// The source format's directives become plain Markdown in the bundle (ADR-0072): each kind, on a
// small fixture, and each way a directive can be malformed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertDirectives, generatorSyntax, headingOnes } from "../build/directives.ts";

const dir = await mkdtemp(join(tmpdir(), "jr2-directives-"));
test.after(() => rm(dir, { recursive: true, force: true }));
await writeFile(join(dir, "fix.ts"), 'import { z } from "zod";\n\nexport function fix() {\n  return 1;\n}\n');

const convert = (text: string) => convertDirectives(text, { file: "docs/site/page.md", dir, repo: dir });
const ok = (text: string) => {
  const r = convert(text);
  assert.deepEqual(r.errors, []);
  return r.text;
};

test("an aside is a blockquote whose first line is its bold kind", () => {
  for (const [kind, label] of [
    ["note", "Note"],
    ["tip", "Tip"],
    ["caution", "Caution"],
    ["danger", "Danger"],
  ]) {
    assert.equal(
      ok(`Before.\n\n:::${kind}\n\nRead this.\n\nAnd this.\n\n:::\n\nAfter.`),
      `Before.\n\n> **${label}**\n>\n> Read this.\n>\n> And this.\n\nAfter.`,
    );
  }
});

test("tabs are a bold label line, then the tab's content, for each tab", () => {
  const text = [
    "::::tabs",
    "",
    ':::tab{label="Anthropic"}',
    "",
    "Text for Anthropic.",
    "",
    ":::",
    "",
    ':::tab{label="Local"}',
    "",
    "```sh",
    "jr2 up",
    "```",
    "",
    ":::",
    "",
    "::::",
  ].join("\n");
  assert.equal(ok(text), "**Anthropic**\n\nText for Anthropic.\n\n**Local**\n\n```sh\njr2 up\n```");
});

test("an aside inside a tab nests", () => {
  const text = '::::tabs\n\n:::tab{label="A"}\n\n:::tip\n\nHi.\n\n:::\n\n:::\n\n::::';
  assert.equal(ok(text), "**A**\n\n> **Tip**\n>\n> Hi.");
});

test("::include is a fenced block of the file, or of its lines, its language from the extension", () => {
  assert.equal(
    ok('::include{file="./fix.ts"}'),
    '```ts\nimport { z } from "zod";\n\nexport function fix() {\n  return 1;\n}\n```',
  );
  assert.equal(ok('::include{file="./fix.ts" lines="4-4"}'), "```ts\nreturn 1;\n```");
  assert.equal(ok('::include{file="./fix.ts" lines="3"}'), "```ts\nexport function fix() {\n```");
});

test("an include whose text holds a fence gets a longer fence", async () => {
  await writeFile(join(dir, "doc.md"), "```ts\nx\n```\n");
  assert.equal(ok('::include{file="./doc.md"}'), "````md\n```ts\nx\n```\n````");
});

test("a mermaid fence, and a directive inside any fence, stay as they are", () => {
  const text = "```mermaid\nflowchart LR\n  a --> b\n```\n\n```md\n:::note\n\n:::\n```";
  assert.equal(ok(text), text);
});

test("an include of a missing file, or of lines outside it, fails", () => {
  assert.match(convert('::include{file="./nope.ts"}').errors[0]!.message, /names nope\.ts, which does not exist/);
  const r = convert('Text.\n\n::include{file="./fix.ts" lines="4-9"}');
  assert.equal(r.errors[0]!.line, 3);
  assert.match(r.errors[0]!.message, /lines="4-9" is outside fix\.ts, which has 5 lines/);
});

test("a directive that is not closed, closes nothing, or is misspelled fails, with its line", () => {
  assert.deepEqual(
    convert("Text.\n\n:::note\n\nOpen.").errors.map((e) => [e.line, e.message]),
    [[3, ":::note is not closed"]],
  );
  assert.match(convert(":::").errors[0]!.message, /::: closes nothing/);
  assert.match(convert("::: tip").errors[0]!.message, /not a directive: "::: tip"/);
  assert.match(convert(':::tab{label="A"}\n\n:::').errors[0]!.message, /:::tab is only inside ::::tabs/);
  assert.match(convert("::::tabs\n\nText.\n\n::::").errors[0]!.message, /only :::tab blocks and empty lines/);
  assert.match(convert("::::tabs\n\n::::").errors[0]!.message, /::::tabs holds no :::tab/);
  assert.match(convert("  :::note\n\n:::").errors[0]!.message, /a directive starts at column 0/);
});

test("a directive line needs an empty line on each side, as prettier would join it otherwise", () => {
  const r = convert("Text.\n:::note\n\nHi.\n\n:::");
  assert.equal(r.errors[0]!.line, 2);
  assert.match(r.errors[0]!.message, /needs an empty line before it and after it/);
});

test("generator syntax in prose fails; the same text in code passes", () => {
  const text = [
    "Hello {{ name }}.",
    "<Tabs>",
    "",
    "import x from './x.md'",
    "<<< @/examples/fix.ts",
    "`{{ fine }}` and `<Tabs>` in code.",
    "```vue",
    "{{ fine }}",
    "<Tabs>",
    "```",
  ].join("\n");
  assert.deepEqual(
    generatorSyntax(text, "p.md").map((e) => e.line),
    [1, 2, 4, 5],
  );
});

test("a wrapped prose line that starts with the verb import or export passes", () => {
  const text = ["A workflow module must", "import only the names it needs, and", "export its Machine."].join("\n");
  assert.deepEqual(generatorSyntax(text, "p.md"), []);
  assert.deepEqual(
    generatorSyntax(`${text}\n\nexport const x = 1`, "p.md").map((e) => e.line),
    [5],
  );
});

test("a source page has no H1", () => {
  assert.deepEqual(
    headingOnes("## Fine\n\n```sh\n# a comment\n```\n\n# Not fine", "p.md", 5).map((e) => e.line),
    [11],
  );
});
