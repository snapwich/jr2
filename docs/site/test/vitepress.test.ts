// The source format's VitePress syntax becomes plain Markdown in the bundle (ADR-0072): each form,
// on a small fixture, and each way a form can be malformed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generatorSyntax,
  headingOnes,
  regionOf,
  toPlainMarkdown,
  vueSafe,
  withoutRegions,
} from "../build/vitepress.ts";

const site = await mkdtemp(join(tmpdir(), "jr2-vitepress-"));
test.after(() => rm(site, { recursive: true, force: true }));
await mkdir(join(site, "examples"), { recursive: true });
await writeFile(join(site, "examples/fix.ts"), 'import { z } from "zod";\n\nexport function fix() {\n  return 1;\n}\n');
await writeFile(
  join(site, "examples/regions.ts"),
  [
    "// #region imports",
    'import { z } from "zod";',
    "// #endregion imports",
    "",
    "export const states = {",
    "  // #region working",
    "  working: {",
    "    // #region inner",
    "    on: {},",
    "    // #endregion inner",
    "  },",
    "  // #endregion working",
    "};",
    "",
  ].join("\n"),
);
await writeFile(join(site, "examples/Dockerfile"), "FROM node:24\n");

const convert = (text: string) => toPlainMarkdown(text, { file: "docs/site/page.md", site, repo: site });
const ok = (text: string) => {
  const r = convert(text);
  assert.deepEqual(r.errors, []);
  return r.text;
};

test("an aside is a blockquote whose first line is its bold label", () => {
  for (const [kind, label] of [
    ["info", "Note"],
    ["tip", "Tip"],
    ["warning", "Caution"],
    ["danger", "Danger"],
  ]) {
    assert.equal(
      ok(`Before.\n\n::: ${kind}\n\nRead this.\n\nAnd this.\n\n:::\n\nAfter.`),
      `Before.\n\n> **${label}**\n>\n> Read this.\n>\n> And this.\n\nAfter.`,
    );
  }
});

test("tabs are a bold label line, then the tab's content, for each tab", () => {
  const text = [
    "::: tabs key:provider",
    "",
    "== Anthropic",
    "",
    "Text for Anthropic.",
    "",
    "== Local",
    "",
    "```sh",
    "jr2 up",
    "```",
    "",
    ":::",
  ].join("\n");
  assert.equal(ok(text), "**Anthropic**\n\nText for Anthropic.\n\n**Local**\n\n```sh\njr2 up\n```");
});

test("a code group is a bold label line, then the fence without its title, for each fence", () => {
  const text = [
    "::: code-group",
    "",
    "```sh [npm]",
    "npm install",
    "```",
    "",
    "<<< @/examples/fix.ts [pnpm]",
    "",
    ":::",
  ].join("\n");
  assert.equal(
    ok(text),
    '**npm**\n\n```sh\nnpm install\n```\n\n**pnpm**\n\n```ts\nimport { z } from "zod";\n\nexport function fix() {\n  return 1;\n}\n```',
  );
});

test("an aside inside tabs nests, when the tabs have more colons", () => {
  const text = ":::: tabs key:provider\n\n== A\n\n::: tip\n\nHi.\n\n:::\n\n::::";
  assert.equal(ok(text), "**A**\n\n> **Tip**\n>\n> Hi.");
});

test("a container inside another with as many colons fails, as VitePress would close the outer one there", () => {
  const r = convert("::: tabs key:provider\n\n== A\n\n::: tip\n\nHi.\n\n:::\n\n:::");
  assert.match(r.errors[0]!.message, /fewer colons than it/);
});

test("<<< is a fenced block of the file, or of its region, its language from {lang} or the extension", () => {
  assert.equal(
    ok("<<< @/examples/fix.ts"),
    '```ts\nimport { z } from "zod";\n\nexport function fix() {\n  return 1;\n}\n```',
  );
  assert.equal(ok("<<< @/examples/regions.ts#imports"), '```ts\nimport { z } from "zod";\n```');
  assert.equal(ok("<<< @/examples/regions.ts#working"), "```ts\nworking: {\n  on: {},\n},\n```");
  assert.equal(ok("<<< @/examples/Dockerfile{dockerfile}"), "```dockerfile\nFROM node:24\n```");
});

test("a whole-file <<< drops the region markers, as the site does", () => {
  assert.equal(
    ok("<<< @/examples/regions.ts"),
    '```ts\nimport { z } from "zod";\n\nexport const states = {\n  working: {\n    on: {},\n  },\n};\n```',
  );
  assert.equal(withoutRegions("a\n# region x\nb\n# endregion x"), "a\nb");
  assert.equal(regionOf("a\n// #region x\nb", "x"), undefined);
});

test("an include whose text holds a fence gets a longer fence", async () => {
  await writeFile(join(site, "examples/doc.md"), "```ts\nx\n```\n");
  assert.equal(ok("<<< @/examples/doc.md"), "````md\n```ts\nx\n```\n````");
});

test("a mermaid fence, and a container inside any fence, stay as they are", () => {
  const text = "```mermaid\nflowchart LR\n  a --> b\n```\n\n```md\n::: tip\n\n:::\n```";
  assert.equal(ok(text), text);
});

test("a <<< of a missing file or region fails; for a missing region, VitePress would show the whole file", () => {
  assert.match(convert("<<< @/examples/nope.ts").errors[0]!.message, /names examples\/nope\.ts, which does not exist/);
  const r = convert("Text.\n\n<<< @/examples/fix.ts#nope");
  assert.equal(r.errors[0]!.line, 3);
  assert.match(r.errors[0]!.message, /the region #nope, which examples\/fix\.ts does not have/);
});

test("a <<< outside the format fails: a relative path, line highlights, a title outside a code group", () => {
  assert.match(convert("<<< ../examples/fix.ts").errors[0]!.message, /not a code import of the format/);
  assert.match(convert("<<< @/examples/fix.ts{1,3}").errors[0]!.message, /not a code import of the format/);
  assert.match(convert("<<< @/examples/fix.ts [x]").errors[0]!.message, /a \[title\] only inside ::: code-group/);
  assert.match(
    convert("::: code-group\n\n<<< @/examples/fix.ts\n\n:::").errors[0]!.message,
    /inside ::: code-group has a \[title\]/,
  );
});

test("a fence's info is its language only, outside a code group; inside, it has a title", () => {
  assert.match(convert("```ts{2}\nx\n```").errors[0]!.message, /a fence's info is its language only/);
  assert.match(convert("```ts [a.ts]\nx\n```").errors[0]!.message, /a fence's info is its language only/);
  assert.match(convert("```ts:line-numbers\nx\n```").errors[0]!.message, /a fence's info is its language only/);
  assert.match(convert("```ts:no-line-numbers\nx\n```").errors[0]!.message, /a fence's info is its language only/);
  assert.deepEqual(convert("```c++\nx\n```\n\n```\ny\n```").errors, []);
  assert.match(
    convert("::: code-group\n\n```ts\nx\n```\n\n:::").errors[0]!.message,
    /a fence in ::: code-group has a language and a \[title\]/,
  );
});

test("a container that is not closed, closes nothing, or is misspelled fails, with its line", () => {
  assert.deepEqual(
    convert("Text.\n\n::: info\n\nOpen.").errors.map((e) => [e.line, e.message]),
    [[3, "::: info is not closed"]],
  );
  assert.match(convert(":::").errors[0]!.message, /::: closes nothing/);
  assert.match(convert("::: note").errors[0]!.message, /not a container of the format: "::: note"/);
  assert.match(convert(":::tip").errors[0]!.message, /not a container of the format: ":::tip"/);
  assert.match(convert("::: details").errors[0]!.message, /not a container of the format/);
  assert.match(convert('::include{file="./fix.ts"}').errors[0]!.message, /not a container of the format/);
  assert.match(convert("::: tabs\n\nText.\n\n:::").errors[0]!.message, /::: tabs starts with a tab/);
  assert.match(convert("::: tabs\n\n:::").errors[0]!.message, /::: tabs holds no tab/);
  assert.match(convert("::: code-group\n\nText.\n\n:::").errors[0]!.message, /only fences and <<< lines/);
  assert.match(convert(":::: tip\n\nHi.\n\n:::").errors[0]!.message, /opened with 4 colons/);
  assert.match(convert("  ::: info\n\n:::").errors[0]!.message, /starts at column 0/);
});

test("a container line needs an empty line on each side, as prettier would join it otherwise", () => {
  const r = convert("Text.\n::: info\n\nHi.\n\n:::");
  assert.equal(r.errors[0]!.line, 2);
  assert.match(r.errors[0]!.message, /needs an empty line before it and after it/);
  const tab = convert("::: tabs\n\n== A\nText.\n\n:::");
  assert.match(tab.errors[0]!.message, /needs an empty line before it and after it: "== A"/);
});

// `{{ }}` in a code span passes: the site renders each code span with `v-pre` (.vitepress/config.ts).
test("VitePress syntax the bundle cannot carry fails in prose; the same text in code passes", () => {
  const text = [
    "Hello {{ name }}.",
    "<Badge text='x' />",
    "",
    "<script setup>",
    "[[toc]]",
    "<!--@include: ./part.md-->",
    "> [!NOTE]",
    "`{{ fine }}` and `<Badge>` in code.",
    "```vue",
    "{{ fine }}",
    "<Badge />",
    "```",
  ].join("\n");
  assert.deepEqual(
    generatorSyntax(text, "p.md").map((e) => e.line),
    [1, 2, 4, 5, 6, 7],
  );
});

test("a raw HTML tag anywhere in prose fails; an anchor, an autolink and a tag in code pass", () => {
  const text = [
    "The push carried <n> commits.",
    "Line one<br>line two, and </div>.",
    'See <a href="x">this</a>.',
    "",
    'An anchor <a id="x"></a>here, <https://example.com> and `<n>` pass.',
  ].join("\n");
  assert.deepEqual(
    generatorSyntax(text, "p.md").map((e) => [e.line, e.message]),
    [
      [1, "a raw HTML tag (<n) is not in the source format: put it in a code span, or write &lt;"],
      [2, "a raw HTML tag (<br) is not in the source format: put it in a code span, or write &lt;"],
      [3, "a raw HTML tag (<a) is not in the source format: put it in a code span, or write &lt;"],
    ],
  );
});

test("a prose line that starts with a tag fails, even inside a code span; an anchor line passes", () => {
  const text = ["Run `jr2 send", "<run id>` now.", "", '<a id="x"></a>', "", "```sh", "<x>", "```"].join("\n");
  assert.deepEqual(
    generatorSyntax(text, "p.md").map((e) => [e.line, e.message.slice(0, 40)]),
    [[2, "VitePress reads a line that starts with "]],
  );
});

test("a prose line that starts with an autolink passes", () => {
  assert.deepEqual(generatorSyntax("The docs are at\n<https://example.com> now.", "p.md"), []);
});

test("a source page has no H1", () => {
  assert.deepEqual(
    headingOnes("## Fine\n\n```sh\n# a comment\n```\n\n# Not fine", "p.md", 5).map((e) => e.line),
    [11],
  );
});

test("vueSafe does not change an autolink", () => {
  const text = "See <https://example.com> now.\nThe docs are at\n<https://example.com/x>.";
  assert.equal(vueSafe(text), text);
});

test("vueSafe joins a prose line that starts with a tag to the line before, and escapes a tag in prose", () => {
  const text = [
    'Refuses: ``machine "<id>": names no party (Agent slots:',
    "<slots>; Gate ids: <ids>)``",
    "",
    'Run <n> times, see <a id="x"></a>the anchor and {{ this }}.',
    "",
    '<a id="type-x"></a>',
    "",
    "```ts",
    "<T>(x: T) => x",
    "```",
  ].join("\n");
  assert.equal(
    vueSafe(text),
    [
      'Refuses: ``machine "<id>": names no party (Agent slots: <slots>; Gate ids: <ids>)``',
      "",
      'Run &lt;n> times, see <a id="x"></a>the anchor and &#123;{ this }}.',
      "",
      '<a id="type-x"></a>',
      "",
      "```ts",
      "<T>(x: T) => x",
      "```",
    ].join("\n"),
  );
});
