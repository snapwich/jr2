// A `fetch` over a Unix socket (ADR-0076): how the Harness sends each control request — the Menu,
// a pick, a delivery poll, a notice's acknowledgment — to the Custodian's control socket under
// `/run/jr2`, not to a loopback port. The domain cannot make a socket there, so it cannot take the
// control listener's place while the Custodian restarts, and never receives the control Stand-in.
//
// It answers as the global `fetch` does, for what `menu.ts` reads: a `Response` for every HTTP
// status, and a rejection on a transport failure — a `TypeError("fetch failed")` whose `cause` is
// the errno (`connect ENOENT …`, `connect ECONNREFUSED …`), as undici's is. An abort rejects with
// the signal's reason.

import { request } from "node:http";
import { Readable } from "node:stream";

/** The statuses whose response has no body: a `Response` refuses one. */
const NULL_BODY = new Set([101, 204, 205, 304]);

/** A `fetch` whose every request goes to the socket at `socketPath`; the URL gives the path. */
export function unixFetch(socketPath: string): typeof globalThis.fetch {
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
      // One connection for each request, never a pooled one: a connection that a restarted
      // Custodian closed would fail a pick as "may have reached", where a new one fails to connect.
      const req = request({
        agent: false,
        socketPath,
        method: init.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers: { host: url.host, ...headers },
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
    })) as typeof globalThis.fetch;
}
