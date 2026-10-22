// Compaction's arithmetic (ADR-0036), at the honest tier: the derivation is pure, so the reserve,
// the small-window floor and the "no declared window means OFF" rule are proven socket-free rather
// than through the turn loop — and so are the estimate, the cut point and the summary call's retry
// and abort, over a fake `Models`. The texts the summarizer reads are pinned against pi 0.82.1's
// own answers in `replay-pi-0.82.1.test.ts`. The MECHANISM — that a cut lands mid-turn and the next
// request carries it — is a conformance claim and lives in `conformance.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { compactIfOver, compactionSettingsFor, overContextThreshold, summaryRetryPolicy } from "../src/compaction.ts";
import type { EngineMessage } from "../src/engine.ts";
import {
  compact,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  prepareCompaction,
} from "../src/compaction-summary.ts";
import { EnginePart, type TranscriptEntry } from "../src/transcript.ts";

test("the reserve is one full response, never less than the floor (ADR-0036)", () => {
  // The threshold is checked BEFORE a request that may emit up to `maxTokens`, so a reserve under
  // one full response reserves nothing. Below the floor the floor wins; above it, `maxTokens`.
  assert.deepEqual(compactionSettingsFor({ contextWindow: 200_000, maxTokens: 8192 }), {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
  });
  assert.deepEqual(compactionSettingsFor({ contextWindow: 131_072, maxTokens: 32_768 }), {
    enabled: true,
    reserveTokens: 32_768,
    keepRecentTokens: 20_000,
  });
});

test("a small window takes flue's floor rather than giving half of itself away", () => {
  // `reserve × 2 ≥ contextWindow` → a third of the window. Without it a 32k model would reserve
  // half its context and compact on its first real tool result.
  assert.deepEqual(compactionSettingsFor({ contextWindow: 32_768, maxTokens: 8192 }), {
    enabled: true,
    reserveTokens: 10_922,
    keepRecentTokens: 20_000,
  });
  // …and the floor under the floor: a third of a tiny window is not a reserve at all.
  assert.deepEqual(compactionSettingsFor({ contextWindow: 1000, maxTokens: 100 }), {
    enabled: true,
    reserveTokens: 1024,
    keepRecentTokens: 20_000,
  });
  // Exactly at the boundary the small-window rule applies (`≥`, not `>`).
  assert.equal(compactionSettingsFor({ contextWindow: 32_768, maxTokens: 16_384 }).reserveTokens, 10_922);
  assert.equal(compactionSettingsFor({ contextWindow: 32_769, maxTokens: 16_384 }).reserveTokens, 16_384);
});

test("a model with no declared contextWindow does not compact — inert, said out loud", () => {
  // `provider.ts` resolves an undeclared limit to 0. Left to the threshold this would compact on
  // EVERY request (`tokens > 0 - reserve`), which is worse than not compacting; silently inert is
  // how the original ADR-0027 regression hid, so the flag is explicit.
  assert.equal(compactionSettingsFor({ contextWindow: 0, maxTokens: 8192 }).enabled, false);
  assert.equal(compactionSettingsFor({ contextWindow: -1, maxTokens: 8192 }).enabled, false);
  assert.equal(compactionSettingsFor({ contextWindow: Number.NaN, maxTokens: 8192 }).enabled, false);
});

test("the retention is jr2's own 20000, and the seam is the conformance suite's alone", () => {
  assert.equal(compactionSettingsFor({ contextWindow: 200_000, maxTokens: 8192 }).keepRecentTokens, 20_000);
  assert.equal(compactionSettingsFor({ contextWindow: 200_000, maxTokens: 8192 }, 12).keepRecentTokens, 12);
});

test("the threshold is strictly over: a context exactly at the reserve still fits", () => {
  const settings = compactionSettingsFor({ contextWindow: 200_000, maxTokens: 8192 });
  assert.equal(overContextThreshold(183_615, 200_000, settings), false);
  assert.equal(overContextThreshold(183_616, 200_000, settings), false, "window − reserve is the last fitting size");
  assert.equal(overContextThreshold(183_617, 200_000, settings), true);
  // A disabled derivation never crosses, whatever the count.
  const off = compactionSettingsFor({ contextWindow: 0, maxTokens: 8192 });
  assert.equal(overContextThreshold(1_000_000, 0, off), false);
});

test("the summarizer states its own retry budget — pi-ai's default is ZERO attempts past the first", () => {
  // `retryAssistantCall` makes no attempt past the first without a policy, and the turn's stream
  // `maxRetries` never reaches this call, so omitting the policy would make ADR-0036's retry
  // budget mean "fails on the first 500".
  assert.equal(summaryRetryPolicy().enabled, true);
  assert.ok(summaryRetryPolicy().maxRetries > 0);
  // A composition that forbids provider retries forbids them here too.
  assert.deepEqual(summaryRetryPolicy(0), { enabled: false, maxRetries: 0, baseDelayMs: 500 });
});

// ─── the estimate and the cut point ──────────────────────────────────────────

const usage = (input: number) => ({
  input,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const user = (text: string): TranscriptEntry => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
});
const assistant = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): TranscriptEntry => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake",
    model: "model-x",
    usage: usage(1000),
    stopReason,
    timestamp: 2,
  },
});
const calls = (id: string): TranscriptEntry => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }],
    api: "openai-completions",
    provider: "fake",
    model: "model-x",
    usage: usage(1000),
    stopReason: "toolUse",
    timestamp: 2,
  },
});
const answered = (id: string, text: string): TranscriptEntry => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
  },
});
const messageOf = (entry: TranscriptEntry) => (entry as { message: EngineMessage }).message;

test("the estimate: characters / 4, 4800 characters an image, a summary by its text", () => {
  assert.equal(estimateTokens(messageOf(user("12345678"))), 2);
  assert.equal(estimateTokens(messageOf(user("123456789"))), 3, "rounded up");
  assert.equal(
    estimateTokens({
      role: "toolResult",
      toolCallId: "i",
      toolName: "read",
      content: [{ type: "image", data: "x", mimeType: "image/png" }],
      isError: false,
      timestamp: 0,
    }),
    1200,
  );
  assert.equal(
    estimateTokens({ role: "compactionSummary", summary: "x".repeat(40), tokensBefore: 1, timestamp: 0 }),
    10,
  );
});

test("the context estimate: the newest valid usage plus the estimate of what came after it", () => {
  const messages = [user("hello"), assistant("hi"), user("12345678")].map(messageOf);
  // `totalTokens` is 0, so the usage is the sum of its parts: 1000 + 10.
  assert.deepEqual(estimateContextTokens(messages), {
    tokens: 1012,
    usageTokens: 1010,
    trailingTokens: 2,
    lastUsageIndex: 1,
  });
  // An aborted or an errored message carries no valid usage.
  const aborted = [user("hello"), assistant("hi", "aborted")].map(messageOf);
  assert.equal(estimateContextTokens(aborted).lastUsageIndex, null);
});

test("the cut point: at a user message, inside a turn (a split turn), or none", () => {
  const entries = [user("u".repeat(400)), calls("c1"), answered("c1", "r".repeat(400)), assistant("a".repeat(400))];
  // A budget that the last message alone fills: the cut is at it, inside the turn that the user
  // message started.
  assert.deepEqual(findCutPoint(entries, 0, entries.length, 50), {
    firstKeptEntryIndex: 3,
    turnStartIndex: 0,
    isSplitTurn: true,
  });
  // A budget that the whole turn fills: the cut is at the user message, which splits nothing.
  assert.deepEqual(findCutPoint(entries, 0, entries.length, 400), {
    firstKeptEntryIndex: 0,
    turnStartIndex: -1,
    isSplitTurn: false,
  });
  // A tool result is never a cut point: with only tool results there is none.
  assert.deepEqual(findCutPoint([answered("c1", "r")], 0, 1, 1), {
    firstKeptEntryIndex: 0,
    turnStartIndex: -1,
    isSplitTurn: false,
  });
});

// ─── the summary call ────────────────────────────────────────────────────────

const model = {
  id: "model-x",
  name: "model-x",
  api: "openai-completions",
  provider: "fake",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} as Model<Api>;

/** A fake registry that answers each summary call with the next step of `answers`. */
function scripted(
  answers: Array<Partial<AssistantMessage> | ((signal?: AbortSignal) => Promise<Partial<AssistantMessage>>)>,
) {
  const seen: Array<{ signal?: AbortSignal }> = [];
  const models = {
    completeSimple: async (_m: Model<Api>, _context: unknown, options: { signal?: AbortSignal }) => {
      seen.push(options);
      const step = answers[seen.length - 1] ?? {};
      const answer = typeof step === "function" ? await step(options.signal) : step;
      return {
        role: "assistant",
        content: [{ type: "text", text: "SUMMARY" }],
        api: "openai-completions",
        provider: "fake",
        model: "model-x",
        usage: usage(10),
        stopReason: "stop",
        timestamp: 0,
        ...answer,
      } as AssistantMessage;
    },
  } as unknown as Models;
  return { models, seen };
}

const settings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1_000_000 };
const prepared = () =>
  prepareCompaction(new EnginePart("t", [user("hello"), assistant("hi")], undefined, undefined).branch(), settings)!;
const fast = (maxRetries: number) => ({ enabled: maxRetries > 0, maxRetries, baseDelayMs: 1 });
const seatOf = (models: Models, maxRetries: number, signal?: AbortSignal) => ({
  models,
  model,
  thinkingLevel: "off" as const,
  retry: fast(maxRetries),
  signal,
});

test("the summary call retries a transient error: a 503, then the summary", async () => {
  const { models, seen } = scripted([
    { stopReason: "error", errorMessage: "503 Service Unavailable", content: [] },
    {},
  ]);
  const done = await compact(prepared(), seatOf(models, 2), settings);
  assert.equal(seen.length, 2);
  assert.equal(done.summary, "SUMMARY");
});

test("a summary call that fails each retry fails with pi's words; with no retries it is asked once", async () => {
  const failing = { stopReason: "error" as const, errorMessage: "500 Internal Server Error", content: [] };
  const three = scripted([failing, failing, failing]);
  await assert.rejects(compact(prepared(), seatOf(three.models, 2), settings), {
    message: "Summarization failed: 500 Internal Server Error",
  });
  assert.equal(three.seen.length, 3);
  const once = scripted([failing]);
  await assert.rejects(compact(prepared(), seatOf(once.models, 0), settings), /^Error: Summarization failed/);
  assert.equal(once.seen.length, 1);
});

test("the summary call gets the run's signal: an abort during the summary ends it", async () => {
  const controller = new AbortController();
  const { models, seen } = scripted([
    (signal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve({ stopReason: "aborted", content: [] }), { once: true });
        setTimeout(() => controller.abort(), 10);
      }),
  ]);
  await assert.rejects(compact(prepared(), seatOf(models, 2, controller.signal), settings), {
    message: "Summarization aborted",
  });
  assert.equal(seen[0]!.signal, controller.signal);
});

test("a model that states no maxTokens: the summary's budget is 0.8 of the reserve, with no cap", async () => {
  // Each replay case has maxTokens 8192, which caps the budget. With no maxTokens (0) the cap is
  // gone, and the budget is floor(0.8 × 16384) = 13107 — pi 0.82.1's number.
  const budgetOf = async (maxTokens: number) => {
    const { models, seen } = scripted([{}]);
    await compact(prepared(), { ...seatOf(models, 0), model: { ...model, maxTokens } }, settings);
    assert.equal(seen.length, 1, "no split turn: one summary request");
    return (seen[0] as { maxTokens?: number }).maxTokens;
  };
  assert.equal(await budgetOf(0), 13_107);
  assert.equal(await budgetOf(8192), 8192);
});

test("an aborted run asks for no summary over a full window: the summary call is never made (I-10)", async () => {
  // pi-ai sends nothing on an aborted signal, so only a count of the calls can see this check.
  const full = (): TranscriptEntry => {
    const entry = assistant("hi");
    (entry as { message: AssistantMessage }).message.usage = usage(190_000);
    return entry;
  };
  const part = () => new EnginePart("t", [user("hello"), full(), user("again"), full()], undefined, undefined);
  const seatFor = (models: Models, signal: AbortSignal | undefined) => ({
    part: part(),
    models,
    model,
    thinkingLevel: "off" as const,
    settings: compactionSettingsFor(model, 1_000),
    retry: fast(0),
    signal,
  });
  const live = scripted([{}]);
  assert.ok(await compactIfOver(seatFor(live.models, undefined)), "the window is full: a live run cuts");
  assert.equal(live.seen.length, 1);
  const controller = new AbortController();
  controller.abort();
  const ended = scripted([{}]);
  assert.equal(await compactIfOver(seatFor(ended.models, controller.signal)), undefined);
  assert.equal(ended.seen.length, 0, "an ended run buys no summarizer round-trip");
});
