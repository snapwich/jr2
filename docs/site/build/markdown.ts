// The small Markdown toolkit docs:build needs (ADR-0072): frontmatter, which lines are code, inline
// code spans, and anchors. Not a Markdown parser — the bundle is plain CommonMark + GFM, and each
// check here only has to tell prose from code the way a reader of the raw file would.

/** One problem the build reports, as `file:line: message`. `file` is repo-relative, or a bundle
 * path for a generated page. */
export type BuildError = { file: string; line: number; message: string };

export const formatError = (e: BuildError): string => `${e.file}:${e.line}: ${e.message}`;

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** For each line, true when it is part of a fenced code block, its fence lines included. */
export function codeLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let open: string | undefined;
  for (const line of lines) {
    if (open === undefined) {
      const m = FENCE.exec(line);
      if (m && !(m[1]!.startsWith("`") && m[2]!.includes("`"))) {
        open = m[1]!;
        out.push(true);
        continue;
      }
      out.push(false);
    } else {
      const m = FENCE.exec(line);
      if (m && m[1]![0] === open[0] && m[1]!.length >= open.length && m[2]!.trim() === "") open = undefined;
      out.push(true);
    }
  }
  return out;
}

/** The `[start, end)` ranges of the inline code spans in a text. A run of backticks opens a span
 * that the next run of the same length closes; an unmatched run is text, as CommonMark reads it. */
export function codeSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const runs = [...text.matchAll(/`+/g)];
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i]!;
    const close = runs.findIndex((r, j) => j > i && r[0].length === open[0].length);
    if (close < 0) continue;
    const end = runs[close]!;
    spans.push([open.index!, end.index! + end[0].length]);
    i = close;
  }
  return spans;
}

/** `text` with every inline code span replaced by spaces of the same length (line breaks kept),
 * so that a regex over the result finds prose only, at the same offsets. */
export function maskCode(text: string): string {
  let out = text;
  for (const [a, b] of codeSpans(text)) out = out.slice(0, a) + out.slice(a, b).replace(/[^\n]/g, " ") + out.slice(b);
  return out;
}

/** Each line as prose: `undefined` for a line of a fenced block, and otherwise the line with its
 * inline code masked. A code span can cross a line break inside a paragraph, so each paragraph
 * is masked whole. */
export function proseLines(lines: readonly string[]): (string | undefined)[] {
  const code = codeLines(lines);
  const out: (string | undefined)[] = lines.map(() => undefined);
  let i = 0;
  while (i < lines.length) {
    if (code[i] || lines[i]!.trim() === "") {
      if (!code[i]) out[i] = lines[i];
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !code[j] && lines[j]!.trim() !== "") j++;
    maskCode(lines.slice(i, j).join("\n"))
      .split("\n")
      .forEach((l, k) => (out[i + k] = l));
    i = j;
  }
  return out;
}

export type Frontmatter = { data: Record<string, string>; body: string; bodyLine: number; errors: string[] };

/** Read the `---` block at the top of a page: `key: value` lines, a value plain or quoted. */
export function parseFrontmatter(text: string): Frontmatter | undefined {
  const lines = text.split("\n");
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end < 0) return { data: {}, body: text, bodyLine: 1, errors: ["the frontmatter has no closing ---"] };
  const data: Record<string, string> = {};
  const errors: string[] = [];
  for (const raw of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (!m) {
      errors.push(`the frontmatter line "${raw}" is not \`key: value\``);
      continue;
    }
    let value = m[2]!.trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) value = JSON.parse(value) as string;
    else if (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      value = value.slice(1, -1).replace(/''/g, "'");
    // The site generator reads the frontmatter as YAML, which ends a plain value at `: ` or ` #`,
    // and reads a leading indicator as syntax.
    else if (/: |\s#|:$/.test(value) || /^[-?:,[\]{}#&*!|>%@`]/.test(value))
      errors.push(`the frontmatter value of ${m[1]} is not a plain YAML string: put it in double quotes`);
    data[m[1]!] = value;
  }
  return { data, body: lines.slice(end + 1).join("\n"), bodyLine: end + 2, errors };
}

/** A YAML scalar for a frontmatter value: plain when YAML reads it back as the same string. */
function yamlScalar(value: string): string {
  return /^[A-Za-z0-9`(][^:#"'\n]*$/.test(value) && !/\s$/.test(value) ? value : JSON.stringify(value);
}

/** The bundle's head of a page: its frontmatter, then its title as the one H1. */
export function pageHead(title: string, description: string): string {
  return `---\ntitle: ${yamlScalar(title)}\ndescription: ${yamlScalar(description)}\n---\n\n# ${title}\n`;
}

/** The anchor GitHub gives a heading: lower case, punctuation dropped, a hyphen for each space. */
export function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Every anchor a page defines: each explicit `<a id="…">`, and each heading's slug. */
export function anchorsIn(text: string): Set<string> {
  const lines = text.split("\n");
  const prose = proseLines(lines);
  const out = new Set<string>();
  lines.forEach((line, i) => {
    if (prose[i] === undefined) return;
    for (const m of line.matchAll(/<a id="([^"]+)"><\/a>/g)) out.add(m[1]!);
    const h = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (h) out.add(headingSlug(h[1]!));
  });
  return out;
}

/** A fenced code block whose fence is longer than any backtick run in `body`. */
export function fenced(lang: string, body: string): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${body}\n${fence}`;
}

/** An explicit anchor, for a target that must resolve in every site generator. */
export const anchor = (id: string): string => `<a id="${id}"></a>`;

/** A Markdown table. Each cell is one line; a `|` in a cell is escaped. */
export function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const cell = (s: string) => s.replace(/\n/g, " ").replace(/\|/g, "\\|");
  return [
    `| ${head.map(cell).join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

/** `text` as an inline code span, with a fence longer than any backtick run inside it. */
export function code(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Indent every line but the first by `n` spaces (empty lines stay empty): a list item's body. */
export function hang(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l, i) => (i === 0 || l === "" ? l : pad + l))
    .join("\n");
}
