// The source format is VitePress's own Markdown (ADR-0072, docs/site/README.md); the bundle holds
// CommonMark + GFM only. This module is the one place that knows the generator's syntax: it makes
// each form plain, and it checks that a page uses only the forms it knows.
//
//   ::: info|tip|warning|danger …   > **Note** … (a blockquote whose first line is the label)
//   ::: tabs key:provider / == X    **X**, then the tab's content, for each tab (vitepress-plugin-tabs)
//   ::: code-group, fences [X]      **X**, then the fence without its title, for each fence
//   <<< @/examples/f.ts#region      a fenced block of the file, or of its region; language from
//                                   `{lang}` or from the file's extension
//   ::: diagram layers|steps [title] **title**, then the list it holds, as it is: the site draws the
//                                   list (.vitepress/diagram.ts), and the list is the diagram's text
//
// Mermaid fences are code, so they pass as they are. markdown-it-container ends a container at the
// first closing line with at least as many colons, and does not count the containers inside it.
// So a container inside another has fewer colons than its parent, and a close has exactly the
// colons of its open: then the stack below reads a page as VitePress does.

import { readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import { codeLines, fenced, proseLines, type BuildError } from "./markdown.ts";

// The labels that the format had before VitePress (Note, Caution), kept: the site shows the same ones
// (`markdown.container` in .vitepress/config.ts), so the bundle does not change with the generator.
const ASIDES = { info: "Note", tip: "Tip", warning: "Caution", danger: "Danger" } as const;
type AsideKind = keyof typeof ASIDES;

const ASIDE_OPEN = /^(:{3,}) (info|tip|warning|danger)$/;
const TABS_OPEN = /^(:{3,}) tabs(?: key:([\w-]+))?$/;
const GROUP_OPEN = /^(:{3,}) code-group$/;
/** `::: diagram <layout> [title]`: the layouts that .vitepress/diagram.ts draws. */
export const DIAGRAM_LAYOUTS = ["layers", "steps"] as const;
const DIAGRAM_OPEN = /^(:{3,}) diagram(?: (\S+))?(?: (\S.*))?$/;
const CLOSE = /^(:{3,})$/;
const TAB = /^== (\S.*)$/;
/** `<<< @/<path>[#region][{lang}][ [title]]`: the part of VitePress's snippet syntax the format
 * keeps. Line highlights (`{1,3}`) and attributes are not in it. */
const SNIPPET = /^<<< @\/([^\s#{[]+)(?:#([\w-]+))?(?:\{([\w-]+)\})?(?: \[([^\]]+)\])?$/;
/** A line VitePress may read as a container or a snippet: one that starts with `::` or `<<<`. */
const SYNTAX_LIKE = /^\s*(?:::|<<<)/;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;

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

// The region markers VitePress finds (findRegion in its snippet plugin): `// #region x`, and `#`
// and HTML comment forms. A marker line is never shown, in the site or in the bundle.
const REGION_MARKER = [
  /^\/\/ ?#?((?:end)?region) ([\w*-]+)$/,
  /^\/\* ?#((?:end)?region) ([\w*-]+) ?\*\/$/,
  /^<!-- #?((?:end)?region) ([\w*-]+) -->$/,
  /^# ?((?:end)?region) ([\w*-]+)$/,
];
const markerOf = (line: string): { end: boolean; name: string } | undefined => {
  for (const re of REGION_MARKER) {
    const m = re.exec(line.trim());
    if (m) return { end: m[1]!.toLowerCase() === "endregion", name: m[2]! };
  }
  return undefined;
};

/** A file's text without its region markers: what a whole-file `<<<` shows. */
export const withoutRegions = (text: string): string =>
  text
    .split("\n")
    .filter((l) => !markerOf(l))
    .join("\n");

/** The lines of a region, its markers and those of the regions inside it taken off, dedented as
 * VitePress dedents them; or undefined when the file has no such region. */
export function regionOf(text: string, name: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => markerOf(l)?.name === name && !markerOf(l)!.end);
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && markerOf(l)?.name === name && markerOf(l)!.end);
  if (end < 0) return undefined;
  return dedent(lines.slice(start + 1, end).filter((l) => !markerOf(l))).join("\n");
}

type Node =
  | { kind: "line"; text: string }
  | { kind: "aside"; aside: AsideKind; children: Node[] }
  | { kind: "tabs"; tabs: { label: string; children: Node[] }[] }
  | { kind: "diagram"; title?: string; children: Node[] }
  | { kind: "code"; label?: string; body: string; lang: string };

export type ConvertOptions = {
  /** The page's path, repo-relative, for errors. */
  file: string;
  /** docs/site on disk: `@/` in a snippet is this folder, as VitePress's srcDir. */
  site: string;
  /** The repo root on disk, to name a snippet's file in an error. */
  repo: string;
  /** The page line that `text`'s first line is. */
  firstLine?: number;
};

/** Make a page body plain Markdown, or say why its VitePress syntax is not well formed. */
export function toPlainMarkdown(text: string, opts: ConvertOptions): { text: string; errors: BuildError[] } {
  const lines = text.split("\n");
  const code = codeLines(lines);
  const first = opts.firstLine ?? 1;
  const errors: BuildError[] = [];
  const err = (i: number, message: string) => errors.push({ file: opts.file, line: first + i, message });

  type Frame =
    | { kind: "root"; children: Node[] }
    | { kind: "aside"; aside: AsideKind; colons: number; children: Node[]; line: number }
    | { kind: "tabs"; colons: number; tabs: { label: string; children: Node[] }[]; line: number }
    | { kind: "group"; colons: number; fences: Extract<Node, { kind: "code" }>[]; line: number }
    | { kind: "diagram"; colons: number; layout: string; title?: string; children: Node[]; line: number };
  const root: Frame = { kind: "root", children: [] };
  const stack: Frame[] = [root];
  const top = () => stack[stack.length - 1]!;
  const push = (n: Node, i: number) => {
    const t = top();
    if (t.kind === "root" || t.kind === "aside" || t.kind === "diagram") return void t.children.push(n);
    if (t.kind === "tabs") {
      const tab = t.tabs[t.tabs.length - 1];
      if (tab) return void tab.children.push(n);
      if (n.kind !== "line" || n.text.trim() !== "") err(i, "::: tabs starts with a tab: `== <label>`");
      return;
    }
    if (n.kind === "code" && n.label) return void t.fences.push(n);
    if (n.kind !== "line" || n.text.trim() !== "")
      err(i, "only fences and <<< lines with a [title] go inside ::: code-group");
  };
  const nest = (colons: number, i: number): boolean => {
    const t = top();
    if (t.kind === "root" || colons < t.colons) return true;
    err(i, `a container inside another has fewer colons than it: write the outer one with ${colons + 1} or more`);
    return false;
  };
  const alone = (i: number) =>
    (i === 0 || lines[i - 1]!.trim() === "") && (i === lines.length - 1 || lines[i + 1]!.trim() === "");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (code[i]) {
      // A fence. Inside a code group it is one tab, and its title is the label; elsewhere its
      // info is its language only, since the bundle is plain GFM.
      const j = fenceEnd(lines, i);
      const block = lines.slice(i, j + 1);
      const info = FENCE_OPEN.exec(raw.trim())![2]!.trim();
      if (top().kind === "group") {
        const m = /^([\w-]*) \[([^\]]+)\]$/.exec(info);
        if (!m) err(i, `a fence in ::: code-group has a language and a [title]: "${raw}"`);
        else push({ kind: "code", lang: m[1]!, label: m[2]!, body: block.slice(1, -1).join("\n") }, i);
      } else {
        if (info !== "" && !/^[\w+#.-]+$/.test(info))
          err(i, `a fence's info is its language only, not "${info}": the bundle is plain Markdown`);
        for (const l of block) push({ kind: "line", text: l }, i);
      }
      i = j;
      continue;
    }
    if (!SYNTAX_LIKE.test(raw) && !(top().kind === "tabs" && /^==/.test(raw))) {
      push({ kind: "line", text: raw }, i);
      continue;
    }
    const line = raw.trimEnd();
    if (/^\s/.test(line)) {
      err(i, `a container or a <<< starts at column 0: "${line.trim()}"`);
      continue;
    }
    if (!alone(i)) err(i, `this line needs an empty line before it and after it: "${line}"`);
    let m: RegExpExecArray | null;
    if ((m = ASIDE_OPEN.exec(line))) {
      if (nest(m[1]!.length, i))
        stack.push({ kind: "aside", aside: m[2] as AsideKind, colons: m[1]!.length, children: [], line: i });
    } else if ((m = TABS_OPEN.exec(line))) {
      // The one tab set of the format is the provider tabs: with no key, or another, the reader's
      // choice would not hold across the pages (README "Provider tabs").
      if (m[2] !== "provider") {
        err(i, `tabs take the key provider, so that the reader's choice holds on each page: "::: tabs key:provider"`);
      }
      if (nest(m[1]!.length, i)) stack.push({ kind: "tabs", colons: m[1]!.length, tabs: [], line: i });
    } else if ((m = GROUP_OPEN.exec(line))) {
      if (nest(m[1]!.length, i)) stack.push({ kind: "group", colons: m[1]!.length, fences: [], line: i });
    } else if ((m = DIAGRAM_OPEN.exec(line))) {
      if (!(DIAGRAM_LAYOUTS as readonly string[]).includes(m[2] ?? ""))
        err(i, `a diagram names its layout, one of ${DIAGRAM_LAYOUTS.join(", ")}: "::: diagram layers [title]"`);
      if (nest(m[1]!.length, i))
        stack.push({ kind: "diagram", colons: m[1]!.length, layout: m[2] ?? "", title: m[3], children: [], line: i });
    } else if ((m = TAB.exec(line)) && top().kind === "tabs") {
      (top() as Extract<Frame, { kind: "tabs" }>).tabs.push({ label: m[1]!, children: [] });
    } else if ((m = CLOSE.exec(line))) {
      const t = top();
      if (t.kind === "root") {
        err(i, `${line} closes nothing`);
        continue;
      }
      if (m[1]!.length !== t.colons) {
        err(i, `${line} closes a container that opened with ${t.colons} colons`);
        continue;
      }
      stack.pop();
      if (t.kind === "aside") push({ kind: "aside", aside: t.aside, children: t.children }, i);
      else if (t.kind === "diagram") {
        const err_ = diagramList(t.layout, t.children);
        if (err_) err(t.line, err_);
        push({ kind: "diagram", title: t.title, children: t.children }, i);
      } else if (t.kind === "tabs") {
        if (t.tabs.length === 0) err(t.line, "::: tabs holds no tab");
        push({ kind: "tabs", tabs: t.tabs }, i);
      } else {
        if (t.fences.length === 0) err(t.line, "::: code-group holds no fence");
        push(
          { kind: "tabs", tabs: t.fences.map((f) => ({ label: f.label!, children: [{ ...f, label: undefined }] })) },
          i,
        );
      }
    } else if ((m = SNIPPET.exec(line))) {
      const included = snippet(m[1]!, m[2], m[3], opts);
      if (typeof included === "string") err(i, included);
      else {
        if (m[4] && top().kind !== "group") err(i, `a <<< has a [title] only inside ::: code-group: "${line}"`);
        if (!m[4] && top().kind === "group") err(i, `a <<< inside ::: code-group has a [title]: "${line}"`);
        push({ ...included, label: m[4] }, i);
      }
    } else if (line.startsWith("<<<")) err(i, `not a code import of the format: "${line}" (see docs/site/README.md)`);
    else err(i, `not a container of the format: "${line}" (see docs/site/README.md)`);
  }
  for (const f of stack.slice(1).reverse()) {
    if (f.kind === "root") continue;
    const name =
      f.kind === "aside"
        ? `::: ${f.aside}`
        : f.kind === "tabs"
          ? "::: tabs"
          : f.kind === "diagram"
            ? "::: diagram"
            : "::: code-group";
    err(f.line, `${name} is not closed`);
  }
  return { text: render(root.children).join("\n"), errors };
}

/** Why a diagram's body is not the one list that its layout draws, or undefined when it is: a
 * `layers` diagram holds a bullet list, and a `steps` diagram an ordered list. */
function diagramList(layout: string, children: Node[]): string | undefined {
  const lines = trimmed(children.map((c) => (c.kind === "line" ? c.text : "\0")));
  if (lines.some((l) => l === "\0" || FENCE_OPEN.test(l.trim())))
    return "a diagram holds one list, and no container or code";
  const item = layout === "steps" ? /^\d+\. / : /^- /;
  const kind = layout === "steps" ? "an ordered list (1. …)" : "a bullet list (- …)";
  if (lines.length === 0) return "::: diagram holds no list";
  if (lines.some((l) => l.trim() === "")) return `a diagram holds one tight list, with no empty line: ${kind}`;
  if (!lines.every((l) => item.test(l) || /^\s/.test(l))) return `a ${layout} diagram holds ${kind} only`;
  return undefined;
}

/** The line that closes the fence that line `i` opens, or the last line when it is not closed. */
function fenceEnd(lines: readonly string[], i: number): number {
  const open = FENCE_OPEN.exec(lines[i]!.trim())![1]!;
  for (let j = i + 1; j < lines.length; j++) {
    const m = FENCE_OPEN.exec(lines[j]!.trim());
    if (m && m[1]![0] === open[0] && m[1]!.length >= open.length && m[2]!.trim() === "") return j;
  }
  return lines.length - 1;
}

/** The `Node` a `<<<` stands for, or why it cannot. */
function snippet(
  file: string,
  region: string | undefined,
  lang: string | undefined,
  opts: ConvertOptions,
): Extract<Node, { kind: "code" }> | string {
  const path = join(opts.site, file);
  const shown = relative(opts.repo, path);
  // A page shows example code only, and `pnpm typecheck` checks what is in examples/ (README
  // "Examples"). A path out of it, or one that climbs out with `..`, is refused before it is read.
  const examples = join(opts.site, "examples");
  if (relative(examples, path).startsWith("..") || isAbsolute(relative(examples, path))) {
    return `<<< names ${shown}; a page shows only a file in docs/site/examples/`;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
  } catch {
    return `<<< names ${shown}, which does not exist`;
  }
  let body = withoutRegions(text);
  if (region !== undefined) {
    const r = regionOf(text, region);
    if (r === undefined) return `<<< names the region #${region}, which ${shown} does not have`;
    body = r;
  }
  return { kind: "code", body, lang: lang ?? langOf(file) };
}

/** Lines with their common leading whitespace taken off, so that a region from inside a block
 * reads as a block. */
function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)![0].length);
  const n = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(n));
}

/** `lines` without the empty lines at either end. */
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
      case "code":
        return fenced(n.lang, n.body).split("\n");
      case "aside":
        return [
          `> **${ASIDES[n.aside]}**`,
          ">",
          ...trimmed(render(n.children)).map((l) => (l.trim() === "" ? ">" : `> ${l}`)),
        ];
      case "diagram":
        return [...(n.title ? [`**${n.title}**`, ""] : []), ...trimmed(render(n.children))];
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

/** What VitePress reads in prose that the bundle cannot carry, and that this module does not
 * convert. */
const GENERATOR_SYNTAX: { test: RegExp; what: string }[] = [
  { test: /\{\{/, what: "a Vue interpolation ({{ … }})" },
  { test: /^\[\[toc\]\]$/, what: "a VitePress [[toc]]" },
  { test: /<!--\s*@include:/, what: "a VitePress Markdown include (<!--@include:-->); use <<<" },
  { test: /^\s*(?:>\s*)+\[!\w+\]/, what: "a GitHub alert (> [!NOTE]); use an aside (::: info)" },
];

/** A raw HTML tag in prose: `<name` before a space, `/` or `>`, or its closing tag. An autolink
 * (`<https://…>`) is not one. Vue compiles each tag, and one that is not closed fails the site. */
const HTML_TAG = /<\/?[A-Za-z][\w-]*(?=[\s/>])/g;

/** Every line of prose (not code) in `text` that uses VitePress syntax the bundle cannot carry. */
export function generatorSyntax(text: string, file: string, firstLine = 1): BuildError[] {
  const errors: BuildError[] = [];
  const lines = text.split("\n");
  proseLines(lines).forEach((prose, i) => {
    if (prose === undefined) return;
    const tag = [...prose.matchAll(HTML_TAG)].find((m) => !ANCHOR_TAG.test(prose.slice(m.index)));
    if (tag)
      errors.push({
        file,
        line: firstLine + i,
        message: `a raw HTML tag (${tag[0]}) is not in the source format: put it in a code span, or write &lt;`,
      });
    // Even inside a code span: VitePress ends the paragraph there (see `vueSafe`).
    const raw = lines[i]!.trimStart();
    if (!tag && i > 0 && lines[i - 1]!.trim() !== "" && TAG_START.test(raw) && !ANCHOR_TAG.test(raw))
      errors.push({
        file,
        line: firstLine + i,
        message:
          "VitePress reads a line that starts with a tag as a Vue component: rewrap it so the line does not start with <",
      });
    for (const g of GENERATOR_SYNTAX)
      if (g.test.test(prose))
        errors.push({ file, line: firstLine + i, message: `${g.what} is not in the source format` });
  });
  return errors;
}

/** Each H1 in a source page: its title is in the frontmatter, and the bundle and the site add the
 * H1. */
export function headingOnes(text: string, file: string, firstLine = 1): BuildError[] {
  const lines = text.split("\n");
  const code = codeLines(lines);
  return lines.flatMap((line, i) =>
    !code[i] && /^# /.test(line)
      ? [{ file, line: firstLine + i, message: "a source page has no H1: its title is the frontmatter's `title`" }]
      : [],
  );
}

// VitePress compiles each page to a Vue template, which reads HTML more strictly than CommonMark.
// A line that starts with a tag is a Vue component block, even inside a paragraph, and a tag that is
// not closed fails the build. The generated pages are plain Markdown that does not know this: a
// TSDoc refusal can wrap with `<slots>` at the start of a line, inside its code span, and an ADR can
// write `<n>` in prose. The site's copy of those pages is made safe; the bundle keeps them as they
// are.
const ANCHOR_TAG = /^<a id="[^"]*"><\/a>|^<\/a>/;
// As HTML_TAG: an autolink (`<https://…>`) is not a tag.
const TAG_START = /^<\/?[A-Za-z][\w-]*(?=[\s/>]|$)/;

/** `text` as VitePress can compile it: a prose line that starts with a tag joins the line before,
 * and each `<` of a tag in prose (but an anchor) becomes `&lt;`. Code is not changed. */
export function vueSafe(text: string): string {
  const lines = text.split("\n");
  const code = codeLines(lines);
  const joined: string[] = [];
  const joinedCode: boolean[] = [];
  lines.forEach((line, i) => {
    const prev = joined[joined.length - 1];
    const continues =
      !code[i] &&
      prev !== undefined &&
      !joinedCode[joinedCode.length - 1] &&
      prev.trim() !== "" &&
      !/^\s*(?:#{1,6}\s|\|)/.test(prev) &&
      TAG_START.test(line.trimStart()) &&
      !ANCHOR_TAG.test(line.trimStart());
    if (continues) joined[joined.length - 1] = `${prev} ${line.trimStart()}`;
    else {
      joined.push(line);
      joinedCode.push(code[i]!);
    }
  });
  const prose = proseLines(joined);
  return joined
    .map((line, i) => {
      const masked = prose[i];
      if (masked === undefined) return line;
      let out = "";
      for (let k = 0; k < line.length; k++) {
        if (masked[k] === "<" && TAG_START.test(masked.slice(k)) && !ANCHOR_TAG.test(masked.slice(k))) out += "&lt;";
        else if (masked[k] === "{" && masked[k + 1] === "{") out += "&#123;";
        else out += line[k];
      }
      return out;
    })
    .join("\n");
}
