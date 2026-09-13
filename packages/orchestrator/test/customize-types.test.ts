// `customize()`'s TYPE-level claims (ADR-0049, ADR-0050), asserted by the compiler. `pnpm
// typecheck` is what runs this file: every `@ts-expect-error` below fails the build if the error
// it names stops happening, and every unannotated call fails if the inference it relies on breaks.
//
// The rule these claims serve: a thing code refers to by name should be typed where it is named
// (ADR-0050). An Agent slot is xstate's own `src`, so a `customize()` of an Agent a Machine does
// not carry must stop at `tsc`, not at the first invoke of a run — which is what `j2 up`'s
// typecheck gate makes a converge-time failure.
//
// The claims:
//   1. an Agent key the Machine does not carry is an error, and a Machine carrying none takes no
//      `agents` at all;
//   2. a child key it does not compose is an error;
//   3. j2's wrappers are transparent — a body's Agents are reachable through the wrapper, without
//      `body`, and the wrapper's own mechanism slots are not offered; and the transparency follows
//      the wrapper's MARKER, so a slot an author spelled `body` is an ordinary child;
//   4. an override is a PARTIAL definition: `{ model }` alone is enough, an unknown field is not;
//   5. the result is the same Machine type, so a customized Machine goes wherever the original
//      did — invoked as a child, with its door still checked;
//   6. `repos` offers exactly the Repo Slots the reached `workspace()` declared (ADR-0051), in
//      any of the three forms, through a wrapper chain — and nothing on a Machine that composes
//      no Sandbox.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPromise, setup, type InputFrom } from "xstate";
import { z } from "zod";
import { defineEvent } from "@j2/agent-protocol";
import { isAgent } from "../src/agent.ts";
import { customize } from "../src/customize.ts";
import { open } from "../src/parts.ts";
import { agent } from "../src/harness-client.ts";
import { pool, source } from "../src/pool.ts";
import { j2Setup } from "../src/setup.ts";
import { workspace, type Workspaced } from "../src/workspace.ts";

const opus = "anthropic/claude-opus-x";
const haiku = "anthropic/claude-haiku-x";
const done = defineEvent({ name: "done", input: z.object({}) });

/** The Machine a package exports: two Agent slots, one composed child, one plain actor. */
const child = j2Setup({ events: [done], actors: { scribe: agent({ model: haiku, instructions: "s" }) } }).createMachine(
  { id: "child", initial: "idle", states: { idle: {} } },
);

const research = j2Setup({
  events: [done],
  actors: {
    coder: agent({ model: haiku, instructions: "c" }),
    reviewer: agent({ model: haiku, instructions: "r" }),
    fetchIt: fromPromise(async () => 1),
    child,
  },
}).createMachine({ id: "research", initial: "idle", states: { idle: {} } });

// The REFUSALS live inside functions that are declared and never called. Every line in them is a
// compile-time assertion, and running one would only re-assert its runtime twin (the loud throw
// customize.test.ts already pins) into this file's own `node --test` pass.

// --- 1: only the Agents the Machine carries ----------------------------------------------------

void customize(research, { agents: { coder: { model: opus }, reviewer: { thinkingLevel: "low" } } });

const agentless = setup({ actors: { helper: fromPromise(async () => 1) } }).createMachine({
  id: "agentless",
  initial: "idle",
  states: { idle: {} },
});

function refusedAgents(): void {
  // @ts-expect-error "scribe" is the CHILD's Agent, not this Machine's — one level's reach, and
  // the composer says which level by writing `actors: { child: { agents: { scribe } } }`.
  void customize(research, { agents: { scribe: { model: opus } } });
  // @ts-expect-error `fetchIt` is a slot, but not an Agent slot: an override would have nothing to
  // layer over.
  void customize(research, { agents: { fetchIt: { model: opus } } });
  // @ts-expect-error a Machine carrying no Agent takes no `agents` — `never`, not an empty object
  // type, which would accept any key and check nothing exactly where there is nothing to name.
  void customize(agentless, { agents: { coder: { model: opus } } });
}

// --- 2: only the Machines it composes ----------------------------------------------------------

void customize(research, { actors: { child: { agents: { scribe: { model: opus } } } } });

function refusedChildren(): void {
  // @ts-expect-error `fetchIt` composes no Machine, so there is no second level to reach
  void customize(research, { actors: { fetchIt: {} } });
  // @ts-expect-error and the child's own slots are checked at the child's level, not guessed
  void customize(research, { actors: { child: { agents: { coder: { model: opus } } } } });
}

// --- 3: j2's wrappers are transparent ----------------------------------------------------------

const door = z.object({ topic: z.string() });
const body = j2Setup({
  events: [done],
  types: {} as { context: {}; input: Workspaced<z.infer<typeof door>> },
  actors: { coder: agent({ model: haiku, instructions: "c" }) },
}).createMachine({ id: "body", context: {}, initial: "idle", states: { idle: {} } });

const wrapped = workspace(body, {
  input: door,
  repos: { target: open, docs: "https://example.test/handbook.git" },
  spec: () => ({ branch: "feat" }),
});

// The body's Agent, reached through the wrapper — the consumer never writes `body` and never has
// to know that j2 wrapped anything.
void customize(wrapped, { agents: { coder: { model: opus } }, image: "ghcr.io/acme/tools:2" });

function refusedThroughTheWrapper(): void {
  // @ts-expect-error `body` is j2's own slot: the transparency is the whole point, so it is not on
  // offer as a child to customize.
  void customize(wrapped, { actors: { body: { agents: { coder: { model: opus } } } } });
  // @ts-expect-error neither are the wrapper's mechanism slots
  void customize(wrapped, { actors: { provision: {} } });
  // @ts-expect-error still only what the body carries, at any wrapper depth
  void customize(pooled, { agents: { scribe: { model: opus } } });
}

// The counter-case, and the reason the reach reads a marker instead of a name: an author is free
// to spell a slot `body` or `worker`, and a type that stepped through it on the spelling would
// offer this Machine's OWN Agents nowhere and the child's everywhere — a compile-time answer the
// runtime (which reads `wrapperBodyOf`) would then contradict.
const namesake = j2Setup({
  events: [done],
  actors: { coder: agent({ model: haiku, instructions: "c" }), body: child, worker: fromPromise(async () => 1) },
}).createMachine({ id: "namesake", initial: "idle", states: { idle: {} } });

void customize(namesake, { agents: { coder: { model: opus } } });
void customize(namesake, { actors: { body: { agents: { scribe: { model: opus } } } } });

function refusedThroughANamesake(): void {
  // @ts-expect-error `scribe` is the child's, and `body` here is an ordinary child slot — so it is
  // reached by name, one level down, like any other composed Machine.
  void customize(namesake, { agents: { scribe: { model: opus } } });
  // @ts-expect-error and `worker` composes no Machine at all
  void customize(namesake, { actors: { worker: {} } });
}

const pooled = pool(wrapped, {
  input: door,
  source: source<{ id: string }>({
    next: fromPromise(async (): Promise<{ item: { id: string } | null; open: number }> => ({ item: null, open: 0 })),
  }),
  itemId: (i) => i.id,
});
// Two wrappers deep — pool of Workspaces — and the Agent is still the body's.
void customize(pooled, { agents: { coder: { model: opus } } });

// --- 4: an override is a partial DEFINITION ----------------------------------------------------

void customize(research, { agents: { coder: { model: opus } } });
void customize(research, { agents: { coder: { instructions: "different", workspace: "read" } } });

function refusedOverrides(): void {
  // @ts-expect-error not a field of an Agent definition — `prompt` is a Turn's, not a persona's
  void customize(research, { agents: { coder: { prompt: "go" } } });
  // @ts-expect-error the scale is j2's, and "extreme" is not on it
  void customize(research, { agents: { coder: { thinkingLevel: "extreme" } } });
}

// --- 5: the result is the same Machine, so it goes where the original went ----------------------

/** True only when A and B are the same type, both ways — assignability would let `any` pass. */
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const quick = customize(wrapped, { agents: { coder: { model: haiku } } });
const doorSurvives: Eq<InputFrom<typeof quick>, z.infer<typeof door>> = true;

void setup({ actors: { deep: customize(wrapped, { agents: { coder: { model: opus } } }), quick } }).createMachine({
  initial: "deep",
  states: {
    deep: { invoke: { src: "deep", input: { topic: "kettles" }, onDone: "quick" } },
    quick: {
      // @ts-expect-error the customized wrapper's door is still checked at the invoke — a retune
      // changes what the Agents are, never what a run of the Machine is started with.
      invoke: { src: "quick", input: { subject: "kettles" } },
    },
  },
});

// --- 6: the Repo Slots the reached workspace() declared (ADR-0051) --------------------------------

// Through the wrapper's own type, and through a pool of it: the slots are the workspace()'s, read
// the way its Agents are read — by the marker, never by a slot's spelling.
void customize(wrapped, { repos: { target: "git@github.com:ourorg/app.git" } });
void customize(wrapped, { repos: { target: { url: "git@github.com:ourorg/app.git", ref: "main" } } });
void customize(pooled, { repos: { target: "git@github.com:ourorg/app.git", docs: open } });
// A mapper over the WRAPPER's door — `input` is the door's parsed type, so a consumer can bind a
// slot from run input without restating the shape.
void customize(wrapped, { repos: { target: ({ input }) => `https://example.test/${input.topic}.git` } });

function refusedRepos(): void {
  // @ts-expect-error `taregt` is a slot this Machine never declared — the body would have no handle for it
  void customize(wrapped, { repos: { taregt: "git@github.com:ourorg/app.git" } });
  // @ts-expect-error the mapper reads the DOOR: `subject` is not on it
  void customize(wrapped, { repos: { target: ({ input }) => input.subject } });
  // @ts-expect-error a Machine composing no Sandbox declares no slots — `never`, not `{}`
  void customize(research, { repos: { target: "git@github.com:ourorg/app.git" } });
  // @ts-expect-error a binding is one of the three forms; a number is none of them
  void customize(wrapped, { repos: { target: 42 } });
}

test("customize()'s type-level claims are the compiler's; this run pins the runtime half", () => {
  // A retune is definition-level and total: what comes back carries the override layered over the
  // stock definition, whatever the type says about the keys.
  const retuned = customize(research, { agents: { coder: { model: opus } } });
  const logic: unknown = retuned.implementations.actors.coder;
  assert.ok(isAgent(logic));
  assert.deepEqual(logic.definition, { model: opus, instructions: "c" });
  assert.ok(doorSurvives);
  // Declared for the compiler, never called — naming them here is what keeps them from reading as
  // dead code (their `@ts-expect-error` lines ARE the assertions).
  assert.ok(
    [
      refusedAgents,
      refusedChildren,
      refusedThroughTheWrapper,
      refusedThroughANamesake,
      refusedOverrides,
      refusedRepos,
    ].every((f) => !!f),
  );
});
