// Compaction's arithmetic (ADR-0036), at the honest tier: the derivation is pure, so the reserve,
// the small-window floor and the "no declared window means OFF" rule are proven socket-free rather
// than through the turn loop. The MECHANISM — that a cut lands mid-turn and the next request
// carries it — is a conformance claim and lives in `conformance.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { compactionSettingsFor, overContextThreshold, summaryRetryPolicy } from "../src/compaction.ts";

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

test("the summarizer states its own retry budget — pi's default is ZERO attempts past the first", () => {
  // `retryAssistantCall` reads `policy?.enabled ? policy.maxRetries : 0`, and the turn's stream
  // `maxRetries` never reaches this call, so omitting the policy would make ADR-0036's "fails
  // after pi's retries" mean "fails on the first 500".
  assert.equal(summaryRetryPolicy().enabled, true);
  assert.ok(summaryRetryPolicy().maxRetries > 0);
  // A composition that forbids provider retries forbids them here too.
  assert.deepEqual(summaryRetryPolicy(0), { enabled: false, maxRetries: 0, baseDelayMs: 500 });
});
