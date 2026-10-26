// The internal registration table (ADR-0011): one structure behind both delivery dialects.
// An Agent slot and `gate` register `address → { accepted event defs, deliver closure, meta,
// sender }` — the sender written on every event it delivers (ADR-0015); the two HTTP surfaces
// (`/agents/:iid/*` for the Agent's Harness, `/runs/:id/gates/*` for humans and webhooks) are
// adapters over it — lookup, schema validation, delivery, discovery, and lifecycle
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

import { getStateNodes } from "xstate";
import type { ActorSystem, AnyActorRef, AnyEventObject, AnyMachineSnapshot, AnyStateMachine } from "xstate";
import { SENDER_KEY, type EventDef, type Sender } from "@jr2/agent-protocol";
import type { AgentAdmission } from "./actor.ts";
import type { EffectMarker, EffectRow } from "./effect.ts";
import type { EffectorPlacement, EffectorTarget } from "./http-effect.ts";
import type { NoticeScope, TakenNotices } from "./notices.ts";
import type { AnswerSeat } from "./pick.ts";
import type { Notice, PickAnswer } from "./wire.ts";
import type { SandboxPort } from "./workspace.ts";
import { invokingMachine, vocabularyOf } from "./vocabulary.ts";
import type { ChartText } from "./chart.ts";
import { notTaken, senderText, takesNow, type NotTakenWriting } from "./party.ts";
import { restOf } from "./rest.ts";
import type { RunStatus } from "./run-host.ts";

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
  /** Accepted events, name→def — the validation scope AND the discovery listing. For an Agent,
   * the invoking state's derived set: what its Allowed picks are narrowed from (ADR-0029). */
  defs: Map<string, EventDef>;
  /**
   * An Agent's MENU (ADR-0029), in its fixed order: the union of the derived sets of every state
   * that invokes an Agent of this name, and the tools block the Harness presents — byte-stable for
   * the conversation, so it never breaks the provider's prompt cache. A superset of {@link defs};
   * a pick on it that {@link defs} lacks is refused at delivery, naming the Allowed picks. Absent
   * on gates, and on an Agent registered with no Menu, which serves its `defs` as the Menu.
   */
  menu?: Map<string, EventDef>;
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
  /** An Agent's: the Harness read this surface (`GET /agents/:iid/surface`), so it has the Turn in
   * hand and prompts it. Until then the Turn may end with no model ever asked (ADR-0026). */
  served?: () => void;
  /**
   * The Machine that invoked this actor — `self._parent`, captured at registration. The menu was
   * derived from THIS machine's transitions (ADR-0015), so it is the only snapshot whose guards
   * can answer "would this event move anything" (see {@link wouldMove}). Absent on registrations
   * that have no parent to name, which is why every read of it fails open.
   */
  invoker?: AnyActorRef;
  /**
   * Who this registration delivers as (ADR-0015): an Agent by its slot, a Gate by its invoke id.
   * The table writes it on every event it delivers (`event.sender`), never taken from the caller.
   * Absent on a registration no party made (a bare unit-test entry): its events carry none.
   */
  sender?: Sender;
  /** The invoke id of the actor that registered: what finds its state — its seat — in the
   * Machine, for the party questions (`party.ts`). */
  invokeId?: string;
  /**
   * An Agent's: the continued conversation ({@link continuedIid}) this Turn is part of — set only
   * when the Turn continues one (`continue: true`). A pick whose route leaves the Agent's state is
   * answered by a notice to it (ADR-0024); a fresh Turn's conversation is never heard again, so its
   * answer has nowhere to go.
   */
  conversation?: string;
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
 * The states this exact event's transitions name as targets, by id — empty for a pick with no
 * target. Read before the send and checked after it with `leftAgain`: what tells a pick that entered
 * a state and left it again inside its own send (an `always` back to where it was) from one that
 * stayed where it went or went nowhere (ADR-0024). Fails CLOSED: a read that cannot be made reads
 * as no target, the plain receipt.
 */
export function targetsOf(invoker: AnyActorRef | undefined, event: AnyEventObject): string[] {
  if (!invoker) return [];
  try {
    const snapshot = invoker.getSnapshot() as AnyMachineSnapshot;
    return (snapshot.machine as AnyStateMachine)
      .getTransitionData(snapshot, event)
      .flatMap((t) => (t.target ?? []).map((node) => node.id));
  } catch {
    return [];
  }
}

/**
 * Is some state of `targets` no longer active — entered by the send and left again inside it? A
 * target to the state the pick was taken in (`drafting: { on: { note: "drafting" } }`) is still
 * active, so it is not. Fails CLOSED: false, the plain receipt.
 */
export function leftAgain(invoker: AnyActorRef | undefined, targets: readonly string[]): boolean {
  if (!invoker || targets.length === 0) return false;
  try {
    const snapshot = invoker.getSnapshot() as AnyMachineSnapshot;
    const active = new Set(getStateNodes(snapshot.machine.root, snapshot.value).map((node) => node.id));
    return targets.some((id) => !active.has(id));
  } catch {
    return false;
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

/** Would the run take `type` from this registration now, payload-blind? Asked AS its sender
 * ({@link takesNow}); a registration with no seat to ask from (a plain `setup()` actor tree, a bare
 * test entry) falls back to {@link mayMove}. */
function takenNow(reg: Pick<Registration, "invoker" | "sender" | "invokeId">, type: string): boolean {
  return takesNow(reg, type) ?? mayMove(reg.invoker, type);
}

/**
 * An Agent's Allowed picks now (ADR-0029): the invoking state's derived set, narrowed to what the
 * invoking Machine would take from this Agent ({@link takenNow}), in Menu order — so the list reads
 * in the order the tools block does. The ONE reading of the list: the surface, every receipt, the
 * nudge and the wake all ask here, so no two of them can disagree about what the Turn may pick
 * (ADR-0016).
 *
 * EMPTY while the Agent's state is not at Rest (rest.ts, ADR-0024): something below it runs, or a
 * timer holds, and every pick is refused until it is back at Rest — so the Rest rule and the
 * payload-blind selection give one list, and a Turn that starts busy is not asked into a refusal.
 */
export function allowedPicks(reg: Pick<Registration, "defs" | "menu" | "invoker" | "sender" | "invokeId">): string[] {
  if (restOf(reg) === "busy") return [];
  const ordered = new Set([...(reg.menu ?? reg.defs).keys()].filter((name) => reg.defs.has(name)));
  for (const name of reg.defs.keys()) ordered.add(name);
  return [...ordered].filter((name) => takenNow(reg, name));
}

/** A Gate's `acceptsNow` (ADR-0011): its accepted set, narrowed the same way as an Agent's Allowed
 * picks — the names the run would take from this Gate now. */
export function acceptsNow(reg: Pick<Registration, "defs" | "invoker" | "sender" | "invokeId">): string[] {
  return [...reg.defs.keys()].filter((name) => takenNow(reg, name));
}

/** Delivery target absent (unknown address, settled run, exited state) — the one catch point. */
export class UnknownAddressError extends Error {}
/** Delivery body rejected (unaccepted name, or payload failing the named schema). An Agent's
 * refusal carries its Allowed picks, read after the refusal (ADR-0029), so the Harness can say
 * what the Turn may pick instead. */
export class EventValidationError extends Error {
  allowed?: string[];
}

/**
 * A pick that arrived while the Agent's state is not at Rest (ADR-0024): refused, `finish` included,
 * and nothing is delivered — xstate would take it, and a pick its state handles would exit the child
 * state and stop the work running there. `outstanding` names this Turn's pick still out, when there
 * is one; without it, the state is busy with work the Turn did not pick (it started busy).
 */
export class OutstandingError extends Error {
  readonly outstanding?: string;
  constructor(message: string, outstanding?: string) {
    super(message);
    this.outstanding = outstanding;
  }
}

/** Refuse a caller's body that carries the sender (ADR-0013, ADR-0015): only the Orchestrator writes
 * it, from the registration, so neither the Agent's wire nor the gates route takes it. */
export function refuseSenderField(payload: unknown): void {
  if (payload && typeof payload === "object" && SENDER_KEY in payload) {
    throw new EventValidationError(
      `\`${SENDER_KEY}\` is written by the Orchestrator on every delivered event; a caller cannot send it`,
    );
  }
}

/**
 * The run would not take this event from this sender (ADR-0015, ADR-0029): xstate's selection holds
 * a writing that is another party's, or — at a Gate — nothing would move. Refused BEFORE the Machine
 * sees it. `writings` names the other party's writings, empty when nothing would move.
 */
export class NotTakenError extends Error {
  readonly writings: readonly NotTakenWriting[];
  constructor(message: string, writings: readonly NotTakenWriting[] = []) {
    super(message);
    this.writings = writings;
  }
}

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

/**
 * The Instance ID of an Agent's ONE continued conversation in one Machine instance (ADR-0057):
 * `<runId>/<machine actor path>/<agent>`, which is also its epoch-0 spelling. `machine` is the
 * actor of the INVOKING Machine — the invoke's own leaf id is deliberately absent, because every
 * state of one Machine that says `continue` means the same conversation, and two Machine
 * instances (two Pool children, whose ids are the items') can never meet.
 *
 * One derivation, two readers, so they cannot drift: `mintIid` builds every iid on it (a fresh
 * Turn adds a random suffix, a burned conversation's successor its epoch), and the Agent's Actor
 * names the conversation it burns with it.
 */
export function continuedIid(machine: AnyActorRef | undefined, runId: string, agentName: string): string {
  const path = (machine ? actorPath(machine).join(".") : "") || "root";
  return `${runId}/${path}/${agentName}`;
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
  /** The same registrations by run, so a run's are read without a scan of every run's: the run host
   * reads them on every microstep of the run (`cause.ts`). */
  private readonly ofRun = new Map<string, Set<Registration>>();

  /** Register a live surface; returns its disposer (actors call it from their stop cleanup). */
  register(reg: Registration): () => void {
    if (this.byAddress.has(reg.address)) {
      throw new Error(
        `registration address "${reg.address}" is already live (two concurrent registrations share an id)`,
      );
    }
    this.byAddress.set(reg.address, reg);
    const ofRun = this.ofRun.get(reg.runId) ?? new Set<Registration>();
    ofRun.add(reg);
    this.ofRun.set(reg.runId, ofRun);
    return () => {
      // Dispose only our own entry — a re-registration under the same address must not be
      // clobbered by a stale disposer running late (dev reload, restore races).
      if (this.byAddress.get(reg.address) === reg) this.byAddress.delete(reg.address);
      const runRegs = this.ofRun.get(reg.runId);
      runRegs?.delete(reg);
      if (runRegs?.size === 0) this.ofRun.delete(reg.runId);
    };
  }

  lookup(address: string): Registration | undefined {
    return this.byAddress.get(address);
  }

  /** All live registrations for one run, in the order they registered — the `GET /runs/:id`
   * discovery listing. */
  byRun(runId: string): Registration[] {
    return [...(this.ofRun.get(runId) ?? [])];
  }

  /**
   * Validate and deliver one event to an address: the shared behavior both dialect adapters
   * call. Unknown address / unaccepted name / bad payload throw typed errors the adapters map
   * to their wire (404 / 400, MCP tool errors). The payload is parsed by the named def's
   * schema, so what lands in the Machine is exactly the validated shape — plus the registration's
   * sender, written here and nowhere else (ADR-0015). A delivery that would run another party's
   * writing throws {@link NotTakenError}.
   */
  deliver(address: string, type: string, payload: unknown): void {
    const reg = this.byAddress.get(address);
    if (!reg) throw new UnknownAddressError(`no live registration at "${address}"`);
    refuseSenderField(payload);
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
    // `type` after the payload: a payload never names the event the Machine receives (ADR-0011).
    const event: DeliveredEvent = {
      ...parsed.data,
      type: def.name,
      ...(reg.sender ? { [SENDER_KEY]: reg.sender } : {}),
    };
    // Exact, with the real payload (ADR-0015): a delivery whose selection holds a writing that is
    // not this sender's never reaches the Machine.
    const others = reg.sender ? notTaken(reg, event) : [];
    if (others.length) {
      const owned = (w: NotTakenWriting): string =>
        w.owners.length ? `, which is ${w.owners.map(senderText).join(" and ")}'s` : "";
      throw new NotTakenError(
        `"${type}" from ${senderText(reg.sender!)} would run the writing on ` +
          `${others.map((w) => `"${w.state}"${owned(w)}`).join(" and ")}`,
        others,
      );
    }
    reg.deliver(event);
  }
}

/**
 * Which run dispatched a run (ADR-0071): the caller's run id, the slot of its `dispatch` Effect, and
 * that Effect's ledger row id, which is the idempotency key — a start that carries a key some run
 * already carries answers that run. `depth` is the dispatched run's depth in the chain, one below
 * its caller, stated by the caller and recorded as sent: one meaning on the wire, on the binding
 * and on the row. `instance` is set for a foreign caller, whose Orchestrator this one cannot
 * verify: opaque text, never resolved.
 */
export type DispatchedBy = { run: string; slot: string; effect: string; depth: number; instance?: string };

/** The header a foreign `dispatch` carries its {@link DispatchedBy} in, as JSON (ADR-0071): out of
 * band, so the callee's door reserves no body field for it. */
export const DISPATCHED_BY_HEADER = "jr2-dispatched-by";

/**
 * A dispatch's start as the run host answers it in-process (ADR-0071): the run, and whether the key
 * found one that already existed; or the door's refusal, with the status `POST /workflows/:name/runs`
 * would answer — 400 input the door refuses, 404 a name the current Assembly lacks, 409 a named
 * Chart that cannot run now, 422 a Chart the door refuses — and its report. A refusal is the
 * Effect's output, never thrown.
 */
export type DispatchStart =
  | { ok: true; runId: string; existing: boolean }
  | { ok: false; status: 400 | 404 | 409 | 422; report: string[] };

/** What a callback actor needs from its host: run identity, the table, and the host's ports. */
export type RunBinding = {
  runId: string;
  workflow: string;
  /** The name this run's Orchestrator gives itself at another Orchestrator's door (ADR-0071): the
   * `instance` of a foreign dispatch's `dispatchedBy` — stable across its runs and restarts, and not
   * secret, since the callee serves it on its open band. Deployed, its namespace. Never an Instance
   * ID, which names an Agent's conversation and stays behind the token. Absent on a bare unit-test
   * binding and an undeployed Orchestrator. */
  orchestratorName?: string;
  /** The run's depth in a chain of dispatches (ADR-0071): 0 for a run nothing dispatched. Absent
   * on a bare unit-test binding, which reads 0. */
  depth?: number;
  /**
   * The in-process half of a `dispatch` Effect (ADR-0071): the run host, reached directly, with no
   * wire and no token — the Orchestrator is the single writer of runs. `start` answers a refusal as
   * {@link DispatchStart}, never by throwing; `settled` resolves with the run's status once it is no
   * longer live — at once for a run already settled, and across a restore in either order — and
   * rejects when `signal` aborts. Absent outside a RunHost: a dispatch with no target faults.
   */
  dispatch?: {
    start(workflow: string, input: Record<string, unknown>, by: DispatchedBy): Promise<DispatchStart>;
    settled(runId: string, signal: AbortSignal): Promise<RunStatus>;
  };
  /** The hash of the Assembly the run holds (ADR-0069): the one it started under, through
   * restarts. Absent for a run no Assembly started. */
  assembly?: string;
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
   * The Harness bearer for a placement (ADR-0058): `harnessToken(signingKey, placement)`, closed
   * over the key by the host. The Agent's Actor asks it for the pod its Turn resolved to; the echo
   * attach asks it for the Workspace's. Absent (bare unit-test bindings, the stub path), no bearer
   * is sent — which only a Harness that checks nothing accepts.
   */
  harnessBearer?: (placement: string) => string;
  /**
   * Where an Effector placement is, and the key its wire is signed with (ADR-0068): the Instance
   * Effector's Service and `effectorKey(signingKey, "instance")`, closed over by the host. An http
   * Effect asks it; absent (bare unit-test bindings, an instance with no Effector), it faults.
   */
  effector?: (placement: EffectorPlacement) => EffectorTarget | undefined;
  /**
   * Record an Agent invocation's durable admission in the host ledger (ADR-0016): persisted
   * beside the snapshot in the same RunBlob save, keyed by iid (globally unique, so the map is
   * flat). Optional so a bare unit-test binding can omit it — then admissions simply are not
   * durable.
   */
  recordAdmission?: (instanceId: string, admission: AgentAdmission, delivered?: readonly string[]) => void;
  /**
   * The admission ledger's READ half (ADR-0016): the last admission ledgered under this iid. A
   * continued Turn asks it whether its conversation was ever admitted — only then can the Harness
   * have lost it (ADR-0062).
   */
  admissionOf?: (instanceId: string) => AgentAdmission | undefined;
  /**
   * The epoch ledger's READ half (ADR-0057): the current epoch of a continued conversation,
   * keyed by its base Instance ID ({@link continuedIid}). The input mapper reads it AT MINT TIME,
   * so the minted id persists with the input — a restore re-attaches the same conversation, and
   * only a fresh transition (which re-runs the mapper) sees a bump. Optional: a bare unit-test
   * binding has no burned conversations, so every conversation reads epoch 0.
   */
  epochOf?: (conversation: string) => number;
  /**
   * The epoch ledger's WRITE half (ADR-0057): the terminal `agent.fault` burns the conversation
   * it ended, and the next `continue` on that Agent mints `<conversation>/<epoch>` — a virgin
   * conversation. No fault leaves a conversation worth continuing (ADR-0035): a runaway either
   * had its reroll or holds a poisoned context, and infra and no-signal mean the Harness that
   * held it is unreachable. Persisted beside the snapshot with the admission ledger. `reason` is
   * the fault's: the host raises it as the next `continue`'s `conversation-new` notice (ADR-0062).
   */
  bumpEpoch?: (conversation: string, reason: string) => void;
  /**
   * The notices' write half (ADR-0062): keep a notice for the next admission in scope — `to` is a
   * continued conversation's base id or a Sandbox name, as the notice's `scope` says. Persisted at
   * the write, like the ledgers. `source` names the event, so one event raised twice is one notice;
   * `older` names earlier events this one tells the same as, marked raised with it (`NoticeLedger`).
   * A burned conversation's notice is raised by `bumpEpoch` itself, in the same save.
   */
  raiseNotice?: (notice: Notice, to: string, source?: string, older?: readonly string[]) => void;
  /** Put back a notice an admission carried that no model heard, WITH its source (`NoticeLedger.restore`):
   * a raise would drop it, its source being seen. Persisted at the write. */
  restoreNotice?: (notice: Notice, to: string, source?: string) => void;
  /** Reserve the pending notices in one admission's scope. They are delivered by the
   * `recordAdmission` that ledgers it (its `delivered` ids), or released if the admission fails. */
  takeNotices?: (scope: NoticeScope) => TakenNotices;
  releaseNotices?: (ids: readonly string[]) => void;
  /**
   * The pick the Turn now at this address has outstanding, or answered and not yet read (ADR-0024):
   * what the Agent's Actor asks when its Harness restarted under a Turn — a Turn whose pick is still
   * out, or whose answer never reached the model, is cut, not faulted (ADR-0031). Read after the host
   * settles its holds, so `answered` is the Rest rule's verdict now. An earlier Turn's pick on the
   * same continued address is not this Turn's: its answer went as a notice. Absent outside a RunHost.
   */
  outstandingOf?: (instanceId: string) => OutstandingPick | undefined;
  /** The held answer reached the model by another road — a re-admission's notice — so the poll's
   * copy is spent (ADR-0031). */
  heldAnswerDelivered?: (instanceId: string) => void;
  /**
   * Did this Turn's own pick end it (ADR-0024)? Asked by the Agent's Actor as its invocation stops,
   * before its registration goes, so its sweep can say so (`cause: "pick"`) and the Harness settles
   * the Submission `ended`. True exactly when the transition that stopped the invocation came from
   * the Turn's own pick, by the four rules of ADR-0024 (`cause.ts`): the pick in its own send; the
   * work below the Agent's state while the pick is out; a send of an actor that takes a relay from
   * the pick (rule 3); and a timer armed while its Machine took such a relay (rule 4) — so a timer
   * that the pick's route armed gives true. False for every other end — a timer armed before the
   * pick, an outside event, another party's event, the run's CANCEL, a fault. Absent outside a RunHost: the
   * sweep then says no cause.
   */
  turnEndedByPick?: (instanceId: string) => boolean;
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
  marker?: (event: RunMarker) => void;
  /**
   * Attach the run-narrative echo to a Workspace's Harness (ADR-0023): the host replays the
   * run's feed-so-far to `endpoint` — the Harness in `placement`'s pod, pushed with that
   * placement's bearer (ADR-0058) — then tees live; returns the detach. Called by `workspace()`'s
   * registrar — the same restore-safe seat the ambient handles ride — and scoped to the OWNING
   * run by construction: the binding is per-run, so a sibling run's feed is unreachable.
   * Host-supplied; absent = no echo.
   */
  echo?: (endpoint: string, placement: string) => () => void;
  /**
   * The HOST is ending this run for its own reasons (ADR-0024). An Agent invocation ending
   * normally ends the Agent's turn — the state stopped waiting — but `RunHost.stop()` is the one
   * ending that must leave the durable submission alive, because ADR-0007's restore re-attaches
   * to it. The host cannot be INFERRED (process shutdown stops no actors, and restore is a fresh
   * process), so it says so here, before it stops the actor.
   */
  hostStopping?: boolean;
  /**
   * The Sandbox names that a live Workspace of this run holds now, a Workspace in `placing` too
   * (ADR-0064, ADR-0073). A delete that runs after a stop leaves these alone: a parent that invokes
   * the same Machine again gives its new Workspace the same invoke id, and so the same name. Absent
   * outside a RunHost: no name is held.
   */
  heldSandboxes?: () => ReadonlySet<string>;
  /**
   * Every reply since the pick that `machine`'s Agent has outstanding, or is delivering now, oldest
   * first (ADR-0024) — what an `answer` action reads as its `chain` (ADR-0067). `seat` is the place
   * the action runs from: an Agent's state, and then only that Agent's pick counts; or `null`, a
   * transition below no Agent's state, and then `event` — the event whose transition runs the action
   * — names the Agent: the sender of a pick, or the Agent whose pick started the child whose done
   * or error event it is. Undefined when no such pick is being answered, when the event names an
   * Agent with none, or when the event names no Agent outside a pick's own send while two Agents'
   * states are active or more than one pick is outstanding: then the action cannot tell whose
   * answer it shapes, and sets none.
   */
  chainOf?: (machine: AnyActorRef, seat: AnswerSeat, event?: AnyEventObject) => PickAnswer[] | undefined;
  /** Set what that pick's answer is (ADR-0067): it replaces the default, and the last call wins.
   * Kept with the hold, so a restore answers the same. */
  setAnswer?: (machine: AnyActorRef, seat: AnswerSeat, value: unknown, event?: AnyEventObject) => void;
  /**
   * The Effect ledger's READ half (ADR-0067): one Effect's row, by its id — what a restored Effect
   * reads to deliver its output, re-attach, or settle `unknown`, and never to run twice.
   */
  effectRow?: (effectId: string) => EffectRow | undefined;
  /** Every row of the run's Effect ledger, by Effect id — what a push reads its pairs from (each
   * push of its Workspace and Repo Slot that published, ADR-0067). */
  effectRows?: () => Readonly<Record<string, EffectRow>>;
  /**
   * The Effect ledger's WRITE half (ADR-0067), in the same RunBlob as the snapshot. `"now"` (the
   * default) saves AT THE WRITE — so an intent row is on disk, with the snapshot that holds its
   * Effect, before the call leaves. `"with-transition"` is for a row written INSIDE a transition (an
   * abort, D1): it is kept in memory for the save that carries that transition — a save now would
   * read the Machine before its route — and saved after the transition if nothing else saves it.
   * Optional: a bare binding keeps no ledger, and nothing it runs is durable.
   */
  recordEffect?: (effectId: string, row: EffectRow, save?: "now" | "with-transition") => void;
  /**
   * iid → the abort still in flight for it (ADR-0024). The Agent's Actor fills this on the way out and
   * waits on it before admitting, so an abort can never overtake the next turn on the same
   * instance — flue QUEUES per instance, and an abort that lost that race would settle the new
   * submission before it ran. Created on demand: the ordering must hold for ANY binding, not only
   * one the host remembered to equip.
   */
  pendingAborts?: Map<string, Promise<void>>;
  /**
   * A named Chart of the run's own Workflow, by its short name (ADR-0070, D-C): what an Open body
   * whose input is `{ chart: { name } }` binds. The host resolves it among the Charts of the
   * wrapper that is the run's Workflow (`<wrapper>` of `<wrapper>/<name>`, or the Workflow itself),
   * and only for a body that wrapper invokes itself. Absent outside a RunHost: no name resolves.
   */
  chartNamed?: (name: string) => ChartText | undefined;
};

/** A conversation's latest outstanding pick, as the Agent's Actor reads it (ADR-0024). `answered`: the Machine
 * came back to Rest, or left the Agent's state (`turnComplete`); `fetched`: the answer reached the
 * model. */
export type OutstandingPick = {
  pick: string;
  answered: boolean;
  turnComplete: boolean;
  answer?: PickAnswer;
  fetched: boolean;
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

/**
 * ADR-0064's two feed lines per wait for capacity: a Workspace's Sandbox has no node — `placing`,
 * with the reason (`on`) and the scheduler's or the quota's own words — and then it has one —
 * `placed`, `after` milliseconds since `since`. A changed reason adds no line: `RunStatus.waiting`
 * carries the latest. `child` is the Workspace's actor path below the run root, its ids joined by
 * `/` (`""` for a run whose root IS the Workspace). Instance-token class like the Turn markers: the
 * message can name nodes and taints, so these ride the per-run feed alone.
 */
export type PlacingMarker =
  | { kind: "placing"; child: string; on: "node" | "quota"; message: string; since: string }
  | { kind: "placed"; child: string; since: string; after: number };

/**
 * A child below an Agent's state failed while a pick of that Agent was outstanding (ADR-0024): the
 * pick's answer carries no reply for it — the Agent is not told — so the operator reads it here: the
 * Agent, its pick, the child (its slot, or its invoke id) and the error's message. Instance-token
 * class like the Turn markers: an error message is mechanism text, as `fault` is.
 */
export type ChildErrorMarker = { kind: "child-error"; agent: string; pick: string; child: string; error: string };

/** Every marker a run's mechanism puts on its per-run feed — an Effect's lines among them
 * (ADR-0067): its start, its stream, its output, its abort. */
export type RunMarker = TurnMarker | PlacingMarker | ChildErrorMarker | EffectMarker;

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

/** The epoch of a continued conversation, or 0 outside a jr2 host (and for one nothing has
 * burned) — the SOFT read `jr2Setup`'s iid minting uses, beside {@link boundRunId}. */
export function boundEpoch(system: AnyActorSystem, conversation: string): number {
  return bindings.get(system)?.epochOf?.(conversation) ?? 0;
}

/** The bound run, or undefined outside a jr2 host — the SOFT read an Effect uses: with no host it
 * keeps no ledger and writes no feed, and still runs. */
export function boundRun(system: AnyActorSystem): RunBinding | undefined {
  return bindings.get(system);
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
