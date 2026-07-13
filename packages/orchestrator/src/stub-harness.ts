// The wire-compatible stub Harness (ADR-0011: dev stubbing happens at the wire, not in the
// actor). `j2 dev` hosts this on localhost so workspace-less test workflows can run without a
// cluster: an endpoint is just a URL, so `agentRun` keeps ONE code path and cannot tell it is
// talking to a fake. Semantics: ADMIT the agent (accept the prompt, mint an admission), hold
// the durable stream open, and never act — the Machine parks exactly as it would against a
// silent real Harness, and e2e drives it by playing the agent against `/mcp/<iid>` instead.
//
// Wire (verified against the real `@flue/sdk` client):
//   POST /agents/:name/:id  {message}  → 200 { streamUrl, offset, submissionId }
//   GET  /agents/:name/:id?offset=…            → 200 `[]` + Stream-Next-Offset/Up-To-Date
//   GET  /agents/:name/:id?…&live=long-poll    → parked; 204 + same headers on timeout
// The client then re-polls calmly at the long-poll cadence. `close()` severs parked polls.
//
// This can later grow scriptable behavior or be swapped for a real local Harness without
// touching actor code — it is only a different URL.
//
// `onAdmit` is the seam where an AGENT would live (ADR-0013). Left unset — as `j2 dev` leaves it —
// the stub is inert, which is what the mechanics tier needs (the Machine parks and e2e plays the
// agent from outside). The dev Harness IMAGE wires a scripted persona into it instead, so the pod
// originates its own tool calls through the Adapter on `localhost`. The hook receives the
// admission, iid and all: like flue's per-submission initializer, the Harness names the iid itself.

import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** One admission of an Agent: which persona, which durable exchange, and the prompt. */
export type Admission = { agentName: string; instanceId: string; message?: string };

export type StubHarnessOptions = {
  /** Listen port. Default 0 → ephemeral (read back from `url`). */
  port?: number;
  /** Listen hostname. Default `127.0.0.1`. */
  hostname?: string;
  /** How long a live long-poll parks before answering "nothing yet". Default 25s. */
  longPollMs?: number;
  /**
   * Play the Agent for this admission (the dev Harness image's persona — see header). Runs after
   * the admission is acknowledged, so a persona that drives its Machine cannot deadlock the very
   * response its Machine is waiting on. A rejection is logged, never thrown: an Agent that fails
   * its turn leaves the Machine parked, exactly as a silent real Agent would.
   */
  onAdmit?: (admission: Admission) => void | Promise<void>;
};

export type RunningStubHarness = {
  /** The base URL — what a test workflow passes as its run-input `endpoint`. */
  url: string;
  /** Admissions seen so far (assertable in tests: which agents were admitted, with what). */
  admissions: Admission[];
  close: () => Promise<void>;
};

const AGENT_PATH = /^\/agents\/([^/]+)\/([^/]+)$/;

/** Start the stub Harness. Never acts: admit → hold the stream open → answer polls "empty". */
export async function startStubHarness(opts: StubHarnessOptions = {}): Promise<RunningStubHarness> {
  const hostname = opts.hostname ?? "127.0.0.1";
  const longPollMs = opts.longPollMs ?? 25_000;
  const admissions: RunningStubHarness["admissions"] = [];
  let submissionSeq = 0;

  // Parked long-polls hold sockets open; close() must sever them or it hangs on graceful close.
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const match = AGENT_PATH.exec(url.pathname);
    if (!match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `stub harness: no route ${url.pathname}` }));
      return;
    }
    const [, agentName, instanceId] = match as unknown as [string, string, string];

    if (req.method === "POST") {
      // Admission: accept the prompt, mint the durable handle, then hand it to the persona (if any).
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk));
      req.on("end", () => {
        const message = (safeParse(body) as { message?: string } | undefined)?.message;
        const admission: Admission = {
          agentName: decodeURIComponent(agentName),
          instanceId: decodeURIComponent(instanceId),
          message,
        };
        admissions.push(admission);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            streamUrl: `http://${hostname}:${port}${url.pathname}`,
            offset: "0_0",
            submissionId: `stub-${++submissionSeq}`,
          }),
        );
        // After the ack, never before it: the persona's tool call travels Adapter → Orchestrator →
        // Machine, and the Machine is inside the very `agentRun` invoke this response settles.
        void Promise.resolve(opts.onAdmit?.(admission)).catch((err: unknown) => {
          console.error(`agent turn failed for "${admission.instanceId}":`, err);
        });
      });
      return;
    }

    if (req.method === "GET") {
      // Durable-stream read. The stream never carries anything: a catch-up read answers
      // "empty, up to date" immediately; a live long-poll parks until timeout, then 204s.
      const offset = url.searchParams.get("offset") ?? "0_0";
      const headers = { "stream-next-offset": offset, "stream-up-to-date": "true" };
      if (url.searchParams.get("live") === "long-poll") {
        const timer = setTimeout(() => {
          res.writeHead(204, headers);
          res.end();
        }, longPollMs);
        req.on("close", () => clearTimeout(timer));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", ...headers });
      res.end("[]");
      return;
    }

    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `stub harness: ${req.method} not supported` }));
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(opts.port ?? 0, hostname, () => resolve((server.address() as AddressInfo).port));
  });

  return {
    url: `http://${hostname}:${port}`,
    admissions,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        for (const socket of sockets) socket.destroy(); // sever parked long-polls
      }),
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
