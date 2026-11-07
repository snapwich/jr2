// How jr2 dials a Service at a lifecycle edge (ADR-0042): the request that is the first to reach a
// Service just coming into service — a Sandbox's attach (ADR-0063), an admission — and the one log
// line that says what reaching it cost.
//
// `dialFetch` is a `fetch` whose CONNECT is bounded. A connection that does not open within
// `connectTimeoutMs` fails as a connect failure (`syscall: "connect"`, so it never reached the
// wire), and the caller's retry dials again on a NEW connection. The global `fetch` gives a
// connection 10 s, and it cannot be shortened without undici's dispatcher, which is not a
// dependency here (kube-client.ts says the same of its body timeout).
//
// Why a new connection, and not a longer wait on the same one: measured on kind (iptables
// kube-proxy), an attach that dialed 8 ms after its Sandbox's EndpointSlice became ready sent a
// SYN that was never answered — nor were the kernel's re-sends of it on that connection — and it
// failed at the 10 s connect timeout. The next try, on a new connection, connected and answered in
// 172 ms. So the wait that is not answered in a short time is not answered at all, and a short
// bound changes the cost of that drop from about 10.5 s to about the bound.
//
// The bound covers the name lookup and the TCP handshake, nothing after it: a connected request
// waits for its answer as long as the answer takes (an attach clones). One connection for each
// request, never a pooled one, so each try is a new connection.

import { request, type ClientRequestArgs } from "node:http";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";

/**
 * How long a dial waits for its connection to open. In a cluster a lookup and a handshake take
 * milliseconds; 2 s still lets the kernel's first SYN re-send (at 1 s) land inside the bound, for a
 * lost packet that a re-send repairs.
 */
export const CONNECT_TIMEOUT_MS = 2_000;

/** The statuses whose response has no body: a `Response` refuses one. */
const NULL_BODY = new Set([101, 204, 205, 304]);

export type DialOptions = {
  /** How long the connection may take to open. Default `CONNECT_TIMEOUT_MS`. */
  connectTimeoutMs?: number;
  /** Makes the connection. Injectable for socket-free tests. Default: `net.createConnection`. */
  connect?: (options: ClientRequestArgs) => Duplex;
};

/**
 * A `fetch` with a bounded connect, for `http:` URLs (every Service jr2 dials in the cluster). It
 * answers as the global `fetch` does: a `Response` for every HTTP status, and on a transport
 * failure a `TypeError("fetch failed")` whose `cause` is the errno; a connect that ran out of time
 * is `connect ETIMEDOUT` with `syscall: "connect"`. An abort rejects with the signal's reason. A
 * body is a string. Any other scheme goes to the global `fetch`, unbounded.
 */
export function dialFetch(options: DialOptions = {}): typeof globalThis.fetch {
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const connect = options.connect ?? ((args: ClientRequestArgs) => createConnection(args as never));
  return ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.protocol !== "http:") return fetch(input, init);
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => (headers[name] = value));
      const body = init.body === undefined || init.body === null ? undefined : String(init.body);
      if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
      const host = url.hostname;
      const port = Number(url.port || 80);
      // `createConnection` and no `agent`: Node then makes one connection for this request alone.
      const req = request({
        host,
        port,
        method: init.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers: { host: url.host, ...headers },
        createConnection: (args: ClientRequestArgs) => connect(args),
      });
      req.once("socket", (socket: Duplex & { connecting?: boolean }) => {
        if (!socket.connecting) return;
        const timer = setTimeout(() => req.destroy(connectTimedOut(host, port, connectTimeoutMs)), connectTimeoutMs);
        const clear = () => clearTimeout(timer);
        socket.once("connect", clear);
        socket.once("close", clear);
      });
      const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) reject(signal.reason);
        else reject(new TypeError("fetch failed", { cause: err }));
      });
      req.on("response", (res) => {
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
    });
  }) as typeof globalThis.fetch;
}

/** Node's own shape for a connect that timed out, so `neverDelivered` reads it by its syscall. */
function connectTimedOut(host: string, port: number, ms: number): Error {
  return Object.assign(new Error(`connect ETIMEDOUT ${host}:${port} (no connection in ${ms}ms)`), {
    code: "ETIMEDOUT",
    syscall: "connect",
    address: host,
    port,
  });
}

/**
 * The marker the `@kind` tier greps for, and therefore a CONTRACT — duplicated verbatim in
 * `@jr2/harness`'s Menu (the two packages share no runtime dependency) and matched in
 * `features/steps/kind.steps.ts`. Renaming it on one side does not break a build; it silently turns
 * the tier's routability budget into a check that passes because it matches nothing.
 */
const ROUTABILITY_MARKER = "jr2.routability";

/**
 * What a retry at a lifecycle edge COST, emitted once, only when there was a cost.
 *
 * ADR-0042 absorbs these retries (ADR-0016's principle: no event, no budget on the authoring
 * surface), and absorption is the right call — but a fault that is absorbed and never measured is
 * how "Ready is not routable" stayed invisible for three sessions. Absorbing and measuring are not
 * in conflict: this is a log line, not a run-feed event, so nothing about the workflow surface
 * changes and the `@kind` tier can still assert a budget on the window it currently only benefits
 * from. Scoped deliberately to the calls that are first to reach a Service — `wait`'s reconnect is
 * a live stream re-attaching, not a Service coming into existence, and does not belong in this
 * number.
 *
 * `attempts` and `ms` are BOTH here because they measure different refusals. A REJECT (kube-proxy
 * with no ready backend) spends attempts and almost no time; a DROP spends time and almost no
 * attempts — before the bounded connect, 2 attempts costing 10667ms, one dropped SYN sitting on the
 * 10 s connect timeout. `last` carries the errno of the final failure so the line says WHICH
 * without anyone having to do that arithmetic.
 */
export function routabilityLine(
  seat: "admission" | "attach" | "surface",
  url: string,
  attempts: number,
  ms: number,
  lastCode: string,
): string {
  return `${ROUTABILITY_MARKER} seat=${seat} attempts=${attempts} ms=${ms} last=${lastCode} url=${url}`;
}

/** The errno of a transport rejection, read structurally down the cause chain (`transportDetail`
 * gives the prose; this gives the one token worth aggregating on). */
export function transportCode(err: unknown, depth = 0): string {
  if (depth > 4 || typeof err !== "object" || err === null) return "?";
  const { code, cause, errors } = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof code === "string") return code;
  const nested = Array.isArray(errors) ? errors[0] : cause;
  return nested === undefined || nested === null ? "?" : transportCode(nested, depth + 1);
}

/**
 * The most specific thing a transport rejection says about itself. `fetch` reports every one of
 * them as the same three words — `fetch failed` — and that string, arriving as an `agent.fault`
 * reason or a log line, names nothing an operator can act on. The errno one level down
 * (`connect ECONNREFUSED 10.96.0.7:8080`, `getaddrinfo ENOTFOUND …`) is the whole diagnosis.
 */
export function transportDetail(err: unknown, depth = 0): string {
  if (depth > 4 || typeof err !== "object" || err === null) return String(err);
  const { message, cause, errors } = err as { message?: unknown; cause?: unknown; errors?: unknown };
  const nested = Array.isArray(errors) ? errors[0] : cause;
  if (nested !== undefined && nested !== null) {
    const deeper = transportDetail(nested, depth + 1);
    if (deeper) return deeper;
  }
  return typeof message === "string" ? message : String(err);
}
