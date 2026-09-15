// `customize(machine, parts)` (ADR-0049, ADR-0051): a composer retunes what an IMPORTED Machine
// carries — its Agents' definitions, the Machines it composes, the images its Workspace is made
// of, and the Repo Slots it attaches — and gets back a new Machine that carries everything else
// unchanged.
//
// The claims that matter, in order: the override LAYERS over the stock definition; the original
// is untouched, so one import can be customized twice, differently (the ADR's `deep`/`quick`);
// only DECLARED parts can be retuned, and naming one that does not exist fails loudly; j2's
// wrappers are transparent, so a consumer never writes `body` or `worker`; and everything a
// Machine carries — its vocabulary, its door, its Sandbox seats, its slots — is still found on
// the result, including on the `image`/`repos` path, which cannot use `provide` and rebuilds
// instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPromise, setup } from "xstate";
import { z } from "zod";
import { defineEvent } from "@j2/agent-protocol";
import { customize } from "../src/customize.ts";
import { fingerprintOf } from "../src/fingerprint.ts";
import { agent } from "../src/harness-client.ts";
import { isAgent } from "../src/agent.ts";
import { open, partsOf, sandboxPartsOf } from "../src/parts.ts";
import { pool, source } from "../src/pool.ts";
import { j2Setup } from "../src/setup.ts";
import { workspace } from "../src/workspace.ts";
import { inputSchemaOf, vocabularyOf } from "../src/vocabulary.ts";

const opus = "anthropic/claude-opus-x";
const haiku = "anthropic/claude-haiku-x";

const coderDef = { model: haiku, instructions: "You are the coder.", workspace: "write" } as const;
const reviewerDef = { model: haiku, instructions: "You are the reviewer.", workspace: "read" } as const;

const done = defineEvent({ name: "done", input: z.object({}) });

/** The Machine a package would export: two Agents and one vocabulary — plus, when asked, its own
 * door (ADR-0033), which only a Machine that is not a `workspace()` body may declare. */
function research(door?: z.ZodObject) {
  return j2Setup({
    events: [done],
    actors: { coder: agent(coderDef), reviewer: agent(reviewerDef) },
  }).createMachine({
    id: "research",
    ...(door ? { input: door } : {}),
    initial: "coding",
    states: {
      coding: { invoke: { src: "coder", input: { prompt: "go" } }, on: { done: "reviewing" } },
      reviewing: { invoke: { src: "reviewer", input: { prompt: "look" } }, on: { done: "finished" } },
      finished: { type: "final" },
    },
  });
}

/** What logic a Machine holds under one slot key — `unknown` in, because these assertions read
 * PARTS off a Machine the way j2 does, not through the invoke types. */
const slotAt = (machine: unknown, slot: string): unknown =>
  (machine as { implementations: { actors: Record<string, unknown> } }).implementations.actors[slot];

/** The definition the named slot would run — read the way everything reads it: off the logic the
 * slot holds (ADR-0049). */
function definitionAt(machine: unknown, slot: string) {
  const logic = slotAt(machine, slot);
  assert.ok(isAgent(logic), `slot "${slot}" is not an Agent`);
  return logic.definition;
}

test("an Agent override layers over the stock definition, and the original is untouched", () => {
  const stock = research();
  const retuned = customize(stock, { agents: { coder: { model: opus } } });

  // Layered, not replaced: the author's instructions and workspace access survive a model swap,
  // which is the whole point of a PARTIAL definition (ADR-0018's identity-vs-Dial line holds —
  // this is a definition-level act by the composer, not a Turn's).
  assert.deepEqual(definitionAt(retuned, "coder"), { ...coderDef, model: opus });
  // Untouched slots keep the very same logic object, so nothing is rebuilt that was not named.
  assert.equal(retuned.implementations.actors.reviewer, stock.implementations.actors.reviewer);
  assert.deepEqual(definitionAt(stock, "coder"), coderDef);
});

test("one import, customized twice, is two Machines — deep and quick (ADR-0049)", () => {
  const stock = research();
  const deep = customize(stock, { agents: { coder: { model: opus } } });
  const quick = customize(stock, { agents: { coder: { model: haiku, thinkingLevel: "low" } } });

  assert.equal(definitionAt(deep, "coder").model, opus);
  assert.deepEqual(definitionAt(quick, "coder"), { ...coderDef, thinkingLevel: "low" });
  // And a walk of both reports two Agents under one slot key — the case a flat roster could not
  // hold, and the reason `j2 up` preflights per definition rather than per name.
  assert.deepEqual(
    partsOf([deep, quick])
      .agents.filter((a) => a.name === "coder")
      .map((a) => a.definition.model),
    [opus, haiku],
  );
});

test("the vocabulary and the door ride through a customize (keyed on the config `provide` keeps)", () => {
  const stock = research(z.object({ topic: z.string() }));
  const retuned = customize(stock, { agents: { coder: { model: opus } } });

  assert.deepEqual([...(vocabularyOf(retuned) ?? new Map()).keys()], ["done"]);
  assert.ok(inputSchemaOf(retuned));
  // Retuning a model changes what an Agent does, never the graph — so a run parked across the
  // change still restores (ADR-0030: shape decides restorability, not behavior).
  assert.equal(fingerprintOf(retuned), fingerprintOf(stock));
});

test("only declared parts can be retuned: an unknown Agent slot fails, naming the Machine's own", () => {
  const stock = research();
  assert.throws(() => customize(stock, { agents: { scribe: { model: opus } } } as never), /research/);
  assert.throws(() => customize(stock, { agents: { scribe: { model: opus } } } as never), /coder, reviewer/);
});

test("a child Machine is retuned one level down — the same call, recursing", () => {
  const child = research();
  const parent = j2Setup({
    events: [done],
    actors: { triager: agent({ model: haiku, instructions: "You triage.", workspace: "none" }), child },
  }).createMachine({
    id: "parent",
    initial: "triaging",
    states: {
      triaging: { invoke: { src: "triager", input: { prompt: "route" } }, on: { done: "deep" } },
      deep: { invoke: { src: "child" } },
    },
  });

  const retuned = customize(parent, {
    agents: { triager: { thinkingLevel: "high" } },
    actors: { child: { agents: { coder: { model: opus } } } },
  });

  assert.equal(definitionAt(retuned, "triager").thinkingLevel, "high");
  assert.equal(definitionAt(slotAt(retuned, "child"), "coder").model, opus);
  // One level's reach, and no further: the imported module's own object is not edited.
  assert.equal(definitionAt(child, "coder").model, haiku);
});

test("a slot that composes no Machine fails, naming the ones that do", () => {
  const machine = j2Setup({
    events: [],
    actors: { coder: agent(coderDef), fetchIt: fromPromise(async () => 1), child: research() },
  }).createMachine({ id: "host", initial: "idle", states: { idle: {} } });

  assert.throws(() => customize(machine, { actors: { fetchIt: {} } } as never), /composes no Machine under "fetchIt"/);
  assert.throws(() => customize(machine, { actors: { fetchIt: {} } } as never), /child/);
});

// --- The wrappers are transparent (ADR-0049) ---------------------------------------------------

const spec = () => ({ branch: "feat-1" });
const APP = "https://example.test/app.git";
const repos = { app: APP };

test("a workspace() is transparent to its body: the composer never writes `body`", () => {
  const wrapped = workspace(research(), { repos, spec });
  const retuned = customize(wrapped, { agents: { coder: { model: opus } } });

  assert.equal(definitionAt(slotAt(retuned, "body"), "coder").model, opus);
  // The wrapper itself is a clone, not the original: the body slot is the only thing substituted.
  assert.notEqual(retuned.implementations.actors.body, wrapped.implementations.actors.body);
  assert.equal(fingerprintOf(retuned), fingerprintOf(wrapped));
});

test("a pool() is transparent to its worker, and a pool of Workspaces to what is inside both", () => {
  const wake = defineEvent({ name: "work_ready", input: z.object({}) });
  const worker = workspace(research(), { repos, spec });
  const poolMachine = pool(worker, {
    source: source<{ id: string }>({
      next: fromPromise(async (): Promise<{ item: { id: string } | null; open: number }> => ({ item: null, open: 0 })),
      wake,
    }),
    itemId: (i) => i.id,
  });

  const retuned = customize(poolMachine, { agents: { reviewer: { model: opus } } });
  assert.deepEqual(
    partsOf([retuned])
      .agents.map((a) => `${a.name}:${String(a.definition.model)}`)
      .sort(),
    [`coder:${haiku}`, `reviewer:${opus}`],
  );
});

test("a slot an AUTHOR spelled `body` is an ordinary child — transparency follows the marker", () => {
  // The counter-case to the two above: `body` and `worker` are names any author may choose, so
  // the reach is the wrapper's own record of being one (`J2Wrapper`/`wrapperBodyOf`, parts.ts) and
  // never the spelling. Stepping through this Machine would retune the CHILD's Agents and refuse
  // the host's own — which is what its author named.
  const host = j2Setup({
    events: [done],
    actors: { coder: agent(coderDef), body: research(), worker: fromPromise(async () => 1) },
  }).createMachine({ id: "host", initial: "idle", states: { idle: { invoke: { src: "body" } } } });

  const retuned = customize(host, {
    agents: { coder: { model: opus } },
    // ...and the child under it is reached the way every other composed Machine is: by name.
    actors: { body: { agents: { reviewer: { model: opus } } } },
  });

  assert.equal(definitionAt(retuned, "coder").model, opus);
  assert.equal(definitionAt(slotAt(retuned, "body"), "reviewer").model, opus);
  assert.equal(definitionAt(slotAt(retuned, "body"), "coder").model, haiku);
});

// --- The Sandbox seats: the one part `provide` cannot carry ------------------------------------

test("image/user retune the workspace() the chain reaches, and the original keeps its own", () => {
  const stock = workspace(research(), { repos, spec, image: "ghcr.io/acme/tools:1", user: "ghcr.io/acme/sshd:1" });
  const retuned = customize(stock, { image: "ghcr.io/acme/tools:2" });

  // Layered like a definition: naming `image` alone leaves the User Container seat — and the
  // slots — as declared.
  assert.deepEqual(sandboxPartsOf(retuned), { image: "ghcr.io/acme/tools:2", user: "ghcr.io/acme/sshd:1", repos });
  assert.deepEqual(sandboxPartsOf(stock), { image: "ghcr.io/acme/tools:1", user: "ghcr.io/acme/sshd:1", repos });
  // The rebuild is what makes that possible — a `provide()` clone shares the config the seats are
  // keyed on, so the two Machines would be one. It must carry everything else across untouched.
  assert.notEqual(retuned.config, stock.config);
  assert.equal(fingerprintOf(retuned), fingerprintOf(stock));
  assert.equal(retuned.implementations.actors.body, stock.implementations.actors.body);
});

test("the door and the transparency survive the rebuild, and both parts can move at once", () => {
  const stock = workspace(research(), { input: z.object({ topic: z.string() }), repos, spec });
  const retuned = customize(stock, { image: "ghcr.io/acme/tools:2", agents: { coder: { model: opus } } });

  assert.ok(inputSchemaOf(retuned), "the wrapper's door rides the rebuilt config");
  assert.deepEqual(sandboxPartsOf(retuned), { image: "ghcr.io/acme/tools:2", repos });
  assert.equal(definitionAt(slotAt(retuned, "body"), "coder").model, opus, "the retuned body rides the rebuild");
  // Still a wrapper: a second customize reaches the body through it, which is what the
  // transparency attachment being copied means.
  const again = customize(retuned, { agents: { reviewer: { model: opus } } });
  assert.equal(definitionAt(slotAt(again, "body"), "reviewer").model, opus);
});

test("image/user/repos on a Machine that composes no Sandbox fails, because there is nothing to name", () => {
  assert.throws(() => customize(research(), { image: "ghcr.io/acme/tools:2" }), /composes none/);
  assert.throws(() => customize(research(), { repos: { app: APP } } as never), /`repos` say what a SANDBOX/);
  assert.throws(() => customize(research(), { repos: { app: APP } } as never), /composes none/);
  // A pool whose worker is a plain Machine is the same case one level down.
  const workerless = pool(research(), {
    source: source<{ id: string }>({
      next: fromPromise(async (): Promise<{ item: { id: string } | null; open: number }> => ({ item: null, open: 0 })),
    }),
    itemId: (i) => i.id,
  });
  assert.throws(() => customize(workerless, { image: "ghcr.io/acme/tools:2" }), /composes none/);
});

test("a plain setup() Machine carries no Agents, and says so", () => {
  const plain = setup({ actors: { helper: fromPromise(async () => 1) } }).createMachine({
    id: "plain",
    initial: "idle",
    states: { idle: {} },
  });
  assert.throws(() => customize(plain, { agents: { coder: { model: opus } } } as never), /its Agents are: none/);
});

// --- The Open model (ADR-0054): bound by the same override that retunes a bound one -------------

/** What a package exports (ADR-0054): the same two Agents, but the model is nobody's answer yet. */
function unbound() {
  return j2Setup({
    events: [done],
    actors: { coder: agent({ ...coderDef, model: open }), reviewer: agent({ ...reviewerDef, model: open }) },
  }).createMachine({
    id: "unbound",
    initial: "coding",
    states: {
      coding: { invoke: { src: "coder", input: { prompt: "go" } }, on: { done: "finished" } },
      finished: { type: "final" },
    },
  });
}

test("an Agent override BINDS an Open model, and the layering is the one it already had", () => {
  const packaged = unbound();
  const bound = customize(packaged, { agents: { coder: { model: opus }, reviewer: { model: haiku } } });

  // The author's instructions and workspace access survive: a composer states the one part the
  // package could not, and nothing else.
  assert.deepEqual(definitionAt(bound, "coder"), { ...coderDef, model: opus });
  assert.deepEqual(definitionAt(bound, "reviewer"), { ...reviewerDef, model: haiku });
  // And the walk of the customized Machine no longer reports them — which is what `j2 up` stops
  // refusing.
  assert.deepEqual(partsOf([bound]).openAgents, []);
  assert.deepEqual(
    partsOf([bound]).agents.map((a) => a.definition.model),
    [opus, haiku],
  );
  // The import is untouched, like every other customize: the package's own object still reads Open.
  assert.deepEqual(partsOf([packaged]).openAgents, [
    { slot: "coder", path: [] },
    { slot: "reviewer", path: [] },
  ]);
});

test("a customize that retunes an Open Agent WITHOUT a model leaves it Open — and the walk says so", () => {
  // The failure this guards is the quiet one: a composer who dialed `thinkingLevel` and thought
  // they had bound the Agent. The override is layered, so the model stays the sentinel, and the
  // converge refuses by name rather than a run faulting at the first Turn.
  const bound = customize(unbound(), { agents: { coder: { thinkingLevel: "high" } } });
  assert.deepEqual(definitionAt(bound, "coder"), { ...coderDef, model: open, thinkingLevel: "high" });
  assert.deepEqual(partsOf([bound]).openAgents, [
    { slot: "coder", path: [] },
    { slot: "reviewer", path: [] },
  ]);
});

// --- The Repo Slots (ADR-0051): bound through the same chain, on the same rebuild ---------------

test("repos bind the workspace() the chain reaches — an open slot, through a pool and its body", () => {
  // The consumer's move for a packaged Machine: it exported `target: open`, and the Instance says
  // which repository — nested through `actors` like every other part, never spelling `body` or
  // `worker`. The original is untouched, so the package's own object still reads as open.
  const packaged = workspace(research(), {
    repos: { target: open, docs: { url: "https://example.test/handbook.git", ref: "v3" } },
    spec,
  });
  const wake = defineEvent({ name: "work_ready", input: z.object({}) });
  const pooled = pool(packaged, {
    source: source<{ id: string }>({
      next: fromPromise(async (): Promise<{ item: { id: string } | null; open: number }> => ({ item: null, open: 0 })),
      wake,
    }),
    itemId: (i) => i.id,
  });

  const bound = customize(pooled, { repos: { target: "git@github.com:ourorg/app.git" } });
  const reached = slotAt(bound, "worker");
  // Layered, like the image seats: the package's own `docs` binding survives untouched.
  assert.deepEqual(sandboxPartsOf(reached as never), {
    repos: { target: "git@github.com:ourorg/app.git", docs: { url: "https://example.test/handbook.git", ref: "v3" } },
  });
  assert.deepEqual(sandboxPartsOf(packaged).repos, {
    target: open,
    docs: { url: "https://example.test/handbook.git", ref: "v3" },
  });
  // And the walk of the customized Machine reports the bound url — which is what `j2 up` warms
  // and what it no longer refuses.
  const walked = partsOf([bound]);
  assert.deepEqual(walked.openSlots, []);
  assert.deepEqual(
    walked.repos.map((r) => r.identity),
    ["github.com/ourorg/app", "example.test/handbook"],
  );
  assert.deepEqual(partsOf([pooled]).openSlots, [{ slot: "target", path: [] }], "the import is untouched");
  // The rebuild is what makes that possible — the same one `image` takes — so everything else the
  // wrapper carried rides across: the shape, the transparency, the Agents.
  assert.equal(fingerprintOf(reached as never), fingerprintOf(packaged));
  assert.equal(definitionAt(slotAt(reached, "body"), "coder").model, haiku);
});

test("a per-run slot may be rebound statically — it becomes bound; and a bound one may become per-run", () => {
  // Which slots a consumer may fix is the package author's call, expressed by the slot's state
  // (ADR-0051): a per-run slot is one the Machine leaves to the run, and a consumer who knows the
  // answer may write it down. Any of the three forms is accepted, so the other direction holds too.
  const perRun = workspace(research(), {
    input: z.object({ repo: z.string() }),
    repos: { target: ({ input }) => input.repo },
    spec,
  });
  const fixed = customize(perRun, { repos: { target: APP } });
  assert.deepEqual(sandboxPartsOf(fixed).repos, { target: APP });
  assert.deepEqual(
    partsOf([fixed]).repos.map((r) => r.url),
    [APP],
  );

  const dynamic = customize(workspace(research(), { repos, spec }), {
    repos: { app: ({ input }) => (input as { repo: string }).repo },
  });
  assert.equal(typeof sandboxPartsOf(dynamic).repos.app, "function");
  assert.deepEqual(partsOf([dynamic]).repos, [], "a per-run slot contributes nothing to the walk");
});

test("only DECLARED slots can be bound: an undeclared key fails, naming the Machine's own", () => {
  const stock = workspace(research(), { repos: { target: open, docs: APP }, spec });
  assert.throws(
    () => customize(stock, { repos: { taregt: APP } } as never),
    /machine "workspace" declares no Repo Slot "taregt" — its slots are: target, docs \(ADR-0051\)/,
  );
  // A prototype key is not a declared slot either: the check reads the declaration's own keys,
  // so the runtime refuses exactly what the compiler refuses.
  assert.throws(
    () => customize(stock, { repos: { constructor: APP } } as never),
    /machine "workspace" declares no Repo Slot "constructor" — its slots are: target, docs \(ADR-0051\)/,
  );
  // And a binding that names no Repo is refused where the composer wrote it, by slot.
  assert.throws(
    () => customize(stock, { repos: { target: "" } }),
    /customize\(\): Repo Slot "target" is bound to an empty url/,
  );
  assert.throws(
    () => customize(stock, { repos: { target: "./local" } }),
    /"target" binds "\.\/local", which names no Repo/,
  );
});
