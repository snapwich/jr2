// The Open body (ADR-0070): the body slot a Chart wrapper declares and a run binds with a Chart.
// `openBody(declaration)` is a slot constructor placed in `actors`, as `agent()` is, and its
// declaration states three things: what the slot LENDS a Chart by slot name, what a Chart may
// DEFINE (the models and the Workspace access of its own Agents), and the CEILINGS that bound a
// Chart's run. Nothing a Chart names resolves anywhere but here.
//
// This file has two halves. The DECLARATION half (below) is the brand, the validation of a
// declaration, and the lent set `jr2Setup` stamps at createMachine; the door (`admitChart`,
// chart.ts) reads only this half. The ACTOR half (at the end of the file) is the logic that
// DELEGATES to a Machine compiled from the Chart the run binds: it admits the Chart, compiles it
// with `jr2Setup` over the lent parts and the Chart's own Agents, enforces the ceilings, and keeps
// the Chart's text in its snapshot, so that restore compiles the same Machine again (ADR-0007).

import {
  and,
  assign,
  not,
  or,
  type AnyActorRef,
  type AnyActorScope,
  type AnyEventObject,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type UnknownActorLogic,
} from "xstate";
import { isAgent, type AgentDefinition, type WorkspaceAccess } from "./agent.ts";
import {
  admitChart,
  chartDigest,
  chartHash,
  ChartRefusal,
  GENERIC_ACTIONS,
  pathSegments,
  resolveSource,
  resolveReferences,
  type AdmittedChart,
  type ChartAction,
  type ChartGuard,
  type ChartInvoke,
  type ChartState,
  type ChartValue,
  type ChartText,
  type ChartTransition,
  type ChartTransitions,
} from "./chart.ts";
import { inputKeysOf, isEffect, type Duration } from "./effect.ts";
import { agent } from "./harness-client.ts";
import { SENT_BY } from "./party.ts";
import { wrapperBodyOf } from "./parts.ts";
import { actorPath, boundRun } from "./registration.ts";
import { jr2Setup } from "./setup.ts";
import { attachBoundMachine, boundMachineFor } from "./vocabulary.ts";

// ADR-0070: "counters are the Open body's".
/**
 * The limits that an Open body sets on its Chart. Each one is a positive bound. When the Chart gets
 * to one, the Open body stops it and ends with `{ outcome: "ceiling", ceiling, detail }`.
 */
export type Ceilings = {
  /** The Agent Turns that start under the Open body, at all levels. The Turns of a lent Machine
   * count too. */
  turns: number;
  /** The time from the start of the Open body, such as `"30m"`. At most about 596 hours. */
  wallClock: Duration;
  /** The transitions of the Chart in the whole run. xstate has no guard against a loop, so this is
   * the guard. */
  transitions: number;
  /** The children that run under the Open body at one time. */
  fanOut: number;
  /** The size of the Chart, as JSON, in bytes. At most 1048576 (1 MiB). */
  size: number;
};

/** The largest `ceilings.size` a declaration may state: 1 MiB. */
export const MAX_CHART_SIZE = 1024 * 1024;

/**
 * The most JSON a Chart's run data may hold, in bytes: its context (its `input` included) and its
 * output. Reaching it settles the body with the `size` ceiling. A kit bound, not a declaration's:
 * the run host saves, serves and feeds this JSON, so it is the host's limit.
 */
export const MAX_CONTEXT_SIZE = 4 * 1024 * 1024;

/**
 * Is the JSON of `value` more than `cap` bytes? A walk with an explicit stack that stops at the
 * cap, and counts a shared reference each time it occurs, as `JSON.stringify` writes it. So a
 * value that is small in memory and huge as JSON costs at most `cap` to measure.
 */
export function jsonOver(value: unknown, cap: number): boolean {
  let total = 0;
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") total += v.length > cap ? v.length : Buffer.byteLength(JSON.stringify(v));
    else if (Array.isArray(v)) {
      total += 2 + v.length;
      for (const x of v) stack.push(x);
    } else if (typeof v === "object" && v !== null) {
      const entries = Object.entries(v);
      total += 2 + entries.length;
      for (const [k, x] of entries) {
        if (x === undefined || typeof x === "function") continue;
        total += Buffer.byteLength(k) + 3;
        stack.push(x);
      }
    } else total += v === undefined ? 0 : String(v).length;
    if (total > cap) return true;
  }
  return false;
}

/** The parts of the Chart wrapper that a Chart can use, by their keys in `actors`, `guards`,
 * `actions` and `delays`. `gate: true` lends the Gate, so that a Chart can wait for an answer from
 * outside the run. A Chart can use no other part. */
export type Lends = {
  agents?: string[];
  effects?: string[];
  machines?: string[];
  guards?: string[];
  actions?: string[];
  delays?: string[];
  gate?: boolean;
};

/**
 * What an Open body declares: the parts that it lends a Chart, what the Agents of a Chart can
 * have, and the limits of a Chart. Give it to {@link openBody}, and to `chartSchemaFor` for the
 * pick of a planner.
 *
 * @see docs/concepts/charts.md
 */
export type OpenBodyDeclaration = {
  /** The parts that a Chart can use. */
  lends: Lends;
  /** What the Agents that a Chart adds can have: a model from `models`, and a Workspace access
   * from `workspace`. With no model, a Chart cannot add an Agent. */
  allows: { models: string[]; workspace: WorkspaceAccess[] };
  /** The limits of one Chart. */
  ceilings: Ceilings;
};

/** The implementations of the lent names, resolved on the wrapper's setup at createMachine. */
export type LentParts = {
  actors: Record<string, UnknownActorLogic>;
  guards: Record<string, unknown>;
  actions: Record<string, unknown>;
  delays: Record<string, unknown>;
};

/** The brand an Open body slot carries, as `definition` marks an Agent slot (ADR-0049). */
export type OpenBodySlot = { readonly openBody: OpenBodyDeclaration };

/** The logic `openBody()` returns: actor logic that carries the brand. */
export type OpenBodyLogic = UnknownActorLogic & OpenBodySlot;

const LEND_KINDS = ["agents", "effects", "machines", "guards", "actions", "delays"] as const;
const WORKSPACE: readonly WorkspaceAccess[] = ["write", "read", "none"];
const CEILING_KEYS = ["turns", "wallClock", "transitions", "fanOut", "size"] as const;
const DURATION = /^(\d+(\.\d+)?)(s|m|h)$/;
/** The longest wall clock an Open body arms as one timer: Node clamps a longer one to 1 ms. */
const MAX_WALL_CLOCK_MS = 2_147_483_647;
/** A name a Chart's grammar reads as its own, so a lent part by that name would be shadowed. */
const reservedName = (kind: (typeof LEND_KINDS)[number], v: string): string | undefined => {
  if (v.includes(".")) return `"${v}" holds a dot; a lent name is a slot key, and dotted names are jr2's and xstate's`;
  if ((kind === "agents" || kind === "effects" || kind === "machines") && v === "gate")
    return `"gate" is the kit's Gate; lend a slot of another name`;
  if (kind === "actions" && (GENERIC_ACTIONS as readonly string[]).includes(v))
    return `"${v}" is a generic action every Chart has; lend an action of another name`;
  if (kind === "delays" && /^(0|[1-9][0-9]*)$/.test(v))
    return `"${v}" reads as a delay of ${v} ms in a Chart; lend a delay by a name that is not an integer`;
  return undefined;
};

/** The milliseconds of a {@link Duration}, or undefined when the text is not a positive one. */
export function durationMs(d: unknown): number | undefined {
  if (typeof d !== "string") return undefined;
  const m = DURATION.exec(d);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]!);
  if (!(n > 0)) return undefined;
  return m[3] === "h" ? n * 3_600_000 : m[3] === "m" ? n * 60_000 : n * 1000;
}

/**
 * The faults of a declaration, one line each; empty when it is valid. Every list holds distinct
 * non-empty strings, every ceiling is present and positive, `size` is at most 1 MiB, `wallClock`
 * is a Duration (`"90s"`, `"10m"`, `"2h"`), and `allows.workspace` holds Workspace accesses only.
 */
export function declarationFaults(decl: unknown): string[] {
  const faults: string[] = [];
  if (typeof decl !== "object" || decl === null) return ["the declaration is not an object"];
  const d = decl as Partial<Record<keyof OpenBodyDeclaration, unknown>>;
  const list = (where: string, value: unknown, item?: (v: string) => string | undefined): void => {
    if (!Array.isArray(value)) {
      faults.push(`${where}: expected a list of names, found ${JSON.stringify(value)}`);
      return;
    }
    const seen = new Set<string>();
    for (const v of value) {
      if (typeof v !== "string" || v === "") faults.push(`${where}: ${JSON.stringify(v)} is not a name`);
      else if (seen.has(v)) faults.push(`${where}: "${v}" is listed twice`);
      else {
        seen.add(v);
        const fault = item?.(v);
        if (fault) faults.push(`${where}: ${fault}`);
      }
    }
  };
  const lends = d.lends;
  if (typeof lends !== "object" || lends === null) faults.push("lends: expected an object of slot-name lists");
  else {
    for (const key of Object.keys(lends)) {
      if (key === "gate") {
        if (typeof (lends as { gate?: unknown }).gate !== "boolean") {
          faults.push("lends.gate: the kit's Gate is lent whole: true or false");
        }
      } else if (!(LEND_KINDS as readonly string[]).includes(key)) {
        faults.push(`lends.${key}: an Open body lends ${LEND_KINDS.join(", ")} and gate only`);
      }
    }
    for (const kind of LEND_KINDS) {
      const value = (lends as Record<string, unknown>)[kind];
      if (value !== undefined) list(`lends.${kind}`, value, (v) => reservedName(kind, v));
    }
  }
  const allows = d.allows as { models?: unknown; workspace?: unknown } | undefined;
  if (typeof allows !== "object" || allows === null) faults.push("allows: expected { models, workspace }");
  else {
    list("allows.models", allows.models);
    list("allows.workspace", allows.workspace, (v) =>
      (WORKSPACE as readonly string[]).includes(v)
        ? undefined
        : `"${v}" is not a Workspace access (${WORKSPACE.join(", ")})`,
    );
  }
  const ceilings = d.ceilings as Partial<Record<keyof Ceilings, unknown>> | undefined;
  if (typeof ceilings !== "object" || ceilings === null) faults.push(`ceilings: expected ${CEILING_KEYS.join(", ")}`);
  else {
    for (const key of CEILING_KEYS) {
      const v = ceilings[key];
      if (v === undefined) faults.push(`ceilings.${key}: missing; an Open body states every ceiling`);
      else if (key === "wallClock") {
        const ms = durationMs(v);
        if (ms === undefined) {
          faults.push(`ceilings.wallClock: ${JSON.stringify(v)} is not a positive duration (like "90s", "10m", "2h")`);
        } else if (ms > MAX_WALL_CLOCK_MS) {
          faults.push(
            `ceilings.wallClock: ${JSON.stringify(v)} is more than one timer holds (${MAX_WALL_CLOCK_MS} ms, about 596h)`,
          );
        }
      } else if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        faults.push(`ceilings.${key}: ${JSON.stringify(v)} is not a positive integer`);
      } else if (key === "size" && v > MAX_CHART_SIZE) {
        faults.push(`ceilings.size: ${v} is more than ${MAX_CHART_SIZE} bytes (1 MiB)`);
      }
    }
    for (const key of Object.keys(ceilings)) {
      if (!(CEILING_KEYS as readonly string[]).includes(key)) {
        faults.push(`ceilings.${key}: not a ceiling (${CEILING_KEYS.join(", ")})`);
      }
    }
  }
  for (const key of Object.keys(d)) {
    if (key !== "lends" && key !== "allows" && key !== "ceilings") faults.push(`${key}: not a part of a declaration`);
  }
  return faults;
}

/** A copy of the declaration with every list copied and frozen, so the brand cannot change later. */
function frozen(decl: OpenBodyDeclaration): OpenBodyDeclaration {
  const lends: Lends = {};
  for (const kind of LEND_KINDS) {
    const v = decl.lends[kind];
    if (v !== undefined) lends[kind] = Object.freeze([...v]) as string[];
  }
  if (decl.lends.gate !== undefined) lends.gate = decl.lends.gate;
  return Object.freeze({
    lends: Object.freeze(lends),
    allows: Object.freeze({
      models: Object.freeze([...decl.allows.models]) as string[],
      workspace: Object.freeze([...decl.allows.workspace]) as WorkspaceAccess[],
    }),
    ceilings: Object.freeze({ ...decl.ceilings }),
  });
}

// It validates the declaration now, so a bad one fails where the Machine is written, and returns
// actor logic branded with it. `jr2Setup` resolves every lent name against its own `actors`,
// `guards`, `actions` and `delays` at createMachine, and stamps the result with `attachLent`
// (ADR-0070).
/**
 * Make an Open body: the actor slot that a Chart binds. Put it in `actors`, and invoke it from a
 * state with `{ chart, ...input }`. `chart` is the text of a Chart, or `{ name }` for a named
 * Chart of this wrapper. The other keys are the input of the Chart, which it reads as
 * `{{input.<key>}}`. A Machine with an Open body is a Chart wrapper.
 *
 * Each Agent Turn of the Chart runs where the Open body runs: in the Sandbox of its `workspace()`,
 * or on the Instance Harness. The Open body ends with an {@link OpenBodyOutput}.
 *
 * It refuses a declaration that is not correct: `openBody: <problem>; <problem>`, for example
 * `ceilings.turns: missing; an Open body states every ceiling`. `createMachine` refuses a lent
 * name that the Machine does not have: `machine "<id>": Open body "<slot>": lends.agents: "<name>"
 * is no actor slot of this Machine; its actors: <slots>`.
 *
 * @param decl - What a Chart can use, and its limits (see {@link OpenBodyDeclaration}).
 * @returns The actor logic of the slot.
 *
 * @example
 * ```ts
 * import { assign } from "xstate";
 * import { z } from "zod";
 * import { agent, chartSchema, jr2Setup, openBody, type OpenBodyOutput } from "@jr2/orchestrator";
 *
 * // `chart` is a Chart, so a run input can carry one, and Charts can have names.
 * const door = z.object({ topic: z.string(), chart: chartSchema });
 * type Input = z.infer<typeof door>;
 * type Context = Input & { result?: OpenBodyOutput };
 *
 * export const machine = jr2Setup({
 *   types: {} as { context: Context; input: Input },
 *   events: [],
 *   actors: {
 *     writer: agent({
 *       model: "anthropic/claude-sonnet-5-5",
 *       workspace: "none",
 *       instructions: "You write clear, short text for engineers.",
 *     }),
 *     body: openBody({
 *       lends: { agents: ["writer"] },
 *       allows: { models: [], workspace: [] },
 *       ceilings: { turns: 6, wallClock: "15m", transitions: 200, fanOut: 1, size: 65536 },
 *     }),
 *   },
 * }).createMachine({
 *   id: "notes",
 *   input: door,
 *   context: ({ input }) => ({ ...input }),
 *   initial: "running",
 *   states: {
 *     running: {
 *       invoke: {
 *         src: "body",
 *         input: ({ context }: { context: Context }) => ({ chart: context.chart, topic: context.topic }),
 *         onDone: { target: "done", actions: assign({ result: ({ event }) => event.output as OpenBodyOutput }) },
 *       },
 *     },
 *     done: { type: "final" },
 *   },
 * });
 * ```
 *
 * @see docs/concepts/charts.md
 * @see docs/guides/run-a-chart-by-name.md
 * @see docs/guides/let-an-agent-write-a-chart.md
 * @see docs/reference/decisions/0070-a-machine-lends-its-parts-to-a-chart.md
 */
export function openBody(decl: OpenBodyDeclaration): OpenBodyLogic {
  return openBodyWith(decl);
}

/** How an Open body builds what a Chart mints. The default runs a minted Agent over the Harness
 * wire, as `agent()` does; a unit test passes its own port here, as it does for `agentActorWith`. */
export type OpenBodyOptions = {
  /** Build the logic of an Agent the Chart mints, from its slot key and its definition. */
  mintAgent?: (slot: string, definition: AgentDefinition) => UnknownActorLogic;
};

/** {@link openBody} with the options a test seam needs. The declaration is validated the same way. */
export function openBodyWith(decl: OpenBodyDeclaration, options: OpenBodyOptions = {}): OpenBodyLogic {
  const faults = declarationFaults(decl);
  if (faults.length) throw new Error(`openBody: ${faults.join("; ")}`);
  const declaration = frozen(decl);
  const logic = openBodyLogic(declaration, options);
  bodyOptions.set(logic, options);
  return Object.assign(logic, { openBody: declaration }) as OpenBodyLogic;
}

/** The options each Open body slot was built with, so a copy keeps them. */
const bodyOptions = new WeakMap<object, OpenBodyOptions>();

/**
 * A new Open body slot with the same declaration and options: what `customize()` stamps a retuned
 * lent set on, so the Machine it was given keeps its own (ADR-0049: two customizations of one
 * import are two Machines).
 */
export function copyOpenBody(logic: OpenBodyLogic): OpenBodyLogic {
  const options = bodyOptions.get(logic) ?? {};
  const declaration = openBodyDeclarationOf(logic);
  const copy = openBodyLogic(declaration, options);
  bodyOptions.set(copy, options);
  return Object.assign(copy, { openBody: declaration }) as OpenBodyLogic;
}

/** Is this actor logic an Open body slot? A duck test on the brand, like `isAgent`. */
export function isOpenBody(logic: unknown): logic is OpenBodyLogic {
  if (typeof logic !== "object" || logic === null) return false;
  const decl = (logic as { openBody?: unknown }).openBody;
  if (typeof decl !== "object" || decl === null) return false;
  const { lends, allows, ceilings } = decl as Partial<OpenBodyDeclaration>;
  return typeof lends === "object" && typeof allows === "object" && typeof ceilings === "object";
}

/** The declaration an Open body slot carries. */
export function openBodyDeclarationOf(logic: OpenBodyLogic): OpenBodyDeclaration {
  return logic.openBody;
}

// Keyed on the logic object, as the vocabulary is keyed on a Machine's config: `customize` and the
// host's per-run `provide` rebuild the actors map, and a WeakMap keeps the logic bit-identical.
const lentSets = new WeakMap<object, LentParts>();

/** Stamp the resolved lent set on an Open body slot. `jr2Setup` calls it at createMachine, and
 * again after a `customize` retunes a lent slot. */
export function attachLent(logic: OpenBodyLogic, lent: LentParts): void {
  lentSets.set(logic, lent);
}

/** The lent set stamped on an Open body slot; undefined before `jr2Setup` resolved it. */
export function lentOf(logic: OpenBodyLogic): LentParts | undefined {
  return lentSets.get(logic);
}

// --- The actor half ------------------------------------------------------------------------------
// The logic `openBody()` returns DELEGATES to a Machine compiled from the Chart (ADR-0070). At
// start it reads `input.chart` (the text, or the name of a Chart of the run's own wrapper, D-C),
// admits it against the declaration and the lent set it has NOW, compiles it with `jr2Setup` (so
// an Agent the Chart's states invoke derives its Menu from the Chart's events, as under any
// Machine), and runs it in its own snapshot. The snapshot is the compiled Machine's, plus the
// Chart's text and hash, the start time and the counters: xstate's own `value`, `context` and
// `children` stay where `durability.ts`, `runChildren` and the timers read them. Restore admits
// the text again and compiles the same Machine (ADR-0007). A Chart the door refuses settles the
// body with a `refused` output, never an error (D-A): the wrapper routes it with `onDone`, and a
// planner reads the report as a link in its Chain. An error of the body stays a defect.

/** What an Open body is invoked with: the Chart, by text or by name, and its `input` (the rest). */
export type OpenBodyInput = { chart: ChartText | { name: string } } & Record<string, unknown>;

/**
 * The output of an Open body. Route on `outcome` in the `onDone` of the state that invokes it:
 *
 * - `done`: the Chart got to a final state. `output` is the output of the Chart.
 * - `refused`: the door refused the Chart. `report` has one line for each problem. Give it to the
 *   Agent that wrote the Chart, so that it can send a corrected one.
 * - `ceiling`: the Chart got to a ceiling, and the Open body stopped it. `ceiling` names it.
 *
 * @see docs/concepts/charts.md
 */
export type OpenBodyOutput =
  | { outcome: "done"; output: unknown }
  | { outcome: "refused"; report: string[] }
  | { outcome: "ceiling"; ceiling: keyof Ceilings; detail: string };

/** The context key the compiled Machine keeps the Chart's `input` under. `$` is no path segment,
 * so no Chart reference or generic action can name it. */
export const CHART_INPUT_KEY = "$input";

/**
 * The keys of the body's input that are a Turn's placement (ADR-0057's `AgentTurnPlacement`): the
 * stub tier's explicit Harness url, and the Sandbox a delivery is scoped to. A Chart carries no
 * url (ADR-0070), so these never reach it: they are not in its `input` scope, not among the keys
 * the door checks `input.*` against, and the body writes them on every Agent Turn its Chart
 * starts. Inside a `workspace()` the wrapper passes none, and a Turn resolves its placement
 * ambiently through the actor chain, as a hand-written Machine's Turn does.
 */
export const PLACEMENT_KEYS = ["endpoint", "sandbox"] as const;

/** `input` without its placement keys: what the Chart reads as `input`. */
export function chartInputOf(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([k]) => !(PLACEMENT_KEYS as readonly string[]).includes(k)));
}

/** The placement in `input`, as strings: what rides each Agent Turn the Chart starts. */
function placementOf(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof input !== "object" || input === null) return out;
  for (const key of PLACEMENT_KEYS) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

/** The event the body sends itself when its wall clock runs out (xstate's own delayed event). */
export const WALL_CLOCK_EVENT = "jr2.openBody.wallClock";

type Counters = { turns: number; transitions: number };

/** What the body keeps beside the compiled Machine's snapshot. `chart` and `chartHash` are absent
 * on a body that bound no Chart (a refusal at start). */
type BodyFields = { chart?: ChartText; chartHash?: string; startedAt: number; counters: Counters };

type BodySnapshot = Record<string, unknown> &
  BodyFields & {
    status: string;
    machine?: AnyStateMachine;
    children?: Record<string, AnyActorRef>;
    context?: Record<string, unknown>;
  };

const EMPTY_LENT: LentParts = { actors: {}, guards: {}, actions: {}, delays: {} };

/** The lent names of a declaration, by the implementation map each resolves in. */
function lentNames(decl: OpenBodyDeclaration) {
  return {
    actors: [...(decl.lends.agents ?? []), ...(decl.lends.effects ?? []), ...(decl.lends.machines ?? [])],
    guards: [...(decl.lends.guards ?? [])],
    actions: [...(decl.lends.actions ?? [])],
    delays: [...(decl.lends.delays ?? [])],
  };
}

type Implementations = {
  actors?: Record<string, unknown>;
  guards?: Record<string, unknown>;
  actions?: Record<string, unknown>;
  delays?: Record<string, unknown>;
};

/**
 * The lent set of a declaration, read off a Machine's implementations by the lent names. A name the
 * Machine does not implement is left out, so the door refuses a Chart that uses it.
 */
export function lentIn(impl: Implementations, decl: OpenBodyDeclaration): LentParts {
  const names = lentNames(decl);
  const pick = <T>(from: Record<string, unknown> | undefined, keys: string[]) =>
    Object.fromEntries(keys.filter((k) => from?.[k] !== undefined).map((k) => [k, from![k]])) as Record<string, T>;
  return {
    actors: pick<UnknownActorLogic>(impl.actors, names.actors),
    guards: pick(impl.guards, names.guards),
    actions: pick(impl.actions, names.actions),
    delays: pick(impl.delays, names.delays),
  };
}

/**
 * The lent set an Open body's actor has NOW: the live implementations of the Machine that invoked
 * it, by the lent names (ADR-0049: a part resolves through the live actor's logic, so a run's
 * `provide()` and a `customize()` retune are what the Chart borrows), or the set `jr2Setup`
 * stamped when nothing a Machine invoked it.
 */
function liveLentOf(self: AnyActorRef, logic: object): LentParts {
  const parent = (self._parent as { logic?: unknown } | undefined)?.logic as AnyStateMachine | undefined;
  const stamped = lentOf(logic as OpenBodyLogic);
  if (!parent?.root) return stamped ?? EMPTY_LENT;
  return lentIn(parent.implementations as Implementations, openBodyDeclarationOf(logic as OpenBodyLogic));
}

/** The refusal line of a compile's throw: `jr2Setup`'s own checks over the Chart (rule 6). */
const compileLine = (err: unknown): string => `(chart): ${err instanceof Error ? err.message : String(err)}`;

/**
 * The door's whole check of a Chart for one Open body (ADR-0070: "admission is static and
 * mandatory"): {@link admitChart}, then the compile `jr2Setup` runs over the Chart, with no run
 * (a parallel region below an Agent's state, a `sentBy` that names no party). A throw of the
 * compile is a refusal line, so the HTTP door, a PUT, a publish and the body refuse alike. Throws
 * ChartRefusal.
 */
export function admitBodyChart(
  text: unknown,
  decl: OpenBodyDeclaration,
  lent: LentParts,
  options: { inputKeys?: readonly string[] } = {},
): AdmittedChart {
  const admitted = admitChart(text, decl, lent, options.inputKeys ? { inputKeys: options.inputKeys } : {});
  try {
    compileChart(admitted, lent, decl);
  } catch (err) {
    if (err instanceof ChartRefusal) throw err;
    throw new ChartRefusal([compileLine(err)]);
  }
  return admitted;
}

const isMachine = (logic: unknown): logic is AnyStateMachine =>
  typeof logic === "object" &&
  logic !== null &&
  typeof (logic as { config?: unknown }).config === "object" &&
  typeof (logic as { implementations?: unknown }).implementations === "object";

/**
 * The Machine that declares the Open bodies of `machine`, seen through jr2's transparent wrappers
 * (ADR-0049: `workspace()` and `pool()` are transparent to their body), with the slot route down
 * to it. A Chart wrapper that is a `workspace()`'s body is still the run's Chart wrapper: the door
 * is the `workspace()`'s, and the bodies and the lent set are the inner Machine's. `machine`
 * itself, with an empty route, when it declares an Open body or is no wrapper.
 */
export function chartWrapperMachineOf(machine: AnyStateMachine): { machine: AnyStateMachine; route: string[] } {
  let at = machine;
  const route: string[] = [];
  const seen = new Set<AnyStateMachine>([machine]);
  while (!openBodiesOf(at).length) {
    const slot = wrapperBodyOf(at);
    const child = slot === undefined ? undefined : (at.implementations.actors as Record<string, unknown>)[slot];
    if (slot === undefined || !isMachine(child) || seen.has(child)) break;
    seen.add(child);
    route.push(slot);
    at = child;
  }
  return { machine: at, route };
}

/**
 * Admit a Chart for the Open body `slot` of `machine` (ADR-0070), seen through transparent
 * wrappers, with the lent set the Machine's implementations hold. Throws ChartRefusal.
 */
export function admitOpenBodyChart(
  machine: AnyStateMachine,
  slot: string,
  text: unknown,
  inputKeys?: readonly string[],
): AdmittedChart {
  const inner = chartWrapperMachineOf(machine).machine;
  const logic = (inner.implementations.actors as Record<string, unknown>)[slot];
  if (!isOpenBody(logic)) throw new Error(`machine "${machine.id}" has no Open body "${slot}"`);
  const decl = openBodyDeclarationOf(logic);
  return admitBodyChart(text, decl, lentIn(inner.implementations as Implementations, decl), {
    ...(inputKeys ? { inputKeys } : {}),
  });
}

/**
 * Admit a Chart field of a Chart wrapper's door (ADR-0070), the door a run's start runs before the
 * run exists. The door cannot tell which Open body a field feeds, so the Chart is admitted against
 * each body, and it is admitted when one body admits it; else each line names its body when there
 * are two or more. `input.*` references are not checked here: the Chart's `input` is what the
 * wrapper's invoke sends, which the door cannot see, and the body checks them at its start. Throws
 * ChartRefusal.
 */
export function admitWrapperChart(machine: AnyStateMachine, text: unknown): AdmittedChart {
  const inner = chartWrapperMachineOf(machine).machine;
  const bodies = openBodiesOf(inner);
  if (!bodies.length) throw new Error(`machine "${machine.id}" declares no Open body`);
  const report: string[] = [];
  for (const { slot, logic } of bodies) {
    const decl = openBodyDeclarationOf(logic);
    try {
      return admitBodyChart(text, decl, lentIn(inner.implementations as Implementations, decl));
    } catch (err) {
      if (!(err instanceof ChartRefusal)) throw err;
      report.push(...err.report.map((line) => (bodies.length > 1 ? `body "${slot}": ${line}` : line)));
    }
  }
  throw new ChartRefusal(report);
}

/** Every Open body slot a Machine declares, in `actors` order. */
export function openBodiesOf(machine: AnyStateMachine): Array<{ slot: string; logic: OpenBodyLogic }> {
  const actors = (machine.implementations?.actors ?? {}) as Record<string, unknown>;
  return Object.entries(actors).flatMap(([slot, logic]) => (isOpenBody(logic) ? [{ slot, logic }] : []));
}

// --- Compiling a Chart ---------------------------------------------------------------------------

type Args = { context: Record<string, unknown>; event: unknown };

/** The scope a reference resolves in: the run's context and event, and the Chart's input. An
 * invoke's error is a line jr2 writes (see {@link errorAsLine}). */
const scopeOf = (args: Args) => ({
  context: args.context,
  event: errorAsLine(args.event),
  input: chartInputOf((args.context?.[CHART_INPUT_KEY] as Record<string, unknown> | undefined) ?? {}),
});

/** An invoke's error whose message jr2 wrote for a Chart to read: a lent Effect's input fault. */
class ChartInvokeFault extends Error {}

/**
 * An invoke's error event as a Chart reads it: `event.error` is a line jr2 writes, never the
 * error's own message. A child's error is a defect whose message never reaches the model
 * (ADR-0067, holds.ts), and a Chart's prompts and output reach one; an error message may also
 * name what is internal (an Effector's address). The one exception is a fault jr2 wrote for the
 * Chart: a lent Effect's input that failed its keys.
 */
function errorAsLine(event: unknown): unknown {
  const e = event as { type?: unknown; error?: unknown } | undefined;
  if (typeof e?.type !== "string" || !e.type.startsWith("xstate.error.actor.")) return event;
  const child = e.type.slice("xstate.error.actor.".length);
  const line =
    e.error instanceof ChartInvokeFault
      ? e.error.message
      : `the invoke "${child}" failed; its error is a defect the Orchestrator logs, and a Chart never reads it (ADR-0067)`;
  return { ...e, error: line };
}

/**
 * A reference that resolved to nothing at run time. The door admits what its dataflow check can
 * see (rule 7), and a run's data can still lack a path it admitted (a read before the state that
 * writes it). The body settles `refused` with the reference named, never an error: an error of
 * the body is a defect, and the planner would never get a report (D-A).
 */
class ChartRunFault extends Error {}

/** The fault the last resolution threw, read by the body after its delegate threw: xstate wraps a
 * guard's throw in an Error of its own, so the class alone does not survive. */
let runFault: ChartRunFault | undefined;

function resolveAt(template: ChartValue, args: Args): unknown {
  try {
    return resolveReferences(template, scopeOf(args));
  } catch (err) {
    runFault = new ChartRunFault(err instanceof Error ? err.message : String(err));
    throw runFault;
  }
}

const resolver = (template: ChartValue) => (args: Args) => resolveAt(template, args);

/** The copy of `value` with `fn(old)` at `path`; objects and lists are copied, never changed. */
function withPath(value: unknown, path: Array<string | number>, fn: (old: unknown) => unknown): unknown {
  if (path.length === 0) return fn(value);
  const [head, ...rest] = path as [string | number, ...Array<string | number>];
  if (typeof head === "number") {
    const list = Array.isArray(value) ? [...value] : [];
    list[head] = withPath(list[head], rest, fn);
    return list;
  }
  const obj = typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
  (obj as Record<string, unknown>)[head] = withPath((obj as Record<string, unknown>)[head], rest, fn);
  return obj;
}

/** The copy of `value` without `path`. */
function withoutPath(value: unknown, path: Array<string | number>): unknown {
  if (typeof value !== "object" || value === null || path.length === 0) return value;
  const [head, ...rest] = path as [string | number, ...Array<string | number>];
  if (Array.isArray(value)) {
    if (typeof head !== "number" || head >= value.length) return value;
    const list = [...value];
    if (rest.length) list[head] = withoutPath(list[head], rest);
    else list.splice(head, 1);
    return list;
  }
  if (!Object.hasOwn(value, head)) return value;
  const obj = { ...(value as Record<string, unknown>) };
  if (rest.length) obj[head] = withoutPath(obj[head], rest);
  else delete obj[head];
  return obj;
}

/** `absent`: a `set` or `append` from one reference that resolved to nothing writes nothing. */
type PathParams = { path: string; value?: unknown; by?: number; absent?: boolean };

/** The four generic actions (ADR-0070), implemented once, as `assign`s driven by their params. */
const GENERIC = {
  set: assign(({ context }: { context: Record<string, unknown> }, p: PathParams) =>
    p.absent ? context : (withPath(context, pathSegments(p.path), () => p.value) as Record<string, unknown>),
  ),
  append: assign(({ context }: { context: Record<string, unknown> }, p: PathParams) =>
    p.absent
      ? context
      : (withPath(context, pathSegments(p.path), (old) => [
          ...(Array.isArray(old) ? old : old === undefined ? [] : [old]),
          p.value,
        ]) as Record<string, unknown>),
  ),
  increment: assign(
    ({ context }: { context: Record<string, unknown> }, p: PathParams) =>
      withPath(context, pathSegments(p.path), (old) => (typeof old === "number" ? old : 0) + (p.by ?? 1)) as Record<
        string,
        unknown
      >,
  ),
  clear: assign(({ context }: { context: Record<string, unknown> }, p: PathParams) => {
    const segments = pathSegments(p.path);
    // A top-level key is assigned `undefined`: `assign` merges, so a key it leaves out stays.
    if (segments.length === 1) return { [segments[0]!]: undefined };
    return withoutPath(context, segments) as Record<string, unknown>;
  }),
} as Record<string, unknown>;

function guardOf(g: ChartGuard): unknown {
  if (typeof g === "string") return g;
  if ("not" in g) return not(guardOf(g.not) as never);
  if ("and" in g) return and(g.and.map(guardOf) as never);
  if ("or" in g) return or(g.or.map(guardOf) as never);
  if (g.params === undefined) return { type: g.type };
  // `jr2.sentBy`'s params are a literal `{ id }`, which the party walk reads (ADR-0015).
  if (g.type === SENT_BY) return { type: g.type, params: g.params };
  return { type: g.type, params: resolver(g.params) };
}

function actionOf(a: ChartAction): unknown {
  const action = a as { type: string; path?: string; from?: ChartValue; by?: number; params?: ChartValue };
  switch (action.type) {
    case "set":
    case "append": {
      const { path, from } = action;
      return {
        type: action.type,
        params: (args: Args) => {
          let source: { value: unknown } | undefined;
          try {
            source = resolveSource(from, scopeOf(args));
          } catch (err) {
            runFault = new ChartRunFault(err instanceof Error ? err.message : String(err));
            throw runFault;
          }
          return source ? { path, value: source.value } : { path, absent: true };
        },
      };
    }
    case "increment":
      return { type: "increment", params: { path: action.path, by: action.by ?? 1 } };
    case "clear":
      return { type: "clear", params: { path: action.path } };
    default:
      return action.params === undefined
        ? { type: action.type }
        : { type: action.type, params: resolver(action.params) };
  }
}

function transitionOf(t: ChartTransition): unknown {
  if (typeof t === "string") return t;
  const out: Record<string, unknown> = {};
  if (t.target !== undefined) out.target = t.target;
  if (t.guard !== undefined) out.guard = guardOf(t.guard);
  if (t.actions !== undefined) out.actions = t.actions.map(actionOf);
  if (t.reenter !== undefined) out.reenter = t.reenter;
  if (t.description !== undefined) out.description = t.description;
  return out;
}

function transitionsOf(ts: ChartTransitions): unknown {
  return Array.isArray(ts) ? ts.map(transitionOf) : transitionOf(ts);
}

const mapValues = <T, U>(o: Record<string, T>, fn: (v: T) => U): Record<string, U> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fn(v)]));

/**
 * Why a resolved Effect input is not exactly the Effect's input keys, each a string (ADR-0070: "the
 * resolved object again at invoke time"), or undefined when it is. The door checked the literal
 * parts; a reference may still resolve to a value that is no string.
 */
function effectInputFault(keys: readonly string[], value: unknown): string | undefined {
  const given = typeof value === "object" && value !== null && !Array.isArray(value) ? Object.keys(value) : undefined;
  const ok =
    given !== undefined &&
    given.length === keys.length &&
    keys.every((k) => typeof (value as Record<string, unknown>)[k] === "string");
  return ok
    ? undefined
    : `its input resolved to ${JSON.stringify(value)}; it takes exactly ${keys.join(", ") || "nothing"}, each a string (ADR-0070)`;
}

const checkedEffects = new WeakMap<object, UnknownActorLogic>();

/**
 * A lent Effect as a Chart invokes it: the Effect itself (its brand and every method, by the
 * prototype), whose start refuses an input that fails its keys. The refusal is THAT invoke's
 * error, so the Chart's `onError` takes it: a throw in the input mapper would end the whole Chart.
 */
function checkedEffect(slot: string, logic: UnknownActorLogic): UnknownActorLogic {
  if (!isEffect(logic)) return logic;
  const keys = inputKeysOf(logic.effect);
  if (keys === undefined) return logic;
  const hit = checkedEffects.get(logic);
  if (hit) return hit;
  const checked = Object.create(logic) as UnknownActorLogic;
  checked.getInitialSnapshot = (scope, input) => {
    const fault = effectInputFault(keys, input);
    if (fault === undefined) return logic.getInitialSnapshot(scope, input);
    return {
      status: "error",
      output: undefined,
      error: new ChartInvokeFault(`the lent Effect "${slot}": ${fault}`),
    } as never;
  };
  checkedEffects.set(logic, checked);
  return checked;
}

/** The lent actors as a Chart invokes them: each Effect checked at its start (see {@link checkedEffect}). */
function chartActors(actors: Record<string, UnknownActorLogic>): Record<string, UnknownActorLogic> {
  return Object.fromEntries(Object.entries(actors).map(([slot, logic]) => [slot, checkedEffect(slot, logic)]));
}

/** An Agent Turn's input with `prompt` and `cwd` as strings: a whole placeholder may resolve to
 * an object or a number, which a Turn's Frame never takes, so it is written as text (JSON for an
 * object or a list), as an interpolated placeholder is. The body's own placement rides it (see
 * {@link PLACEMENT_KEYS}): the Chart named none. */
function turnInput(value: unknown, placement: Record<string, string>): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const out = { ...(value as Record<string, unknown>), ...placement };
  for (const key of ["prompt", "cwd"]) {
    const v = out[key];
    if (v === undefined || typeof v === "string") continue;
    out[key] = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
  }
  return out;
}

/**
 * A Chart Gate's input with its `gate` id below the body's own actor path: a Chart cannot take
 * the caller-facing name of a Gate of its wrapper (gate.ts: two live Gates with one id fail at
 * invoke), and a human told to approve that name approves the wrapper's Gate, not the Chart's.
 * `self` is the body's actor, which runs the compiled Machine.
 */
function gateInput(value: unknown, self: AnyActorRef): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const id = (value as { gate?: unknown }).gate;
  if (typeof id !== "string") return value;
  return { ...(value as Record<string, unknown>), gate: [...actorPath(self), id].join(".") };
}

function invokeOf(inv: ChartInvoke, agents: ReadonlySet<string>): unknown {
  const out: Record<string, unknown> = { src: inv.src };
  if (inv.id !== undefined) out.id = inv.id;
  if (inv.input !== undefined) {
    const template = inv.input;
    // Resolved at invoke time, with `{ context, event, input }` (ADR-0070).
    out.input = agents.has(inv.src)
      ? (args: Args) => turnInput(resolveAt(template, args), placementOf(args.context?.[CHART_INPUT_KEY]))
      : inv.src === "gate"
        ? (args: Args & { self: AnyActorRef }) => gateInput(resolveAt(template, args), args.self)
        : (args: Args) => resolveAt(template, args);
  }
  if (inv.onDone !== undefined) out.onDone = transitionsOf(inv.onDone);
  if (inv.onError !== undefined) out.onError = transitionsOf(inv.onError);
  return out;
}

function stateOf(st: ChartState, agents: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (st.type !== undefined) out.type = st.type;
  if (st.initial !== undefined) out.initial = st.initial;
  if (st.history !== undefined) out.history = st.history;
  if (st.states !== undefined) out.states = mapValues(st.states, (child) => stateOf(child, agents));
  if (st.invoke !== undefined)
    out.invoke = Array.isArray(st.invoke) ? st.invoke.map((inv) => invokeOf(inv, agents)) : invokeOf(st.invoke, agents);
  if (st.on !== undefined) out.on = mapValues(st.on, transitionsOf);
  if (st.always !== undefined) out.always = transitionsOf(st.always);
  if (st.after !== undefined) out.after = mapValues(st.after, transitionsOf);
  if (st.entry !== undefined) out.entry = st.entry.map(actionOf);
  if (st.exit !== undefined) out.exit = st.exit.map(actionOf);
  if (st.output !== undefined) out.output = resolver(st.output);
  if (st.meta !== undefined) out.meta = st.meta;
  if (st.tags !== undefined) out.tags = [...st.tags];
  if (st.description !== undefined) out.description = st.description;
  return out;
}

/** How {@link compileChart} builds what is not in the Chart. */
export type CompileOptions = OpenBodyOptions & {
  /** The machine id when the Chart names none: the Open body's slot key. Default `"chart"`. */
  id?: string;
};

/**
 * Build the Machine a Chart describes (ADR-0070), with `jr2Setup` over: the lent actors by their
 * slot names, `agent(def)` for each Agent the Chart mints, and the kit's `gate`; the lent guards
 * and `jr2.sentBy`; the lent actions and the four generic ones; the lent delays. Every reference
 * resolves at invoke time, so the Machine holds the text's shape and no run's data. The Chart's
 * input is the context key {@link CHART_INPUT_KEY}; a done Chart outputs `{ outcome: "done",
 * output }`, its `output` resolved (or, without one, its final state's). The transitions ceiling
 * is xstate's `maxIterations` as well, so a guarded `always` loop that never ends in one macrostep
 * still ends. `jr2Setup`'s own refusals (a parallel state below an Agent's) throw here.
 */
export function compileChart(
  admitted: AdmittedChart,
  lent: LentParts,
  decl: OpenBodyDeclaration,
  options: CompileOptions = {},
): AnyStateMachine {
  const text = admitted.text;
  const mint = options.mintAgent ?? ((_slot: string, definition: AgentDefinition) => agent(definition));
  const minted = mapValues(admitted.agents, (def) => def);
  const actors: Record<string, UnknownActorLogic> = chartActors(lent.actors);
  for (const [slot, def] of Object.entries(minted)) actors[slot] = mint(slot, def);
  // The slots an invoke runs an Agent Turn in: the lent Agents and the Chart's own.
  const agentSlots = new Set([
    ...Object.keys(lent.actors).filter((slot) => isAgent(lent.actors[slot])),
    ...Object.keys(minted),
  ]);
  const initialContext = text.context ?? {};
  const config = {
    id: text.id ?? options.id ?? "chart",
    context: ({ input }: { input: unknown }) => ({
      ...(JSON.parse(JSON.stringify(initialContext)) as Record<string, unknown>),
      [CHART_INPUT_KEY]: input ?? {},
    }),
    initial: text.initial,
    states: mapValues(text.states, (st) => stateOf(st, agentSlots)),
    output: ({ context, event }: Args) =>
      ({
        outcome: "done",
        output:
          text.output !== undefined
            ? resolveAt(text.output, { context, event })
            : (event as { output?: unknown } | undefined)?.output,
      }) satisfies OpenBodyOutput,
    options: { maxIterations: decl.ceilings.transitions },
  };
  return jr2Setup({
    events: admitted.events,
    actors,
    guards: lent.guards as never,
    actions: { ...(lent.actions as Record<string, unknown>), ...GENERIC } as never,
    delays: lent.delays as never,
  }).createMachine(config as never) as unknown as AnyStateMachine;
}

// One compile per Chart text and id, per declaration, per process (the brief's memo by hash): the
// lent implementations vary per run and are put in with `provide`, which keeps the config, so the
// vocabulary and the seats `jr2Setup` attached stay. What the compile reads off the lent set is
// the KIND of each lent actor (an Agent's invoke input is a Turn's), so the key holds the kinds:
// a run whose `provide()` lends a fake in an Agent's place compiles a Machine of its own. Bounded:
// the least recently used Machine goes first, so distinct one-shot Charts do not grow the process.
const compiled = new WeakMap<OpenBodyDeclaration, Map<string, AnyStateMachine>>();

/** The compiled Machines one declaration keeps. */
export const COMPILE_MEMO_SIZE = 64;

const kindOf = (logic: unknown): string => (isAgent(logic) ? "agent" : isEffect(logic) ? "effect" : "machine");

function compiledFor(
  admitted: AdmittedChart,
  lent: LentParts,
  decl: OpenBodyDeclaration,
  options: CompileOptions,
): AnyStateMachine {
  let byKey = compiled.get(decl);
  if (!byKey) compiled.set(decl, (byKey = new Map()));
  // The full digest: a 12-hex hash is a display, and two texts that share one must never share a
  // Machine.
  const kinds = Object.keys(lent.actors)
    .sort()
    .map((slot) => `${slot}:${kindOf(lent.actors[slot])}`)
    .join(",");
  const key = `${chartDigest(admitted.text)}#${admitted.text.id ?? options.id ?? "chart"}#${kinds}`;
  let machine = byKey.get(key);
  if (machine) {
    byKey.delete(key);
    byKey.set(key, machine);
    return machine;
  }
  try {
    machine = compileChart(admitted, lent, decl, options);
  } catch (err) {
    if (err instanceof ChartRefusal) throw err;
    throw new ChartRefusal([compileLine(err)]);
  }
  byKey.set(key, machine);
  if (byKey.size > COMPILE_MEMO_SIZE) byKey.delete(byKey.keys().next().value!);
  return machine;
}

/** The compiled Machines a declaration's memo holds now: a test reads the bound. */
export function compiledCount(decl: OpenBodyDeclaration): number {
  return compiled.get(decl)?.size ?? 0;
}

/** The Machine an Open body's actor runs: compiled from its Chart, with the lent parts it has now.
 * What `invokingMachine` consults first, so an Agent or a Gate a Chart's state invokes resolves its
 * vocabulary, its Menu and its iid as under any Machine. Undefined for any other actor. */
export function boundMachineOf(actor: AnyActorRef): AnyStateMachine | undefined {
  return boundMachineFor(actor);
}

/** A Chart a persisted (or live) snapshot tree binds: the child ids down to its body, the body's
 * slot key, and the text and hash the body keeps. */
export type BoundChart = { path: string[]; src: string; chart: ChartText; chartHash: string };

/** {@link BoundChart} with the slot key of every actor on the path, root's child first: what the
 * host resolves the body slot through, Machine by Machine. */
export type BoundChartRoute = BoundChart & { srcs: string[] };

/** Every Chart bound in a snapshot tree, with the slot route to its body. Both shapes a run's tree
 * arrives in are read: a live actor's children are actor refs, a persisted one's `{ src, snapshot }`. */
export function boundChartRoutesOf(snapshot: unknown): BoundChartRoute[] {
  const out: BoundChartRoute[] = [];
  const walk = (snap: unknown, path: string[], srcs: string[]): void => {
    const children = (snap as { children?: Record<string, unknown> } | undefined)?.children ?? {};
    for (const [id, entry] of Object.entries(children)) {
      const child = entry as { src?: unknown; snapshot?: unknown; getSnapshot?: () => unknown };
      const inner = (typeof child.getSnapshot === "function" ? child.getSnapshot() : child.snapshot) as
        | { chart?: unknown; chartHash?: unknown; status?: unknown }
        | undefined;
      const src = typeof child.src === "string" ? child.src : "";
      const at = [...path, id];
      const route = [...srcs, src];
      if (inner && typeof inner.chart === "object" && inner.chart !== null && typeof inner.chartHash === "string") {
        out.push({ path: at, src, srcs: route, chart: inner.chart as ChartText, chartHash: inner.chartHash });
      }
      walk(inner, at, route);
    }
  };
  walk(snapshot, [], []);
  return out;
}

/** Every Chart bound in a snapshot tree (D-B: the text and hash ride the body's own snapshot). */
export function boundChartsOf(persisted: unknown): BoundChart[] {
  return boundChartRoutesOf(persisted).map(({ srcs: _srcs, ...chart }) => chart);
}

const isLoop = (err: unknown): boolean => err instanceof Error && err.message.startsWith("Infinite loop detected");

const fieldsOf = (s: BodyFields): BodyFields => ({
  ...(s.chart !== undefined ? { chart: s.chart } : {}),
  ...(s.chartHash !== undefined ? { chartHash: s.chartHash } : {}),
  startedAt: s.startedAt,
  counters: { ...s.counters },
});

/** Is this the `{ name }` form of a body's `chart` input? */
function isChartName(raw: unknown): raw is { name: string } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    Object.keys(raw).length === 1 &&
    typeof (raw as { name?: unknown }).name === "string"
  );
}

/** The event the body sends itself when an Agent Turn starts below one of its children: a lent
 * Machine's Turn, which no transition of the body sees, counted where the body's counters are. */
export const TURN_EVENT = "jr2.openBody.turn";

/**
 * A scope whose `defer` holds each function until the delegate returns. xstate defers the start
 * of each child a macrostep spawns; a macrostep the transitions ceiling aborts (or a reference
 * that resolved to nothing) is in no snapshot, so its children must never start: their Turns would
 * run outside every counter, and CANCEL could not reach them. `flush` hands the held functions to
 * the body's own scope, in order, and every later `defer` goes there at once (before the body
 * starts, xstate runs the initial actions later, and they defer through this scope then); `drop`
 * discards them, and every later one.
 */
function buffered(scope: AnyActorScope): { scope: AnyActorScope; flush: () => void; drop: () => void } {
  const held: Array<() => void> = [];
  let mode: "hold" | "forward" | "drop" = "hold";
  return {
    scope: {
      ...scope,
      defer: (fn: () => void) => {
        if (mode === "hold") held.push(fn);
        else if (mode === "forward") scope.defer(fn);
      },
    } as AnyActorScope,
    flush: () => {
      mode = "forward";
      for (const fn of held.splice(0)) scope.defer(fn);
    },
    drop: () => {
      mode = "drop";
      held.length = 0;
    },
  };
}

/** The Turns a body's actor counts, at any depth below it, and its watch on the actor system. */
type TurnWatch = { turns: number; unsubscribe: () => void };
const turnWatches = new WeakMap<AnyActorRef, TurnWatch>();

const isBelow = (ref: AnyActorRef, self: AnyActorRef): boolean => {
  for (let p = ref._parent; p; p = p._parent) if (p === self) return true;
  return false;
};

/**
 * Count every Agent Turn that starts below the body (ADR-0070: the Turns counter is the Open
 * body's), a lent Machine's included: an Agent actor CREATED below it, not one restored (a restore
 * re-attaches a Turn that was counted). The Turn one past the ceiling is stopped before its
 * deferred start, so it is never admitted, and the body is told; a Turn below a child is told too,
 * so the count rides the body's snapshot.
 */
function watchTurns(self: AnyActorRef, turns: number, ceiling: number): TurnWatch {
  turnWatches.get(self)?.unsubscribe();
  const watch: TurnWatch = { turns, unsubscribe: () => {} };
  const sub = self.system.inspect((ev) => {
    if (ev.type !== "@xstate.actor") return;
    const ref = ev.actorRef as AnyActorRef & { logic?: unknown; options?: { snapshot?: unknown; state?: unknown } };
    if (!isAgent(ref.logic) || ref.options?.snapshot !== undefined || ref.options?.state !== undefined) return;
    if (!isBelow(ref, self)) return;
    watch.turns += 1;
    if (watch.turns > ceiling) (ref as unknown as { _stop: () => void })._stop();
    if (watch.turns > ceiling || ref._parent !== self) self.send({ type: TURN_EVENT });
  });
  watch.unsubscribe = () => sub.unsubscribe();
  turnWatches.set(self, watch);
  return watch;
}

/** The actor logic of an Open body: a custom ActorLogic that delegates to the compiled Chart. */
export function openBodyLogic(decl: OpenBodyDeclaration, options: OpenBodyOptions = {}): UnknownActorLogic {
  const wallMs = durationMs(decl.ceilings.wallClock) ?? Number.POSITIVE_INFINITY;
  const c = decl.ceilings;

  const settled = (output: OpenBodyOutput, fields: BodyFields, from?: BodySnapshot): BodySnapshot => ({
    status: "done",
    output,
    error: undefined,
    value: from?.value ?? {},
    context: {},
    children: {},
    historyValue: {},
    ...fields,
  });

  /** Settle with `output` and stop the body's children (a ceiling, a run-time refusal). */
  const settleWith = (
    output: OpenBodyOutput,
    from: BodySnapshot,
    fields: BodyFields,
    scope: AnyActorScope,
  ): BodySnapshot => {
    for (const child of Object.values(from.children ?? {})) {
      if ((child as { _parent?: unknown })._parent === scope.self) scope.stopChild(child);
    }
    return settled(output, fields, from);
  };

  /** Settle on a ceiling (ADR-0070): the body's output names it, and its children are stopped. */
  const ceiling = (
    which: keyof Ceilings,
    detail: string,
    from: BodySnapshot,
    fields: BodyFields,
    scope: AnyActorScope,
  ): BodySnapshot => settleWith({ outcome: "ceiling", ceiling: which, detail }, from, fields, scope);

  const turnsDetail = (turns: number) =>
    `the Chart started ${turns} Agent Turns; this Open body's ceiling is ${c.turns}`;

  /** The counters and the ceilings a transition's result is held to: Turns started, children live,
   * the size of the context and the output. */
  const held = (next: AnyMachineSnapshot, fields: BodyFields, scope: AnyActorScope): BodySnapshot => {
    const turns = turnWatches.get(scope.self)?.turns ?? fields.counters.turns;
    const counted: BodyFields = { ...fields, counters: { ...fields.counters, turns } };
    const out = { ...(next as unknown as Record<string, unknown>), ...counted } as BodySnapshot;
    // A generic `set` or `append` can copy a structure into itself, so a context that is small in
    // memory (shared references) can double its JSON on each transition; every save, status read
    // and feed frame writes that JSON. So the data a Chart holds is bounded too.
    const big = jsonOver(next.context, MAX_CONTEXT_SIZE)
      ? "context"
      : next.status === "done" && jsonOver(next.output, MAX_CONTEXT_SIZE)
        ? "output"
        : undefined;
    if (big) {
      return ceiling(
        "size",
        `the Chart's ${big} is more than ${MAX_CONTEXT_SIZE} bytes of JSON; an Open body holds at most that`,
        out,
        counted,
        scope,
      );
    }
    if (next.status !== "active") return out;
    if (turns > c.turns) return ceiling("turns", turnsDetail(turns), out, counted, scope);
    // A child that is done while its state is still active is no longer live (xstate removes it
    // only when its state exits).
    const children = Object.values((next.children ?? {}) as Record<string, AnyActorRef>);
    const live = children.filter((child) => child.getSnapshot()?.status === "active").length;
    if (live > c.fanOut) {
      return ceiling(
        "fanOut",
        `the Chart has ${live} children live at once; this Open body's ceiling is ${c.fanOut}`,
        out,
        counted,
        scope,
      );
    }
    return out;
  };

  const transitionsDetail = (n: number) =>
    `the Chart took ${n} microsteps; this Open body's ceiling is ${c.transitions}`;

  /**
   * Run one step of the compiled Machine over a buffered scope, and hold its result to the
   * ceilings. The transitions ceiling is a microstep budget for the whole run (ADR-0070): each
   * step counts the microsteps xstate takes (its `@xstate.microstep` inspection events), and the
   * step may take at most what is left (xstate's `maxIterations`, set per step on the body's own
   * Machine), so a macrostep that never comes to rest ends too. Past the budget the body settles
   * `ceiling`; a reference that resolved to nothing settles `refused`. Either way the aborted
   * step's deferred starts are dropped: its children never run.
   */
  const step = (
    machine: AnyStateMachine,
    run: (scope: AnyActorScope) => AnyMachineSnapshot,
    from: BodySnapshot,
    fields: BodyFields,
    scope: AnyActorScope,
  ): BodySnapshot => {
    const { scope: inner, flush, drop } = buffered(scope);
    // `provide()` gave this body a Machine of its own, so its options are this run's alone.
    (machine.options as { maxIterations?: number }).maxIterations = Math.max(
      1,
      c.transitions - fields.counters.transitions,
    );
    let microsteps = 0;
    const counting = scope.system.inspect((ev) => {
      if (ev.type === "@xstate.microstep" && ev.actorRef === scope.self) microsteps++;
    });
    runFault = undefined;
    let next: AnyMachineSnapshot;
    try {
      next = run(inner);
    } catch (err) {
      drop();
      // Set by a resolver inside `run`, which the compiler cannot see.
      const fault = runFault as ChartRunFault | undefined;
      runFault = undefined;
      if (isLoop(err)) {
        const total = fields.counters.transitions + microsteps;
        return ceiling(
          "transitions",
          `${transitionsDetail(Math.max(total, c.transitions + 1))}, and it did not come to rest`,
          from,
          { ...fields, counters: { ...fields.counters, transitions: total } },
          scope,
        );
      }
      if (fault !== undefined) {
        return settleWith(
          {
            outcome: "refused",
            report: [`(run time): ${fault.message}; the door admitted it, and the run's data does not hold it`],
          },
          from,
          fields,
          scope,
        );
      }
      throw err;
    } finally {
      counting.unsubscribe();
    }
    const counted: BodyFields = {
      ...fields,
      counters: { ...fields.counters, transitions: fields.counters.transitions + microsteps },
    };
    if (counted.counters.transitions > c.transitions) {
      drop();
      return ceiling("transitions", transitionsDetail(counted.counters.transitions), from, counted, scope);
    }
    const out = held(next, counted, scope);
    // A ceiling `held` reached stopped the new children, so their deferred starts do nothing.
    flush();
    return out;
  };

  /** Admit and compile a Chart text, and record the Machine the actor runs. Throws ChartRefusal. */
  const bind = (self: AnyActorRef, text: unknown, inputKeys: readonly string[]) => {
    const lent = liveLentOf(self, logic);
    const admitted = admitChart(text, decl, lent, { inputKeys });
    const src = (self as { src?: unknown }).src;
    const machine = compiledFor(admitted, lent, decl, {
      ...options,
      ...(typeof src === "string" ? { id: src } : {}),
    }).provide({
      actors: chartActors(lent.actors),
      guards: lent.guards,
      actions: lent.actions,
      delays: lent.delays,
    } as Parameters<AnyStateMachine["provide"]>[0]);
    attachBoundMachine(self, machine);
    return { admitted, machine };
  };

  /** Is `ref` the body of a transparent wrapper (ADR-0049: `workspace()`, `pool()`)? */
  const isTransparentBody = (ref: AnyActorRef): boolean => {
    const parent = (ref._parent as { logic?: unknown } | undefined)?.logic;
    return isMachine(parent) && wrapperBodyOf(parent) === (ref as { src?: unknown }).src;
  };

  /** The Chart a body's `chart` input names: its text, or a named Chart of the run's own wrapper. */
  const chartOf = (raw: unknown, scope: AnyActorScope): unknown => {
    if (raw === undefined || raw === null) {
      throw new ChartRefusal(["chart: the Open body's input carries no `chart` (its text, or { name })"]);
    }
    if (!isChartName(raw)) return raw;
    // D-C: a name resolves among the Charts of the wrapper that is the run's Workflow, seen through
    // the transparent wrappers above it; a body whose wrapper another Machine invokes resolves none.
    let wrapper = scope.self._parent;
    while (wrapper?._parent && isTransparentBody(wrapper)) wrapper = wrapper._parent;
    if (wrapper?._parent !== undefined) {
      throw new ChartRefusal([
        `chart.name: "${raw.name}" — a Chart is named only under the Chart wrapper that is the run's own Workflow, ` +
          "and this Open body's Chart wrapper is invoked by another Machine; pass the Chart's text (ADR-0070)",
      ]);
    }
    const text = boundRun(scope.system)?.chartNamed?.(raw.name);
    if (text === undefined) {
      throw new ChartRefusal([`chart.name: the run's Chart wrapper has no Chart named "${raw.name}"`]);
    }
    return text;
  };

  /** The keys of the Chart's `input` that hold a value: a key sent as undefined is absent, and
   * the body's placement is never the Chart's to read. */
  const keysOf = (input: Record<string, unknown>): string[] =>
    Object.keys(chartInputOf(input)).filter((k) => input[k] !== undefined);

  /** The body is done with the system: its Turn watch ends. */
  const release = (self: AnyActorRef, snap: BodySnapshot): BodySnapshot => {
    if (snap.status !== "active") {
      turnWatches.get(self)?.unsubscribe();
      turnWatches.delete(self);
    }
    return snap;
  };

  const logic = {
    getInitialSnapshot(scope: AnyActorScope, input: unknown): BodySnapshot {
      const base: BodyFields = { startedAt: Date.now(), counters: { turns: 0, transitions: 0 } };
      const { chart: raw, ...chartInput } = (input ?? {}) as Record<string, unknown>;
      try {
        const text = chartOf(raw, scope);
        const { admitted, machine } = bind(scope.self, text, keysOf(chartInput));
        const fields: BodyFields = { ...base, chart: admitted.text, chartHash: admitted.hash };
        watchTurns(scope.self, 0, c.turns);
        const from = settled({ outcome: "done", output: undefined }, fields);
        const out = step(
          machine,
          (inner) => machine.getInitialSnapshot(inner as never, chartInput) as AnyMachineSnapshot,
          from,
          fields,
          scope,
        );
        if (out.status === "active") {
          // The wall clock is xstate's own delayed event, so a parked Chart still ends; the run
          // host records it with the run's other timers and arms it again at restore (timers.ts).
          scope.defer(() => {
            (scope.system as unknown as { scheduler: Scheduler }).scheduler.schedule(
              scope.self,
              scope.self,
              { type: WALL_CLOCK_EVENT },
              wallMs,
              WALL_CLOCK_EVENT,
            );
          });
        }
        return release(scope.self, out);
      } catch (err) {
        if (!(err instanceof ChartRefusal)) throw err;
        return release(scope.self, settled({ outcome: "refused", report: err.report }, base));
      }
    },

    transition(snapshot: BodySnapshot, event: AnyEventObject, scope: AnyActorScope): BodySnapshot {
      const machine = snapshot.machine;
      if (snapshot.status !== "active" || !machine) return snapshot;
      const fields = fieldsOf(snapshot);
      if (event.type === "xstate.stop") {
        release(scope.self, { ...snapshot, status: "stopped" });
        return {
          ...(machine.transition(snapshot as never, event, scope as never) as object),
          ...fields,
        } as BodySnapshot;
      }
      if (event.type === TURN_EVENT) {
        // A Turn started below a child of the body: the count rides the snapshot, and one past
        // the ceiling settles the body (the Turn itself was stopped before it started).
        const turns = turnWatches.get(scope.self)?.turns ?? fields.counters.turns;
        const counted: BodyFields = { ...fields, counters: { ...fields.counters, turns } };
        if (turns > c.turns) return release(scope.self, ceiling("turns", turnsDetail(turns), snapshot, counted, scope));
        return { ...snapshot, ...counted };
      }
      const elapsed = Date.now() - fields.startedAt;
      if (event.type === WALL_CLOCK_EVENT || elapsed >= wallMs) {
        return release(
          scope.self,
          ceiling(
            "wallClock",
            `the Chart ran ${decl.ceilings.wallClock} by the wall clock; this Open body's ceiling is ${decl.ceilings.wallClock}`,
            snapshot,
            fields,
            scope,
          ),
        );
      }
      if (fields.counters.transitions >= c.transitions) {
        return release(
          scope.self,
          ceiling("transitions", transitionsDetail(fields.counters.transitions), snapshot, fields, scope),
        );
      }
      return release(
        scope.self,
        step(
          machine,
          (inner) => machine.transition(snapshot as never, event, inner as never) as AnyMachineSnapshot,
          snapshot,
          fields,
          scope,
        ),
      );
    },

    getPersistedSnapshot(snapshot: BodySnapshot, options?: unknown): unknown {
      const fields = fieldsOf(snapshot);
      if (!snapshot.machine) {
        const { machine: _m, ...plain } = snapshot;
        return { ...plain, ...fields };
      }
      return { ...(snapshot.machine.getPersistedSnapshot(snapshot as never, options as never) as object), ...fields };
    },

    restoreSnapshot(persisted: unknown, scope: AnyActorScope): BodySnapshot {
      const p = persisted as BodySnapshot;
      if (p.status !== "active" || p.chart === undefined) return p;
      const hash = chartHash(p.chart);
      if (hash !== p.chartHash) {
        throw new Error(`Open body: the Chart's hash ${String(p.chartHash)} does not match its text (${hash})`);
      }
      const input = (p.context?.[CHART_INPUT_KEY] ?? {}) as Record<string, unknown>;
      // Admitted again against the declaration and the lent set the actor has NOW: a lent slot the
      // Assembly dropped refuses (D-B). The host checks this before it restores; a refusal here is
      // the body's error.
      const { machine } = bind(scope.self, p.chart, keysOf(input));
      // The Turns counted so far ride the snapshot; a restored Agent re-attaches and is not counted.
      watchTurns(scope.self, p.counters?.turns ?? 0, c.turns);
      const inner = machine.restoreSnapshot!(p as never, scope as never) as object;
      return { ...inner, ...fieldsOf(p) } as BodySnapshot;
    },

    start(snapshot: BodySnapshot): void {
      if (snapshot.status === "active" && snapshot.machine) snapshot.machine.start?.(snapshot as never);
    },
  };
  return logic as unknown as UnknownActorLogic;
}

/** xstate's system scheduler, as the wall clock arms it (an xstate internal; timers.ts reads it too). */
type Scheduler = {
  schedule: (source: AnyActorRef, target: AnyActorRef, event: AnyEventObject, delay: number, id?: string) => void;
};
