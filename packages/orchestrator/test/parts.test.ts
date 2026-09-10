// The parts walk (ADR-0049): what `j2 up` learns about a workflow's Agents by walking the Machine
// it registered — the replacement for the Instance roster it used to read from a folder. The walk
// must reach every way a Machine composes (a named slot, an imported child Machine, a
// `workspace()` body, a `pool()` worker) and must NOT collapse two Machines' same-named Agents,
// which is exactly what a flat roster could not hold.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPromise, setup } from "xstate";
import { agentsOf } from "../src/parts.ts";
import { agent } from "../src/harness-client.ts";
import { j2Setup } from "../src/setup.ts";
import { pool, source } from "../src/pool.ts";
import { workspace } from "../src/workspace.ts";
import { defineEvent } from "@j2/agent-protocol";
import { z } from "zod";

const def = (model: string, workspaceAccess?: "write" | "read" | "none") => ({
  model,
  instructions: "i",
  ...(workspaceAccess ? { workspace: workspaceAccess } : {}),
});

/** A leaf Machine carrying one Agent under `slot`. */
function carrier(id: string, slot: string, model: string, workspaceAccess?: "write" | "read" | "none") {
  return j2Setup({ events: [], actors: { [slot]: agent(def(model, workspaceAccess)) } }).createMachine({
    id,
    initial: "working",
    states: { working: { invoke: { id: slot, src: slot, input: { prompt: "go" } } } },
  });
}

test("a Machine's own slots are found by the brand, and nothing else is", () => {
  const machine = j2Setup({
    events: [],
    actors: {
      coder: agent(def("anthropic/claude-x")),
      // Not an Agent: a plain actor is a part of the Machine, but not one this walk reports.
      fetchIt: fromPromise(async () => 1),
    },
  }).createMachine({ id: "w", initial: "idle", states: { idle: {} } });

  assert.deepEqual(agentsOf([machine]), [{ name: "coder", definition: def("anthropic/claude-x") }]);
});

test("the walk descends into composed Machines — a named child slot (ADR-0049)", () => {
  const child = carrier("child", "reviewer", "vllm/qwen");
  const parent = j2Setup({ events: [], actors: { triager: agent(def("anthropic/claude-x")), child } }).createMachine({
    id: "parent",
    initial: "triaging",
    states: { triaging: { invoke: { src: "child" } } },
  });

  assert.deepEqual(agentsOf([parent]), [
    { name: "triager", definition: def("anthropic/claude-x") },
    { name: "reviewer", definition: def("vllm/qwen") },
  ]);
});

test("the walk reaches a workspace() body and a pool() worker — the kit's own wrappers", () => {
  // `workspace()` invokes its body as an INLINE machine object, so it is reachable only through
  // the raw invoke config; `pool()` names its worker as a slot. Both must yield their Agents, or
  // a jr-shaped workflow would preflight nothing at all.
  const wrapped = workspace(carrier("body", "coder", "vllm/qwen"), {
    spec: () => ({ repos: [{ name: "app", baseRef: "main" }], branch: "feat-1" }),
  });
  assert.deepEqual(agentsOf([wrapped]), [{ name: "coder", definition: def("vllm/qwen") }]);

  const workReady = defineEvent({ name: "work_ready", input: z.object({}) });
  const worker = carrier("worker", "scribe", "anthropic/claude-x");
  const poolMachine = pool(worker, {
    source: source<{ id: string }>({
      next: fromPromise(async (): Promise<{ item: { id: string } | null; open: number }> => ({ item: null, open: 0 })),
      wake: workReady,
    }),
    itemId: (i) => i.id,
  });
  assert.deepEqual(agentsOf([poolMachine]), [{ name: "scribe", definition: def("anthropic/claude-x") }]);
});

test("two Machines may each carry a `coder` — both are reported (what a roster could not hold)", () => {
  const deep = carrier("deep", "coder", "anthropic/claude-opus");
  const quick = carrier("quick", "coder", "anthropic/claude-haiku");
  const parent = j2Setup({ events: [], actors: { deep, quick } }).createMachine({
    id: "parent",
    initial: "idle",
    states: { idle: {} },
  });

  assert.deepEqual(agentsOf([parent]), [
    { name: "coder", definition: def("anthropic/claude-opus") },
    { name: "coder", definition: def("anthropic/claude-haiku") },
  ]);
});

test("identical definitions collapse — one definition carried by three Machines is preflighted once", () => {
  const shared = def("vllm/qwen");
  const one = j2Setup({ events: [], actors: { coder: agent(shared) } }).createMachine({
    id: "one",
    initial: "idle",
    states: { idle: {} },
  });
  const two = j2Setup({ events: [], actors: { coder: agent({ ...shared }) } }).createMachine({
    id: "two",
    initial: "idle",
    states: { idle: {} },
  });
  // Distinct logics over an equal definition, and one Machine reached twice (as a slot of both
  // roots) — the walk answers once either way.
  assert.deepEqual(agentsOf([one, two, one]), [{ name: "coder", definition: shared }]);
});

test("the walk terminates on a Machine that composes itself", () => {
  // Legal (a recursive worker); walking it twice is not. The cycle guard is what makes the
  // converge's walk safe on any registered Machine, not just the shapes j2 ships.
  const recursive = j2Setup({ events: [], actors: { coder: agent(def("vllm/qwen")) } }).createMachine({
    id: "recursive",
    initial: "idle",
    states: { idle: {} },
  });
  (recursive.implementations.actors as Record<string, unknown>).self = recursive;

  assert.deepEqual(agentsOf([recursive]), [{ name: "coder", definition: def("vllm/qwen") }]);
});

test("no Agents anywhere is an empty answer — a workflow may invoke none", () => {
  const plain = setup({}).createMachine({ id: "plain", initial: "idle", states: { idle: {} } });
  assert.deepEqual(agentsOf([plain]), []);
  assert.deepEqual(agentsOf([]), []);
});
