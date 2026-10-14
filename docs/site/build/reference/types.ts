// Named types, rendered from their declarations, for a page whose prose or signatures name them
// (the HTTP API's bodies and answers, the Mechanism events' payloads, the kit types an Authoring
// surface signature names that no page documents). A type's declaration names other types; each
// one the kit declares is rendered too, once, so that no name on the page is undefined. A name a
// dependency declares (xstate's, zod's) is listed with its package instead, as the text writes it.
//
// A type whose TSDoc carries `@internal` is type plumbing: it computes a type from other types
// (a Machine's actors, an Effect's Open parts), and an author never writes it. It is listed with
// its declaration alone, and the names inside it are not followed: what it names is the kit's
// machinery, and its TSDoc is a maintainer's.

import ts from "typescript";
import { relative } from "node:path";
import { anchor, code, fenced } from "../markdown.ts";
import { declaredText, docOf, exportedSymbol, isKitSource, sourceFile } from "../tsdoc.ts";
import { fieldsOf, renderFieldBlock } from "./fields.ts";
import { anchorOf, renderProse, typeDocTail, type RefContext } from "./context.ts";

export type NamedType = {
  name: string;
  decl: ts.TypeAliasDeclaration | ts.InterfaceDeclaration;
  anchor: string;
  /** Marked `@internal`: shown as its declaration only. */
  plumbing: boolean;
};
export type TypeClosure = { types: NamedType[]; external: Map<string, string> };

const INTERNAL = "packages/orchestrator/src/internal.ts";

function declOf(sym: ts.Symbol | undefined): ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined {
  const d = sym?.declarations?.[0];
  return d && (ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d)) ? d : undefined;
}

/** The package a declaration outside the kit comes from, as its import names it. */
function packageOf(ctx: RefContext, d: ts.Node): string {
  const file = relative(ctx.repo, d.getSourceFile().fileName);
  const m = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(file);
  return m?.[1] ?? "the TypeScript lib";
}

/** `roots` (names the kit's internal root exports) and every kit type their declarations name. */
export function typeClosure(ctx: RefContext, roots: readonly string[], page: string, prefix = "type"): TypeClosure {
  const internal = sourceFile(ctx.program, INTERNAL);
  const seeds = roots.map((name) => {
    const d = declOf(exportedSymbol(ctx.program, internal, name));
    if (!d) throw new Error(`docs:build: no type ${name} in @jr2/orchestrator/internal`);
    return d;
  });
  return closureOf(ctx, seeds, page, prefix);
}

/** The kit types that `nodes` name, and the types in `also`, that no page documents (`skip` knows
 * the documented names), and each kit type that those name in turn: a field's type, or the
 * parameter or the result of a function a field holds. Not what a type marked `@internal` names. */
export function namedBy(
  ctx: RefContext,
  nodes: readonly ts.Node[],
  page: string,
  skip: (name: string) => boolean,
  prefix = "type",
  also: readonly ts.Symbol[] = [],
): TypeClosure {
  const seeds: (ts.TypeAliasDeclaration | ts.InterfaceDeclaration)[] = [];
  const external = new Map<string, string>();
  for (const n of nodes) visitRefs(ctx, n, seeds, external);
  for (const sym of also) {
    const d = declOf(sym);
    if (d && isKitSource(ctx.program, d)) seeds.push(d);
    else if (sym.declarations?.[0] && !external.has(sym.name))
      external.set(sym.name, packageOf(ctx, sym.declarations[0]));
  }
  const c = closureOf(ctx, seeds, page, prefix, skip);
  for (const [name, pkg] of c.external) external.set(name, pkg);
  for (const [name, pkg] of external) if (pkg === "the TypeScript lib" || pkg === "typescript") external.delete(name);
  return { types: c.types, external };
}

/** Push each kit type that a type reference under `node` names onto `queue`, and record each name
 * a dependency declares in `external`. */
function visitRefs(
  ctx: RefContext,
  node: ts.Node,
  queue: (ts.TypeAliasDeclaration | ts.InterfaceDeclaration)[],
  external: Map<string, string>,
): void {
  const { checker } = ctx.program;
  const visit = (n: ts.Node) => {
    if (ts.isTypeReferenceNode(n) || ts.isExpressionWithTypeArguments(n)) {
      const at = ts.isTypeReferenceNode(n) ? n.typeName : n.expression;
      let sym = checker.getSymbolAtLocation(at);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      const target = declOf(sym);
      if (sym && !(sym.flags & ts.SymbolFlags.TypeParameter)) {
        // A dependency's name as the text writes it: `z.infer`, not the `output` it aliases.
        const written = at.getText();
        if (target && isKitSource(ctx.program, target)) queue.push(target);
        else if (sym.declarations?.[0] && !external.has(written))
          external.set(written, packageOf(ctx, sym.declarations[0]));
      }
    }
    // `typeof x` names a value; the reader needs its type, which the text already shows.
    if (ts.isTypeQueryNode(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/** True for a type whose TSDoc carries `@internal`. */
export function isPlumbing(ctx: RefContext, d: ts.Node): boolean {
  return !!docOf(ctx.program, d)?.tags.some((t) => t.name === "internal");
}

function closureOf(
  ctx: RefContext,
  seeds: readonly (ts.TypeAliasDeclaration | ts.InterfaceDeclaration)[],
  page: string,
  prefix: string,
  skip: (name: string) => boolean = () => false,
): TypeClosure {
  const types: NamedType[] = [];
  const external = new Map<string, string>();
  const seen = new Set<ts.Node>();
  let level = [...seeds];
  while (level.length) {
    const next: (ts.TypeAliasDeclaration | ts.InterfaceDeclaration)[] = [];
    for (const d of level) {
      if (seen.has(d) || skip(d.name.text)) continue;
      seen.add(d);
      const plumbing = isPlumbing(ctx, d);
      types.push({ name: d.name.text, decl: d, anchor: anchorOf(prefix, d.name.text), plumbing });
      if (!plumbing) visitRefs(ctx, d, next, external);
    }
    level = next;
  }
  for (const t of types) ctx.names.set(t.name, ctx.names.get(t.name) ?? { page, anchor: t.anchor });
  // Built-in names (Record, Promise, …) need no line: every TypeScript reader knows them.
  for (const [name, pkg] of external) if (pkg === "the TypeScript lib" || pkg === "typescript") external.delete(name);
  return { types, external };
}

/** The Types section: each type's declared text, its TSDoc summary, its fields and the rest of its
 * TSDoc; then the type plumbing, as declarations alone; then the dependency names. */
export function renderTypes(
  ctx: RefContext,
  c: TypeClosure,
  from: string,
  heading = "## Types",
  intro?: string,
): string {
  const parts = [heading, ...(intro ? [intro] : [])];
  for (const t of c.types.filter((t) => !t.plumbing)) {
    const doc = docOf(ctx.program, t.decl);
    const block = [`${anchor(t.anchor)}\n\n### ${code(t.name)}`, fenced("ts", declaredText(t.decl))];
    if (doc?.summary) block.push(renderProse(ctx, doc.summary, from));
    const sym = ctx.program.checker.getSymbolAtLocation(t.decl.name);
    const fields = sym && fieldsOf(ctx, t.decl, sym);
    if (fields) block.push(renderFieldBlock(ctx, fields, from));
    block.push(...typeDocTail(ctx, doc, from));
    parts.push(block.join("\n\n"));
  }
  const plumbing = c.types.filter((t) => t.plumbing);
  if (plumbing.length) {
    const items = plumbing.map((t) => `${anchor(t.anchor)}${code(t.name)}\n\n${fenced("ts", declaredText(t.decl))}`);
    parts.push(
      `**Type plumbing.** These types compute a type from the types of a Machine or of its parts. A workflow module does not write them. A signature above names them, so their declarations are here:\n\n${items.join("\n\n")}`,
    );
  }
  if (c.external.size) {
    const rows = [...c.external].map(([name, pkg]) => `- ${code(name)}: from ${code(pkg)}`);
    parts.push(`These names come from a dependency:\n\n${rows.join("\n")}`);
  }
  return parts.join("\n\n");
}
