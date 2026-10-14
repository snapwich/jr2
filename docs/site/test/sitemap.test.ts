// sitemap.json is the site's navigation as data (ADR-0072): docs:build reads it to know which
// pages to assemble, and each site generator renders its nav from it. So its shape is a contract,
// pinned here; the types both read are build/sitemap.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { allPages as pagesIn, pagesOf, readSitemap } from "../build/sitemap.ts";

const sitemap = await readSitemap();
const allPages = pagesIn(sitemap);

// A slug is a path relative to docs/site without `.md`: lower-case kebab segments joined by `/`.
// That shuts out `..`, a leading `/`, a backslash, and an extension, so a slug cannot name a file
// outside the folder or a file that is not the page.
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

test("the sections are the nav, in its order", () => {
  assert.deepEqual(
    sitemap.sections.map((s) => s.title),
    ["Home", "Why jr2", "Get started", "Concepts", "Guides", "Reference"],
  );
});

test("a section holds pages or groups, never both, and nothing is empty", () => {
  for (const s of sitemap.sections) {
    assert.ok(typeof s.title === "string" && s.title.length > 0, "a section has a title");
    assert.ok((s.pages === undefined) !== (s.groups === undefined), `${s.title}: pages or groups, not both`);
    for (const g of s.groups ?? []) {
      assert.ok(typeof g.title === "string" && g.title.length > 0, `${s.title}: a group has a title`);
      assert.ok(g.pages.length > 0, `${s.title} / ${g.title}: no pages`);
    }
    assert.ok(pagesOf(s).length > 0, `${s.title}: no pages`);
  }
});

test("every page has a slug, a title, and a known source", () => {
  for (const p of allPages) {
    assert.deepEqual(Object.keys(p).sort(), ["slug", "source", "title"], `${p.slug}: unexpected keys`);
    assert.ok(typeof p.title === "string" && p.title.length > 0, `${p.slug}: no title`);
    assert.ok(p.source === "page" || p.source === "generated", `${p.slug}: source ${String(p.source)}`);
  }
});

test("slugs are unique", () => {
  const seen = new Set<string>();
  for (const { slug } of allPages) {
    assert.ok(!seen.has(slug), `duplicate slug ${slug}`);
    seen.add(slug);
  }
});

test("every slug is a safe relative path", () => {
  for (const { slug } of allPages) assert.match(slug, SAFE_SLUG);
});

test("the Reference is generated and nothing else is", () => {
  // A generated page has no source file in docs/site (ADR-0072). A `page` entry under Reference
  // sends docs:build after a file that is never written; a `generated` one elsewhere, a page
  // that no generator makes.
  for (const s of sitemap.sections) {
    const want = s.title === "Reference" ? "generated" : "page";
    for (const p of pagesOf(s)) assert.equal(p.source, want, `${p.slug}`);
  }
});
