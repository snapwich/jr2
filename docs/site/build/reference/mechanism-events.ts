// The Mechanism events page (ADR-0072): the events jr2 itself delivers into every `jr2Setup`
// Machine. They have no runtime list — `MechanismEvent` is a type union — so the compiler reads the
// union: per member, its `type` name, its payload fields, and its TSDoc. Who sends each one is not
// in the type, so `SENDERS` says it, and the build fails when the union and `SENDERS` disagree.

import ts from "typescript";
import { anchor, code, fenced } from "../markdown.ts";
import { declaredText, docOf, sourceFile, typeText, where } from "../tsdoc.ts";
import { anchorOf, checkVoice, renderProse, typeDocTail, type RefContext } from "./context.ts";

export const EVENTS_PAGE = "reference/mechanism-events.md";
const SETUP_FILE = "packages/orchestrator/src/setup.ts";

/** Who delivers each Mechanism event, by its `type`. */
export const SENDERS: Readonly<Record<string, string>> = {
  "agent.fault": "The Agent slot (`agent()`) that the state invoked, to the Machine that invoked it.",
  "workspace.lost": "`workspace()`, to its body Machine, when the Workspace's Sandbox is gone.",
};

export type MechanismEventDoc = {
  type: string;
  alias: ts.TypeAliasDeclaration;
  fields: ts.PropertySignature[];
};

function aliasOf(ctx: RefContext, node: ts.TypeNode): ts.TypeAliasDeclaration | undefined {
  if (!ts.isTypeReferenceNode(node)) return undefined;
  let sym = ctx.program.checker.getSymbolAtLocation(node.typeName);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = ctx.program.checker.getAliasedSymbol(sym);
  const d = sym?.declarations?.[0];
  return d && ts.isTypeAliasDeclaration(d) ? d : undefined;
}

/** The members of `MechanismEvent`, in union order. */
/** The anchor of the line that lists the events: `MechanismEvent`, their union, links there. */
const MECHANISM_EVENT_ANCHOR = "type-mechanismevent";

export function readMechanismEvents(ctx: RefContext): MechanismEventDoc[] {
  const sf = sourceFile(ctx.program, SETUP_FILE);
  const union = sf.statements.find(
    (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === "MechanismEvent",
  );
  if (!union) throw new Error("docs:build: MechanismEvent is not in setup.ts");
  const members = ts.isUnionTypeNode(union.type) ? union.type.types : [union.type];
  const out: MechanismEventDoc[] = [];
  for (const m of members) {
    const alias = aliasOf(ctx, m);
    const literal = alias && ts.isTypeLiteralNode(alias.type) ? alias.type : undefined;
    const props = literal?.members.filter(ts.isPropertySignature) ?? [];
    const typeProp = props.find((p) => p.name.getText() === "type");
    const t = typeProp?.type && ts.isLiteralTypeNode(typeProp.type) && ts.isStringLiteral(typeProp.type.literal);
    if (!alias || !t) {
      ctx.errors.push({
        ...where(ctx.program, m),
        message: 'a MechanismEvent member is not an alias of { type: "…", … }',
      });
      continue;
    }
    const type = ((typeProp!.type as ts.LiteralTypeNode).literal as ts.StringLiteral).text;
    out.push({ type, alias, fields: props.filter((p) => p !== typeProp) });
  }
  for (const e of out)
    if (!SENDERS[e.type])
      ctx.errors.push({
        ...where(ctx.program, e.alias),
        message: `docs:build names no sender for the Mechanism event ${e.type}: add it to SENDERS in docs/site/build/reference/mechanism-events.ts`,
      });
  for (const t of Object.keys(SENDERS))
    if (!out.some((e) => e.type === t))
      ctx.errors.push({
        file: "docs/site/build/reference/mechanism-events.ts",
        line: 1,
        message: `SENDERS names ${t}, which MechanismEvent does not hold`,
      });
  for (const e of out) ctx.names.set(e.alias.name.text, { page: EVENTS_PAGE, anchor: anchorOf(e.type) });
  // Their union, as a signature names it, is the page's list of them.
  ctx.names.set("MechanismEvent", { page: EVENTS_PAGE, anchor: MECHANISM_EVENT_ANCHOR });
  return out;
}

export function renderMechanismEvents(ctx: RefContext, events: MechanismEventDoc[]): string {
  const intro = [
    `jr2's own mechanism delivers these events into every Machine that ${code("jr2Setup")} makes, beside the workflow events its ${code("defineEvent")} defs declare. Handle one with an ${code("on")} key, as any event: ${code(`on: { "agent.fault": "failed" }`)}. A Mechanism event's name has a dot, and a workflow event's name cannot, so the two never collide. The Machine's event type, ${code("WorkflowEvent")}, holds them already.`,
    `Each Mechanism event must have a route. ${code("jr2 check")} and ${code("jr2 up")} refuse a state that invokes an Agent, or an Open body that lends an Agent or allows a model, when that state and each state above it have no ${code("agent.fault")} route, and ${code("workspace()")} refuses a body with a state that is not final and has no ${code("workspace.lost")} route on itself or on a state above. One route on the root satisfies each rule. A route with actions only is a route. When the event comes and no transition takes it, because the guard of its route is false, the run ends ${code("error")}, and its fault names the event, the state and the reason. In a [Chart](../concepts/charts.md), the ${code("agent.fault")} route is optional: when no transition of the Chart takes it, the Open body sends it, unchanged, to the Machine that invoked the body, and that Machine's own route takes it.`,
    `To end the run as a Failure when a Mechanism event comes, route it to a state that invokes [${code("fail")}](authoring-surface/fail.md): ${code(`lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } }`)}. The run then ends ${code("failed")}, not ${code("done")}, because a final state means that the work succeeded.`,
  ];
  intro.push(
    `${anchor(MECHANISM_EVENT_ANCHOR)}${code("MechanismEvent")} is one of these events: ${events.map((e) => `[${code(e.type)}](#${anchorOf(e.type)})`).join(", ")}.`,
  );
  const sections = events.map((e) => {
    const doc = docOf(ctx.program, e.alias);
    const fields = e.fields.map((f) => {
      const d = docOf(ctx.program, f);
      checkVoice(ctx, d);
      const text = d?.summary ? `: ${renderProse(ctx, d.summary.replace(/\s*\n\s*/g, " "), EVENTS_PAGE)}` : "";
      return `- ${code(f.name.getText())}${f.questionToken ? " (optional)" : ""}, ${code(typeText(f.type))}${text}`;
    });
    return [
      `${anchor(anchorOf(e.type))}\n\n## ${code(e.type)}`,
      `- Type: ${code(e.alias.name.text)}\n- Sent by: ${SENDERS[e.type] ?? "unknown"}`,
      fenced("ts", declaredText(e.alias)),
      ...(doc?.summary ? [renderProse(ctx, doc.summary, EVENTS_PAGE)] : []),
      fields.length ? `**Payload**\n\n${fields.join("\n")}` : "**Payload**: none.",
      ...typeDocTail(ctx, doc, EVENTS_PAGE),
    ].join("\n\n");
  });
  return [...intro, ...sections].join("\n\n") + "\n";
}
