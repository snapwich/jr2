// What the Register buys a REGISTERED program (ADR-0050), asserted by the compiler. This instance's
// `j2.config.ts` augments `Register`, so `RepoName` here is this catalog's own names — which is
// exactly the program `j2 up` typechecks before it builds anything, and therefore the seat where a
// mistyped repo stops being a runtime attach refusal and becomes a build error.
//
// It lives in `examples/coding` rather than in the kit's own suite because `Register` is a global
// interface: one augmentation retypes every `WorkspaceSpec` in its program. The kit's half of these
// claims — `defineConfig`'s refusal, and the unregistered `string` fallback — is in
// `packages/orchestrator/test/register-types.test.ts`.
//
// The claims:
//   1. `RepoName` is the catalog's own names, derived by `repoName()`'s rule (the url's last
//      segment minus `.git`), not `string`;
//   2. a typo'd repo name in a `workspace()` spec is a compile error;
//   3. `repoNames(config)` is that same union at runtime, in catalog order, so a door built on it
//      hands its parsed value straight into a spec.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "xstate";
import { repoNames, workspace, type RepoName, type WorkspaceSpec } from "@j2/orchestrator";
import config from "../j2.config.ts";

type Expect<T extends true> = T;
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// --- 1: the catalog, read back through the Register ---------------------------------------------

type _Catalog = Expect<Eq<RepoName, "obsidian-tasks.nvim">>;

// --- 2: a typo is a build error, in a spec and anywhere else a name is written -------------------

const body = setup({ types: {} as { context: {}; input: unknown } }).createMachine({
  context: {},
  initial: "idle",
  states: { idle: {} },
});

const good = workspace(body, {
  spec: () => ({ repos: [{ name: "obsidian-tasks.nvim", baseRef: "main" }], branch: "b" }),
});

workspace(body, {
  // @ts-expect-error "obsidian-tasks" is not in this instance's catalog — one converge earlier than
  // the attach that would have refused it
  spec: () => ({ repos: [{ name: "obsidian-tasks", baseRef: "main" }], branch: "b" }),
});

// The same refusal off the Machine, so it cannot be read as an artifact of the overload resolution.
// @ts-expect-error a spec literal is checked against the catalog wherever it is written
const _typoed: WorkspaceSpec = { repos: [{ name: "obsidian-tasks" }], branch: "b" };

// --- 3: the runtime half, and the door↔spec seam -------------------------------------------------

test("repoNames(config) is the catalog's names, in order — what a door's z.enum is built from", () => {
  assert.deepEqual(repoNames(config), ["obsidian-tasks.nvim"]);
});

test("a name that came through a repoNames door drops into a spec with no re-check", () => {
  const [first] = repoNames(config);
  const spec: WorkspaceSpec = { repos: [{ name: first! }], branch: "feat" };
  assert.deepEqual(spec.repos, [{ name: "obsidian-tasks.nvim" }]);
});

void good;
void _typoed;
export type { _Catalog };
