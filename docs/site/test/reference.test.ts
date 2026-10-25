// The generated Reference covers the code it comes from (ADR-0072): each root export on the
// Authoring surface page, each command-table row on the CLI page, each route on the HTTP page, and
// each `JR2Config` field on the config page. Each list here is read from the code by another road
// than the generator's, so a generator that drops a name fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import * as surface from "@jr2/orchestrator";
import { HTTP_ROUTES } from "@jr2/orchestrator/internal";
import { COMMANDS, nameOf } from "../../../packages/cli/src/command-table.ts";
import { generateReference, referenceContext, REPO } from "../build/build.ts";
import { commandAnchor } from "../build/reference/cli.ts";
import { checkVoice, seeLink, typeDocTail } from "../build/reference/context.ts";
import { firstSentence } from "../build/reference/surface.ts";
import { routeAnchor } from "../build/reference/http-api.ts";
import { allPages, readSitemap } from "../build/sitemap.ts";
import { sourceFile } from "../build/tsdoc.ts";

const ctx = referenceContext(REPO, allPages(await readSitemap()));
const { pages, entries } = generateReference(ctx);
const page = (slug: string) => pages.get(slug) ?? assert.fail(`no page ${slug}`);
const SURFACE = "reference/authoring-surface";
/** The Authoring surface's own page of a name: `type-<name>` for a type, the name for a value. */
const pageOf = (name: string, type = false) => page(`${SURFACE}/${type ? "type-" : ""}${name.toLowerCase()}`);

test("the generators report no error on the real code", () => {
  assert.deepEqual(ctx.errors, []);
});

test("each root export has its own page, and the Authoring surface contents page links to it", async () => {
  const index = await readFile(join(REPO, "packages/orchestrator/src/index.ts"), "utf8");
  const types = [...index.matchAll(/^export type \{([^}]*)\}/gm)].flatMap((m) => m[1]!.split(",").map((s) => s.trim()));
  const values = Object.keys(surface);
  assert.ok(values.length + types.length > 30);
  const contents = page(SURFACE);
  for (const [name, type] of [...values.map((v) => [v, false] as const), ...types.map((t) => [t, true] as const)]) {
    const file = `${type ? "type-" : ""}${name.toLowerCase()}.md`;
    assert.match(pageOf(name, type), /^(?:Function|Constant|Type), in `/, `${name} has no page of its own`);
    assert.ok(
      contents.includes(`- [\`${name}\`](authoring-surface/${file}) (`),
      `the contents page does not list ${name}`,
    );
  }
  // The contents page holds no entry: each name's signature is on its page.
  assert.doesNotMatch(contents, /^```ts$/m);
});

test("the contents page and each entry page are short enough for one read of a file tool", () => {
  // The Authoring surface was one page of about 200 KB, which a file tool cuts off. The contents
  // page gives the first sentence of each TSDoc, which is about 20 KB of lines (ADR-0072).
  const contents = Buffer.byteLength(page(SURFACE));
  assert.ok(contents < 25 * 1024, `the contents page is ${contents} bytes`);
  const list = entries.get(SURFACE) ?? assert.fail("the Authoring surface has no entry pages");
  for (const e of list) {
    const size = Buffer.byteLength(page(e.slug));
    assert.ok(size < 15 * 1024, `${e.slug}.md is ${size} bytes`);
  }
  assert.ok(!entries.has("reference/machines"), "the machines page is short, and stays one page");
});

test("each other Reference page is one page of 64 KB or less", () => {
  // ADR-0072 gives this size. The HTTP API page is the largest, at about 50 KB.
  assert.deepEqual([...entries.keys()], [SURFACE], "only the Authoring surface has entry pages");
  const split = new Set((entries.get(SURFACE) ?? []).map((e) => e.slug));
  for (const [slug, text] of pages) {
    if (slug === SURFACE || split.has(slug)) continue;
    const size = Buffer.byteLength(text);
    assert.ok(size <= 64 * 1024, `${slug}.md is ${size} bytes`);
  }
});

test("the split Authoring surface does not send the reader to a signature on its contents page", () => {
  // The signatures are on the entry pages; the contents page has none.
  const list = entries.get(SURFACE) ?? assert.fail("the Authoring surface has no entry pages");
  for (const slug of [SURFACE, ...list.map((e) => e.slug)])
    assert.doesNotMatch(page(slug).replace(/\s+/g, " "), /A signature (?:above|on the|or a type on the)/, slug);
  assert.match(
    pageOf("BodyAcceptsDoor", true),
    /The signature of an export, or a type that it names, names this type, so its declaration is here\. The \[Authoring surface\]\(\.\.\/authoring-surface\.md\) page lists each export\./,
  );
});

test("no line of the contents page or of an entry page is longer than 1,000 characters", () => {
  // A file tool can cut off a long line, and a list of 60 links on one line is hard to read.
  const list = entries.get(SURFACE) ?? assert.fail("the Authoring surface has no entry pages");
  for (const slug of [SURFACE, ...list.map((e) => e.slug)])
    for (const [i, l] of page(slug).split("\n").entries())
      assert.ok(l.length <= 1000, `${slug}.md:${i + 1} is ${l.length} characters`);
});

test("a contents line is the first sentence of the TSDoc summary, as plain text", () => {
  // A colon does not end the sentence: "An invoke." alone tells nothing.
  assert.equal(
    firstSentence("Make a `command` Effect: an actor slot. It runs."),
    "Make a `command` Effect: an actor slot.",
  );
  assert.equal(firstSentence("An invoke: a lent Agent.\nMore."), "An invoke: a lent Agent.");
  assert.equal(firstSentence("The output `{ a: 1. b }` of x.\nMore."), "The output `{ a: 1. b }` of x.");
  assert.equal(firstSentence("See {@link Size} and [the guide](x.md) now"), "See `Size` and the guide now");
  assert.equal(firstSentence(undefined), undefined);
});

test("each @jr2/machines export is on its page", async () => {
  const machines = await import("@jr2/machines");
  const text = page("reference/machines");
  for (const name of Object.keys(machines)) assert.ok(text.includes(`\n### \`${name}\`\n`), name);
});

test("each field of TaskInput is on the @jr2/machines page, with its TSDoc", async () => {
  // Read from the zod schema the type is inferred from, by its syntax alone.
  const file = join(REPO, "packages/machines/src/task.ts");
  const sf = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
  let door: ts.ObjectLiteralExpression | undefined;
  sf.forEachChild(function find(n) {
    if (
      ts.isVariableDeclaration(n) &&
      n.name.getText() === "door" &&
      n.initializer &&
      ts.isCallExpression(n.initializer)
    )
      door = n.initializer.arguments[0] as ts.ObjectLiteralExpression;
    n.forEachChild(find);
  });
  const props = door!.properties.filter(ts.isPropertyAssignment);
  assert.ok(props.length >= 4);
  const text = page("reference/machines");
  const entry = text.slice(text.indexOf("\n### `TaskInput`\n"), text.indexOf("\n### `TaskOutput`\n"));
  assert.doesNotMatch(entry, /typeof door/);
  for (const p of props) {
    const optional = p.initializer.getText().includes(".optional()");
    const doc = ts.getJSDocCommentsAndTags(p).filter(ts.isJSDoc).at(-1);
    const first = String(doc?.comment ?? "")
      .split("\n")[0]!
      .trim();
    assert.ok(first, `${p.name.getText()} has no TSDoc`);
    assert.ok(entry.includes(`- \`${p.name.getText()}\`${optional ? " (optional)" : ""}: `), p.name.getText());
    assert.ok(entry.includes(first), `the TSDoc of ${p.name.getText()} is not on the page`);
  }
});

test("a union type lists one field list per form, and a kit type a signature names is defined", () => {
  const text = page("reference/machines");
  const entry = text.slice(
    text.indexOf("\n### `TaskOutput`\n"),
    text.indexOf("\n<a id=", text.indexOf("\n### `TaskOutput`\n")),
  );
  assert.match(entry, /\*\*Forms\*\*[\s\S]*- Form 1: `outcome`, `branch`[\s\S]*- Form 2: `outcome`/);
  assert.match(pageOf("EventAudience", true), /^Type, in `/);
  assert.ok(page(SURFACE).includes("- [`EventAudience`](authoring-surface/type-eventaudience.md): "));
});

test("a @see target is a sitemap page or an ADR, and anything else is an error", () => {
  const adr = ctx.adrs[0]!;
  assert.equal(typeof seeLink(ctx, "docs/reference/cli.md", "reference/machines.md"), "string");
  assert.equal(typeof seeLink(ctx, `docs/reference/decisions/${adr.file}`, "reference/machines.md"), "string");
  assert.equal(typeof seeLink(ctx, "@jr2/orchestrator/docs/reference/cli.md", "reference/machines.md"), "string");
  for (const bad of ["docs/guides/nope.md", "docs/reference/decisions/9999-nope.md", "../x.md", "https://x.dev"])
    assert.ok(typeof seeLink(ctx, bad, "reference/machines.md") === "object", bad);
});

test("a type in a Types section shows its @see links", () => {
  assert.ok(
    pageOf("EventAudience", true).includes("](../../concepts/the-menu.md)"),
    "EventAudience does not link to the Menu page",
  );
});

test("on a named type, a bad @see target and a tag the Reference drops are errors at their lines", () => {
  const errors: typeof ctx.errors = [];
  const doc = {
    summary: "A type.",
    file: "packages/orchestrator/src/x.ts",
    line: 3,
    tags: [
      { name: "see", text: "docs/concepts/no-such-page.md", line: 5 },
      { name: "deprecated", text: "gone", line: 6 },
      { name: "see", text: "docs/reference/cli.md", line: 7 },
    ],
  };
  const tail = typeDocTail({ ...ctx, errors }, doc, "reference/http-api.md");
  assert.deepEqual(
    errors.map((e) => `${e.file}:${e.line}`),
    ["packages/orchestrator/src/x.ts:6", "packages/orchestrator/src/x.ts:5"],
  );
  assert.ok(tail.join("\n").includes("](cli.md)"));
});

test("outside @jr2/orchestrator, a @see names the bundle by its package, and a docs/ path is an error", () => {
  const errors: typeof ctx.errors = [];
  const doc = {
    summary: "A type.",
    file: "packages/machines/src/x.ts",
    line: 3,
    tags: [
      { name: "see", text: "docs/reference/cli.md", line: 5 },
      { name: "see", text: "@jr2/orchestrator/docs/reference/cli.md", line: 6 },
    ],
  };
  const tail = typeDocTail({ ...ctx, errors }, doc, "reference/http-api.md");
  assert.deepEqual(
    errors.map((e) => `${e.file}:${e.line}`),
    ["packages/machines/src/x.ts:5"],
  );
  assert.equal(tail.join("\n").split("](cli.md)").length, 3);
});

test("each command-table row is on the CLI page, with its anchor and each of its flags", () => {
  const text = page("reference/cli");
  for (const c of COMMANDS) {
    assert.ok(text.includes(`<a id="${commandAnchor(c)}"></a>\n\n### \`jr2 ${nameOf(c)}\``), nameOf(c));
    for (const f of c.flags) assert.ok(text.includes(`--${f.name}`), `${nameOf(c)} --${f.name}`);
  }
});

test("each HTTP_ROUTES row is on the HTTP page, and each type it names is defined there", () => {
  const text = page("reference/http-api");
  for (const r of HTTP_ROUTES)
    assert.ok(
      text.includes(`<a id="${routeAnchor(r)}"></a>\n\n### \`${r.method} ${r.path}\``),
      `${r.method} ${r.path}`,
    );
  for (const m of text.matchAll(/\]\(#(type-[a-z0-9-]+)\)/g))
    assert.ok(text.includes(`<a id="${m[1]}">`), `#${m[1]} is not on the page`);
  for (const name of ["RunStatus", "GateView", "MachineDoc", "AgentSurfaceView"])
    assert.ok(text.includes(`\n### \`${name}\`\n`), name);
});

test("each JR2Config field, nested, is on the config page", () => {
  const { checker } = ctx.program;
  const config = sourceFile(ctx.program, "packages/orchestrator/src/config.ts");
  const decl = config.statements.find(
    (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === "JR2Config",
  )!;
  const text = page("reference/config");
  const visit = (type: ts.Type, path: string, depth: number) => {
    if (depth > 6) return;
    type = checker.getNonNullableType(type);
    if (checker.isArrayType(type))
      return visit(checker.getTypeArguments(type as ts.TypeReference)[0]!, `${path}[]`, depth);
    const index = type.getStringIndexType();
    if (index && type.getProperties().length === 0) return visit(index, `${path}.<name>`, depth);
    if (type.isUnion() && type.types.every((t) => t.flags & ts.TypeFlags.Object)) {
      // One of several objects: its fields are listed inside the field, by name.
      for (const t of type.types)
        for (const p of t.getProperties()) assert.ok(text.includes(`\`${p.name}\``), `${path}: ${p.name}`);
      return;
    }
    if (!(type.flags & ts.TypeFlags.Object) || type.getCallSignatures().length) return;
    const props = type.getProperties();
    // A type the Authoring surface documents (Size) is linked, not opened.
    if (depth > 0 && type.aliasSymbol && ctx.names.get(type.aliasSymbol.name)?.page.startsWith(`${SURFACE}/`)) return;
    for (const p of props) {
      const child = path ? `${path}.${p.name}` : p.name;
      assert.ok(text.includes(`\`${child}\`\n`), `${child} is not on the page`);
      visit(checker.getTypeOfSymbol(p), child, depth + 1);
    }
  };
  visit(checker.getTypeAtLocation(decl.name), "", 0);
});

test("each kit type that a signature or a field on a surface page shows has an anchor on a Reference page", () => {
  // The names the kit's own sources declare as types, read from every file of the program.
  const kit = new Set<string>();
  for (const sf of ctx.program.program.getSourceFiles()) {
    const file = sf.fileName.slice(REPO.length);
    if (!file.startsWith("packages/") || file.includes("node_modules")) continue;
    for (const s of sf.statements)
      if (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) kit.add(s.name.text);
  }
  const anchors = new Set(
    [...pages.values()].flatMap((t) => [...t.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]!)),
  );
  // The Authoring surface is its entry pages; the machines page is one page.
  const surfacePages = (entries.get(SURFACE) ?? []).map((e) => page(e.slug));
  for (const [slug, texts] of [
    [SURFACE, surfacePages],
    ["reference/machines", [page("reference/machines")]],
  ] as const) {
    // The type plumbing is shown as its declarations alone; what those name is the kit's machinery.
    // An example is the author's own code, with its own type names.
    const text = texts
      .filter((t) => !t.includes("It is type plumbing"))
      .map((t) => t.split("**Type plumbing.**")[0]!)
      .join("\n")
      .replace(/\*\*Example\*\*\n\n```ts\n[\s\S]*?^```$/gm, "");
    const shown = [
      ...[...text.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((m) => m[1]!),
      ...[...text.matchAll(/^\s*- `[^`]+`(?: \(optional\))?: (?:\[`([^`]+)`\]\([^)]*\)|`([^`]+)`)$/gm)].map(
        (m) => m[1] ?? m[2]!,
      ),
    ];
    const names = new Set(shown.flatMap((s) => [...s.matchAll(/\b[A-Z][A-Za-z0-9]*\b/g)].map((m) => m[0])));
    for (const name of names) {
      if (!kit.has(name)) continue;
      assert.ok(
        ctx.names.has(name) || anchors.has(`type-${name.toLowerCase()}`),
        `${slug} shows the kit type ${name}, and no Reference page defines it`,
      );
    }
  }
});

test("the TSDoc a Reference page shows names no repo path and no commit", () => {
  const errors: typeof ctx.errors = [];
  checkVoice(
    { ...ctx, errors },
    {
      summary: "Reads `ambient.ts` (the baba71f incident), see test/door-types.test.ts.",
      tags: [
        { name: "remarks", text: "Set it in jr2.config.ts, and read AGENTS.md.", line: 4 },
        { name: "example", text: "```ts\nimport x from './x.ts';\n```", line: 5 },
        { name: "see", text: "docs/concepts/effects.md", line: 8 },
      ],
      file: "packages/x/src/x.ts",
      line: 2,
    },
  );
  assert.deepEqual(
    errors.map((e) => `${e.line}: ${/names (\S+),/.exec(e.message)?.[1]}`),
    ["2: ambient.ts", "2: test/door-types.test.ts", "2: baba71f"],
  );
});

test("a type marked @internal is listed with its declaration alone", () => {
  const contents = page(SURFACE);
  const plumbing = contents.slice(contents.indexOf("**Type plumbing.**"));
  assert.ok(plumbing.includes("[`BodyAcceptsDoor`](authoring-surface/type-bodyacceptsdoor.md)"), "it is not listed");
  // Its page is the line that says what it is, and its declaration: no TSDoc, no fields.
  const own = pageOf("BodyAcceptsDoor", true);
  assert.match(own, /^Type, in `[^`]+`\. It is type plumbing: [^\n]*\n\n```ts\n[\s\S]*\n```\n$/);
  for (const e of entries.get(SURFACE) ?? []) assert.doesNotMatch(page(e.slug), /door-types\.test\.ts|claim 1/);
});
