// The Authoring surface and `@jr2/machines` pages (ADR-0072): each name a package root exports, in
// the root's own groups and order, followed through its re-exports to the declaration the compiler
// finds. Per name: its kind, its signature, and its TSDoc — the summary, the params with the fields
// of the option types an author writes, what it returns, its examples, and its `@see` links. Last,
// the kit types the signatures name that no page documents, so each name has a definition.

import ts from "typescript";
import { relative } from "node:path";
import { anchor, code, fenced, hang } from "../markdown.ts";
import {
  docOf,
  flow,
  functionSignature,
  paramTag,
  printed,
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
import { namedBy, renderTypes, type TypeClosure } from "./types.ts";

export type Kind = "function" | "const" | "type";
export type Entry = { name: string; kind: Kind; symbol: ts.Symbol; decls: ts.Declaration[]; anchor: string };
export type EntryGroup = { title?: string; intro?: string; entries: Entry[] };

/** One root's exports, grouped by the comment that heads each export statement. */
export type Surface = { root: string; page: string; groups: EntryGroup[] };

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
export function readSurface(ctx: RefContext, root: string, page: string): Surface {
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
    ctx.names.set(e.name, { page, anchor: e.anchor });
  }
  return { root, page, groups: groups.filter((g) => g.entries.length) };
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
 * type param, or each member of an intersection. `undefined` when one part has no page. */
function documentedTypes(
  ctx: RefContext,
  d: ts.FunctionDeclaration,
  node: ts.TypeNode | undefined,
): string[] | undefined {
  if (!node) return undefined;
  if (ts.isIntersectionTypeNode(node)) {
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
      const type = links.length ? ` (${links.join(" & ")})` : "";
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

/** The package path of a declaration's file, as an Assistant finds it in node_modules. */
function declaredIn(ctx: RefContext, d: ts.Declaration): string {
  const file = relative(ctx.repo, d.getSourceFile().fileName);
  const m = /^packages\/([^/]+)\/(.*)$/.exec(file);
  return m ? `@jr2/${m[1]}/${m[2]}` : file;
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

function renderEntry(ctx: RefContext, e: Entry, from: string, named: TypeClosure): string {
  const parts = [`${anchor(e.anchor)}\n\n### ${code(e.name)}`];
  parts.push(
    `${e.kind === "type" ? "Type" : e.kind === "const" ? "Constant" : "Function"}, in ${code(declaredIn(ctx, e.decls[0]!))}.`,
  );
  const shown = new Set<string>();
  e.decls.forEach((d, i) => {
    if (e.decls.length > 1) parts.push(`#### Overload ${i + 1}`);
    parts.push(fenced("ts", signatureOf(ctx, e, d)));
    const short = shortenedType(ctx, e, d);
    if (short) parts.push(typeLine(ctx, short, named, from));
    parts.push(...renderDoc(ctx, docOf(ctx.program, d), d, e.symbol, from, shown));
  });
  return parts.join("\n\n");
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

/** The nodes of a declaration that its signature shows: never a function's body. */
function signatureNodes(d: ts.Declaration): ts.Node[] {
  if (ts.isFunctionDeclaration(d)) return [...(d.typeParameters ?? []), ...d.parameters, ...(d.type ? [d.type] : [])];
  if (ts.isVariableDeclaration(d)) return d.type ? [d.type] : [];
  return [d];
}

export function renderSurface(ctx: RefContext, s: Surface, intro: string): string {
  // The kit types a signature names that no page documents, first, so a `{@link}` finds them.
  const nodes = s.groups.flatMap((g) => g.entries.flatMap((e) => e.decls.flatMap(signatureNodes)));
  const shortened = s.groups.flatMap((g) =>
    g.entries.flatMap((e) => e.decls.flatMap((d) => shortenedType(ctx, e, d) ?? [])),
  );
  const named = namedBy(ctx, nodes, s.page, (name) => ctx.names.has(name), "type", shortened);
  const sections = s.groups.map((g) => {
    const head = g.title ? [`## ${g.title}`] : [];
    const intro = g.intro ? [renderProse(ctx, g.intro[0]!.toUpperCase() + g.intro.slice(1), s.page)] : [];
    return [...head, ...intro, ...g.entries.map((e) => renderEntry(ctx, e, s.page, named))].join("\n\n");
  });
  const pkg = s.root.startsWith("packages/machines/") ? "@jr2/machines" : "@jr2/orchestrator";
  const types = named.types.length
    ? [
        renderTypes(
          ctx,
          named,
          s.page,
          "## Types these signatures name",
          `A signature above names these types, or a type here names them. They are not exports of ${code(pkg)}, so a workflow module does not import them by name. With them, each kit type that this page shows has a definition on a Reference page.`,
        ),
      ]
    : [];
  return [intro, "## Contents", contents(s), ...sections, ...types].join("\n\n") + "\n";
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
