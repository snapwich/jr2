// The Glossary and the Decisions (ADR-0072): CONTEXT.md and docs/adr, rendered as they are. The
// Glossary gains one explicit anchor per term, by the slug rule in docs/site/README.md, so that a
// link to a term resolves in every site generator; its H1 gives way to the page's. The Decisions
// page indexes every ADR, and each ADR is copied beside it.

import { relativeHref } from "../links.ts";
import { anchor, code, codeLines, table } from "../markdown.ts";
import type { Adr } from "./context.ts";

export const GLOSSARY_PAGE = "reference/glossary.md";
export const DECISIONS_PAGE = "reference/decisions.md";

/** The anchor of a Glossary term: the term in lower case, with a hyphen for each space. */
export const termSlug = (term: string): string => term.toLowerCase().replace(/ /g, "-");

const TERM = /^\*\*([^*]+)\*\*:/;

/** CONTEXT.md with an anchor before each term, its H1 dropped. Errors name a term whose slug
 * another term has. */
export function renderGlossary(context: string): { body: string; terms: string[]; errors: string[] } {
  const lines = context.split("\n");
  const code_ = codeLines(lines);
  const out: string[] = [];
  const terms: string[] = [];
  const errors: string[] = [];
  const slugs = new Set<string>();
  let dropped = false;
  let skipBlank = false;
  lines.forEach((line, i) => {
    if (!dropped && !code_[i] && /^# /.test(line)) {
      dropped = skipBlank = true;
      return;
    }
    if (skipBlank && line === "") return;
    skipBlank = false;
    const m = code_[i] ? null : TERM.exec(line);
    if (m) {
      const slug = termSlug(m[1]!);
      if (slugs.has(slug)) errors.push(`two Glossary terms have the anchor #${slug}`);
      slugs.add(slug);
      terms.push(m[1]!);
      out.push(anchor(slug), "");
    }
    out.push(line);
  });
  return { body: out.join("\n").replace(/^\n+/, "").replace(/\n*$/, "\n"), terms, errors };
}

/** The Decisions page: every ADR, by number, with its title. */
export function renderDecisions(adrs: readonly Adr[]): string {
  const rows = adrs.map((a) => [
    a.number,
    `[${a.title}](${relativeHref(DECISIONS_PAGE, `reference/decisions/${a.file}`)})`,
  ]);
  return (
    [
      `Each architecture decision record (ADR) says what jr2 decided, why, and what it gave up. An ADR is updated in place: it states the latest decision. The pages of the docs link to the ADR behind a rule; the ${code("ADR-NNNN")} in a page is its number here.`,
      table(["ADR", "Title"], rows),
    ].join("\n\n") + "\n"
  );
}
