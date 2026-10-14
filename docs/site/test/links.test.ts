// The link rules of the bundle (ADR-0072): a link into the docs set becomes its bundle path, a link
// to another repo file becomes a GitHub URL at the release tag, and a link to nothing fails with
// its file and line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteLinks, type DocsSet, type LinkSource } from "../build/links.ts";
import { formatError } from "../build/markdown.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const ADR = "0015-authoring-surface-absorbs-the-mechanism.md";

const set: DocsSet = {
  version: "1.2.3",
  repo,
  aliases: new Map([
    ["GLOSSARY.md", "reference/glossary.md"],
    [`docs/adr/${ADR}`, `reference/decisions/${ADR}`],
  ]),
  bundle: new Set([
    "index.md",
    "concepts/workspaces.md",
    "reference/glossary.md",
    "reference/cli.md",
    `reference/decisions/${ADR}`,
  ]),
  skipped: new Set(["guides/write-a-workflow.md"]),
  anchors: new Map([
    ["reference/glossary.md", new Set(["lease", "authoring-surface"])],
    ["reference/cli.md", new Set(["run"])],
  ]),
};

const page: LinkSource = {
  from: "docs/site/concepts/workspaces.md",
  bundle: "concepts/workspaces.md",
  file: "docs/site/concepts/workspaces.md",
};
const rewrite = (text: string, src = page) => rewriteLinks(text, src, set);

test("a link into the docs set becomes its bundle path, relative to the linking file", () => {
  const r = rewrite(
    [
      "[home](../index.md)",
      "[the Lease](../reference/glossary.md#lease)",
      "[the term](../../../GLOSSARY.md#authoring-surface)",
      `[why](../../adr/${ADR})`,
      `[why, as a page](../reference/decisions/${ADR}#decision)`,
      "[run](../reference/cli.md#run 'jr2 run')",
    ].join("\n"),
  );
  assert.deepEqual(r.errors, []);
  assert.equal(
    r.text,
    [
      "[home](../index.md)",
      "[the Lease](../reference/glossary.md#lease)",
      "[the term](../reference/glossary.md#authoring-surface)",
      `[why](../reference/decisions/${ADR})`,
      `[why, as a page](../reference/decisions/${ADR}#decision)`,
      "[run](../reference/cli.md#run 'jr2 run')",
    ].join("\n"),
  );
});

test("an ADR's link to another ADR, and to GLOSSARY.md, resolves from its own place", () => {
  const adr: LinkSource = { from: `docs/adr/${ADR}`, bundle: `reference/decisions/${ADR}`, file: `docs/adr/${ADR}` };
  const r = rewrite(`[self](${ADR}) and [terms](../../GLOSSARY.md)`, adr);
  assert.deepEqual(r.errors, []);
  assert.equal(r.text, `[self](${ADR}) and [terms](../glossary.md)`);
});

test("a link to a repo file outside the docs set becomes a GitHub URL at the tag", () => {
  const r = rewrite(
    "[index](../../../packages/orchestrator/src/index.ts#L10) and [the fixture](../tutorial/greet) and [def]\n\n[def]: ../../../justfile",
  );
  assert.deepEqual(r.errors, []);
  assert.equal(
    r.text,
    "[index](https://github.com/snapwich/jr2/blob/v1.2.3/packages/orchestrator/src/index.ts#L10) and " +
      "[the fixture](https://github.com/snapwich/jr2/tree/v1.2.3/docs/site/tutorial/greet) and [def]\n\n" +
      "[def]: https://github.com/snapwich/jr2/blob/v1.2.3/justfile",
  );
});

test("a link to nothing fails with file:line and its target", () => {
  const r = rewrite("Line one.\n\nSee [gone](../concepts/nope.md) and [term](../reference/glossary.md#nope).", {
    ...page,
    firstLine: 5,
  });
  assert.deepEqual(r.errors.map(formatError), [
    "docs/site/concepts/workspaces.md:7: the link ../concepts/nope.md resolves to docs/site/concepts/nope.md, which does not exist",
    "docs/site/concepts/workspaces.md:7: the anchor #nope is not in reference/glossary.md",
  ]);
  assert.match(rewrite("[x](/abs.md)").errors[0]!.message, /root-absolute/);
  assert.match(rewrite("[x](../../../../outside.md)").errors[0]!.message, /does not exist/);
});

test("a link into a folder that the site build writes fails, even when an earlier build left the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "jr2-links-"));
  try {
    for (const f of ["docs/site/reference/old.md", "docs/site/.vitepress/dist/index.html", "docs/site/x.md"]) {
      await mkdir(join(root, f, ".."), { recursive: true });
      await writeFile(join(root, f), "");
    }
    const r = rewriteLinks("[old](../reference/old.md) [dist](../.vitepress/dist/index.html) [x](../x.md)", page, {
      ...set,
      repo: root,
    });
    assert.deepEqual(
      r.errors.map((e) => e.message),
      [
        "the link ../reference/old.md resolves to docs/site/reference/old.md, which does not exist",
        "the link ../.vitepress/dist/index.html resolves to docs/site/.vitepress/dist/index.html, which does not exist",
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an absolute URL passes unchecked, and code is not a link", () => {
  const text =
    "[a](https://example.com/x.md) <https://example.com> [m](mailto:a@b.c) `[x](nope.md)`\n\n" +
    "A span `that wraps\n[x](nope.md)` over a line.\n\n```md\n[x](nope.md)\n```";
  const r = rewrite(text);
  assert.deepEqual(r.errors, []);
  assert.equal(r.text, text);
});

test("a footnote definition is not a link definition", () => {
  const text = "A claim.[^1]\n\n[^1]: The note, with no link.\n[d]: ../index.md";
  const r = rewrite(text);
  assert.deepEqual(r.errors, []);
  assert.equal(r.text, "A claim.[^1]\n\n[^1]: The note, with no link.\n[d]: ../index.md");
});

test("a link to a page --partial skipped becomes its text, and its anchor is not checked", () => {
  const r = rewrite(
    "See [w](../guides/write-a-workflow.md#a-step), [a `[x]`\nwrapped [one]](../guides/write-a-workflow.md) and ![an image](../guides/write-a-workflow.md).\n\n" +
      "[d]: ../guides/write-a-workflow.md\n[e]: ../index.md",
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.text, "See w, a `[x]`\nwrapped [one] and an image.\n\n[e]: ../index.md");
});

test("a same-page anchor is checked where the page's anchors are known", () => {
  const cli: LinkSource = { from: "docs/site/reference/cli.md", bundle: "reference/cli.md", file: "reference/cli.md" };
  assert.deepEqual(rewrite("[run](#run)", cli).errors, []);
  assert.match(rewrite("[x](#nope)", cli).errors[0]!.message, /#nope is not in reference\/cli\.md/);
});
