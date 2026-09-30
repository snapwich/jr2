// The Harness on its port: the listen, what a listen that fails says, and the shutdown a signal
// runs. `main.ts` calls it once; tests call it with their own `say` and `exit`.

import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type { HarnessServer } from "./app.ts";

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
    "the Harness's and the Custodian's ports are the pod's (CONTEXT.md)"
  );
}

export function serveHarness(harness: HarnessServer, opts: ServeOptions): Served {
  const say = opts.say ?? ((line: string) => console.error(line));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const server = serve({ fetch: harness.app.fetch, port: opts.port, hostname: opts.hostname ?? "0.0.0.0" }, (info) => {
    // No agent count: this process holds no roster to count (ADR-0049) — every admission brings
    // the definition it runs.
    console.log(`jr2 harness serving on :${(info as AddressInfo).port}`);
  });
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
