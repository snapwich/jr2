// The Agent as a slot (ADR-0049): `agent(definition)` brands its logic with the definition, and
// `isAgent` is how everything else — the menu walk above all — recognizes one. There is nothing
// else in this module: the instance roster it also held (`agents/` discovery, read by `j2 up` into
// a ConfigMap) retired when the definition began riding the Turn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromCallback } from "xstate";
import { isAgent, type AgentDefinition } from "../src/agent.ts";
import { agent } from "../src/harness-client.ts";

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
