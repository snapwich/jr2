// An Instance has one Kit version (ADR-0056): every Instance verb refuses unless the Instance and
// the CLI resolve the SAME `@jr2/orchestrator` — same real path, never a version compare. The
// refusal names both sides and the line to edit, differently for an Instance that has no `@jr2/cli`
// of its own (add one; the launcher hands off to it) and one that has (pin both at one number).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertKitVersion, CLI_ROOT, CLI_VERSION, resolvePackage } from "../src/kit-version.ts";
import { fakeKit, linkKit } from "./_kit.ts";

async function mkInstance(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jr2-kitver-"));
  await writeFile(join(root, "jr2.config.ts"), "export default {};\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "inst", version: "0.0.0" }));
  return root;
}

test("the CLI's own version is its manifest's, and its orchestrator is the checkout's", () => {
  assert.match(CLI_VERSION, /^\d+\.\d+\.\d+/);
  const own = resolvePackage("@jr2/orchestrator", CLI_ROOT);
  assert.ok(own, "the checkout's CLI resolves its peer through its own node_modules");
  assert.equal(own.version, CLI_VERSION, "one release train: the CLI and its peer carry one number");
});

test("resolvePackage answers the REAL root through a symlink, and undefined when nothing resolves", async () => {
  const root = await mkInstance();
  try {
    assert.equal(resolvePackage("@jr2/orchestrator", root), undefined);
    await linkKit(root);
    const found = resolvePackage("@jr2/orchestrator", root);
    assert.ok(found);
    assert.ok(!found.root.startsWith(root), `resolved through the symlink to the real package, not ${found.root}`);
    assert.equal(found.root, resolvePackage("@jr2/orchestrator", CLI_ROOT)?.root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same copy → passes", async () => {
  const root = await mkInstance();
  try {
    await linkKit(root);
    assert.doesNotThrow(() => assertKitVersion(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no dependencies installed → refuses, and says install", async () => {
  const root = await mkInstance();
  try {
    assert.throws(
      () => assertKitVersion(root),
      (err: Error) => {
        assert.match(err.message, /Kit version mismatch/);
        assert.match(err.message, /does not resolve/);
        assert.match(err.message, /install the Instance's dependencies/);
        assert.match(err.message, new RegExp(`this jr2 \\(${CLI_VERSION.replace(/\./g, "\\.")}\\)`));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("another orchestrator and no local CLI → refuses, and says add @jr2/cli at the Instance's number", async () => {
  const root = await mkInstance();
  try {
    await fakeKit(root, "@jr2/orchestrator", "9.9.9");
    assert.throws(
      () => assertKitVersion(root),
      (err: Error) => {
        assert.match(err.message, /@jr2\/orchestrator resolves to 9\.9\.9/);
        assert.match(err.message, /add "@jr2\/cli": "9\.9\.9" to devDependencies/);
        assert.match(err.message, /the Instance's own jr2 then runs/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("another orchestrator beside a local CLI → refuses, and says pin both at one version", async () => {
  const root = await mkInstance();
  try {
    await fakeKit(root, "@jr2/orchestrator", "9.9.9");
    await fakeKit(root, "@jr2/cli", "9.9.8");
    assert.throws(
      () => assertKitVersion(root),
      (err: Error) => {
        assert.match(err.message, /pin "@jr2\/orchestrator" and "@jr2\/cli" at ONE exact version/);
        assert.doesNotMatch(err.message, /add "@jr2\/cli"/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
