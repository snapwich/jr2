// The fields of a type, for a Reference page: from a type literal's own members where the
// declaration spells them out, and from the compiler where it does not (a `z.infer<typeof x>`, a
// union of named types). A union of objects is shown as its forms, one field list per form, so
// that two `outcome` fields never sit in one list.

import ts from "typescript";
import { code, hang } from "../markdown.ts";
import { docOf, isKitSource, typeText, type Doc } from "../tsdoc.ts";
import { checkVoice, linker, renderProse, type RefContext } from "./context.ts";

export type Field = {
  name: string;
  optional: boolean;
  type: string;
  doc?: Doc;
  members?: ts.NodeArray<ts.TypeElement>;
};

/** A named type whose fields a type has too, as an intersection member: `X`, or `Omit<X, "k">`. */
export type Base = { name: string; except: string[] };

/** A type's fields: one list, or one list per form of a union. `bases` are the documented types
 * whose fields it has too; the list holds only its own. */
export type Fields = { fields: Field[]; bases?: Base[] } | { forms: Field[][] };

/** The fields a type literal declares, in its order. */
export function literalFields(ctx: RefContext, members: ts.NodeArray<ts.TypeElement>): Field[] {
  return members.flatMap((m): Field[] => {
    if (!ts.isPropertySignature(m) && !ts.isMethodSignature(m)) return [];
    const nested = m.type && ts.isTypeLiteralNode(m.type) ? m.type.members : undefined;
    const type = ts.isMethodSignature(m)
      ? `(${m.parameters.map((p) => p.getText()).join(", ")}) => ${typeText(m.type)}`
      : nested
        ? "object"
        : typeText(m.type);
    const doc = docOf(ctx.program, m);
    return [
      {
        name: m.name.getText(),
        optional: !!m.questionToken,
        type,
        ...(doc ? { doc } : {}),
        ...(nested ? { members: nested } : {}),
      },
    ];
  });
}

/** One property the compiler resolves, when the kit's own sources declare it: a member of a type
 * literal, or a property of an object a type is inferred from (a zod schema's `{ prompt: … }`). */
function propField(ctx: RefContext, prop: ts.Symbol): Field | undefined {
  const { checker } = ctx.program;
  const d = prop.valueDeclaration ?? prop.declarations?.[0];
  if (!d || !isKitSource(ctx.program, d)) return undefined;
  const optional = !!(prop.flags & ts.SymbolFlags.Optional);
  if (ts.isPropertySignature(d) || ts.isMethodSignature(d)) {
    const [f] = literalFields(ctx, ts.factory.createNodeArray([d]));
    return f && { ...f, optional };
  }
  if (!ts.isPropertyAssignment(d)) return undefined;
  let type = checker.getTypeOfSymbol(prop);
  if (optional) type = checker.getNonNullableType(type);
  const doc = docOf(ctx.program, d);
  return {
    name: prop.name,
    optional,
    type: checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation),
    ...(doc ? { doc } : {}),
  };
}

/** The properties of a resolved type. With `all`, `undefined` when one of them is not the kit's,
 * as a list with a hole in it would mislead; without, the kit's own (an options type that extends
 * a dependency's). */
export function propertyFields(ctx: RefContext, type: ts.Type, all = true): Field[] | undefined {
  const fields: Field[] = [];
  for (const prop of ctx.program.checker.getPropertiesOfType(type)) {
    const f = propField(ctx, prop);
    if (f) fields.push(f);
    else if (all) return undefined;
  }
  return fields.length ? fields : undefined;
}

const unparen = (n: ts.TypeNode): ts.TypeNode => (ts.isParenthesizedTypeNode(n) ? unparen(n.type) : n);

/** The literals a type node is made of, when it is only literals: itself, or an intersection of
 * them. */
function onlyLiterals(node: ts.TypeNode): ts.TypeLiteralNode[] | undefined {
  const n = unparen(node);
  if (ts.isTypeLiteralNode(n)) return [n];
  if (!ts.isIntersectionTypeNode(n)) return undefined;
  const parts = n.types.map(onlyLiterals);
  return parts.every(Boolean) ? parts.flatMap((p) => p!) : undefined;
}

/** An intersection of type literals and documented types (`X`, `Omit<X, "k">`): the literals'
 * fields, and the documented types as bases, so that a page does not list their fields again. */
function basedFields(ctx: RefContext, node: ts.TypeNode): Fields | undefined {
  if (!ts.isIntersectionTypeNode(node)) return undefined;
  const fields: Field[] = [];
  const bases: Base[] = [];
  for (const part of node.types.map(unparen)) {
    if (ts.isTypeLiteralNode(part)) {
      fields.push(...literalFields(ctx, part.members));
      continue;
    }
    if (!ts.isTypeReferenceNode(part)) return undefined;
    let ref = part;
    let except: string[] = [];
    if (ref.typeName.getText() === "Omit" && ref.typeArguments?.length === 2) {
      const [target, keys] = ref.typeArguments;
      if (!ts.isTypeReferenceNode(target!)) return undefined;
      const literal = (t: ts.TypeNode) =>
        ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? [t.literal.text] : undefined;
      const names = ts.isUnionTypeNode(keys!) ? keys.types.map(literal) : [literal(keys!)];
      if (!names.every(Boolean)) return undefined;
      ref = target;
      except = names.flatMap((n) => n!);
    }
    const name = ref.typeName.getText();
    if (!ctx.names.has(name)) return undefined;
    bases.push({ name, except });
  }
  return bases.length ? { fields, bases } : undefined;
}

const isObject = (t: ts.Type): boolean =>
  !!(t.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) && !t.getCallSignatures().length;

/** The fields of a named type: from the literals its declaration writes, or else from the type
 * the compiler resolves. `undefined` for a type that is not an object, or not only the kit's. */
export function fieldsOf(
  ctx: RefContext,
  d: ts.TypeAliasDeclaration | ts.InterfaceDeclaration,
  sym: ts.Symbol,
): Fields | undefined {
  const some = (fields: Field[]) => (fields.length ? { fields } : undefined);
  if (ts.isInterfaceDeclaration(d)) return some(literalFields(ctx, d.members));
  const node = unparen(d.type);
  if (ts.isUnionTypeNode(node)) {
    const forms = node.types.map(onlyLiterals);
    if (forms.every(Boolean)) return { forms: forms.map((ls) => ls!.flatMap((l) => literalFields(ctx, l.members))) };
  }
  const literals = onlyLiterals(node);
  if (literals) return some(literals.flatMap((l) => literalFields(ctx, l.members)));
  const based = basedFields(ctx, node);
  if (based) return based;
  const type = ctx.program.checker.getDeclaredTypeOfSymbol(sym);
  if (type.isUnion()) {
    if (!type.types.every(isObject)) return undefined;
    const forms = type.types.map((t) => propertyFields(ctx, t));
    return forms.every(Boolean) ? { forms: forms as Field[][] } : undefined;
  }
  if (!isObject(type)) return undefined;
  const fields = propertyFields(ctx, type);
  return fields && { fields };
}

/** A field list, nested where a field's type is itself a literal. A field whose type is a name a
 * page documents links to it. */
export function renderFields(ctx: RefContext, fields: Field[], from: string, depth = 0): string {
  const link = linker(ctx, from);
  return fields
    .map((f) => {
      const href = link(f.type);
      const type = href ? `[${code(f.type)}](${href})` : code(f.type);
      const head = `- ${code(f.name)}${f.optional ? " (optional)" : ""}: ${type}`;
      checkVoice(ctx, f.doc);
      const body = f.doc?.summary ? renderProse(ctx, f.doc.summary, from) : "";
      const nested =
        f.members && depth < 3 ? renderFields(ctx, literalFields(ctx, f.members), from, depth + 1) : undefined;
      const parts = [body, nested].filter(Boolean) as string[];
      return hang([head, ...parts.map((p) => `\n${p}`)].join("\n"), 2);
    })
    .join("\n");
}

/** A `**Fields**` block, or a `**Forms**` block with one field list per form. */
export function renderFieldBlock(ctx: RefContext, f: Fields, from: string): string {
  if ("fields" in f) {
    const link = linker(ctx, from);
    const bases = (f.bases ?? []).map((b) => {
      const except = b.except.length ? `, except ${b.except.map(code).join(" and ")}` : "";
      return `[${code(b.name)}](${link(b.name)})${except}`;
    });
    const list = f.fields.length ? renderFields(ctx, f.fields, from) : "";
    if (!bases.length) return `**Fields**\n\n${list}`;
    const head = `**Fields**: each field of ${bases.join(", and each field of ")}${list ? ", and these:" : "."}`;
    return list ? `${head}\n\n${list}` : head;
  }
  const forms = f.forms.map((form, i) => {
    const keys = form.map((x) => code(x.name)).join(", ");
    return hang(`- Form ${i + 1}: ${keys}\n\n${renderFields(ctx, form, from)}`, 2);
  });
  return `**Forms**: it is one of these objects.\n\n${forms.join("\n")}`;
}
