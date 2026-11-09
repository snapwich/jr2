// The Harness on its port: the listen, what a listen that fails says, and the shutdown a signal
// runs. `main.ts` calls it once; tests call it with their own `say` and `exit`.

import { STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type { HarnessServer } from "./app.ts";
import { LAND_ID } from "./handoff-land-main.ts";

export type Served = {
  server: ServerType;
  /** The drain, then exit 0 (ADR-0031): admit nothing more, let every admitted Submission settle,
   * then close. Bounded by nothing here — the pod's termination grace bounds it. */
  stop: () => Promise<void>;
};

export type ServeOptions = {
  port: number;
  hostname?: string;
  /** The one line a fatal listen writes — the pod log (stderr) unless a test collects it. */
  say?: (line: string) => void;
  exit?: (code: number) => void;
  /** How long answers already on their way get to leave once the drain is over. */
  flushMs?: number;
};

/**
 * What a listen that failed says, when jr2 can say more than the errno: a port another container in
 * the pod took (scaling review R16, ADR-0063). The pod has one network namespace, so a User
 * Container or a Sandbox Image process that binds 8080 takes the Harness's port — and the Harness's
 * last log line is the provision's fault reason (`FallbackToLogsOnError`), so it names the port and
 * the cause in words, not as a stack.
 */
export function listenFault(err: unknown, port: number): string | undefined {
  if ((err as NodeJS.ErrnoException | undefined)?.code !== "EADDRINUSE") return undefined;
  return (
    `port ${port} is taken inside this pod: another container listens on it — ` +
    "the Harness's and the Custodian's ports are the pod's (ADR-0005)"
  );
}

/**
 * node ends a request whose body still comes after its `requestTimeout` (300 s) with 408. Every
 * route keeps that bound but one: the body of `PUT /handoffs/<id>` is a whole carry, which can take
 * longer (ADR-0080). That request gets a time of its own instead, longer than the Orchestrator's
 * carry (`HANDOFF_LAND_MS`, `handoff-land.ts`), and the land ends at it. node tells a request past
 * its time as a `clientError`, and a server with a `clientError` listener answers it itself, so
 * this listener answers as node does for every other socket.
 */
export function spareLands(server: Server): void {
  const landing = new WeakSet<Socket>();
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "PUT" || !LAND_URL.test(req.url ?? "")) return;
    landing.add(req.socket);
    res.once("close", () => landing.delete(req.socket));
  });
  server.on("clientError", (err: NodeJS.ErrnoException, socket: Socket) => {
    if (err.code === "ERR_HTTP_REQUEST_TIMEOUT" && landing.has(socket)) return;
    // What node writes with no listener (`socketOnError`, node 24).
    const status =
      err.code === "ERR_HTTP_REQUEST_TIMEOUT"
        ? 408
        : err.code === "HPE_HEADER_OVERFLOW"
          ? 431
          : err.code === "HPE_CHUNK_EXTENSIONS_OVERFLOW"
            ? 413
            : 400;
    const sent = (socket as Socket & { _httpMessage?: { _headerSent?: boolean } })._httpMessage?._headerSent;
    if (socket.writable && !sent)
      socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
    socket.destroy(err);
  });
}

/** The raw url of `PUT /handoffs/<id>`, with an id of the form that `LAND_ID` takes. It holds no
 * `.` and no `%`, so the path that Hono routes on is this one: `/handoffs/../agents` is not spared. */
const LAND_URL = new RegExp(`^/handoffs/${LAND_ID.source.slice(1, -1)}(?:\\?|$)`);

export function serveHarness(harness: HarnessServer, opts: ServeOptions): Served {
  const say = opts.say ?? ((line: string) => console.error(line));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const server = serve({ fetch: harness.app.fetch, port: opts.port, hostname: opts.hostname ?? "0.0.0.0" }, (info) => {
    // No agent count: this process holds no roster to count (ADR-0049) — every admission brings
    // the definition it runs.
    console.log(`jr2 harness serving on :${(info as AddressInfo).port}`);
  });
  spareLands(server as Server);
  server.on("error", (err) => {
    const fault = listenFault(err, opts.port);
    if (!fault) throw err;
    // One line and exit 1: a stack under it would push the cause out of the fallback's tail.
    say(fault);
    exit(1);
  });

  const stop = async (): Promise<void> => {
    await harness.drain();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeIdleConnections" in server) server.closeIdleConnections();
      // Parked long-polls hold sockets open, and a graceful close would wait them out past the
      // pod's termination grace. Every Submission has settled by now, and where the Harness
      // persists its conversations the Settlements are in the record: a severed read loses
      // nothing, because the Orchestrator's `wait` reconnects from its offset (ADR-0021).
      setTimeout(() => {
        if ("closeAllConnections" in server) server.closeAllConnections();
      }, opts.flushMs ?? 1000).unref();
    });
    exit(0);
  };
  return { server, stop };
}
