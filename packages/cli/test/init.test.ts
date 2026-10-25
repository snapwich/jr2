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
// `AGENTS.md` is mirrored with the text between its markers taken out: init fills the block from the
// docs bundle when it can read one (ADR-0072), the bundle is generated, and nothing generated is
// committed, so the template holds the markers empty.
//
// Since the manifest pins @jr2/* at KIT_VERSION (ADR-0043), the package.json comparison is also the
// version-bump tripwire: bumping the kit renders a new literal and fails here until the default
// template is re-rendered to match.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_VERSION } from "@jr2/orchestrator/internal";
import { init, scaffoldBlock } from "../src/commands/init.ts";
import { BEGIN_MARKER, END_MARKER, rewriteAgentsBlock, scaffoldAgentsMd } from "../src/agents-md.ts";
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
  // Claude Code reads AGENTS.md only when no CLAUDE.md exists, so this one imports it (ADR-0072).
  "CLAUDE.md",
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

test("init's AGENTS.md is the default template's with the block between the markers taken out", async (t) => {
  const dir = await scaffold();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const scaffolded = await readFile(join(dir, "AGENTS.md"), "utf8");
  const model = await readFile(join(TEMPLATE, "AGENTS.md"), "utf8");
  // The template's own markers are empty: generated text is never committed in templates/.
  assert.deepEqual(rewriteAgentsBlock(model, ""), { kind: "current" }, "templates/default/AGENTS.md holds a block");
  const emptied = rewriteAgentsBlock(scaffolded, "");
  const outside = emptied.kind === "updated" ? emptied.text : scaffolded;
  assert.equal(outside, model, "AGENTS.md has drifted from templates/default/AGENTS.md outside the markers");
  // Room for the user's own text: the END marker is the last line.
  assert.ok(model.endsWith(`${END_MARKER}\n`));
  assert.ok(model.indexOf(BEGIN_MARKER) > 0, "a line outside the markers says who writes them");
});

test("init fills the block only from a peer at the exact version it pins", async (t) => {
  const kit = await mkdtemp(join(tmpdir(), "jr2-init-kit-"));
  t.after(() => rm(kit, { recursive: true, force: true }));
  // No bundle (a checkout before docs:build): nothing between the markers.
  assert.equal(scaffoldBlock({ root: kit, version: "0.9.0" }, "0.9.0"), undefined);
  await mkdir(join(kit, "docs"));
  await writeFile(join(kit, "docs", "agents-block.md"), "the index\n");
  assert.equal(scaffoldBlock({ root: kit, version: "0.9.0" }, "0.9.0"), "the index\n");
  // A peer at another version would index docs the pinned Kit does not ship.
  assert.equal(scaffoldBlock({ root: kit, version: "0.8.0" }, "0.9.0"), undefined);
  assert.equal(scaffoldBlock(undefined, "0.9.0"), undefined);
  assert.equal(scaffoldAgentsMd("the index\n").includes(`${BEGIN_MARKER}\nthe index\n${END_MARKER}\n`), true);
});

test("init leaves a user's own AGENTS.md and CLAUDE.md alone, and says what keeps the docs index from an Assistant", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jr2-init-own-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "AGENTS.md"), "# My rules\n");
  await writeFile(join(dir, "CLAUDE.md"), "Be brief.\n");
  const lines: string[] = [];
  const io: Io = { stdout: () => {}, stderr: (l) => lines.push(l), env: {}, cwd: dir };
  assert.equal(await init([], io), 0);
  assert.equal(await readFile(join(dir, "AGENTS.md"), "utf8"), "# My rules\n");
  assert.equal(await readFile(join(dir, "CLAUDE.md"), "utf8"), "Be brief.\n");
  const text = lines.join("");
  assert.match(
    text,
    /skip {3}AGENTS\.md \(exists\)\n {9}AGENTS\.md has no jr2-docs markers: add the lines <!-- BEGIN:jr2-docs --> and <!-- END:jr2-docs -->, and jr2 up fills them/,
  );
  assert.match(
    text,
    /skip {3}CLAUDE\.md \(exists\)\n {9}CLAUDE\.md does not import AGENTS\.md: add the line @AGENTS\.md, so that Claude Code reads it/,
  );

  // A file that already does both gets no hint.
  await writeFile(join(dir, "AGENTS.md"), scaffoldAgentsMd());
  await writeFile(join(dir, "CLAUDE.md"), "Be brief.\n@AGENTS.md\n");
  lines.length = 0;
  assert.equal(await init([], io), 0);
  assert.doesNotMatch(lines.join(""), /markers:|does not import/);
});

test("init leaves an AGENTS.md with a broken marker pair alone, and says that jr2 up does not update it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jr2-init-broken-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const own = `# My rules\n${END_MARKER}\n`;
  await writeFile(join(dir, "AGENTS.md"), own);
  const lines: string[] = [];
  const io: Io = { stdout: () => {}, stderr: (l) => lines.push(l), env: {}, cwd: dir };
  assert.equal(await init([], io), 0);
  assert.equal(await readFile(join(dir, "AGENTS.md"), "utf8"), own);
  const text = lines.join("");
  const skip = text.indexOf("skip   AGENTS.md (exists)\n");
  assert.ok(skip >= 0, text);
  const next = text.slice(skip).split("\n")[1];
  assert.equal(
    next?.trim(),
    "AGENTS.md: <!-- END:jr2-docs --> has no <!-- BEGIN:jr2-docs --> before it, so jr2 up does not update the jr2 block",
  );
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
  // And the check of `jr2 up` with no cluster (ADR-0050): the typecheck plus the load of each module.
  assert.equal(pkg.scripts.check, "jr2 check");
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
