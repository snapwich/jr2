// An Instance has ONE Kit version (ADR-0056): the `@jr2/orchestrator` it resolves, because that is
// what its image bakes. Published `@jr2/cli@X` used to DEPEND on `@jr2/orchestrator@X` exact, so an
// Instance pinning any other orchestrator quietly held two copies — the CLI's `KIT_VERSION` named
// one, the bundle baked the other, and the CLI's own code handled config objects built by a
// different copy of the same classes. Now the orchestrator is the CLI's PEER (one copy can exist),
// and every Instance verb asks this module whether the copy the CLI resolves IS the copy the
// Instance resolves: same REAL path, never a version compare. Same file means same version by
// construction under npm hoisting, pnpm dedup, and checkout symlinks alike — and identity is
// exactly the property the class-identity bug needs.
//
// Builtins only: the launcher (`bin/jr2.js`) resolves through here before any kit import.

import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ResolvedPackage = {
  /** The package's REAL root directory (symlinks resolved). */
  root: string;
  version: string;
  bin?: string | Record<string, string>;
};

/**
 * Resolve `name` the way code in `fromDir` would — Node resolution from that folder — and answer
 * the package's real root. `undefined` when nothing resolves (no `node_modules` yet, or a global
 * with no peer beside it). Walks up from the resolved ENTRY to the nearest manifest carrying the
 * name, rather than resolving `<name>/package.json`, because an `exports` map hides the manifest
 * and the kits already published export none.
 */
export function resolvePackage(name: string, fromDir: string): ResolvedPackage | undefined {
  const require = createRequire(join(fromDir, "package.json"));
  let entry: string;
  try {
    entry = realpathSync(require.resolve(name));
  } catch {
    return undefined;
  }
  let dir = dirname(entry);
  for (;;) {
    try {
      const m = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as ResolvedPackage & { name?: string };
      if (m.name === name) return { root: dir, version: m.version, bin: m.bin };
    } catch {
      // not a manifest, or not this package's — keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** This CLI's own real root and version — what `jr2 init` pins (ADR-0056), what the refusal names. */
export const CLI_ROOT = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
export const CLI_VERSION = (JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8")) as { version: string })
  .version;

const ORCHESTRATOR = "@jr2/orchestrator";
const CLI = "@jr2/cli";

/**
 * The ADR-0056 question, answered rather than asserted: what the Instance at `root` resolves
 * `@jr2/orchestrator` to, what this CLI resolves it to, and whether they are one copy. `ok` is the
 * real-path identity, never a version compare. `jr2 version` prints this; every other Instance verb
 * goes through {@link assertKitVersion}, which turns a not-ok answer into the refusal.
 */
export type KitCheck = {
  /** The Instance's own resolution — its Kit version; absent when nothing resolves from `root`. */
  instance?: ResolvedPackage;
  /** This CLI's peer; absent for a global with no orchestrator beside it. */
  own?: ResolvedPackage;
  /** What the Instance's manifest PINS for `@jr2/orchestrator`, verbatim — so "edited the line,
   * never reinstalled" is visible as a pin that disagrees with what resolves. */
  pinned?: string;
  ok: boolean;
};

export function checkKitVersion(root: string): KitCheck {
  const instance = resolvePackage(ORCHESTRATOR, root);
  const own = resolvePackage(ORCHESTRATOR, CLI_ROOT);
  return {
    instance,
    own,
    pinned: pinnedVersion(root, ORCHESTRATOR),
    ok: instance !== undefined && own !== undefined && instance.root === own.root,
  };
}

/** The version `root/package.json` pins for `name`, from any dependency block; `undefined` when
 * there is no manifest or no such line. The pin as WRITTEN — a range stays a range. */
export function pinnedVersion(root: string, name: string): string | undefined {
  try {
    const m = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const block of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const pin = m[block]?.[name];
      if (pin !== undefined) return pin;
    }
  } catch {
    // no manifest, or not JSON — the Instance has no pin to speak of
  }
  return undefined;
}

/**
 * Refuse unless the Instance at `root` and this CLI resolve the SAME `@jr2/orchestrator`. The
 * message names both versions and the lines to edit: an Instance with no `@jr2/cli` of its own is
 * told to add one (the launcher then hands off to it); one that has it is told to pin both lines
 * at one number.
 */
export function assertKitVersion(root: string): void {
  const { instance, own, ok } = checkKitVersion(root);
  if (ok) return;

  const manifest = join(root, "package.json");
  const local = instance && resolvePackage(CLI, root);
  const fix = !instance
    ? `install the Instance's dependencies (${manifest} pins "${ORCHESTRATOR}" and "${CLI}" at one exact version)`
    : local
      ? `pin "${ORCHESTRATOR}" and "${CLI}" at ONE exact version in ${manifest} and reinstall`
      : `add "${CLI}": "${instance.version}" to devDependencies in ${manifest} and reinstall — the Instance's ` +
        `own jr2 then runs`;
  const have = instance
    ? `${ORCHESTRATOR} resolves to ${instance.version} (${instance.root})`
    : `${ORCHESTRATOR} does not resolve from ${root}`;
  const self = own
    ? `this jr2 (${CLI_VERSION}) runs against ${own.version} (${own.root})`
    : `this jr2 (${CLI_VERSION}, at ${CLI_ROOT}) has no ${ORCHESTRATOR} beside it`;
  throw new Error(`Kit version mismatch — an Instance has one (ADR-0056):\n  ${have}\n  ${self}\n  ${fix}`);
}
