// What the kit publishes (ADR-0043). The @dist tier proves the published kit WORKS; it structurally
// cannot prove that the tarballs hold nothing they shouldn't — a `files:` allowlist fails loudly
// only when it OMITS something, never when it over-includes. So the over-include half is asserted
// here, on the manifests themselves, socket-free.
//
// It matters because these are PROD dependencies of every instance: whatever they pack is unpacked
// by the bundle's frozen install and baked into the instance image (ADR-0038).

import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

type Manifest = {
  private?: boolean;
  publishConfig?: { registry?: string; access?: string };
  engines?: { node?: string };
  description?: string;
  repository?: { type?: string; url?: string; directory?: string };
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

test("the publish set is the instance's prod chain, and no manifest names a registry", async () => {
  // `private: true` was the accidental-publish guard, then a localhost `publishConfig.registry`
  // was (ADR-0043) — and that line had no exit, because `publishConfig` outranks `--registry`, so
  // the edit that let the kit reach npmjs broke every reader of the guard at once. The guard is
  // now the CREDENTIAL (ADR-0055): no dev box holds an npmjs token, and the release job publishes
  // by trusted publishing on a pushed tag. So the assertion inverts — a registry line in any
  // manifest would silently pin a release to wherever it points, past every flag the job passes.
  for (const pkg of PUBLIC) {
    const m = await manifest(pkg);
    assert.equal(m.private, false, `packages/${pkg} publishes`);
    assert.equal(
      m.publishConfig?.registry,
      undefined,
      `packages/${pkg} names no registry — the guard is the credential`,
    );
    // A scoped package's first publish is a 402 without this.
    assert.equal(m.publishConfig?.access, "public", `packages/${pkg} publishes public`);
  }
  for (const pkg of PRIVATE) {
    const m = await manifest(pkg);
    assert.equal(m.private, true, `packages/${pkg} reaches users as a Kit image, not as an npm package`);
  }
});

test("every published package says where it runs and where it comes from", async () => {
  // Every runtime the kit runs in is Node 24 (both Kit Dockerfiles, the instance Dockerfile, the
  // `registerHooks` bin), and a published package is the one place a user's package manager can
  // learn that before an install that would fail later (ADR-0055).
  const { node } = (await manifest("cli")).engines ?? {};
  assert.ok(node, "@jr2/cli declares the Node it runs on");
  for (const pkg of PUBLIC) {
    const m = await manifest(pkg);
    assert.equal(m.engines?.node, node, `packages/${pkg} runs on the same Node as the CLI`);
    assert.ok(m.description, `packages/${pkg} has a description for its npm page`);
    assert.equal(m.repository?.directory, `packages/${pkg}`, `packages/${pkg} points its npm page at its folder`);
    // README and LICENSE are packed whatever `files:` says; they have to exist to be packed.
    for (const file of ["README.md", "LICENSE"]) {
      await access(join(REPO, "packages", pkg, file)).catch(() => {
        assert.fail(`packages/${pkg}/${file} is missing — the tarball's npm page would be empty`);
      });
    }
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

    // And the half nothing downstream can catch: tests are ~460 kB of source in @jr2/orchestrator
    // alone, unpacked into every instance's node_modules and baked into its image.
    assert.ok(!files.includes("test"), `packages/${pkg} does not ship its test tree`);
  }

  // The Console is served from the package at runtime (ADR-0034: `console/` assets, `.ts` sources
  // type-erased on the way out), so nothing in the manifest names it and the derived check above
  // cannot see it. Said explicitly, because an orchestrator that packs no `console/` serves 404s.
  assert.ok((await manifest("orchestrator")).files?.includes("console"), "@jr2/orchestrator ships the Console");
});
