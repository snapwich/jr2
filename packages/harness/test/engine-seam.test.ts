// The engine seam (ADR-0027, `engine.ts`): the Turn runs through an `EngineAdapter` alone. A small
// fake adapter stands where pi stands, with no provider, no socket and no pi-agent-core: the Turn
// opens its part, gives it the run, hears its events, and settles on its last assistant message.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Engine, EngineAdapter, EngineListener, EngineRun } from "../src/engine.ts";
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
