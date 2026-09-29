// The other two processes a real Agent turn needs, reduced to what conformance asserts about
// (ADR-0027: the flue-contract tier's rig, re-owned — the Harness itself now runs IN-PROCESS):
//
//   the provider  — a scripted OpenAI-compatible fake, so a turn's SHAPE is chosen by the test
//                   (where it stalls, what it half-emits, when it fails) instead of by a model.
//                   Records every request body, which is the only place context loss is visible.
//   the Custodian — what answers at `$JR2_CUSTODIAN_URL`, over a real socket: the Orchestrator's
//                   surface and delivery routes as the Custodian relays them, a surface that can
//                   be killed or swapped mid-run (what a state exit does to a registration), and
//                   deliveries that can be held open (an abort mid-tool-call). The Custodian's
//                   own claims are its suite's (ADR-0059); what the Harness owes is here.
//
// Both are SHARED across a file's tests (`reset` rearms them per scenario), so per-scenario
// servers do not each wait out a keep-alive to close.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { Surface } from "../../src/menu.ts";

/** What the Harness container's env holds for the Sandbox token: its Stand-in (ADR-0059). */
export const SANDBOX_STAND_IN = "jr2-held-JR2_SANDBOX_TOKEN";

// ─── the scripted provider ───────────────────────────────────────────────────

/** One streaming response, under the test's control. `stall` holds the socket open forever. */
export type Turn = {
  text?: string;
  /** Emit a tool call. `partial` stops after the name — no arguments, no finish, no `[DONE]`. */
  toolCall?: { id: string; name: string; args?: string; partial?: boolean };
  stall?: boolean;
  /** Answer this HTTP status with an error body instead of a stream — the provider-failure lever
   * (with `maxRetries: 0` the turn settles `failed` on the first attempt). */
  status?: number;
  /** The usage this response reports — Compaction's only lever (ADR-0036), since a scripted
   * transcript can never fill a real window. pi DERIVES its total from the parts rather than
   * reading `total_tokens`, so the fabricated context size goes in `prompt_tokens`. */
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** One request body, as the provider received it. `tools` is where the Menu is visible — the same bytes on every Turn (ADR-0029). */
export type RecordedCall = {
  messages: Array<Record<string, unknown>>;
  tools?: Array<{ function?: { name?: string } }>;
  /** The model id the request named — the only witness that a per-turn dial reached the wire. */
  model?: string;
  /** The thinking level the request named. pi writes a non-`off` level as `reasoning_effort` for
   * every model declaring `reasoning` (which `provider.ts` does for the custom provider), so this
   * is where a Turn's level is visible — including on the summarizer's own request (ADR-0036). */
  reasoning_effort?: string;
  /** Arrival order across BOTH streams (turn requests and summarizer requests), from 1. Compaction
   * happens at a step the test does not choose, so this is the only witness that the cut landed
   * BETWEEN two requests of one turn rather than at a turn boundary. */
  seq: number;
};

export type FakeProvider = {
  url: string;
  /** Every request body the provider received since the last `reset`, in order. */
  calls: RecordedCall[];
  /** The compaction summarizer's requests (ADR-0036) — pi's own LLM call, recorded APART from
   * `calls`: it fires at a step the test does not choose, so letting it consume a script slot
   * would shift every later turn and quietly break the exact-count assertions. */
  summaries: RecordedCall[];
  /** What any summarization request answers with. `status` is the compaction-failure lever. */
  summarize: (answer: { text?: string; status?: number; stall?: boolean }) => void;
  /** True while a scripted response is deliberately holding its socket open. */
  stalled: () => boolean;
  /** Rearm for the next scenario: forget recorded calls, swap the script. */
  reset: (script: Turn[]) => void;
  close: () => Promise<void>;
};

/** How a summarization request is told apart from a turn request: pi sends it standalone, with its
 * own system prompt and no tools (`SUMMARIZATION_SYSTEM_PROMPT`, matched on its opening clause). */
const SUMMARIZER_MARK = "You are a context summarization assistant";

/** `script[n]` answers call n+1; anything past the end answers plain text. */
export async function startFakeProvider(initialScript: Turn[] = []): Promise<FakeProvider> {
  let script = initialScript;
  const calls: RecordedCall[] = [];
  const summaries: RecordedCall[] = [];
  let summaryAnswer: { text?: string; status?: number; stall?: boolean } = {};
  let seq = 0;
  let stalling = 0;

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      if (!req.url?.includes("chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "model-x" }] }));
        return;
      }
      const body = JSON.parse(raw) as RecordedCall & { stream?: boolean };
      seq += 1;
      body.seq = seq;
      // pi's summarizer request is not a scripted turn: it arrives at a step the test did not
      // choose, so it is recorded apart and answered from `summarize` (ADR-0036).
      const summarizing = raw.includes(SUMMARIZER_MARK);
      let turn: Turn;
      if (summarizing) {
        summaries.push(body);
        turn = { text: summaryAnswer.text ?? "## Goal\nEverything before this was summarized.", ...summaryAnswer };
      } else {
        calls.push(body);
        turn = script[calls.length - 1] ?? { text: `turn ${calls.length}` };
      }
      const id = `chatcmpl-${seq}`;
      const created = Math.floor(Date.now() / 1000);
      // `total_tokens` is decoration: pi derives the total from the parts, so a scripted context
      // size only counts when it rides in `prompt_tokens`.
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, ...turn.usage };

      if (turn.status !== undefined) {
        res.writeHead(turn.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "scripted provider failure" } }));
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const frame = (delta: unknown, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "model-x", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );

      if (turn.text !== undefined) {
        frame({ role: "assistant" });
        frame({ content: turn.text });
      }
      if (turn.toolCall) {
        const { id: callId, name, args, partial } = turn.toolCall;
        frame({ tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: "" } }] });
        if (!partial) frame({ tool_calls: [{ index: 0, function: { arguments: args ?? "{}" } }] });
      }
      if (turn.stall) {
        stalling += 1;
        const keepalive = setInterval(() => res.write(": keepalive\n\n"), 5000);
        res.on("close", () => {
          clearInterval(keepalive);
          stalling -= 1;
        });
        return;
      }
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "model-x", choices: [{ index: 0, delta: {}, finish_reason: turn.toolCall ? "tool_calls" : "stop" }], usage })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    summaries,
    summarize: (answer) => (summaryAnswer = answer),
    stalled: () => stalling > 0,
    reset: (next) => {
      script = next;
      calls.length = 0;
      summaries.length = 0;
      summaryAnswer = {};
      seq = 0;
    },
    close: () => {
      server.closeAllConnections();
      return close(server);
    },
  };
}

// ─── the Custodian's address, answering for a killable Orchestrator ──────────

export type FakeSandbox = {
  url: string;
  /** What the next surface read serves — a Machine state change, or a guard that changed its
   * answer, between two Submissions (ADR-0029: the Allowed picks move, the Menu does not). */
  setSurface: (surface: Surface) => void;
  /** What a state exit does to the registration: every later surface read is a 404. */
  killSurface: () => void;
  reviveSurface: () => void;
  /**
   * What a BLIP does to it, which is a different claim (ADR-0026): a 404 means "this turn is
   * over", and the Harness settles it `aborted` without asking the model; anything else is a Menu
   * it could not read at all. Only this lever produces the second — the leg of a turn that runs
   * BEFORE the model is ever asked.
   */
  faultSurface: (status?: number) => void;
  /** A stopping Orchestrator (ADR-0026): the next `reads` surface reads answer 503, then it is
   * back — what a rollout looks like from the Harness. */
  stopFor: (reads: number) => void;
  /** Every pick delivered since the last `reset`, in order. */
  delivered: Array<Record<string, unknown>>;
  /** Every surface read since the last `reset`. */
  reads: () => number;
  /** Every bearer the Harness presented, in order — the Stand-in, never a token. */
  bearers: string[];
  /** Park every LATER delivery after recording it — the abort-mid-tool-call lever. */
  holdDeliveries: () => void;
  /** Rearm for the next scenario: this surface, live, responding, nothing delivered. */
  reset: (surface: Surface) => void;
  close: () => Promise<void>;
};

export async function startFakeCustodian(initialSurface: Surface): Promise<FakeSandbox> {
  let surface = initialSurface;
  let live = true;
  let holding = false;
  let surfaceFault: number | undefined;
  let stopping = 0;
  let surfaceReads = 0;
  const delivered: Array<Record<string, unknown>> = [];
  const bearers: string[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      bearers.push(req.headers.authorization ?? "");
      if (req.url?.endsWith("/surface")) surfaceReads += 1;
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (!live) return json(404, { error: "no live agent surface" });
      if (req.url?.endsWith("/surface")) {
        if (surfaceFault !== undefined) return json(surfaceFault, { error: "scripted orchestrator failure" });
        if (stopping > 0) {
          stopping -= 1;
          return json(503, { error: "the Orchestrator is stopping" });
        }
        return json(200, surface);
      }
      const event = JSON.parse(raw) as Record<string, unknown>;
      delivered.push(event);
      if (holding) return; // parked: the response never comes
      json(200, { delivered: true, event: event.type, turnComplete: true, deliveryId: `d-${delivered.length}` });
    });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    setSurface: (next) => (surface = next),
    killSurface: () => (live = false),
    reviveSurface: () => (live = true),
    faultSurface: (status = 500) => (surfaceFault = status),
    stopFor: (reads) => (stopping = reads),
    delivered,
    reads: () => surfaceReads,
    bearers,
    holdDeliveries: () => (holding = true),
    reset: (next) => {
      surface = next;
      live = true;
      holding = false;
      surfaceFault = undefined;
      stopping = 0;
      surfaceReads = 0;
      delivered.length = 0;
      bearers.length = 0;
    },
    close: () => {
      server.closeAllConnections();
      return close(server);
    },
  };
}

// ─── small helpers ───────────────────────────────────────────────────────────

/** Poll until `predicate` holds. The three processes settle on their own clocks. */
export async function until(predicate: () => boolean | Promise<boolean>, what: string, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Sever every idle keep-alive socket `fetch`'s global dispatcher holds — the Menu's and pi's
 * provider sockets. Teardown-only (fetch is dead afterwards): without it a fake's `close` waits out
 * the server's keep-alive timeout on sockets nothing will reuse. The
 * dispatcher has no public accessor; Node parks it on this well-known symbol.
 */
export async function severKeepAliveSockets(): Promise<void> {
  const dispatcher = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("undici.globalDispatcher.1")] as
    | { destroy?: () => Promise<void> }
    | undefined;
  await dispatcher?.destroy?.();
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}
