// The wire-compatible stub Harness (ADR-0011: dev stubbing happens at the wire, not in the
// actor). `j2 dev` hosts this on localhost so workspace-less test workflows can run without a
// cluster: an endpoint is just a URL, so `agentRun` keeps ONE code path and cannot tell it is
// talking to a fake. Semantics: ADMIT the agent (accept the prompt, mint an admission), hold
// the durable stream open, and never act — the Machine parks exactly as it would against a
// silent real Harness, and e2e drives it by playing the agent against `/mcp/<iid>` instead.
//
// Wire (ADR-0027 — the normative model of the five endpoints; `@j2/harness` serves it for real):
//   POST /agents/:name/:id  {message}  → 200 { streamUrl, offset, submissionId }
//   GET  /agents/:name/:id?offset=…[&view=updates] → 200 `[]` + Stream-Next-Offset/Up-To-Date
//   GET  /agents/:name/:id?…&live=long-poll        → parked; 204 + same headers on timeout
//   POST /agents/:name/:id/abort                   → 200 { aborted }
//   GET  /agents/:name/:id?view=history            → 200 { …, settlements }
// (the client's `wait(admission)` long-polls `streamUrl?view=updates` from the admission offset;
// an empty stream parks it — exactly the "admitted, never settles" semantics the mechanics tier
// needs.) The client then re-polls calmly at the long-poll cadence. `close()` severs parked polls.
//
// A stub submission therefore ends exactly one way: ABORTED, when the state that asked for the
// turn stops waiting (ADR-0024). That is what `history`'s `settlements` carries, and it is the
// only place a black-box test can see a turn end — the run itself is untouched by an abort.
//
// This can later grow scriptable behavior or be swapped for a real local Harness without
// touching actor code — it is only a different URL.
//
// `onAdmit` is the seam where an AGENT would live (ADR-0013). Left unset — as `j2 dev` leaves it —
// the stub is inert, which is what the mechanics tier needs (the Machine parks and e2e plays the
// agent from outside). The dev Harness IMAGE wires a scripted persona into it instead, so the pod
// originates its own tool calls through the Adapter on `localhost`. The hook receives the
// admission, iid and all: the Harness names the iid itself, the persona never picks one.

import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** One admission of an Agent: which persona, which durable exchange, and the prompt. */
export type Admission = { agentName: string; instanceId: string; message?: string };

/** One settled submission, in the shape `history()` reports it. The stub settles submissions for
 * exactly one reason — an abort (ADR-0024) — so `outcome` has exactly one value here. */
export type StubSettlement = { submissionId: string; outcome: "aborted" };

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
const ABORT_PATH = /^\/agents\/([^/]+)\/([^/]+)\/abort$/;

/** Start the stub Harness. Never acts: admit → hold the stream open → answer polls "empty". */
export async function startStubHarness(opts: StubHarnessOptions = {}): Promise<RunningStubHarness> {
  const hostname = opts.hostname ?? "127.0.0.1";
  const longPollMs = opts.longPollMs ?? 25_000;
  const admissions: RunningStubHarness["admissions"] = [];
  let submissionSeq = 0;

  // Per-instance submission bookkeeping — the little that abort needs to mean anything (ADR-0024).
  // A stub submission never settles on its own (that IS its semantics), so "unsettled" is simply
  // "admitted and not yet aborted", and an abort sweeps ALL of them: the running Submission AND
  // everything queued behind it (ADR-0024/0027).
  const unsettled = new Map<string, string[]>();
  const settlements = new Map<string, StubSettlement[]>();
  const key = (agentName: string, instanceId: string) => `${agentName}/${instanceId}`;

  // Parked long-polls hold sockets open; close() must sever them or it hangs on graceful close.
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");

    // End every in-flight and queued submission for one instance (`agents.abort` — ADR-0024).
    // Answers `{ aborted }`: whether there was anything to end, exactly as the real Harness
    // does for an idle instance. Settlement is recorded here rather than pushed on the stream, because nothing is
    // listening — the actor that asked for the turn is already stopped.
    const aborting = req.method === "POST" && ABORT_PATH.exec(url.pathname);
    if (aborting) {
      const [, agentName, instanceId] = aborting as unknown as [string, string, string];
      const k = key(decodeURIComponent(agentName), decodeURIComponent(instanceId));
      const ended = unsettled.get(k)?.splice(0) ?? [];
      const settled = settlements.get(k) ?? [];
      settled.push(...ended.map((submissionId) => ({ submissionId, outcome: "aborted" as const })));
      settlements.set(k, settled);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ aborted: ended.length > 0 }));
      return;
    }

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
        const submissionId = `stub-${++submissionSeq}`;
        const k = key(admission.agentName, admission.instanceId);
        unsettled.set(k, [...(unsettled.get(k) ?? []), submissionId]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            streamUrl: `http://${hostname}:${port}${url.pathname}`,
            offset: "0_0",
            submissionId,
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

    if (req.method === "GET" && url.searchParams.get("view") === "history") {
      // The conversation snapshot (`agents.history`). Messages are not modeled — the stub has no
      // model — but SETTLEMENTS are, because `settlements[].outcome` is how a turn's end is
      // observed from outside (ADR-0024) and what the @kind tier asserts.
      const k = key(decodeURIComponent(agentName), decodeURIComponent(instanceId));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          v: 1,
          conversationId: decodeURIComponent(instanceId),
          offset: "0_0",
          messages: [],
          settlements: settlements.get(k) ?? [],
        }),
      );
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
