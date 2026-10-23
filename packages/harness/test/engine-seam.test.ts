// The engine seam (ADR-0027, `engine.ts`): the Turn runs through an `EngineAdapter` alone. A small
// fake adapter stands where pi stands, with no provider, no socket and no pi-agent-core: the Turn
// opens its part, gives it the run, hears its events, and settles on its last assistant message.
// The last test holds the pi adapter to the seam's order of tool calls, through pi-ai's faux
// provider: no socket.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import type { Engine, EngineAdapter, EngineListener, EngineRun, EngineTool } from "../src/engine.ts";
import { piAdapter } from "../src/pi-engine.ts";
import { modelsFor } from "../src/provider.ts";
import type { HistoryMessage } from "../src/wire.ts";
import { openEnginePart } from "../src/transcript.ts";
import { runSubmissionFor } from "../src/turn.ts";

const models = modelsFor(
  { provider: { id: "fake", api: "openai-completions", baseUrl: "http://unused.invalid", models: { m: {} } } },
  {},
);

/** The Custodian's surface read, answered in process: a Menu with nothing in it. */
const fetchSurface: typeof fetch = async () =>
  new Response(JSON.stringify({ instanceId: "i", runId: "r", menu: [], allowed: [] }), {
    headers: { "content-type": "application/json" },
  });

test("a Turn runs on any EngineAdapter: the part it opens, the run it gives, the events it hears", async () => {
  const opened: string[] = [];
  const runs: EngineRun[] = [];
  const adapter: EngineAdapter = {
    open: (seat, first) => {
      opened.push(first.cwd);
      return openEnginePart(seat, "fake", first);
    },
    make: (options): Engine => {
      const listeners: EngineListener[] = [];
      const emit = async (event: Parameters<EngineListener>[0]) => {
        for (const listener of listeners) await listener(event, new AbortController().signal);
      };
      return {
        async run(run) {
          runs.push(run);
          assert.equal(await options.hooks.beforeRequest(undefined), undefined, "nothing to compact");
          await emit({ type: "message_end", message: { role: "user", content: run.prompt, timestamp: 1 } });
          const answer: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            api: run.model.api,
            provider: run.model.provider,
            model: run.model.id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 2,
          };
          await emit({ type: "message_end", message: answer });
          await emit({ type: "step_boundary", message: answer, toolResults: [] });
        },
        steer: () => assert.fail("nothing changed, so nothing is steered"),
        abort: () => {},
        subscribe(listener) {
          listeners.push(listener);
          return () => listeners.splice(listeners.indexOf(listener), 1);
        },
      };
    },
  };
  const history: HistoryMessage[] = [];
  const printed: string[] = [];
  const turn = runSubmissionFor({
    models,
    menu: { url: "http://custodian.invalid", token: "t", fetch: fetchSurface },
    agentName: "coder",
    instanceId: "i",
    appendMessage: (message) => history.push(message),
    printerOut: { write: (chunk: string) => void printed.push(chunk) },
    engineAdapter: adapter,
  });
  await turn(
    { message: "go", cwd: "/w", definition: { model: "fake/m", instructions: "be brief" } },
    new AbortController().signal,
  );

  assert.deepEqual(opened, ["/w"]);
  assert.equal(runs.length, 1);
  assert.match(runs[0]!.prompt, /^go\n/);
  assert.match(runs[0]!.systemPrompt, /^be brief/);
  assert.deepEqual(history.at(-1), { role: "assistant", text: "done" });
  assert.match(printed.join(""), /\[coder\] \[text\] done/);
});

test("the pi adapter runs the calls of one model answer one at a time, in the model's order (ADR-0027)", async () => {
  // pi's own default is `parallel`: there the second call starts while the first still runs.
  const faux = fauxProvider();
  const registry = createModels();
  registry.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("slow", {}, { id: "c1" }), fauxToolCall("fast", {}, { id: "c2" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const seen: string[] = [];
  const tool = (name: string, ms: number): EngineTool => ({
    name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => {
      seen.push(`${name} start`);
      await sleep(ms);
      seen.push(`${name} end`);
      return { content: [{ type: "text", text: name }] };
    },
  });
  const engine = piAdapter.make({
    id: "seam",
    models: registry,
    maxRetries: 0,
    hooks: {
      convertToLlm: (messages) => messages as Message[],
      beforeRequest: async () => undefined,
      beforeToolCall: ({ name }) => {
        seen.push(`${name} asked`);
        return undefined;
      },
      endsRun: () => false,
    },
  });
  await engine.run({
    model: faux.getModel(),
    thinkingLevel: "off",
    systemPrompt: "",
    tools: [tool("slow", 30), tool("fast", 0)],
    context: [],
    prompt: "go",
  });
  assert.deepEqual(seen, ["slow asked", "slow start", "slow end", "fast asked", "fast start", "fast end"]);
});

test("the Turn blocks a second pick of one model answer: the first is the first pick the engine asked about in that answer (ADR-0024)", async () => {
  // The Turn's `beforeToolCall`, asked by a fake engine inside a run: no claim, no Menu socket. The
  // engine tells each model answer before it asks about its calls (`engine.ts`).
  const verdicts: Array<string | undefined> = [];
  const answer = (timestamp: number): AssistantMessage => ({
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "fake",
    model: "m",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp,
  });
  const adapter: EngineAdapter = {
    open: (seat, first) => openEnginePart(seat, "fake", first),
    make: (options): Engine => {
      const listeners: EngineListener[] = [];
      const told = async (message: AssistantMessage) => {
        for (const listener of listeners)
          await listener({ type: "message_end", message }, new AbortController().signal);
      };
      const ask = (name: string) =>
        verdicts.push(options.hooks.beforeToolCall({ name, args: { n: verdicts.length } })?.block);
      return {
        async run() {
          await told(answer(1));
          ask("bash");
          ask("mcp__jr2__run_tests");
          ask("mcp__jr2__finish");
          ask("read");
          await told(answer(2));
          ask("mcp__jr2__finish");
        },
        steer: () => {},
        abort: () => {},
        subscribe(listener) {
          listeners.push(listener);
          return () => listeners.splice(listeners.indexOf(listener), 1);
        },
      };
    },
  };
  const turn = runSubmissionFor({
    models,
    menu: { url: "http://custodian.invalid", token: "t", fetch: fetchSurface },
    agentName: "coder",
    instanceId: "i",
    appendMessage: () => {},
    printerOut: { write: () => {} },
    engineAdapter: adapter,
  });
  await turn(
    { message: "go", cwd: "/w", definition: { model: "fake/m", instructions: "be brief" } },
    new AbortController().signal,
  );
  assert.deepEqual(verdicts, [
    undefined,
    undefined,
    "This pick did not run: you sent it before you read the answer to `mcp__jr2__run_tests`.",
    undefined,
    undefined,
  ]);
});
