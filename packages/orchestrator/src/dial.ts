// How jr2 dials a Service at a lifecycle edge (ADR-0042): the request that is the first to reach a
// Service just coming into service — a Sandbox's attach (ADR-0063), an admission — and the one log
// line that says what reaching it cost.
//
// `dialFetch` is a `fetch` whose TCP CONNECT is bounded. A connection that does not open within
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
// The bound starts when the name lookup has answered, and covers the TCP handshake only. Node
// cannot cancel a `getaddrinfo`: a bound that cut the lookup would leave it holding a libuv pool
// thread (4 by default), and in a DNS outage the retries would fill the pool. A lookup ends on the
// resolver's own timeouts, and the caller's signal ends the wait for it.
//
// A connected request has an IDLE bound, as the global `fetch` had (undici's 300 s headers and body
// timeouts): no byte from the server for `idleTimeoutMs` ends it, so a server whose node vanished
// mid-request cannot hold it for ever. One connection for each request, never a pooled one, so each
// try is a new connection.

import { request, type ClientRequestArgs, type IncomingMessage } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { urlToHttpOptions } from "node:url";

/**
 * How long a dial waits for its TCP connection to open, from the end of the name lookup. In a
 * cluster a handshake takes milliseconds; 2 s still lets the kernel's first SYN re-send (at 1 s)
 * land inside the bound, for a lost packet that a re-send repairs.
 */
export const CONNECT_TIMEOUT_MS = 2_000;

/**
 * How long a connected request may go with no byte from the server: the global `fetch`'s own
 * limit (undici's `headersTimeout` and `bodyTimeout`), so a request that took up to this before
 * takes up to this now (ADR-0042).
 */
export const IDLE_TIMEOUT_MS = 300_000;

/** The statuses whose response has no body: a `Response` refuses one. */
const NULL_BODY = new Set([101, 204, 205, 304]);

export type DialOptions = {
  /** How long the TCP connection may take to open. Default `CONNECT_TIMEOUT_MS`. */
  connectTimeoutMs?: number;
  /** How long a connected request may go with no byte from the server. Default `IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number;
  /** Makes the connection. Injectable for socket-free tests. Default: `net.createConnection`. */
  connect?: (options: ClientRequestArgs) => Duplex;
};

type DialSocket = Duplex & { connecting?: boolean; setTimeout?: (ms: number, cb?: () => void) => unknown };

/**
 * A `fetch` with a bounded connect, for `http:` URLs (every Service jr2 dials in the cluster). It
 * answers as the global `fetch` does: a `Response` for every HTTP status, and on a transport
 * failure a `TypeError("fetch failed")` whose `cause` is the errno. A connect that ran out of time
 * is `connect ETIMEDOUT` with `syscall: "connect"`; an idle connected request is `ETIMEDOUT` with no
 * syscall (it may have reached the server). An abort rejects with the signal's reason, also while
 * the body is read.
 *
 * Narrower than `fetch`, and it says so: the input is a string or a `URL` (a `Request` is a
 * `TypeError`), and a body is a string or a `ReadableStream`, which goes in chunks (anything else
 * is a `TypeError`). It does not follow a redirect, and the `Response`'s `url` is empty. Any scheme but `http:` goes to the global `fetch`,
 * unbounded.
 */
export function dialFetch(options: DialOptions = {}): typeof globalThis.fetch {
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  // Read at call time, so a test that replaces `net.createConnection` sees every default dial.
  const connect = options.connect ?? ((args: ClientRequestArgs) => net.createConnection(args as never));
  return ((input: string | URL | Request, init: RequestInit = {}) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      return Promise.reject(new TypeError("dialFetch takes a string or a URL, not a Request"));
    }
    const streamed = init.body instanceof ReadableStream ? (init.body as ReadableStream<Uint8Array>) : undefined;
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string" && streamed === undefined) {
      return Promise.reject(new TypeError("dialFetch sends a string or a ReadableStream body only"));
    }
    const url = new URL(input);
    if (url.protocol !== "http:") return fetch(input, init);
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        void streamed?.cancel(signal.reason).catch(() => {});
        reject(signal.reason);
        return;
      }
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => (headers[name] = value));
      const body = streamed === undefined ? ((init.body ?? undefined) as string | undefined) : undefined;
      if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
      // `urlToHttpOptions` takes the brackets off an IPv6 literal, which `URL.hostname` keeps.
      const { hostname } = urlToHttpOptions(url);
      const host = hostname ?? url.hostname;
      const port = Number(url.port || 80);
      let response: IncomingMessage | undefined;
      // `createConnection` and no `agent`: Node then makes one connection for this request alone.
      const req = request({
        host,
        port,
        method: init.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers: { host: url.host, ...headers },
        createConnection: (args: ClientRequestArgs) => connect(args),
      });
      req.once("socket", (socket: DialSocket) => {
        if (!socket.connecting) return armIdle(socket);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          timer = setTimeout(() => req.destroy(connectTimedOut(host, port, connectTimeoutMs)), connectTimeoutMs);
        };
        const clear = () => clearTimeout(timer);
        // An IP literal has no lookup, so its bound starts now.
        if (net.isIP(host)) arm();
        else socket.once("lookup", (err: Error | null) => (err ? undefined : arm()));
        socket.once("connect", () => {
          clear();
          armIdle(socket);
        });
        socket.once("close", clear);
      });
      const armIdle = (socket: DialSocket) => {
        socket.setTimeout?.(idleTimeoutMs, () => {
          const err = idleTimedOut(host, port, idleTimeoutMs);
          if (response) response.destroy(err);
          req.destroy(err);
        });
      };
      const onAbort = () => {
        const reason = signal?.reason instanceof Error ? signal.reason : new Error("aborted");
        // After the headers, the body's stream ends with the reason; before them, the request does.
        if (response) response.destroy(reason);
        req.destroy(reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) reject(signal.reason);
        else reject(new TypeError("fetch failed", { cause: err }));
      });
      req.on("response", (res) => {
        response = res;
        const out = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
        }
        const status = res.statusCode ?? 0;
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
      if (streamed === undefined) {
        req.end(body);
        return;
      }
      // A streamed body goes in chunks, as the reader pulls them, so neither side holds the whole
      // of it. A body that fails ends the request with its error; a request that ends early cancels
      // the body.
      const source = Readable.fromWeb(streamed as never);
      source.once("error", (err) => req.destroy(err));
      req.once("close", () => source.destroy());
      source.pipe(req);
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

/** A connected request that heard nothing for the idle bound. No `syscall`: it may have arrived. */
function idleTimedOut(host: string, port: number, ms: number): Error {
  return Object.assign(new Error(`no answer from ${host}:${port} in ${ms}ms`), { code: "ETIMEDOUT" });
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

/** Errnos that mean no connection was ever established. `getaddrinfo`/`connect` say it by syscall
 * (as `dialFetch`'s bounded connect does); undici's own connect timeout says it by code. Deliberately short — anything not on this list is
 * treated as possibly-delivered (see `postAdmission`). */
const NEVER_DELIVERED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
const NEVER_DELIVERED_SYSCALLS = new Set(["connect", "getaddrinfo"]);

/**
 * Did this rejection happen BEFORE any byte of the request reached the wire?
 *
 * `fetch` reports transport failures as a generic `TypeError: fetch failed` and puts the real
 * errno on `cause`, which for a dual-stack address is an `AggregateError` over one attempt per
 * family — so the answer is only ever legible by walking down. Read structurally (syscall/code),
 * never by matching the message: the message is the part that changes between Node versions.
 */
export function neverDelivered(err: unknown, depth = 0): boolean {
  if (depth > 4 || typeof err !== "object" || err === null) return false;
  const { code, syscall, cause, errors } = err as {
    code?: unknown;
    syscall?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (typeof syscall === "string" && NEVER_DELIVERED_SYSCALLS.has(syscall)) return true;
  if (typeof code === "string" && (code === "UND_ERR_CONNECT_TIMEOUT" || NEVER_DELIVERED_CODES.has(code))) return true;
  if (Array.isArray(errors) && errors.some((nested) => neverDelivered(nested, depth + 1))) return true;
  return neverDelivered(cause, depth + 1);
}
