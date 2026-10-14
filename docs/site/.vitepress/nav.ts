// The site's nav and sidebar, made from sitemap.json (ADR-0072): the sitemap is the one list of the
// pages, so the site never holds a second copy of it. Each section is a nav item that opens its
// first page. A section of more than one page has a sidebar under its folder, with its groups.

import type { DefaultTheme } from "vitepress";
import { groupsOf, pagesOf, type Section, type Sitemap } from "../build/sitemap.ts";

/** The site link of a page: its slug from the site root, `/` for Home. */
export const linkOf = (slug: string): string => (slug === "index" ? "/" : `/${slug}`);

/** The folder a section's pages share, such as `concepts`, or undefined for a page at the root. */
function folderOf(section: Section): string | undefined {
  const dirs = new Set(pagesOf(section).map((p) => (p.slug.includes("/") ? p.slug.split("/")[0] : undefined)));
  const [dir] = dirs;
  return dirs.size === 1 ? dir : undefined;
}

/** The nav bar: each section but Home, in the sitemap's order. The site title links Home. */
export function navOf(map: Sitemap): DefaultTheme.NavItemWithLink[] {
  return map.sections
    .filter((s) => !pagesOf(s).some((p) => p.slug === "index"))
    .map((s) => {
      const folder = folderOf(s);
      return {
        text: s.title,
        link: linkOf(pagesOf(s)[0]!.slug),
        ...(folder ? { activeMatch: `^/${folder}/` } : {}),
      };
    });
}

/** One sidebar for each section folder: its groups, or its pages when it has no groups. */
export function sidebarOf(map: Sitemap): DefaultTheme.SidebarMulti {
  const out: DefaultTheme.SidebarMulti = {};
  for (const s of map.sections) {
    const folder = folderOf(s);
    if (!folder) continue;
    out[`/${folder}/`] = groupsOf(s).map((g) => ({
      text: g.title ?? s.title,
      items: g.pages.map((p) => ({ text: p.title, link: linkOf(p.slug) })),
    }));
  }
  return out;
}
