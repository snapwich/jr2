// The internal registration table (ADR-0011): one structure behind both delivery dialects.
// An Agent slot and `gate` register `address → { accepted event defs, deliver closure, meta }`;
// the two HTTP surfaces (`/agents/:iid/*` for the Adapter, `/runs/:id/gates/*` for humans and
// webhooks) are adapters over it — lookup, schema validation, delivery, discovery, and lifecycle
// are implemented ONCE. The table is implementation structure, not vocabulary: workflows speak
// only `defineEvent` / `agent` / `gate`.
//
// The dialects are also the AUTHORIZATION boundary (ADR-0013), which is why an agent registration
// records its `sandbox`: a Sandbox token may deliver to `kind: "agent"` registrations whose Sandbox
// is its own, and to nothing else. Never a Gate — a compromised Agent must not be able to approve
// its own review — and never another Sandbox: `coding.ts`'s iids are derivable, so a run-scoped
// credential would let one feature's coder inject a verdict into another feature's reviewer.
//
// Run identity reaches every registration mechanically through the xstate actor `system`: the
// host binds each run's root system to a RunBinding at createActor time, and callback actors
// (which receive `system`, shared by every actor in the tree at any nesting depth) resolve it
// here. That is what makes gate ids run-scoped — `gate: "F-12"` in two concurrent runs cannot
// collide — with zero workflow plumbing. The WeakMap is rendezvous keyed by per-run object
// identity, not a swappable adapter (the distinction ADR-0011 draws for the demux).
//
// The binding carries run identity and host infrastructure and NO vocabulary: event names are
// scoped to the Machine that declared them, not to the run (ADR-0011, ADR-0049), so
// `resolveAccepts` reads them off the invoking Machine below and a nested Machine's names are
// never the root's problem.

import type { ActorSystem, AnyActorRef, AnyEventObject } from "xstate";
import type { EventDef } from "@jr2/agent-protocol";
import type { AgentAdmission } from "./actor.ts";
import type { SandboxPort } from "./workspace.ts";
import { invokingMachine, vocabularyOf } from "./vocabulary.ts";

/** xstate doesn't export its internal AnyActorSystem; this matches what actors receive. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActorSystem = ActorSystem<any>;

/** A workflow event as delivered into a Machine: the def's name as `type`, plus its payload. */
export type DeliveredEvent = { type: string } & Record<string, unknown>;

/** One live registration: a state's declared surface, addressable by one external caller. */
export type Registration = {
  /** Table-wide unique address (see {@link gateAddress} / {@link agentAddress}). */
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
  /**
   * The actor path below the run root ({@link actorPath}) — WHERE in the Machine this surface
   * lives. Carried beside `id` because an authored gate id ("F-12") erases the path a derived id
   * happens to spell, and a caller locating the invoking state (the Console's gate pin) must
   * never parse ids. Gates always carry it; agent registrations don't need it today.
   */
  path?: string[];
  /**
   * The Sandbox this agent runs in — the scope of the Sandbox token that may deliver here
   * (ADR-0013). Absent on gates, and on a workspace-less Agent turn (the mechanics tier's stub
   * Harness runs on the host, in no Sandbox at all): those are the Instance token's business.
   */
  sandbox?: string;
  /** Close over the invoking state's `sendBack`; delivery lands where the actor was invoked. */
  deliver: (event: DeliveredEvent) => void;
  /**
   * The Machine that invoked this actor — `self._parent`, captured at registration. The menu was
   * derived from THIS machine's transitions (ADR-0015), so it is the only snapshot whose guards
   * can answer "would this event move anything" (see {@link wouldMove}). Absent on registrations
   * that have no parent to name, which is why every read of it fails open.
   */
  invoker?: AnyActorRef;
};

/**
 * Would this exact event move the invoking Machine? The guard question the derived menu cannot ask
 * for itself: `deriveMenus` reads transition KEYS, so an event whose every transition is guarded
 * false is on the menu regardless (ADR-0029).
 *
 * This is the AUTHORITATIVE form — delivery has the validated payload, so payload-reading guards
 * answer on real data. {@link mayMove} is the menu's weaker form.
 *
 * **Fails open**: no invoker, or a guard that throws, reads as `true`. The failure modes are not
 * symmetric. A wrong `true` offers a tool that does nothing — today's behavior, and recoverable,
 * because the receipt now says so. A wrong `false` tells an Agent its work was rejected when the
 * workflow would have accepted it, and nothing recovers from that.
 *
 * A transition that neither targets nor acts (`on: { X: {} }`) reads as false, matching xstate's
 * own `can()`. Correct: a handler that does nothing is not a handler.
 */
export function wouldMove(invoker: AnyActorRef | undefined, event: AnyEventObject): boolean {
  if (!invoker) return true;
  try {
    return invoker.getSnapshot().can(event);
  } catch {
    return true;
  }
}

/**
 * COULD this event move the invoking Machine, judged before the Agent has picked its arguments?
 * What the surface build can ask (ADR-0029) — there is no payload yet, so a guard reading one
 * would answer on `undefined` and report a false "no".
 *
 * So the probe watches. The event goes in behind a Proxy that records any read outside `type`; a
 * `false` is trusted only when the guard never looked at the payload, and a guard that did look is
 * offered anyway and settled exactly at delivery by {@link wouldMove}. That keeps the two failure
 * modes where they belong: a context-only guard (`rounds > 0`) filters precisely, and a
 * payload-only guard (`event.verdict === "approved"`) is never silently hidden from the Agent.
 *
 * Verified against the pinned xstate: guards receive the object handed to `can()`, unspread and
 * unwrapped, so the trap sees exactly the guard's own reads. If an xstate bump ever broke that, the
 * trap would simply see nothing and this would degrade to filtering slightly more — hence the test
 * that pins a payload-reading guard STAYING on the menu.
 */
export function mayMove(invoker: AnyActorRef | undefined, type: string): boolean {
  if (!invoker) return true;
  let readPayload = false;
  const watch = (prop: string | symbol): void => {
    if (typeof prop === "string" && prop !== "type") readPayload = true;
  };
  const probe = new Proxy({ type } as Record<string, unknown>, {
    get(target, prop, receiver) {
      watch(prop);
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      watch(prop);
      return Reflect.has(target, prop);
    },
  });
  try {
    if (invoker.getSnapshot().can(probe as AnyEventObject)) return true;
  } catch {
    return true;
  }
  return readPayload;
}

/** Delivery target absent (unknown address, settled run, exited state) — the one catch point. */
export class UnknownAddressError extends Error {}
/** Delivery body rejected (unaccepted name, or payload failing the named schema). */
export class EventValidationError extends Error {}

/**
 * The actor path below the run's root: every id from the root's children down to `ref` itself,
 * root-most first. The root is excluded because its id is generated per process — everything
 * below it is author-named and stable across restore (ADR-0016). One walk for both address
 * kinds: `mintIid` builds iids from it, `gate` derives default gate ids from it, so the two
 * cannot drift.
 */
export function actorPath(ref: AnyActorRef): string[] {
  const segments: string[] = [];
  for (let r: AnyActorRef | undefined = ref; r?._parent; r = r._parent) segments.unshift(r.id);
  return segments;
}

/** The address of a run's gate: gate ids are run-scoped by construction (ADR-0011). */
export function gateAddress(runId: string, gate: string): string {
  return `gate/${runId}/${gate}`;
}

/** The address of an agent instance's surface (`/agents/:iid/*`): iids are globally unique. */
export function agentAddress(instanceId: string): string {
  return `agent/${instanceId}`;
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

/** What a callback actor needs from its host: run identity, the table, and the host's ports. */
export type RunBinding = {
  runId: string;
  workflow: string;
  table: RegistrationTable;
  /** The host's Sandbox backend, when it has a cluster (`workspace()` resolves it here —
   * one cluster per orchestrator instance, so it is host infrastructure like the table). */
  sandbox?: SandboxPort;
  /**
   * The Instance Harness base URL (ADR-0031) — the deterministic Service DNS a
   * `workspace: "none"` Turn is admitted at. Deployed instances derive it from their namespace;
   * absent, a `"none"` Agent without an explicit `endpoint` fails loudly.
   */
  instanceHarness?: string;
  /**
   * Record an Agent invocation's durable admission in the host ledger (ADR-0016): persisted
   * beside the snapshot in the same RunBlob save, keyed by iid (globally unique, so the map is
   * flat). Optional so a bare unit-test binding can omit it — then admissions simply are not
   * durable.
   */
  recordAdmission?: (instanceId: string, admission: AgentAdmission) => void;
  /**
   * Surface absorbed-retry telemetry on the run feed (ADR-0016): attempts are observable, but
   * as `{ child, attempt }` — state-key-class data, never iids (ADR-0014's line holds on the
   * open feed).
   */
  telemetry?: (event: RetryTelemetry) => void;
  /**
   * Put a Turn marker on the run's feed (ADR-0023): an Agent turn reports its admission and its
   * settlement pick, so the run's narrative can name what a Turn hosted elsewhere decided.
   * Host-supplied; absent (bare unit-test bindings), turns leave no markers.
   */
  marker?: (event: TurnMarker) => void;
  /**
   * Attach the run-narrative echo to a Workspace's Harness (ADR-0023): the host replays the
   * run's feed-so-far to `endpoint`, then tees live; returns the detach. Called by `workspace()`'s
   * registrar — the same restore-safe seat the ambient handles ride — and scoped to the OWNING
   * run by construction: the binding is per-run, so a sibling run's feed is unreachable.
   * Host-supplied; absent = no echo.
   */
  echo?: (endpoint: string) => () => void;
  /**
   * The HOST is ending this run for its own reasons (ADR-0024). An Agent invocation ending
   * normally ends the Agent's turn — the state stopped waiting — but `RunHost.stop()` is the one
   * ending that must leave the durable submission alive, because ADR-0007's restore re-attaches
   * to it. The host cannot be INFERRED (process shutdown stops no actors, and restore is a fresh
   * process), so it says so here, before it stops the actor.
   */
  hostStopping?: boolean;
  /**
   * iid → the abort still in flight for it (ADR-0024). The Agent actor fills this on the way out and
   * waits on it before admitting, so an abort can never overtake the next turn on the same
   * instance — flue QUEUES per instance, and an abort that lost that race would settle the new
   * submission before it ran. Created on demand: the ordering must hold for ANY binding, not only
   * one the host remembered to equip.
   */
  pendingAborts?: Map<string, Promise<void>>;
};

/** One absorbed-retry attempt (a no-signal nudge), as the run feed carries it. */
export type RetryTelemetry = { kind: "retry"; child: string; attempt: number; reason: string };

/**
 * ADR-0023's Turn markers, as the run feed carries them: a Turn admitted on a Harness (the Agent
 * and its framing), and the settlement pick that ended it. `endpoint` names the HOSTING Harness —
 * what lets the echo tee keep "markers, not mirrors": a marker whose Turn ran AT the echo's own
 * target is dropped there, because that pod's log already carries the whole transcript. Feed
 * data of the Instance-token class (the prompt is working data): markers ride the per-run feed
 * and the echo, never ADR-0014's open band.
 */
export type TurnMarker =
  | { kind: "admission"; agent: string; endpoint: string; prompt: string }
  | { kind: "pick"; agent: string; endpoint: string; event: string; payload?: Record<string, unknown> };

const bindings = new WeakMap<AnyActorSystem, RunBinding>();

/** Host-side: bind a run's actor system to its identity, before the actor starts. */
export function bindRun(system: AnyActorSystem, binding: RunBinding): void {
  bindings.set(system, binding);
}

/** The bound run's id, or undefined outside a jr2 host — the SOFT read `jr2Setup`'s iid minting
 * uses, so a machine stays constructible and provide()-testable with no host at all. */
export function boundRunId(system: AnyActorSystem): string | undefined {
  return bindings.get(system)?.runId;
}

/** Actor-side: resolve the run this actor tree belongs to. Throws outside a jr2 host. */
export function runBindingOf(system: AnyActorSystem): RunBinding {
  const binding = bindings.get(system);
  if (!binding) {
    throw new Error(
      "no run binding for this actor system — gate and Agent slots only run under a jr2 RunHost " +
        "(unit tests: bindRun(actor.system, …) before start)",
    );
  }
  return binding;
}

/**
 * Resolve `accepts` names against the vocabulary of the Machine that INVOKED this actor
 * (ADR-0011, ADR-0049). Names are local to their Machine — `coding`'s `approve` and `release`'s
 * `approve` may carry different payloads, and one run may hold both — so the scope is
 * `self._parent.logic`, never a run-wide set. An unlisted name fails at invoke time, naming the
 * Machine and its declared set.
 */
export function resolveAccepts(self: AnyActorRef, accepts: readonly string[]): Map<string, EventDef> {
  const machine = invokingMachine(self);
  const vocabulary = (machine && vocabularyOf(machine)) ?? new Map<string, EventDef>();
  const defs = new Map<string, EventDef>();
  for (const name of accepts) {
    const def = vocabulary.get(name);
    if (!def) {
      throw new Error(
        `machine "${machine?.id ?? "(no invoking machine)"}" does not declare event "${name}" ` +
          `(declared: ${[...vocabulary.keys()].join(", ") || "none — pass its def to jr2Setup({ events })"})`,
      );
    }
    defs.set(name, def);
  }
  return defs;
}
