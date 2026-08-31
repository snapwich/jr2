// Steps for the @dist tier (ADR-0043): the kit as a user installs it. There are only three of them,
// and that is the shape of the claim — a user's whole path is `j2 init`, their own package manager,
// `j2 up`. Nothing here reaches past what their shell would see (ADR-0010).
//
// Everything after `j2 up` is already covered by the run-control steps (`I run … with message …`,
// `stdout is the terminal status with reply …`), and they work here unchanged because the World
// decides WHICH binary `runCli` spawns. That reuse is the point: the assertions are the same
// claims the other tiers make, and only the delivery of the kit differs.

import { Given, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { E2EWorld } from "./world.ts";

const exec = promisify(execFile);

/** 64 MB: a package manager resolving a whole dependency tree out loud. */
const BIG = 64 * 1024 * 1024;

// Lifecycle lives in hooks.ts with every other tier's: the suite-wide published kit, and a per
// -scenario namespace + temp folder the World's `cleanup` already deletes.

// --- given ---------------------------------------------------------------------------------------

/**
 * `j2 init` in a temp folder, run by the INSTALLED binary. The assertions before it are the
 * scenario's real preconditions, not paranoia: an instance inside a pnpm workspace bundles with
 * `pnpm deploy` and an instance inside a git repo is a different scaffold story, so a stray
 * `TMPDIR` under a checkout would silently test the mode every other tier already tests.
 */
Given("a standalone instance scaffolded by the installed j2", async function (this: E2EWorld): Promise<void> {
  for (const marker of ["pnpm-workspace.yaml", ".git", "package.json"]) {
    const found = await findAbove(this.dir, marker);
    assert.equal(found, undefined, `the @dist instance must stand alone — found ${marker} above it at ${found}`);
  }
  const r = await this.runCli(["init"], { namespaced: false });
  assert.equal(r.code, 0, `j2 init failed: ${r.stderr}`);
});

// --- when ----------------------------------------------------------------------------------------

/**
 * The user's own install, with their own package manager. The `.npmrc` is written first and is
 * REALISTIC, not a test fixture: it is what anyone resolving a scoped package from a private
 * registry already has. It reaches this install only — the staged bundle drops `.npmrc` with the
 * rest of the credential files (ADR-0043), so the frozen install `j2 up` runs inside it takes the
 * registry off the environment instead (see `setupDist`).
 */
When("I install its dependencies with {string}", async function (this: E2EWorld, pm: string): Promise<void> {
  const registry = this.dist?.registry;
  assert.ok(registry, "a @dist scenario has its installed kit");
  await writeFile(join(this.dir, ".npmrc"), `registry=${registry}\n`);
  // The resolution failure is the likeliest one in this tier, so its own words are carried out.
  await exec(pm, ["install"], { cwd: this.dir, env: shellEnv(), maxBuffer: BIG }).catch(
    (err: Error & { stderr?: string }) => {
      throw new Error(`${pm} install failed in ${this.dir}: ${err.stderr || err.message}`);
    },
  );
  // The lockfile is part of the instance contract (ADR-0043): it, not the node_modules this just
  // wrote, is what the image bundle installs from — so a manager that wrote none has already
  // broken the converge, three minutes before `j2 up` would say so.
  const lockfile = pm === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
  await stat(join(this.dir, lockfile)).catch(() => {
    throw new Error(`${pm} install left no ${lockfile} — the bundle installs from the lockfile (ADR-0043)`);
  });
});

// The converge, in installed mode: no kit sources resolve, so the Harness, Adapter, and operator
// come from the published `<kitversion>` tags the suite fixture loaded (ADR-0038), and the instance
// image is bundled from the lockfile above.
When("I converge it onto the cluster", { timeout: 900_000 }, async function (this: E2EWorld): Promise<void> {
  const r = await this.runCli(["up", "--yes"]);
  assert.equal(r.code, 0, `j2 up failed: ${r.stderr}`);
  assert.match(r.stderr, /images: installed kit/, "the installed CLI took installed mode, not checkout mode");
});

/**
 * The environment a USER's shell has. This suite is launched by `pnpm --filter`, and pnpm exports
 * its whole configuration as `npm_config_*` — `registry` included — to everything it spawns. Env
 * config OUTRANKS a project `.npmrc` in both managers, so an inherited environment would resolve
 * `@j2/*` from npmjs and fail the tier on a leak from its own runner rather than on the kit.
 */
function shellEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("npm_")));
}

/** The nearest ancestor of `dir` (inclusive) holding `marker`, or undefined. */
async function findAbove(dir: string, marker: string): Promise<string | undefined> {
  for (let at = dir; ; at = dirname(at)) {
    try {
      await stat(join(at, marker));
      return at;
    } catch {
      // absent here — keep walking
    }
    if (dirname(at) === at) return undefined;
  }
}
