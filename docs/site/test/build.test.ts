// docs:build as a whole (ADR-0072): --partial against strict, the checks on a page's source, and a
// full partial build of this repo written to a temp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDocs, REPO, writeBundle } from "../build/build.ts";
import { formatError } from "../build/markdown.ts";
import { allPages, readSitemap } from "../build/sitemap.ts";

const tmp = await mkdtemp(join(tmpdir(), "jr2-docs-build-"));
test.after(() => rm(tmp, { recursive: true, force: true }));

/** A site folder with the real sitemap and the pages given, so the Reference is the repo's. */
async function site(name: string, pages: Record<string, string>): Promise<string> {
  const dir = join(tmp, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "sitemap.json"), await readFile(join(REPO, "docs/site/sitemap.json")));
  for (const [slug, text] of Object.entries(pages)) {
    await mkdir(join(dir, slug, ".."), { recursive: true });
    await writeFile(join(dir, `${slug}.md`), text);
  }
  return dir;
}

const page = (title: string, body: string) => `---\ntitle: ${title}\ndescription: A page.\n---\n\n${body}\n`;

test("strict fails on each sitemap page with no file; --partial skips them and unlinks links to them", async () => {
  const dir = await site("partial", {
    "concepts/workspaces": page("Workspaces", "See [Write a Workflow](../guides/write-a-workflow.md)."),
  });
  const strict = await buildDocs({ site: dir });
  const missing = allPages(await readSitemap()).filter((p) => p.source === "page" && p.slug !== "concepts/workspaces");
  const lines = strict.errors.map(formatError);
  assert.deepEqual(
    lines.filter((l) => l.includes("has no file")),
    missing.map(
      (p) =>
        `docs/site/${p.slug}.md:1: sitemap.json names the page ${p.slug}, and it has no file (build with --partial to skip it)`,
    ),
  );
  // Strict, the link to a missing page is broken too.
  assert.ok(
    lines.includes(
      "docs/site/concepts/workspaces.md:6: the link ../guides/write-a-workflow.md resolves to docs/site/guides/write-a-workflow.md, which does not exist",
    ),
    lines.join("\n"),
  );

  const partial = await buildDocs({ site: dir, partial: true });
  assert.deepEqual(partial.errors.map(formatError), []);
  assert.equal(partial.skipped.length, missing.length);
  assert.ok(!partial.files.has("guides/write-a-workflow.md"));
  assert.equal(
    partial.files.get("concepts/workspaces.md"),
    "---\ntitle: Workspaces\ndescription: A page.\n---\n\n# Workspaces\n\nSee Write a Workflow.\n",
  );
});

test("a page's source is checked: its frontmatter, its title, no H1, and its links", async () => {
  const adr = "../adr/0015-authoring-surface-absorbs-the-mechanism.md";
  const dir = await site("checks", {
    index: `---\ntitle: Start\ndescription: x\nsidebar: 2\n---\n\n# Home\n\n[gone](nope.md)\n\n[ok](${adr}#jr2setup-an-xstate-setup-analog-not-a-dsl) [bad](${adr}#nope)\n`,
    why: "No frontmatter.\n",
  });
  const r = await buildDocs({ site: dir, partial: true });
  assert.deepEqual(r.errors.map(formatError), [
    "docs/site/index.md:1: the frontmatter holds title and description and nothing else, not: description, sidebar, title",
    'docs/site/index.md:2: the title "Start" is not the sitemap\'s "Home"',
    "docs/site/index.md:7: a source page has no H1: its title is the frontmatter's `title`",
    "docs/site/why.md:1: a page starts with frontmatter that holds its title and description",
    "docs/site/index.md:9: the link nope.md resolves to docs/site/nope.md, which does not exist",
    "docs/site/index.md:11: the anchor #nope is not in reference/decisions/0015-authoring-surface-absorbs-the-mechanism.md",
  ]);
});

test("a full partial build of this repo succeeds, and writes the bundle", async () => {
  const r = await buildDocs({ partial: true });
  assert.deepEqual(r.errors.map(formatError), []);
  const out = join(tmp, "bundle");
  await writeBundle(r.files, out);
  for (const p of allPages(await readSitemap()).filter((p) => p.source === "generated"))
    assert.ok(existsSync(join(out, `${p.slug}.md`)), p.slug);
  const adrs = (await readdir(join(REPO, "docs/adr"))).filter((f) => /^\d{4}-/.test(f));
  assert.deepEqual((await readdir(join(out, "reference/decisions"))).sort(), adrs.sort());
  const block = await readFile(join(out, "agents-block.md"), "utf8");
  assert.match(block, /node_modules\/@jr2\/orchestrator\/docs/);
  // One entry for each directory, in the order an Assistant needs the pages.
  assert.match(block, /\|reference:\{authoring-surface\.md,machines\.md,config\.md,cli\.md,[^}]*\}\|/);
  const dirs = [...block.matchAll(/\|([\w./-]+):\{/g)].map((m) => m[1]!);
  assert.deepEqual(dirs, [...new Set(dirs)], "a directory has two entries in the block");
  assert.ok(block.endsWith("\n") && !block.includes("BEGIN:jr2-docs"));
  assert.match(
    await readFile(join(out, "llms.txt"), "utf8"),
    /^# jr2\n\n> .+\n\n## Reference\n\n- \[Authoring surface\]\(reference\/authoring-surface\.md\): /,
  );
  // A second build replaces the first; a folder that is not a bundle is refused, not emptied.
  await writeBundle(r.files, out);
  const other = join(tmp, "not-a-bundle");
  await mkdir(other);
  await writeFile(join(other, "keep.txt"), "mine");
  await assert.rejects(writeBundle(r.files, other), /not a docs bundle/);
  assert.ok(existsSync(join(other, "keep.txt")));
});

test("a group that the AGENTS.md block indexes first, renamed in sitemap.json, is an error on sitemap.json", async () => {
  const dir = await site("renamed", {});
  const map = JSON.parse(await readFile(join(dir, "sitemap.json"), "utf8")) as {
    sections: { title: string; groups?: { title: string }[] }[];
  };
  for (const g of map.sections.flatMap((s) => s.groups ?? [])) if (g.title === "Write Machines") g.title = "Author";
  await writeFile(join(dir, "sitemap.json"), JSON.stringify(map));
  const r = await buildDocs({ site: dir, partial: true });
  assert.deepEqual(r.errors.map(formatError), [
    'docs/site/sitemap.json:1: the AGENTS.md block indexes the group "Write Machines" first, and sitemap.json has none',
  ]);
});
