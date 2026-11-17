// The Orchestrator's side of the Custodian of its Instance (ADR-0084, ADR-0059). Each Custodian pod
// is on one Sandbox node, and the Orchestrator finds each pod and its node in the EndpointSlices of
// the headless Service `jr2-custodian` (no read of a Pod, ADR-0063). It does three things with them:
//
//   live     a provision asks each ready Custodian pod (`POST /slots/<i>`) to read the slot's
//            Secret again, and waits until each one says that the rules of one version are live
//   reports  the slot allocator asks each Custodian pod, ready or not (`GET /slots/<i>`), whether it
//            holds rules of a slot and whether a pod answers on the slot's VLAN (`fence-slots.ts`)
//   dial     a request to a Harness pod or to a Sandbox Effector goes to the Custodian pod on that
//            pod's node, port 18080, which carries it to `x-jr2-target` on the slot's VLAN
//
// Each call carries the Instance's dial token (`x-jr2-dial`). The token, and a NetworkPolicy, keep
// every other pod off these ports.
//
// A dial through the Custodian always connects, because Envoy accepts it. When the Harness pod
// does not answer, the Custodian answers 503 with `x-jr2-custodian: unreachable` and Envoy's flags,
// and when the Custodian refuses the dial itself, it answers with `x-jr2-custodian: refused` or
// `not-ready`. `fenceRouted` turns each such answer into the transport failure that it is (ADR-0042):
// "not delivered" when the Custodian sent nothing on, else "may have been delivered". So each caller
// keeps its own rule for a request that never reached the pod, and no caller reads the Custodian's
// own answer as the Harness's or the Effector's (ADR-0068).

import { isIPv4 } from "node:net";
import { slotAddress, slotVlan } from "./custodian-rules.ts";
import type { SlotStatus } from "./custodian-control.ts";
import { CUSTODIAN_CONTROL_PORT, CUSTODIAN_INBOUND_PORT, DIAL_TARGET_HEADER, DIAL_TOKEN_HEADER } from "./custodian.ts";
import { FENCE_SLOTS } from "./custodian.ts";
import { dialFetch } from "./dial.ts";
import type { FenceRanges } from "./egress.ts";
import type { SlotReport } from "./fence-slots.ts";
import { ENDPOINTSLICES, type KubeClient, type KubeObject } from "./kube-client.ts";
import { CUSTODIAN_SERVICE } from "./names.ts";

/** One Custodian pod, as its Service's EndpointSlices name it. */
export type CustodianPod = { pod: string; address: string; node?: string; ready: boolean };

type EndpointSlice = KubeObject & {
  endpoints?: Array<{
    addresses?: string[];
    conditions?: { ready?: boolean };
    nodeName?: string;
    targetRef?: { name?: string };
  }>;
};

/** Envoy's flags on a dial that the Custodian sent nothing of to the Harness pod: the connection
 * failed, no host, the lookup failed, or the retry limit after one of those (ADR-0042). */
const NOT_SENT = new Set(["UF", "UH", "DF", "URX"]);

/** The Custodian's mark on an answer of its own (`custodian.lua`, `INBOUND_UNREACHABLE`). The route
 * removes a mark that a Harness pod sends, so only the Custodian's answer has one. */
const MARK = "x-jr2-custodian";

export type CustodianClientOptions = {
  kube: Pick<KubeClient, "list">;
  namespace: string;
  /** The Instance's dial token (`custodianDialToken`). */
  dialToken: string;
  /** The transport of the calls to the control API. Default `dialFetch()`. */
  fetch?: typeof fetch;
  /** How long a list of the Custodian pods serves the dial. Default 2 s. */
  cacheMs?: number;
  /** A monotonic clock in ms. Default `performance.now`. */
  now?: () => number;
};

export type CustodianClient = {
  /** Each Custodian pod of the Instance, ready or not. `fresh` reads the API again at once. */
  pods(fresh?: boolean): Promise<CustodianPod[]>;
  /** What each Custodian pod says of a slot (`GET /slots/<i>`): the slot allocator's input. A pod
   * that does not answer, or answers with another status than 200, has no `status`. */
  reports(slot: number): Promise<SlotReport[]>;
  /** Make the slot's rules live on each ready Custodian pod (`POST /slots/<i>`), and wait until each
   * one says that the rules of one version are live. Answers that version. Throws, with what each
   * pod said, when the wait ends with no such answer, or when no Custodian pod is ready. */
  makeLive(slot: number, opts?: { signal?: AbortSignal; timeoutMs?: number; intervalMs?: number }): Promise<string>;
  /** The address of the ready Custodian pod on `node`, or undefined. */
  podOn(node: string): Promise<string | undefined>;
  /** The token of each call (`x-jr2-dial`). */
  readonly dialToken: string;
};

/** How long a provision waits for the Custodian to make a slot's rules live. */
export const LIVE_WAIT_MS = 60_000;

export function custodianClient(opts: CustodianClientOptions): CustodianClient {
  const call = opts.fetch ?? dialFetch({ idleTimeoutMs: 60_000 });
  const cacheMs = opts.cacheMs ?? 2_000;
  const now = opts.now ?? (() => performance.now());
  let cached: { at: number; pods: Promise<CustodianPod[]> } | undefined;

  const list = async (): Promise<CustodianPod[]> => {
    const { items } = await opts.kube.list<EndpointSlice>(ENDPOINTSLICES, opts.namespace, {
      labelSelector: `kubernetes.io/service-name=${CUSTODIAN_SERVICE}`,
    });
    const out = new Map<string, CustodianPod>();
    for (const slice of items) {
      for (const e of slice.endpoints ?? []) {
        const address = e.addresses?.[0];
        if (address === undefined) continue;
        // An endpoint with no `ready` condition is ready (the API's own reading).
        const ready = e.conditions?.ready !== false;
        out.set(address, {
          pod: e.targetRef?.name ?? address,
          address,
          ...(e.nodeName !== undefined ? { node: e.nodeName } : {}),
          ready,
        });
      }
    }
    return [...out.values()].sort((a, b) => a.pod.localeCompare(b.pod));
  };

  const pods = (fresh = false): Promise<CustodianPod[]> => {
    const t = now();
    if (!fresh && cached !== undefined && t - cached.at < cacheMs) return cached.pods;
    const p = list();
    cached = { at: t, pods: p };
    // A failed list is not kept: the next call asks again.
    p.catch(() => {
      if (cached?.pods === p) cached = undefined;
    });
    return p;
  };

  const control = async (
    pod: CustodianPod,
    method: "GET" | "POST",
    slot: number,
    signal?: AbortSignal,
  ): Promise<{ status: number; body?: SlotStatus; text: string }> => {
    const res = await call(`http://${pod.address}:${CUSTODIAN_CONTROL_PORT}/slots/${slot}`, {
      method,
      headers: { [DIAL_TOKEN_HEADER]: opts.dialToken },
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    if (res.status !== 200) return { status: res.status, text: text.trim() };
    try {
      return { status: 200, body: JSON.parse(text) as SlotStatus, text };
    } catch {
      return { status: 502, text: "an answer that is not JSON" };
    }
  };

  return {
    dialToken: opts.dialToken,
    pods,

    async reports(slot) {
      const all = await pods(true);
      return Promise.all(
        all.map(async (pod): Promise<SlotReport> => {
          try {
            const { body } = await control(pod, "GET", slot, AbortSignal.timeout(10_000));
            return body === undefined
              ? { pod: pod.pod }
              : {
                  pod: pod.pod,
                  status: { active: body.active, ...(body.present !== undefined ? { present: body.present } : {}) },
                };
          } catch {
            return { pod: pod.pod };
          }
        }),
      );
    },

    async makeLive(slot, o = {}) {
      const timeoutMs = o.timeoutMs ?? LIVE_WAIT_MS;
      const intervalMs = o.intervalMs ?? 500;
      const deadline = now() + timeoutMs;
      let said = "no Custodian pod was asked";
      for (;;) {
        o.signal?.throwIfAborted();
        let ready: CustodianPod[] = [];
        try {
          ready = (await pods(true)).filter((p) => p.ready);
        } catch (err) {
          said = `the Custodian pods cannot be listed: ${(err as Error).message}`;
        }
        if (ready.length === 0 && !said.startsWith("the Custodian pods cannot")) {
          said = "no Custodian pod of the Instance is ready";
        }
        if (ready.length > 0) {
          const answers = await Promise.all(
            ready.map(async (pod) => {
              try {
                const a = await control(pod, "POST", slot, o.signal);
                return { pod, ...a };
              } catch (err) {
                if (o.signal?.aborted) throw err;
                return { pod, status: 0, text: `no answer: ${(err as Error).message}` };
              }
            }),
          );
          const versions = new Set(answers.map((a) => (a.body?.live ? a.body.version : null)));
          const [only] = versions;
          if (versions.size === 1 && typeof only === "string") return only;
          said = answers
            .map(({ pod, status, body, text }) => {
              const where = `${pod.pod}${pod.node ? ` on ${pod.node}` : ""}`;
              if (body === undefined) return `${where}: ${status ? `${status} ` : ""}${text}`;
              if (body.live) return `${where}: live at version ${body.version}`;
              return `${where}: not live${body.error ? ` (${body.error})` : ""}`;
            })
            .join("; ");
        }
        if (now() + intervalMs > deadline) {
          throw new Error(
            `the Custodian did not make the rules of Fence slot ${slot} live in ${Math.round(timeoutMs / 1000)} s ` +
              `(ADR-0084): ${said}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },

    async podOn(node) {
      const all = await pods();
      return all.find((p) => p.ready && p.node === node)?.address;
    },
  };
}

/** The slot of an address on the segment, for the Instance's range: undefined for an address that is
 * not a slot of the range. */
export function slotOfAddress(ranges: FenceRanges, range: number, address: string): number | undefined {
  if (!isIPv4(address)) return undefined;
  const int = (a: string) => a.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
  const slot = int(address) - int(ranges.segment.split("/")[0]!) - slotVlan(range, 0);
  if (!Number.isInteger(slot) || slot < 0 || slot >= FENCE_SLOTS) return undefined;
  return fenceSlotAddress(ranges, range, slot) === address ? slot : undefined;
}

/** The address of a slot of the Instance's range on the segment. */
export function fenceSlotAddress(ranges: FenceRanges, range: number, slot: number): string {
  return slotAddress(ranges.segment, slotVlan(range, slot));
}

/** How the process reaches a Harness pod behind the Fence: the Instance's Custodian, the node of the
 * pod at a slot address, and which addresses are slots. */
export type FenceRoute = {
  custodian: CustodianClient;
  /** The slot of `host` when it is a slot address of this Instance, else undefined. */
  slotOf(host: string): number | undefined;
  /** The node of the Harness pod on a slot, or undefined when no pod of the slot has a node. */
  nodeOf(slot: number): Promise<string | undefined>;
};

/** The route of this process. The Agent and Effect slots build their clients from a URL in their
 * input (ADR-0049), so the route to a slot address is the process's, not each client's. */
let installed: FenceRoute | undefined;

/** Set the process's route to the Harness pods behind the Fence (`server.ts`), or clear it. */
export function installFenceRoute(route: FenceRoute | undefined): void {
  installed = route;
}

/** A failure that certainly sent nothing on: its `cause` reads as a connect that did not happen, so
 * `neverDelivered` (dial.ts) and `neverReached` (effector-wire.ts) say so. */
function notDelivered(message: string, code = "EHOSTUNREACH"): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code, syscall: "connect" }) });
}

/** A failure after which the Harness pod may have the request. */
function mayHaveDelivered(message: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code: "ECONNRESET" }) });
}

/**
 * `inner`, with each `http:` request to a slot address of this Instance sent through the Custodian
 * pod on that pod's node (above), by `hop`. Any other request goes to `inner` as it is. The route
 * is read at each call, so a client made before the route was set uses it. A request whose slot has
 * no pod with a node, or whose node has no ready Custodian pod, fails as a connect that did not
 * happen.
 *
 * The request keeps the target as its `Host`: a Harness makes a URL that it answers with (a
 * stream's URL) from its `Host`, and that URL must name the slot's address again. So `hop` must
 * send a `Host` header that it is given, as `dialFetch` does; the global `fetch` sets its own.
 */
export function fenceRouted(inner: typeof fetch, hop: typeof fetch = inner): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const route = installed;
    if (route === undefined || input instanceof Request) return inner(input, init);
    const url = new URL(input);
    const slot = url.protocol === "http:" ? route.slotOf(url.hostname) : undefined;
    if (slot === undefined) return inner(input, init);
    const target = `${url.hostname}:${url.port || "80"}`;
    const node = await route.nodeOf(slot);
    if (node === undefined) throw notDelivered(`no pod on Fence slot ${slot} (${target}) has a node`);
    let pod: string | undefined;
    try {
      pod = await route.custodian.podOn(node);
    } catch (err) {
      throw notDelivered(`the Custodian pods cannot be listed: ${(err as Error).message}`);
    }
    if (pod === undefined) throw notDelivered(`no Custodian pod is ready on node ${node}, so ${target} is not reached`);
    const headers = new Headers(init.headers);
    headers.set("host", target);
    headers.set(DIAL_TARGET_HEADER, target);
    headers.set(DIAL_TOKEN_HEADER, route.custodian.dialToken);
    const via = `http://${pod}:${CUSTODIAN_INBOUND_PORT}${url.pathname}${url.search}`;
    let res: Response;
    try {
      res = await hop(via, { ...init, headers });
    } catch (err) {
      // The Custodian pod itself was not reached: the next call lists the pods again.
      void route.custodian.pods(true).catch(() => {});
      throw err;
    }
    const mark = res.headers.get(MARK);
    if (mark === null) return res;
    const text = await res.text().catch(() => "");
    return custodianAnswer(mark, res.status, text, target);
  }) as typeof fetch;
}

/** The global `fetch`, routed: its hop to a Custodian pod is `dialFetch`, which keeps the `Host`.
 * The default `fetch` of each client of a Harness pod or a Sandbox Effector. */
export const routedFetch: typeof fetch = fenceRouted((input, init) => fetch(input, init), dialFetch());

/** The Custodian's own answer to a dial, as the failure it is. Never a Response: no caller may read
 * it as the Harness's or the Effector's. */
function custodianAnswer(mark: string, status: number, text: string, target: string): never {
  if (mark === "unreachable") {
    let flags: string[] = [];
    let detail = text.trim();
    try {
      const body = JSON.parse(text) as { flags?: string; detail?: string };
      flags = (body.flags ?? "").split(",").filter((f) => f !== "" && f !== "-");
      detail = body.detail ?? detail;
    } catch {
      // not the Custodian's JSON: no flag is known, so the request may have reached the pod
    }
    const words = `the Custodian could not reach ${target} (${status}${flags.length ? ` ${flags.join(",")}` : ""}): ${detail}`;
    if (flags.length > 0 && flags.every((f) => NOT_SENT.has(f))) throw notDelivered(words, "ECONNREFUSED");
    throw mayHaveDelivered(words);
  }
  if (mark === "refused" || mark === "not-ready") {
    throw notDelivered(`the Custodian refused the dial to ${target} (${status}): ${text.trim()}`, "ECONNREFUSED");
  }
  throw mayHaveDelivered(`the Custodian answered the dial to ${target} with ${status} (${mark}): ${text.trim()}`);
}
