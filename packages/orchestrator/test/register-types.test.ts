// The Register's TYPE-level claims (ADR-0050), asserted by the compiler. `pnpm typecheck` is what
// runs this file: every `@ts-expect-error` fails the build if the refusal it names stops happening.
//
// This program registers NOTHING — `Register` is a global interface, so one augmentation would
// retype every `WorkspaceSpec` in the package's own suite. That is the point of the split: the
// claims that need a catalog in view live in `examples/coding/test/repo-names.test.ts`, whose
// program augments `Register` from its own `j2.config.ts`. What is provable HERE is the other
// half — `defineConfig`'s refusal, which needs no Register at all, and the unregistered fallback.
//
// The claims:
//   1. an unregistered program's `RepoName` is `string` — an honest "no catalog in view", which is
//      also what a Machine packaged for someone else's Instance compiles against;
//   2. a repo entry whose url is not a LITERAL and that carries no `name` is a compile error at
//      `defineConfig` — never a silent widening to `string`;
//   3. the same entry WITH a literal `name` compiles, and that name is the one the catalog holds;
//   4. a literal `name` that is itself non-literal (read from a variable) is refused too — the rule
//      is about the RESOLVED name, not about which field it came from;
//   5. `const T` survives: `defineConfig` hands back the literals it was given, not a widened shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConfig, repoNames, type RepoName } from "../src/config.ts";

/** Compiler-only assertions. Invariant (not covariant) equality, so a widening to `string` in
 * either direction fails rather than passing as "assignable". */
type Expect<T extends true> = T;
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// --- 1: unregistered → `string` ----------------------------------------------------------------

type _Unregistered = Expect<Eq<RepoName, string>>;

// --- 2/3/4: the defineConfig refusal ------------------------------------------------------------

// Not a literal: read at load time, exactly as an instance would read a deployment-varying url.
const fromEnv: string = process.env.J2_TEST_REPO_URL ?? "https://example.test/app.git";

// @ts-expect-error a non-literal url with no `name` has no name the type system can read
const _bareObject = defineConfig({ repos: [{ url: fromEnv }] });
// @ts-expect-error the string shorthand of the same entry, refused for the same reason
const _bareString = defineConfig({ repos: [fromEnv] });
// @ts-expect-error a literal url whose `name` is not a literal widens just the same
const _widenedName = defineConfig({ repos: [{ name: fromEnv, url: "https://example.test/app.git" }] });
// @ts-expect-error one good entry does not excuse a bad one — the error lands on the entry
const _mixed = defineConfig({ repos: ["https://example.test/good.git", { url: fromEnv }] });

// The fix the error names: give the entry a literal name. This must COMPILE.
const named = defineConfig({ repos: [{ name: "app", url: fromEnv }] });

// --- 5: `const T` keeps the literals ------------------------------------------------------------

const literal = defineConfig({ name: "inst", repos: ["https://example.test/app.git"] });
type _Kept = Expect<Eq<(typeof literal)["repos"], readonly ["https://example.test/app.git"]>>;
type _KeptName = Expect<Eq<(typeof named)["repos"], readonly [{ readonly name: "app"; readonly url: string }]>>;

// --- the runtime half, so the file is a real test too -------------------------------------------

test("repoNames resolves the catalog the way the boot does — url-derived and explicit alike", () => {
  const config = defineConfig({
    repos: ["https://github.com/snapwich/obsidian-tasks.nvim.git", { name: "app", url: "/seed/app.bundle" }],
  });
  assert.deepEqual(repoNames(config), ["obsidian-tasks.nvim", "app"]);
});

test("repoNames on a config with no catalog is empty — a door over it accepts nothing", () => {
  assert.deepEqual(repoNames(defineConfig({})), []);
  assert.deepEqual(repoNames(defineConfig({ repos: [] })), []);
});

test("repoNames raises the catalog's own faults — the door and the volume can never disagree", () => {
  assert.throws(
    () => repoNames(defineConfig({ repos: ["https://a.test/app.git", { name: "app", url: "https://b.test/x.git" }] })),
    /both resolve to the name "app"/,
  );
});

// Referenced so `noUnusedLocals` stays available to catch a genuinely dead claim.
void _bareObject;
void _bareString;
void _widenedName;
void _mixed;
void named;
void literal;
export type { _Unregistered, _Kept, _KeptName };
