// The @dist tier's suite fixture (ADR-0043/0044): the kit published into a local registry and
// installed globally, exactly as a user receives it — the packages from npm, the Kit images from a
// registry the cluster's nodes pull them out of.
//
// TWO registries stand in here, and nothing else does. npm's (verdaccio) and the Kit image home's
// (a local OCI registry, ADR-0044) — the second one added the day `publishedKitRefs()` grew a
// registry prefix, because until then this tier `kind load`ed the published tags and the pull path
// every installed kit takes ran nowhere.
//
// ONE per suite run. A publish plus three image builds is minutes and nothing about it is
// per-scenario: scenarios isolate by namespace and temp folder, the way @kind's do.
//
// Not a `BeforeAll`. Cucumber's global hooks take no tags, so a `BeforeAll` in a step file the
// DEFAULT profile also imports would stand up verdaccio for a socket-free suite that wants none.
// A memoized promise the `@dist` Before hook awaits buys the same once-per-run without that.
//
// The mechanics live in scripts/dist-registry.sh + scripts/dist-image-registry.sh +
// scripts/dist-publish.sh — the SAME scripts `just dist-up` runs, so the loop's automated face and
// its manual face cannot drift apart.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** What a @dist scenario needs from the fixture: where the installed `j2` lives, the registry its
 * package manager resolves `@j2/*` from, and the one its CLUSTER pulls Kit images from — two
 * different registries answering two different questions (ADR-0044), never one address doing both. */
export type InstalledKit = { binDir: string; registry: string; kitRegistry: string };

let pending: Promise<InstalledKit> | undefined;
/** The fixture's own state — its dir (registry storage, npmrc, global prefix) and the environment
 * the scripts read it through. Set as soon as bring-up starts, so a bring-up that FAILS half way
 * still has its registry stopped and its dir deleted. */
let state: { dir: string; env: NodeJS.ProcessEnv } | undefined;

/** The published kit, brought up on first ask and shared by every @dist scenario after. */
export function installedKit(): Promise<InstalledKit> {
  return (pending ??= bringUp());
}

/** Stop the registry and delete the fixture's state. A no-op when no @dist scenario ran, which is
 * what lets the untagged `AfterAll` that calls it live in a file every profile imports. */
export async function closeInstalledKit(): Promise<void> {
  if (!pending) return;
  await pending.catch(() => {});
  const held = state;
  pending = undefined;
  state = undefined;
  if (!held) return;
  await exec(script("dist-registry.sh"), ["down"], { env: held.env }).catch(() => {});
  await exec(script("dist-image-registry.sh"), ["down"], { env: held.env }).catch(() => {});
  await rm(held.dir, { recursive: true, force: true });
}

async function bringUp(): Promise<InstalledKit> {
  // The registry is READ from the guard, never repeated here: `publishConfig` names the only
  // registry a package may publish to (ADR-0043), so a fixture that picked its own port would
  // publish nowhere — and moving the guard must move the loop with it, not break it.
  const manifest = JSON.parse(await readFile(join(REPO, "packages", "cli", "package.json"), "utf8")) as {
    publishConfig?: { registry?: string };
  };
  const registry = manifest.publishConfig?.registry;
  assert.ok(registry, "@j2/cli's publishConfig names the registry the loop publishes to (ADR-0043)");

  // The guard fixes the port, so the loop's two faces cannot both hold it: anything already
  // answering there is a `just dist-up` left standing, whose storage this fixture will not wipe.
  // Said here, because the alternative is a publish that fails as an unexplained version conflict.
  const taken = await fetch(`${registry}/-/ping`).then(
    () => true,
    () => false,
  );
  assert.ok(!taken, `something already serves ${registry} — \`just dist-down\` before the @dist tier`);

  // Asked before minutes of docker are spent, and asked of the CLUSTER rather than of a name
  // written down here: `j2 up` will address whatever the current context names (ADR-0019), and an
  // installed kit builds no Kit image — it deploys published refs, which must already be in a
  // registry these nodes can pull from (below).
  const { stdout: context } = await exec("kubectl", ["config", "current-context"]).catch(() => ({ stdout: "" }));
  assert.match(
    context.trim(),
    /^kind-/,
    "the @dist tier needs a kind cluster as the current kube context — `just e2e-dist-up`",
  );

  // The scripts take their whole configuration from these two variables, so the fixture's registry
  // storage, npmrc, and global prefix never touch a `just dist-up` a developer left standing.
  const dir = await mkdtemp(join(tmpdir(), "j2-dist-"));
  const env: NodeJS.ProcessEnv = { ...process.env, J2_DIST_DIR: dir, J2_DIST_PORT: new URL(registry).port };
  state = { dir, env };
  await exec(script("dist-registry.sh"), ["up"], { env, maxBuffer: BIG });
  // The second stand-in (ADR-0044): the Kit image home. Up before the publish, which pushes the
  // three images into it, and it is the script that also points the cluster's nodes at it — a node
  // that cannot resolve this address fails the tier here, by name, instead of as an
  // ImagePullBackOff three minutes into a converge.
  await exec(script("dist-image-registry.sh"), ["up"], { env, maxBuffer: BIG });
  // Asked, never composed: the port has one owner (the script's own default/J2_DIST_IMAGE_PORT), so
  // a fixture that spelled `localhost:5001` a second time could point scenarios at a registry
  // nothing serves.
  const { stdout: kitRegistry } = await exec(script("dist-image-registry.sh"), ["address"], { env });
  await exec(script("dist-publish.sh"), [], { env, maxBuffer: BIG });

  const binDir = join(dir, "npm-global", "bin");
  // The one property `npm link` could not give this tier (ADR-0043): the binary is a real install,
  // not a symlink into the checkout. Node resolves modules by REAL path, so a linked `j2` would
  // find the kit checkout above it and run checkout mode — the branch this tier exists to skip.
  // Both sides resolved, because a temp dir is a symlink on some platforms and this must compare
  // real paths against real paths, not a truth against a spelling.
  const real = await realpath(join(binDir, "j2"));
  const prefix = await realpath(dir);
  assert.ok(real.startsWith(prefix), `the installed j2 resolves inside the throwaway prefix, not to ${real}`);
  return { binDir, registry, kitRegistry: kitRegistry.trim() };
}

/** 64 MB: three docker builds and a publish, all narrating. */
const BIG = 64 * 1024 * 1024;

function script(name: string): string {
  return join(REPO, "scripts", name);
}
