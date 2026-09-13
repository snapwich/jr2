// The parts walk (ADR-0049, ADR-0051): what `j2 up` and the boot learn about a workflow by walking
// the Machine it registered. The walk must reach every way a Machine composes (a named slot, an
// imported child Machine, a `workspace()` body, a `pool()` worker), must NOT collapse two Machines'
// same-named Agents (exactly what a flat roster could not hold), must report every `file:` docker
// context a `workspace()` carries — and only those, since a registry ref is deployed-never-built —
// and must report every BOUND Repo (deduped by identity), every OPEN slot, and whether any Machine
// composes a Sandbox at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPromise, setup } from "xstate";
import { open, partsOf } from "../src/parts.ts";
import { agent } from "../src/harness-client.ts";
import { j2Setup } from "../src/setup.ts";
import { pool, source } from "../src/pool.ts";
import { workspace } from "../src/workspace.ts";
import { defineEvent } from "@j2/agent-protocol";
import { z } from "zod";
import { repoKey } from "../src/repo-identity.ts";
import type { RepoSlot } from "../src/parts.ts";

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
    repos: { app: "https://example.test/app.git" },
    spec: () => ({ branch: "feat-1" }),
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

const NOTHING = { agents: [], images: [], repos: [], openSlots: [], composesSandbox: false };

test("no Agents anywhere is an empty answer — a workflow may invoke none, and compose no Sandbox", () => {
  const plain = setup({}).createMachine({ id: "plain", initial: "idle", states: { idle: {} } });
  assert.deepEqual(partsOf([plain]), NOTHING);
  assert.deepEqual(partsOf([]), NOTHING);
});

// --- the images half (ADR-0037/0049) ----------------------------------------------------------

const ws = (image?: string, user?: string) =>
  workspace(carrier("body", "coder", "vllm/qwen"), {
    ...(image !== undefined ? { image } : {}),
    ...(user !== undefined ? { user } : {}),
    repos: { app: "https://example.test/app.git" },
    spec: () => ({ branch: "feat-1" }),
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

// --- the jr shape, whole (ADR-0049) -------------------------------------------------------------

test("a workspace() inside a j2Setup() inside a pool() — every part, at every depth", () => {
  // The shape a real workflow actually has (examples/coding's `jr`), and the one a converge must
  // read in a single pass: the Pool schedules a worker Machine, the worker composes a Workspace,
  // and the Agents sit one level below that. Two wrapper kinds, an author Machine between them,
  // and both image seats — nothing here is reachable from the root's own `implementations.actors`.
  const body = j2Setup({
    events: [],
    actors: { coder: agent(def("vllm/qwen")), reviewer: agent(def("anthropic/claude-x", "read")) },
  }).createMachine({
    id: "body",
    initial: "coding",
    states: { coding: { invoke: { src: "coder", input: { prompt: "go" } } } },
  });

  const feature = workspace(body, {
    image: "file:///srv/pkg/tools",
    user: "file:///srv/pkg/sshd",
    repos: { app: "git@github.com:acme/app.git", docs: open },
    spec: () => ({ branch: "feat-1" }),
  });

  const worker = j2Setup({
    events: [],
    actors: { triager: agent(def("anthropic/claude-haiku", "none")), feature },
  }).createMachine({ id: "worker", initial: "triaging", states: { triaging: { invoke: { src: "feature" } } } });

  const workReady = defineEvent({ name: "work_ready", input: z.object({}) });
  const top = pool(worker, {
    source: source<{ id: string }>({
      next: fromPromise(async (): Promise<{ item: { id: string } | null; open: number }> => ({ item: null, open: 0 })),
      wake: workReady,
    }),
    itemId: (i) => i.id,
  });

  assert.deepEqual(partsOf([top]), {
    // In walk order, and every one of them is a model `j2 up` preflights (ADR-0018) — the
    // `workspace: "none"` triager is also what converges the Instance Harness (ADR-0031).
    agents: [
      { name: "triager", definition: def("anthropic/claude-haiku", "none") },
      { name: "coder", definition: def("vllm/qwen") },
      { name: "reviewer", definition: def("anthropic/claude-x", "read") },
    ],
    images: [
      { url: "file:///srv/pkg/tools", dir: "/srv/pkg/tools", name: "tools" },
      { url: "file:///srv/pkg/sshd", dir: "/srv/pkg/sshd", name: "sshd" },
    ],
    // The bound Repo is known before any run asks (the boot warms it); the open slot is the
    // converge's refusal; and the pool's worker's workspace is a Sandbox two wrappers down.
    repos: [{ url: "git@github.com:acme/app.git", identity: "github.com/acme/app", key: APP_KEY }],
    openSlots: [{ machine: "workspace", slot: "docs" }],
    composesSandbox: true,
  });
});

// --- the repos half (ADR-0051) ----------------------------------------------------------------

/** The cache key `github.com/acme/app` normalizes to (repo-identity.ts) — one for every spelling. */
const APP_KEY = repoKey("https://github.com/acme/app");

const wsRepos = (repos: Record<string, RepoSlot>) =>
  workspace(carrier("body", "coder", "vllm/qwen"), { repos, spec: () => ({ branch: "feat-1" }) });

test("bound urls are collected with their identity and key, deduped by IDENTITY across spellings", () => {
  // Two Machines — or two slots — spelling one repository two ways are one Repo and one cache
  // (ADR-0051): the first spelling in walk order is what the CR is created with, the ref rides
  // with it, and the identity is what every later attach finds it by.
  const ssh = wsRepos({ app: { url: "git@github.com:Acme/App.git", ref: "main" } });
  const https = wsRepos({ mirror: "https://GitHub.com/Acme/App/", other: "https://example.test/x.git" });
  assert.deepEqual(partsOf([ssh, https]).repos, [
    {
      url: "git@github.com:Acme/App.git",
      ref: "main",
      identity: "github.com/Acme/App",
      key: repoKey("https://github.com/Acme/App"),
    },
    { url: "https://example.test/x.git", identity: "example.test/x", key: repoKey("https://example.test/x.git") },
  ]);
  assert.equal(partsOf([ssh, https]).repos[0]!.key, repoKey("https://GitHub.com/Acme/App/"), "one key, both spellings");
});

test("a per-run slot contributes nothing — which Repo it binds is the run's business", () => {
  const perRun = wsRepos({
    target: ({ input }) => (input as { repo: string }).repo,
    docs: "https://example.test/d.git",
  });
  const parts = partsOf([perRun]);
  assert.deepEqual(
    parts.repos.map((r) => r.identity),
    ["example.test/d"],
  );
  assert.deepEqual(parts.openSlots, []);
  assert.equal(parts.composesSandbox, true);
});

test("open slots are reported with the Machine's id — what `j2 up` refuses by name", () => {
  const packaged = wsRepos({ target: open, docs: open });
  assert.deepEqual(partsOf([packaged]).openSlots, [
    { machine: "workspace", slot: "target" },
    { machine: "workspace", slot: "docs" },
  ]);
  assert.deepEqual(partsOf([packaged]).repos, []);
});

test("composesSandbox is true through a pool and a child, false for a plain Machine — the data-plane switch", () => {
  const inner = wsRepos({ app: "https://example.test/app.git" });
  const outer = j2Setup({ events: [], actors: { research: inner } }).createMachine({
    id: "outer",
    initial: "researching",
    states: { researching: { invoke: { src: "research" } } },
  });
  assert.equal(partsOf([outer]).composesSandbox, true, "through a child slot");
  const workReady = defineEvent({ name: "work_ready", input: z.object({}) });
  const pooled = pool(inner, {
    source: source<{ id: string }>({
      next: fromPromise(async (): Promise<{ item: { id: string } | null; open: number }> => ({ item: null, open: 0 })),
      wake: workReady,
    }),
    itemId: (i) => i.id,
  });
  assert.equal(partsOf([pooled]).composesSandbox, true, "through a pool worker");
  assert.equal(
    partsOf([carrier("plain", "coder", "vllm/qwen")]).composesSandbox,
    false,
    "an Agent alone is no Sandbox",
  );
});
