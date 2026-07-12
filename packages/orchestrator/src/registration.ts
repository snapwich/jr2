// The internal registration table (ADR-0011): one structure behind both delivery dialects.
// `agentRun` and `gate` register `address → { accepted event defs, deliver closure, meta }`;
// the MCP demux and the gates HTTP API are adapters over it — lookup, schema validation,
// delivery, discovery, and lifecycle are implemented ONCE. The table is implementation
// structure, not vocabulary: workflows speak only `defineEvent` / `agentRun` / `gate`.
//
// Run identity reaches every registration mechanically through the xstate actor `system`: the
// host binds each run's root system to a RunBinding at createActor time, and callback actors
// (which receive `system`, shared by every actor in the tree at any nesting depth) resolve it
// here. That is what makes gate ids run-scoped — `gate: "F-12"` in two concurrent runs cannot
// collide — with zero workflow plumbing. The WeakMap is rendezvous keyed by per-run object
// identity, not a swappable adapter (the distinction ADR-0011 draws for the demux).

import type { ActorSystem } from "xstate";
import type { EventDef } from "@j2/agent-protocol";

/** xstate doesn't export its internal AnyActorSystem; this matches what actors receive. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActorSystem = ActorSystem<any>;

/** A workflow event as delivered into a Machine: the def's name as `type`, plus its payload. */
export type DeliveredEvent = { type: string } & Record<string, unknown>;

/** One live registration: a state's declared surface, addressable by one external caller. */
export type Registration = {
  /** Table-wide unique address (see {@link gateAddress} / {@link mcpAddress}). */
  address: string;
  runId: string;
  /** Which dialect registered it — what `GET /runs/:id` lists as gates vs agent surfaces. */
  kind: "gate" | "agent";
  /** The caller-facing id within its dialect (the gate id, or the agent's instance id). */
  id: string;
  /** Accepted events, name→def — the validation scope AND the discovery listing. */
  defs: Map<string, EventDef>;
  /** Serializable caller/integration context (PR URL, title …) — rides the discovery listing. */
  meta?: Record<string, unknown>;
  /** Close over the invoking state's `sendBack`; delivery lands where the actor was invoked. */
  deliver: (event: DeliveredEvent) => void;
};

/** Delivery target absent (unknown address, settled run, exited state) — the one catch point. */
export class UnknownAddressError extends Error {}
/** Delivery body rejected (unaccepted name, or payload failing the named schema). */
export class EventValidationError extends Error {}

/** The address of a run's gate: gate ids are run-scoped by construction (ADR-0011). */
export function gateAddress(runId: string, gate: string): string {
  return `gate/${runId}/${gate}`;
}

/** The address of an agent instance's MCP surface: iids are globally unique already. */
export function mcpAddress(instanceId: string): string {
  return `mcp/${instanceId}`;
}

export class RegistrationTable {
  private readonly byAddress = new Map<string, Registration>();

  /** Register a live surface; returns its disposer (actors call it from their stop cleanup). */
  register(reg: Registration): () => void {
    if (this.byAddress.has(reg.address)) {
      throw new Error(
        `registration address "${reg.address}" is already live (two concurrent registrations share an id)`,
      );
    }
    this.byAddress.set(reg.address, reg);
    return () => {
      // Dispose only our own entry — a re-registration under the same address must not be
      // clobbered by a stale disposer running late (dev reload, restore races).
      if (this.byAddress.get(reg.address) === reg) this.byAddress.delete(reg.address);
    };
  }

  lookup(address: string): Registration | undefined {
    return this.byAddress.get(address);
  }

  /** All live registrations for one run — the `GET /runs/:id` discovery listing. */
  byRun(runId: string): Registration[] {
    return [...this.byAddress.values()].filter((r) => r.runId === runId);
  }

  /**
   * Validate and deliver one event to an address: the shared behavior both dialect adapters
   * call. Unknown address / unaccepted name / bad payload throw typed errors the adapters map
   * to their wire (404 / 400, MCP tool errors). The payload is parsed by the named def's
   * schema, so what lands in the Machine is exactly the validated shape.
   */
  deliver(address: string, type: string, payload: unknown): void {
    const reg = this.byAddress.get(address);
    if (!reg) throw new UnknownAddressError(`no live registration at "${address}"`);
    const def = reg.defs.get(type);
    if (!def) {
      throw new EventValidationError(
        `"${reg.id}" does not accept "${type}" (accepts: ${[...reg.defs.keys()].join(", ") || "nothing"})`,
      );
    }
    const parsed = def.input.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new EventValidationError(`invalid "${type}" payload: ${parsed.error.message}`);
    }
    reg.deliver({ type: def.name, ...parsed.data });
  }
}

/** What a callback actor needs from its host: run identity, the workflow's vocabulary, the table. */
export type RunBinding = {
  runId: string;
  workflow: string;
  /** The workflow's declared vocabulary (its `events` manifest, resolved name→def). */
  events: Map<string, EventDef>;
  table: RegistrationTable;
};

const bindings = new WeakMap<AnyActorSystem, RunBinding>();

/** Host-side: bind a run's actor system to its identity, before the actor starts. */
export function bindRun(system: AnyActorSystem, binding: RunBinding): void {
  bindings.set(system, binding);
}

/** Actor-side: resolve the run this actor tree belongs to. Throws outside a j2 host. */
export function runBindingOf(system: AnyActorSystem): RunBinding {
  const binding = bindings.get(system);
  if (!binding) {
    throw new Error(
      "no run binding for this actor system — gate/agentRun only run under a j2 RunHost " +
        "(unit tests: bindRun(actor.system, …) before start)",
    );
  }
  return binding;
}

/**
 * Resolve `accepts` names against the run's declared vocabulary. An unlisted name fails at
 * invoke time, naming the workflow and its declared set (ADR-0011: names are per-workflow).
 */
export function resolveAccepts(binding: RunBinding, accepts: readonly string[]): Map<string, EventDef> {
  const defs = new Map<string, EventDef>();
  for (const name of accepts) {
    const def = binding.events.get(name);
    if (!def) {
      throw new Error(
        `workflow "${binding.workflow}" does not declare event "${name}" ` +
          `(declared: ${[...binding.events.keys()].join(", ") || "none — add an \`export const events\` manifest"})`,
      );
    }
    defs.set(name, def);
  }
  return defs;
}
