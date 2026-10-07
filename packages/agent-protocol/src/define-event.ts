// `defineEvent` — the event mechanism, and zero events (ADR-0011). A workflow defines its own
// control vocabulary as pure-data defs; jr2 owns only definition, transport, validation, and
// delivery. This is a PURE factory: no import-time side effects, no global registry. Scoping is
// per-MACHINE — a Machine hands its defs to `jr2Setup({ events: [...] })` (ADR-0015), which
// attaches the vocabulary to that machine, and actors resolve event *names* (which is all a
// serializable input can carry — ADR-0007) against the Machine that INVOKED them (ADR-0049).
// Two Machines' `approve` may legitimately differ, nested one inside the other, in one run.

import { z } from "zod";

/**
 * How delivering the event resolves for the caller (ADR-0006):
 * - `ack`  the pick is delivered and answered. A pick that moves the workflow to work inside the
 *          Agent's state is answered when that work is done (ADR-0024): the answer is the Machine's,
 *          never a schema on the pick, so no pick declares an output.
 * - `poll` the caller pulls queued down-channel messages (cooperative steer checkpoint). Reserved,
 *          not built (ADR-0013).
 */
export type EventSemantics = "ack" | "poll";

/**
 * Who may deliver the event, stated BY KIND (ADR-0015): `agent` (an Agent's pick), `external` (a
 * Gate's caller), `any` (both). Leave it UNSET for the default: each writing of the event — each
 * `on` key — belongs to the party that its state, or the nearest state above it, invokes (an Agent
 * slot, a `gate`, or both); with none above, both. Set it only to give a pick to the other party
 * (`submit: "any"` lets an in-Turn Gate's caller send the Agent's pick) or to hold a root pick back
 * (`report_blocked: "agent"`; `approve: "external"` guarantees no Agent state can offer it).
 */
export type EventAudience = "agent" | "external" | "any";

/**
 * A workflow-defined control event: pure data (plus zod schemas), safe to import anywhere.
 * `name` doubles as the MCP tool name (agent side) and the xstate event `type` (Machine side).
 */
export type EventDef<Name extends string = string, Input extends z.ZodObject = z.ZodObject> = {
  readonly name: Name;
  readonly description?: string;
  /** Input schema — a flat tagged object, never a `oneOf` (ADR-0006 encoding rule). */
  readonly input: Input;
  readonly semantics: EventSemantics;
  /** Absent: each writing's state decides who may send it (see {@link EventAudience}). */
  readonly audience?: EventAudience;
};

/**
 * The Machine-side event type a def delivers as: `{ type: name } & input`. Distributes over
 * unions, so a `setup` event union derives from the defs — one source of truth, no drift:
 *
 *   events: EventFrom<typeof approve | typeof requestChanges> | { type: "agent.fault"; ... }
 */
export type EventFrom<D extends EventDef> =
  D extends EventDef<infer N, infer I>
    ? // An empty input infers as `Record<string, never>`, whose intersection with `{ type }` is
      // unsatisfiable — collapse it so `{ type: "approve" }` typechecks for payload-less events.
      { type: N } & (z.infer<I> extends Record<string, never> ? unknown : z.infer<I>)
    : never;

// The wire constrains names, not taste: a name is an MCP tool name and an xstate event type at
// once. The MCP-safe charset below also (deliberately) excludes `.`, which keeps workflow events
// mechanically out of the dotted namespaces jr2 itself delivers on (`xstate.*`, `agent.*`,
// `workspace.*`).
const NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * The field the Orchestrator writes on every event a party delivers into a Machine: its
 * {@link Sender} (ADR-0011, ADR-0015). Plain data on the event, so it rides the mailbox, a delayed
 * event the run host persists, and a restore. Only the Orchestrator writes it: no def may declare
 * it, and a caller that posts it is refused. The Machine's own events (`raise`, `sendTo` itself, a
 * child's `sendParent`) carry none.
 */
export const SENDER_KEY = "sender";

/** Who delivered an event: an Agent by its slot, or a Gate by its invoke id (ADR-0015). */
export type Sender = { readonly party: "agent" | "gate"; readonly id: string };

/** Define one control event. Pure — returns a frozen def; registration happens nowhere. */
export function defineEvent<const Name extends string, Input extends z.ZodObject>(def: {
  name: Name;
  description?: string;
  input: Input;
  /** Default: `ack`. */
  semantics?: EventSemantics;
  /** Default: unset — each writing's state decides (see {@link EventAudience}). */
  audience?: EventAudience;
}): EventDef<Name, Input> {
  if (!NAME_RE.test(def.name)) {
    throw new Error(
      `defineEvent: invalid name "${def.name}" — must match ${NAME_RE} ` +
        `(it becomes an MCP tool name and an xstate event type)`,
    );
  }
  if (SENDER_KEY in def.input.shape) {
    throw new Error(
      `defineEvent: "${def.name}" declares \`${SENDER_KEY}\` in its input — the Orchestrator writes that field ` +
        `on every delivered event (who sent it); name the payload field something else`,
    );
  }
  // Retired (ADR-0006): a pick's answer is the Machine's — the last reply since the pick, or what an
  // `answer` action sets (ADR-0024) — so a schema on the pick would promise a shape nothing keeps.
  const loose = def as { semantics?: unknown; output?: unknown };
  if (loose.semantics === "deferred" || loose.output !== undefined) {
    throw new Error(
      `defineEvent: "${def.name}" declares ${loose.output !== undefined ? "an `output`" : "`deferred`"}, which is retired — ` +
        `every pick is answered when the work it started is done, and the answer is the Machine's, not the def's`,
    );
  }
  return Object.freeze({ semantics: "ack" as const, ...def });
}

/** Duck-type guard for manifest validation (defs are plain data, not branded). */
export function isEventDef(value: unknown): value is EventDef {
  const v = value as EventDef | null;
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.name === "string" &&
    !!v.input &&
    typeof (v.input as { safeParse?: unknown }).safeParse === "function"
  );
}

/**
 * Resolve a defs list into a name→def map, rejecting duplicates and non-defs. `jr2Setup` calls
 * this once per Machine (ADR-0015); the error names the Machine so an unlisted or double-listed
 * name fails loudly at machine-build time, not at delivery. The scope is the MACHINE, not the
 * Workflow: a nested Machine is reached by `import` and never carries the name `jr2 run` addresses
 * (ADR-0049), so naming it a workflow here would misreport where the bad def lives.
 *
 * `poll` is RESERVED, not implemented (ADR-0013): the wire leaves room for it — a surface listing
 * ships each def's `semantics` — but nothing drains a steer inbox today. Registering one therefore
 * FAILS here. Quietly downgrading it to `ack` would hand the Agent a tool whose contract is a lie.
 * (A pick whose answer waits on the Machine's work needs no semantics of its own: every `ack` pick
 * is answered at Rest, ADR-0024.)
 */
export function eventMap(machine: string, events: readonly unknown[]): Map<string, EventDef> {
  const map = new Map<string, EventDef>();
  for (const def of events) {
    if (!isEventDef(def)) {
      throw new Error(`machine "${machine}": \`events\` entry is not a defineEvent() def: ${JSON.stringify(def)}`);
    }
    if (map.has(def.name)) throw new Error(`machine "${machine}": duplicate event "${def.name}" in \`events\``);
    if (def.semantics !== "ack") {
      throw new Error(
        `machine "${machine}": event "${def.name}" is \`${def.semantics}\`, which is reserved but ` +
          `NOT IMPLEMENTED (ADR-0013). Only \`ack\` events can be delivered today; nothing drains a ` +
          `steer inbox, and degrading it to \`ack\` would hand the Agent a lying tool contract.`,
      );
    }
    map.set(def.name, def);
  }
  return map;
}
