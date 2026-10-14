// Every `@example` on the Authoring surface and on @jr2/machines typechecks (ADR-0072): the
// Reference prints them, and an Assistant copies them, so each is compiled as a module of its own
// against the workspace packages. One program holds them all, which keeps the suite to one
// compiler pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { generateReference, referenceContext, REPO } from "../build/build.ts";
import { allPages, readSitemap } from "../build/sitemap.ts";

const SITE_MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));

// The package a bare specifier names: `@scope/name` or `name`, without a subpath.
const packageOf = (specifier: string): string =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

// The compile below resolves against this package's node_modules, which holds more than an
// Instance does. Under pnpm an Instance imports only what its package.json lists, so an example
// that imports anything else typechecks here and is refused by `jr2 up` there. So each bare import
// is a dependency `jr2 init` scaffolds (templates/default, which init.test holds equal to it), or
// @jr2/machines, which the machines page tells the reader to add.
test("every @example imports only what a scaffolded Instance can import", async () => {
  const { examples } = generateReference(referenceContext(REPO, allPages(await readSitemap())));
  const scaffold = JSON.parse(await readFile(join(REPO, "templates/default/package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const allowed = new Set([...Object.keys(scaffold.dependencies), "@jr2/machines"]);
  const strays = examples.flatMap((e) =>
    ts
      .preProcessFile(e.code, true, true)
      .importedFiles.map((f) => f.fileName)
      .filter((s) => !s.startsWith(".") && !s.startsWith("node:") && !allowed.has(packageOf(s)))
      .map((s) => `${e.page} ${e.name}: ${s}`),
  );
  assert.deepEqual(strays, []);
});

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
