// `customize()`'s TYPE-level claims (ADR-0049, ADR-0050), asserted by the compiler. `pnpm
// typecheck` is what runs this file: every `@ts-expect-error` below fails the build if the error
// it names stops happening, and every unannotated call fails if the inference it relies on breaks.
//
// The rule these claims serve: a thing code refers to by name should be typed where it is named
// (ADR-0050). An Agent slot is xstate's own `src`, so a `customize()` of an Agent a Machine does
// not carry must stop at `tsc`, not at the first invoke of a run — which is what `jr2 up`'s
// typecheck gate makes a converge-time failure.
//
// The claims:
//   1. an Agent key the Machine does not carry is an error, and a Machine carrying none takes no
//      `agents` at all;
//   2. a child key it does not compose is an error;
//   3. jr2's wrappers are transparent — a body's Agents are reachable through the wrapper, without
//      `body`, and the wrapper's own mechanism slots are not offered; and the transparency follows
//      the wrapper's MARKER, so a slot an author spelled `body` is an ordinary child;
//   4. an override is a PARTIAL definition: `{ model }` alone is enough, an unknown field is not;
//   5. the result is the same Machine type, so a customized Machine goes wherever the original
//      did — invoked as a child, with its door still checked;
//   6. `repos` offers exactly the Repo Slots the reached `workspace()` declared (ADR-0051), in
//      any of the three forms, through a wrapper chain — and nothing on a Machine that composes
//      no Sandbox; a `workspace()` that declared its map Open takes any keys, since naming them
//      is the composer's half;
//   7. `resources` is a Size — `limits.memory` and `limits.cpu`, nothing else (ADR-0060) — and
//      `user` takes the image alone or `{ image, resources }`;
//   8. `effects` offers exactly the Effects a package left Open, each with its part's binding;
//   9. an Open secret binds with `{ secret }`, and beside an Open url or argv one object takes both,
//      so a binding that leaves either unbound does not compile (ADR-0054).

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPromise, setup, type InputFrom } from "xstate";
import { z } from "zod";
import { isAgent } from "../src/agent.ts";
import { customize } from "../src/customize.ts";
import { open } from "../src/parts.ts";
import { agent, command } from "../src/harness-client.ts";
import { arg } from "../src/effect.ts";
import { basic, bearer, http, secret, text } from "../src/http-effect.ts";
import { dispatch } from "../src/dispatch-effect.ts";
import { pool, source } from "../src/pool.ts";
import { jr2Setup } from "../src/setup.ts";
import { workspace, type WorkspaceMachine, type Workspaced } from "../src/workspace.ts";

const opus = "anthropic/claude-opus-x";
const haiku = "anthropic/claude-haiku-x";

/** The Machine a package exports: two Agent slots, one composed child, one plain actor. */
const child = jr2Setup({
  events: [],
  actors: { scribe: agent({ model: haiku, instructions: "s" }) },
}).createMachine({ id: "child", initial: "idle", states: { idle: {} } });

const research = jr2Setup({
  events: [],
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

// --- 3: jr2's wrappers are transparent ----------------------------------------------------------

const door = z.object({ topic: z.string() });
const body = jr2Setup({
  events: [],
  types: {} as { context: {}; input: Workspaced<z.infer<typeof door>, "target"> },
  actors: { coder: agent({ model: haiku, instructions: "c" }) },
}).createMachine({ id: "body", context: {}, initial: "idle", states: { idle: {} } });

const wrapped = workspace(body, {
  input: door,
  repos: { target: open, docs: "https://example.test/handbook.git" },
  spec: () => ({ branch: "feat" }),
});

// The body's Agent, reached through the wrapper — the consumer never writes `body` and never has
// to know that jr2 wrapped anything.
void customize(wrapped, { agents: { coder: { model: opus } }, image: "ghcr.io/acme/tools:2" });

// A Size, and the User Container's split beside it (ADR-0060).
void customize(wrapped, {
  resources: { limits: { memory: "4Gi", cpu: 2 } },
  user: { image: "ghcr.io/acme/sshd:1", resources: { limits: { memory: "256Mi" } } },
});

function refusedSizes(): void {
  // @ts-expect-error a Size is limits only — jr2 reserves the whole Size, so no request is stated
  void customize(wrapped, { resources: { limits: { memory: "4Gi" }, requests: { memory: "1Gi" } } });
  // @ts-expect-error and only the two limits Agent Substrate's template size carries
  void customize(wrapped, { resources: { limits: { "ephemeral-storage": "10Gi" } } });
  // @ts-expect-error the User Container seat forwards nothing but its image and its split
  void customize(wrapped, { user: { image: "ghcr.io/acme/sshd:1", env: [] } });
}

function refusedThroughTheWrapper(): void {
  // @ts-expect-error `body` is jr2's own slot: the transparency is the whole point, so it is not on
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
const namesake = jr2Setup({
  events: [],
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
  // @ts-expect-error the scale is jr2's, and "extreme" is not on it
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

// A package author annotates an export with `WorkspaceMachine`, naming its slots: the phantom the
// annotation carries is what `customize()` reads, so the slots it offers are the named ones. A
// `declare` has no runtime value, so its uses live in the never-called function below.
declare const annotated: WorkspaceMachine<{ topic: string }, unknown, typeof body, "target">;

function refusedRepos(): void {
  void customize(annotated, { repos: { target: "git@github.com:ourorg/app.git" } });
  // @ts-expect-error `taregt` is a slot this Machine never declared — the body would have no handle for it
  void customize(wrapped, { repos: { taregt: "git@github.com:ourorg/app.git" } });
  // @ts-expect-error the same through an annotation — it names the slots, and there is no default that offers every key
  void customize(annotated, { repos: { whatever: "git@github.com:ourorg/app.git" } });
  // @ts-expect-error the mapper reads the DOOR: `subject` is not on it
  void customize(wrapped, { repos: { target: ({ input }) => input.subject } });
  // @ts-expect-error a Machine composing no Sandbox declares no slots — `never`, not `{}`
  void customize(research, { repos: { target: "git@github.com:ourorg/app.git" } });
  // @ts-expect-error a binding is one of the three forms; a number is none of them
  void customize(wrapped, { repos: { target: 42 } });
}

// An Open MAP (`repos: open`): the wrapper's slots infer as `string`, so `repos` takes the
// composer's own keys — as many as they write — in the same three forms, and still refuses a
// value that is none of them.
const anySlots = jr2Setup({
  events: [],
  types: {} as { context: {}; input: Workspaced<z.infer<typeof door>, string> },
  actors: { coder: agent({ model: haiku, instructions: "c" }) },
}).createMachine({ id: "anySlots", context: {}, initial: "idle", states: { idle: {} } });
const mapped = workspace(anySlots, { input: door, repos: open, spec: () => ({ branch: "feat" }) });
void customize(mapped, {
  repos: { target: "git@github.com:ourorg/app.git", reference: { url: "https://example.test/lib.git" } },
});
void customize(mapped, { repos: { target: ({ input }) => `https://example.test/${input.topic}.git` } });
void customize(mapped, { agents: { coder: { model: opus } } });

function refusedUnderOpenMap(): void {
  // @ts-expect-error still one of the three forms per slot
  void customize(mapped, { repos: { target: 42 } });
  // @ts-expect-error the mapper still reads the DOOR
  void customize(mapped, { repos: { target: ({ input }) => input.subject } });
  // @ts-expect-error a body that NAMES a slot cannot sit under an Open map: the composer may never write that word
  void workspace(body, { input: door, repos: open, spec: () => ({ branch: "feat" }) });
}

// --- 8: an Effect's Open parts (ADR-0054) -----------------------------------------------------------
// `effects` offers exactly the Effect slots whose url or argv the package left `open`, each with the
// binding its kind takes, through the wrappers as `agents` goes — and nothing on a Machine with none.

const effectful = jr2Setup({
  events: [],
  actors: {
    call: http({ method: "POST", url: open }),
    deploy: command(open),
    lint: command(["pnpm", "lint"]),
    tracked: http({ method: "GET", url: "https://fixed.example.com" }),
  },
}).createMachine({ id: "effectful", initial: "idle", states: { idle: {} } });

void customize(effectful, {
  effects: { call: { url: text`https://t.example.com/${secret("path")}` }, deploy: { argv: ["make", arg("env")] } },
});
void customize(
  workspace(effectful, { repos: { app: "https://example.test/app.git" }, spec: () => ({ branch: "f" }) }),
  {
    effects: { call: { url: "https://t.example.com" } },
  },
);

function refusedEffects(): void {
  // @ts-expect-error a command's Open part is its argv, not a url
  void customize(effectful, { effects: { deploy: { url: "https://x.example.com" } } });
  // @ts-expect-error an http Effect's Open part is its url, not an argv
  void customize(effectful, { effects: { call: { argv: ["x"] } } });
  // @ts-expect-error a part the author fixed is not offered: its host stays the definition's
  void customize(effectful, { effects: { tracked: { url: "https://other.example.com" } } });
  // @ts-expect-error nor a fixed argv
  void customize(effectful, { effects: { lint: { argv: ["pnpm", "test"] } } });
  // @ts-expect-error bound once, to a value — never a mapper over the run
  void customize(effectful, { effects: { call: { url: () => "https://x.example.com" } } });
  // @ts-expect-error a Machine with no Open Effect takes no `effects`
  void customize(research, { effects: { fetchIt: { url: "https://x.example.com" } } });
}

// --- 9: an Open secret (ADR-0054) ----------------------------------------------------------------------
// `secret(open)` in an auth, a header or a command's env states the Open part "secret": `effects` offers
// `{ secret }`, and an Effect with an Open url or argv beside it takes ONE object with both keys — the
// intersection of the two bindings — so a binding that leaves the secret unbound does not compile.

const token = secret(open);
const secretive = jr2Setup({
  events: [],
  actors: {
    hook: http({ method: "POST", url: "https://hooks.example.com", auth: bearer(secret(open)) }),
    keyed: http({ method: "GET", url: "https://api.example.com", headers: { "x-api-key": text`${secret(open)}` } }),
    pager: http({ method: "POST", url: open, auth: basic("bot", secret(open)) }),
    release: command(open, { env: { TOKEN: token, TOKEN_FILE: token.path } }),
    deploy: command(["make", "deploy"], { env: { KEY: secret(open).path } }),
    fixed: http({ method: "POST", url: "https://fixed.example.com", auth: bearer(secret("fixed")) }),
  },
}).createMachine({ id: "secretive", initial: "idle", states: { idle: {} } });

void customize(secretive, {
  effects: {
    hook: { secret: "team-hook" },
    keyed: { secret: "team-key" },
    pager: { url: "https://pager.example.com", secret: "team-pager" },
    release: { argv: ["./release.sh"], secret: "team-release" },
    deploy: { secret: "team-deploy" },
  },
});

function refusedSecrets(): void {
  // @ts-expect-error an Open url beside an Open secret: one object binds both — the secret left unbound does not compile
  void customize(secretive, { effects: { pager: { url: "https://pager.example.com" } } });
  // @ts-expect-error nor the url left unbound
  void customize(secretive, { effects: { pager: { secret: "team-pager" } } });
  // @ts-expect-error an Open argv beside an Open secret: the secret left unbound does not compile
  void customize(secretive, { effects: { release: { argv: ["./release.sh"] } } });
  // @ts-expect-error an Open secret alone binds to { secret }, never a url
  void customize(secretive, { effects: { hook: { url: "https://x.example.com" } } });
  // @ts-expect-error nor to nothing: its secret left unbound does not compile
  void customize(secretive, { effects: { deploy: {} } });
  // @ts-expect-error a secret's name is a string, never a mapper over the run
  void customize(secretive, { effects: { hook: { secret: () => "per-run" } } });
  // @ts-expect-error a secret the author named is not offered
  void customize(secretive, { effects: { fixed: { secret: "other" } } });
}

// --- 10: a dispatch's Open target (ADR-0071) ------------------------------------------------------
// `target: open` states the Open part "target": `effects` offers `{ target: { url, token } }`, the
// token a named secret — never `secret(open)`, since the target is the Open part, not its secret.

const dispatching = jr2Setup({
  events: [],
  actors: {
    hand: dispatch("task/review-loop", { target: open }),
    local: dispatch("review"),
    away: dispatch("review", { target: { url: "https://ops.example.com", token: secret("ops") } }),
  },
}).createMachine({ id: "dispatching", initial: "idle", states: { idle: {} } });

void customize(dispatching, {
  effects: { hand: { target: { url: "https://ops.example.com", token: secret("ops-instance") } } },
});

function refusedTargets(): void {
  // @ts-expect-error a dispatch's Open part is its target, not a url
  void customize(dispatching, { effects: { hand: { url: "https://ops.example.com" } } });
  // @ts-expect-error nor its target's token alone
  void customize(dispatching, { effects: { hand: { secret: "ops" } } });
  const openToken = { url: "https://ops.example.com", token: secret(open) };
  // @ts-expect-error the token is a named secret: secret(open) inside a target is refused
  void customize(dispatching, { effects: { hand: { target: openToken } } });
  // @ts-expect-error nor a bare string
  void customize(dispatching, { effects: { hand: { target: { url: "https://ops.example.com", token: "ops" } } } });
  // @ts-expect-error a target is bound whole: the token left out does not compile
  void customize(dispatching, { effects: { hand: { target: { url: "https://ops.example.com" } } } });
  // @ts-expect-error a dispatch with no target, or a fixed one, is not offered
  void customize(dispatching, { effects: { local: { target: { url: "https://x.example.com", token: secret("x") } } } });
  // @ts-expect-error nor a fixed one
  void customize(dispatching, { effects: { away: { target: { url: "https://x.example.com", token: secret("x") } } } });
  // The definition holds the same rule as the binding: a target's token is a named secret.
  // @ts-expect-error secret(open) inside a definition's target
  void dispatch("review", { target: { url: "https://ops.example.com", token: secret(open) } });
  // @ts-expect-error nor through a variable
  void dispatch("review", { target: openToken });
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
      refusedUnderOpenMap,
      refusedSizes,
      refusedEffects,
      refusedSecrets,
      refusedTargets,
    ].every((f) => !!f),
  );
});
