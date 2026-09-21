// A Turn's input as a TYPE (ADR-0057), asserted by the compiler — `pnpm typecheck` is what runs
// this file: every `@ts-expect-error` below fails the build if the refusal it names stops
// happening, and every unannotated literal fails if the acceptance it relies on breaks.
//
// The claim: a Turn's input is its FRAME, its DIALS, and whether it CONTINUES — nothing else.
// Identity stays on the definition, and MECHANISM (where the Harness is, which Sandbox scopes the
// deliveries) is not an authoring surface at all: it is {@link AgentTurnPlacement}, the seat the
// stub tier sits in because it has no `workspace()` to resolve from — and sits in for real: the
// stub-tier invokes in `_fixtures.ts` annotate their inputs with it, so an author key that crept
// back in would fail there too. The Frame's `cwd` also left the definition, since a Worktree path
// exists only once a run has a branch.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentTurnInput, AgentTurnPlacement } from "../src/actor.ts";
import type { AgentDefinition } from "../src/agent.ts";

// The whole surface, accepted as written.
const turn: AgentTurnInput = {
  prompt: "summarize the diff",
  cwd: "/work/target/feature",
  continue: true,
  model: "anthropic/claude-sonnet-4-6",
  thinkingLevel: "high",
};

// @ts-expect-error `endpoint` is mechanism (AgentTurnPlacement), never something a state writes
const endpointed: AgentTurnInput = { prompt: "go", endpoint: "http://harness.invalid" };

// @ts-expect-error `sandbox` is mechanism too — a real run resolves it ambiently (ADR-0016)
const sandboxed: AgentTurnInput = { prompt: "go", sandbox: "jr2-ws-1" };

// @ts-expect-error the Menu override retired: the Menu is derived from the state's transitions
const menued: AgentTurnInput = { prompt: "go", tools: ["done"] };

// @ts-expect-error identity is the definition's — an invocation that rewrote it would lie
const identified: AgentTurnInput = { prompt: "go", instructions: "be someone else" };

// The mechanics tier states both, beside the Frame.
const stubbed: AgentTurnInput & AgentTurnPlacement = {
  prompt: "go",
  endpoint: "http://harness.invalid",
  sandbox: "jr2-ws-1",
};

// @ts-expect-error the seat carries mechanism ONLY — it is no way back to the retired Menu
const stubbedMenu: AgentTurnInput & AgentTurnPlacement = { prompt: "go", tools: ["done"] };

// @ts-expect-error `cwd` left the definition with ADR-0057 — it is the Frame's
const rooted: AgentDefinition = { model: "vllm/qwen", instructions: "i", cwd: "/work" };

test("the Turn's input is its Frame, its Dials, and whether it continues — the checks above are the compiler's", () => {
  assert.equal(turn.prompt, "summarize the diff");
  assert.equal(stubbed.endpoint, "http://harness.invalid");
  assert.ok(endpointed && sandboxed && menued && identified && stubbedMenu && rooted);
});
