// The source format's directives, made plain Markdown for the bundle (ADR-0072, docs/site/README.md).
// A page in docs/site may use the asides, the tabs, and `::include`; the bundle holds CommonMark +
// GFM only, so each becomes what a reader of the raw file reads well:
//
//   :::note … :::                  > **Note** … (a blockquote whose first line is the kind)
//   ::::tabs / :::tab{label} …     **<label>**, then the tab's content, for each tab
//   ::include{file lines}          a fenced block, its language from the file's extension
//
// Mermaid fences are code, so they pass as they are. The checks here are the format's own: a
// directive is well formed, alone on its line with an empty line on each side, and closed; an
// include names a file that exists and lines inside it; and no page uses one generator's syntax.

import { readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { codeLines, fenced, proseLines, type BuildError } from "./markdown.ts";

const ASIDES = { note: "Note", tip: "Tip", caution: "Caution", danger: "Danger" } as const;
type AsideKind = keyof typeof ASIDES;

const ASIDE_OPEN = /^:::(note|tip|caution|danger)$/;
const TABS_OPEN = /^::::tabs$/;
const TAB_OPEN = /^:::tab\{label="([^"]+)"\}$/;
const CLOSE = /^:::$/;
const TABS_CLOSE = /^::::$/;
const INCLUDE = /^::include\{file="([^"]+)"(?: lines="(\d+)(?:-(\d+))?")?\}$/;
/** Anything that looks like a directive: a line that starts with `::`, after any indent. */
const DIRECTIVE_LIKE = /^\s*::/;

/** The language of an included file's fence, by extension; the bare extension otherwise. */
const LANGS: Record<string, string> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sh": "sh",
  ".md": "md",
};
export const langOf = (file: string): string => {
  const ext = extname(file).toLowerCase();
  return LANGS[ext] ?? ext.slice(1);
};

type Node =
  | { kind: "line"; text: string }
  | { kind: "aside"; aside: AsideKind; children: Node[] }
  | { kind: "tabs"; tabs: { label: string; children: Node[] }[] }
  | { kind: "include"; body: string; lang: string };

export type ConvertOptions = {
  /** The page's path, repo-relative, for errors. */
  file: string;
  /** The page's directory on disk: an include's `file` is relative to it. */
  dir: string;
  /** The repo root on disk, to name an include in an error. */
  repo: string;
  /** The page line that `text`'s first line is. */
  firstLine?: number;
};

/** Convert the directives in a page body to plain Markdown, or say why they are not well formed. */
export function convertDirectives(text: string, opts: ConvertOptions): { text: string; errors: BuildError[] } {
  const lines = text.split("\n");
  const code = codeLines(lines);
  const first = opts.firstLine ?? 1;
  const errors: BuildError[] = [];
  const err = (i: number, message: string) => errors.push({ file: opts.file, line: first + i, message });

  type Frame =
    | { kind: "root"; children: Node[] }
    | { kind: "aside"; aside: AsideKind; children: Node[]; line: number }
    | { kind: "tabs"; tabs: { label: string; children: Node[] }[]; line: number }
    | { kind: "tab"; label: string; children: Node[]; line: number };
  const root: Frame = { kind: "root", children: [] };
  const stack: Frame[] = [root];
  const top = () => stack[stack.length - 1]!;
  const push = (n: Node, i: number) => {
    const t = top();
    if (t.kind !== "tabs") return void t.children.push(n);
    if (n.kind !== "line" || n.text.trim() !== "") err(i, "only :::tab blocks and empty lines go inside ::::tabs");
  };

  lines.forEach((raw, i) => {
    if (code[i] || !DIRECTIVE_LIKE.test(raw)) {
      push({ kind: "line", text: raw }, i);
      return;
    }
    const line = raw.trimEnd();
    if (/^\s/.test(line)) return err(i, `a directive starts at column 0: "${line.trim()}"`);
    const alone = (i === 0 || lines[i - 1]!.trim() === "") && (i === lines.length - 1 || lines[i + 1]!.trim() === "");
    if (!alone) err(i, `a directive line needs an empty line before it and after it: "${line}"`);
    let m: RegExpExecArray | null;
    if ((m = ASIDE_OPEN.exec(line))) {
      if (top().kind === "tabs") return err(i, "only :::tab blocks go inside ::::tabs");
      stack.push({ kind: "aside", aside: m[1] as AsideKind, children: [], line: i });
    } else if (TABS_OPEN.test(line)) {
      if (top().kind === "tabs") return err(i, "::::tabs cannot hold ::::tabs");
      stack.push({ kind: "tabs", tabs: [], line: i });
    } else if ((m = TAB_OPEN.exec(line))) {
      if (top().kind !== "tabs") return err(i, ":::tab is only inside ::::tabs");
      stack.push({ kind: "tab", label: m[1]!, children: [], line: i });
    } else if (CLOSE.test(line)) {
      const t = top();
      if (t.kind === "aside") {
        stack.pop();
        push({ kind: "aside", aside: t.aside, children: t.children }, i);
      } else if (t.kind === "tab") {
        stack.pop();
        (top() as Extract<Frame, { kind: "tabs" }>).tabs.push({ label: t.label, children: t.children });
      } else err(i, "::: closes nothing");
    } else if (TABS_CLOSE.test(line)) {
      const t = top();
      if (t.kind !== "tabs") return err(i, ":::: closes no ::::tabs");
      stack.pop();
      if (t.tabs.length === 0) err(t.line, "::::tabs holds no :::tab");
      push({ kind: "tabs", tabs: t.tabs }, i);
    } else if ((m = INCLUDE.exec(line))) {
      const included = include(m[1]!, m[2], m[3], opts);
      if (typeof included === "string") return err(i, included);
      push(included, i);
    } else err(i, `not a directive: "${line}" (see docs/site/README.md)`);
  });
  for (const f of stack.slice(1).reverse()) {
    if (f.kind === "root") continue;
    const name = f.kind === "aside" ? `:::${f.aside}` : f.kind === "tabs" ? "::::tabs" : `:::tab{label="${f.label}"}`;
    err(f.line, `${name} is not closed`);
  }
  return { text: render(root.children).join("\n"), errors };
}

/** The `Node` an `::include` stands for, or why it cannot. */
function include(file: string, from: string | undefined, to: string | undefined, opts: ConvertOptions): Node | string {
  const path = join(opts.dir, file);
  const shown = relative(opts.repo, path);
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return `::include names ${shown}, which does not exist`;
  }
  const all = body.replace(/\n$/, "").split("\n");
  let picked = all;
  if (from !== undefined) {
    const a = Number(from);
    const b = to === undefined ? a : Number(to);
    if (a < 1 || b < a || b > all.length)
      return `::include lines="${from}${to === undefined ? "" : `-${to}`}" is outside ${shown}, which has ${all.length} lines`;
    picked = dedent(all.slice(a - 1, b));
  }
  return { kind: "include", body: picked.join("\n"), lang: langOf(file) };
}

/** Lines with their common leading whitespace taken off, so that a range from inside a block reads
 * as a block. */
function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)![0].length);
  const n = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(n));
}

/** `nodes` without the empty lines at either end. */
function trimmed(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.trim() === "") a++;
  while (b > a && lines[b - 1]!.trim() === "") b--;
  return lines.slice(a, b);
}

function render(nodes: Node[]): string[] {
  return nodes.flatMap((n): string[] => {
    switch (n.kind) {
      case "line":
        return [n.text];
      case "include":
        return fenced(n.lang, n.body).split("\n");
      case "aside":
        return [
          `> **${ASIDES[n.aside]}**`,
          ">",
          ...trimmed(render(n.children)).map((l) => (l.trim() === "" ? ">" : `> ${l}`)),
        ];
      case "tabs":
        return n.tabs.flatMap((t, i) => [
          ...(i === 0 ? [] : [""]),
          `**${t.label}**`,
          "",
          ...trimmed(render(t.children)),
        ]);
    }
  });
}

/** Syntax that only one site generator knows, which the source format shuts out. */
// MDX reads ESM only where a block starts, so `blockStart` keeps a wrapped prose line that starts
// with the verb "import" or "export" from failing.
const GENERATOR_SYNTAX: { test: RegExp; what: string; blockStart?: true }[] = [
  { test: /\{\{/, what: "a Vue mustache ({{ … }})" },
  { test: /<\/?[A-Z][\w.]*(?=[\s/>])/, what: "a JSX or MDX tag" },
  { test: /^(?:import|export)\s/, what: "an MDX import or export line", blockStart: true },
  { test: /^<<<\s/, what: "a VitePress code import (<<<); use ::include" },
];

/** Every line of prose (not code) in `text` that uses one generator's syntax. */
export function generatorSyntax(text: string, file: string, firstLine = 1): BuildError[] {
  const errors: BuildError[] = [];
  const lines = text.split("\n");
  proseLines(lines).forEach((prose, i) => {
    if (prose === undefined) return;
    const starts = i === 0 || lines[i - 1]!.trim() === "";
    for (const g of GENERATOR_SYNTAX)
      if ((starts || !g.blockStart) && g.test.test(prose))
        errors.push({ file, line: firstLine + i, message: `${g.what} is not in the source format` });
  });
  return errors;
}

/** Each H1 in a source page: its title is in the frontmatter, and the bundle adds the H1. */
export function headingOnes(text: string, file: string, firstLine = 1): BuildError[] {
  const lines = text.split("\n");
  const code = codeLines(lines);
  return lines.flatMap((line, i) =>
    !code[i] && /^# /.test(line)
      ? [{ file, line: firstLine + i, message: "a source page has no H1: its title is the frontmatter's `title`" }]
      : [],
  );
}
