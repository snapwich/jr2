// Steps for the @dist tier (ADR-0043/0044): the kit as a user installs it. Three of them are the
// user's whole path — `jr2 init`, their own package manager, `jr2 up` — and that shape is the claim.
// The fourth reaches into the cluster with `kubectl`, for the one thing the path cannot show from
// outside: that the Kit images came off a registry by PULL (ADR-0044). Nothing here reaches past
// what a user's own shell could see (ADR-0010).
//
// Everything after `jr2 up` is already covered by the run-control steps (`I run … with message …`,
// `stdout is the terminal status with reply …`), and they work here unchanged because the World
// decides WHICH binary `runCli` spawns. That reuse is the point: the assertions are the same
// claims the other tiers make, and only the delivery of the kit differs.

import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { IMAGES_CONFIGMAP, IMAGES_KEY } from "@jr2/orchestrator";
import { E2EWorld } from "./world.ts";

const exec = promisify(execFile);

/** 64 MB: a package manager resolving a whole dependency tree out loud. */
const BIG = 64 * 1024 * 1024;

// Lifecycle lives in hooks.ts with every other tier's: the suite-wide published kit, and a per
// -scenario namespace + temp folder the World's `cleanup` already deletes.

// --- given ---------------------------------------------------------------------------------------

/**
 * `jr2 init` in a temp folder, run by the INSTALLED binary. The assertions before it are the
 * scenario's real preconditions, not paranoia: an instance inside a pnpm workspace bundles with
 * `pnpm deploy` and an instance inside a git repo is a different scaffold story, so a stray
 * `TMPDIR` under a checkout would silently test the mode every other tier already tests.
 */
Given("a standalone instance scaffolded by the installed jr2", async function (this: E2EWorld): Promise<void> {
  for (const marker of ["pnpm-workspace.yaml", ".git", "package.json"]) {
    const found = await findAbove(this.dir, marker);
    assert.equal(found, undefined, `the @dist instance must stand alone — found ${marker} above it at ${found}`);
  }
  const r = await this.runCli(["init"], { namespaced: false });
  assert.equal(r.code, 0, `jr2 init failed: ${r.stderr}`);

  // The one edit a self-hosting user makes to the scaffold (ADR-0044): this cluster pulls its Kit
  // images from a mirror, not from the canonical home. It rides `.env` + `process.env` rather than
  // a literal because it is deployment-varying — which also means the instance's config file is
  // byte-identical to what any other self-hoster writes, and the fixture's address stays out of it.
  const kitRegistry = this.dist?.kitRegistry;
  assert.ok(kitRegistry, "a @dist scenario has its installed kit");
  await writeFile(join(this.dir, ".env"), `JR2_KIT_REGISTRY=${kitRegistry}\n`);
  await writeFile(join(this.dir, "jr2.config.ts"), KIT_REGISTRY_CONFIG_TS);
});

/**
 * The scaffold's own `jr2.config.ts` plus the mirror key — written whole rather than patched, so the
 * step never depends on the template's exact bytes (`jr2 init` owns those, and `init.test.ts` guards
 * them). No `git` block: these scenarios run `ping`, which touches no Workspace at all.
 *
 * `.env` reaches the CLI and stops there. It is one of the credential files a bundle stage drops
 * (ADR-0043), so nothing about the mirror is baked into the instance image — and nothing needs to
 * be: `kitRegistry` is answered at converge time, when the pod spec's image refs are composed.
 *
 * The import names `@jr2/orchestrator` by BARE specifier, so this tier is where it meets a
 * genuinely npm-installed kit — both when Node type-strips this file and when `jr2 up`'s gate
 * compiles the folder.
 */
const KIT_REGISTRY_CONFIG_TS = `import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({ kitRegistry: process.env.JR2_KIT_REGISTRY });
`;

// --- when ----------------------------------------------------------------------------------------

/**
 * The user's own install, with their own package manager. The `.npmrc` is written first and is
 * REALISTIC, not a test fixture: it is what anyone resolving a scoped package from a private
 * registry already has. It reaches this install only — the staged bundle drops `.npmrc` with the
 * rest of the credential files (ADR-0043), so the frozen install `jr2 up` runs inside it takes the
 * registry off the environment instead (see `setupDist`).
 *
 * The one thing the manager gets that a user's shell would not: a cache of the fixture's, because
 * the user's own remembers a registry that was wiped since (`InstalledKit.cacheDir`).
 */
When("I install its dependencies with {string}", async function (this: E2EWorld, pm: string): Promise<void> {
  const registry = this.dist?.registry;
  const cacheDir = this.dist?.cacheDir;
  assert.ok(registry && cacheDir, "a @dist scenario has its installed kit");
  const cacheSetting = CACHE_SETTING[pm];
  assert.ok(cacheSetting, `no cache setting is known for "${pm}" — this tier drives npm and pnpm`);
  await writeFile(join(this.dir, ".npmrc"), `registry=${registry}\n`);
  // The resolution failure is the likeliest one in this tier, so its own words are carried out.
  const env = { ...shellEnv(), [cacheSetting]: cacheDir };
  await exec(pm, ["install"], { cwd: this.dir, env, maxBuffer: BIG }).catch((err: Error & { stderr?: string }) => {
    throw new Error(`${pm} install failed in ${this.dir}: ${err.stderr || err.message}`);
  });
  // The lockfile is part of the instance contract (ADR-0043): it, not the node_modules this just
  // wrote, is what the image bundle installs from — so a manager that wrote none has already
  // broken the converge, three minutes before `jr2 up` would say so.
  const lockfile = pm === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
  await stat(join(this.dir, lockfile)).catch(() => {
    throw new Error(`${pm} install left no ${lockfile} — the bundle installs from the lockfile (ADR-0043)`);
  });
});

/**
 * Each manager's name for its cache, as the environment spells it. Keyed by manager because the
 * two names differ and each warns about the other's as unknown config — and it goes through the
 * environment, never through the `.npmrc` above, which stays what a user writes.
 */
const CACHE_SETTING: Record<string, string> = { npm: "npm_config_cache", pnpm: "npm_config_cache_dir" };

// The converge, in installed mode: no kit sources resolve, so the Harness, Adapter, and operator
// come from the published `<kitRegistry>/jr2-<x>:<kitversion>` tags the suite fixture PUSHED, pulled
// by the nodes themselves (ADR-0038/0044), and the instance image is bundled from the lockfile
// above — built here, and still delivered by `kind load`, because this converge is the one that
// builds it.
When("I converge it onto the cluster", { timeout: 900_000 }, async function (this: E2EWorld): Promise<void> {
  const r = await this.runCli(["up", "--yes"]);
  assert.equal(r.code, 0, `jr2 up failed: ${r.stderr}`);
  assert.match(r.stderr, /images: installed kit/, "the installed CLI took installed mode, not checkout mode");
});

/** `jr2 down --yes`, from the installed binary: removes the instance's namespace and sweeps the
 * images its roots no longer protect (ADR-0019/0039). `--yes` because the verb always confirms,
 * and there is no one at the prompt. */
When("I take the instance down", { timeout: 300_000 }, async function (this: E2EWorld): Promise<void> {
  const r = await this.runCli(["down", "--yes"]);
  assert.equal(r.code, 0, `jr2 down failed: ${r.stderr}`);
  assert.match(r.stderr, /removed/, "down reports the instance removed");
});

// --- then ----------------------------------------------------------------------------------------

/** The namespace IS the instance (ADR-0019): gone means removed. `jr2 down` waits on the delete, so
 * this asks once and expects kubectl's NotFound — spelled the way a user would check. */
Then("the instance's namespace is gone", async function (this: E2EWorld): Promise<void> {
  assert.ok(this.namespace, "a @dist scenario has its namespace set in setupDist");
  const left = await kubectlOut(["get", "namespace", this.namespace, "--ignore-not-found", "-o", "name"]);
  assert.equal(left.trim(), "", `namespace ${this.namespace} still exists after jr2 down`);
});

/**
 * The claim ADR-0044 adds to this tier: the Kit images this cluster runs came out of a REGISTRY.
 *
 * Two halves, because one of them alone would prove less than it looks. The refs say the CLI
 * re-homed the published tags onto `kitRegistry` (the Harness and the Adapter have no pod in a
 * `ping` scenario — the instance's own image map is where they are nameable at all); the RUNNING
 * operator pod says a node resolved that address, pulled the bytes and unpacked them, which is the
 * exact leg `kind load` at the published names used to skip.
 *
 * Spelled the way a user's `kubectl` would (ADR-0010), namespace and selector included — they are
 * `OPERATOR_NAMESPACE`/`OPERATOR_SELECTOR` in packages/cli/src/deploy.ts, and a black-box step is
 * not entitled to import them from the kit it is testing at arm's length.
 */
Then("the cluster pulled its Kit images from the local registry", async function (this: E2EWorld): Promise<void> {
  const kitRegistry = this.dist?.kitRegistry;
  assert.ok(kitRegistry, "a @dist scenario has its installed kit");
  assert.ok(this.namespace, "a @dist scenario has its namespace set in setupDist");

  const map = await kubectlOut(["--namespace", this.namespace, "get", "configmap", IMAGES_CONFIGMAP, "-o", "json"]);
  const raw = (JSON.parse(map) as { data?: Record<string, string> }).data?.[IMAGES_KEY];
  assert.ok(raw, `the ${IMAGES_CONFIGMAP} ConfigMap carries ${IMAGES_KEY} (ADR-0038)`);
  const refs = JSON.parse(raw) as { harness?: string; adapter?: string };
  for (const [which, ref] of Object.entries({ harness: refs.harness, adapter: refs.adapter })) {
    assert.ok(
      ref?.startsWith(`${kitRegistry}/jr2-${which}:`),
      `the ${which} ref is ${ref} — an installed kit pointed at a mirror deploys ${kitRegistry}/jr2-${which}:<ver>`,
    );
  }

  // The operator's declared image first: a pod could otherwise be a survivor of some earlier
  // converge, and "something running out of the mirror" is not the claim.
  const declared = (
    await kubectlOut([
      "--namespace",
      "jr2-system",
      "get",
      "deployment",
      "jr2-controller-manager",
      "-o",
      "jsonpath={.spec.template.spec.containers[0].image}",
    ])
  ).trim();
  assert.ok(
    declared.startsWith(`${kitRegistry}/jr2-operator:`),
    `the operator Deployment declares ${declared}, not a ${kitRegistry} ref`,
  );

  // Then a pod actually RUNNING it. `Running` is the whole assertion: the kubelet reaches that
  // phase only after containerd resolved `localhost:<port>/…` through the node's hosts.toml, pulled
  // the manifest and unpacked the layers. A rollout leaves the previous pod terminating, so this
  // asks whether ANY running pod carries the declared ref rather than that every one does.
  const pods = await kubectlOut([
    "--namespace",
    "jr2-system",
    "get",
    "pods",
    "-l",
    "control-plane=controller-manager",
    "-o",
    `jsonpath={range .items[*]}{.status.phase}{"\\t"}{.spec.containers[*].image}{"\\n"}{end}`,
  ]);
  const running = pods
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([phase]) => phase === "Running")
    .map(([, image]) => image ?? "");
  assert.ok(
    running.includes(declared),
    `no operator pod is running ${declared} — the node never pulled it. Pods:\n${pods}`,
  );
});

/** kubectl, verbatim, for the claims that reach past the instance's own namespace. */
async function kubectlOut(args: string[]): Promise<string> {
  const { stdout } = await exec("kubectl", args, { maxBuffer: BIG });
  return stdout;
}

/**
 * The environment a USER's shell has. This suite is launched by `pnpm --filter`, and pnpm exports
 * its whole configuration as `npm_config_*` — `registry` included — to everything it spawns. Env
 * config OUTRANKS a project `.npmrc` in both managers, so an inherited environment would resolve
 * `@jr2/*` from npmjs and fail the tier on a leak from its own runner rather than on the kit.
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
