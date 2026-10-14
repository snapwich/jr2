// sitemap.json as types (ADR-0072): the nav that docs:build assembles the bundle from and that each
// site generator renders. test/sitemap.test.ts pins its shape; this module is what both read.

import { readFile } from "node:fs/promises";

/** One page: its bundle path without `.md`, its nav title, and whether a file in docs/site holds
 * it (`page`) or docs:build makes it (`generated`). */
export type Page = { slug: string; title: string; source: "page" | "generated" };
export type Group = { title: string; pages: Page[] };
/** A nav section: `pages`, or `groups` that each hold pages — never both. */
export type Section = { title: string; pages?: Page[]; groups?: Group[] };
export type Sitemap = { sections: Section[] };

export const SITEMAP_URL = new URL("../sitemap.json", import.meta.url);

export async function readSitemap(url: URL = SITEMAP_URL): Promise<Sitemap> {
  return JSON.parse(await readFile(url, "utf8")) as Sitemap;
}

export const pagesOf = (s: Section): Page[] => s.pages ?? (s.groups ?? []).flatMap((g) => g.pages);

/** A section's pages as groups: its own groups, or one untitled group of its pages. */
export const groupsOf = (s: Section): { title?: string; pages: Page[] }[] => s.groups ?? [{ pages: s.pages ?? [] }];

export const allPages = (map: Sitemap): Page[] => map.sections.flatMap(pagesOf);
