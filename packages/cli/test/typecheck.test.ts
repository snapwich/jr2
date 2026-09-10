// `j2 up`'s Instance typecheck (ADR-0050): the gate that turns a wrong name into a compile error
// instead of an invoke-time failure mid-run. These tests drive the REAL compiler — the gate's whole
// claim is about which compiler runs and what it reads, and a fake would assert neither.
//
// The fixtures are temp folders whose `node_modules/typescript` is a symlink to this repo's, which
// is exactly the resolution the port must perform: an instance's compiler is the one IT installed
// (the scaffold pins it, ADR-0043), never one the CLI happens to carry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tscTypecheck } from "../src/typecheck.ts";

const REPO_TYPESCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "typescript");

/** An instance folder as `j2 init` leaves one: the root marker, a tsconfig, and an installed
 * compiler. `compiler: false` is the folder whose dependencies were never installed. */
async function mkInstance(files: Record<string, string>, opts: { compiler?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "j2-tsc-"));
  await writeFile(join(root, "j2.config.ts"), `export default { name: "t" };\n`);
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

/** The compiler options an instance inherits from `@j2/orchestrator/tsconfig.instance.json`, inline:
 * these fixtures have no kit in `node_modules`, and the claim under test is the gate, not the
 * extends chain (`examples/*` and the `@dist` tier run the real one). */
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
    // Stands in for every name a Machine carries and the compiler now checks (ADR-0049/0050): a
    // slot the Machine does not declare, a `customize()` of an Agent it does not carry, a repo the
    // Register does not know. All of them arrive here as one `tsc` line.
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
