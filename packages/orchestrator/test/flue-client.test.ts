// Unit tests for the real flue-backed AgentRunPort. The flue SDK client is FAKED (no Harness/cluster
// needed): the adapter depends only on `agents.send` + `agents.stream`, so a hand-driven fake exercises
// every mapping branch — fresh admit, re-attach by offset, the baseline + tool-boundary offset
// checkpoints, terminal/fault detection, and cancel-as-abandon.

import { test } from "node:test";
import assert from "node:assert/strict";
import { flueAgentRunPort } from "../src/flue-client.ts";
import type { FlueAgentRunDep } from "../src/flue-client.ts";
import type { AgentRunInput, AgentToolCall } from "../src/actor.ts";
import type { AttachedAgentEvent } from "@flue/sdk";

/** Build a minimal AttachedAgentEvent (only the fields the adapter reads matter). */
function ev(partial: Record<string, unknown>): AttachedAgentEvent {
  return { v: 3, eventIndex: 0, timestamp: "", instanceId: "inst-1", ...partial } as unknown as AttachedAgentEvent;
}

type Step = { offset: string; event: AttachedAgentEvent };

/** A fake flue stream: advances `.offset` as it yields each scripted step, then waits for abort. */
function fakeStream(script: Step[], signal: AbortSignal | undefined, rec: { aborted: boolean }) {
  let offset = "pre";
  let cancelled = false;
  return {
    cancel() {
      cancelled = true;
    },
    get offset() {
      return offset;
    },
    async *[Symbol.asyncIterator]() {
      for (const step of script) {
        if (cancelled) return;
        offset = step.offset;
        yield step.event;
      }
      // Stay live until abandoned (mirrors a long-running run with no terminal event scripted).
      if (signal && !signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        rec.aborted = true;
      }
    },
  };
}

/** A fake flue SDK client whose stream plays a fixed script; records the `send` call. */
function fakeFlue(script: Step[]): FlueAgentRunDep & {
  sent: Array<{ name: string; id: string; message: string; hasSignal: boolean }>;
  streamAbort: { aborted: boolean };
} {
  const sent: Array<{ name: string; id: string; message: string; hasSignal: boolean }> = [];
  const streamAbort = { aborted: false };
  return {
    sent,
    streamAbort,
    agents: {
      async send(
        name: string,
        id: string,
        options,
      ): Promise<{ streamUrl: string; offset: string; submissionId: string }> {
        sent.push({ name, id, message: options.message, hasSignal: !!options.signal });
        return { streamUrl: "", offset: "off-admit", submissionId: "sub-1" };
      },
      stream(_name: string, _id: string, options) {
        return fakeStream(script, options?.signal, streamAbort) as ReturnType<FlueAgentRunDep["agents"]["stream"]>;
      },
    },
  };
}

const baseInput: AgentRunInput = {
  agentName: "coder",
  instanceId: "inst-1",
  endpoint: "http://harness.invalid", // the fake never dials; the real client is built from this
  prompt: "do the thing",
  tools: [],
};

const toolStart = (offset: string, toolName: string): Step => ({
  offset,
  event: ev({ type: "tool_start", toolName, toolCallId: "tc-1", args: { a: 1 } }),
});
const settled = (outcome: "completed" | "failed", error?: unknown): Step => ({
  offset: "off-end",
  event: ev({ type: "submission_settled", submissionId: "sub-1", outcome, error }),
});

test("fresh admit sends the prompt and surfaces the baseline + tool-boundary offsets", async () => {
  const flue = fakeFlue([toolStart("off-7", "request_review"), settled("completed")]);
  const calls: AgentToolCall[] = [];
  const port = flueAgentRunPort(flue);

  await port.admit(baseInput, (c) => calls.push(c));

  assert.deepEqual(flue.sent, [{ name: "coder", id: "inst-1", message: "do the thing", hasSignal: true }]);
  // Baseline = the admission offset; then the tool call's stream offset.
  assert.deepEqual(
    calls.map((c) => c.offset),
    ["off-admit", "off-7"],
  );
  assert.deepEqual(
    calls.map((c) => c.name),
    ["agent.stream", "request_review"],
  );
});

test("re-attach streams from attachOffset without re-sending the prompt", async () => {
  const flue = fakeFlue([settled("completed")]);
  const calls: AgentToolCall[] = [];
  const port = flueAgentRunPort(flue);

  await port.admit({ ...baseInput, prompt: undefined, attachOffset: "off-resume" }, (c) => calls.push(c));

  assert.deepEqual(flue.sent, [], "re-attach must not call agents.send");
  assert.deepEqual(
    calls.map((c) => c.offset),
    ["off-resume"],
    "baseline checkpoint resumes from the persisted offset",
  );
});

test("a failed submission rejects so the actor surfaces an agent.fault", async () => {
  const flue = fakeFlue([settled("failed", { message: "boom" })]);
  const port = flueAgentRunPort(flue);

  await assert.rejects(() => port.admit(baseInput, () => {}), /flue submission failed: boom/);
});

test("admit with neither prompt nor attachOffset is an error", async () => {
  const flue = fakeFlue([]);
  const port = flueAgentRunPort(flue);

  await assert.rejects(
    () => port.admit({ ...baseInput, prompt: undefined }, () => {}),
    /needs a prompt .* or attachOffset/,
  );
});

test("cancel abandons the run by aborting its stream", async () => {
  const flue = fakeFlue([toolStart("off-1", "check_inbox")]); // no terminal event → stays live
  const port = flueAgentRunPort(flue);

  let resolved = false;
  const admitP = port.admit(baseInput, () => {}).then(() => (resolved = true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resolved, false, "run stays live until abandoned");

  await port.cancel("inst-1");
  await admitP;
  assert.equal(resolved, true, "cancel ends the admission");
  assert.equal(flue.streamAbort.aborted, true, "cancel aborts the stream's signal");
});
