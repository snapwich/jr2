// What the kit publishes (ADR-0043). The @dist tier proves the published kit WORKS; it structurally
// cannot prove that the tarballs hold nothing they shouldn't — a `files:` allowlist fails loudly
// only when it OMITS something, never when it over-includes. So the over-include half is asserted
// here, on the manifests themselves, socket-free.
//
// It matters because these are PROD dependencies of every instance: whatever they pack is unpacked
// by the bundle's frozen install and baked into the instance image (ADR-0038).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

type Manifest = {
  private?: boolean;
  publishConfig?: { registry?: string };
  files?: string[];
  bin?: Record<string, string>;
  types?: string;
  exports?: Record<string, string>;
};

async function manifest(pkg: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(REPO, "packages", pkg, "package.json"), "utf8")) as Manifest;
}

/** The prod-resolution chain an instance pulls from npm. */
const PUBLIC = ["cli", "orchestrator", "agent-protocol", "machines"];
/** Reached as Kit images instead, never via npm install (ADR-0027, ADR-0037). */
const PRIVATE = ["harness", "adapter"];

/** The registry the guard names. Read from `@j2/cli` rather than written down twice: moving the
 * guard must move every reader with it (the @dist fixture reads the same field). */
async function guardedRegistry(): Promise<string> {
  const registry = (await manifest("cli")).publishConfig?.registry;
  assert.ok(registry, "@j2/cli's publishConfig names the registry the kit may publish to");
  return registry;
}

test("the publish set is the instance's prod chain, and its guard is the manifest", async () => {
  // `private: true` was the accidental-publish guard; losing it moves the guard into
  // publishConfig, which outranks CLI and env registry settings (ADR-0043). Publishing to npmjs is
  // then a deliberate, reviewable edit — never an absence-of-flag accident.
  const registry = await guardedRegistry();
  assert.match(registry, /^http:\/\/localhost:\d+$/, "the only registry the kit may publish to is local");

  for (const pkg of PUBLIC) {
    const m = await manifest(pkg);
    assert.equal(m.private, false, `packages/${pkg} publishes`);
    assert.equal(m.publishConfig?.registry, registry, `packages/${pkg} carries the same localhost guard`);
  }
  for (const pkg of PRIVATE) {
    const m = await manifest(pkg);
    assert.equal(m.private, true, `packages/${pkg} reaches users as a Kit image, not as an npm package`);
  }
});

test("every published package ships an allowlist that holds its entrypoints and no test tree", async () => {
  for (const pkg of PUBLIC) {
    const m = await manifest(pkg);
    const files = m.files;
    assert.ok(files?.length, `packages/${pkg} declares a files: allowlist — without one, npm packs the whole tree`);

    // Everything the manifest itself points at has to be inside the allowlist, or the package
    // installs broken. This is the half a publish would eventually catch; it is here so it fails in
    // the default gate instead.
    const entrypoints = [
      ...Object.values(m.exports ?? {}),
      ...Object.values(m.bin ?? {}),
      ...(m.types ? [m.types] : []),
    ];
    for (const entry of entrypoints) {
      const rel = entry.replace(/^\.\//, "");
      const covered = files.some((f) => f === rel || rel.startsWith(`${f}/`));
      assert.ok(covered, `packages/${pkg} publishes ${entry}, so its files: list must cover it`);
    }

    // And the half nothing downstream can catch: tests are ~460 kB of source in @j2/orchestrator
    // alone, unpacked into every instance's node_modules and baked into its image.
    assert.ok(!files.includes("test"), `packages/${pkg} does not ship its test tree`);
  }

  // The Console is served from the package at runtime (ADR-0034: `console/` assets, `.ts` sources
  // type-erased on the way out), so nothing in the manifest names it and the derived check above
  // cannot see it. Said explicitly, because an orchestrator that packs no `console/` serves 404s.
  assert.ok((await manifest("orchestrator")).files?.includes("console"), "@j2/orchestrator ships the Console");
});
