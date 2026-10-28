// The Authoring surface and `@jr2/machines` pages (ADR-0072): each name a package root exports, in
// the root's own groups and order, followed through its re-exports to the declaration the compiler
// finds. Per name: its kind, its signature, and its TSDoc — the summary, the params with the fields
// of the option types an author writes, what it returns, its examples, and its `@see` links. Last,
// the kit types the signatures name that no page documents, so each name has a definition.
//
// A surface is one page, or it is split: then its page is a contents page, which gives each name
// its kind and the first sentence of its TSDoc, and each name has a page of its own in the folder
// of the same name. A file tool reads the contents whole, and then one entry at a time.

import ts from "typescript";
import { relative } from "node:path";
import { relativeHref } from "../links.ts";
import { anchor, code, fenced, hang, maskCode } from "../markdown.ts";
import {
  docOf,
  flow,
  functionSignature,
  paramTag,
  printed,
  renderInline,
  resolveAlias,
  sourceFile,
  typeAliasSignature,
  variableSignature,
  type Doc,
} from "../tsdoc.ts";
import {
  anchorOf,
  checkTags,
  checkVoice,
  exampleBlock,
  linker,
  renderProse,
  seeAlso,
  type RefContext,
} from "./context.ts";
import { fieldsOf, propertyFields, renderFieldBlock, renderFields, type Field } from "./fields.ts";
import { dependencyNames, namedBy, renderTypes, typeBlocks, type NamedType, type TypeClosure } from "./types.ts";

export type Kind = "function" | "const" | "type";
export type Entry = { name: string; kind: Kind; symbol: ts.Symbol; decls: ts.Declaration[]; anchor: string };
export type EntryGroup = { title?: string; intro?: string; entries: Entry[] };

/** One root's exports, grouped by the comment that heads each export statement. A `split` surface
 * gives each name a page of its own. */
export type Surface = { root: string; page: string; groups: EntryGroup[]; split: boolean };

/** The page of one name of a split surface: `reference/authoring-surface/<anchor>.md`. The anchor
 * is lower case, so two names that differ only in case (`Customize`, `customize`) are two files on
 * a file system that ignores case, too. */
export const entryPage = (page: string, anchor: string): string => `${page.replace(/\.md$/, "")}/${anchor}.md`;

/** The `//` comment block right above a statement, with no empty line between: the group's head. */
function headComment(sf: ts.SourceFile, stmt: ts.Statement): string | undefined {
  const ranges = ts.getLeadingCommentRanges(sf.text, stmt.getFullStart()) ?? [];
  const block: string[] = [];
  let next = stmt.getStart();
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!;
    if (r.kind !== ts.SyntaxKind.SingleLineCommentTrivia) break;
    if (/\n\s*\n/.test(sf.text.slice(r.end, next))) break;
    block.unshift(sf.text.slice(r.pos, r.end).replace(/^\/\/ ?/, ""));
    next = r.pos;
  }
  return block.length ? block.join(" ").trim() : undefined;
}

function kindOf(d: ts.Declaration): Kind | undefined {
  if (ts.isFunctionDeclaration(d)) return "function";
  if (ts.isVariableDeclaration(d)) return "const";
  if (ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d)) return "type";
  return undefined;
}

/** The declarations of a name that a reader calls: each overload, never the implementation. */
function callable(decls: readonly ts.Declaration[]): ts.Declaration[] {
  const fns = decls.filter(ts.isFunctionDeclaration);
  if (fns.length > 1) return fns.filter((f) => !f.body);
  return [...decls];
}

function entryOf(ctx: RefContext, name: string, sym: ts.Symbol, at: ts.Node): Entry | undefined {
  const target = resolveAlias(ctx.program, sym);
  const decls = callable(target.declarations ?? []);
  const kind = decls[0] && kindOf(decls[0]);
  if (!kind) {
    const { line } = at.getSourceFile().getLineAndCharacterOfPosition(at.getStart());
    ctx.errors.push({
      file: relative(ctx.repo, at.getSourceFile().fileName),
      line: line + 1,
      message: `docs:build cannot document the export ${name}: no function, const or type declares it`,
    });
    return undefined;
  }
  // A type and a value can share a name (`Customize`, `customize`), as TypeScript lets them: the
  // type's anchor carries its namespace, so both stay stable.
  return { name, kind, symbol: target, decls, anchor: kind === "type" ? anchorOf("type", name) : anchorOf(name) };
}

/** Read a package root's exports in its order. A named export statement's head comment opens a
 * group, `Title: intro`; an `export *` lists its module's exports in their source order. */
export function readSurface(ctx: RefContext, root: string, page: string, split = false): Surface {
  const { checker } = ctx.program;
  const sf = sourceFile(ctx.program, root);
  const groups: EntryGroup[] = [];
  let group: EntryGroup | undefined;
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    const head = headComment(sf, stmt);
    if (head || !group) {
      const colon = head?.indexOf(":") ?? -1;
      group = {
        ...(head && colon > 0 ? { title: head.slice(0, colon).trim() } : {}),
        ...(head ? { intro: colon > 0 ? head.slice(colon + 1).trim() : head } : {}),
        entries: [],
      };
      groups.push(group);
    }
    if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        const sym = checker.getExportSpecifierLocalTargetSymbol(el);
        const e = sym && entryOf(ctx, el.name.text, sym, el);
        if (e) group.entries.push(e);
      }
    } else if (stmt.moduleSpecifier) {
      const mod = checker.getSymbolAtLocation(stmt.moduleSpecifier);
      const syms = mod ? checker.getExportsOfModule(mod) : [];
      const pos = (s: ts.Symbol) => resolveAlias(ctx.program, s).declarations?.[0]?.getStart() ?? 0;
      for (const s of [...syms].sort((a, b) => pos(a) - pos(b))) {
        const e = entryOf(ctx, s.name, s, stmt);
        if (e) group.entries.push(e);
      }
    }
  }
  const seen = new Set<string>();
  for (const e of groups.flatMap((g) => g.entries)) {
    if (seen.has(e.anchor))
      ctx.errors.push({ file: root, line: 1, message: `two exports share the anchor #${e.anchor}` });
    seen.add(e.anchor);
    ctx.names.set(e.name, split ? { page: entryPage(page, e.anchor) } : { page, anchor: e.anchor });
  }
  return { root, page, groups: groups.filter((g) => g.entries.length), split };
}

// ---- rendering ---------------------------------------------------------------------------------

/** True when a type node names, with `typeof`, a value that no Reference page documents: the
 * reader cannot look that value up, so the text alone tells them nothing. */
function namesHiddenValue(ctx: RefContext, node: ts.Node): boolean {
  const { checker } = ctx.program;
  let hidden = false;
  const visit = (n: ts.Node) => {
    if (ts.isTypeQueryNode(n)) {
      const sym = checker.getSymbolAtLocation(n.exprName);
      if (sym && !ctx.names.has(resolveAlias(ctx.program, sym).name)) hidden = true;
    }
    if (!hidden) ts.forEachChild(n, visit);
  };
  visit(node);
  return hidden;
}

function signatureOf(ctx: RefContext, e: Entry, d: ts.Declaration): string {
  if (ts.isFunctionDeclaration(d)) return functionSignature(d);
  if (ts.isVariableDeclaration(d)) return variableSignature(ctx.program, d, e.symbol);
  if (ts.isTypeAliasDeclaration(d) && namesHiddenValue(ctx, d.type)) {
    // `z.infer<typeof door>`, with `door` the module's own: show the type the compiler resolves.
    const { checker } = ctx.program;
    const node = checker.typeToTypeNode(
      checker.getDeclaredTypeOfSymbol(e.symbol),
      undefined,
      ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.MultilineObjectLiterals | ts.NodeBuilderFlags.InTypeAlias,
    );
    // The printer indents by four; the kit's sources by two.
    const type = node ? printed(node).replace(/^(?: {4})+/gm, (m) => " ".repeat(m.length / 2)) : "unknown";
    const tps = d.typeParameters ? `<${d.typeParameters.map((t) => t.getText()).join(", ")}>` : "";
    return `type ${e.name}${tps} = ${type};`;
  }
  return typeAliasSignature(d as ts.TypeAliasDeclaration);
}

/** The fields of a param's type as the compiler resolves it — its constraint, for a type param —
 * when the kit's own sources declare them. `undefined` for a param that takes no options object. */
function paramFields(ctx: RefContext, param: ts.ParameterDeclaration): Field[] | undefined {
  const { checker } = ctx.program;
  let type = checker.getTypeAtLocation(param);
  if (type.flags & ts.TypeFlags.TypeParameter) type = checker.getBaseConstraintOfType(type) ?? type;
  type = checker.getNonNullableType(type);
  if (type.getCallSignatures().length) return undefined;
  return propertyFields(ctx, type, false);
}

/** The names of the documented types that a param's type is: the type itself, the constraint of a
 * type param, or each member of an intersection or of a union (`workspace()`'s options, with Repo
 * Slots or with none). `undefined` when one part has no page. */
function documentedTypes(
  ctx: RefContext,
  d: ts.FunctionDeclaration,
  node: ts.TypeNode | undefined,
): string[] | undefined {
  if (!node) return undefined;
  if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) {
    const parts = node.types.map((t) => documentedTypes(ctx, d, t));
    return parts.every(Boolean) ? parts.flatMap((p) => p!) : undefined;
  }
  if (!ts.isTypeReferenceNode(node)) return undefined;
  const name = node.typeName.getText();
  const tp = d.typeParameters?.find((t) => t.name.text === name);
  if (tp) return documentedTypes(ctx, d, tp.constraint);
  return ctx.names.has(name) ? [name] : undefined;
}

/** The parts of one declaration's TSDoc, as Markdown blocks. `shown` holds the params whose fields
 * an earlier overload of the same entry listed: `name: type text`. */
function renderDoc(
  ctx: RefContext,
  doc: Doc | undefined,
  d: ts.Declaration,
  sym: ts.Symbol,
  from: string,
  shown: Set<string> = new Set(),
): string[] {
  const link = linker(ctx, from);
  const prose = (text: string) => renderProse(ctx, text, from);
  const out: string[] = [];
  if (doc?.summary) out.push(prose(doc.summary));
  const tags = doc?.tags ?? [];
  for (const t of tags.filter((t) => t.name === "remarks")) out.push(prose(flow(t.text)));
  checkTags(ctx, doc);
  checkVoice(ctx, doc);

  if (ts.isFunctionDeclaration(d) && d.parameters.length) {
    const texts = new Map(tags.filter((t) => t.name === "param").map((t) => [paramTag(t).name, paramTag(t).text]));
    const items = d.parameters.map((p) => {
      const name = p.name.getText();
      const text = texts.get(name);
      // A param whose type a page documents links there; its fields are in that entry.
      const named = documentedTypes(ctx, d, p.type);
      const links = (named ?? []).filter((n) => !text?.includes(`{@link ${n}}`)).map((n) => `[${code(n)}](${link(n)})`);
      // A union's members are its forms: one or the other, never both.
      const join = p.type && ts.isUnionTypeNode(p.type) ? " | " : " & ";
      const type = links.length ? ` (${links.join(join)})` : "";
      const head = `- ${code(name)}${type}${text ? `: ${prose(text)}` : ""}`;
      if (named) return hang(head, 2);
      // An overload's param with the same type as an earlier overload's has its fields there.
      const key = `${name}: ${p.type?.getText() ?? ""}`;
      const fields = shown.has(key) ? undefined : paramFields(ctx, p);
      if (fields) shown.add(key);
      return hang(fields ? `${head}\n\n${renderFields(ctx, fields, from)}` : head, 2);
    });
    out.push(`**Parameters**\n\n${items.join("\n")}`);
  } else if (ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d)) {
    const fields = fieldsOf(ctx, d, sym);
    if (fields) out.push(renderFieldBlock(ctx, fields, from));
  }
  for (const t of tags.filter((t) => t.name === "returns" || t.name === "return"))
    out.push(`**Returns**: ${prose(flow(t.text))}`);
  for (const t of tags.filter((t) => t.name === "example")) {
    out.push(`**Example**\n\n${exampleBlock(t.text)}`);
  }
  const see = seeAlso(ctx, doc, from);
  if (see) out.push(see);
  return out;
}

// The packages an Instance lists, so their folders are in its own node_modules: the kit, and
// @jr2/machines, which the machines page tells the reader to add. Any other @jr2 package is a
// dependency of @jr2/orchestrator, which a strict node_modules (pnpm) keeps out of the Instance's.
const LISTED = new Set(["orchestrator", "machines"]);

/** Where a declaration's file is, as Markdown, as an Assistant finds it from the Instance's
 * node_modules: `@jr2/orchestrator/src/x.ts`, or for a package the Instance does not list, the
 * file and the package it is in. */
function declaredIn(ctx: RefContext, d: ts.Declaration): string {
  const file = relative(ctx.repo, d.getSourceFile().fileName);
  const m = /^packages\/([^/]+)\/(.*)$/.exec(file);
  if (!m) return code(file);
  if (LISTED.has(m[1]!)) return code(`@jr2/${m[1]}/${m[2]}`);
  return `${code(m[2]!)} of ${code(`@jr2/${m[1]}`)}, a dependency of ${code("@jr2/orchestrator")}`;
}

/** The named type of a const whose signature shows only that name (`WorkspaceMachine<…>`): the
 * type the compiler infers is too long to print. */
function shortenedType(ctx: RefContext, e: Entry, d: ts.Declaration): ts.Symbol | undefined {
  if (!ts.isVariableDeclaration(d) || d.type || !signatureOf(ctx, e, d).endsWith("<…>")) return undefined;
  const type = ctx.program.checker.getTypeOfSymbol(e.symbol);
  return type.aliasSymbol ?? type.getSymbol();
}

/** The line under a shortened signature that says where its type is defined. */
function typeLine(ctx: RefContext, sym: ts.Symbol, named: TypeClosure, from: string): string {
  const href = linker(ctx, from)(sym.name);
  if (href) return `Type: [${code(sym.name)}](${href}).`;
  const pkg = named.external.get(sym.name);
  return `Type: ${code(sym.name)}${pkg ? `, from ${code(pkg)}` : ""}.`;
}

const KIND_TITLE: Record<Kind, string> = { function: "Function", const: "Constant", type: "Type" };

/** An entry as Markdown blocks after its heading: its kind, then each overload's signature and
 * TSDoc. `back` is the line that leads from an entry's own page to its contents page. An overload
 * has a heading one level under the entry's. */
function entryBlocks(ctx: RefContext, e: Entry, from: string, named: TypeClosure, sub: string, back = ""): string[] {
  const parts = [`${KIND_TITLE[e.kind]}, in ${declaredIn(ctx, e.decls[0]!)}.${back}`];
  const shown = new Set<string>();
  e.decls.forEach((d, i) => {
    if (e.decls.length > 1) parts.push(`${sub} Overload ${i + 1}`);
    parts.push(fenced("ts", signatureOf(ctx, e, d)));
    const short = shortenedType(ctx, e, d);
    if (short) parts.push(typeLine(ctx, short, named, from));
    parts.push(...renderDoc(ctx, docOf(ctx.program, d), d, e.symbol, from, shown));
  });
  return parts;
}

function renderEntry(ctx: RefContext, e: Entry, from: string, named: TypeClosure): string {
  return [`${anchor(e.anchor)}\n\n### ${code(e.name)}`, ...entryBlocks(ctx, e, from, named, "####")].join("\n\n");
}

/** A page's contents: each group, and a link to each of its names. */
function contents(s: Surface): string {
  return s.groups
    .map((g) => {
      const names = g.entries.map((e) => `[${code(e.name)}](#${e.anchor})`).join(", ");
      return g.title ? `- ${g.title}: ${names}` : `- ${names}`;
    })
    .join("\n");
}

/** The first sentence of a TSDoc summary, as one line of plain Markdown: a `{@link}` is its code
 * or its label, and a link is its text. `undefined` for no summary. A colon does not end the
 * sentence: the words after it often tell what the name is (ADR-0072). */
export function firstSentence(summary: string | undefined): string | undefined {
  if (!summary?.trim()) return undefined;
  const text = renderInline(summary, () => undefined)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  // The end of the sentence is a stop and a space, outside a code span.
  const end = /[.!?](?=\s)/.exec(maskCode(text));
  return end ? text.slice(0, end.index + 1) : text;
}

/** The nodes of a declaration that its signature shows: never a function's body. */
function signatureNodes(d: ts.Declaration): ts.Node[] {
  if (ts.isFunctionDeclaration(d)) return [...(d.typeParameters ?? []), ...d.parameters, ...(d.type ? [d.type] : [])];
  if (ts.isVariableDeclaration(d)) return d.type ? [d.type] : [];
  return [d];
}

/** A page that a split surface adds beside its contents page: its bundle path without `.md`, its
 * title and its H1, its description (the first sentence of its TSDoc), and its body. */
export type EntryPage = { slug: string; title: string; heading: string; description: string; body: string };

/** A surface's pages: its page body, and for a split surface, the page of each name. */
export type SurfacePages = { body: string; entries: EntryPage[] };

const TYPES_HEADING = "## Types these signatures name";

export function renderSurface(ctx: RefContext, s: Surface, intro: string): SurfacePages {
  // The kit types a signature names that no page documents, first, so a `{@link}` finds them.
  const nodes = s.groups.flatMap((g) => g.entries.flatMap((e) => e.decls.flatMap(signatureNodes)));
  const shortened = s.groups.flatMap((g) =>
    g.entries.flatMap((e) => e.decls.flatMap((d) => shortenedType(ctx, e, d) ?? [])),
  );
  const place = s.split ? (a: string) => entryPage(s.page, a) : s.page;
  const named = namedBy(ctx, nodes, place, (name) => ctx.names.has(name), "type", shortened);
  const pkg = s.root.startsWith("packages/machines/") ? "@jr2/machines" : "@jr2/orchestrator";
  if (s.split) return renderSplit(ctx, s, intro, named, pkg);
  const sections = s.groups.map((g) => {
    const head = g.title ? [`## ${g.title}`] : [];
    const intro = g.intro ? [renderProse(ctx, g.intro[0]!.toUpperCase() + g.intro.slice(1), s.page)] : [];
    return [...head, ...intro, ...g.entries.map((e) => renderEntry(ctx, e, s.page, named))].join("\n\n");
  });
  const types = named.types.length
    ? [
        renderTypes(
          ctx,
          named,
          s.page,
          TYPES_HEADING,
          `A signature above names these types, or a type here names them. They are not exports of ${code(pkg)}, so a workflow module does not import them by name. With them, each kit type that this page shows has a definition on a Reference page.`,
        ),
      ]
    : [];
  return { body: [intro, "## Contents", contents(s), ...sections, ...types].join("\n\n") + "\n", entries: [] };
}

/** A split surface: its contents page, and a page for each export and each type it names. */
function renderSplit(ctx: RefContext, s: Surface, intro: string, named: TypeClosure, pkg: string): SurfacePages {
  const entries: EntryPage[] = [];
  // Add the page of one name, and give the href of that page from the contents page.
  const add = (name: string, anchor: string, description: string, body: string[]) => {
    const page = entryPage(s.page, anchor);
    entries.push({
      slug: page.replace(/\.md$/, ""),
      title: name,
      heading: code(name),
      description,
      body: body.join("\n\n") + "\n",
    });
    return relativeHref(s.page, page);
  };
  const home = (from: string) => `[${pageTitle(ctx, s.page)}](${relativeHref(from, s.page)})`;
  const line = (href: string, name: string, kind: string, summary: string | undefined) =>
    `- [${code(name)}](${href})${kind}${summary ? `: ${summary}` : ""}`;

  const sections = s.groups.map((g) => {
    const head = g.title ? [`## ${g.title}`] : [];
    const text = g.intro ? [renderProse(ctx, g.intro[0]!.toUpperCase() + g.intro.slice(1), s.page)] : [];
    const items = g.entries.map((e) => {
      const from = entryPage(s.page, e.anchor);
      const summary = firstSentence(docOf(ctx.program, e.decls[0]!)?.summary);
      const back = ` It is an export of ${code(pkg)}, on the ${home(from)} page${g.title ? `, in ${g.title}` : ""}.`;
      const href = add(
        e.name,
        e.anchor,
        summary ?? `${KIND_TITLE[e.kind]}, an export of ${pkg}.`,
        entryBlocks(ctx, e, from, named, "##", back),
      );
      return line(href, e.name, ` (${KIND_TITLE[e.kind].toLowerCase()})`, summary);
    });
    return [...head, ...text, items.join("\n")].join("\n\n");
  });

  const typeEntry = (t: NamedType) => {
    const from = entryPage(s.page, t.anchor);
    const summary = t.plumbing ? undefined : firstSentence(docOf(ctx.program, t.decl)?.summary);
    const what = t.plumbing
      ? ` It is type plumbing: it computes a type from the types of a Machine or of its parts, and a workflow module does not write it. The signature of an export, or a type that it names, names this type, so its declaration is here. The ${home(from)} page lists each export.`
      : ` The signature of an export, or a type that it names, names this type. The ${home(from)} page lists each export. This type is not an export of ${code(pkg)}, so a workflow module does not import it by name.`;
    return add(t.name, t.anchor, summary ?? `A type that the ${pageTitle(ctx, s.page)} names.`, [
      `Type, in ${declaredIn(ctx, t.decl)}.${what}`,
      ...typeBlocks(ctx, t, from),
    ]);
  };
  const types: string[] = [];
  if (named.types.length) {
    types.push(
      TYPES_HEADING,
      `The signature of an export, or a type here, names each of these types. They are not exports of ${code(pkg)}, so a workflow module does not import them by name.`,
    );
    const own = named.types.filter((t) => !t.plumbing);
    if (own.length)
      types.push(
        own.map((t) => line(typeEntry(t), t.name, "", firstSentence(docOf(ctx.program, t.decl)?.summary))).join("\n"),
      );
    const plumbing = named.types.filter((t) => t.plumbing);
    if (plumbing.length)
      types.push(
        `**Type plumbing.** These types compute a type from the types of a Machine or of its parts. A workflow module does not write them. Each has a page with its declaration:\n\n${plumbing.map((t) => `- [${code(t.name)}](${typeEntry(t)})`).join("\n")}`,
      );
    const deps = dependencyNames(named, true);
    if (deps) types.push(deps);
  }
  return { body: [intro, ...sections, ...types].join("\n\n") + "\n", entries };
}

/** The sitemap title of a Reference page, by its bundle path. */
function pageTitle(ctx: RefContext, page: string): string {
  return ctx.pages.find((p) => `${p.slug}.md` === page)?.title ?? page;
}

/** Every `@example` on a surface, by the name that carries it, for the typecheck test. */
export function examplesOf(ctx: RefContext, s: Surface): { name: string; code: string }[] {
  return s.groups.flatMap((g) =>
    g.entries.flatMap((e) =>
      e.decls.flatMap((d) =>
        (docOf(ctx.program, d)?.tags ?? [])
          .filter((t) => t.name === "example")
          .map((t) => ({ name: e.name, code: t.text.trim().replace(/^(`{3,}|~{3,})\w*\n([\s\S]*?)\n\1$/, "$2") })),
      ),
    ),
  );
}
