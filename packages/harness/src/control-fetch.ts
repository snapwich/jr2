// How the Harness sends each control request — the Menu, a pick, a delivery poll, a notice's
// acknowledgment, a batch of the conversation — to the Custodian (ADR-0059, ADR-0076, ADR-0084).
//
// A Harness pod is on the Fence, and the Custodian is outside the pod, at jr2's own name
// (`custodian.jr2.internal`), which the slot's resolver answers. The control routes are HTTPS on
// its port 443, and the Custodian ends that TLS with a leaf of the pod's CA. The Harness trusts that
// CA through `NODE_EXTRA_CA_CERTS` (the pod's trust bundle), so it sends the control Stand-in only
// to a peer that holds the leaf: no process in the pod can take the Custodian's place.
//
// The `fetch` answers as the global `fetch` does, for what `menu.ts` reads: a `Response` for every
// HTTP status, and a rejection on a transport failure — a `TypeError("fetch failed")` whose `cause`
// is the error (`connect ECONNREFUSED …`, `connect EHOSTUNREACH …`, a TLS refusal), as undici's
// is. An abort rejects with the signal's reason.

import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";

/** jr2's own name for the Custodian, as a URL: where the control routes are. `@jr2/orchestrator`'s
 * `JR2_CUSTODIAN_NAME`; a test holds the two equal. */
export const CUSTODIAN_URL = "https://custodian.jr2.internal";

/** The statuses whose response has no body: a `Response` refuses one. */
const NULL_BODY = new Set([101, 204, 205, 304]);

export type ControlFetchOptions = {
  /** The trust for an `https:` URL. Default: Node's own, with `NODE_EXTRA_CA_CERTS` (the pod's CA).
   * A test gives its own CA. */
  ca?: string;
  /** How the URL's host is looked up. Default: the system's. A test points jr2's name at the
   * loopback. */
  lookup?: LookupFunction;
};

/**
 * A `fetch` that makes one connection for each request, never a pooled one: a connection that a
 * restarted Custodian closed would fail a pick as "may have reached", where a new one fails to
 * connect, which proves that the pick never left.
 */
export function controlFetch(opts: ControlFetchOptions = {}): typeof globalThis.fetch {
  return ((input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => (headers[name] = value));
      const body = init.body === undefined || init.body === null ? undefined : String(init.body);
      if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
      const base: RequestOptions = {
        agent: false,
        method: init.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers: { host: url.host, ...headers },
      };
      if (url.protocol !== "https:") {
        reject(new Error(`a control request goes over HTTPS, not to ${url.origin}`));
        return;
      }
      const req: ClientRequest = httpsRequest({
        ...base,
        hostname: url.hostname,
        port: url.port === "" ? 443 : Number(url.port),
        ...(opts.ca !== undefined ? { ca: opts.ca } : {}),
        ...(opts.lookup !== undefined ? { lookup: opts.lookup } : {}),
      });
      const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) reject(signal.reason);
        else reject(new TypeError("fetch failed", { cause: err }));
      });
      req.on("response", (res: IncomingMessage) => {
        const out = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
        }
        const status = res.statusCode ?? 0;
        // An abort after the headers ends the body's stream with the signal's reason.
        res.on("close", () => signal?.removeEventListener("abort", onAbort));
        if (NULL_BODY.has(status)) res.resume();
        try {
          resolve(
            new Response(NULL_BODY.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
              status,
              statusText: res.statusMessage ?? "",
              headers: out,
            }),
          );
        } catch (err) {
          res.destroy();
          reject(new TypeError("fetch failed", { cause: err }));
        }
      });
      req.end(body);
    })) as typeof globalThis.fetch;
}

/** Where the Harness sends its control requests, and how. */
export type ControlReach = { url: string; fetch: typeof globalThis.fetch };

/**
 * The control reach of this pod, from its env: `JR2_CUSTODIAN_URL`, else {@link CUSTODIAN_URL}. Throws for a URL that is not `https:`: the control Stand-in goes only to a
 * peer that shows the Custodian's leaf (ADR-0059).
 */
export function controlReachOf(env: Readonly<Record<string, string | undefined>>): ControlReach {
  const url = env.JR2_CUSTODIAN_URL || CUSTODIAN_URL;
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = "";
  }
  if (protocol !== "https:") {
    throw new Error(
      `JR2_CUSTODIAN_URL ${JSON.stringify(url)} is not an https URL: the Harness sends the control Stand-in only ` +
        "over TLS, to a peer that holds the Custodian's leaf (ADR-0059)",
    );
  }
  return { url, fetch: controlFetch() };
}
