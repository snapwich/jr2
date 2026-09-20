// `jr2 init` scaffolds a working instance — and keeps mirroring `templates/default/`, which is the
// model instance the docs point at and the only one anyone actually runs (ADR-0054). The templates
// are inline string consts (the CLI ships without `templates/`), so nothing structural stops the two
// from drifting; they already had, before this test existed. So the assertion is byte-equality
// against the real folder, for every scaffolded path except package.json's per-instance
// `name`/`description`.
//
// It runs the real `init()` into a temp dir rather than reaching into the consts, which makes it the
// only coverage of the scaffold's FILE LIST too — that `tsconfig.json` is written at all, and that a
// fresh instance is typecheckable by construction.
//
// Since the manifest pins @jr2/* at KIT_VERSION (ADR-0043), the package.json comparison is also the
// version-bump tripwire: bumping the kit renders a new literal and fails here until the default
// template is re-rendered to match.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_VERSION } from "@jr2/orchestrator";
import { init } from "../src/commands/init.ts";
import type { Io } from "../src/output.ts";

const TEMPLATE = fileURLToPath(new URL("../../../templates/default", import.meta.url));

/** Every path `init` is expected to write. `package.json` is compared separately (it varies). */
const MIRRORED = [
  "tsconfig.json",
  "jr2.config.ts",
  ".gitignore",
  "workflows/ping.ts",
  // The scaffolded Sandbox Image (ADR-0037): `images/default` is what makes the resolution chain's
  // middle leg a visible convention rather than magic, so it has to be scaffolded to exist at all.
  "images/default/Dockerfile",
];

async function scaffold(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-init-"));
  const io: Io = { stdout: () => {}, stderr: () => {}, env: {}, cwd: dir };
  assert.equal(await init([], io), 0);
  return dir;
}

test("init scaffolds every file templates/default has, byte-for-byte", async (t) => {
  const dir = await scaffold();
  t.after(() => rm(dir, { recursive: true, force: true }));

  for (const path of MIRRORED) {
    const scaffolded = await readFile(join(dir, path), "utf8");
    const model = await readFile(join(TEMPLATE, path), "utf8");
    assert.equal(scaffolded, model, `${path} has drifted from templates/default/${path}`);
  }
});

test("init's package.json matches the default template's but for name and description", async (t) => {
  const dir = await scaffold();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const scaffolded = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const model = JSON.parse(await readFile(join(TEMPLATE, "package.json"), "utf8"));

  // The two fields that are legitimately per-instance: `name` defaults to the folder, and only the
  // committed template carries a `description` explaining what it is.
  assert.equal(scaffolded.name, basename(dir));
  delete scaffolded.name;
  delete model.name;
  delete model.description;

  assert.deepEqual(
    scaffolded,
    model,
    `the scaffolded package.json has drifted from templates/default/package.json — if this kit's ` +
      `version just changed, re-render the template: its @jr2/* deps must read "${KIT_VERSION}" (ADR-0043)`,
  );
});

test("the scaffold pins @jr2/* at the exact kit version — exact, not caret (0.x minors break)", async (t) => {
  const dir = await scaffold();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@jr2/orchestrator"], KIT_VERSION);
  assert.equal(pkg.devDependencies["@jr2/cli"], KIT_VERSION);
  // One template for both modes (ADR-0043): no `workspace:*` only the kit's own workspace resolves,
  // and no `packageManager` field — the scaffold names no package manager.
  assert.equal(pkg.packageManager, undefined);
});

test("a scaffolded instance can typecheck: tsconfig extends the base shipped by @jr2/orchestrator", async (t) => {
  const dir = await scaffold();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const tsconfig = JSON.parse(await readFile(join(dir, "tsconfig.json"), "utf8"));
  assert.equal(tsconfig.extends, "@jr2/orchestrator/tsconfig.instance.json");

  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.typecheck, "tsc --noEmit");
  // `node:` imports in a workflow (and in the orchestrator source the program pulls in) need these.
  assert.ok(pkg.devDependencies["@types/node"]);
  // And the compiler itself — `jr2 up` RUNS it as a converge gate (ADR-0050), so a folder that
  // declares none cannot converge at all. Unpinned, the script names a tool the folder does not
  // declare: in an INSTALLED instance `tsc` then resolves to `@jr2/cli`'s transitive
  // `ts-blank-space` → `typescript`, which floats across majors — the instance checks the kit's
  // own `.ts` sources (zero-build: `exports` point at source) with a compiler the kit never ran.
  // Read back from the kit's OWN range rather than restated, so a kit that moves compilers and
  // leaves the scaffold behind fails here instead of shipping instances checked by a compiler the
  // gate never ran.
  const kit = JSON.parse(await readFile(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"));
  assert.equal(pkg.devDependencies.typescript, kit.devDependencies.typescript);
});
