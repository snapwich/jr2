// The `jr2.config.ts` page (ADR-0072): every field of `JR2Config`, nested, in declared order — its
// path, its type, whether it is required, its default where the TSDoc states one, and its TSDoc.
// The walk follows the declared types: an object, a list of objects, a map of objects, and a type
// alias the config module declares are opened; a type on the Authoring surface (`Size`) is linked.

import ts from "typescript";
import { anchor, code, maskCode } from "../markdown.ts";
import { docOf, renderInline, sourceFile, typeText, isKitSource, type Doc } from "../tsdoc.ts";
import { anchorOf, checkVoice, linker, renderProse, seeAlso, type RefContext } from "./context.ts";

export const CONFIG_PAGE = "reference/config.md";
const CONFIG_FILE = "packages/orchestrator/src/config.ts";

type Field = {
  path: string;
  anchor: string;
  type: string;
  optional: boolean;
  doc?: Doc;
  /** The alternatives of a field that is one of several objects, rendered inside it. */
  forms?: Field[][];
  depth: number;
};

/** How a type node opens: the members it holds, and the path suffix that reaches them. */
type Opened = { members: ts.TypeElement[]; suffix: string; via?: string } | { forms: ts.TypeElement[][] } | undefined;

function aliasOf(ctx: RefContext, node: ts.TypeReferenceNode): ts.TypeAliasDeclaration | undefined {
  const { checker } = ctx.program;
  let sym = checker.getSymbolAtLocation(node.typeName);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const d = sym?.declarations?.[0];
  return d && ts.isTypeAliasDeclaration(d) && isKitSource(ctx.program, d) ? d : undefined;
}

/** The members of an object type node: a literal, an intersection of them, or an alias the config
 * module declares that is one. */
function membersOf(ctx: RefContext, node: ts.TypeNode): ts.TypeElement[] | undefined {
  if (ts.isTypeLiteralNode(node)) return [...node.members];
  if (ts.isParenthesizedTypeNode(node)) return membersOf(ctx, node.type);
  if (ts.isIntersectionTypeNode(node)) {
    const parts = node.types.map((t) => membersOf(ctx, t));
    return parts.every(Boolean) ? parts.flatMap((p) => p!) : undefined;
  }
  if (ts.isTypeReferenceNode(node) && !ctx.names.has(node.typeName.getText())) {
    const alias = aliasOf(ctx, node);
    if (alias && alias.getSourceFile().fileName.endsWith(CONFIG_FILE)) return membersOf(ctx, alias.type);
  }
  return undefined;
}

function open(ctx: RefContext, node: ts.TypeNode): Opened {
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) return open(ctx, node.type);
  if (ts.isArrayTypeNode(node)) {
    const m = membersOf(ctx, node.elementType);
    return m && { members: m, suffix: "[]" };
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    const args = node.typeArguments ?? [];
    if (name === "Readonly" && args[0]) return open(ctx, args[0]);
    if (name === "Record" && args[1]) {
      const m = membersOf(ctx, args[1]);
      return m && { members: m, suffix: ".<name>" };
    }
  }
  if (ts.isUnionTypeNode(node)) {
    const forms = node.types.map((t) => membersOf(ctx, t));
    if (forms.every(Boolean) && forms.length > 1) return { forms: forms as ts.TypeElement[][] };
  }
  const m = membersOf(ctx, node);
  return m && { members: m, suffix: "" };
}

/** The type names a field's type node names, for `{@link}` to land on the field. */
function namedTypes(node: ts.TypeNode): string[] {
  const out: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isTypeReferenceNode(n)) out.push(n.typeName.getText());
    ts.forEachChild(n, walk);
  };
  walk(node);
  return out;
}

function walk(ctx: RefContext, members: readonly ts.TypeElement[], prefix: string, depth: number, out: Field[]) {
  for (const m of members) {
    if (!ts.isPropertySignature(m) || !m.type) continue;
    const name = m.name.getText();
    const path = prefix ? `${prefix}.${name}` : name;
    const opened = open(ctx, m.type);
    const doc = docOf(ctx.program, m);
    const literal = ts.isTypeLiteralNode(m.type);
    const field: Field = {
      path,
      anchor: anchorOf(path.replace(/\[\]/g, "").replace(/<name>/g, "name")),
      type: literal || (opened && "forms" in opened) ? "object" : typeText(m.type),
      optional: !!m.questionToken,
      ...(doc ? { doc } : {}),
      depth,
    };
    for (const t of namedTypes(m.type))
      if (!ctx.names.has(t) && !/^(Readonly|Record)$/.test(t))
        ctx.names.set(t, { page: CONFIG_PAGE, anchor: field.anchor });
    if (opened && "forms" in opened) {
      field.forms = opened.forms.map((form) => {
        const sub: Field[] = [];
        walk(ctx, form, "", depth + 1, sub);
        return sub;
      });
    }
    out.push(field);
    if (opened && "members" in opened) walk(ctx, opened.members, path + opened.suffix, depth + 1, out);
  }
}

/** The fields of `JR2Config`, in the order a reader meets them. Fills `ctx.names` with the config
 * types a TSDoc links to. */
export function readConfig(ctx: RefContext): Field[] {
  const sf = sourceFile(ctx.program, CONFIG_FILE);
  const decl = sf.statements.find(
    (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === "JR2Config",
  );
  if (!decl) throw new Error("docs:build: JR2Config is not in config.ts");
  ctx.names.set("JR2Config", ctx.names.get("JR2Config") ?? { page: CONFIG_PAGE, anchor: "jr2config" });
  const out: Field[] = [];
  walk(ctx, membersOf(ctx, decl.type) ?? [], "", 0, out);
  return out;
}

/** The default a field's TSDoc states: the sentence that starts `Default:`. */
export function defaultOf(summary: string): string | undefined {
  const flat = summary.replace(/\s*\n\s*/g, " ");
  const masked = maskCode(flat);
  const at = masked.indexOf("Default:");
  if (at < 0) return undefined;
  const rest = masked.slice(at + "Default:".length);
  const stop = /\.(?=\s|$)/.exec(rest);
  return flat.slice(at + "Default:".length, at + "Default:".length + (stop ? stop.index : rest.length)).trim();
}

function renderForms(ctx: RefContext, forms: Field[][]): string {
  return forms
    .map((form, i) => {
      const keys = form.map((f) => code(f.path)).join(", ");
      const items = form.map((f) => {
        checkVoice(ctx, f.doc);
        const doc = f.doc?.summary ? `: ${renderProse(ctx, f.doc.summary.replace(/\s*\n\s*/g, " "), CONFIG_PAGE)}` : "";
        return `  - ${code(f.path)}${f.optional ? " (optional)" : ""}, ${code(f.type)}${doc}`;
      });
      return `- Form ${i + 1}: ${keys}\n${items.join("\n")}`;
    })
    .join("\n");
}

function renderField(ctx: RefContext, f: Field): string {
  const link = linker(ctx, CONFIG_PAGE);
  const summary = f.doc?.summary ?? "";
  const def = defaultOf(summary);
  const named = ctx.names.get(f.type);
  const type = named && named.page !== CONFIG_PAGE ? `[${code(f.type)}](${link(f.type)})` : code(f.type);
  const facts = [
    `- Type: ${type}`,
    `- Required: ${f.optional ? "no" : "yes"}`,
    ...(def ? [`- Default: ${renderInline(def, link)}`] : []),
  ];
  const parts = [`${anchor(f.anchor)}\n\n${f.depth === 0 ? "##" : "###"} ${code(f.path)}`, facts.join("\n")];
  checkVoice(ctx, f.doc);
  if (summary) parts.push(renderProse(ctx, summary, CONFIG_PAGE));
  if (f.forms) parts.push(`It is one of these objects:\n\n${renderForms(ctx, f.forms)}`);
  return parts.join("\n\n");
}

/** The page body. The intro is `JR2Config`'s own TSDoc, its example and its `@see` links. */
export function renderConfig(ctx: RefContext, fields: Field[]): string {
  const sf = sourceFile(ctx.program, CONFIG_FILE);
  const decl = sf.statements.find((s) => ts.isTypeAliasDeclaration(s) && s.name.text === "JR2Config")!;
  const doc = docOf(ctx.program, decl);
  const intro: string[] = [
    `An Instance's config is the default export of its ${code("jr2.config.ts")}: a ${code("JR2Config")}, written with ${code("defineConfig")}. Each field below has its path, as in ${code("git.credentials[].match")}, where ${code("[]")} is each entry of a list and ${code("<name>")} is each key of a map.`,
  ];
  checkVoice(ctx, doc);
  if (doc?.summary) intro.push(renderProse(ctx, doc.summary, CONFIG_PAGE));
  for (const t of doc?.tags.filter((t) => t.name === "example") ?? []) intro.push(`**Example**\n\n${t.text.trim()}`);
  const see = seeAlso(ctx, doc, CONFIG_PAGE);
  if (see) intro.push(see);
  const index = fields.filter((f) => f.depth === 0).map((f) => `[${code(f.path)}](#${f.anchor})`);
  return [...intro, `Fields: ${index.join(", ")}.`, ...fields.map((f) => renderField(ctx, f))].join("\n\n") + "\n";
}
