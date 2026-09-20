// The @kind tier's scripted MODEL (ADR-0038). The pod runs the STOCK Harness now — the dev Harness
// image and its hand-rolled MCP client are gone — so the only thing this tier still fakes is the
// LLM. Substitution moved from the image to the provider: `harness.provider` already accepts any
// OpenAI-compatible `baseUrl`, so pointing the instance at this endpoint runs the real `@jr2/harness`
// with pi, the real Menu over MCP, and the real Working tools, while the test still chooses every
// turn's shape. That is what makes this tier a SECOND pi canary beside the conformance suite.
//
// Ported from `packages/harness/test/support/rig.ts`'s `startFakeProvider`, with four deltas the
// @kind placement forces:
//
//  1. NON-STREAMING answers. `jr2 up`'s provider preflight (ADR-0019) POSTs `/chat/completions`
//     WITHOUT `stream` and demands `choices[0].message.tool_calls`, on every scenario's converge —
//     a stream-only fake would fail 100% of scenarios at `Given the kind instance is serving`.
//     `GET /models` must answer too.
//  2. A HOLD/RELEASE queue instead of a fixed script array. A parked turn is a held provider
//     request: the Machine parks because the model has not answered yet, which is exactly what a
//     real Agent that is still thinking looks like. "The Agent calls X" is the host RELEASING that
//     request with a tool call. It must never be a plain-text answer — a turn that settles
//     `completed` with no pick burns the no-signal nudge budget and then faults (ADR-0016).
//  3. Binds 0.0.0.0 and reports its PORT, so the World can publish a pod-reachable base URL
//     (localhost never works from a pod — ADR-0019 says so in `HarnessProvider.baseUrl`).
//  4. Holds the request that FOLLOWS a tool result too. After a pick the Harness asks the model
//     again; if that answered, the submission could settle `completed` before the state-exit abort
//     landed, making `completed` vs `aborted` a coin flip in the ADR-0024 scenarios. Held, the
//     abort is the only settlement.
//
// Releases are matched by the OFFERED TOOL, not by arrival order, and that is load-bearing: after a
// pick, the previous submission's post-tool-result request is still parked beside the next state's
// fresh one. A model can only answer with a tool it was offered, so "the request offering `ship`"
// names the turn `shipping` asked for and nothing else.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

/** One request body as the provider received it. `tools` is where the per-turn Menu is visible:
 * the Menu the invoking state derived (as `mcp__jr2__<name>`, the model-facing name `menu.ts`
 * mints) plus the Working tools the definition's `workspace` left in place (ADR-0028). */
export type RecordedCall = {
  /** Model-facing tool names, in the order the Harness offered them. */
  tools: string[];
  /** The model id the request named — `<model>` after the provider prefix (ADR-0018). */
  model?: string;
  /** True for a turn request; false for `jr2 up`'s converge-time preflight, which never streams. */
  stream: boolean;
  /** The whole body, serialized — where a tool RESULT is visible (the messages a step asserts on). */
  raw: string;
  /** Arrival order from 1, across preflight and turn requests alike. */
  seq: number;
};

export type FakeProvider = {
  /** The listening port — the World composes the pod-reachable base URL from it. */
  port: number;
  /** Every request body received, in order. */
  calls: RecordedCall[];
  /**
   * Answer the parked turn request that was offered `tool` with a call to it, then let the stream
   * finish. `tool` is the bare name (`finish`, or a Working tool like `bash`); the Menu's
   * `mcp__jr2__` prefix is matched and emitted for you. Waits for such a request to arrive.
   */
  release(tool: string, args: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
};

/** One turn request, parked with its SSE stream already open (see `release`). */
type Held = {
  call: RecordedCall;
  res: ServerResponse;
  keepalive: NodeJS.Timeout;
  done: boolean;
};

/** Every model this endpoint claims to serve. The id is committed in the instance config's
 * `harness.provider.models` too — a custom provider id has no catalog entry, so unset token limits
 * resolve to 0 and leave Compaction no budget (ADR-0036). */
const MODEL_ID = "model-x";

export async function startFakeProvider(): Promise<FakeProvider> {
  const calls: RecordedCall[] = [];
  const held: Held[] = [];
  const sockets = new Set<Socket>();
  let seq = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk));
    req.on("end", () => {
      // Anything that is not a completion is the model LIST (`GET /models`, the first half of the
      // converge preflight). Answered unconditionally: this fake serves exactly one model.
      if (!req.url?.includes("chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
        return;
      }

      const body = JSON.parse(raw) as {
        stream?: boolean;
        model?: string;
        tools?: Array<{ function?: { name?: string } }>;
      };
      seq += 1;
      const call: RecordedCall = {
        tools: (body.tools ?? []).map((t) => t.function?.name ?? "?"),
        ...(body.model ? { model: body.model } : {}),
        stream: body.stream === true,
        raw,
        seq,
      };
      calls.push(call);

      if (!call.stream) {
        // `jr2 up`'s preflight (ADR-0019): one trivial completion that MUST answer with tool_calls,
        // proving the endpoint can do tool calling at all. It offers a single `ping` tool; answer
        // whatever it offered, so the probe's own contract is what decides the name.
        answerPreflight(res, call.tools[0] ?? "ping");
        return;
      }

      // A turn request: park it. The Machine is now waiting on a model that has not answered —
      // which is the state every @kind scenario starts a step from.
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const entry: Held = {
        call,
        res,
        // SSE comments: legal, ignored by every parser, and the reason a request can be parked for
        // a minute of `kubectl` steps without any intermediary calling the socket idle.
        keepalive: setInterval(() => res.write(": keepalive\n\n"), 5000),
        done: false,
      };
      held.push(entry);
      res.on("close", () => finish(entry));
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "0.0.0.0", () => resolve((server.address() as AddressInfo).port));
  });

  return {
    port,
    calls,
    release: async (tool, args) => {
      const wanted = [`mcp__jr2__${tool}`, tool];
      const entry = await until(
        () => held.find((h) => !h.done && h.call.tools.some((t) => wanted.includes(t))),
        // Lazily rendered: what makes a miss debuggable is the menus seen by the TIME IT GAVE UP,
        // not the (usually empty) set at the moment the step started polling. The total request
        // count is in the message because it splits the two failure classes an empty menu list
        // cannot: "the pod never reached this endpoint at all" (0 requests — look at the network
        // and the Harness pod's logs) vs "requests arrived but no turn ever parked" (preflights
        // only, or a stream that closed early — look at the turn admission).
        () =>
          `a parked turn request offering "${tool}" (menus seen: ${JSON.stringify(held.map((h) => h.call.tools))}; ` +
          `${calls.length} request(s) ever received, ${calls.filter((c) => c.stream).length} streaming)`,
      );
      const name = wanted.find((w) => entry.call.tools.includes(w))!;
      streamToolCall(entry.res, name, JSON.stringify(args));
      finish(entry);
    },
    close: async () => {
      for (const entry of held) finish(entry);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

/** Mark a parked request settled and stop its keepalive — from `release`, from `close`, and from
 * the socket closing under us (which is what an ADR-0024 abort does to the request it ends). */
function finish(entry: Held): void {
  if (entry.done) return;
  entry.done = true;
  clearInterval(entry.keepalive);
}

/** The non-streaming answer shape `jr2 up`'s probe reads: `choices[0].message.tool_calls`. */
function answerPreflight(res: ServerResponse, toolName: string): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: `chatcmpl-preflight`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_preflight", type: "function", function: { name: toolName, arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
}

/** Finish a parked stream as one tool call. The name is the MODEL-FACING one (`mcp__jr2__<tool>`
 * for a Menu pick — `menu.ts` mints it and pi matches on it), and `finish_reason: "tool_calls"` is
 * what makes pi execute rather than end the turn. */
function streamToolCall(res: ServerResponse, name: string, args: string): void {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const frame = (delta: unknown, finish_reason: string | null = null, usage?: unknown): void => {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: MODEL_ID,
        choices: [{ index: 0, delta, finish_reason }],
        ...(usage ? { usage } : {}),
      })}\n\n`,
    );
  };
  frame({ role: "assistant" });
  frame({ tool_calls: [{ index: 0, id: `call_${created}`, type: "function", function: { name, arguments: "" } }] });
  frame({ tool_calls: [{ index: 0, function: { arguments: args } }] });
  frame({}, "tool_calls", { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
  res.write("data: [DONE]\n\n");
  res.end();
}

/** Poll until `pick` answers something. Everything here waits on a real pod's real turn loop, so
 * the budget is generous and the failure message carries what WAS seen. */
async function until<T>(pick: () => T | undefined, what: () => string, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = pick();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what()}`);
    await sleep(200);
  }
}
