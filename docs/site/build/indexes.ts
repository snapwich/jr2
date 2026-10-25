// The bundle's two indexes (ADR-0072): `llms.txt`, for a tool that reads the docs over the network
// (llmstxt.org), and `agents-block.md`, the text `jr2 up` keeps between an Instance's AGENTS.md
// markers. The block is the channel an Assistant always reads, so it is small: one instruction,
// the Kit version, and one pipe-delimited index of the bundle — the root, then each directory and
// its file names — in the compressed style that passed Vercel's evals. What an Assistant needs to
// write a Machine comes first.

import { posix } from "node:path";
import type { BuildError } from "./markdown.ts";
import { allPages, groupsOf, type Page, type Sitemap } from "./sitemap.ts";

export const BUNDLE_ROOT = "node_modules/@jr2/orchestrator/docs";

/** The page a sitemap entry is, with the description its frontmatter gives. */
export type Described = Page & { description: string };

/** `llms.txt`: the title, a one-line summary, then one section per sitemap section. A page's
 * `children` (the entry pages of a contents page) are a list under its item. */
export function llmsTxt(
  map: Sitemap,
  pages: ReadonlyMap<string, Described>,
  version: string,
  children: ReadonlyMap<string, readonly Described[]> = new Map(),
): string {
  const item = (d: Described) => `- [${d.title}](${d.slug}.md): ${d.description}`;
  const sections = map.sections.flatMap((s) => {
    const items = groupsOf(s)
      .flatMap((g) => g.pages)
      .flatMap((p) => {
        const d = pages.get(p.slug);
        return d ? [item(d), ...(children.get(p.slug) ?? []).map((c) => `  ${item(c)}`)] : [];
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

/** A folder that the index gives as one entry, `dir:{note; dir.md lists them}`, and not as a list
 * of its files: the folder of entry pages that a contents page `dir.md` lists. */
export type Folder = { dir: string; note: string };

/** The pipe-delimited index: `dir:{a.md,b.md}` for each directory, at the place of its first page
 * in the block's order, with the files in that order. The root's pages (Home, Why jr2) share the
 * entry `.`. Each folder follows the entry of the directory that holds its contents page. */
function compressedIndex(
  map: Sitemap,
  present: (slug: string) => boolean,
  errors: BuildError[],
  folders: readonly Folder[],
): string {
  const dirs = new Map<string, string[]>();
  for (const p of blockGroups(map, errors)
    .flat()
    .filter((p) => present(p.slug))) {
    const dir = posix.dirname(p.slug);
    dirs.set(dir, [...(dirs.get(dir) ?? []), `${posix.basename(p.slug)}.md`]);
  }
  const folder = (f: Folder) => `${f.dir}:{${f.note}; ${f.dir}.md lists them}`;
  return [
    `[jr2 docs index]|root: ./${BUNDLE_ROOT}`,
    ...[...dirs].flatMap(([dir, files]) => [
      `${dir}:{${files.join(",")}}`,
      ...folders.filter((f) => posix.dirname(f.dir) === dir).map(folder),
    ]),
    folder({ dir: "reference/decisions", note: "one file per ADR" }),
  ].join("|");
}

/** Where the block's instruction says to start: the guide that walks through a workflow module,
 * and the contents page that links to each name an Assistant writes against. */
const START = { guide: "guides/write-a-workflow", contents: "reference/authoring-surface" };

/** The sentences of the instruction that say where to start, and to read one page at a time: two
 * entry pages in one read are more than a file tool shows. A page that sitemap.json does not have
 * is an error, so a rename cannot leave the sentence pointing nowhere. */
function startSentence(map: Sitemap, errors: BuildError[]): string {
  const slugs = new Set(allPages(map).map((p) => p.slug));
  for (const slug of Object.values(START))
    if (!slugs.has(slug))
      errors.push({
        file: "docs/site/sitemap.json",
        line: 1,
        message: `the AGENTS.md block says to start with ${slug}.md, and sitemap.json has no such page`,
      });
  return (
    `Start with ${START.guide}.md and with ${START.contents}.md, the contents page of the Authoring surface. ` +
    "Read one page with each call of your file tool, because a file tool cuts off a long output."
  );
}

/** The sentences of the instruction that say what to run before the Assistant gives a change to the user: `jr2 check`, because
 * `npm run typecheck` loads no module, so it does not find a refusal of `createMachine`,
 * `defineEvent` or `workspace()`, and an Assistant that may not run `jr2 up` sees no other check.
 * The command is `npx --no`, because npx with no TTY installs a missing package with no prompt, and
 * the package `jr2` on the npm registry is not jr2. With `--no`, npx stops when the Instance has no
 * local `jr2` bin. */
const CHECK_SENTENCE =
  "Before you give a change to the user, run `npx --no jr2 check` in the Instance folder. " +
  "It does the typecheck and the load of each Workflow that `jr2 up` does first, with no cluster, and it gives the same refusals.";

/** `agents-block.md`: what `jr2 up` writes between the AGENTS.md markers, without the markers. */
export function agentsBlock(
  map: Sitemap,
  present: (slug: string) => boolean,
  version: string,
  errors: BuildError[] = [],
  folders: readonly Folder[] = [],
): string {
  return [
    `jr2 is newer than your training data. Before you write a Machine or change jr2.config.ts, read the bundled docs in ${BUNDLE_ROOT}/. They are the docs of this Instance's Kit version, ${version}. ${startSentence(map, errors)} ${CHECK_SENTENCE}`,
    "",
    compressedIndex(map, present, errors, folders),
    "",
  ].join("\n");
}
