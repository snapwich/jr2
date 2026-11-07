// Compaction's arithmetic and seat (ADR-0036), at the honest tier: the derivation is pure, so the
// reserve, the small-window floor and the "no declared window means OFF" rule are proven
// socket-free rather than through the turn loop — and so are the summary call's retry and abort and
// the cases where no cut is taken, over a fake `Models`. The cut and the summary texts are pi's own
// (`pi-compaction.ts`), tested upstream. The MECHANISM — that a cut lands mid-turn and the next
// request carries it — is a conformance claim and lives in `conformance.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, AssistantMessage, Message, Model, Models } from "@earendil-works/pi-ai";
import { compactIfOver, compactionSettingsFor, summaryRetryPolicy } from "../src/compaction.ts";
import { prepareCompaction, sessionChain, shouldCompact } from "../src/pi-compaction.ts";
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

test("pi's rule with jr2's setting: strictly over, so a context exactly at the reserve still fits", () => {
  const settings = compactionSettingsFor({ contextWindow: 200_000, maxTokens: 8192 });
  assert.equal(shouldCompact(183_615, 200_000, settings), false);
  assert.equal(shouldCompact(183_616, 200_000, settings), false, "window − reserve is the last fitting size");
  assert.equal(shouldCompact(183_617, 200_000, settings), true);
  // A disabled derivation never crosses, whatever the count.
  const off = compactionSettingsFor({ contextWindow: 0, maxTokens: 8192 });
  assert.equal(shouldCompact(1_000_000, 0, off), false);
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

// ─── the seat ────────────────────────────────────────────────────────────────

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
const assistant = (
  text: string,
  input = 1000,
  stopReason: AssistantMessage["stopReason"] = "stop",
): TranscriptEntry => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake",
    model: "model-x",
    usage: usage(input),
    stopReason,
    timestamp: 2,
  },
});

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

type Seen = { signal?: AbortSignal; maxTokens?: number };

/** A fake registry that answers each summary call with the next step of `answers`. pi asks through
 * the stream function, and reads its `result()`. */
function scripted(
  answers: Array<Partial<AssistantMessage> | ((signal?: AbortSignal) => Promise<Partial<AssistantMessage>>)>,
) {
  const seen: Seen[] = [];
  const models = {
    streamSimple: (_m: Model<Api>, _context: unknown, options: Seen) => {
      seen.push(options);
      const step = answers[seen.length - 1] ?? {};
      return {
        result: async () =>
          ({
            role: "assistant",
            content: [{ type: "text", text: "SUMMARY" }],
            api: "openai-completions",
            provider: "fake",
            model: "model-x",
            usage: usage(10),
            stopReason: "stop",
            timestamp: 0,
            ...(typeof step === "function" ? await step(options.signal) : step),
          }) as AssistantMessage,
      };
    },
  } as unknown as Models;
  return { models, seen };
}

/** A transcript whose newest usage fills the window: the next request cuts. */
const full = (): TranscriptEntry[] => [
  user("hello"),
  assistant("hi", 190_000),
  user("again"),
  assistant("ok", 190_000),
];
const fast = (maxRetries: number) => ({ enabled: maxRetries > 0, maxRetries, baseDelayMs: 1 });
const seatFor = (part: EnginePart, models: Models, maxRetries: number, signal?: AbortSignal) => ({
  part,
  models,
  model,
  thinkingLevel: "off" as const,
  // Keep the second prompt and its answer: the cut is at a user message, so one summary request.
  settings: compactionSettingsFor(model, 3),
  retry: fast(maxRetries),
  signal,
});
const messageOf = (entry: TranscriptEntry) => (entry as { message: Message }).message;
const compactions = (part: EnginePart) => part.all().filter((entry) => entry.type === "compaction");

test("a cut at a Submission's prompt is a split turn: pi's cut moves back over the mark", () => {
  // The mark is a custom entry with no context (`sessionChain`), as pi's own state entries are, so
  // the cut that falls on the second prompt moves back to the mark, and the turn it splits is the
  // first Submission's.
  const entries: TranscriptEntry[] = [
    { type: "submission" },
    user("u".repeat(400)),
    assistant("a".repeat(400)),
    { type: "submission" },
    user("v".repeat(400)),
  ];
  const prepared = prepareCompaction(sessionChain(entries), { enabled: true, reserveTokens: 1, keepRecentTokens: 50 });
  assert.ok(prepared);
  assert.equal(prepared.firstKeptEntryId, "3");
  assert.equal(prepared.isSplitTurn, true);
});

test("the summary call retries a transient error: a 503, then the summary", async () => {
  const { models, seen } = scripted([
    { stopReason: "error", errorMessage: "503 Service Unavailable", content: [] },
    {},
  ]);
  const part = new EnginePart("t", full(), undefined, undefined);
  assert.ok(await compactIfOver(seatFor(part, models, 2)));
  assert.equal(seen.length, 2);
  assert.match((compactions(part)[0] as { summary: string }).summary, /^SUMMARY/);
});

test("a summary call that fails each retry fails with pi's words; with no retries it is asked once", async () => {
  const failing = { stopReason: "error" as const, errorMessage: "500 Internal Server Error", content: [] };
  const three = scripted([failing, failing, failing]);
  const part = new EnginePart("t", full(), undefined, undefined);
  await assert.rejects(compactIfOver(seatFor(part, three.models, 2)), {
    message: "Summarization failed: 500 Internal Server Error",
  });
  assert.equal(three.seen.length, 3);
  assert.equal(compactions(part).length, 0, "a failed summary appends nothing");
  const once = scripted([failing]);
  await assert.rejects(compactIfOver(seatFor(part, once.models, 0)), /^Error: Summarization failed/);
  assert.equal(once.seen.length, 1);
});

test("an abort during the summary ends it, and appends nothing: pi would store the summary it got", async () => {
  // pi fails a summary that ended `error` or `length`, not one that ended `aborted`. The seat
  // throws for an aborted run, so no empty or partial summary becomes the context.
  const controller = new AbortController();
  const { models, seen } = scripted([
    (signal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve({ stopReason: "aborted", content: [] }), { once: true });
        setTimeout(() => controller.abort(), 10);
      }),
  ]);
  const part = new EnginePart("t", full(), undefined, undefined);
  const before = part.all().length;
  await assert.rejects(compactIfOver(seatFor(part, models, 2, controller.signal)), {
    message: "Summarization aborted",
  });
  assert.equal(seen[0]!.signal, controller.signal, "the summary call gets the run's signal");
  assert.equal(part.all().length, before, "the aborted summary appended no Compaction");
});

test("the summary request states no maxTokens: its budget is the model's output limit (pi #9512)", async () => {
  const { models, seen } = scripted([{}]);
  await compactIfOver(seatFor(new EnginePart("t", full(), undefined, undefined), models, 0));
  assert.equal(seen.length, 1, "no split turn: one summary request");
  assert.equal(seen[0]!.maxTokens, undefined);
});

test("an aborted run asks for no summary over a full window: the summary call is never made (I-10)", async () => {
  // pi-ai sends nothing on an aborted signal, so only a count of the calls can see this check.
  const live = scripted([{}]);
  assert.ok(
    await compactIfOver(seatFor(new EnginePart("t", full(), undefined, undefined), live.models, 0)),
    "the window is full: a live run cuts",
  );
  assert.equal(live.seen.length, 1);
  const controller = new AbortController();
  controller.abort();
  const ended = scripted([{}]);
  assert.equal(
    await compactIfOver(seatFor(new EnginePart("t", full(), undefined, undefined), ended.models, 0, controller.signal)),
    undefined,
  );
  assert.equal(ended.seen.length, 0, "an ended run buys no summarizer round-trip");
});

test("no second cut on the reading that crossed: pi's estimate does not trust a usage from before the cut", async () => {
  // A cut keeps recent assistant messages, and so the usage that crossed. A request after the cut
  // that ends `error` adds no usage of its own. pi's projected estimate then counts the text of the
  // context, which the cut made small.
  const { models, seen } = scripted([{}, {}]);
  const part = new EnginePart("t", full(), undefined, undefined);
  assert.ok(await compactIfOver(seatFor(part, models, 0)));
  part.appendMessage(messageOf(assistant("", 0, "error")));
  assert.equal(await compactIfOver(seatFor(part, models, 0)), undefined);
  assert.equal(seen.length, 1, "one summary request for one crossing");
  // A usage AFTER the cut that crosses again is trusted, and cuts again.
  part.appendMessage(messageOf(user("more")));
  part.appendMessage(messageOf(assistant("big", 190_000)));
  assert.ok(await compactIfOver(seatFor(part, models, 0)));
  assert.equal(compactions(part).length, 2);
});

test("a second cut when the text itself is still over: pi's estimate counts the text, and the text crosses", async () => {
  // The other side of the case above. After a cut and a request that ends `error`, pi's projected
  // estimate counts the text of the context (chars/4). When that text is still over the window less
  // the reserve, the context really is over, and the next request cuts again by pi's rule. A pi bump
  // that changes this rule fails here.
  const { models, seen } = scripted([{}, {}]);
  const part = new EnginePart("t", full(), undefined, undefined);
  assert.ok(await compactIfOver(seatFor(part, models, 0)));
  part.appendMessage(messageOf(user("x".repeat(800_000))));
  part.appendMessage(messageOf(assistant("", 0, "error")));
  assert.ok(await compactIfOver(seatFor(part, models, 0)), "the text estimate crossed, so pi cuts again");
  assert.equal(seen.length, 2, "one summary request for each crossing");
  assert.equal(compactions(part).length, 2);
});
