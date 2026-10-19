// The Chart (ADR-0070): a Machine written as data alone, and the door that admits one.
//
// A Chart is xstate's own JSON-serializable config with every guard, action and delay named and
// every `invoke.src` a slot name. It carries no function, no import, no secret name, no url, no
// argv, no image and no Repo. It MINTS its states, its events and its own Agents; it BORROWS every
// other part by slot name from the Open body it binds (open-body.ts). So authority is a constant
// the door checks, and data flows only through references: a placeholder `{{context.ticket}}` or
// an object `{ "$ref": "event.notes" }`, a path lookup that jr2's own code performs. There is no
// evaluation, no operator and no call, and the roots are `context`, `event` and `input` only.
//
// The door is static and mandatory, because xstate refuses nothing: an un-lent `src` kills the
// Chart wrapper, an unknown action is ignored, an unknown delay fires at once, and an unguarded `always`
// cycle exhausts the heap. `admitChart` checks, in this order: (1) the size, (2) the grammar,
// (3) the names, (4) the events, (5) the minted Agents, (6) the structure, (7) the dataflow and
// (8) the lent input shapes. Each refusal is one line that starts with the path in the Chart, so
// an author (or a planner Agent, which reads the report as its answer) can find and fix it.
//
// This module is socket-free. It builds a Machine once, as the last check: a trial `compileChart`
// (open-body.ts), so that `jr2Setup`'s own refusals and load warnings are lines of the same report.

import { createHash } from "node:crypto";
import { z } from "zod";
import { defineEvent, type EventAudience, type EventDef } from "@jr2/agent-protocol";
import type { AgentDefinition, ThinkingLevel, WorkspaceAccess } from "./agent.ts";
import { inputKeysOf, isEffect } from "./effect.ts";
import { compileChart, durationMs, type LentParts, type OpenBodyDeclaration } from "./open-body.ts";
import { SENT_BY } from "./party.ts";
import { loadWarningsOf } from "./vocabulary.ts";

// --- The text -------------------------------------------------------------------------------------

/** Plain JSON. */
export type ChartJson = string | number | boolean | null | ChartJson[] | { [key: string]: ChartJson };

/**
 * A value whose strings may hold `{{<root>.<path>}}` placeholders and whose objects may be
 * `{ "$ref": "<root>.<path>" }`. Resolved by {@link resolveReferences} at invoke time.
 */
export type ChartValue = ChartJson;

/** A guard: a lent guard by name, with or without params, `jr2.sentBy`, or `not`/`and`/`or`. */
export type ChartGuard =
  | string
  | { type: string; params?: ChartValue }
  | { not: ChartGuard }
  | { and: ChartGuard[] }
  | { or: ChartGuard[] };

/**
 * An action. The four generic ones write the run's context at `path`, a context path WITHOUT the
 * `context.` root (`"round"`, `"ticket.notes"`, `"items.0"`); every other `type` is a lent action.
 */
export type ChartAction =
  | { type: "set"; path: string; from: ChartValue }
  | { type: "append"; path: string; from: ChartValue }
  | { type: "increment"; path: string; by?: number }
  | { type: "clear"; path: string }
  | { type: string; params?: ChartValue };

/** A transition: a target alone, or the object form. */
export type ChartTransition =
  | string
  | {
      target?: string | string[];
      guard?: ChartGuard;
      actions?: ChartAction[];
      reenter?: boolean;
      description?: string;
    };

/** One transition or a list, in xstate's order. */
export type ChartTransitions = ChartTransition | ChartTransition[];

/** An invoke: a lent Agent, Effect or Machine, a minted Agent, or the kit's `gate`. */
export type ChartInvoke = {
  src: string;
  id?: string;
  input?: ChartValue;
  onDone?: ChartTransitions;
  onError?: ChartTransitions;
};

/** A state node. */
export type ChartState = {
  type?: "atomic" | "compound" | "parallel" | "final" | "history";
  initial?: string;
  states?: Record<string, ChartState>;
  history?: "shallow" | "deep";
  invoke?: ChartInvoke | ChartInvoke[];
  on?: Record<string, ChartTransitions>;
  always?: ChartTransitions;
  after?: Record<string, ChartTransitions>;
  entry?: ChartAction[];
  exit?: ChartAction[];
  output?: ChartValue;
  meta?: ChartJson;
  tags?: string[];
  description?: string;
};

/** An event a Chart mints: its payload is a JSON Schema object, built into zod at admission. */
export type ChartEvent = { description?: string; input: Record<string, unknown>; audience?: EventAudience };

/** An Agent a Chart mints: the plain fields of an Agent definition (ADR-0049). */
export type ChartAgent = {
  model: string;
  instructions: string;
  description?: string;
  thinkingLevel?: ThinkingLevel;
  workspace?: WorkspaceAccess;
};

/** The Chart text (ADR-0070). Every key here is the whole grammar: the door refuses any other. */
export type ChartText = {
  version?: 1;
  /** The machine id. Default: the Open body's slot key. A `#` target needs it. */
  id?: string;
  /** The initial context: plain JSON, no references. */
  context?: Record<string, ChartJson>;
  events?: Record<string, ChartEvent>;
  agents?: Record<string, ChartAgent>;
  initial: string;
  states: Record<string, ChartState>;
  /** The Chart's output, resolved when the Chart is done. */
  output?: ChartValue;
};

/** The four actions every Chart has; every other action `type` is lent. */
export const GENERIC_ACTIONS = ["set", "append", "increment", "clear"] as const;

/** The mechanism events a Chart may handle by name (ADR-0011): jr2 delivers them, no def declares them. */
const MECHANISM_EVENTS: Record<string, { fields: Record<string, boolean> }> = {
  "agent.fault": { fields: { type: true, instanceId: true, reason: true } },
  "workspace.lost": { fields: { type: true, reason: false, message: false } },
};

/** The keys an Agent invoke's input may carry (ADR-0057's Frame and Dials, and the stub tier's
 * placement; see {@link checkAgentInput}). */
const AGENT_INPUT_KEYS = ["prompt", "cwd", "continue", "model", "thinkingLevel"] as const;

/**
 * The Chart briefing (ADR-0070): jr2's text on how a Chart runs, for whoever writes one. It is the
 * grammar's root description, so it rides `GET /workflows/<wrapper>/chart-schema` and a pick's tool
 * parameters; and the surface marks a pick whose parameter is a Chart with it, so the Harness says
 * it in the Turn part when that pick is Allowed (`AgentSurfaceView`). Each sentence is a fault a
 * measured planner made without it. It names no task and no pick.
 */
export const CHART_BRIEFING = chartBriefing();

/**
 * The Chart briefing for one body's grammar: the sentence on where an Agent comes from names the
 * lent Agents, and a body that allows no model has no `agents` to speak of.
 */
export function chartBriefing(narrow?: Narrow): string {
  const lent = narrow?.lentAgents.length ? ` (${narrow.lentAgents.map((n) => `\`${n}\``).join(", ")})` : "";
  const mints = narrow !== undefined && narrow.models.length === 0;
  const gate = narrow?.gate
    ? ' `src: "gate"` is the kit\'s Gate: the Chart waits there for an outside answer (a human, a webhook), ' +
      'one of its `events` with `audience: "external"`, not an Agent\'s Turn.'
    : "";
  const agents = mints
    ? `A state runs an Agent with \`invoke: { src, input: { prompt } }\`: \`src\` is a lent Agent's name${lent}. ` +
      "This Chart mints no Agent of its own: there is no `agents`."
    : `A state runs an Agent with \`invoke: { src, input: { prompt } }\`: \`src\` is a lent Agent's name${lent} or ` +
      "a key of `agents`; a lent Agent needs no entry in `agents`, which mints new ones.";
  return (
    `A Chart is a workflow written as data: states, the events its Agents pick${mints ? "" : ", and the Agents it mints"}. ` +
    `${agents}${gate} An Agent's Turn ends only when it ` +
    "picks one of the Chart's `events`: declare each pick in `events` with an `input` schema " +
    '(`{ "type": "object", "properties": { "<field>": { "type": "string" } }, "required": ["<field>"] }`; a field not in ' +
    "`required` may be absent), and " +
    "handle it in the `on` of the invoking state or a state above it, with a `target`; `onDone` never fires for an " +
    "Agent. A value is a reference: `{{input.<key>}}` (the Chart's input), `{{context.<path>}}`, or " +
    "`{{event.<field>}}` on a transition for the pick it handles. Keep what a pick says with an action " +
    '`{ "type": "set", "path": "<path>", "from": "{{event.<field>}}" }`, and read it back from ' +
    '`context`. The Chart ends at a state of `type: "final"`, and its `output` is resolved from `context` then. ' +
    "A cycle between states needs a guard on one of its edges."
  );
}

/** A Turn's placement (ADR-0057's `AgentTurnPlacement`): never the Chart's to name. The Open body
 * places each Turn its Chart starts from its own input (open-body.ts `PLACEMENT_KEYS`). */
const PLACEMENT_INPUT_KEYS = ["endpoint", "sandbox"] as const;
const THINKING: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** A name: an xstate event type, a state key, a slot key. No dot (xstate's delimiter), no `#`. */
const NAME = /^[A-Za-z0-9_-]+$/;
/** One segment of a path: an identifier, or an integer that indexes an array. */
const SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_-]*|0|[1-9][0-9]*)$/;
/** Segments a path may never walk: they reach the prototype, never the data. */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const ROOTS = ["context", "event", "input"] as const;
type Root = (typeof ROOTS)[number];
/** A placeholder in a Chart string. Its content must be a reference path. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{([^{}]*)\}\}$/;

/** The faults of a context path (`round`, `ticket.notes`), or undefined when it is one. */
function pathFault(path: string): string | undefined {
  const segments = path.split(".");
  for (const s of segments) {
    if (!SEGMENT.test(s)) return `"${path}" is not a path: identifiers or integers joined by "."`;
    if (FORBIDDEN_SEGMENTS.has(s)) return `"${path}" walks "${s}", which no path may name`;
  }
  return undefined;
}

/** The faults of a reference (`context.round`), or undefined when it is one. */
function referenceFault(ref: string): string | undefined {
  const [root, ...rest] = ref.split(".");
  if (!(ROOTS as readonly string[]).includes(root!)) {
    return `"${ref}" is not a reference: it starts at context, event or input (a reference is a path, never an expression)`;
  }
  if (rest.length === 0) return `"${ref}" names a whole root; a reference names a path below it, like "${root}.x"`;
  const fault = pathFault(rest.join("."));
  return fault
    ? `"${ref}" is not a reference: identifiers or integers joined by ".", with no operator or call`
    : undefined;
}

/**
 * The segments of a path: an integer segment is a number, every other a property name. A generic
 * action's `path` is a context path (no `context.` root); a reference keeps its root as segment 0.
 */
export function pathSegments(path: string): Array<string | number> {
  return path.split(".").map((s) => (/^(0|[1-9][0-9]*)$/.test(s) ? Number(s) : s));
}

// --- The grammar ----------------------------------------------------------------------------------

/** What a narrowed grammar fixes as enums (ADR-0070: the grammar with the Chart wrapper's names). */
type Narrow = {
  srcs: string[];
  lentAgents: string[];
  gate: boolean;
  guards: string[];
  actions: string[];
  delays: string[];
  models: string[];
  workspace: string[];
};

const enumOf = (values: string[]): z.ZodType<string> =>
  values.length ? (z.enum(values as [string, ...string[]]) as unknown as z.ZodType<string>) : z.never();

/** Check a value's placeholders and `$ref` objects, adding an issue per fault at its path. */
function referenceIssues(value: unknown, ctx: z.RefinementCtx, path: PropertyKey[]): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(PLACEHOLDER)) {
      const fault = referenceFault(m[1]!.trim());
      if (fault) ctx.addIssue({ code: "custom", path, message: fault });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => referenceIssues(v, ctx, [...path, i]));
    return;
  }
  if (typeof value === "object" && value !== null) {
    if ("$ref" in value) {
      const keys = Object.keys(value);
      const ref = (value as { $ref: unknown }).$ref;
      if (keys.length !== 1) {
        ctx.addIssue({ code: "custom", path, message: "a `$ref` object holds the key `$ref` alone" });
      } else if (typeof ref !== "string") {
        ctx.addIssue({ code: "custom", path: [...path, "$ref"], message: "a `$ref` is a reference path, as a string" });
      } else {
        const fault = referenceFault(ref);
        if (fault) ctx.addIssue({ code: "custom", path: [...path, "$ref"], message: fault });
      }
      return;
    }
    for (const [k, v] of Object.entries(value)) referenceIssues(v, ctx, [...path, k]);
  }
}

/** The deepest a Chart's JSON may nest (objects and lists): zod and the canonical form recurse. */
const MAX_JSON_DEPTH = 64;

/**
 * The faults of a Chart's raw JSON that zod cannot report: nesting deeper than
 * {@link MAX_JSON_DEPTH} (zod's walk would overflow the stack) and a key that reaches the
 * prototype (`__proto__`, which zod drops with no message, `constructor` and `prototype`). One
 * walk with an explicit stack, so no text can overflow it; at most a few lines.
 */
export function jsonFaults(value: unknown): Array<{ path: PropertyKey[]; message: string }> {
  const out: Array<{ path: PropertyKey[]; message: string }> = [];
  const stack: Array<{ v: unknown; path: PropertyKey[] }> = [{ v: value, path: [] }];
  while (stack.length && out.length < 8) {
    const { v, path } = stack.pop()!;
    if (typeof v !== "object" || v === null) continue;
    if (path.length >= MAX_JSON_DEPTH) {
      out.push({ path, message: `the text nests deeper than ${MAX_JSON_DEPTH} objects and lists here` });
      continue;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => stack.push({ v: x, path: [...path, i] }));
      continue;
    }
    for (const key of Object.keys(v)) {
      if (FORBIDDEN_SEGMENTS.has(key)) {
        out.push({ path: [...path, key], message: `a key named "${key}" is refused anywhere in a Chart` });
        continue;
      }
      stack.push({ v: (v as Record<string, unknown>)[key], path: [...path, key] });
    }
  }
  return out;
}

/**
 * The prefix of the grammar's JSON Schema ids (`$defs` keys): a schema that holds the grammar
 * beside one of the author's own never meets a duplicate id.
 */
const ID_PREFIX = "jr2.";

function grammar(narrow?: Narrow): z.ZodType<ChartText> {
  const name = (what: string) => z.string().regex(NAME, `a ${what} is letters, digits, "_" and "-" only`);
  const template = z
    .json()
    .superRefine((v, ctx) => referenceIssues(v, ctx, []))
    .describe(
      'JSON. A string may hold placeholders like "{{context.ticket.title}}", and an object { "$ref": "event.notes" } ' +
        "is replaced by the value. The roots are context, event and input; a reference is a path, never an expression.",
    );
  // Plain data: a `{{` or a `$ref` in it is never resolved, as in any value a reference inserts.
  const plain = z.json();
  const contextPath = z
    .string()
    .superRefine((p, ctx) => {
      const fault = pathFault(p);
      if (fault) ctx.addIssue({ code: "custom", message: fault });
    })
    .describe('A context path without the "context." root, like "round" or "ticket.notes".');

  // `jr2.sentBy` is the kit's routing guard (ADR-0015), and the one guard that is never lent.
  const sentByArm = z.strictObject({ type: z.literal(SENT_BY), params: z.strictObject({ id: z.string() }) });
  const lentGuardName = narrow
    ? enumOf(narrow.guards)
    : z.string().refine((t) => t !== SENT_BY, { message: `"${SENT_BY}" takes params { id }` });
  const guard: z.ZodType<ChartGuard> = z
    .union([
      lentGuardName,
      sentByArm,
      z.strictObject({ type: lentGuardName, params: template.optional() }),
      z.strictObject({
        get not() {
          return guard;
        },
      }),
      z.strictObject({
        get and() {
          return z.array(guard).min(1);
        },
      }),
      z.strictObject({
        get or() {
          return z.array(guard).min(1);
        },
      }),
    ])
    .meta({
      id: `${ID_PREFIX}ChartGuard`,
      description: "A lent guard by name, `jr2.sentBy`, or not/and/or of guards.",
    }) as never;

  const lentActionName = narrow
    ? enumOf(narrow.actions)
    : z.string().refine((t) => !(GENERIC_ACTIONS as readonly string[]).includes(t), {
        message: "a generic action takes its own fields",
      });
  const action: z.ZodType<ChartAction> = z
    .union([
      z.strictObject({ type: z.literal("set"), path: contextPath, from: template }),
      z.strictObject({ type: z.literal("append"), path: contextPath, from: template }),
      z.strictObject({ type: z.literal("increment"), path: contextPath, by: z.number().int().optional() }),
      z.strictObject({ type: z.literal("clear"), path: contextPath }),
      z.strictObject({ type: lentActionName, params: template.optional() }),
    ])
    .meta({
      id: `${ID_PREFIX}ChartAction`,
      description: "A generic action (set, append, increment, clear) or a lent one.",
    }) as never;

  const target = z.string().min(1);
  const transition: z.ZodType<ChartTransition> = z
    .union([
      target,
      z.strictObject({
        target: z.union([target, z.array(target).min(1)]).optional(),
        guard: guard.optional(),
        actions: z.array(action).optional(),
        reenter: z.boolean().optional(),
        description: z.string().optional(),
      }),
    ])
    .meta({
      id: `${ID_PREFIX}ChartTransition`,
      description: 'A target ("sibling", ".child", "#<chart id>.a.b"), or { target, guard, actions }.',
    }) as never;
  const transitions = z.union([transition, z.array(transition)]);

  const src = narrow
    ? z.union([enumOf(narrow.srcs), z.string().describe("A minted Agent: a key of this Chart's own `agents`.")])
    : z.string();
  const invoke = z
    .strictObject({
      src: src.describe(
        "A lent Agent, Effect or Machine by its name; the kit's `gate` (waits for an outside answer: a human, a " +
          "webhook) where the body lends it; or a key of this Chart's `agents`.",
      ),
      id: name("invoke id").optional(),
      input: template.optional().describe("An Agent takes `{ prompt }`; an Effect or a Machine takes its own input."),
      onDone: transitions
        .optional()
        .describe(
          "For an Effect or a Machine that settles. Never for an Agent: its Turn ends by a pick, handled in `on`.",
        ),
      onError: transitions.optional(),
    })
    .meta({ id: `${ID_PREFIX}ChartInvoke` });

  const delayKey = narrow
    ? z.union([
        enumOf(narrow.delays),
        z
          .string()
          .regex(/^(0|[1-9][0-9]{0,9})$/)
          .describe(`an integer of ms, at most ${MAX_TIMER_MS} (a longer timer fires at once) and the wall clock`),
      ])
    : z
        .string()
        .regex(/^(?:[A-Za-z_][A-Za-z0-9_-]*|0|[1-9][0-9]*)$/, "a delay is a lent delay name or an integer of ms");

  const state: z.ZodType<ChartState> = z
    .strictObject({
      type: z.enum(["atomic", "compound", "parallel", "final", "history"]).optional(),
      initial: z.string().optional(),
      get states() {
        return z.record(name("state key"), state).optional();
      },
      history: z.enum(["shallow", "deep"]).optional(),
      invoke: z.union([invoke, z.array(invoke)]).optional(),
      on: z.record(z.string(), transitions).optional(),
      always: transitions.optional(),
      after: z.record(delayKey, transitions).optional(),
      entry: z.array(action).optional(),
      exit: z.array(action).optional(),
      output: template.optional(),
      meta: z.json().optional(),
      tags: z.array(z.string()).optional(),
      description: z.string().optional(),
    })
    .meta({ id: `${ID_PREFIX}ChartState` }) as never;

  const event = z.strictObject({
    description: z.string().optional(),
    input: z
      .looseObject({ type: z.literal("object") })
      .describe(
        "The pick's payload, as a JSON Schema of type object: `properties` are its fields, read as `event.<field>`, " +
          "and a field not in `required` may be absent.",
      ),
    audience: z.enum(["agent", "external", "any"]).optional(),
  });
  const agentDef = z.strictObject({
    model: narrow ? enumOf(narrow.models) : z.string().min(1),
    instructions: z.string(),
    description: z.string().optional(),
    thinkingLevel: z.enum(THINKING as [ThinkingLevel, ...ThinkingLevel[]]).optional(),
    workspace: (narrow ? enumOf(narrow.workspace) : z.enum(["write", "read", "none"])).optional(),
  });

  return z
    .strictObject({
      version: z.literal(1).optional(),
      id: name("machine id").optional(),
      context: z.record(z.string(), plain).optional().describe("Initial context: plain data, no references."),
      events: z
        .record(name("event name"), event)
        .optional()
        .describe("Every pick an Agent of this Chart may make, by name; a state handles it in `on`."),
      // A body that allows no model mints nothing, so its grammar has no `agents` at all: a planner
      // reads a field it cannot fill as one to fill (measured: eight of ten first Charts minted).
      ...(narrow !== undefined && narrow.models.length === 0
        ? {}
        : {
            agents: z
              .record(name("slot key"), agentDef)
              .optional()
              .describe("The Agents this Chart mints. A lent Agent is not listed here: it is invoked by its name."),
          }),
      initial: z.string(),
      states: z.record(name("state key"), state),
      output: template.optional().describe("Resolved from `context` when the Chart reaches a final state."),
    })
    .describe(chartBriefing(narrow)) as unknown as z.ZodType<ChartText>;
}

/**
 * The Chart grammar (ADR-0070), as zod. A door field or a pick param that IS this schema is a
 * Chart field: `isChartSchema` tells, and jr2 reads a Chart wrapper's one-shot door off it.
 */
export const chartSchema: z.ZodType<ChartText> = guarded(grammar());

/** The defs of every Chart grammar: {@link chartSchema} and each {@link chartSchemaFor}. */
const chartSchemaDefs = new WeakSet<object>([(chartSchema as unknown as { _zod: { def: object } })._zod.def]);
/** The briefing of every Chart grammar, by def: the text the surface marks a Chart pick with. */
const chartBriefings = new WeakMap<object, string>([
  [(chartSchema as unknown as { _zod: { def: object } })._zod.def, CHART_BRIEFING],
]);

/** A grammar behind the raw-JSON check, which runs before zod's own walk. */
function guarded(inner: z.ZodType<ChartText>, narrow?: Narrow): z.ZodType<ChartText> {
  return z.preprocess((value, ctx) => {
    // Before zod's own walk, which recurses: a text too deep for it is a report line, never a throw.
    for (const fault of jsonFaults(value)) {
      ctx.addIssue({ code: "custom", path: fault.path, message: fault.message, input: value });
    }
    // The grammar has no `agents` under a body that mints nothing: the line says why, where the
    // strict object would say "unrecognized key".
    if (narrow?.models.length === 0 && typeof value === "object" && value !== null && "agents" in value) {
      const lent = narrow.lentAgents.length ? narrow.lentAgents.join(", ") : "none";
      ctx.addIssue({
        code: "custom",
        path: ["agents"],
        message: `this body allows no model, so a Chart under it mints no Agent; its Agents are the lent ones: ${lent}`,
        input: value,
      });
    }
    return value;
  }, inner) as unknown as z.ZodType<ChartText>;
}

/** Is this schema a Chart grammar, under `.optional()`, `.nullable()`, `.default()` or a description? */
export function isChartSchema(schema: unknown): boolean {
  return chartBriefingOf(schema) !== undefined;
}

/** The Chart briefing of a Chart field's grammar, or undefined for a schema that is no Chart grammar. */
export function chartBriefingOf(schema: unknown): string | undefined {
  let s = schema as { _zod?: { def?: { innerType?: unknown } } } | undefined;
  for (let i = 0; i < 8 && s?._zod?.def; i++) {
    if (chartSchemaDefs.has(s._zod.def)) return chartBriefings.get(s._zod.def);
    s = s._zod.def.innerType as typeof s;
  }
  return undefined;
}

const narrowedSchemas = new WeakMap<OpenBodyDeclaration, z.ZodType<ChartText>>();

/**
 * The Chart grammar as zod, narrowed to one Open body (ADR-0070): the lent `src` names, guard,
 * action and delay names, and the allowed models and Workspace accesses are enums. A planner's
 * pick whose field is this schema gets the narrowed grammar as its tool parameters, so the model
 * is constrained when it writes the Chart; a Chart wrapper's door may take it too. Either way it
 * is a Chart field (`isChartSchema`), and the door still admits the Chart against the lent set the
 * body has at its start. One schema per declaration.
 */
export function chartSchemaFor(decl: OpenBodyDeclaration): z.ZodType<ChartText> {
  const hit = narrowedSchemas.get(decl);
  if (hit) return hit;
  const narrow = narrowOf(decl);
  const schema = guarded(grammar(narrow), narrow);
  chartSchemaDefs.add((schema as unknown as { _zod: { def: object } })._zod.def);
  chartBriefings.set((schema as unknown as { _zod: { def: object } })._zod.def, chartBriefing(narrow));
  narrowedSchemas.set(decl, schema);
  return schema;
}

/** The names an Open body lends, in each kind, as lists. */
function lendsOf(decl: OpenBodyDeclaration) {
  return {
    agents: decl.lends.agents ?? [],
    effects: decl.lends.effects ?? [],
    machines: decl.lends.machines ?? [],
    guards: decl.lends.guards ?? [],
    actions: decl.lends.actions ?? [],
    delays: decl.lends.delays ?? [],
    gate: decl.lends.gate === true,
  };
}

/**
 * The Chart grammar as JSON Schema, narrowed to one Open body (ADR-0070): `GET
 * /workflows/<wrapper>/chart-schema`. The lent `src` names, guard, action and delay names, and the
 * allowed models and Workspace accesses are `enum`s, so an editor completes them and a planner's
 * pick is constrained when the model writes it.
 */
export function narrowedChartSchema(decl: OpenBodyDeclaration): Record<string, unknown> {
  return z.toJSONSchema(grammar(narrowOf(decl)), { unrepresentable: "any" }) as Record<string, unknown>;
}

/** What one Open body's declaration fixes as enums in the grammar. */
function narrowOf(decl: OpenBodyDeclaration): Narrow {
  const l = lendsOf(decl);
  return {
    srcs: [...l.agents, ...l.effects, ...l.machines, ...(l.gate ? ["gate"] : [])],
    lentAgents: l.agents,
    gate: l.gate,
    guards: l.guards,
    actions: l.actions,
    delays: l.delays,
    models: [...decl.allows.models],
    workspace: [...decl.allows.workspace],
  };
}

// --- Canonical form and hash ----------------------------------------------------------------------

/** The canonical JSON of a value: object keys sorted, no whitespace. Undefined object values are
 * dropped, as `JSON.stringify` drops them. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const walk = (v: unknown): string => {
    if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error(`${v} is not JSON`);
      return JSON.stringify(v);
    }
    if (typeof v !== "object") throw new Error(`a ${typeof v} is not JSON`);
    if (seen.has(v)) throw new Error("a cycle is not JSON");
    seen.add(v);
    const out = Array.isArray(v)
      ? `[${v.map((x) => (x === undefined ? "null" : walk(x))).join(",")}]`
      : `{${Object.keys(v)
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${walk((v as Record<string, unknown>)[k])}`)
          .join(",")}}`;
    seen.delete(v);
    return out;
  };
  return walk(value);
}

/** A Chart's identity (ADR-0070, D-B): sha256 of its canonical JSON, 12 hex. Key order does not count. */
export function chartHash(text: ChartText): string {
  return chartDigest(text).slice(0, 12);
}

/** The full sha256 of a Chart's canonical JSON, 64 hex: a key no one can collide by search, as
 * the compile memo needs. {@link chartHash} is its first 12 hex, for display and the stamp. */
export function chartDigest(text: ChartText): string {
  return createHash("sha256").update(canonicalJson(text)).digest("hex");
}

// --- References -----------------------------------------------------------------------------------

/** Every reference a value makes, as written (`context.round`), in the order met. */
export function referencesOf(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(PLACEHOLDER)) out.push(m[1]!.trim());
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) {
      if ("$ref" in v && typeof (v as { $ref: unknown }).$ref === "string" && Object.keys(v).length === 1) {
        out.push((v as { $ref: string }).$ref);
        return;
      }
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return out;
}

/** The value at a reference, walking own properties only. A missing path throws: the door made
 * it impossible, so a throw here is a defect. */
function lookup(ref: string, scope: { context: unknown; event: unknown; input: unknown }): unknown {
  const [root, ...rest] = pathSegments(ref);
  if (!(ROOTS as readonly unknown[]).includes(root)) throw new Error(`Chart reference "${ref}": no root "${root}"`);
  let v: unknown = scope[root as Root];
  for (const seg of rest) {
    if (typeof v !== "object" || v === null || !Object.hasOwn(v, seg) || FORBIDDEN_SEGMENTS.has(String(seg))) {
      throw new Error(`Chart reference "${ref}" resolves to nothing (at "${seg}")`);
    }
    v = (v as Record<string | number, unknown>)[seg];
  }
  if (v === undefined) throw new Error(`Chart reference "${ref}" resolves to nothing`);
  return v;
}

/**
 * Resolve a value's references against the run's `{ context, event, input }` (ADR-0070). A path walk and
 * string interpolation only: a string that is exactly one placeholder yields the value itself (so
 * an object can be passed); any other string interpolates each value (a string as itself, an
 * object or a list as its JSON, anything else through `String`). `{{` inside DATA is never
 * resolved: the walk reads only the value's own strings, and an inserted value is never read
 * again.
 */
export function resolveReferences(
  value: unknown,
  scope: { context: unknown; event: unknown; input: unknown },
): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_PLACEHOLDER.exec(value);
    if (whole) return lookup(whole[1]!.trim(), scope);
    return value.replace(PLACEHOLDER, (_m, ref: string) => {
      const v = lookup(ref.trim(), scope);
      return typeof v === "string" ? v : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveReferences(v, scope));
  if (typeof value === "object" && value !== null) {
    const ref = (value as { $ref?: unknown }).$ref;
    if (typeof ref === "string" && Object.keys(value).length === 1) return lookup(ref, scope);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveReferences(v, scope)]));
  }
  return value;
}

/**
 * Resolve the source of a generic `set` or `append`: undefined when it is one reference whose
 * path is absent (an optional field the door admitted there), so the write writes nothing and the
 * path keeps what it had; else what {@link resolveReferences} gives.
 */
export function resolveSource(
  value: unknown,
  scope: { context: unknown; event: unknown; input: unknown },
): { value: unknown } | undefined {
  const ref = wholeRefOf(value);
  if (ref !== undefined) {
    try {
      return { value: lookup(ref, scope) };
    } catch {
      return undefined;
    }
  }
  return { value: resolveReferences(value, scope) };
}

// --- The door -------------------------------------------------------------------------------------

/** The door's refusal: one line per fault, each starting with the path in the Chart. */
export class ChartRefusal extends Error {
  readonly report: string[];
  constructor(report: string[]) {
    super(`Chart refused:\n${report.map((line) => `- ${line}`).join("\n")}`);
    this.name = "ChartRefusal";
    this.report = report;
  }
}

/** A Chart the door admitted: its text and hash, its minted events and Agents, its size. */
export type AdmittedChart = {
  text: ChartText;
  hash: string;
  events: EventDef[];
  agents: Record<string, AgentDefinition>;
  /** The bytes of the text's canonical JSON. */
  size: number;
};

/** What the door knows beyond the declaration and the lent set. */
export type AdmitOptions = {
  /**
   * The keys the Chart's `input` has: the body invoke's input minus its Chart fields (the
   * Chart wrapper's door schema minus its Chart fields, or the live input at start). Given, an
   * `input.<key>` reference is checked against it; absent, `input` references are not checked.
   */
  inputKeys?: readonly string[];
};

const MAX_STATES = 200;
/** The longest delay a timer holds: Node clamps a longer `setTimeout` to 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
const MAX_NESTING = 8;

type Line = { rule: number; line: string };

/** The `{ states }` tree of an unknown value: its state count and its deepest nesting. */
function measure(text: unknown): { states: number; depth: number } {
  let states = 0;
  let depth = 0;
  const walk = (node: unknown, d: number): void => {
    const children = (node as { states?: unknown } | null)?.states;
    if (typeof children !== "object" || children === null || Array.isArray(children)) return;
    for (const child of Object.values(children)) {
      states++;
      depth = Math.max(depth, d + 1);
      if (d + 1 <= MAX_NESTING + 1) walk(child, d + 1);
    }
  };
  walk(text, 0);
  return { states, depth };
}

/** A zod issue tree as report lines. A union failure reports the arm the value came closest to. */
function issueLines(
  issues: readonly z.core.$ZodIssue[],
  base: PropertyKey[] = [],
): Array<{ path: PropertyKey[]; message: string; code: string }> {
  const out: Array<{ path: PropertyKey[]; message: string; code: string }> = [];
  for (const issue of issues) {
    const path = [...base, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length) {
      const arms = issue.errors.map((arm) => issueLines(arm, path));
      const rootTypes = arms.every(
        (a) => a.length === 1 && a[0]!.code === "invalid_type" && a[0]!.path.length === path.length,
      );
      if (rootTypes) {
        const expected = [...new Set(issue.errors.map((arm) => String((arm[0] as { expected?: unknown }).expected)))];
        const found = /received (\w+)/.exec(arms[0]![0]!.message)?.[1];
        out.push({
          path,
          code: "invalid_type",
          message: `expected ${expected.join(" or ")}${found ? `, found ${found}` : ""}`,
        });
        continue;
      }
      const score = (arm: typeof out): number =>
        arm.reduce((s, l) => {
          if (l.path.length === path.length && l.code === "invalid_type") return s + 100;
          if (l.path.length === path.length + 1 && l.path[l.path.length - 1] === "type") return s + 50;
          return s + 1;
        }, 0);
      const best = arms.reduce((a, b) => (score(b) < score(a) ? b : a));
      out.push(...best);
      continue;
    }
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        out.push({ path: [...path, key], code: issue.code, message: "this key is not in the Chart grammar here" });
      }
      continue;
    }
    if (issue.code === "invalid_key") {
      const inner = issue.issues.map((i) => i.message).join("; ");
      out.push({ path, code: issue.code, message: `the key is refused: ${inner}` });
      continue;
    }
    out.push({ path, code: issue.code, message: issue.message });
  }
  return out;
}

const pathText = (path: readonly PropertyKey[]): string => (path.length ? path.map(String).join(".") : "(chart)");

/** One state of the Chart, indexed for the checks. */
type Node = {
  key: string;
  /** The doc path: `states.review.states.wait`; the root's is "". */
  doc: string;
  state: ChartState;
  kind: NonNullable<ChartState["type"]>;
  parent?: Node;
  children: Map<string, Node>;
};

/** Where a reference may look for `event`. */
type EventScope =
  | { kind: "none"; why: string }
  | { kind: "event"; name: string }
  | { kind: "mechanism"; name: string }
  | { kind: "done" }
  | { kind: "error" }
  /** The event was refused: its `event` references are not checked again. */
  | { kind: "skip" };

const at = (doc: string, rest: string): string => (doc ? `${doc}.${rest}` : rest);
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const listAt = <T>(v: T | T[] | undefined, path: string): Array<[T, string]> =>
  v === undefined ? [] : Array.isArray(v) ? v.map((x, i) => [x, `${path}.${i}`]) : [[v, path]];
const names = (xs: readonly string[]): string => (xs.length ? xs.join(", ") : "none");

/**
 * Admit a Chart against an Open body's declaration and the lent set it has now (ADR-0070). Returns
 * the admitted Chart, or throws {@link ChartRefusal} with every fault, rule by rule.
 */
export function admitChart(
  text: unknown,
  decl: OpenBodyDeclaration,
  lent: LentParts,
  options: AdmitOptions = {},
): AdmittedChart {
  // 1. Size: the JSON's nesting and keys, the canonical JSON, the state count, the state nesting.
  const shape = jsonFaults(text);
  if (shape.length) throw new ChartRefusal(shape.map((f) => `${pathText(f.path)}: ${f.message}`));
  let canonical: string;
  try {
    canonical = canonicalJson(text);
  } catch (err) {
    throw new ChartRefusal([`(chart): the text is not JSON: ${(err as Error).message}`]);
  }
  const size = Buffer.byteLength(canonical, "utf8");
  const sized: string[] = [];
  if (size > decl.ceilings.size) {
    sized.push(`(chart): the text is ${size} bytes; this Open body's ceiling is ${decl.ceilings.size}`);
  }
  const { states: stateCount, depth } = measure(text);
  if (stateCount > MAX_STATES) sized.push(`states: the Chart has ${stateCount} states; at most ${MAX_STATES}`);
  if (depth > MAX_NESTING) sized.push(`states: the Chart nests states ${depth} deep; at most ${MAX_NESTING}`);
  if (sized.length) throw new ChartRefusal(sized);

  // 2. Grammar.
  const parsed = chartSchema.safeParse(text);
  if (!parsed.success) {
    throw new ChartRefusal(issueLines(parsed.error.issues).map((l) => `${pathText(l.path)}: ${l.message}`));
  }
  const chart = parsed.data;
  return new Door(chart, decl, lent, options).admit(size);
}

/** The checks from rule 3 on, over a Chart the grammar admitted. */
class Door {
  private readonly lines: Line[] = [];
  private readonly lends: ReturnType<typeof lendsOf>;
  private readonly root: Node;
  private readonly nodes: Node[] = [];
  /** The minted events' JSON Schemas, by name. */
  private readonly eventSchemas = new Map<string, Record<string, unknown>>();
  private readonly handled = new Set<string>();
  /** Every context path a generic `set`, `append` or `increment` writes, with the event its
   * transition handles. */
  private readonly written: Array<{
    path: Array<string | number>;
    kind: "set" | "append" | "increment";
    from?: ChartValue;
    scope: EventScope;
    /** The action's path in the Chart, for a line that names the write. */
    at: string;
  }> = [];
  /** Every reference, checked once the walk has seen every write (rule 7). */
  private readonly refs: Array<{ ref: string; path: string; scope: EventScope; optionalOk: boolean }> = [];
  /** Every `always` edge, for the cycle check. */
  private readonly alwaysEdges: Array<{
    from: Node;
    targets: Node[];
    guarded: boolean;
    reenter: boolean;
    doc: string;
  }> = [];
  /** What each invoke's `src` names, once rule 3 resolved it. */
  private readonly invokeKinds = new Map<ChartInvoke, NonNullable<ReturnType<Door["srcKind"]>>>();
  /** Every `jr2.sentBy` id, for the party check. */
  private readonly sentBys: Array<{ id: string; path: string }> = [];

  private readonly chart: ChartText;
  private readonly decl: OpenBodyDeclaration;
  private readonly lent: LentParts;
  private readonly options: AdmitOptions;

  constructor(chart: ChartText, decl: OpenBodyDeclaration, lent: LentParts, options: AdmitOptions) {
    this.chart = chart;
    this.decl = decl;
    this.lent = lent;
    this.options = options;
    this.lends = lendsOf(decl);
    this.root = this.index("(root)", "", { initial: chart.initial, states: chart.states }, undefined, "compound");
    for (const [name, ev] of Object.entries(chart.events ?? {})) this.eventSchemas.set(name, ev.input);
  }

  private fail(rule: number, line: string): void {
    this.lines.push({ rule, line });
  }

  private index(key: string, doc: string, state: ChartState, parent: Node | undefined, kind?: Node["kind"]): Node {
    const node: Node = {
      key,
      doc,
      state,
      kind: kind ?? state.type ?? (state.states && Object.keys(state.states).length ? "compound" : "atomic"),
      parent,
      children: new Map(),
    };
    if (parent) this.nodes.push(node);
    for (const [k, child] of Object.entries(state.states ?? {})) {
      node.children.set(k, this.index(k, at(doc, `states.${k}`), child, node));
    }
    return node;
  }

  admit(size: number): AdmittedChart {
    this.checkEvents();
    this.checkAgents();
    if (!this.root.children.has(this.chart.initial)) {
      this.fail(
        6,
        `initial: "${this.chart.initial}" is not a state here; states: ${names([...this.root.children.keys()])}`,
      );
    }
    for (const node of this.nodes) this.checkState(node);
    this.checkUnhandled();
    this.checkAlwaysCycles();
    this.checkParties();
    this.checkOutput(this.chart.output, "output", {
      kind: "none",
      why: "the Chart's output is resolved when it is done",
    });
    this.checkAllRefs();

    if (this.lines.length) {
      const sorted = this.lines.map((l, i) => ({ ...l, i })).sort((a, b) => a.rule - b.rule || a.i - b.i);
      throw new ChartRefusal(sorted.map((l) => l.line));
    }
    const events = Object.entries(this.chart.events ?? {}).map(([name, ev]) => this.eventDef(name, ev)!);
    const agents: Record<string, AgentDefinition> = {};
    for (const [slot, a] of Object.entries(this.chart.agents ?? {})) agents[slot] = { ...a };
    const admitted: AdmittedChart = { text: this.chart, hash: chartHash(this.chart), events, agents, size };
    this.trialCompile(admitted);
    return admitted;
  }

  /**
   * The last check: compile the Chart as the Open body will, so `jr2Setup`'s own refusals (ADR-0011,
   * ADR-0015, ADR-0067) and its load warnings are lines of this report, at every door (a PUT, a
   * Chart file, a one-shot start) and not first at the body's start. For a Chart a warning is a
   * refusal: no author reads a planner's Chart at load, so a warning nobody reads is a silent fault.
   */
  private trialCompile(admitted: AdmittedChart): void {
    let lines: string[];
    try {
      const machine = compileChart(admitted, this.lent, this.decl);
      lines = loadWarningsOf(machine);
    } catch (err) {
      if (err instanceof ChartRefusal) throw err;
      lines = [err instanceof Error ? err.message : String(err)];
    }
    if (lines.length) throw new ChartRefusal(lines.map((l) => `(chart): ${l.replace(/^machine "[^"]*": /, "")}`));
  }

  // --- rule 3: names --------------------------------------------------------------------------------

  /** The lent actors by kind, as the lent set has them now. */
  private lentActors(): Array<{ name: string; kind: "Agent" | "Effect" | "Machine" }> {
    const out: Array<{ name: string; kind: "Agent" | "Effect" | "Machine" }> = [];
    for (const name of this.lends.agents) if (name in this.lent.actors) out.push({ name, kind: "Agent" });
    for (const name of this.lends.effects) if (name in this.lent.actors) out.push({ name, kind: "Effect" });
    for (const name of this.lends.machines) if (name in this.lent.actors) out.push({ name, kind: "Machine" });
    return out;
  }

  private lentText(): string {
    const actors = this.lentActors().map((a) => `${a.name} (${a.kind})`);
    const minted = Object.keys(this.chart.agents ?? {});
    return `lent: ${names(actors)}; kit: ${this.lends.gate ? "gate" : "none"}; minted: ${names(minted)}`;
  }

  /** What an invoke's `src` names, or undefined after a refusal line. */
  private srcKind(src: string, path: string): "agent" | "minted" | "effect" | "machine" | "gate" | undefined {
    const lentNow = (name: string) => name in this.lent.actors;
    const declared = [...this.lends.agents, ...this.lends.effects, ...this.lends.machines];
    if (declared.includes(src) && !lentNow(src)) {
      this.fail(
        3,
        `${path}: "${src}" is lent by the Open body, but the Chart wrapper has no actor slot "${src}" now; ${this.lentText()}`,
      );
      return undefined;
    }
    if (this.lends.agents.includes(src)) return "agent";
    if (this.lends.effects.includes(src)) return "effect";
    if (this.lends.machines.includes(src)) return "machine";
    if (src === "gate") {
      if (this.lends.gate) return "gate";
      this.fail(
        3,
        `${path}: "gate" is the kit's Gate, which waits for an outside answer (a human, a webhook), and this Open body does not lend it (\`lends.gate: true\` would); ${this.lentText()}`,
      );
      return undefined;
    }
    if (Object.hasOwn(this.chart.agents ?? {}, src)) return "minted";
    this.fail(3, `${path}: "${src}" is not a lent actor or an Agent of this Chart; ${this.lentText()}`);
    return undefined;
  }

  private checkGuard(guard: ChartGuard, path: string, scope: EventScope): void {
    if (typeof guard === "string") return this.checkGuardName(guard, path);
    if ("not" in guard) return this.checkGuard(guard.not, `${path}.not`, scope);
    if ("and" in guard) return guard.and.forEach((g, i) => this.checkGuard(g, `${path}.and.${i}`, scope));
    if ("or" in guard) return guard.or.forEach((g, i) => this.checkGuard(g, `${path}.or.${i}`, scope));
    if (guard.type === SENT_BY) {
      this.sentBys.push({ id: (guard.params as { id: string }).id, path: `${path}.params.id` });
      return;
    }
    this.checkGuardName(guard.type, `${path}.type`);
    if (guard.params !== undefined) this.checkRefs(guard.params, `${path}.params`, scope);
  }

  private checkGuardName(name: string, path: string): void {
    const lent = this.lends.guards.filter((g) => g in this.lent.guards);
    if (this.lends.guards.includes(name) && !(name in this.lent.guards)) {
      this.fail(
        3,
        `${path}: guard "${name}" is lent by the Open body, but the Chart wrapper has no guard "${name}" now; lent guards: ${names(lent)}`,
      );
    } else if (!this.lends.guards.includes(name)) {
      this.fail(
        3,
        `${path}: "${name}" is not a lent guard; lent guards: ${names(lent)} (and ${SENT_BY} with params { id })`,
      );
    }
  }

  private checkAction(action: ChartAction, path: string, scope: EventScope): void {
    const t = action.type;
    if ((GENERIC_ACTIONS as readonly string[]).includes(t)) {
      const write = action as { path: string; from?: ChartValue };
      if (t === "set" || t === "append") this.checkRefs(write.from, `${path}.from`, scope, true);
      if (t === "set" || t === "append" || t === "increment") {
        this.written.push({
          path: pathSegments(write.path),
          kind: t,
          ...(write.from === undefined ? {} : { from: write.from }),
          scope,
          at: path,
        });
      }
      return;
    }
    const lent = this.lends.actions.filter((a) => a in this.lent.actions);
    if (this.lends.actions.includes(t) && !(t in this.lent.actions)) {
      this.fail(
        3,
        `${path}.type: action "${t}" is lent by the Open body, but the Chart wrapper has no action "${t}" now; lent actions: ${names(lent)}`,
      );
    } else if (!this.lends.actions.includes(t)) {
      this.fail(
        3,
        `${path}.type: "${t}" is not a generic or a lent action; generic: ${GENERIC_ACTIONS.join(", ")}; lent: ${names(lent)}`,
      );
    }
    const params = (action as { params?: unknown }).params;
    if (params !== undefined) this.checkRefs(params, `${path}.params`, scope);
  }

  private checkDelay(key: string, path: string): void {
    if (/^(0|[1-9][0-9]*)$/.test(key)) {
      // A timer above the clamp fires at once (Node's setTimeout, which xstate's clock uses), the
      // same silent fault as an unknown delay; one above the wall clock can never fire.
      const ms = Number(key);
      const wall = durationMs(this.decl.ceilings.wallClock);
      if (ms > MAX_TIMER_MS) {
        this.fail(3, `${path}: ${key} ms is more than a timer holds (${MAX_TIMER_MS} ms, about 24.8 days)`);
      } else if (wall !== undefined && ms > wall) {
        this.fail(
          3,
          `${path}: ${key} ms is more than this Open body's wallClock ceiling (${this.decl.ceilings.wallClock}), so it never fires`,
        );
      }
      return;
    }
    const lent = this.lends.delays.filter((d) => d in this.lent.delays);
    if (this.lends.delays.includes(key) && !(key in this.lent.delays)) {
      this.fail(
        3,
        `${path}: delay "${key}" is lent by the Open body, but the Chart wrapper has no delay "${key}" now; lent delays: ${names(lent)}`,
      );
    } else if (!this.lends.delays.includes(key)) {
      this.fail(3, `${path}: "${key}" is not a lent delay or an integer of ms; lent delays: ${names(lent)}`);
    }
  }

  /** An `on` key: a Chart event, a mechanism event, or a refusal. */
  private onScope(name: string, path: string): EventScope | undefined {
    if (name === "*") {
      this.fail(3, `${path}: "*" is refused; handle each event by name`);
      return undefined;
    }
    if (name.startsWith("xstate.done.actor.") || name.startsWith("xstate.error.actor.")) {
      this.fail(3, `${path}: "${name}" is refused; write the invoke's \`onDone\` or \`onError\``);
      return undefined;
    }
    if (Object.hasOwn(MECHANISM_EVENTS, name)) return { kind: "mechanism", name };
    if (name.includes(".")) {
      this.fail(
        3,
        `${path}: "${name}" is not an event a Chart may handle (a dotted name is the kit's); mechanism events: ${Object.keys(MECHANISM_EVENTS).join(", ")}; a pick is a Chart event: declare it in \`events\` under a name with no dot, and handle it here in \`on\``,
      );
      return undefined;
    }
    this.handled.add(name);
    if (!this.eventSchemas.has(name)) {
      this.fail(
        4,
        `${path}: event "${name}" is not declared in the Chart's \`events\`; declared: ${names([...this.eventSchemas.keys()])}; a state handles only the events the Chart declares: add \`events.${name}\` with its \`input\` schema (type object), and an Agent in this state gets it as a pick`,
      );
      return undefined;
    }
    return { kind: "event", name };
  }

  // --- rule 4: events -------------------------------------------------------------------------------

  private readonly defs = new Map<string, EventDef | undefined>();

  private eventDef(name: string, ev: ChartEvent): EventDef | undefined {
    if (this.defs.has(name)) return this.defs.get(name);
    let def: EventDef | undefined;
    const path = `events.${name}.input`;
    const faults = payloadSchemaFaults(ev.input);
    if (faults.length) {
      for (const f of faults) this.fail(4, `${pathText([path, ...f.path])}: ${f.message}`);
      this.defs.set(name, undefined);
      return undefined;
    }
    try {
      const input = z.fromJSONSchema(ev.input as never);
      if (!(input instanceof z.ZodObject)) {
        this.fail(4, `${path}: the payload schema must read as an object schema`);
      } else {
        def = defineEvent({
          name,
          input,
          ...(ev.description === undefined ? {} : { description: ev.description }),
          ...(ev.audience === undefined ? {} : { audience: ev.audience }),
        });
      }
    } catch (err) {
      const message = (err as Error).message.replace(/^defineEvent: /, "");
      this.fail(4, `${path}: ${message}`);
    }
    this.defs.set(name, def);
    return def;
  }

  private checkEvents(): void {
    for (const [name, ev] of Object.entries(this.chart.events ?? {})) this.eventDef(name, ev);
  }

  private checkUnhandled(): void {
    for (const name of this.eventSchemas.keys()) {
      if (!this.handled.has(name)) {
        this.fail(
          4,
          `events.${name}: no state handles "${name}"; a pick no state takes is on no Menu and no Gate; handle it in the \`on\` of the state whose Agent should pick it`,
        );
      }
    }
  }

  // --- rule 5: minted Agents ------------------------------------------------------------------------

  private checkAgents(): void {
    const lentNames = new Set([...this.lends.agents, ...this.lends.effects, ...this.lends.machines, "gate"]);
    for (const [slot, a] of Object.entries(this.chart.agents ?? {})) {
      const path = `agents.${slot}`;
      if (lentNames.has(slot)) {
        this.fail(
          5,
          `${path}: "${slot}" is a lent name; a minted Agent takes a slot key of its own; a lent Agent needs no entry in \`agents\`: invoke it as \`src: "${slot}"\` with a \`prompt\``,
        );
      }
      if (!this.decl.allows.models.includes(a.model)) {
        this.fail(
          5,
          `${path}.model: "${a.model}" is not a model this Open body allows; allowed: ${names(this.decl.allows.models)}`,
        );
      }
      const workspace = a.workspace ?? "write";
      if (!this.decl.allows.workspace.includes(workspace)) {
        this.fail(
          5,
          `${path}.workspace: "${workspace}"${a.workspace ? "" : " (the default)"} is not a Workspace access this Open body allows; allowed: ${names(this.decl.allows.workspace)}`,
        );
      }
    }
  }

  // --- rule 6: structure ----------------------------------------------------------------------------

  private checkStructure(node: Node): void {
    const s = node.state;
    const path = node.doc;
    const kids = [...node.children.keys()];
    if (node.kind === "compound") {
      if (!kids.length) this.fail(6, `${path}: a compound state has child \`states\``);
      else if (s.initial === undefined)
        this.fail(6, `${path}.initial: a compound state names its initial child; states: ${names(kids)}`);
      else if (!node.children.has(s.initial))
        this.fail(6, `${path}.initial: "${s.initial}" is not a child; states: ${names(kids)}`);
    } else if (s.initial !== undefined) {
      this.fail(6, `${path}.initial: a ${node.kind} state has no \`initial\``);
    }
    if ((node.kind === "atomic" || node.kind === "final" || node.kind === "history") && kids.length) {
      this.fail(6, `${path}.states: a ${node.kind} state has no child states`);
    }
    if (node.kind === "final") {
      for (const key of ["on", "invoke", "always", "after"] as const) {
        if (s[key] !== undefined) this.fail(6, `${path}.${key}: a final state has no \`${key}\``);
      }
      // A final state's output is read only as the Chart's own output: a Chart has no state
      // `onDone`, and the Chart's `output`, when it has one, is what the Chart outputs.
      if (s.output !== undefined && node.parent !== this.root) {
        this.fail(
          6,
          `${path}.output: only a final state directly under the Chart's \`states\` has an output that is read; a Chart has no state \`onDone\``,
        );
      } else if (s.output !== undefined && this.chart.output !== undefined) {
        this.fail(
          6,
          `${path}.output: the Chart has its own \`output\`, which is what it outputs; this one is never read: keep one of the two`,
        );
      }
    } else if (s.output !== undefined) {
      this.fail(6, `${path}.output: only a final state has an \`output\``);
    }
    if (s.history !== undefined && node.kind !== "history")
      this.fail(6, `${path}.history: only a history state has \`history\``);
  }

  /** Resolve a target as xstate does: `#<id>.a.b` from the root, `.child` below the source, else a sibling path. */
  private resolveTarget(target: string, source: Node, path: string): Node | undefined {
    const walk = (from: Node, keys: string[]): Node | undefined => {
      let n: Node | undefined = from;
      for (const k of keys) {
        n = n.children.get(k);
        if (!n) return undefined;
      }
      return n;
    };
    let found: Node | undefined;
    if (target.startsWith("#")) {
      const [id, ...keys] = target.slice(1).split(".");
      if (this.chart.id === undefined) {
        this.fail(
          6,
          `${path}: "${target}" is a \`#\` target, which needs the Chart's \`id\`; write a sibling or ".child" target, or give the Chart an \`id\``,
        );
        return undefined;
      }
      if (id !== this.chart.id) {
        this.fail(6, `${path}: "${target}" names "#${id}"; this Chart's id is "${this.chart.id}"`);
        return undefined;
      }
      found = walk(this.root, keys);
    } else if (target.startsWith(".")) {
      found = walk(source, target.slice(1).split("."));
    } else {
      found = walk(source.parent ?? this.root, target.split("."));
    }
    if (!found) {
      const siblings = [...(source.parent ?? this.root).children.keys()];
      this.fail(6, `${path}: target "${target}" resolves to no state; siblings: ${names(siblings)}`);
    }
    return found;
  }

  /** Every state below `node`. */
  private descendants(node: Node): Node[] {
    const out: Node[] = [];
    const walk = (n: Node): void => {
      for (const c of n.children.values()) {
        out.push(c);
        walk(c);
      }
    };
    walk(node);
    return out;
  }

  /** The states a state's entry enters below it: its initial child, or every region of a parallel. */
  private enterDown(n: Node, into: Set<Node>): void {
    into.add(n);
    if (n.kind === "parallel") for (const c of n.children.values()) this.enterDown(c, into);
    else if (n.kind === "compound" && n.state.initial !== undefined) {
      const c = n.children.get(n.state.initial);
      if (c) this.enterDown(c, into);
    }
  }

  /** The transition domain, as xstate takes it: the source for a target below it (no `reenter`),
   * else the nearest proper ancestor of the source that holds every target. */
  private domainOf(e: { from: Node; targets: Node[]; reenter: boolean }): Node {
    if (!e.targets.length) return e.from;
    if (!e.reenter && e.targets.every((t) => t !== e.from && isAncestorOrSelf(e.from, t))) return e.from;
    for (let a = e.from.parent; a; a = a.parent) if (e.targets.every((t) => isAncestorOrSelf(a, t))) return a;
    return this.root;
  }

  /**
   * The states an `always` edge enters, or keeps active as the source's ancestors: each target with
   * its ancestors and its initial descendants, the other regions of a parallel state on the way in,
   * and, for a history target, every state below its parent (what it may restore). A targetless
   * edge keeps its source.
   */
  private enteredBy(e: { from: Node; targets: Node[]; reenter: boolean }): Set<Node> {
    const out = new Set<Node>();
    if (!e.targets.length) {
      for (let n: Node | undefined = e.from; n; n = n.parent) out.add(n);
      return out;
    }
    const domain = this.domainOf(e);
    for (const t of e.targets) {
      for (let n: Node | undefined = t; n; n = n.parent) {
        out.add(n);
        // A parallel state on the way in, the domain included, enters its other regions too.
        if (n.kind === "parallel" && isAncestorOrSelf(domain, n)) {
          for (const c of n.children.values()) if (!isAncestorOrSelf(c, t)) this.enterDown(c, out);
        }
      }
      if (t.kind === "history") {
        const parent = t.parent ?? this.root;
        for (const d of this.descendants(parent)) out.add(d);
      } else this.enterDown(t, out);
    }
    return out;
  }

  /** The states an `always` edge may leave active outside its domain: every state in the other
   * regions of a parallel state above the domain (any of them may be active). */
  private keptBy(e: { from: Node; targets: Node[]; reenter: boolean }): Set<Node> {
    const out = new Set<Node>();
    const domain = this.domainOf(e);
    for (let a: Node = domain; a.parent; a = a.parent) {
      const p: Node = a.parent;
      if (p.kind !== "parallel") continue;
      for (const c of p.children.values() as Iterable<Node>) {
        if (c === a) continue;
        out.add(c);
        for (const d of this.descendants(c)) out.add(d);
      }
    }
    return out;
  }

  /**
   * No `always` cycle with an unguarded edge: such a cycle never ends, and exhausts the heap. An
   * edge can follow another when its source is entered by it, or stays active beside it in another
   * region of a parallel state. An edge whose source no `always` edge enters fires at most once, so
   * it is in no cycle (the fixed point below drops it): a region's one-time step beside another
   * region's loop is no cycle.
   */
  private checkAlwaysCycles(): void {
    const edges = this.alwaysEdges;
    const entered = edges.map((e) => this.enteredBy(e));
    const kept = edges.map((e) => this.keptBy(e));
    const live = new Set(edges.map((_e, i) => i));
    for (let changed = true; changed; ) {
      changed = false;
      for (const i of [...live]) {
        if (![...live].some((j) => entered[j]!.has(edges[i]!.from))) {
          live.delete(i);
          changed = true;
        }
      }
    }
    const next = edges.map((_e, i) =>
      [...live].filter((j) => entered[i]!.has(edges[j]!.from) || kept[i]!.has(edges[j]!.from)),
    );
    const reported = new Set<number>();
    edges.forEach((e, i) => {
      if (e.guarded || reported.has(i) || !live.has(i)) return;
      // Search from this unguarded edge for a way back to it.
      const seen = new Set<number>();
      const stack: Array<{ at: number; trail: number[] }> = [{ at: i, trail: [i] }];
      while (stack.length) {
        const { at: cur, trail } = stack.pop()!;
        for (const j of next[cur]!) {
          if (j === i) {
            for (const k of trail) if (!edges[k]!.guarded) reported.add(k);
            const states = trail.map((k) => edges[k]!.from.doc.replace(/^states\./, "").replace(/\.states\./g, "."));
            this.fail(
              6,
              `${e.doc}: an \`always\` cycle (${[...states, states[0]].join(" -> ")}) has an unguarded edge; it would never end: guard every edge of it`,
            );
            return;
          }
          if (!seen.has(j)) {
            seen.add(j);
            stack.push({ at: j, trail: [...trail, j] });
          }
        }
      }
    });
  }

  // --- the walk: rules 3, 6, 7 and 8 per state -------------------------------------------------------

  private checkState(node: Node): void {
    const s = node.state;
    const doc = node.doc;
    this.checkStructure(node);
    const none = (why: string): EventScope => ({ kind: "none", why });

    (s.entry ?? []).forEach((a, i) =>
      this.checkAction(a, `${doc}.entry.${i}`, none("an entry action runs on entering the state")),
    );
    (s.exit ?? []).forEach((a, i) =>
      this.checkAction(a, `${doc}.exit.${i}`, none("an exit action runs on leaving the state")),
    );

    for (const [inv, path] of listAt(s.invoke, `${doc}.invoke`)) {
      const kind = this.srcKind(inv.src, `${path}.src`);
      if (kind) this.invokeKinds.set(inv, kind);
      if (inv.input !== undefined)
        this.checkRefs(inv.input, `${path}.input`, none("an invoke's input is resolved on entering the state"));
      if (kind) this.checkInvokeInput(inv, kind, path);
      this.checkTransitions(inv.onDone, `${path}.onDone`, node, { kind: "done" }, false);
      this.checkTransitions(inv.onError, `${path}.onError`, node, { kind: "error" }, false);
    }
    for (const [name, ts] of Object.entries(s.on ?? {})) {
      const path = `${doc}.on.${name}`;
      const scope = this.onScope(name, path);
      this.checkTransitions(ts, path, node, scope ?? { kind: "skip" }, false);
    }
    this.checkTransitions(s.always, `${doc}.always`, node, none("an `always` transition handles no event"), true);
    for (const [key, ts] of Object.entries(s.after ?? {})) {
      const path = `${doc}.after.${key}`;
      this.checkDelay(key, path);
      this.checkTransitions(ts, path, node, none("an `after` transition handles no event"), false);
    }
    if (s.output !== undefined)
      this.checkOutput(s.output, `${doc}.output`, none("a final state's output is resolved on entering it"));
  }

  private checkOutput(value: ChartValue | undefined, path: string, scope: EventScope): void {
    if (value !== undefined) this.checkRefs(value, path, scope);
  }

  private checkTransitions(
    ts: ChartTransitions | undefined,
    path: string,
    source: Node,
    scope: EventScope,
    always: boolean,
  ): void {
    for (const [t, tpath] of listAt(ts, path)) {
      const obj = typeof t === "string" ? { target: t } : t;
      const targets: Node[] = [];
      let unresolved = false;
      for (const [target, p] of listAt(obj.target, typeof t === "string" ? tpath : `${tpath}.target`)) {
        const n = this.resolveTarget(target, source, p);
        if (n) targets.push(n);
        else unresolved = true;
      }
      if (obj.guard !== undefined) this.checkGuard(obj.guard, `${tpath}.guard`, scope);
      (obj.actions ?? []).forEach((a, i) => this.checkAction(a, `${tpath}.actions.${i}`, scope));
      // An edge with a refused target is left out of the cycle check: it already has its line.
      if (always && !unresolved) {
        this.alwaysEdges.push({
          from: source,
          targets,
          guarded: obj.guard !== undefined,
          reenter: obj.reenter === true,
          doc: tpath,
        });
      }
    }
  }

  // --- rules 3 and 6: the parties -------------------------------------------------------------------

  /** Does a state invoke a party: an Agent (lent or minted) or a Gate? */
  private invokesParty(n: Node): boolean {
    return list(n.state.invoke).some((inv) => {
      const k = this.invokeKinds.get(inv);
      return k === "agent" || k === "minted" || k === "gate";
    });
  }

  /**
   * Can something end an Agent's Turn at `node`? A Turn ends when its state exits (an Agent's
   * invoke never settles, so its `onDone` never runs): by a Chart event handled at, above or below
   * the state (its modes, with no party-invoking state between), or by an `after`, an `always` or
   * another invoke's `onDone`/`onError` at or above it. Under a parallel state another region may
   * end it, which this walk does not follow, so it says yes there.
   */
  private endsTurn(node: Node): boolean {
    const handles = (n: Node): boolean => Object.keys(n.state.on ?? {}).some((k) => this.eventSchemas.has(k));
    const leaves = (n: Node): boolean =>
      n.state.after !== undefined ||
      n.state.always !== undefined ||
      list(n.state.invoke).some((inv) => {
        const k = this.invokeKinds.get(inv);
        return k !== "agent" && k !== "minted" && (inv.onDone !== undefined || inv.onError !== undefined);
      });
    for (let n: Node | undefined = node; n && n !== this.root; n = n.parent) {
      if (handles(n) || leaves(n) || n.parent?.kind === "parallel") return true;
    }
    const below = (n: Node): boolean =>
      [...n.children.values()].some((c) => !this.invokesParty(c) && (handles(c) || below(c)));
    return below(node);
  }

  /** The parties' rules, as `jr2Setup` applies them (ADR-0015), each with its path in the Chart. */
  private checkParties(): void {
    const agents = new Set<string>();
    const gates = new Set<string>();
    for (const node of this.nodes) {
      const invokes = listAt(node.state.invoke, `${node.doc}.invoke`);
      // A Gate's invoke id, as jr2Setup names an unnamed one: the state's key path.
      const key = node.doc
        .split(".")
        .filter((_s, i) => i % 2 === 1)
        .join(".");
      const unnamed = invokes.filter(([inv]) => this.invokeKinds.get(inv) === "gate" && inv.id === undefined).length;
      let ordinal = 0;
      for (const [inv, path] of invokes) {
        const kind = this.invokeKinds.get(inv);
        if (kind === "gate") gates.add(inv.id ?? (unnamed > 1 ? `${key}.${ordinal++}` : key));
        if (kind !== "agent" && kind !== "minted") continue;
        agents.add(inv.src);
        if (inv.onDone !== undefined) {
          this.fail(
            6,
            `${path}.onDone: an Agent's Turn never settles, so this never runs; a Turn ends when the Agent picks one of the Chart's \`events\`: declare that pick in \`events\` and handle it in this state's \`on\``,
          );
        }
        const parallel = [node, ...this.descendants(node)].find((n) => n.kind === "parallel");
        if (parallel) {
          this.fail(
            6,
            `${parallel.doc}: a parallel state at or below Agent "${inv.src}"'s state (${node.doc}) is refused: a Turn takes one pick at a time; background work goes above the Agent's state`,
          );
        }
        if (!this.endsTurn(node)) {
          this.fail(
            6,
            `${node.doc}: nothing ends Agent "${inv.src}"'s Turn: no state at, above or below it handles a Chart event (its Menu is empty), and no \`after\` leaves it; declare the pick that ends the Turn in \`events\` and handle it in this state's \`on\``,
          );
        }
      }
    }
    for (const { id, path } of this.sentBys) {
      if (id.includes("{{")) {
        this.fail(3, `${path}: a sentBy id is a literal party name, never a reference`);
      } else if (!agents.has(id) && !gates.has(id)) {
        this.fail(
          3,
          `${path}: sentBy("${id}") names no party of this Chart; Agents it invokes: ${names([...agents])}; Gate invoke ids: ${names([...gates])}`,
        );
      }
    }
  }

  // --- rule 7: dataflow -----------------------------------------------------------------------------

  /** Note every reference of a value, checked once the walk has seen every write. `optionalOk`:
   * the value is one reference that a `set` or `append` writes only when it is there. */
  private checkRefs(value: unknown, path: string, scope: EventScope, optionalOk = false): void {
    for (const ref of referencesOf(value)) {
      this.refs.push({ ref, path, scope, optionalOk: optionalOk && isRef(value) });
    }
  }

  private checkAllRefs(): void {
    for (const r of this.refs) {
      const check = this.refCheck(r.ref, r.scope, 0);
      if (check && !(check.optional && r.optionalOk)) this.fail(7, `${r.path}: ${check.fault}`);
    }
  }

  /** Why a reference may resolve to nothing, or undefined when something always supplies it.
   * `optional`: the only fault is a field that may be absent. */
  private refCheck(ref: string, scope: EventScope, depth: number): RefCheck {
    const [root, ...rest] = pathSegments(ref);
    if (root === "context") {
      const supplied = this.contextSupplies(rest, depth);
      if (supplied === true) return undefined;
      // A write exists, from one field a pick may leave out: the line names the field and the
      // fix, because "supplied by nothing" hid it (measured: every miss of a planner that never
      // wrote `required`).
      if (supplied !== false) {
        return {
          fault: `${ref} is written only by \`${supplied.kind}\` at ${supplied.at}, from \`${supplied.source}\`, which the pick may leave out: ${supplied.why}; a field in the event's \`required\` is always there`,
        };
      }
      return {
        fault: `${ref} is supplied by nothing: it is not in the initial \`context\`, and no \`set\`, \`append\` or \`increment\` writes it (a write supplies its own path and the paths above it; below a \`set\`, only what its one reference supplies)`,
      };
    }
    if (root === "input") {
      const keys = this.options.inputKeys;
      if (keys === undefined) return undefined;
      if (!keys.includes(String(rest[0])))
        return { fault: `${ref} is not in the Chart's input; input keys: ${names([...keys])}` };
      if (rest.length > 1) {
        return {
          fault: `${ref}: the door knows the keys of the Chart's input, not what they hold; reference input.${String(rest[0])} whole`,
        };
      }
      return undefined;
    }
    // event
    switch (scope.kind) {
      case "none":
        return {
          fault: `${ref} has no event to read here: ${scope.why}; \`event\` is read on a transition that handles one`,
        };
      case "done":
        return rest.length === 1 && rest[0] === "output"
          ? undefined
          : {
              fault: `${ref}: an \`onDone\` transition supplies event.output, whole (the door does not know its shape)`,
            };
      case "error":
        return rest.length === 1 && rest[0] === "error"
          ? undefined
          : {
              fault: `${ref}: an \`onError\` transition supplies event.error, whole (a line jr2 writes that names the invoke; never the error's own message, ADR-0067)`,
            };
      case "mechanism": {
        const fields = MECHANISM_EVENTS[scope.name]!.fields;
        const f = String(rest[0]);
        if (!Object.hasOwn(fields, f) || rest.length > 1)
          return { fault: `${ref} is not a field of "${scope.name}"; fields: ${Object.keys(fields).join(", ")}` };
        if (!fields[f])
          return {
            fault: `${ref} is optional on "${scope.name}"; a reference reads a field that is always there`,
            optional: true,
          };
        return undefined;
      }
      case "skip":
        return undefined;
      case "event": {
        const first = String(rest[0]);
        if (first === "type" && rest.length === 1) return undefined;
        if (
          first === "sender" &&
          (rest.length === 1 || (rest.length === 2 && ["party", "id"].includes(String(rest[1]))))
        )
          return undefined;
        return this.schemaSupplies(this.eventSchemas.get(scope.name)!, rest, `event "${scope.name}"`, ref);
      }
    }
  }

  /** Is a context path always there: in the initial context, at or above a path a write supplies,
   * or below a `set` whose one reference supplies the rest? */
  /** True when something always supplies the path; false when nothing writes it; or the one
   * write that would, whose source a pick may leave out (the first such write, in Chart order). */
  private contextSupplies(
    rest: Array<string | number>,
    depth: number,
  ): boolean | { kind: string; at: string; source: string; why: string } {
    if (depth > MAX_NESTING) return false;
    let v: unknown = this.chart.context ?? {};
    let inContext = true;
    for (const seg of rest) {
      if (typeof v !== "object" || v === null || !Object.hasOwn(v, seg)) {
        inContext = false;
        break;
      }
      v = (v as Record<string | number, unknown>)[seg];
    }
    if (inContext) return true;
    const isPrefix = (a: Array<string | number>, b: Array<string | number>) =>
      a.length <= b.length && a.every((s, i) => String(b[i]) === String(s));
    let optional: { kind: string; at: string; source: string; why: string } | undefined;
    for (const w of this.written) {
      const atOrAbove = isPrefix(rest, w.path);
      if (!atOrAbove && !(w.kind === "set" && isPrefix(w.path, rest))) continue;
      const source = w.kind === "increment" ? undefined : wholeRefOf(w.from);
      // A write from one reference that may be absent writes nothing then, so it supplies nothing.
      if (source !== undefined) {
        const check = this.refCheck(source, w.scope, depth + 1);
        if (check?.optional) {
          optional ??= { kind: w.kind, at: w.at, source, why: check.fault.split("; ")[0]! };
          continue;
        }
      }
      if (atOrAbove) return true;
      if (source === undefined) continue;
      const tail = rest.slice(w.path.length).map(String).join(".");
      if (this.refCheck(`${source}.${tail}`, w.scope, depth + 1) === undefined) return true;
    }
    return optional ?? false;
  }

  /** Is the path a required field, all the way down, of a payload's JSON Schema? A segment walks
   * the `properties` of an object schema, or an index below `minItems` of a list schema. */
  private schemaSupplies(
    schema: Record<string, unknown>,
    rest: Array<string | number>,
    what: string,
    ref: string,
  ): RefCheck {
    let node: Record<string, unknown> = schema;
    let optional = false;
    for (const seg of rest) {
      if (typeof seg === "string") {
        const props = node.properties as Record<string, Record<string, unknown>> | undefined;
        if ((node.type !== undefined && node.type !== "object") || typeof props !== "object" || props === null)
          return {
            fault: `${ref}: ${what}'s input has no object with fields here; a reference walks named fields: a pick's fields are at the top of \`event\`, as \`event.<field>\`, the fields its \`input\` schema declares`,
          };
        if (!Object.hasOwn(props, seg))
          return {
            fault: `${ref} is not a field of ${what}'s input; fields: ${names(Object.keys(props))}; a pick's fields are at the top of \`event\`, as \`event.<field>\``,
          };
        const required: string[] = Array.isArray(node.required) ? (node.required as string[]) : [];
        if (!required.includes(seg)) optional = true;
        node = props[seg]!;
      } else {
        const items = node.items as Record<string, unknown> | undefined;
        if (node.type !== "array" || typeof items !== "object" || items === null)
          return { fault: `${ref}: ${what}'s input has no list here; an integer indexes a list` };
        const min = typeof node.minItems === "number" ? node.minItems : 0;
        if (seg >= min)
          return {
            fault: `${ref}: the list in ${what}'s input may hold fewer than ${seg + 1} items (its minItems is ${min})`,
          };
        node = items;
      }
    }
    return optional
      ? {
          fault: `${ref} is optional in ${what}'s input (not in its \`required\`); a reference reads a required field (a \`set\` or \`append\` from it alone writes it when it is there)`,
          optional: true,
        }
      : undefined;
  }

  // --- rule 8: lent input shapes --------------------------------------------------------------------

  private checkInvokeInput(
    inv: ChartInvoke,
    kind: "agent" | "minted" | "effect" | "machine" | "gate",
    path: string,
  ): void {
    const ipath = `${path}.input`;
    const input = inv.input;
    const isObject = typeof input === "object" && input !== null && !Array.isArray(input) && !("$ref" in input);
    if (kind === "machine") return;
    if (kind === "gate") {
      if (input === undefined) return;
      if (!isObject) return this.fail(8, `${ipath}: a Gate's input is an object of gate (a name) and meta`);
      for (const key of Object.keys(input)) {
        if (key !== "gate" && key !== "meta") {
          this.fail(
            8,
            `${ipath}.${key}: a Gate's input takes gate and meta only; \`gate\` is the kit's Gate, which waits for an outside answer (a human, a webhook), not an Agent's Turn`,
          );
        }
      }
      const id = (input as Record<string, unknown>).gate;
      if (id !== undefined && (typeof id !== "string" || referencesOf(id).length)) {
        this.fail(8, `${ipath}.gate: a Gate's id is a literal name`);
      }
      return;
    }
    if (kind === "effect") {
      const logic = this.lent.actors[inv.src];
      const keys = isEffect(logic) ? inputKeysOf(logic.effect) : undefined;
      if (keys === undefined) {
        return this.fail(
          8,
          `${ipath}: the lent Effect "${inv.src}" has no input keys the door can read (an Open argv nobody bound)`,
        );
      }
      if (input === undefined && keys.length === 0) return;
      if (!isObject) {
        return this.fail(8, `${ipath}: the lent Effect "${inv.src}" takes an object of exactly ${names(keys)}`);
      }
      const given = Object.keys(input);
      const missing = keys.filter((k) => !given.includes(k));
      const extra = given.filter((k) => !keys.includes(k));
      if (missing.length || extra.length) {
        this.fail(
          8,
          `${ipath}: the lent Effect "${inv.src}" takes exactly ${names(keys)}` +
            (missing.length ? `; missing: ${missing.join(", ")}` : "") +
            (extra.length ? `; not its input: ${extra.join(", ")}` : ""),
        );
      }
      for (const k of given.filter((g) => keys.includes(g))) {
        const v = (input as Record<string, unknown>)[k];
        if (typeof v !== "string" && !isRef(v))
          this.fail(8, `${ipath}.${k}: an Effect's input slot takes a string or a reference`);
      }
      return;
    }
    this.checkAgentInput(inv.src, kind, input, isObject, ipath);
  }

  /**
   * An Agent invoke's input is a Turn's Frame and Dials (ADR-0057): `prompt` (a string), and
   * optionally `cwd`, `continue: true`, a `model` the Open body allows, and a `thinkingLevel`.
   * A Chart carries no url (ADR-0070): a Turn's placement, `endpoint` or `sandbox`, is refused by
   * name, and the Open body places each Turn from its own input.
   */
  private checkAgentInput(
    src: string,
    kind: "agent" | "minted",
    input: unknown,
    isObject: boolean,
    ipath: string,
  ): void {
    const who = kind === "agent" ? `the lent Agent "${src}"` : `the Chart's Agent "${src}"`;
    if (!isObject) return this.fail(8, `${ipath}: ${who} takes an object with a \`prompt\``);
    const obj = input as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if ((PLACEMENT_INPUT_KEYS as readonly string[]).includes(key)) {
        this.fail(
          8,
          `${ipath}.${key}: a Chart names no placement; the Open body places each Turn its Chart starts (ADR-0070)`,
        );
      } else if (!(AGENT_INPUT_KEYS as readonly string[]).includes(key)) {
        this.fail(
          8,
          `${ipath}.${key}: not an Agent's Turn input; it takes prompt, and cwd, continue, model, thinkingLevel`,
        );
      }
    }
    if (obj.prompt === undefined) this.fail(8, `${ipath}: ${who} takes a \`prompt\``);
    else if (typeof obj.prompt !== "string")
      this.fail(8, `${ipath}.prompt: a prompt is a string (placeholders inside it are fine)`);
    if (obj.cwd !== undefined && typeof obj.cwd !== "string") this.fail(8, `${ipath}.cwd: a cwd is a string`);
    if (obj.continue !== undefined && obj.continue !== true)
      this.fail(8, `${ipath}.continue: \`continue\` is true or absent`);
    if (obj.model !== undefined) {
      if (typeof obj.model !== "string" || referencesOf(obj.model).length) {
        this.fail(
          8,
          `${ipath}.model: a model is a literal the Open body allows; allowed: ${names(this.decl.allows.models)}`,
        );
      } else if (!this.decl.allows.models.includes(obj.model)) {
        this.fail(
          8,
          `${ipath}.model: "${obj.model}" is not a model this Open body allows; allowed: ${names(this.decl.allows.models)}`,
        );
      }
    }
    if (obj.thinkingLevel !== undefined && !(THINKING as readonly unknown[]).includes(obj.thinkingLevel)) {
      this.fail(8, `${ipath}.thinkingLevel: one of ${THINKING.join(", ")}`);
    }
  }
}

/**
 * The JSON Schema keywords a Chart event's payload may use (ADR-0070, rule 4). The Orchestrator
 * checks every pick against this schema in its own process, before the Allowed check, so a keyword
 * whose cost the door cannot bound is refused by name: `pattern` (a backtracking regex),
 * `patternProperties`, `$ref`, the combinators and the conditionals.
 */
const PAYLOAD_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "additionalProperties",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);

/**
 * The faults of an event's payload schema, before zod reads it: every keyword not in
 * {@link PAYLOAD_KEYWORDS}, a list-form `items`, and a top-level field named `type`, which would let
 * the payload name the event a Chart receives (registration.ts builds `{ type, ...payload }`).
 */
function payloadSchemaFaults(schema: unknown): Array<{ path: PropertyKey[]; message: string }> {
  const out: Array<{ path: PropertyKey[]; message: string }> = [];
  const walk = (node: unknown, path: PropertyKey[]): void => {
    if (typeof node === "boolean" && path.length && path[path.length - 1] === "additionalProperties") return;
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      out.push({ path, message: "a schema here is an object" });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "$schema" && path.length === 0) continue;
      if (!PAYLOAD_KEYWORDS.has(key)) {
        out.push({
          path: [...path, key],
          message: `"${key}" is not a keyword a Chart event's payload may use; it may use ${[...PAYLOAD_KEYWORDS].join(", ")}`,
        });
        continue;
      }
      if (key === "properties") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          out.push({ path: [...path, key], message: "`properties` is an object of schemas" });
          continue;
        }
        for (const [field, sub] of Object.entries(value)) walk(sub, [...path, key, field]);
      } else if (key === "items") {
        if (Array.isArray(value)) out.push({ path: [...path, key], message: "`items` is one schema, not a list" });
        else walk(value, [...path, key]);
      } else if (key === "additionalProperties") {
        walk(value, [...path, key]);
      }
    }
  };
  walk(schema, []);
  const props = (schema as { properties?: unknown } | null)?.properties;
  if (typeof props === "object" && props !== null && Object.hasOwn(props, "type")) {
    out.push({
      path: ["properties", "type"],
      message: "a payload field named `type` is refused: jr2 writes the event's type, and the payload never names it",
    });
  }
  return out;
}

/** A reference's fault, or undefined when it is always supplied. `optional`: the one fault is a
 * field that may be absent, which a `set` or `append` from it alone may read. */
type RefCheck = { fault: string; optional?: true } | undefined;

/** The reference a value is, when it is one reference alone. */
function wholeRefOf(v: unknown): string | undefined {
  if (typeof v === "string") return WHOLE_PLACEHOLDER.exec(v)?.[1]!.trim();
  return isRef(v) ? (v as { $ref: string }).$ref : undefined;
}

/** Is `a` the state `b` or a state above it? */
function isAncestorOrSelf(a: Node, b: Node): boolean {
  for (let n: Node | undefined = b; n; n = n.parent) if (n === a) return true;
  return false;
}

/** Is this value a reference by itself: `{ "$ref": "..." }` or `"{{...}}"`? */
function isRef(v: unknown): boolean {
  if (typeof v === "string") return WHOLE_PLACEHOLDER.test(v);
  return (
    typeof v === "object" &&
    v !== null &&
    Object.keys(v).length === 1 &&
    typeof (v as { $ref?: unknown }).$ref === "string"
  );
}
