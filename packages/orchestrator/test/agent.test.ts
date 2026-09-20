// The Agent as a slot (ADR-0049): `agent(definition)` brands its logic with the definition, and
// `isAgent` is how everything else — the menu walk above all — recognizes one. There is nothing
// else in this module: the instance roster it also held (`agents/` discovery, read by `jr2 up` into
// a ConfigMap) retired when the definition began riding the Turn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromCallback } from "xstate";
import { isAgent, isOpenAgent, requireBoundAgent, type AgentDeclaration, type AgentDefinition } from "../src/agent.ts";
import { agent } from "../src/harness-client.ts";
import { open } from "../src/open.ts";

test("agent(def) is actor logic BRANDED with its definition — the whole slot mechanism (ADR-0049)", () => {
  const definition: AgentDefinition = { model: "m", instructions: "i", workspace: "none" };
  const logic = agent(definition);

  assert.ok(isAgent(logic), "the menu walk recognizes it by the brand, not by a reserved src name");
  assert.equal((logic as unknown as { definition: AgentDefinition }).definition, definition, "the same object");
  // Two slots over ONE definition are two DISTINCT logics: the closure is per-slot, which is what
  // lets two Machines each carry their own `coder`.
  assert.notEqual(agent(definition), logic);
});

test("isAgent rejects everything that is not a slot — a provide() fake included", () => {
  assert.equal(isAgent(fromCallback(() => {})), false, "the unit-test seam's fake is not an Agent");
  assert.equal(isAgent(undefined), false);
  assert.equal(isAgent({ definition: { model: "m" } }), false, "a definition needs BOTH fields");
});

// --- the Open model (ADR-0054) ----------------------------------------------------------------

test("an Open model is still an Agent slot — the walk has to SEE it to refuse it", () => {
  const declaration: AgentDeclaration = { model: open, instructions: "i" };
  const logic = agent(declaration);

  assert.ok(isAgent(logic), "a packaged Machine's unbound Agent is an Agent");
  assert.equal(isOpenAgent(declaration), true);
  assert.equal(isOpenAgent({ model: "m", instructions: "i" }), false);
  // Any other symbol is not the sentinel: `Symbol.for("jr2.open")` is the agreement between an
  // Instance's copy of the module and the CLI's, and nothing else passes for it.
  assert.equal(isAgent({ definition: { model: Symbol("open"), instructions: "i" } }), false);
});

test("requireBoundAgent is the door to the wire — a definition out, or a refusal naming the slot", () => {
  // The wire takes a string model and nothing else: a Symbol would be dropped by JSON.stringify
  // and the Harness would 400 on a slot key alone, which names nothing a composer can fix.
  assert.deepEqual(requireBoundAgent("coder", { model: "anthropic/x", instructions: "i", workspace: "read" }), {
    model: "anthropic/x",
    instructions: "i",
    workspace: "read",
  });
  assert.throws(
    () => requireBoundAgent("coder", { model: open, instructions: "i" }),
    /agent "coder" has an Open model .*customize\(<machine>, \{ agents: \{ coder: \{ model: "<provider>\/<model>" \} \} \}\)/s,
  );
});
