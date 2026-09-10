// The parts walk (ADR-0049): what `j2 up` learns about a workflow by walking the Machine it
// registered — the replacement for the Instance roster it used to read from an `agents/` folder
// and the `images/<name>` scan it used to read from an `images/` one. The walk must reach every way
// a Machine composes (a named slot, an imported child Machine, a `workspace()` body, a `pool()`
// worker), must NOT collapse two Machines' same-named Agents (exactly what a flat roster could not
// hold), and must report every `file:` docker context a `workspace()` carries — and only those,
// since a registry ref is deployed-never-built.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPromise, setup } from "xstate";
import { partsOf } from "../src/parts.ts";
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

  assert.deepEqual(partsOf([machine]).agents, [{ name: "coder", definition: def("anthropic/claude-x") }]);
});

test("the walk descends into composed Machines — a named child slot (ADR-0049)", () => {
  const child = carrier("child", "reviewer", "vllm/qwen");
  const parent = j2Setup({ events: [], actors: { triager: agent(def("anthropic/claude-x")), child } }).createMachine({
    id: "parent",
    initial: "triaging",
    states: { triaging: { invoke: { src: "child" } } },
  });

  assert.deepEqual(partsOf([parent]).agents, [
    { name: "triager", definition: def("anthropic/claude-x") },
    { name: "reviewer", definition: def("vllm/qwen") },
  ]);
});

test("the walk reaches a workspace() body and a pool() worker — the kit's own wrappers", () => {
  // Both name their child as a SLOT since ADR-0049 — `body` and `worker` — so both are reached the
  // same way an imported child Machine is. Either failing would preflight nothing at all for a
  // jr-shaped workflow.
  const wrapped = workspace(carrier("body", "coder", "vllm/qwen"), {
    spec: () => ({ repos: [{ name: "app", baseRef: "main" }], branch: "feat-1" }),
  });
  assert.deepEqual(partsOf([wrapped]).agents, [{ name: "coder", definition: def("vllm/qwen") }]);

  const workReady = defineEvent({ name: "work_ready", input: z.object({}) });
  const worker = carrier("worker", "scribe", "anthropic/claude-x");
  const poolMachine = pool(worker, {
    source: source<{ id: string }>({
      next: fromPromise(async (): Promise<{ item: { id: string } | null; open: number }> => ({ item: null, open: 0 })),
      wake: workReady,
    }),
    itemId: (i) => i.id,
  });
  assert.deepEqual(partsOf([poolMachine]).agents, [{ name: "scribe", definition: def("anthropic/claude-x") }]);
});

test("two Machines may each carry a `coder` — both are reported (what a roster could not hold)", () => {
  const deep = carrier("deep", "coder", "anthropic/claude-opus");
  const quick = carrier("quick", "coder", "anthropic/claude-haiku");
  const parent = j2Setup({ events: [], actors: { deep, quick } }).createMachine({
    id: "parent",
    initial: "idle",
    states: { idle: {} },
  });

  assert.deepEqual(partsOf([parent]).agents, [
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
  assert.deepEqual(partsOf([one, two, one]).agents, [{ name: "coder", definition: shared }]);
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

  assert.deepEqual(partsOf([recursive]).agents, [{ name: "coder", definition: def("vllm/qwen") }]);
});

test("no Agents anywhere is an empty answer — a workflow may invoke none", () => {
  const plain = setup({}).createMachine({ id: "plain", initial: "idle", states: { idle: {} } });
  assert.deepEqual(partsOf([plain]), { agents: [], images: [] });
  assert.deepEqual(partsOf([]), { agents: [], images: [] });
});

// --- the images half (ADR-0037/0049) ----------------------------------------------------------

const ws = (image?: string, user?: string) =>
  workspace(carrier("body", "coder", "vllm/qwen"), {
    ...(image !== undefined ? { image } : {}),
    ...(user !== undefined ? { user } : {}),
    spec: () => ({ repos: [{ name: "app" }], branch: "feat-1" }),
  });

test("a `file:` image is a context to build; a registry ref is not, and neither is silence", () => {
  // The whole reason the image is an OPTION and not a spec field: `j2 up` must find it statically.
  // A ref is deployed-never-built (ADR-0037/0039 — what j2 did not stamp, j2 does not touch), and
  // an absent one is the `images/default` fallback, which is a path convention `j2 up` checks
  // itself rather than something a Machine carries.
  assert.deepEqual(partsOf([ws("file:///srv/pkg/image")]).images, [
    { url: "file:///srv/pkg/image", dir: "/srv/pkg/image", name: "image" },
  ]);
  assert.deepEqual(partsOf([ws("ghcr.io/acme/tools:1")]).images, []);
  assert.deepEqual(partsOf([ws()]).images, []);
});

test("the User Container's image rides the same rule — ADR-0005 gives it the same two origins", () => {
  assert.deepEqual(partsOf([ws("file:///srv/pkg/tools", "file:///srv/pkg/sshd")]).images, [
    { url: "file:///srv/pkg/tools", dir: "/srv/pkg/tools", name: "tools" },
    { url: "file:///srv/pkg/sshd", dir: "/srv/pkg/sshd", name: "sshd" },
  ]);
  assert.deepEqual(partsOf([ws(undefined, "ghcr.io/acme/sshd:1")]).images, []);
});

test("one context named by two Workspaces is built once, and survives a provide() clone", () => {
  // Deduped by URL, because the converge's question is "which contexts must I build". And the
  // attachment is keyed on `machine.config`, which `.provide()` passes through unchanged — the
  // ADR-0049 rule that lets a customized or test-seamed Machine keep the parts it was built with.
  const one = ws("file:///srv/pkg/image");
  const two = ws("file:///srv/pkg/image");
  assert.deepEqual(partsOf([one, two.provide({})]).images, [
    { url: "file:///srv/pkg/image", dir: "/srv/pkg/image", name: "image" },
  ]);
});

test("the image is found through composition, not just at the root", () => {
  // A packaged Machine ships its own context; the Instance registers something that INVOKES it.
  const inner = ws("file:///srv/pkg/image");
  const outer = j2Setup({ events: [], actors: { research: inner } }).createMachine({
    id: "outer",
    initial: "researching",
    states: { researching: { invoke: { src: "research" } } },
  });
  assert.deepEqual(partsOf([outer]).images, [{ url: "file:///srv/pkg/image", dir: "/srv/pkg/image", name: "image" }]);
});

test("workspace() refuses an empty image at build time, not at the first provision", () => {
  // Static, so checkable now: the same derives-from-a-typo bug `assertSpec` catches for the spec.
  assert.throws(
    () => ws(""),
    (err: Error) => {
      assert.match(err.message, /`image` must be a non-empty string/);
      assert.match(err.message, /import\.meta\.resolve/, "names both origins");
      return true;
    },
  );
  assert.throws(() => ws(undefined, ""), /`user` must be a non-empty string/);
});
