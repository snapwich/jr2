// What the Harness is handed (ADR-0018/0027/0049): `definitionFault` must be LOUD about every
// definition that would otherwise become a silently thinner or mute turn — it is the per-admission
// check that replaced the retired boot-time roster sweep — `resolveDefinition` is the
// per-Submission read (the Submission's dials and the `/work`/`write` defaults resolve here, at
// turn start), and `loadHarnessSpec` reads the one thing still mounted: what this instance can
// REACH.

import { test } from "node:test";
import assert from "node:assert/strict";
import { definitionFault, loadHarnessSpec, resolveDefinition, type AgentDefinition } from "../src/spec.ts";

const coder: AgentDefinition = { instructions: "be the coder", model: "anthropic/claude-x" };

test("definitionFault: a complete definition passes", () => {
  assert.equal(definitionFault("coder", coder), undefined);
  assert.equal(
    definitionFault("coder", { ...coder, cwd: "/elsewhere", workspace: "none", thinkingLevel: "high" }),
    undefined,
  );
});

test("definitionFault: NO definition on the admission is the loud one — the Turn carries it (ADR-0049)", () => {
  // The Harness holds no roster to fall back to, so this is not "unknown agent": it is an
  // admission that named a slot and brought nothing to run.
  assert.match(String(definitionFault("coder", undefined)), /agent "coder": the admission carries no definition/);
  assert.match(String(definitionFault("coder", "coder")), /carries no definition/);
});

test("definitionFault: instructions and model are both required, and the message names the slot", () => {
  assert.match(String(definitionFault("coder", { model: "anthropic/claude-x" })), /agent "coder".*no `instructions`/s);
  assert.match(String(definitionFault("coder", { instructions: "i" })), /agent "coder".*names no model/s);
  // No instance-wide model default has ever existed (ADR-0018) — the definition is where a model
  // is checkable, and now it arrives per Turn.
  assert.match(String(definitionFault("coder", { instructions: "i", model: "" })), /no instance-wide default/);
});

test("definitionFault: off-scale enums fail before pi ever sees them", () => {
  assert.match(String(definitionFault("coder", { ...coder, thinkingLevel: "max" })), /thinkingLevel "max"/);
  assert.match(String(definitionFault("coder", { ...coder, workspace: "rw" })), /workspace "rw"/);
  assert.match(String(definitionFault("coder", { ...coder, cwd: 7 })), /`cwd` must be a path string/);
});

test("resolveDefinition: the definition supplies the values; defaults apply", () => {
  assert.deepEqual(resolveDefinition({ instructions: "code", model: "anthropic/claude-x", thinkingLevel: "high" }), {
    model: "anthropic/claude-x",
    instructions: "code",
    cwd: "/work",
    workspace: "write",
    thinkingLevel: "high",
  });
  // `workspace` carries through resolution (ADR-0028) — it is the field the Working-tool assembly
  // filters by, so dropping it here would silently hand a reviewer the write/edit tools.
  assert.deepEqual(
    resolveDefinition({ instructions: "review", model: "vllm/q", cwd: "/elsewhere", workspace: "read" }),
    { model: "vllm/q", instructions: "review", cwd: "/elsewhere", workspace: "read" },
  );
});

test("resolveDefinition: this Submission's dials win over the definition (ADR-0018)", () => {
  const definition: AgentDefinition = { instructions: "code", model: "anthropic/claude-x", thinkingLevel: "low" };
  assert.deepEqual(resolveDefinition(definition, { model: "vllm/big", thinkingLevel: "xhigh" }), {
    model: "vllm/big",
    instructions: "code",
    cwd: "/work",
    workspace: "write",
    thinkingLevel: "xhigh",
  });
  // One dial at a time: the other keeps the definition's value.
  assert.equal(resolveDefinition(definition, { thinkingLevel: "xhigh" }).model, "anthropic/claude-x");
  assert.equal(resolveDefinition(definition, { model: "vllm/big" }).thinkingLevel, "low");
  // Dials are the ONLY overridable fields — identity is definition-only (ADR-0028's `workspace`
  // above all: per-invocation escalation would void its containment claim).
  assert.equal(resolveDefinition(definition, { model: "vllm/big" }).instructions, "code");
});

test("loadHarnessSpec: the provider round-trips", () => {
  const spec = loadHarnessSpec({
    JR2_HARNESS_JSON: JSON.stringify({ provider: { id: "vllm", api: "openai-completions", baseUrl: "https://v/v1" } }),
  });
  assert.equal(spec.provider?.id, "vllm");
});

test("loadHarnessSpec: absent is valid — an instance may name only built-in models", () => {
  assert.deepEqual(loadHarnessSpec({}), {});
  // And it carries no Agents to be absent (ADR-0049): the roster this env var replaced is gone.
  assert.equal("agents" in loadHarnessSpec({ JR2_HARNESS_JSON: "{}" }), false);
});

test("loadHarnessSpec: malformed fails loudly, naming the env var", () => {
  assert.throws(() => loadHarnessSpec({ JR2_HARNESS_JSON: "{nope" }), /JR2_HARNESS_JSON is not JSON/);
  assert.throws(() => loadHarnessSpec({ JR2_HARNESS_JSON: JSON.stringify({ provider: { id: "vllm" } }) }), /baseUrl/);
});
