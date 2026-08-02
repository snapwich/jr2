// The J2_AGENTS_JSON contract (ADR-0018/0027): `loadSpec` must be LOUD about every spec that would
// otherwise become a silently thinner or mute Harness, and `resolveDefinition` is the
// per-Submission read — the Submission's dials and the `/work`/`write` defaults resolve here, at
// turn start.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSpec, resolveDefinition, type AgentsSpec } from "../src/spec.ts";

const coder = { name: "coder", definition: { instructions: "be the coder", model: "anthropic/claude-x" } };

function env(spec: unknown): Record<string, string | undefined> {
  return { J2_AGENTS_JSON: JSON.stringify(spec) };
}

test("loadSpec: a valid spec round-trips", () => {
  const spec = loadSpec(
    env({ agents: [coder], harness: { provider: { id: "vllm", api: "openai-completions", baseUrl: "https://v/v1" } } }),
  );
  assert.equal(spec.agents.length, 1);
  assert.equal(spec.harness?.provider?.id, "vllm");
});

test("loadSpec: no J2_AGENTS_JSON fails loudly — the ConfigMap was not mounted", () => {
  assert.throws(() => loadSpec({}), /J2_AGENTS_JSON/);
});

test("loadSpec: non-JSON fails loudly, naming the env var", () => {
  assert.throws(() => loadSpec({ J2_AGENTS_JSON: "{nope" }), /J2_AGENTS_JSON is not JSON/);
});

test("loadSpec: zero agents fails — nothing to serve", () => {
  assert.throws(() => loadSpec(env({ agents: [] })), /no Agent definitions/);
  assert.throws(() => loadSpec(env({})), /no Agent definitions/);
});

test("loadSpec: an entry without instructions is not a definition", () => {
  assert.throws(() => loadSpec(env({ agents: [{ name: "a", definition: {} }] })), /agent "a" is not a definition/);
  assert.throws(() => loadSpec(env({ agents: [{ definition: { instructions: "i" } }] })), /is not a definition/);
});

test("loadSpec: a definition naming no model fails — there is no instance-wide default (ADR-0018)", () => {
  const modelless = { name: "a", definition: { instructions: "i" } };
  assert.throws(() => loadSpec(env({ agents: [modelless] })), /agent "a" names no model/);
});

test("loadSpec: a duplicated agent name fails — names are conversation routes", () => {
  assert.throws(() => loadSpec(env({ agents: [coder, coder] })), /agent "coder" is defined twice/);
});

test("resolveDefinition: the definition supplies the values; defaults apply", () => {
  const spec: AgentsSpec = {
    agents: [
      { name: "coder", definition: { instructions: "code", model: "anthropic/claude-x", thinkingLevel: "high" } },
      { name: "reviewer", definition: { instructions: "review", model: "vllm/q", cwd: "/elsewhere", access: "read" } },
    ],
  };
  assert.deepEqual(resolveDefinition(spec, "coder"), {
    model: "anthropic/claude-x",
    instructions: "code",
    cwd: "/work",
    access: "write",
    thinkingLevel: "high",
  });
  // `access` carries through resolution (ADR-0028) — it is the field the Working-tool assembly
  // filters by, so dropping it here would silently hand a reviewer the write/edit tools.
  assert.deepEqual(resolveDefinition(spec, "reviewer"), {
    model: "vllm/q",
    instructions: "review",
    cwd: "/elsewhere",
    access: "read",
  });
});

test("resolveDefinition: this Submission's dials win over the definition (ADR-0018 as amended)", () => {
  const spec: AgentsSpec = {
    agents: [
      { name: "coder", definition: { instructions: "code", model: "anthropic/claude-x", thinkingLevel: "low" } },
    ],
  };
  assert.deepEqual(resolveDefinition(spec, "coder", { model: "vllm/big", thinkingLevel: "xhigh" }), {
    model: "vllm/big",
    instructions: "code",
    cwd: "/work",
    access: "write",
    thinkingLevel: "xhigh",
  });
  // One dial at a time: the other keeps the definition's value.
  assert.equal(resolveDefinition(spec, "coder", { thinkingLevel: "xhigh" }).model, "anthropic/claude-x");
  assert.equal(resolveDefinition(spec, "coder", { model: "vllm/big" }).thinkingLevel, "low");
  // Dials are the ONLY overridable fields — identity is definition-only (ADR-0028's `access`
  // above all: per-invocation escalation would void its containment claim).
  assert.equal(resolveDefinition(spec, "coder", { model: "vllm/big" }).instructions, "code");
});

test("resolveDefinition: an unknown agent fails — the pod predates a rename", () => {
  assert.throws(() => resolveDefinition({ agents: [coder] }, "ghost"), /agent "ghost" is not in the mounted spec/);
});
