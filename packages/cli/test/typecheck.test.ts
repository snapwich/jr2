// `jr2 up`'s Instance typecheck (ADR-0050): the gate that turns a wrong name into a compile error
// instead of an invoke-time failure mid-run. These tests drive the REAL compiler — the gate's whole
// claim is about which compiler runs and what it reads, and a fake would assert neither.
//
// The fixtures are temp folders whose `node_modules/typescript` is a symlink to this repo's, which
// is exactly the resolution the port must perform: an instance's compiler is the one IT installed
// (the scaffold pins it, ADR-0043), never one the CLI happens to carry.
//
// The last tests are the ones that gate the PROGRAM rather than the port: an instance staged as
// npm leaves one — `@jr2/orchestrator` as its `files:` list with no `node_modules` of its own, its
// runtime dependencies flat beside it, and the real `tsconfig.instance.json` extends chain. The
// checkout hides the class of failure it catches, because pnpm links the kit's packages to each
// other and an instance here resolves the orchestrator's own devDependencies through that link.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tscTypecheck } from "../src/typecheck.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO_TYPESCRIPT = join(REPO, "node_modules", "typescript");
const ORCHESTRATOR = join(REPO, "packages", "orchestrator");

/** An instance folder as `jr2 init` leaves one: the root marker, a tsconfig, and an installed
 * compiler. `compiler: false` is the folder whose dependencies were never installed. */
async function mkInstance(files: Record<string, string>, opts: { compiler?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jr2-tsc-"));
  await writeFile(join(root, "jr2.config.ts"), `export default { name: "t" };\n`);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  if (opts.compiler !== false) {
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(REPO_TYPESCRIPT, join(root, "node_modules", "typescript"), "dir");
  }
  return root;
}

/** The compiler options an instance inherits from `@jr2/orchestrator/tsconfig.instance.json`, inline:
 * these fixtures have no kit in `node_modules`, and the claim they test is the port's — which
 * compiler runs, and what it does with the two answers. The extends chain and the kit's own sources
 * are the last test's subject. */
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true },
  include: ["**/*.ts"],
});

test("a folder that compiles passes, and says nothing", async () => {
  const root = await mkInstance({
    "tsconfig.json": TSCONFIG,
    "workflows/ping.ts": `export const machine: string = "ping";\n`,
  });

  assert.deepEqual(await tscTypecheck(root), { ok: true, output: "" });
});

test("a type error is the answer, with the compiler's own line — the gate reports, it does not judge", async () => {
  const root = await mkInstance({
    "tsconfig.json": TSCONFIG,
    // Stands in for every name a Machine carries and the compiler now checks (ADR-0049): a slot the
    // Machine does not declare, a `customize()` of an Agent it does not carry. Both arrive here as
    // one `tsc` line.
    "workflows/ping.ts": `export const machine: number = "not a machine";\n`,
  });

  const result = await tscTypecheck(root);
  assert.equal(result.ok, false);
  assert.match(result.output, /workflows\/ping\.ts\(1,14\): error TS2322/);
  const ansi = new RegExp(String.fromCharCode(27));
  assert.ok(!ansi.test(result.output), "relayed, not drawn — `--pretty false` survives a pipe and a CI log");
});

test("every file in the folder is checked, not just the one an entrypoint imports", async () => {
  // The instance's tsconfig includes `**/*.ts`, so a Machine nothing registers yet is still checked.
  const root = await mkInstance({
    "tsconfig.json": TSCONFIG,
    "workflows/ping.ts": `export const machine: string = "ping";\n`,
    "workflows/_shared.ts": `export const broken: string = 1;\n`,
  });

  assert.match((await tscTypecheck(root)).output, /_shared\.ts.*TS2322/);
});

test("no compiler in the instance: the refusal names the install, not the missing module", async () => {
  const root = await mkInstance({ "tsconfig.json": TSCONFIG }, { compiler: false });

  await assert.rejects(tscTypecheck(root), /compiler is missing.*install its dependencies/s);
});

test("no tsconfig.json: the refusal names the file the scaffold writes", async () => {
  const root = await mkInstance({ "workflows/ping.ts": "export const machine = 1;\n" });

  await assert.rejects(tscTypecheck(root), /no tsconfig\.json/);
});

/** An instance as npm leaves one, staged from this checkout (ADR-0043's installed shape).
 *
 * Faithful in the one way that matters: `node_modules/@jr2/orchestrator` is a COPY of the package's
 * `files:` list with no `node_modules` of its own, and only its declared `dependencies` sit beside
 * it. So a kit source reaching for a devDependency — `@jr2/harness`, which is private and never
 * published (ADR-0009/0043) — is `Cannot find module` here and nowhere else in the default gate.
 */
async function mkInstalledInstance(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(ORCHESTRATOR, "package.json"), "utf8")) as {
    files: string[];
    dependencies: Record<string, string>;
  };
  const root = await mkdtemp(join(tmpdir(), "jr2-installed-"));
  const modules = join(root, "node_modules");

  const orchestrator = join(modules, "@jr2", "orchestrator");
  await mkdir(orchestrator, { recursive: true });
  for (const entry of pkg.files) await cp(join(ORCHESTRATOR, entry), join(orchestrator, entry), { recursive: true });
  await writeFile(join(orchestrator, "package.json"), JSON.stringify({ ...pkg, devDependencies: undefined }));

  // Flat-hoisted, as npm and pnpm's default public hoisting both leave them. Each is the link the
  // workspace already resolved, so the versions under test are the versions that ship.
  for (const dep of [...Object.keys(pkg.dependencies), "@types/node"]) {
    await mkdir(join(modules, dirname(dep)), { recursive: true });
    await symlink(join(ORCHESTRATOR, "node_modules", dep), join(modules, dep), "dir");
  }
  await symlink(REPO_TYPESCRIPT, join(modules, "typescript"), "dir");

  // What `jr2 init` scaffolds, verbatim in shape: an ESM package, the real extends chain, and one
  // workflow that imports the kit — which is what pulls @jr2/orchestrator's sources into the program.
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "staged", private: true, type: "module" }));
  await writeFile(
    join(root, "tsconfig.json"),
    `{ "extends": "@jr2/orchestrator/tsconfig.instance.json", "include": ["**/*.ts"] }`,
  );
  // The config imports the kit by BARE specifier, so this is also where "does the package resolve
  // the way npm laid it out?" is answered; in the checkout it resolves through a pnpm link instead.
  await writeFile(
    join(root, "jr2.config.ts"),
    `import { defineConfig } from "@jr2/orchestrator";\n` +
      `export default defineConfig({ git: { credentials: [{ match: "*", token: "JR2_GIT_TOKEN" }] } });\n`,
  );
  await mkdir(join(root, "workflows"), { recursive: true });
  await writeFile(
    join(root, "workflows", "ping.ts"),
    `import { jr2Setup } from "@jr2/orchestrator";\n` +
      `export const machine = jr2Setup({ events: [] }).createMachine({\n` +
      `  id: "ping",\n  initial: "done",\n  states: { done: { type: "final" } },\n});\n`,
  );
  return root;
}

/** A packaged `workspace()` that leaves its one Repo Slot OPEN (`_pkg.ts` — imported, never
 * registered), and a registered Workflow that binds it with `customize()` under `slot` — the
 * consumer's move (ADR-0051), and the seat the wrapper's `JR2Repos` phantom types. */
async function writeCustomizeBinding(root: string, slot: string): Promise<void> {
  await writeFile(
    join(root, "workflows", "_pkg.ts"),
    `import { jr2Setup, open, workspace } from "@jr2/orchestrator";\n` +
      `const body = jr2Setup({ events: [] }).createMachine({\n` +
      `  id: "body",\n  initial: "done",\n  states: { done: { type: "final" } },\n});\n` +
      `export const codeReview = workspace(body, { repos: { target: open }, spec: () => ({ branch: "b" }) });\n`,
  );
  await writeFile(
    join(root, "workflows", "work.ts"),
    `import { customize } from "@jr2/orchestrator";\n` +
      `import { codeReview } from "./_pkg.ts";\n` +
      `export const machine = customize(codeReview, { repos: { ${slot}: "https://example.test/app.git" } });\n`,
  );
}

test("an instance staged as npm installs it typechecks — the kit's own sources included", async () => {
  // The gate is a converge REFUSAL (ADR-0050), so a published source that cannot compile in an
  // installed folder is `jr2 up` returning 1 for every user, on `jr2 init` → `npm i` → `jr2 up`. The
  // checkout cannot see it: pnpm links @jr2/orchestrator to `packages/orchestrator`, whose own
  // `node_modules` holds the devDependencies the published tarball leaves behind.
  const root = await mkInstalledInstance();

  assert.deepEqual(await tscTypecheck(root), { ok: true, output: "" });
});

test("a customize() of an undeclared Repo Slot is what the gate refuses, in an INSTALLED instance (ADR-0051)", async () => {
  // The whole claim in one folder, laid out the way npm lays it out: the slots a `workspace()`
  // declared ride its type as a phantom, read through the wrapper the way its Agents are, so a
  // consumer binding a slot the package never declared stops at `tsc` — before anything is built.
  // Both directions, so the refusal cannot be an artifact of the folder failing to compile for
  // some other reason.
  const root = await mkInstalledInstance();

  await writeCustomizeBinding(root, "target");
  assert.deepEqual(await tscTypecheck(root), { ok: true, output: "" }, "the declared slot binds");

  await writeCustomizeBinding(root, "taregt");
  const typoed = await tscTypecheck(root);
  assert.equal(typoed.ok, false, "a slot the Machine does not declare refuses before anything is built");
  assert.match(typoed.output, /workflows\/work\.ts/, "and it names the file the author must fix");
  assert.match(typoed.output, /'taregt'/, "quoting the key it could not place");
});
