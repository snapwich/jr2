// The site's nav and sidebar come from sitemap.json (ADR-0072): every page is in them once, in the
// sitemap's order, so the site never needs a second list of the pages.

import { test } from "node:test";
import assert from "node:assert/strict";
import { linkOf, navOf, sidebarOf } from "../.vitepress/nav.ts";
import { allPages, pagesOf, readSitemap } from "../build/sitemap.ts";

const map = await readSitemap();

test("the nav is each section but Home, in order, and opens its first page", () => {
  assert.deepEqual(
    navOf(map).map((n) => [n.text, n.link]),
    map.sections.slice(1).map((s) => [s.title, linkOf(pagesOf(s)[0]!.slug)]),
  );
});

test("every page is in the site once: Home at the title, a single root page in the nav, the rest in a sidebar", () => {
  const sidebar = Object.values(sidebarOf(map)).flatMap((groups) =>
    (groups as { items: { link: string }[] }[]).flatMap((g) => g.items.map((i) => i.link)),
  );
  const rootPages = navOf(map)
    .map((n) => n.link)
    .filter((l) => !l.slice(1).includes("/"));
  assert.deepEqual(
    [linkOf("index"), ...rootPages, ...sidebar],
    allPages(map).map((p) => linkOf(p.slug)),
  );
});

test("a section's sidebar is under its folder, with the sitemap's groups", () => {
  const sidebar = sidebarOf(map);
  assert.deepEqual(Object.keys(sidebar), ["/get-started/", "/concepts/", "/guides/", "/reference/"]);
  assert.deepEqual(
    (sidebar["/guides/"] as { text: string }[]).map((g) => g.text),
    ["Run Workflows", "Converge an Instance", "Write Machines"],
  );
});
