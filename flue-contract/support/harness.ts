// The three processes a real Agent turn needs, reduced to what the contract asserts about:
//
//   the provider  — a scripted OpenAI-compatible fake, so a turn's SHAPE is chosen by the test
//                   (where it stalls, what it half-emits) instead of by a model. Records every
//                   request body, which is the only place the defect under test is visible.
//   the Adapter   — the REAL `@j2/adapter`, over a real socket, against a fake Orchestrator whose
//                   surface can be killed mid-turn (what a state exit does to a registration).
//   the Harness   — the REAL flue node server at the pinned version, as a child process, built by
//                   flue's own CLI. Not a stub: a stub is what cannot see any of this.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { OrchestratorClient, startAdapter, type Surface } from "@j2/adapter";

/** The package root — `dist/server.mjs` is written there by `flue build`. */
const PKG = fileURLToPath(new URL("..", import.meta.url));

// ─── the scripted provider ───────────────────────────────────────────────────

/** One streaming response, under the test's control. `stall` holds the socket open forever. */
export type Turn = {
  text?: string;
  /** Emit a tool call. `partial` stops after the name — no arguments, no finish, no `[DONE]`. */
  toolCall?: { id: string; name: string; args?: string; partial?: boolean };
  stall?: boolean;
};

export type FakeProvider = {
  url: string;
  /** Every request body the provider received, in order. Index 0 is the first turn. */
  calls: Array<{ messages: Array<Record<string, unknown>> }>;
  /** True while a scripted response is deliberately holding its socket open. */
  stalled: () => boolean;
  close: () => Promise<void>;
};

/** `script[n]` answers call n+1; anything past the end answers plain text. */
export async function startFakeProvider(script: Turn[]): Promise<FakeProvider> {
  const calls: FakeProvider["calls"] = [];
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
      const body = JSON.parse(raw) as { messages: Array<Record<string, unknown>>; stream?: boolean };
      calls.push(body);
      const n = calls.length;
      const id = `chatcmpl-${n}`;
      const created = Math.floor(Date.now() / 1000);
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model: "model-x",
            choices: [{ index: 0, message: { role: "assistant", content: `turn ${n}` }, finish_reason: "stop" }],
            usage,
          }),
        );
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const frame = (delta: unknown, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "model-x", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );

      const turn = script[n - 1] ?? { text: `turn ${n}` };
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
    close: () => close(server),
  };
}

// ─── the real Adapter, over a killable fake Orchestrator ─────────────────────

export type FakeSandbox = {
  url: string;
  /** What a state exit does to the registration: every later surface read is a 404. */
  killSurface: () => void;
  reviveSurface: () => void;
  delivered: Array<Record<string, unknown>>;
  close: () => Promise<void>;
};

export async function startAdapterOverFakeOrchestrator(surface: Surface): Promise<FakeSandbox> {
  let live = true;
  const delivered: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    if (!live) return new Response(JSON.stringify({ error: "no live agent surface" }), { status: 404 });
    if (String(input).endsWith("/surface")) return Response.json(surface);
    const event = JSON.parse(String(init?.body)) as Record<string, unknown>;
    delivered.push(event);
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
    killSurface: () => (live = false),
    reviveSurface: () => (live = true),
    delivered,
    close: adapter.close,
  };
}

// ─── the real flue Harness ───────────────────────────────────────────────────

export type Harness = { url: string; output: () => string; close: () => Promise<void> };

/** Start the built flue node server. `pnpm test:contract` runs `flue build` first. */
export async function startHarness(env: { providerUrl: string; adapterUrl: string }): Promise<Harness> {
  const probe = createServer();
  const port = await listen(probe);
  await close(probe);

  const child: ChildProcess = spawn(process.execPath, ["dist/server.mjs"], {
    cwd: PKG,
    env: {
      ...process.env,
      PORT: String(port),
      J2_CONTRACT_PROVIDER_URL: env.providerUrl,
      J2_ADAPTER_URL: env.adapterUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (c: Buffer) => (output += c));
  child.stderr?.on("data", (c: Buffer) => (output += c));

  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`the Harness exited (${child.exitCode}):\n${output}`);
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
      return { url, output: () => output, close: () => kill(child) };
    } catch {
      await sleep(100);
    }
  }
  await kill(child);
  throw new Error(`the Harness never came up:\n${output}`);
}

// ─── small helpers ───────────────────────────────────────────────────────────

/** Poll until `predicate` holds. Everything here is asynchronous across three processes. */
export async function until(predicate: () => boolean | Promise<boolean>, what: string, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

function kill(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}
