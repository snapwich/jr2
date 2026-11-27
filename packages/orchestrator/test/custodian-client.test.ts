// The Orchestrator's side of the Custodian (ADR-0084): the pods off the EndpointSlices, the slot
// reports and the live wait over the control API, and the dial through the uplink with the
// Custodian's own answers read as the transport failures they are (ADR-0042, ADR-0068).
// Socket-free (ADR-0010): the API and every Custodian pod are fakes behind `fetch`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  custodianClient,
  fenceRouted,
  fenceSlotAddress,
  governedPodNode,
  installFenceRoute,
  slotOfAddress,
  type CustodianClient,
} from "../src/custodian-client.ts";
import { neverDelivered } from "../src/dial.ts";
import { neverReached } from "../src/effector-wire.ts";
import { FENCE_PLACEHOLDERS, FENCE_SEGMENT } from "../src/egress.ts";
import type { KubeClient } from "../src/kube-client.ts";

const RANGES = { segment: FENCE_SEGMENT, placeholders: FENCE_PLACEHOLDERS };

type Endpoint = { pod: string; address: string; node: string; ready?: boolean };

function slices(endpoints: Endpoint[]) {
  const asked: Array<{ selector?: string }> = [];
  const kube: Pick<KubeClient, "list"> = {
    list: (async (_kind: unknown, _ns: string, opts?: { labelSelector?: string }) => {
      asked.push({ ...(opts?.labelSelector ? { selector: opts.labelSelector } : {}) });
      return {
        items: [
          {
            metadata: { name: "jr2-custodian-abc" },
            endpoints: endpoints.map((e) => ({
              addresses: [e.address],
              nodeName: e.node,
              targetRef: { name: e.pod },
              ...(e.ready === undefined ? {} : { conditions: { ready: e.ready } }),
            })),
          },
        ],
        resourceVersion: "1",
      };
    }) as KubeClient["list"],
  };
  return { kube, asked };
}

/** Each Custodian pod's control API, by address: `answer` gives its status and body for a call. */
function controlApis(answer: (address: string, method: string, slot: number) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; method: string; token: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ url: url.toString(), method, token: new Headers(init.headers).get("x-jr2-dial") });
    const slot = Number(url.pathname.split("/").pop());
    const { status, body } = answer(url.hostname, method, slot);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const PODS: Endpoint[] = [
  { pod: "c-1", address: "10.0.0.11", node: "w1" },
  { pod: "c-2", address: "10.0.0.12", node: "w2" },
  { pod: "c-3", address: "10.0.0.13", node: "w3", ready: false },
];

test("the Custodian pods and their nodes come from the EndpointSlices of jr2-custodian, ready or not", async () => {
  const { kube, asked } = slices(PODS);
  const client = custodianClient({ kube, namespace: "ns", dialToken: "d" });
  assert.deepEqual(await client.pods(), [
    { pod: "c-1", address: "10.0.0.11", node: "w1", ready: true },
    { pod: "c-2", address: "10.0.0.12", node: "w2", ready: true },
    { pod: "c-3", address: "10.0.0.13", node: "w3", ready: false },
  ]);
  assert.deepEqual(asked, [{ selector: "kubernetes.io/service-name=jr2-custodian" }]);
  assert.equal(await client.podOn("w2"), "10.0.0.12");
  // A pod that is not ready carries no dial.
  assert.equal(await client.podOn("w3"), undefined);
  assert.equal(await client.podOn("w9"), undefined);
});

test("reports: each Custodian pod's word on a slot, and no status from a pod that does not answer 200", async () => {
  const { kube } = slices(PODS);
  const apis = controlApis((address) =>
    address === "10.0.0.11"
      ? { status: 200, body: { slot: 7, version: null, live: false, active: null, present: false } }
      : address === "10.0.0.12"
        ? { status: 503, body: "jr2 custodian: not ready" }
        : { status: 200, body: { slot: 7, version: "v1", live: true, active: "v1" } },
  );
  const client = custodianClient({ kube, namespace: "ns", dialToken: "dial-1", fetch: apis.fetchImpl });
  assert.deepEqual(await client.reports(7), [
    { pod: "c-1", status: { active: null, present: false } },
    { pod: "c-2" },
    // A pod that cannot tell whether a pod is on the VLAN gives no `present`.
    { pod: "c-3", status: { active: "v1" } },
  ]);
  assert.ok(apis.calls.every((c) => c.method === "GET" && c.token === "dial-1"));
  assert.deepEqual(
    apis.calls.map((c) => c.url),
    ["http://10.0.0.11:18081/slots/7", "http://10.0.0.12:18081/slots/7", "http://10.0.0.13:18081/slots/7"],
  );
});

test("makeLive: POST to each ready Custodian pod until each says the rules of one version are live", async () => {
  const { kube } = slices(PODS);
  let round = 0;
  const apis = controlApis((address, method) => {
    assert.equal(method, "POST");
    if (address === "10.0.0.12" && round < 2) {
      round++;
      return { status: 200, body: { slot: 4, version: "v2", live: false, active: null, error: "Envoy did not take" } };
    }
    return { status: 200, body: { slot: 4, version: "v2", live: true, active: "v2" } };
  });
  const client = custodianClient({ kube, namespace: "ns", dialToken: "d", fetch: apis.fetchImpl });
  assert.equal(await client.makeLive(4, { intervalMs: 1 }), "v2");
  // Only the ready pods are asked: a pod that starts later reads every slot before it is ready.
  assert.ok(apis.calls.every((c) => !c.url.includes("10.0.0.13")));
  assert.equal(apis.calls.filter((c) => c.url.includes("10.0.0.12")).length, 3);
});

test("makeLive names what each pod said when the wait ends, and refuses with no ready pod", async () => {
  const { kube } = slices(PODS);
  const apis = controlApis((address) =>
    address === "10.0.0.11"
      ? { status: 200, body: { slot: 4, version: "v1", live: true, active: "v1" } }
      : { status: 401, body: "jr2 custodian: refused: this API takes the Instance's dial token (ADR-0084)" },
  );
  const client = custodianClient({ kube, namespace: "ns", dialToken: "d", fetch: apis.fetchImpl });
  await assert.rejects(
    client.makeLive(4, { timeoutMs: 20, intervalMs: 5 }),
    /did not make the rules of Fence slot 4 live .*c-1 on w1: live at version v1; c-2 on w2: 401 jr2 custodian: refused/,
  );

  const none = custodianClient({ kube: slices([{ ...PODS[2]! }]).kube, namespace: "ns", dialToken: "d" });
  await assert.rejects(none.makeLive(4, { timeoutMs: 10, intervalMs: 5 }), /no Custodian pod of the Instance is ready/);

  // Two pods live at two versions are not live: one of them holds a Secret of before.
  const split = controlApis((address) => ({
    status: 200,
    body: { slot: 4, version: address === "10.0.0.11" ? "v1" : "v2", live: true, active: "v" },
  }));
  const two = custodianClient({ kube, namespace: "ns", dialToken: "d", fetch: split.fetchImpl });
  await assert.rejects(two.makeLive(4, { timeoutMs: 10, intervalMs: 5 }), /live at version v1; .*live at version v2/);
});

test("a slot address is the slot's VLAN on the segment, of this Instance's range alone", () => {
  // Range 2: slot i is VLAN 258 + i, so slot 5 is 198.19.1.7.
  assert.equal(fenceSlotAddress(RANGES, 2, 5), "198.19.1.7");
  assert.equal(slotOfAddress(RANGES, 2, "198.19.1.7"), 5);
  assert.equal(slotOfAddress(RANGES, 2, "198.19.1.2"), 0);
  // Another Instance's range, the uplink's own address, a name, an address off the segment: no slot.
  assert.equal(slotOfAddress(RANGES, 1, "198.19.1.7"), undefined);
  assert.equal(slotOfAddress(RANGES, 2, "198.19.0.1"), undefined);
  assert.equal(slotOfAddress(RANGES, 2, "jr2-orchestrator.ns.svc"), undefined);
  assert.equal(slotOfAddress(RANGES, 2, "10.96.0.7"), undefined);
  // A moved segment moves the addresses.
  assert.equal(fenceSlotAddress({ ...RANGES, segment: "10.200.0.0/20" }, 0, 3), "10.200.0.5");
});

/** The route of a test: slot 5 of range 2 is on node w2, every other slot has no node. */
function routed(custodian: CustodianClient, inner: typeof fetch) {
  installFenceRoute({
    custodian,
    slotOf: (host) => slotOfAddress(RANGES, 2, host),
    nodeOf: async (slot) => (slot === 5 ? "w2" : undefined),
  });
  return fenceRouted(inner);
}

/** What `inner` saw, and the answer it gives. */
function upstream(answer: () => Response) {
  const seen: Array<{ url: string; headers: Headers; method: string; body: unknown }> = [];
  const inner = (async (input: string | URL | Request, init: RequestInit = {}) => {
    seen.push({
      url: String(input),
      headers: new Headers(init.headers),
      method: init.method ?? "GET",
      body: init.body,
    });
    return answer();
  }) as typeof fetch;
  return { inner, seen };
}

test("a request to a slot address goes to the Custodian pod on its node, with the target and the dial token", async (t) => {
  t.after(() => installFenceRoute(undefined));
  const custodian = custodianClient({ kube: slices(PODS).kube, namespace: "ns", dialToken: "dial-9" });
  const { inner, seen } = upstream(() => Response.json({ ok: true }));
  const dial = routed(custodian, inner);
  const res = await dial("http://198.19.1.7:8080/attach?x=1", {
    method: "POST",
    headers: { authorization: "Bearer h" },
    body: "{}",
  });
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(seen[0]!.url, "http://10.0.0.12:18080/attach?x=1");
  assert.equal(seen[0]!.headers.get("x-jr2-target"), "198.19.1.7:8080");
  assert.equal(seen[0]!.headers.get("x-jr2-dial"), "dial-9");
  // The target stays the Host: a Harness makes a stream's URL from it, and that URL must route here.
  assert.equal(seen[0]!.headers.get("host"), "198.19.1.7:8080");
  assert.equal(seen[0]!.headers.get("authorization"), "Bearer h");
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.body, "{}");

  // Any other address goes to `inner` as it is: the Instance Effector, the Orchestrator's peers.
  await dial("http://10.96.0.7:8082/effects/x");
  assert.equal(seen[1]!.url, "http://10.96.0.7:8082/effects/x");
  assert.equal(seen[1]!.headers.get("x-jr2-dial"), null);

  // With no route installed, a slot address is not special.
  installFenceRoute(undefined);
  await fenceRouted(inner)("http://198.19.1.7:8080/healthz");
  assert.equal(seen[2]!.url, "http://198.19.1.7:8080/healthz");
});

test("the Custodian's own answers are failures, never answers: not delivered only when it sent nothing on", async (t) => {
  t.after(() => installFenceRoute(undefined));
  const custodian = custodianClient({ kube: slices(PODS).kube, namespace: "ns", dialToken: "d" });
  const unreachable = (flags: string) => () =>
    new Response(JSON.stringify({ error: "the Harness pod never answered", detail: "upstream_reset", flags }), {
      status: 503,
      headers: { "x-jr2-custodian": "unreachable" },
    });
  const failure = async (answer: () => Response) => {
    const dial = routed(custodian, upstream(answer).inner);
    try {
      await dial("http://198.19.1.7:8082/effects/e1", { method: "POST", body: "{}" });
    } catch (err) {
      return err;
    }
    assert.fail("the Custodian's answer must not reach the caller as a Response");
  };
  for (const flags of ["UF", "UH", "DF", "UF,URX"]) {
    const err = await failure(unreachable(flags));
    assert.equal(neverDelivered(err), true, flags);
    assert.equal(neverReached(err), true, flags);
  }
  // Any other flag: the pod may have the request, so an admission is not sent again.
  for (const flags of ["UC", "UF,UC", "UPE", "-"]) {
    const err = await failure(unreachable(flags));
    assert.equal(neverDelivered(err), false, flags);
    assert.equal(neverReached(err), false, flags);
  }
  // The Custodian refused the dial itself (a token, a target, no token yet): nothing went on.
  for (const mark of ["refused", "not-ready"]) {
    const err = await failure(
      () => new Response("jr2 custodian: no", { status: 403, headers: { "x-jr2-custodian": mark } }),
    );
    assert.equal(neverDelivered(err), true, mark);
  }
  // A body that is not the Custodian's JSON says no flag: not "not delivered".
  assert.equal(
    neverDelivered(
      await failure(() => new Response("x", { status: 503, headers: { "x-jr2-custodian": "unreachable" } })),
    ),
    false,
  );
  // The pod's own 503 (a draining Harness, a stopping Effector) is an answer: the route took its mark off.
  const own = await routed(
    custodian,
    upstream(() => new Response("stopping", { status: 503 })).inner,
  )("http://198.19.1.7:8082/effects/e1");
  assert.equal(own.status, 503);
});

test("a slot with no node, or a node with no ready Custodian pod, is never delivered", async (t) => {
  t.after(() => installFenceRoute(undefined));
  const custodian = custodianClient({
    kube: slices([{ pod: "c-2", address: "10.0.0.12", node: "w2", ready: false }]).kube,
    namespace: "ns",
    dialToken: "d",
  });
  const { inner, seen } = upstream(() => new Response("ok"));
  const dial = routed(custodian, inner);
  // Slot 6 has no node.
  const noNode = await dial("http://198.19.1.8:8080/attach").catch((e: unknown) => e);
  assert.equal(neverDelivered(noNode), true);
  assert.match(String((noNode as Error & { cause: Error }).cause.message), /no pod on Fence slot 6/);
  const noPod = await dial("http://198.19.1.7:8080/attach").catch((e: unknown) => e);
  assert.equal(neverDelivered(noPod), true);
  assert.match(String((noPod as Error & { cause: Error }).cause.message), /no Custodian pod is ready on node w2/);
  assert.equal(seen.length, 0);
});

test("the Instance Harness's node is in the EndpointSlices of its headless Service: a serving endpoint first, a draining one else, and no Pod is read (ADR-0031, ADR-0084)", async () => {
  let asked: string[] = [];
  let endpoints: Array<Record<string, unknown>> = [];
  const kube: Pick<KubeClient, "list"> = {
    list: (async (kind: { plural?: string }, ns: string, opts?: { labelSelector?: string }) => {
      asked.push(`${kind.plural} ${ns} ${opts?.labelSelector}`);
      return { items: [{ metadata: { name: "jr2-instance-harness-pods-x" }, endpoints }] };
    }) as never,
  };
  let t = 0;
  const node = governedPodNode({ kube, namespace: "ns", service: "jr2-instance-harness-pods", now: () => t });
  endpoints = [{ addresses: ["198.19.0.2"], nodeName: "node-a", conditions: { ready: true, serving: true } }];
  assert.equal(await node(), "node-a");
  assert.deepEqual(asked, ["endpointslices ns kubernetes.io/service-name=jr2-instance-harness-pods"]);
  // Cached for 2 s, then read again.
  endpoints = [
    { addresses: ["198.19.0.2"], nodeName: "node-b", conditions: { ready: false, serving: true, terminating: true } },
  ];
  assert.equal(await node(), "node-a");
  t = 2_500;
  assert.equal(await node(), "node-b", "a draining pod still serves, so its node still carries the dial");
  // No endpoint names a node: none, and that is not kept.
  endpoints = [];
  t = 5_000;
  assert.equal(await node(), undefined);
  endpoints = [{ addresses: ["198.19.0.2"], nodeName: "node-c", conditions: { ready: false } }];
  asked = [];
  assert.equal(await node(), "node-c", "not ready, but the only one: the Custodian answers for it");
  assert.equal(asked.length, 1);
});
