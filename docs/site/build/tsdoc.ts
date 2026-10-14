// The code side of the generated Reference (ADR-0072): one TypeScript program over the kit's
// sources, and the TSDoc of a declaration read as the author-facing text it is. The compiler finds
// each declaration — through every re-export, to the file that declares it — and gives its source
// text; the TSDoc itself is read from that text here, so the prose, its line breaks and its
// examples reach the page exactly as written, with a source line for each error.

import ts from "typescript";
import { join, relative } from "node:path";
import { code, type BuildError } from "./markdown.ts";

export type Program = { program: ts.Program; checker: ts.TypeChecker; repo: string };

/** The program every Reference generator reads: the kit's `internal` root (which holds the
 * Authoring surface and the rest) and `@jr2/machines`. */
export function createProgram(repo: string): Program {
  const roots = ["packages/orchestrator/src/internal.ts", "packages/machines/src/index.ts"].map((p) => join(repo, p));
  const program = ts.createProgram(roots, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    types: ["node"],
  });
  return { program, checker: program.getTypeChecker(), repo };
}

export function sourceFile(p: Program, repoPath: string): ts.SourceFile {
  const sf = p.program.getSourceFile(join(p.repo, repoPath));
  if (!sf) throw new Error(`docs:build: ${repoPath} is not in the program`);
  return sf;
}

/** The symbol a module exports under `name`, followed through every alias to its declaration. */
export function exportedSymbol(p: Program, sf: ts.SourceFile, name: string): ts.Symbol | undefined {
  const mod = p.checker.getSymbolAtLocation(sf);
  const sym = mod && p.checker.getExportsOfModule(mod).find((s) => s.name === name);
  return sym && resolveAlias(p, sym);
}

export const resolveAlias = (p: Program, s: ts.Symbol): ts.Symbol =>
  s.flags & ts.SymbolFlags.Alias ? p.checker.getAliasedSymbol(s) : s;

/** Repo-relative path and 1-based line of a node, for an error. */
export function where(p: Program, node: ts.Node): { file: string; line: number } {
  const sf = node.getSourceFile();
  return {
    file: relative(p.repo, sf.fileName),
    line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
  };
}

/** True for a declaration in the kit's own sources, not in a dependency or the TS lib. */
export function isKitSource(p: Program, node: ts.Node): boolean {
  const file = relative(p.repo, node.getSourceFile().fileName);
  return file.startsWith("packages/") && !file.includes("node_modules");
}

// ---- TSDoc ------------------------------------------------------------------------------------

export type Tag = { name: string; text: string; line: number };
export type Doc = { summary: string; tags: Tag[]; file: string; line: number };

/** The JSDoc block that documents `node`: the last one before it (a variable's sits on its
 * statement). */
export function jsDocNode(node: ts.Node): ts.JSDoc | undefined {
  return ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc).at(-1);
}

/** The TSDoc of `node`, read from its source text: the summary and each block tag. A line that
 * starts with `@` inside a fenced block is the block's, not a tag. */
export function docOf(p: Program, node: ts.Node): Doc | undefined {
  const js = jsDocNode(node);
  if (!js) return undefined;
  const sf = node.getSourceFile();
  const startLine = sf.getLineAndCharacterOfPosition(js.getStart()).line + 1;
  const raw = sf.text.slice(js.getStart(), js.end);
  const lines = raw
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l, i) => (i === 0 ? l.replace(/^ /, "") : l.replace(/^\s*\* ?/, "").replace(/^\s*\*?$/, "")));
  const summary: string[] = [];
  const tags: Tag[] = [];
  let fence: string | undefined;
  lines.forEach((line, i) => {
    const f = /^(`{3,}|~{3,})/.exec(line);
    const inFence = fence !== undefined;
    if (f) fence = !inFence ? f[1] : line.startsWith(fence!) ? undefined : fence;
    const t = !inFence && !f ? /^@(\w+)\s?(.*)$/.exec(line) : null;
    if (t) tags.push({ name: t[1]!, text: t[2]!, line: startLine + i });
    else if (tags.length) tags[tags.length - 1]!.text += `\n${line}`;
    else summary.push(line);
  });
  for (const t of tags) t.text = t.text.replace(/\s+$/, "");
  return { summary: summary.join("\n").trim(), tags, ...where(p, js) };
}

/** The text of a TSDoc with each `{@link X}` made Markdown: a link when `linkTo` knows `X`, code
 * otherwise. */
export function renderInline(text: string, linkTo: (name: string) => string | undefined): string {
  return text.replace(
    /\{@link(?:code|plain)?\s+([^}|\s]+)(?:\s*\|\s*([^}]*)|\s+([^}]*))?\}/g,
    (_, name: string, a, b) => {
      const label = (a ?? b)?.trim();
      const href = linkTo(name);
      const shown = label ? label : code(name);
      return href ? `[${shown}](${href})` : shown;
    },
  );
}

/** A `@param` tag's name and text: `name - text`, `name text`, or `{type} name text`. */
export function paramTag(t: Tag): { name: string; text: string } {
  const m = /^(?:\{[^}]*\}\s*)?\[?([\w.$]+)\]?\s*(?:-\s*)?([\s\S]*)$/.exec(t.text.trim());
  return { name: m?.[1] ?? "", text: flow(m?.[2] ?? "") };
}

/** A tag's prose with the hanging indent of its continuation lines taken off. */
export const flow = (text: string): string => text.trim().replace(/\n[ \t]+/g, "\n");

/** A `@see` tag's target: the bundle path inside `docs/`, as the kit writes them
 * (`docs/guides/x.md`). */
export function seeTarget(t: Tag): string {
  return t.text.trim().split(/\s+/)[0] ?? "";
}

/** An error at a tag's line. */
export const tagError = (doc: Doc, t: Tag, message: string): BuildError => ({ file: doc.file, line: t.line, message });

// ---- source text ------------------------------------------------------------------------------

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** A node printed without its comments, at the compiler's layout. */
export function printed(node: ts.Node): string {
  // A node the checker builds (`typeToTypeNode`) is in no source file.
  return printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile() ?? EMPTY);
}

const EMPTY = ts.createSourceFile("built.ts", "", ts.ScriptTarget.Latest);

/** The declared text of a type node on one line, comments dropped. */
export function typeText(node: ts.TypeNode | undefined): string {
  return node ? printed(node).replace(/\s+/g, " ").trim() : "unknown";
}

/** A function declaration's signature: the declaration without its body, `export` and comments,
 * each part as its declared text. One line when it fits; otherwise one type parameter and one
 * parameter per line. */
export function functionSignature(d: ts.FunctionDeclaration): string {
  const name = d.name?.getText() ?? "";
  const tps = d.typeParameters?.map(partText) ?? [];
  const params = d.parameters.map(partText);
  const ret = d.type ? `: ${partText(d.type)}` : "";
  const one = `function ${name}${tps.length ? `<${tps.join(", ")}>` : ""}(${params.join(", ")})${ret}`;
  if (one.split("\n").every((l) => l.length <= 100)) return one;
  const each = (xs: string[]) => xs.map((x) => `  ${x.replace(/\n/g, "\n  ")},`).join("\n");
  const typeList = tps.length ? `<\n${each(tps)}\n>` : "";
  return `function ${name}${typeList}(\n${each(params)}\n)${ret}`;
}

/** A node's own source text, as the author laid it out, with each comment taken out and the lines
 * that leaves empty dropped. The printer would re-lay out a large type (a conditional tuple type
 * becomes one token per line), so a declaration is shown from its text. */
export function declaredText(node: ts.Node): string {
  const sf = node.getSourceFile();
  const start = node.getStart(sf);
  const end = node.getEnd();
  const cuts = new Map<number, number>();
  const visit = (n: ts.Node) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const ranges = [
      ...(ts.getLeadingCommentRanges(sf.text, n.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(sf.text, n.getEnd()) ?? []),
    ];
    for (const r of ranges) if (r.pos >= start && r.end <= end) cuts.set(r.pos, r.end);
    n.getChildren(sf).forEach(visit);
  };
  visit(node);
  let out = "";
  let at = start;
  for (const [pos, to] of [...cuts].sort((a, b) => a[0] - b[0])) {
    if (pos < at) continue;
    out += sf.text.slice(at, pos);
    at = to;
  }
  out += sf.text.slice(at, end);
  return out
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l !== "")
    .join("\n")
    .replace(/^export\s+/, "");
}

/** A part of a declaration as its declared text, its later lines moved left by the indent of the
 * line it starts on, so that the text sits at column 0 wherever the source puts it. */
function partText(node: ts.Node): string {
  const sf = node.getSourceFile();
  const start = node.getStart(sf);
  const lineStart = sf.text.lastIndexOf("\n", start - 1) + 1;
  const indent = /^[ \t]*/.exec(sf.text.slice(lineStart, start))![0].length;
  const strip = new RegExp(`\n[ \t]{0,${indent}}`, "g");
  return declaredText(node).replace(strip, "\n");
}

/** A type alias or an interface as its declared text, comments dropped. */
export function typeAliasSignature(d: ts.TypeAliasDeclaration | ts.InterfaceDeclaration): string {
  return declaredText(d);
}

/** A variable's signature: its annotation, or its inferred type when that is short, or the name
 * of that type when it is not. */
export function variableSignature(p: Program, d: ts.VariableDeclaration, sym: ts.Symbol): string {
  const name = d.name.getText();
  if (d.type) return `const ${name}: ${typeText(d.type)}`;
  const type = p.checker.getTypeOfSymbol(sym);
  const full = p.checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  if (full.length <= 200) return `const ${name}: ${full}`;
  const named = (type.aliasSymbol ?? type.getSymbol())?.name;
  return `const ${name}: ${named && !named.startsWith("__") ? `${named}<…>` : p.checker.typeToString(type)}`;
}
