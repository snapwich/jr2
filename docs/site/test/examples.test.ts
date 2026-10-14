// Every `@example` on the Authoring surface and on @jr2/machines typechecks (ADR-0072): the
// Reference prints them, and an Assistant copies them, so each is compiled as a module of its own
// against the workspace packages. One program holds them all, which keeps the suite to one
// compiler pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { generateReference, referenceContext, REPO } from "../build/build.ts";
import { allPages, readSitemap } from "../build/sitemap.ts";

const SITE_MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));

test("every @example on the Authoring surface and on @jr2/machines typechecks", async (t) => {
  const { examples } = generateReference(referenceContext(REPO, allPages(await readSitemap())));
  assert.ok(examples.length > 30, `only ${examples.length} examples`);
  const dir = await mkdtemp(join(tmpdir(), "jr2-examples-"));
  try {
    // The examples import the kit as an Instance does; this package's node_modules holds it.
    await symlink(SITE_MODULES, join(dir, "node_modules"), "dir");
    await writeFile(join(dir, "package.json"), '{ "type": "module" }\n');
    const files: string[] = [];
    const names = new Map<string, string>();
    for (const [i, e] of examples.entries()) {
      const file = join(dir, `${String(i).padStart(2, "0")}-${e.name}.ts`);
      // `export {}` makes each one a module, so two examples may declare the same name.
      await writeFile(file, `${e.code}\nexport {};\n`);
      files.push(file);
      names.set(file, `${e.page} ${e.name}`);
    }
    const started = performance.now();
    const program = ts.createProgram(files, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noUncheckedIndexedAccess: true,
      verbatimModuleSyntax: true,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      noEmit: true,
      types: ["node"],
      typeRoots: [join(SITE_MODULES, "@types")],
    });
    const problems = ts.getPreEmitDiagnostics(program).map((d) => {
      const at = d.file
        ? `${names.get(d.file.fileName) ?? d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}`
        : "";
      return `${at} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    });
    t.diagnostic(`${examples.length} examples typechecked in ${Math.round(performance.now() - started)} ms`);
    assert.deepEqual(problems, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
