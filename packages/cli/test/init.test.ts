// `j2 init` scaffolds a working instance — and keeps mirroring `examples/starter/`, which is the
// model instance the docs point at and the only one anyone actually runs. The templates are inline
// string consts (the CLI ships without `examples/`), so nothing structural stops the two from
// drifting; they already had, before this test existed. So the assertion is byte-equality against
// the real folder, for every scaffolded path except package.json's per-instance `name`/`description`.
//
// It runs the real `init()` into a temp dir rather than reaching into the consts, which makes it the
// only coverage of the scaffold's FILE LIST too — that `tsconfig.json` is written at all, and that a
// fresh instance is typecheckable by construction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "../src/commands/init.ts";
import type { Io } from "../src/output.ts";

const STARTER = fileURLToPath(new URL("../../../examples/starter", import.meta.url));

/** Every path `init` is expected to write. `package.json` is compared separately (it varies). */
const MIRRORED = ["tsconfig.json", "j2.config.ts", ".gitignore", "workflows/ping.ts"];

async function scaffold(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "j2-init-"));
  const io: Io = { stdout: () => {}, stderr: () => {}, env: {}, cwd: dir };
  assert.equal(await init([], io), 0);
  return dir;
}

test("init scaffolds every file examples/starter has, byte-for-byte", async (t) => {
  const dir = await scaffold();
  t.after(() => rm(dir, { recursive: true, force: true }));

  for (const path of MIRRORED) {
    const scaffolded = await readFile(join(dir, path), "utf8");
    const model = await readFile(join(STARTER, path), "utf8");
    assert.equal(scaffolded, model, `${path} has drifted from examples/starter/${path}`);
  }
});

test("init's package.json matches the starter's but for name and description", async (t) => {
  const dir = await scaffold();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const scaffolded = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const model = JSON.parse(await readFile(join(STARTER, "package.json"), "utf8"));

  // The two fields that are legitimately per-instance: `name` defaults to the folder, and only the
  // committed example carries a `description` explaining what it is.
  assert.equal(scaffolded.name, basename(dir));
  delete scaffolded.name;
  delete model.name;
  delete model.description;

  assert.deepEqual(scaffolded, model, "the scaffolded package.json has drifted from examples/starter");
});

test("a scaffolded instance can typecheck: tsconfig extends the base shipped by @j2/orchestrator", async (t) => {
  const dir = await scaffold();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const tsconfig = JSON.parse(await readFile(join(dir, "tsconfig.json"), "utf8"));
  assert.equal(tsconfig.extends, "@j2/orchestrator/tsconfig.instance.json");

  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.typecheck, "tsc --noEmit");
  // `node:` imports in a workflow (and in the orchestrator source the program pulls in) need these.
  assert.ok(pkg.devDependencies["@types/node"]);
});
