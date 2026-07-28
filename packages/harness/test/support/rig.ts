// The other two processes a real Agent turn needs, reduced to what conformance asserts about
// (ADR-0027: the flue-contract tier's rig, re-owned — the Harness itself now runs IN-PROCESS):
//
//   the provider  — a scripted OpenAI-compatible fake, so a turn's SHAPE is chosen by the test
//                   (where it stalls, what it half-emits, when it fails) instead of by a model.
//                   Records every request body, which is the only place context loss is visible.
//   the Adapter   — the REAL `@j2/adapter`, over a real socket, against a fake Orchestrator whose
//                   surface can be killed or swapped mid-run (what a state exit does to a
//                   registration) and whose deliveries can be held open (an abort mid-tool-call).
//
// Both are SHARED across a file's tests (`reset` rearms them per scenario): every conversation
// leaks exactly one Menu connection by design (turn.ts closes the previous turn's, never the
// last), so per-scenario servers would each wait out a keep-alive to close.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { OrchestratorClient, startAdapter, type Surface } from "@j2/adapter";

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
};

/** One request body, as the provider received it. `tools` is where the per-turn Menu is visible. */
export type RecordedCall = {
  messages: Array<Record<string, unknown>>;
  tools?: Array<{ function?: { name?: string } }>;
};

export type FakeProvider = {
  url: string;
  /** Every request body the provider received since the last `reset`, in order. */
  calls: RecordedCall[];
  /** True while a scripted response is deliberately holding its socket open. */
  stalled: () => boolean;
  /** Rearm for the next scenario: forget recorded calls, swap the script. */
  reset: (script: Turn[]) => void;
  close: () => Promise<void>;
};

/** `script[n]` answers call n+1; anything past the end answers plain text. */
export async function startFakeProvider(initialScript: Turn[] = []): Promise<FakeProvider> {
  let script = initialScript;
  const calls: RecordedCall[] = [];
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
      calls.push(body);
      const n = calls.length;
      const turn = script[n - 1] ?? { text: `turn ${n}` };
      const id = `chatcmpl-${n}`;
      const created = Math.floor(Date.now() / 1000);
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

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
    stalled: () => stalling > 0,
    reset: (next) => {
      script = next;
      calls.length = 0;
    },
    close: () => {
      server.closeAllConnections();
      return close(server);
    },
  };
}

// ─── the real Adapter, over a killable fake Orchestrator ─────────────────────

export type FakeSandbox = {
  url: string;
  /** The Menu the next surface read serves — a Machine state change, between two Submissions. */
  setSurface: (surface: Surface) => void;
  /** What a state exit does to the registration: every later surface read is a 404. */
  killSurface: () => void;
  reviveSurface: () => void;
  /** Every pick delivered since the last `reset`, in order. */
  delivered: Array<Record<string, unknown>>;
  /** Park every LATER delivery after recording it — the abort-mid-tool-call lever. The parked
   * response never resolves; a bare pending promise holds no handle, so nothing leaks. */
  holdDeliveries: () => void;
  /** Rearm for the next scenario: this surface, live, responding, nothing delivered. */
  reset: (surface: Surface) => void;
  close: () => Promise<void>;
};

export async function startAdapterOverFakeOrchestrator(initialSurface: Surface): Promise<FakeSandbox> {
  let surface = initialSurface;
  let live = true;
  let holding = false;
  const delivered: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    if (!live) return new Response(JSON.stringify({ error: "no live agent surface" }), { status: 404 });
    if (String(input).endsWith("/surface")) return Response.json(surface);
    const event = JSON.parse(String(init?.body)) as Record<string, unknown>;
    delivered.push(event);
    if (holding) await new Promise<never>(() => {});
    return Response.json({
      delivered: true,
      event: event.type,
      turnComplete: true,
      deliveryId: `d-${delivered.length}`,
    });
  };
  const adapter = await startAdapter({
    orchestrator: new OrchestratorClient({
      url: "http://orchestrator.invalid",
      token: "ws-1.signed",
      fetch: fetchImpl,
    }),
    port: 0,
  });
  return {
    url: adapter.url,
    setSurface: (next) => (surface = next),
    killSurface: () => (live = false),
    reviveSurface: () => (live = true),
    delivered,
    holdDeliveries: () => (holding = true),
    reset: (next) => {
      surface = next;
      live = true;
      holding = false;
      delivered.length = 0;
    },
    close: adapter.close,
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
 * Sever every idle keep-alive socket `fetch`'s global dispatcher holds — the leaked Menu
 * connections and pi's provider sockets. Teardown-only (fetch is dead afterwards): without it the
 * Adapter's `close` waits out the server's keep-alive timeout on sockets nothing will reuse. The
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
