// What every Reference generator shares: the docs set it links into, the anchors the other
// generated pages define, and the errors the build reports.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { relativeHref } from "../links.ts";
import type { BuildError } from "../markdown.ts";
import type { Page } from "../sitemap.ts";
import { fenced, maskCode } from "../markdown.ts";
import { flow, renderInline, seeTarget, tagError, type Doc, type Program } from "../tsdoc.ts";

export type Adr = { file: string; number: string; title: string };

/** Every ADR in docs/adr, in number order, with the title its H1 gives. */
export function readAdrs(repo: string): Adr[] {
  const dir = join(repo, "docs/adr");
  return readdirSync(dir)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .sort()
    .map((file) => {
      const h1 = /^# (.*)$/m.exec(readFileSync(join(dir, file), "utf8"));
      return { file, number: file.slice(0, 4), title: h1?.[1]?.trim() ?? file };
    });
}

export type RefContext = {
  repo: string;
  program: Program;
  pages: readonly Page[];
  adrs: readonly Adr[];
  /** Where each name a TSDoc `{@link}` can name is documented: a bundle path and an anchor. The
   * generators fill it before any page renders. */
  names: Map<string, { page: string; anchor: string }>;
  errors: BuildError[];
};

/** The href of the ADR numbered `number` (`"0015"`) from the bundle file `from`. */
export function adrHref(ctx: RefContext, number: string, from: string): string | undefined {
  const adr = ctx.adrs.find((a) => a.number === number);
  return adr && relativeHref(from, `reference/decisions/${adr.file}`);
}

/** `[ADR-0015](decisions/0015-….md), …` for a list of bare numbers. An unknown number is an error. */
export function adrLinks(ctx: RefContext, numbers: readonly string[], from: string, file: string): string {
  return numbers
    .map((n) => {
      const href = adrHref(ctx, n, from);
      if (!href) {
        ctx.errors.push({ file, line: 1, message: `ADR-${n} is not in docs/adr` });
        return `ADR-${n}`;
      }
      return `[ADR-${n}](${href})`;
    })
    .join(", ");
}

/** Each `ADR-NNNN` in prose made a link to that ADR: not one in a code span, and not one that is
 * already the text of a link. */
export function linkAdrMentions(ctx: RefContext, text: string, from: string): string {
  const masked = maskCode(text);
  let out = "";
  let at = 0;
  for (const m of masked.matchAll(/(?<!\[)\bADR-(\d{4})\b(?!\]\()/g)) {
    const href = adrHref(ctx, m[1]!, from);
    if (!href) continue;
    out += `${text.slice(at, m.index)}[${m[0]}](${href})`;
    at = m.index! + m[0].length;
  }
  return out + text.slice(at);
}

/** A TSDoc text as the Markdown of the page at `from`: each `{@link}` resolved, and each ADR
 * mention made a link. */
export function renderProse(ctx: RefContext, text: string, from: string): string {
  return linkAdrMentions(ctx, renderInline(text, linker(ctx, from)), from);
}

// The TSDoc a Reference page shows is written for the author (ADR-0072), so a maintainer's
// pointers in it — a repo file, a commit — are errors: they mean the reasoning that belongs in a
// `//` comment reached the page. The author's own files are not repo paths.
const AUTHOR_FILES = new Set(["jr2.config.ts", "AGENTS.md", "CLAUDE.md"]);
const REPO_PATH =
  /\b(?:packages|features|docs|scripts|templates|test|src|poc)\/(?:[\w./*-]*[\w*])?|\b[\w-]+(?:\.[\w-]+)*\.(?:ts|md|go|sh)\b/g;
const COMMIT_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;

/** An error for each repo path or commit id in the prose of `doc`: its summary and each tag that
 * the page shows as prose. An example's code and a `@see` target are not prose. */
export function checkVoice(ctx: RefContext, doc: Doc | undefined): void {
  if (!doc) return;
  const texts = [
    { text: doc.summary, line: doc.line },
    ...doc.tags.filter((t) => t.name !== "example" && t.name !== "see").map((t) => ({ text: t.text, line: t.line })),
  ];
  for (const { text, line } of texts) {
    const prose = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
    const found = [
      ...[...prose.matchAll(REPO_PATH)].map((m) => m[0]).filter((f) => !AUTHOR_FILES.has(f)),
      ...[...prose.matchAll(COMMIT_ID)].map((m) => m[0]),
    ];
    for (const f of new Set(found))
      ctx.errors.push({
        file: doc.file,
        line,
        message: `the TSDoc names ${f}, a repo path or a commit: TSDoc on a Reference page is for the author, and a maintainer's note goes in a // comment`,
      });
  }
}

/** A TSDoc `@see` target as a Markdown link from `from`: a sitemap page or an ADR, by its bundle
 * path under `docs/`. Anything else is an error. */
export function seeLink(ctx: RefContext, target: string, from: string): string | { error: string } {
  const bundled = bundlePath(target);
  const path = bundled.startsWith("docs/") ? bundled.slice("docs/".length) : undefined;
  const page = path && ctx.pages.find((p) => `${p.slug}.md` === path);
  if (page) return `[${page.title}](${relativeHref(from, path)})`;
  const adr = path && ctx.adrs.find((a) => path === `reference/decisions/${a.file}`);
  if (adr) return `[ADR-${adr.number}: ${adr.title}](${relativeHref(from, path!)})`;
  return {
    error: `@see ${target} is not a sitemap page or an ADR (write docs/<slug>.md or docs/reference/decisions/<file>)`,
  };
}

// A `@see` path is relative to @jr2/orchestrator's root, which holds the bundle. A TSDoc in
// another package names the bundle by its package, so an Assistant reading that file in
// node_modules can follow it: `@jr2/orchestrator/docs/<slug>.md`.
const BUNDLE_PACKAGE = "@jr2/orchestrator/";

/** A `@see` target as a path from @jr2/orchestrator's root: `docs/…`. */
export const bundlePath = (target: string): string =>
  target.startsWith(BUNDLE_PACKAGE) ? target.slice(BUNDLE_PACKAGE.length) : target;

/** A `{@link}` resolver for the page at `from`. */
export const linker =
  (ctx: RefContext, from: string) =>
  (name: string): string | undefined => {
    const n = ctx.names.get(name);
    if (!n) return undefined;
    return n.page === from ? `#${n.anchor}` : `${relativeHref(from, n.page)}#${n.anchor}`;
  };

/** The anchor of a name: lower case, a hyphen for each run of other characters. */
export const anchorOf = (...parts: string[]): string =>
  parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** A TSDoc's `@see` tags as a "See also" list from `from`, without a link to `from` itself. An
 * unknown target is an error at its tag's line. */
export function seeAlso(ctx: RefContext, doc: Doc | undefined, from: string): string | undefined {
  const items = (doc?.tags ?? [])
    .filter((t) => t.name === "see" && bundlePath(seeTarget(t)) !== `docs/${from}`)
    .map((t) => {
      if (!doc!.file.startsWith("packages/orchestrator/") && seeTarget(t).startsWith("docs/"))
        ctx.errors.push(
          tagError(
            doc!,
            t,
            `@see ${seeTarget(t)} is outside @jr2/orchestrator: write @jr2/orchestrator/${seeTarget(t)}`,
          ),
        );
      const l = seeLink(ctx, seeTarget(t), from);
      if (typeof l === "string") return `- ${l}`;
      ctx.errors.push(tagError(doc!, t, l.error));
      return `- ${seeTarget(t)}`;
    });
  return items.length ? `**See also**\n\n${items.join("\n")}` : undefined;
}

/** The block tags a surface entry renders, each in its own place. */
export const RENDERED_TAGS: ReadonlySet<string> = new Set(["remarks", "param", "returns", "return", "example", "see"]);

/** The block tags a named type renders (a Types section, a Mechanism event): it has no params and
 * returns nothing. */
export const TYPE_TAGS: ReadonlySet<string> = new Set(["remarks", "example", "see"]);

/** An error for each block tag of `doc` that is not in `rendered`: its text would be dropped
 * without a word. */
export function checkTags(ctx: RefContext, doc: Doc | undefined, rendered: ReadonlySet<string> = RENDERED_TAGS): void {
  for (const t of (doc?.tags ?? []).filter((t) => !rendered.has(t.name)))
    ctx.errors.push(
      tagError(doc!, t, `@${t.name} is not a tag the Reference renders here (${[...rendered].join(", ")})`),
    );
}

/** A named type's TSDoc after its summary, as Markdown blocks: its remarks, its examples and its
 * See also list. A tag it would drop is an error. */
export function typeDocTail(ctx: RefContext, doc: Doc | undefined, from: string): string[] {
  checkTags(ctx, doc, TYPE_TAGS);
  checkVoice(ctx, doc);
  const tags = doc?.tags ?? [];
  const out = tags.filter((t) => t.name === "remarks").map((t) => renderProse(ctx, flow(t.text), from));
  for (const t of tags.filter((t) => t.name === "example")) out.push(`**Example**\n\n${exampleBlock(t.text)}`);
  const see = seeAlso(ctx, doc, from);
  if (see) out.push(see);
  return out;
}

/** An `@example`'s text as a fenced block: as written when the author fenced it, else as `ts`. */
export function exampleBlock(text: string): string {
  const t = text.trim();
  return /^(`{3,}|~{3,})/.test(t) ? t : fenced("ts", t);
}
