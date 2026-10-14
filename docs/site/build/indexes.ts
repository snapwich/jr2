// The bundle's two indexes (ADR-0072): `llms.txt`, for a tool that reads the docs over the network
// (llmstxt.org), and `agents-block.md`, the text `jr2 up` keeps between an Instance's AGENTS.md
// markers. The block is the channel an Assistant always reads, so it is small: one instruction,
// the Kit version, and one pipe-delimited index of the bundle — the root, then each directory and
// its file names — in the compressed style that passed Vercel's evals. What an Assistant needs to
// write a Machine comes first.

import { posix } from "node:path";
import type { BuildError } from "./markdown.ts";
import { groupsOf, type Page, type Sitemap } from "./sitemap.ts";

export const BUNDLE_ROOT = "node_modules/@jr2/orchestrator/docs";

/** The page a sitemap entry is, with the description its frontmatter gives. */
export type Described = Page & { description: string };

/** `llms.txt`: the title, a one-line summary, then one section per sitemap section. */
export function llmsTxt(map: Sitemap, pages: ReadonlyMap<string, Described>, version: string): string {
  const sections = map.sections.flatMap((s) => {
    const items = groupsOf(s)
      .flatMap((g) => g.pages)
      .flatMap((p) => {
        const d = pages.get(p.slug);
        return d ? [`- [${d.title}](${d.slug}.md): ${d.description}`] : [];
      });
    return items.length ? [`## ${s.title}\n\n${items.join("\n")}`] : [];
  });
  return [
    "# jr2",
    `> A kit for agentic workflows as xstate Machines, run on Kubernetes. These are the docs of Kit version ${version}, as plain Markdown.`,
    ...sections,
  ]
    .join("\n\n")
    .concat("\n");
}

/** The Reference pages an Assistant writes against, first in the block. */
const AUTHORING = ["reference/authoring-surface", "reference/machines", "reference/config"];

/** The groups of the block's index, in the order an Assistant needs them: the Reference it writes
 * against, the Write Machines guides, the Concepts of what it writes, then the rest in nav order.
 * A group it names that sitemap.json does not have is an error, so a rename cannot drop it. */
function blockGroups(map: Sitemap, errors: BuildError[]): Page[][] {
  const groups = map.sections.flatMap((s) =>
    groupsOf(s).map((g) => ({ section: s.title, title: g.title, pages: g.pages })),
  );
  const missing = (what: string): Page[] => {
    errors.push({
      file: "docs/site/sitemap.json",
      line: 1,
      message: `the AGENTS.md block indexes ${what} first, and sitemap.json has none`,
    });
    return [];
  };
  const reference = groups.find((g) => g.section === "Reference")?.pages ?? missing('the section "Reference"');
  const authoring = AUTHORING.flatMap((slug) => reference.find((p) => p.slug === slug) ?? missing(`the page ${slug}`));
  const group = (title: string) => groups.find((g) => g.title === title)?.pages ?? missing(`the group "${title}"`);
  const first: Page[][] = [authoring, group("Write Machines"), group("What you write")];
  const placed = new Set(first.flat().map((p) => p.slug));
  const rest = groups.map((g) => g.pages.filter((p) => !placed.has(p.slug)));
  return [...first, ...rest];
}

/** The pipe-delimited index: `dir:{a.md,b.md}` for each directory, at the place of its first page
 * in the block's order, with the files in that order. The root's pages (Home, Why jr2) share the
 * entry `.`. */
function compressedIndex(map: Sitemap, present: (slug: string) => boolean, errors: BuildError[]): string {
  const dirs = new Map<string, string[]>();
  for (const p of blockGroups(map, errors)
    .flat()
    .filter((p) => present(p.slug))) {
    const dir = posix.dirname(p.slug);
    dirs.set(dir, [...(dirs.get(dir) ?? []), `${posix.basename(p.slug)}.md`]);
  }
  return [
    `[jr2 docs index]|root: ./${BUNDLE_ROOT}`,
    ...[...dirs].map(([dir, files]) => `${dir}:{${files.join(",")}}`),
    "reference/decisions:{one file per ADR; reference/decisions.md lists them}",
  ].join("|");
}

/** `agents-block.md`: what `jr2 up` writes between the AGENTS.md markers, without the markers. */
export function agentsBlock(
  map: Sitemap,
  present: (slug: string) => boolean,
  version: string,
  errors: BuildError[] = [],
): string {
  return [
    `jr2 is newer than your training data. Before you write a Machine or change jr2.config.ts, read the bundled docs in ${BUNDLE_ROOT}/. They are the docs of this Instance's Kit version, ${version}.`,
    "",
    compressedIndex(map, present, errors),
    "",
  ].join("\n");
}
