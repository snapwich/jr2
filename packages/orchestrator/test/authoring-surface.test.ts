// The Authoring surface (GLOSSARY.md, ADR-0015, ADR-0072) is the root's export list, and this test pins it.
// A name joins or leaves the surface only in a change that edits the list below, so a reviewer sees
// each one. The rule for the list: a name is on the surface when an author writes it in a workflow
// module or in `jr2.config.ts`; everything else the kit shares goes through
// `@jr2/orchestrator/internal`.
//
// Types erase, so the runtime check cannot see them. They are pinned from the source instead: with
// no `export *` in index.ts, every type on the surface is a specifier there, and the specifiers are
// compared with a list, as the values are.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import * as surface from "../src/index.ts";

const SURFACE_VALUES = [
  "agent",
  "answer",
  "arg",
  "basic",
  "bearer",
  "chartSchema",
  "chartSchemaFor",
  "command",
  "customize",
  "defineConfig",
  "defineEvent",
  "dispatch",
  "fail",
  "file",
  "fromPick",
  "http",
  "isFailure",
  "jr2Setup",
  "open",
  "openBody",
  "paramsOf",
  "pool",
  "push",
  "secret",
  "sentBy",
  "source",
  "text",
  "workspace",
];

const SURFACE_TYPES = [
  "AgentDefinition",
  "Binding",
  "CommandOutput",
  "Customize",
  "DispatchOutput",
  "EffectBinding",
  "HostInjectedInput",
  "HttpOutput",
  "JR2Config",
  "OpenBodyDeclaration",
  "OpenBodyOutput",
  "PushOutput",
  "RepoSlot",
  "Size",
  "ThinkingLevel",
  "UserContainer",
  "Workspaced",
];

/** The code of index.ts, without its comments: comments may say `export *`; code may not. */
async function indexCode(): Promise<string> {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("the root names each export: index.ts has no `export *`", async () => {
  assert.doesNotMatch(await indexCode(), /export\s+(type\s+)?\*/);
});

test("the root's type exports are exactly the Authoring surface's types", async () => {
  const types: string[] = [];
  for (const [, typeOnly, list = ""] of (await indexCode()).matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    const specifiers = list.split(",").map((s) => s.trim());
    for (const raw of specifiers.filter(Boolean)) {
      const inline = /^type\s+/.test(raw);
      if (!typeOnly && !inline) continue;
      // `A as B` exports B.
      types.push(
        raw
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop()!,
      );
    }
  }
  assert.deepEqual(SURFACE_TYPES, [...SURFACE_TYPES].sort(), "keep the list sorted");
  assert.deepEqual(types.sort(), SURFACE_TYPES);
});

test("the root's runtime exports are exactly the Authoring surface's values", () => {
  assert.deepEqual(SURFACE_VALUES, [...SURFACE_VALUES].sort(), "keep the list sorted");
  assert.deepEqual(Object.keys(surface).sort(), SURFACE_VALUES);
});

// What the kit ships for authors, and each Instance-shaped folder in the repo, is written as an
// author writes: against the root only (ADR-0015).
const AUTHOR_FOLDERS = [
  "packages/machines/src",
  "templates/default",
  "docs/intro/instance",
  "features/kind-instance",
  "features/model-instance",
  // The code that the docs pages show (ADR-0072): an Instance can import only the root.
  "docs/site/examples",
];

/** The source files under `dir`, outside node_modules (its links loop through the workspace). */
async function sourcesUnder(dir: URL, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(new URL(rel, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = `${rel}${entry.name}`;
    if (entry.isDirectory()) out.push(...(await sourcesUnder(dir, `${path}/`)));
    else if (/\.(ts|mts|js|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

test("the Machines the kit ships and the Instance-shaped folders import the root only", async () => {
  const repo = new URL("../../../", import.meta.url);
  for (const folder of AUTHOR_FOLDERS) {
    const dir = new URL(`${folder}/`, repo);
    const sources = await sourcesUnder(dir);
    assert.ok(sources.length > 0, `${folder}: no source files`);
    for (const file of sources) {
      const text = await readFile(new URL(file, dir), "utf8");
      assert.doesNotMatch(text, /["']@jr2\/orchestrator\/[^"']+["']/, `${folder}/${file}: imports past the root`);
    }
  }
});
