// `defineEvent` — the event mechanism, and zero events (ADR-0011). A workflow defines its own
// control vocabulary as pure-data defs; jr2 owns only definition, transport, validation, and
// delivery. This is a PURE factory: no import-time side effects, no global registry. Scoping is
// per-MACHINE — a Machine hands its defs to `jr2Setup({ events: [...] })` (ADR-0015), which
// attaches the vocabulary to that machine, and actors resolve event *names* (which is all a
// serializable input can carry — ADR-0007) against the Machine that INVOKED them (ADR-0049).
// Two Machines' `approve` may legitimately differ, nested one inside the other, in one run.

import { z } from "zod";

// How delivering the event resolves for the caller (ADR-0006):
// - `ack`  the pick is delivered and answered. A pick that moves the workflow to work inside the
//          Agent's state is answered when that work is done (ADR-0024): the answer is the Machine's,
//          never a schema on the pick, so no pick declares an output.
// - `poll` the caller pulls queued down-channel messages (cooperative steer checkpoint). Reserved,
//          not built (ADR-0013).
/**
 * How the party that sends an event gets its answer.
 *
 * - `"ack"`, the default: jr2 delivers the event and answers the sender. When the event starts
 *   work inside the Agent's state, the answer comes when that work is done.
 * - `"poll"`: reserved. `createMachine` refuses it: ``machine "<id>": event "<name>" is `poll`,
 *   which is reserved but NOT IMPLEMENTED (ADR-0013). Only `ack` events can be delivered today;
 *   nothing drains a steer inbox, and degrading it to `ack` would hand the Agent a lying tool
 *   contract.``
 *
 * @see @jr2/orchestrator/docs/concepts/the-menu.md
 * @see @jr2/orchestrator/docs/reference/decisions/0006-agent-control-surface.md
 */
export type EventSemantics = "ack" | "poll";

// Stated BY KIND (ADR-0015). Unset, each writing — each `on` key — belongs to the party that its
// state, or the nearest state above it, invokes (an Agent slot, a `gate`, or both); with none
// above, both. Set it only to give a pick to the other party (`submit: "any"` lets an in-Turn
// Gate's caller send the Agent's pick) or to hold a root pick back (`report_blocked: "agent"`;
// `approve: "external"` guarantees no Agent state can offer it).
/**
 * Who may send an event: `"agent"` (an Agent, as a pick from its Menu), `"external"` (the caller of
 * a Gate), or `"any"` (both).
 *
 * Leave it unset in most cases. Then the position of each `on` key decides: the event belongs to
 * the party that its state, or the nearest state above it, invokes. An `on` key on a state that
 * invokes no party, with no such state above it, belongs to both. Set an audience only to give an
 * event to the other party too (`"any"`). Or set it to keep an event on the root from one party
 * (`"agent"` or `"external"`).
 *
 * @see @jr2/orchestrator/docs/concepts/the-menu.md
 * @see @jr2/orchestrator/docs/concepts/gates.md
 * @see @jr2/orchestrator/docs/reference/decisions/0015-authoring-surface-absorbs-the-mechanism.md
 */
export type EventAudience = "agent" | "external" | "any";

// `name` doubles as the MCP tool name (agent side) and the xstate event `type` (Machine side).
/**
 * A workflow event, as `defineEvent` gives it back: plain, frozen data and a zod schema, safe to
 * import anywhere. Give it to `jr2Setup({ events })`. A Machine accepts only the events in that
 * list.
 *
 * @see @jr2/orchestrator/docs/guides/write-a-workflow.md
 * @see @jr2/orchestrator/docs/reference/decisions/0011-workflow-defined-events.md
 */
export type EventDef<Name extends string = string, Input extends z.ZodObject = z.ZodObject> = {
  /** The event's name: its xstate event `type`, and the name of its tool on the Agent's Menu. */
  readonly name: Name;
  /** What the event means. An Agent's model reads it as the tool's description. */
  readonly description?: string;
  // The ADR-0006 encoding rule: a flat tagged object, never a `oneOf`.
  /** The schema of the event's payload: a flat `z.object`, never a union. */
  readonly input: Input;
  /** How the sender gets its answer: always `"ack"` on an event that `createMachine` accepts. */
  readonly semantics: EventSemantics;
  /** Who may send the event. Absent: the state of each `on` key decides (see {@link EventAudience}). */
  readonly audience?: EventAudience;
};

/**
 * The Machine-side event type a def delivers as: `{ type: name } & input`. Distributes over
 * unions, so a `setup` event union derives from the defs — one source of truth, no drift:
 *
 *   events: EventFrom<typeof approve | typeof requestChanges> | { type: "agent.fault"; ... }
 *
 * @internal
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

/**
 * Define one workflow event: an event that an Agent or the caller of a Gate may send into your
 * Machine. Give the result to `jr2Setup({ events })`, and write its name as an `on` key on the
 * states that take it. An Agent sees each event it may send as one tool on its Menu.
 *
 * It gives back a frozen {@link EventDef} and registers nothing. Each Machine whose `jr2Setup`
 * lists the event takes it. A Machine that does not list it does not take it.
 *
 * It refuses:
 * - a name with a character other than a letter, a digit, `_` or `-`:
 *   `defineEvent: invalid name "<name>" — must match /^[a-zA-Z0-9_-]+$/ (it becomes an MCP tool
 *   name and an xstate event type)`
 * - an `input` with a `sender` field:
 *   ``defineEvent: "<name>" declares `sender` in its input — the Orchestrator writes that field
 *   on every delivered event (who sent it); name the payload field something else``
 * - an `output` field:
 *   ``defineEvent: "<name>" declares an `output`, which is retired — every pick is answered when
 *   the work it started is done, and the answer is the Machine's, not the def's``. With
 *   `semantics: "deferred"`, the text says ``declares `deferred` `` in place of
 *   ``declares an `output` ``.
 *
 * @param def - The event: its `name`, its `input` schema, and optionally its `description`,
 *   `semantics` and `audience`.
 * @returns The event, as plain data to list in `jr2Setup({ events })`.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { agent, defineEvent, jr2Setup } from "@jr2/orchestrator";
 *
 * const done = defineEvent({
 *   name: "done",
 *   description: "Call this when the summary is written.",
 *   input: z.object({ summary: z.string() }),
 * });
 *
 * export const machine = jr2Setup({
 *   events: [done],
 *   actors: {
 *     writer: agent({
 *       model: "anthropic/claude-haiku-5-5",
 *       instructions: "You write short summaries.",
 *       workspace: "none",
 *     }),
 *   },
 * }).createMachine({
 *   id: "summary",
 *   initial: "writing",
 *   states: {
 *     writing: {
 *       invoke: { src: "writer", input: { prompt: "Summarize the release notes in one line." } },
 *       on: { done: "finished" },
 *     },
 *     finished: { type: "final" },
 *   },
 * });
 * ```
 *
 * @see @jr2/orchestrator/docs/guides/write-a-workflow.md
 * @see @jr2/orchestrator/docs/concepts/the-menu.md
 * @see @jr2/orchestrator/docs/reference/decisions/0011-workflow-defined-events.md
 */
export function defineEvent<const Name extends string, Input extends z.ZodObject>(def: {
  /** The event's name: the `on` key that takes it, and the name of its tool on the Agent's Menu.
   * Letters, digits, `_` and `-` only. */
  name: Name;
  /** What the event means, and when to send it. An Agent's model reads it as the tool's
   * description. Make it true at every state that takes the event. */
  description?: string;
  /** The schema of the payload: a flat `z.object`. Use `z.object({})` for an event with no
   * payload. Do not name a field `sender`: jr2 writes that field. */
  input: Input;
  /** How the sender gets its answer. Default: `"ack"`, the only value `createMachine` accepts. */
  semantics?: EventSemantics;
  /** Who may send the event: `"agent"`, `"external"` or `"any"`. Default: unset, and the state of
   * each `on` key decides (see {@link EventAudience}). */
  audience?: EventAudience;
}): EventDef<Name, Input> {
  // Pure: no import-time side effect and no global registry (ADR-0011). Scoping is per Machine,
  // done by `jr2Setup`, never here.
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
