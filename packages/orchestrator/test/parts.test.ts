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
import { customizeLine, open, partsOf } from "../src/parts.ts";
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

const NOTHING = { agents: [], images: [], repos: [], openSlots: [], openAgents: [], composesSandbox: false };

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
  // The shape a real jr-shaped workflow has, and the one a converge must
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
    // converge's refusal, located by the `customize()` route from the root — through the pool's
    // transparent `worker`, then the worker's own `feature` slot; and the pool's worker's
    // workspace is a Sandbox two wrappers down.
    repos: [{ url: "git@github.com:acme/app.git", identity: "github.com/acme/app", key: APP_KEY }],
    openSlots: [{ slot: "docs", path: ["feature"] }],
    openAgents: [],
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

test("open slots are reported with their `customize()` route from the root — what `j2 up` refuses by name", () => {
  // The Machine is named by where it sits, never by the wrapper's xstate id (every `workspace()`
  // shares one): the path is the `actors` nesting a `customize()` of the registered root writes
  // to reach the wrapper, so the refusal's fix line pastes.
  const packaged = wsRepos({ target: open, docs: open });
  assert.deepEqual(partsOf([packaged]).openSlots, [
    { slot: "target", path: [] },
    { slot: "docs", path: [] },
  ]);
  assert.deepEqual(partsOf([packaged]).repos, []);

  // Composed under a child slot, then under a pool: the path is the author-written slots alone —
  // `customize()` is transparent to `worker` and `body`, so the route is too.
  const host = j2Setup({ events: [], actors: { review: packaged } }).createMachine({
    id: "host",
    initial: "reviewing",
    states: { reviewing: { invoke: { src: "review" } } },
  });
  assert.deepEqual(partsOf([host]).openSlots, [
    { slot: "target", path: ["review"] },
    { slot: "docs", path: ["review"] },
  ]);
  const workReady = defineEvent({ name: "work_ready", input: z.object({}) });
  const pooled = pool(host, {
    source: source<{ id: string }>({
      next: fromPromise(async (): Promise<{ item: { id: string } | null; open: number }> => ({ item: null, open: 0 })),
      wake: workReady,
    }),
    itemId: (i) => i.id,
  });
  assert.deepEqual(
    partsOf([pooled]).openSlots.map((o) => o.path),
    [["review"], ["review"]],
  );

  // Invoked INLINE, the wrapper sits under an actor with no slot key — nothing a `customize()`
  // can name — so the path is undefined and the refusal says so instead of printing a line.
  const inline = j2Setup({ events: [] }).createMachine({
    id: "inline",
    initial: "reviewing",
    states: { reviewing: { invoke: { src: packaged } } },
  });
  assert.deepEqual(partsOf([inline]).openSlots, [
    { slot: "target", path: undefined },
    { slot: "docs", path: undefined },
  ]);
});

test("customizeLine renders the fix as the nesting `customize()` accepts", () => {
  assert.equal(customizeLine("codeReview", [], "target"), `customize(codeReview, { repos: { target: "<url>" } })`);
  assert.equal(
    customizeLine("top", ["review", "feature"], "docs"),
    `customize(top, { actors: { review: { actors: { feature: { repos: { docs: "<url>" } } } } } })`,
  );
  // An Agent binds through `agents`, and the placeholder is ADR-0018's two-part spelling: the
  // provider prefix is what picks the endpoint, so `<model>` alone would be a line that pastes and
  // then fails at the next converge.
  assert.equal(
    customizeLine("task", [], "coder", "agent"),
    `customize(task, { agents: { coder: { model: "<provider>/<model>" } } })`,
  );
  assert.equal(
    customizeLine("top", ["review"], "coder", "agent"),
    `customize(top, { actors: { review: { agents: { coder: { model: "<provider>/<model>" } } } } })`,
  );
});

// --- the Open model (ADR-0054) ----------------------------------------------------------------

/** A leaf Machine whose one Agent is Open — what a package exports, since it cannot pay for a
 * model (ADR-0054). */
function unbound(id: string, slot: string) {
  return j2Setup({ events: [], actors: { [slot]: agent({ model: open, instructions: "i" }) } }).createMachine({
    id,
    initial: "working",
    states: { working: { invoke: { id: slot, src: slot, input: { prompt: "go" } } } },
  });
}

test("an Open Agent is reported beside the open Repo Slots, and names no model to preflight", () => {
  const packaged = unbound("packaged", "coder");
  const parts = partsOf([packaged]);

  assert.deepEqual(parts.openAgents, [{ slot: "coder", path: [] }]);
  // Still CARRIED: the converge reads `workspace` off it to decide the Instance Harness, and the
  // refusal has to name a slot it walked. What it does not contribute is a model — the preflight
  // probes strings, and this Agent has none yet.
  assert.deepEqual(parts.agents, [{ name: "coder", definition: { model: open, instructions: "i" } }]);
  assert.deepEqual(
    parts.agents.map((a) => a.definition.model).filter((m) => typeof m === "string"),
    [],
  );
});

test("an Open Agent is located by the same `customize()` route a Repo Slot is — through wrappers and all", () => {
  const packaged = workspace(unbound("body", "coder"), { repos: { target: open }, spec: () => ({ branch: "b" }) });
  const host = j2Setup({ events: [], actors: { review: packaged } }).createMachine({
    id: "host",
    initial: "reviewing",
    states: { reviewing: { invoke: { src: "review" } } },
  });
  const parts = partsOf([host]);
  // The wrapper's `body` is transparent to `customize()`, so it is absent from both routes — the
  // two Open parts of one packaged Machine are bound by one nesting, in one edit.
  assert.deepEqual(parts.openSlots, [{ slot: "target", path: ["review"] }]);
  assert.deepEqual(parts.openAgents, [{ slot: "coder", path: ["review"] }]);

  // Invoked INLINE, the Machine sits under an actor with no slot key: nothing a `customize()` can
  // name, so the path is undefined and the refusal says so instead of printing a line.
  const inline = j2Setup({ events: [] }).createMachine({
    id: "inline",
    initial: "reviewing",
    states: { reviewing: { invoke: { src: packaged } } },
  });
  assert.deepEqual(partsOf([inline]).openAgents, [{ slot: "coder", path: undefined }]);
});

test("an Open Agent and a bound one under the same slot key do not collapse", () => {
  // The dedupe key is the definition serialized whole, and `JSON.stringify` drops a symbol-valued
  // key — so without the canonicalizer's symbol case these two would be one entry, and the walk
  // would report an Open Agent or a model, never both.
  const bound = carrier("bound", "coder", "vllm/qwen");
  const both = j2Setup({ events: [], actors: { bound, unbound: unbound("unbound", "coder") } }).createMachine({
    id: "both",
    initial: "idle",
    states: { idle: {} },
  });
  assert.deepEqual(partsOf([both]).agents, [
    { name: "coder", definition: def("vllm/qwen") },
    { name: "coder", definition: { model: open, instructions: "i" } },
  ]);
  assert.deepEqual(partsOf([both]).openAgents, [{ slot: "coder", path: ["unbound"] }]);
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

test("the stamps are read by a SECOND copy of this module — the installed CLI's walk over an Instance's own kit (ADR-0043)", async () => {
  // An installed `j2` resolves `@j2/orchestrator` from its own global prefix and the Instance
  // resolves it from its own node_modules: `workspace()` runs in one copy, `partsOf` in the other.
  // A query string makes Node load a second instance of this module, with its own module scope —
  // a WeakMap here would be empty there, and the walk would report no Sandbox at all.
  const copy = new URL("../src/parts.ts?installed-copy", import.meta.url).href;
  const other = (await import(copy)) as typeof import("../src/parts.ts");
  assert.notEqual(other.partsOf, partsOf, "the import must be a distinct module instance");
  const machine = wsRepos({ app: "https://example.test/app.git" });
  assert.equal(other.composesSandbox(machine), true, "the data-plane switch");
  assert.deepEqual(Object.keys(other.sandboxPartsOf(machine).repos), ["app"]);
  assert.equal(other.wrapperBodyOf(machine), "body");
  assert.deepEqual(
    other.partsOf([machine]).repos.map((r) => r.identity),
    ["example.test/app"],
    "the bound Repo the boot creates a CR for",
  );
});
