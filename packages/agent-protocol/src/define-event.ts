// `defineEvent` — the event mechanism, and zero events (ADR-0011). A workflow defines its own
// control vocabulary as pure-data defs; j2 owns only definition, transport, validation, and
// delivery. This is a PURE factory: no import-time side effects, no global registry. Scoping is
// per-workflow — each workflow module declares its vocabulary in a manifest export
// (`export const events = [...]`, a peer of `export const machine`), discovery collects it, and
// actors resolve event *names* (which is all a serializable input can carry — ADR-0007) against
// their own workflow's set. Two workflows' `approve` may legitimately differ.

import { z } from "zod";

/**
 * How delivering the event resolves for the caller (ADR-0006):
 * - `ack`      fire-and-acknowledge; the caller does not wait on a meaningful result.
 * - `deferred` the result is held open until the Machine answers (solicited down-channel).
 * - `poll`     the caller pulls queued down-channel messages (cooperative steer checkpoint).
 */
export type EventSemantics = "ack" | "deferred" | "poll";

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
  /** Result schema for `deferred` events (the held tool result the Machine answers with). */
  readonly output?: z.ZodType;
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
// mechanically out of the dotted namespaces j2 itself delivers on (`xstate.*`, `agent.*`,
// `workspace.*`).
const NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Define one control event. Pure — returns a frozen def; registration happens nowhere. */
export function defineEvent<const Name extends string, Input extends z.ZodObject>(def: {
  name: Name;
  description?: string;
  input: Input;
  /** Default: `ack`. */
  semantics?: EventSemantics;
  output?: z.ZodType;
}): EventDef<Name, Input> {
  if (!NAME_RE.test(def.name)) {
    throw new Error(
      `defineEvent: invalid name "${def.name}" — must match ${NAME_RE} ` +
        `(it becomes an MCP tool name and an xstate event type)`,
    );
  }
  if (def.semantics === "deferred" && !def.output) {
    throw new Error(
      `defineEvent: "${def.name}" is deferred but has no output schema — a deferred event's result IS its output`,
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
 * Resolve a manifest (`export const events`) into a name→def map, rejecting duplicates and
 * non-defs. Discovery calls this once per workflow; the error names the workflow so an unlisted
 * or double-listed name fails loudly at registration, not at delivery.
 *
 * `deferred` and `poll` are RESERVED, not implemented (ADR-0013): the wire leaves room for them —
 * a surface listing ships each def's `semantics`, a delivery returns an addressable receipt — but
 * nothing answers a held call today, and how a Machine should is deliberately undesigned (there is
 * no consumer to design it against, and flue's 60s MCP timeout means the answer will be
 * poll-with-progress rather than a held socket). Registering one therefore FAILS here. Quietly
 * downgrading it to `ack` would be worse than useless: the Agent would be handed a tool whose
 * contract — "this call returns the Machine's answer" — is a lie.
 */
export function eventMap(workflow: string, events: readonly unknown[]): Map<string, EventDef> {
  const map = new Map<string, EventDef>();
  for (const def of events) {
    if (!isEventDef(def)) {
      throw new Error(
        `workflow "${workflow}": \`events\` manifest entry is not a defineEvent() def: ${JSON.stringify(def)}`,
      );
    }
    if (map.has(def.name))
      throw new Error(`workflow "${workflow}": duplicate event "${def.name}" in \`events\` manifest`);
    if (def.semantics !== "ack") {
      throw new Error(
        `workflow "${workflow}": event "${def.name}" is \`${def.semantics}\`, which is reserved but ` +
          `NOT IMPLEMENTED (ADR-0013). Only \`ack\` events can be delivered today; there is nothing to ` +
          `answer a held call with, and degrading it to \`ack\` would hand the Agent a lying tool contract.`,
      );
    }
    map.set(def.name, def);
  }
  return map;
}
