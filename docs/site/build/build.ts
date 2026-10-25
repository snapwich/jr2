// docs:build (ADR-0072): assemble the docs bundle that `@jr2/orchestrator` ships. Its inputs are
// the pages in docs/site, the Reference generated from the code, GLOSSARY.md and docs/adr; its
// output is plain CommonMark + GFM at the sitemap's paths, every ADR under reference/decisions/,
// `llms.txt`, and `agents-block.md`. The whole bundle is made in memory and checked — the source
// format, the titles, every link — and written only when nothing failed, so a failed build leaves
// no half bundle behind.
//
// --partial is for the time before every page exists: a sitemap page with no file is skipped, and
// a link to it counts as resolved. The default is strict, and a missing page fails it.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentsBlock, llmsTxt, type Described } from "./indexes.ts";
import { rewriteLinks, type DocsSet } from "./links.ts";
import { anchorsIn, pageHead, parseFrontmatter, type BuildError } from "./markdown.ts";
import { CLI_PAGE, renderCli } from "./reference/cli.ts";
import { CONFIG_PAGE, readConfig, renderConfig } from "./reference/config.ts";
import { readAdrs, type RefContext } from "./reference/context.ts";
import { GLOSSARY_PAGE, renderDecisions, renderGlossary } from "./reference/glossary.ts";
import { HTTP_PAGE, renderHttp } from "./reference/http-api.ts";
import { EVENTS_PAGE, readMechanismEvents, renderMechanismEvents } from "./reference/mechanism-events.ts";
import { examplesOf, readSurface, renderSurface, type EntryPage } from "./reference/surface.ts";
import { allPages, readSitemap, type Page } from "./sitemap.ts";
import { createProgram, type Program } from "./tsdoc.ts";
import { generatorSyntax, headingOnes, toPlainMarkdown } from "./vitepress.ts";

export const REPO = fileURLToPath(new URL("../../../", import.meta.url));
export const DEFAULT_OUT = join(REPO, "packages/orchestrator/docs");

export type BuildOptions = {
  /** The repo root. */
  repo?: string;
  /** The folder of the hand-written pages and sitemap.json. Its pages resolve their links as
   * pages of docs/site. */
  site?: string;
  /** Skip a sitemap page that has no file, and let a link to it resolve. */
  partial?: boolean;
};

export type BuildResult = {
  /** Every bundle file, by its bundle path. */
  files: Map<string, string>;
  /** The sitemap pages --partial skipped. */
  skipped: string[];
  errors: BuildError[];
};

/** The generated Reference pages: what each says it holds. */
const GENERATED: Record<string, string> = {
  "reference/authoring-surface":
    "Every name that @jr2/orchestrator exports from its root, by group, with a link to its page: its signature, its TSDoc, and an example.",
  "reference/machines": "The Machines that @jr2/machines ships: their input, their output, and their Open parts.",
  "reference/config": "Every field of jr2.config.ts: its type, whether it is required, its default, and what it does.",
  "reference/cli": "Every jr2 command: its synopsis, its arguments, flags and env vars, and what it prints.",
  "reference/http-api":
    "Every route of the Orchestrator's HTTP API, by access band, and the types of its bodies and answers.",
  "reference/mechanism-events": "The events that jr2 itself sends into every jr2Setup Machine, and their payloads.",
  "reference/glossary": "The terms of jr2: what each one means, and the words to avoid.",
  "reference/decisions": "Every architecture decision record of jr2, by number.",
};

const programs = new Map<string, Program>();

/** The compiler program over the repo's sources. One build process makes it once. */
function programFor(repo: string): Program {
  let p = programs.get(repo);
  if (!p) programs.set(repo, (p = createProgram(repo)));
  return p;
}

export function kitVersion(repo: string): string {
  return (JSON.parse(readFileSync(join(repo, "packages/orchestrator/package.json"), "utf8")) as { version: string })
    .version;
}

type Source = { page: Page; file: string; title: string; description: string; body: string; bodyLine: number };

/** Read and check one hand-written page: its frontmatter, its title, and the source format. */
function readPage(page: Page, site: string, errors: BuildError[]): Source | undefined {
  const file = `docs/site/${page.slug}.md`;
  const text = readFileSync(join(site, `${page.slug}.md`), "utf8");
  const fm = parseFrontmatter(text);
  const err = (line: number, message: string) => errors.push({ file, line, message });
  if (!fm) return (err(1, "a page starts with frontmatter that holds its title and description"), undefined);
  for (const e of fm.errors) err(1, e);
  const keys = Object.keys(fm.data).sort();
  if (keys.join(",") !== "description,title")
    err(1, `the frontmatter holds title and description and nothing else, not: ${keys.join(", ") || "nothing"}`);
  if (fm.data.title !== undefined && fm.data.title !== page.title)
    err(2, `the title "${fm.data.title}" is not the sitemap's "${page.title}"`);
  errors.push(...generatorSyntax(fm.body, file, fm.bodyLine), ...headingOnes(fm.body, file, fm.bodyLine));
  return {
    page,
    file,
    title: page.title,
    description: fm.data.description ?? "",
    body: fm.body,
    bodyLine: fm.bodyLine,
  };
}

/** The Reference context: the program, the docs set's pages and ADRs, and the names each page
 * documents. */
export function referenceContext(repo: string, pages: readonly Page[]): RefContext {
  return { repo, program: programFor(repo), pages, adrs: readAdrs(repo), names: new Map(), errors: [] };
}

/** The surface pages that are split into a contents page and a folder of entry pages, by slug,
 * and what the AGENTS.md block says that the folder holds. The Authoring surface is too long for
 * one read of a file tool (about 200 KB as one page). The machines page is short. */
export const SPLIT: Record<string, string> = {
  "reference/authoring-surface": "one file per export and type",
};

export type GeneratedReference = {
  /** Each Reference page's body, by slug: the sitemap's pages and their entry pages. */
  pages: Map<string, string>;
  /** The entry pages of each contents page, by the contents page's slug. */
  entries: Map<string, EntryPage[]>;
  examples: { page: string; name: string; code: string }[];
};

/** The Reference pages, by slug, and the examples the surface pages carry. */
export function generateReference(ctx: RefContext): GeneratedReference {
  const read = (root: string, slug: string) => readSurface(ctx, root, `${slug}.md`, slug in SPLIT);
  const surface = read("packages/orchestrator/src/index.ts", "reference/authoring-surface");
  const machines = read("packages/machines/src/index.ts", "reference/machines");
  const config = readConfig(ctx);
  const events = readMechanismEvents(ctx);
  const surfacePages = renderSurface(
    ctx,
    surface,
    "The [Authoring surface](glossary.md#authoring-surface) is every name that `@jr2/orchestrator` exports from its root, and nothing else: a workflow module and `jr2.config.ts` import only these names. The groups and their order are those of the root's `src/index.ts`. This page gives each name its kind and the first sentence of its TSDoc. Each name has a page of its own, in `authoring-surface/`, with the file that declares it, its signature, and its TSDoc.",
  );
  const machinesPages = renderSurface(
    ctx,
    machines,
    "`@jr2/machines` ships Machines, not Workflows. A Machine becomes a Workflow when a file in the Instance's `workflows/` folder exports it, with each [Open](glossary.md#open) part bound by [`customize`](authoring-surface/customize.md). Install it beside `@jr2/orchestrator`, at the same version: it is a peer of the kit, never a copy of it.",
  );
  const pages = new Map<string, string>([
    ["reference/authoring-surface", surfacePages.body],
    ["reference/machines", machinesPages.body],
    [CONFIG_PAGE.replace(/\.md$/, ""), renderConfig(ctx, config)],
    [CLI_PAGE.replace(/\.md$/, ""), renderCli(ctx)],
    [HTTP_PAGE.replace(/\.md$/, ""), renderHttp(ctx)],
    [EVENTS_PAGE.replace(/\.md$/, ""), renderMechanismEvents(ctx, events)],
  ]);
  const entries = new Map<string, EntryPage[]>();
  for (const [slug, p] of [
    ["reference/authoring-surface", surfacePages],
    ["reference/machines", machinesPages],
  ] as const) {
    if (!p.entries.length) continue;
    entries.set(slug, p.entries);
    for (const e of p.entries) {
      if (pages.has(e.slug))
        ctx.errors.push({ file: `${slug}.md (generated)`, line: 1, message: `two pages are ${e.slug}.md` });
      pages.set(e.slug, e.body);
    }
  }
  const examples = [
    ...examplesOf(ctx, surface).map((e) => ({ page: surface.page, ...e })),
    ...examplesOf(ctx, machines).map((e) => ({ page: machines.page, ...e })),
  ];
  return { pages, entries, examples };
}

/** Assemble the bundle in memory. Nothing is written. */
export async function buildDocs(opts: BuildOptions = {}): Promise<BuildResult> {
  const repo = resolve(opts.repo ?? REPO);
  const site = resolve(opts.site ?? join(repo, "docs/site"));
  const map = await readSitemap(pathToFileURL(join(site, "sitemap.json")));
  const version = kitVersion(repo);
  const errors: BuildError[] = [];
  const pages = allPages(map);

  // The hand-written pages, read and checked.
  const sources: Source[] = [];
  const skipped: string[] = [];
  for (const page of pages.filter((p) => p.source === "page")) {
    if (!existsSync(join(site, `${page.slug}.md`))) {
      if (opts.partial) skipped.push(page.slug);
      else
        errors.push({
          file: `docs/site/${page.slug}.md`,
          line: 1,
          message: `sitemap.json names the page ${page.slug}, and it has no file (build with --partial to skip it)`,
        });
      continue;
    }
    const s = readPage(page, site, errors);
    if (s) sources.push(s);
  }

  // The generated pages.
  const ctx = referenceContext(repo, pages);
  const reference = generateReference(ctx);
  errors.push(...ctx.errors);
  const glossary = renderGlossary(readFileSync(join(repo, "GLOSSARY.md"), "utf8"));
  for (const e of glossary.errors) errors.push({ file: "GLOSSARY.md", line: 1, message: e });
  reference.pages.set("reference/glossary", glossary.body);
  reference.pages.set("reference/decisions", renderDecisions(ctx.adrs));
  const entryPages = new Map([...reference.entries.values()].flat().map((e) => [e.slug, e]));
  for (const p of pages.filter((p) => p.source === "generated"))
    if (!reference.pages.has(p.slug) || !GENERATED[p.slug])
      errors.push({ file: "docs/site/sitemap.json", line: 1, message: `no generator makes the page ${p.slug}` });

  // The docs set the links resolve in.
  const adrFiles = ctx.adrs.map((a) => a.file);
  const bundle = new Set<string>([
    ...sources.map((s) => `${s.page.slug}.md`),
    ...[...reference.pages.keys()].map((slug) => `${slug}.md`),
    ...adrFiles.map((f) => `reference/decisions/${f}`),
  ]);
  const anchors = new Map<string, Set<string>>();
  for (const [slug, body] of reference.pages) {
    anchors.set(`${slug}.md`, anchorsIn(body));
    // Two names that slug alike (two routes that differ only in a `{regex}`) would share one
    // anchor, and a link to the second would land on the first.
    const ids = [...body.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]!);
    for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i)))
      errors.push({ file: `${slug}.md (generated)`, line: 1, message: `two entries share the anchor #${id}` });
  }
  for (const f of adrFiles)
    anchors.set(`reference/decisions/${f}`, anchorsIn(readFileSync(join(repo, "docs/adr", f), "utf8")));
  const set: DocsSet = {
    version,
    repo,
    aliases: new Map([
      ["GLOSSARY.md", GLOSSARY_PAGE],
      ...adrFiles.map((f): [string, string] => [`docs/adr/${f}`, `reference/decisions/${f}`]),
    ]),
    bundle,
    skipped: new Set(skipped.map((s) => `${s}.md`)),
    anchors,
  };

  const files = new Map<string, string>();
  const described = new Map<string, Described>();
  for (const s of sources) {
    const bundlePath = `${s.page.slug}.md`;
    const linked = rewriteLinks(s.body, { from: s.file, bundle: bundlePath, file: s.file, firstLine: s.bodyLine }, set);
    errors.push(...linked.errors);
    const converted = toPlainMarkdown(linked.text, { file: s.file, site, repo, firstLine: s.bodyLine });
    errors.push(...converted.errors);
    files.set(bundlePath, `${pageHead(s.title, s.description)}${converted.text.replace(/^\n*/, "\n")}`);
    described.set(s.page.slug, { ...s.page, description: s.description });
  }
  for (const [slug, body] of reference.pages) {
    const page = pages.find((p) => p.slug === slug);
    const entry = entryPages.get(slug);
    const bundlePath = `${slug}.md`;
    const from = slug === "reference/glossary" ? "GLOSSARY.md" : `docs/site/${bundlePath}`;
    const label = slug === "reference/glossary" ? "GLOSSARY.md" : `${bundlePath} (generated)`;
    const head = entry
      ? pageHead(entry.title, entry.description, entry.heading)
      : pageHead(page?.title ?? slug, GENERATED[slug] ?? "");
    const linked = rewriteLinks(body, { from, bundle: bundlePath, file: label }, set);
    errors.push(...linked.errors);
    files.set(bundlePath, `${head}\n${linked.text}`);
    if (page) described.set(slug, { ...page, description: GENERATED[slug] ?? "" });
  }
  for (const f of adrFiles) {
    const from = `docs/adr/${f}`;
    const bundlePath = `reference/decisions/${f}`;
    const linked = rewriteLinks(readFileSync(join(repo, from), "utf8"), { from, bundle: bundlePath, file: from }, set);
    errors.push(...linked.errors);
    files.set(bundlePath, linked.text);
  }
  const children = new Map(
    [...reference.entries].map(([slug, list]): [string, Described[]] => [
      slug,
      list.map((e) => ({ slug: e.slug, title: e.heading, source: "generated", description: e.description })),
    ]),
  );
  const folders = [...reference.entries.keys()].map((slug) => ({
    dir: slug,
    note: SPLIT[slug] ?? "one file per entry",
  }));
  files.set("llms.txt", llmsTxt(map, described, version, children));
  files.set(
    "agents-block.md",
    agentsBlock(map, (slug) => described.has(slug), version, errors, folders),
  );
  return { files, skipped, errors };
}

/** Write a built bundle to `out`, replacing an earlier bundle there. A folder that holds other
 * files and no `agents-block.md` is not a bundle, and is refused rather than emptied. */
export async function writeBundle(files: ReadonlyMap<string, string>, out: string): Promise<void> {
  if (existsSync(out) && readdirSync(out).length && !existsSync(join(out, "agents-block.md")))
    throw new Error(`docs:build: ${out} holds files and no agents-block.md, so it is not a docs bundle to replace`);
  await rm(out, { recursive: true, force: true });
  for (const [path, text] of files) {
    const file = join(out, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}
