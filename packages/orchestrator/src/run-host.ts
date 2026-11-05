// The Machine host: runs an xstate Machine as a durable run and wires the three slice-1 modules
// together (ADR-0002/0007/0011). It is the integration seam the modules left open.
//
// Wiring (ADR-0011 registration table — no routing layer):
//   - The host owns ONE RegistrationTable and binds each run's actor system to it at track time;
//     `gate` and the Agent slots register their invocation's event surface there, with deliver
//     closures over their own `sendBack` — so delivery lands on the invoking state at any
//     nesting depth and the host routes nothing.
//   - Two thin surfaces sit on that table, and NEITHER is MCP (ADR-0013 — the Orchestrator does
//     not speak it): `agentSurface` / `sendToAgent` serve the Agent's Harness (`/agents/:iid/*`),
//     `gates` / `sendToGate` serve humans, webhooks and CI (`/runs/:id/gates/*`). Lookup,
//     validation, delivery and lifecycle stay implemented once, in the table.
//   - The run's Agent children report their durable admissions through the run binding into
//     the host LEDGER (`RunBlob.agents` — ADR-0016), persisted in the same save as the snapshot.
//     (the Harness wire = lifecycle; the agent surface = domain events.)
//
// Durability (ADR-0007): a snapshot is persisted after every transition. Live infrastructure (the
// wire-client-backed Agent slot) is injected via `.provide()` at start AND restore, never
// persisted — so the snapshot is JSON-safe and restore re-attaches by rewriting the child's
// persisted input (drop `prompt`, set `attach` from the ledger) rather than re-POSTing the prompt.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createActor,
  type AnyActor,
  type AnyActorLogic,
  type AnyActorRef,
  type AnyEventObject,
  type AnyMachineSnapshot,
  type AnyStateMachine,
} from "xstate";
import {
  SENDER_KEY,
  type EventDef,
  type EventSemantics,
  type Sender,
  type SenderCallerField,
} from "@jr2/agent-protocol";
import { partiesAt, seatOf, senderText } from "./party.ts";
import { GATE_ANSWERS_KEPT, type CallerRecord, type GateAnswer, type RunStarter } from "./callers.ts";
import { placeAnswers, type AnswerSeat } from "./pick.ts";
import { inputSchemaOf } from "./vocabulary.ts";
import type { EchoEvent, EchoStatusChild, LiveConversation, Notice, PickAnswer } from "./wire.ts";
import { answerOf, childErrorOf, replyOf, type Hold } from "./holds.ts";
import { PickCauses } from "./cause.ts";
import { restOf, runningBelow } from "./rest.ts";
import {
  acceptsNow,
  agentAddress,
  agentSlot,
  allowedPicks,
  bindRun,
  dispatchKeyOf,
  EventValidationError,
  gateAddress,
  NotTakenError,
  OutstandingError,
  RegistrationTable,
  refuseSenderField,
  slotPath,
  type SenderCaller,
  UnknownAddressError,
  wouldMove,
  targetsOf,
  leftAgain,
  type DispatchedBy,
  type DispatchStart,
  type Registration,
  type RetryTelemetry,
  type RunBinding,
  type RunMarker,
  type SourceVerdictLine,
} from "./registration.ts";
import { NoticeLedger, type LedgerBody, type NoticeLedgerState, type SteeringRecord } from "./notices.ts";
import { isAgent } from "./agent.ts";
import { pendingTimers, startAndRearm, watchTimers, type PendingTimer } from "./timers.ts";
import {
  DEFAULT_LEASE_INTERVAL_MS,
  WORKSPACE_WAIT_KEY,
  leaseDelay,
  workspaceName,
  type SandboxPort,
  type WorkspaceWait,
} from "./workspace.ts";
import { INSTANCE_HARNESS_SERVICE } from "./names.ts";
import { composesSandbox } from "./parts.ts";
import { failurePayload, isFailure, type FailureInput } from "./fail.ts";
import { unroutedMechanismEvent, type MicrostepView } from "./mechanism-routes.ts";
import { fingerprintOf } from "./fingerprint.ts";
import {
  serializeMachine,
  type ChildMachineDoc,
  type MachineBodyDoc,
  type MachineDoc,
  type MachineStateDoc,
} from "./machine-doc.ts";
import type { SnapshotStore, StandingHead } from "./snapshot-store.ts";
import { HAND_OVER, standingCarryOf, standingPoolOf, standingTaken, standingTook } from "./pool.ts";
import type { AgentAdmission } from "./actor.ts";
import type { AnyHandler } from "./gate.ts";
import { dropSavedTails, type EffectRow } from "./effect.ts";
import type { EffectorPlacement, EffectorTarget } from "./http-effect.ts";
import { reattachAgentRuns, serializeSnapshot } from "./durability.ts";
import { admitChart, chartBriefingOf, chartHash, ChartRefusal, isChartSchema, type ChartText } from "./chart.ts";
import type { ChartOrigin, NamedChart } from "./charts.ts";
import {
  admitBodyChart,
  admitWrapperChart,
  boundChartRoutesOf,
  chartWrapperMachineOf,
  boundMachineOf,
  compileChart,
  isOpenBody,
  lentIn,
  openBodiesOf,
  openBodyDeclarationOf,
  type BoundChartRoute,
} from "./open-body.ts";

/** The actors filled into a run's named slots — `.provide()` is the unit-test seam (ADR-0015);
 * production instances inject nothing. Built fresh at start and at restore. */
export type RunProviders = { actors?: Record<string, AnyActorLogic> };

/** A registered workflow: a template Machine plus how to fill its live slots for one run. */
export type WorkflowDef = {
  name: string;
  /** The template; slots (e.g. an Agent) are referenced by name and filled by `provide`. */
  machine: AnyStateMachine;
  /** Build this run's live providers. A test seam (ADR-0015): discovery injects nothing. */
  provide: (ctx: { instanceId: string }) => RunProviders;
  /**
   * The hash of the Assembly this Machine came from (ADR-0069): set at register for the current
   * Assembly, and by `resolveDef` for a held one at restore. A run holds the Assembly it started
   * under, so every save of the run stamps this hash. Absent only for a def that no Assembly
   * loaded: an in-process test host, which stamps nothing.
   */
  assembly?: string;
  /**
   * The def is a Chart wrapper (ADR-0070): `body` is its (first) Open body's slot key, and
   * `chartFields` are the door's fields that are `chartSchema` — empty for a wrapper whose Charts
   * only its own states supply. `register` reads both off the Machine when the caller leaves this
   * out.
   */
  wrapper?: { body: string; chartFields: string[] };
  /**
   * The def is a named Chart (ADR-0070): the Workflow `<wrapper>/<name>`, whose `machine` is its
   * wrapper's. A start supplies every Chart field of the wrapper's door from `text` and takes the
   * rest from the caller.
   */
  chart?: { wrapper: string; name: string; text: ChartText; hash: string; origin: ChartOrigin };
};

/**
 * One entry of `GET /workflows` (ADR-0070): a Workflow and where it came from. A Chart wrapper's
 * entry carries its Open body, whether its door takes a Chart (`oneShot`), and its named Charts.
 */
export type WorkflowListing = {
  name: string;
  origin: "machine" | ChartOrigin;
  wrapper?: {
    body: string;
    oneShot: boolean;
    charts: Array<{ name: string; origin: ChartOrigin; unrunnable?: string }>;
  };
  unrunnable?: string;
};

/** What makes a Machine a Chart wrapper (ADR-0070), read off it: its first Open body's slot key and
 * the door's fields that are `chartSchema`. The bodies are seen through jr2's transparent wrappers
 * (a Chart wrapper that is a `workspace()`'s body), and the door is the registered Machine's.
 * Undefined for a Machine with no Open body. */
function wrapperOf(machine: AnyStateMachine): WorkflowDef["wrapper"] | undefined {
  const bodies = openBodiesOf(chartWrapperMachineOf(machine).machine);
  if (!bodies.length) return undefined;
  const shape = (inputSchemaOf(machine)?.shape ?? {}) as Record<string, unknown>;
  return { body: bodies[0]!.slot, chartFields: Object.keys(shape).filter((k) => isChartSchema(shape[k])) };
}

/** A pick one of whose parameters is a Chart (by schema identity, ADR-0070) is marked with that
 * grammar's briefing, for the Turn part. */
function briefingOf(input: z.ZodObject): { briefing?: string } {
  const shape = input.shape as Record<string, unknown>;
  for (const key of Object.keys(shape)) {
    const briefing = chartBriefingOf(shape[key]);
    if (briefing !== undefined) return { briefing };
  }
  return {};
}

/** The short wrapper name of a Workflow name: `<wrapper>` of `<wrapper>/<name>`, else the name. */
function wrapperName(workflow: string): string {
  const at = workflow.indexOf("/");
  return at > 0 ? workflow.slice(0, at) : workflow;
}

/**
 * Why a run's bound Charts no longer read under `machine` (ADR-0070, D-B), or undefined when each
 * does: every bound Chart is admitted again against the Open body slot it binds, resolved on the
 * Machine through `implementations.actors` (a lent child Machine's own slots included), with the
 * lent set that Machine has now. A text whose hash does not match is drift too: a hand-edited
 * volume.
 */
function chartDrift(machine: AnyStateMachine, routes: readonly BoundChartRoute[]): string | undefined {
  for (const route of routes) {
    const where = `chart "${route.path.join("/")}" under body "${route.src}"`;
    let at: AnyStateMachine = machine;
    let resolved = true;
    for (const src of route.srcs.slice(0, -1)) {
      const logic = (at.implementations.actors as Record<string, unknown>)[src];
      // The lent parts a bound body's Chart invokes are its wrapper's: the next hop is resolved there.
      if (isOpenBody(logic)) continue;
      const child = (logic as AnyStateMachine | undefined)?.root ? (logic as AnyStateMachine) : undefined;
      if (!child) {
        resolved = false;
        break;
      }
      at = child;
    }
    const logic = resolved ? (at.implementations.actors as Record<string, unknown>)[route.src] : undefined;
    if (!isOpenBody(logic)) return `${where}: the Machine has no Open body "${route.src}" now`;
    const hash = chartHash(route.chart);
    if (hash !== route.chartHash) {
      return `${where}: its hash ${route.chartHash} does not match its text (${hash}); the stored run was edited`;
    }
    const decl = openBodyDeclarationOf(logic);
    try {
      admitBodyChart(route.chart, decl, lentIn(at.implementations as never, decl));
    } catch (err) {
      if (!(err instanceof ChartRefusal)) throw err;
      return `${where}: ${err.report.join("; ")}`;
    }
  }
  return undefined;
}

/** The serializable identity of a run — what reconcile sees and what restore rebuilds from.
 * `dispatchedBy` is the run that started it through a `dispatch` Effect, and this run's depth in
 * that chain, as the caller sent it (ADR-0071); absent for a run a human or a client started.
 * `startedBy` is who started it (ADR-0078): a Caller, a run, or jr2. Behind the token, like
 * `context`: {@link observe} never carries it. Absent for a run that a host started with no
 * starter, as a test does. */
export type RunRecord = {
  runId: string;
  workflow: string;
  instanceId: string;
  dispatchedBy?: DispatchedBy;
  startedBy?: RunStarter;
  /** The Caller whose `jr2 run` resumed this standing run (ADR-0017, ADR-0078). */
  resumedBy?: CallerRecord;
};

/** A start of a name no Workflow is registered under: the door answers 404 (ADR-0009), and an
 * in-process `dispatch` settles `refused` with status 404 (ADR-0071). */
export class UnknownWorkflowError extends Error {
  override name = "UnknownWorkflowError";
}

/** The run a key names (ADR-0071). The key is scoped to the callee Workflow, so the run is always
 * of the Workflow that was asked. */
export type DispatchedRun = { runId: string; instanceId: string };

/**
 * One live child MACHINE of a run, and its own children below it. A workflow's root machine is
 * usually a coordinator — `coding` spawns a `featureWorkspace` per feature and the real work happens
 * in there — so the root's `value` alone says almost nothing about where a run IS. This is the rest.
 *
 * Context-free BY CONSTRUCTION: there is no context field to forget to redact, which is what lets
 * `observe()` pass the whole tree through to unauthenticated observers untouched. `src` is the join
 * key ({@link ChildMachineDoc}); `id` is the spawn id (`"F-1"`), which is how two live instances of
 * the same child machine are told apart.
 */
export type RunChild = { id: string; src: string; status: string; value: unknown; children: RunChild[] };

/**
 * The child-machine tree under a snapshot, in the TWO shapes it arrives in: a live actor's
 * `children` are actorRefs (`status()`), a persisted snapshot's are `{src, snapshot}` records
 * (`read()`, off the store). Both carry `src`, so one walk serves both.
 *
 * Machine actors only — a promise/callback/observable child has no state `value`, so there is
 * nothing to light up and nothing to nest.
 */
function runChildren(snapshot: unknown): RunChild[] {
  const children = (snapshot as { children?: Record<string, unknown> } | undefined)?.children ?? {};
  const out: RunChild[] = [];
  for (const [id, entry] of Object.entries(children)) {
    const child = entry as { src?: unknown; snapshot?: unknown; getSnapshot?: () => unknown };
    const snap = (typeof child.getSnapshot === "function" ? child.getSnapshot() : child.snapshot) as
      | { status?: string; value?: unknown }
      | undefined;
    if (snap?.value === undefined) continue;
    out.push({
      id,
      src: typeof child.src === "string" ? child.src : "",
      status: snap.status ?? "active",
      value: snap.value,
      children: runChildren(snap),
    });
  }
  return out;
}

/**
 * One Workspace of a run waiting for capacity (ADR-0064): its Sandbox has no node. `child` is the
 * Workspace's actor path below the run root — the {@link RunChild} ids down to it, joined by `/`,
 * and `""` when the run's root IS the Workspace. `on` is what it waits for: a node from the
 * scheduler, or room under the cluster owner's quota; `message` is the scheduler's or the API
 * server's own words; `since` (ISO) is when the wait began, kept across a changed reason and a
 * restart.
 */
export type RunWaiting = { child: string; on: "node" | "quota"; message: string; since: string };

/**
 * Every Workspace in `placing` with a reason, at any depth, read off the snapshot tree in the two
 * shapes {@link runChildren} walks — the wait rides each Workspace's own persisted context, so a
 * restored run reports it before its watch has said a word. A live child is held to being a
 * `workspace()` by its logic; a persisted one has none, and the state key and the context's shape
 * are the test. Only an ACTIVE run and an active Workspace wait: a run that ended — faulted,
 * cancelled, done — has deleted what never ran, so a `placing` left in its snapshot waits for nothing.
 */
function runWaiting(snapshot: unknown, logic?: unknown, path: string[] = []): RunWaiting[] {
  const out: RunWaiting[] = [];
  const snap = snapshot as { status?: unknown; value?: unknown; context?: Record<string, unknown> } | undefined;
  if (snap?.status !== undefined && snap.status !== "active") return out;
  const wait = snap?.context?.[WORKSPACE_WAIT_KEY] as WorkspaceWait | undefined;
  const isWorkspace = logic == null || composesSandbox(logic as AnyStateMachine);
  if (isWorkspace && snap?.value === "placing" && (wait?.on === "node" || wait?.on === "quota")) {
    out.push({ child: path.join("/"), on: wait.on, message: String(wait.message), since: String(wait.since) });
  }
  const children = (snapshot as { children?: Record<string, unknown> } | undefined)?.children ?? {};
  for (const [id, entry] of Object.entries(children)) {
    const child = entry as { snapshot?: unknown; getSnapshot?: () => unknown; logic?: unknown };
    const live = typeof child.getSnapshot === "function";
    const childSnap = live ? child.getSnapshot!() : child.snapshot;
    if ((childSnap as { value?: unknown } | undefined)?.value === undefined) continue;
    out.push(...runWaiting(childSnap, live ? child.logic : undefined, [...path, id]));
  }
  return out;
}

/**
 * The Sandbox of every live Workspace under `actor`, at any depth, by CR name — what a cancel
 * destroys (ADR-0025). Read off the run's own live actor tree: each Workspace holds its `wsId` in
 * context, and the name is a function of the run and that id, the same one its `teardown` deletes.
 * Correct after a restart by construction: `restore()` rebuilds this tree from the persisted
 * snapshot, so a restored run names its Sandboxes before its watch has listed. The Sandbox watch's
 * set, filtered by the run's label, is not: before the watch has listed it holds nothing, and
 * unknown is never absent (ADR-0063).
 *
 * Left out: a Workspace in `placing`, which deletes its own Sandbox when its wait is aborted — and
 * only once any write in flight has settled, so a delete from here could race the apply and leave
 * the CR behind (ADR-0064); and one that is `done` or ended, whose `teardown` or `failing` already
 * ran. An actor that ended in `error` is not a Workspace here, but its children are read: a failed
 * run's root (ADR-0073) is in `error`, and its active children are still in its snapshot, as
 * `stopTree` reads them.
 *
 * With `placing`, a Workspace in `placing` is also named: the names that a live Workspace holds
 * now, which a delete must leave alone.
 */
function runSandboxes(actor: AnyActorRef, runId: string, opts: { placing?: boolean } = {}): string[] {
  const out: string[] = [];
  const snap = actor.getSnapshot() as
    | { status?: string; value?: unknown; context?: { wsId?: unknown }; children?: Record<string, AnyActorRef> }
    | undefined;
  if (snap?.status !== "active" && snap?.status !== "error") return out;
  const logic = (actor as AnyActorRef & { logic?: unknown }).logic;
  if (
    snap.status === "active" &&
    logic != null &&
    composesSandbox(logic as AnyStateMachine) &&
    (opts.placing === true || snap.value !== "placing") &&
    typeof snap.context?.wsId === "string"
  ) {
    out.push(workspaceName(runId, snap.context.wsId));
  }
  for (const child of Object.values(snap.children ?? {})) out.push(...runSandboxes(child, runId, opts));
  return out;
}

/** One Agent slot of a live run (ADR-0002), as `GET /runs/:runId/agents` lists it: `agent` is the
 * slot (`<machine path>/<agent name>`), `open` says that a Turn of it is open now, and `steerable`
 * that a Caller may send it a Steering message. */
export type RunAgent = { agent: string; open: boolean; steerable: boolean };

/** The `steering` field of a status: the record, when the run got a message. */
function steeringOf(record: readonly SteeringRecord[]): { steering?: SteeringRecord[] } {
  return record.length > 0 ? { steering: record.map((r) => ({ ...r })) } : {};
}

/** Is this actor a Machine (not a promise, a callback, or an Agent)? */
function isMachineActor(ref: AnyActorRef): boolean {
  const logic = (ref as { logic?: unknown }).logic;
  return typeof logic === "object" && logic !== null && "root" in logic;
}

/**
 * Every Agent slot of every live Machine instance under `actor`, at any depth (ADR-0002): the
 * Agents that each Machine carries in its `actors`, by the slot their Turns are registered with
 * (`agentSlot`). A Machine that is not active holds none: it can take no Turn.
 */
function liveSlots(actor: AnyActorRef): Array<{ agent: string; steerable: boolean }> {
  const out: Array<{ agent: string; steerable: boolean }> = [];
  const walk = (ref: AnyActorRef): void => {
    const snap = ref.getSnapshot() as { status?: string; children?: Record<string, AnyActorRef> } | undefined;
    if (snap?.status !== "active") return;
    if (isMachineActor(ref)) {
      const actors = ((ref as { logic?: AnyStateMachine }).logic?.implementations.actors ?? {}) as Record<
        string,
        unknown
      >;
      for (const [name, logic] of Object.entries(actors)) {
        if (isAgent(logic)) out.push({ agent: agentSlot(ref, name), steerable: logic.definition.steerable !== false });
      }
    }
    for (const child of Object.values(snap.children ?? {})) if (child) walk(child);
  };
  walk(actor);
  return out;
}

/** Why `POST /runs/:runId/steering` refuses a message (ADR-0002): `status` is the HTTP status, and
 * `agents` the run's slots when the slot named none of them. */
export class SteeringRefused extends Error {
  readonly status: 403 | 409;
  readonly agents?: RunAgent[];
  constructor(message: string, status: 403 | 409, agents?: RunAgent[]) {
    super(message);
    this.status = status;
    if (agents !== undefined) this.agents = agents;
  }
}

/**
 * Stop every actor under `actor`, at any depth, deepest first. A machine that ended in `error` has
 * stopped processing — its own stop is a no-op — so its children are reached through its snapshot
 * rather than asked to stop through it.
 */
function stopTree(actor: AnyActorRef): void {
  const children = (actor.getSnapshot() as { children?: Record<string, AnyActorRef> } | undefined)?.children ?? {};
  for (const child of Object.values(children)) {
    stopTree(child);
    // `_stop` is what xstate's own `stopChild` calls: a child cannot be stopped through `stop()`.
    (child as AnyActorRef & { _stop?: () => void })._stop?.();
  }
}

/** One outstanding pick, as `RunStatus.held` reports it: the Agent slot, its pick, and the ISO time
 * it was delivered. */
export type RunHeld = { agent: string; pick: string; since: string };

/** The pick being delivered now (ADR-0024): its registration, every reply from below its Agent's
 * state inside its own send, and what an `answer` action set there (ADR-0067). */
type Sending = {
  reg: Registration;
  pick: string;
  chain: PickAnswer[];
  shaped?: { value: unknown };
};

/**
 * Whose pick started a child (ADR-0067): the Agent's slot, and the invoke id of the Agent's state the
 * pick was made at, which tells apart two states that invoke one slot, one after the other. `invoke` is absent when the event that
 * started the child named the Agent and not where (a pick taken outside its own send).
 */
type ChildAgent = { agent: string; invoke?: string };

/**
 * The key of the child `childId` of `parent` in the run's record of which Agent started each child
 * (`childAgents`, ADR-0067): the invoke ids from below the root down to `parent`, then `childId`, each
 * encoded and joined by `/`. An invoke id is local to its Machine — two Machines of one tree, and
 * every worker of a pool, may each have a child `job` — and the chain is not. A child of the root
 * keeps its bare id. The ids are the snapshot's, so a restore gives the same key.
 */
function childKey(parent: AnyActorRef, childId: string): string {
  const ids = [childId];
  for (let at: AnyActorRef | undefined = parent; at?._parent !== undefined; at = at._parent) ids.unshift(at.id);
  return ids.map(encodeURIComponent).join("/");
}

/**
 * The Agent whose event `event` is, as `taker` takes it (ADR-0024, ADR-0067): a pick's sender, or
 * the Agent whose pick started the child of `taker` whose done or error event it is (`childAgents`).
 * Undefined when the event names no Agent: a timer, a Gate's answer, an outside send, a child no
 * Agent's pick started. `sending`'s invoke is where a pick in its own send was made.
 */
function agentOfEvent(
  event: AnyEventObject,
  childAgents: Record<string, ChildAgent>,
  taker: AnyActorRef,
  sending?: Sending,
): ChildAgent | undefined {
  const sender = (event as { [SENDER_KEY]?: Sender })[SENDER_KEY];
  if (sender?.party === "agent") {
    const invoke = sending?.reg.sender?.id === sender.id ? sending.reg.invokeId : undefined;
    return invoke !== undefined ? { agent: sender.id, invoke } : { agent: sender.id };
  }
  const child = /^xstate\.(?:done|error)\.actor\.(.+)$/.exec(event.type)?.[1];
  if (child === undefined) return undefined;
  const key = childKey(taker, child);
  return Object.hasOwn(childAgents, key) ? childAgents[key] : undefined;
}

/** How many of `snapshot`'s active states invoke an Agent. With two or more, an event that names no
 * Agent cannot say whose pick an `answer` below no Agent's state shapes (ADR-0024). */
function activeAgentStates(snapshot: AnyMachineSnapshot): number {
  const machine = snapshot.machine as AnyStateMachine;
  const active = (snapshot as { _nodes?: AnyStateMachine["root"][] })._nodes ?? [];
  return active.filter((node) => partiesAt(node, machine).some((party) => party.party === "agent")).length;
}

/** The `childKey` of every child in `actor`'s tree, at any depth. */
function liveChildKeys(actor: AnyActorRef, into = new Set<string>()): Set<string> {
  const children = (actor.getSnapshot() as { children?: Record<string, AnyActorRef> } | undefined)?.children ?? {};
  for (const child of Object.values(children)) {
    if (!child) continue;
    into.add(childKey(actor, child.id));
    liveChildKeys(child, into);
  }
  return into;
}

/** `childAgents` as the save keeps it: only children still in the run's tree (ADR-0067). Read at the
 * save, a microtask after the snapshot, so a done event the Machine took has run its route. */
function liveChildAgents(childAgents: Record<string, ChildAgent>, actor: AnyActorRef): Record<string, ChildAgent> {
  const live = liveChildKeys(actor);
  for (const id of Object.keys(childAgents)) if (!live.has(id)) delete childAgents[id];
  return childAgents;
}

/** An `answer` action's value as the hold keeps it: JSON, because it rides the run blob and the
 * wire (ADR-0067). `undefined`, or a value with no JSON form, sets no answer — the default stands. */
function jsonOf(value: unknown): { value: unknown } | undefined {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/** The outstanding picks among a run's holds. */
function heldOf(holds: Iterable<Hold>): RunHeld[] {
  return [...holds]
    .filter((hold) => hold.answer === undefined)
    .map((hold) => ({ agent: hold.agent, pick: hold.pick, since: hold.since }));
}

/** The Caller of a Gate's event as its Sender carries it (ADR-0011): `via` and `name` are always
 * checked, because an authenticator made them; `onBehalfOf` only for a Hook, whose signature covers
 * the payload that it comes from. */
function senderCallerOf(by: CallerRecord): SenderCaller {
  const checked: SenderCallerField[] = ["via", "name"];
  if (by.via === "hook" && by.onBehalfOf !== undefined) checked.push("onBehalfOf");
  return {
    via: by.via,
    name: by.name,
    ...(by.onBehalfOf !== undefined ? { onBehalfOf: by.onBehalfOf } : {}),
    checked,
  };
}

/** What a Hook's fan-in did (ADR-0011): the Gates that took the delivery, the ones that did not and
 * why, and how many open Gates of its kind and key gave nothing. */
export type HookFanIn = {
  delivered: Array<{ run: string; workflow: string; gate: string; event: string }>;
  refused: Array<{ run: string; gate: string; event?: string; reason: string }>;
  ignored: number;
  /** Each Source's verdict (ADR-0017), one line for each Pool whose Source hears the kind and key. */
  sources: SourceLine[];
  /** The standing Workflows whose Source hears the kind and key, and that have no live run and are
   * not paused (ADR-0017): a hand-over waits out its back-off. The door answers 503. */
  waiting?: string[];
  /** For a delivery whose answer a person reads: the `reply` of each target that has one, in the
   * order of the fan-out (ADR-0011). The door joins them; it never puts them in the outcome. */
  replies?: HookReply[];
};

/**
 * What one target's `reply` gave (ADR-0011): its place in the join (a Source or a Gate, its
 * Workflow and its run), and its text, or the error of a `reply` that threw or gave no text. A
 * `skipped` Source's text shows only when no other target gave one.
 */
export type HookReply = {
  target: "source" | "gate";
  workflow: string;
  run: string;
  /** The Gate's id, or the Pool's `source` Gate's id. */
  gate: string;
  text?: string;
  skipped?: true;
  error?: string;
};

/** Run one `reply`: plain text, or nothing, or the error that the hook log keeps. */
function runReply(place: Omit<HookReply, "text" | "error">, run: () => unknown): HookReply {
  let given: unknown;
  try {
    given = run();
  } catch (err) {
    return { ...place, error: `its reply threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (given === undefined || given === "") return place;
  if (typeof given !== "string") return { ...place, error: `its reply gave ${typeof given}, not text` };
  return { ...place, text: given };
}

/** One Source's verdict on one delivery (ADR-0017): the Pool's run, its Workflow, the `source`
 * Gate's id, and the verdict. */
export type SourceLine = { pool: string; workflow: string; source: string } & SourceVerdictLine;

/** A run's current observable state. `fault` carries the error message when status is "error"
 * (e.g. a gate invoked with a name outside the workflow's manifest — ADR-0011). A run that ends
 * "failed" (ADR-0073) has no `fault`: its `output` is the Failure's `{ reason, detail? }`. */
export type RunStatus = RunRecord & {
  status: string;
  value: unknown;
  context: unknown;
  /** The live child machines beneath the root — where most of a run actually is. */
  children: RunChild[];
  /** Every Workspace waiting for capacity, and why (ADR-0064). Behind the token: the reason is
   * the scheduler's or the quota's own words, which can name nodes and taints, so {@link observe}
   * never carries it — the open band sees only that a Workspace is in `placing`. */
  waiting: RunWaiting[];
  /** Every pick of this run that is outstanding (ADR-0024): the Agent, its pick, and since when —
   * the Console's "held since". There is no default time bound on a held Turn; this is how a
   * human sees one. Behind the token, like `context`: a pick names what the Agent did. */
  held: RunHeld[];
  fault?: string;
  /**
   * Why the HOST set this status, for the statuses the Machine did not choose — today `drifted`
   * (ADR-0030). Distinct from `fault`, which is a running actor's own error; this is the store's
   * account of a run it declined to resume, and until it was surfaced here nothing on any HTTP
   * route could read it.
   */
  reason?: string;
  /** The hash of the Assembly the run started under (ADR-0069). Absent for a run no Assembly
   * started. */
  assembly?: string;
  /** The run binds at least one Chart (ADR-0070): its Machine is the bound one, `runMachine`. */
  bound?: true;
  /** The hashes of the Charts the run binds now, distinct and sorted (ADR-0070). A run can bind a
   * second Chart in its life (a planner whose first Chart reaches a ceiling picks again), so these,
   * not the run id, say which bound Machine `runMachine` draws. Absent when it binds none. */
  chartHashes?: string[];
  /**
   * The Machine's output, for a run that is no longer live (ADR-0071): what a `dispatch` with
   * `wait` settles with, and what `GET /runs/<id>` serves its foreign caller. Never for a live run,
   * whose Machine has none yet. For a `failed` run, the Failure's `{ reason, detail? }` (ADR-0073),
   * not a value of the Machine's output type. Behind the token, like `context`: it is the
   * workflow's data.
   */
  output?: unknown;
  /** The runs this run's `dispatch` Effects started, oldest first (ADR-0071): the chain's other
   * direction, read off the caller's own ledger rows. A foreign dispatch's run is a run of the
   * Orchestrator its target names. Absent when it started none. */
  dispatched?: Dispatched[];
  /** The Caller that cancelled the run (ADR-0078). Behind the token: {@link observe} never
   * carries it. */
  cancelledBy?: CallerRecord;
  /** The run that took over from this standing run (ADR-0017): a hand-over ends the run `done`. */
  handedOverTo?: string;
  /** The answers to the run's Gates, oldest first, each with the Caller that gave it (ADR-0011,
   * ADR-0078): the last {@link GATE_ANSWERS_KEPT}. An event that a Gate's `look` gives is not an
   * answer, and is not here. Behind the token. Absent when no Gate was answered. */
  answers?: GateAnswer[];
  /** The run's Steering messages, oldest first (ADR-0002): each one's Agent slot, author, text,
   * time and outcome — the newest 100, and each one still held. Behind the token, like `context`.
   * Absent when the run got none. */
  steering?: SteeringRecord[];
  /** The Worktrees this run's cuts made, oldest first (ADR-0075), read off its ledger's settled
   * `ready` rows, so an Agent's `git switch` does not change them. A re-cut of one path and branch
   * is one entry. Behind the token, like `context`: a branch name is the workflow's data. Absent
   * when the run cut none. */
  worktrees?: RunWorktree[];
};

/** One Worktree a `worktree()` Effect of this run cut (ADR-0075): its Repo Slot, its path, and the
 * branch of the cut. `branch` is `null` for a detached Worktree. */
export type RunWorktree = { slot: string; path: string; branch: string | null };

/** One run a `dispatch` Effect of this run started (ADR-0071): its slot, the run, and when the
 * ledger row was written. */
export type Dispatched = { slot: string; run: string; at: string };

/**
 * A run as an UNAUTHENTICATED observer may see it: which run, of what workflow, and where in the
 * Machine it is. That is the whole set — enough to light up a state in the Console, and nothing
 * more.
 *
 * What is absent is the point. `context` is the workflow's working data (branch names, ticket
 * bodies, review verdicts, Harness endpoints) and `instanceId`/`fault` name live infrastructure and
 * leak error text; all of it is STATE, which ADR-0013 guards behind the Instance token. `value` is
 * a tree of state KEYS — it is structure, and structure is already public (`/workflows/:name/machine`
 * serves the whole Machine). So an observer learns nothing here it could not read from the Machine
 * doc, except which states are lit.
 *
 * `children` extends that to the child machines (which is where a run mostly lives), and it does NOT
 * widen the line: a {@link RunChild} is keys and ids by construction, with no context field at any
 * depth. The one thing it adds is the spawn ids, which are the workflow's own labels for its
 * parallel work (`"F-1"`) — the same class of thing as a state key.
 */
export type RunObservation = {
  runId: string;
  workflow: string;
  status: string;
  value: unknown;
  children: RunChild[];
  /** The run binds a Chart (ADR-0070): the Console draws `GET /workflows/:name/runs/:runId/machine`.
   * Structure, like `value`. */
  bound?: true;
  /** The hashes of the Charts it binds now (see {@link RunStatus.chartHashes}). Structure: a hash
   * of a Chart's text, which `runMachine` already serves on the open band. */
  chartHashes?: string[];
  /** The run that dispatched this one, its slot, and the chain's depth (ADR-0071). Routing — two
   * ids, a slot name and a number — the class of thing `runId` and `value` are, so ADR-0014's line
   * is unmoved. The idempotency key is not: it names the caller's ledger, which is the caller's. */
  dispatchedBy?: Omit<DispatchedBy, "effect" | "key" | "hook">;
  /** The runs it dispatched, by slot (ADR-0071): the same routing as `dispatchedBy`, the other
   * direction. */
  dispatched?: Array<{ slot: string; run: string }>;
};

/** Project a full status down to what an observer may see. The one place the line is drawn. */
export function observe(status: RunStatus): RunObservation {
  return {
    runId: status.runId,
    workflow: status.workflow,
    status: status.status,
    value: status.value,
    children: status.children,
    ...(status.bound ? { bound: true as const } : {}),
    ...(status.chartHashes ? { chartHashes: status.chartHashes } : {}),
    ...(status.dispatchedBy ? { dispatchedBy: routingOf(status.dispatchedBy) } : {}),
    ...(status.dispatched ? { dispatched: status.dispatched.map(({ slot, run }) => ({ slot, run })) } : {}),
  };
}

/** A {@link DispatchedBy} without its idempotency key (ADR-0071): what the open band carries. */
function routingOf(by: DispatchedBy): Omit<DispatchedBy, "effect" | "key" | "hook"> {
  // The key names the caller's ledger, or a Pool's item, and the Hook delivery is the workflow's
  // data: neither is routing (ADR-0014, ADR-0017).
  const { effect: _effect, key: _key, hook: _hook, ...routing } = by;
  return routing;
}

/** An Agent registration's Menu (ADR-0029): the one it registered, or — registered with none, by a
 * plain `setup()` machine — its derived set. */
function menuOf(reg: Registration): Map<string, EventDef> {
  return reg.menu ?? reg.defs;
}

/** The invoking Machine's state value, as one comparable string; undefined when it cannot be read. */
function stateValueOf(invoker: AnyActorRef | undefined): string | undefined {
  try {
    return invoker ? JSON.stringify(invoker.getSnapshot().value) : undefined;
  } catch {
    return undefined;
  }
}

/** The Allowed picks (ADR-0029), as the Agent's nudge and wake read them too. */
function allowedOf(reg: Registration): string[] {
  return allowedPicks(reg);
}

/** One open gate as external callers discover it (`GET /runs/:id` — ADR-0011): the accepted
 * events with their input schemas as JSON Schema (what drives a form or a `jr2 send` prompt),
 * plus the workflow-supplied `meta` (what a UI renders and a webhook translator matches on). */
export type GateView = {
  gate: string;
  /** The invoking state's actor path below the run root — where the gate lives in the Machine
   * (what the Console's "parked here" pin resolves against its scope tree), stable whether the
   * id was authored ("F-12") or derived. Never parse `gate` for this. */
  path: string[];
  accepts: Array<{ name: string; description?: string; input: unknown }>;
  /** The names of `accepts` the run would take from this Gate NOW, payload-blind (ADR-0011,
   * ADR-0029): a send of another name is refused 409. `accepts` stays whole — it drives the forms. */
  acceptsNow: string[];
  meta?: Record<string, unknown>;
};

/** One event on an Agent's Menu, as the surface serves it: a tool, its `input` schema the tool's
 * parameters. `semantics` rides along so the Harness refuses a reserved one (ADR-0013). */
/** One pick on the surface. `briefing` marks a pick whose parameter is a Chart: jr2's text on how a
 * Chart runs (`CHART_BRIEFING`, ADR-0070), which the Harness says in the Turn part when the pick is
 * Allowed, so only the Turns that may write a Chart carry it. */
export type SurfaceEvent = {
  name: string;
  description?: string;
  input: unknown;
  semantics: EventSemantics;
  briefing?: string;
};

/**
 * One live agent surface, as the Harness reads it through its Custodian (`GET /agents/:iid/surface`
 * — ADR-0013, ADR-0029). Two answers, because they change at different rates:
 *
 *   - `menu` is the Agent's MENU — every pick any state invoking this Agent offers, in a fixed
 *     order. The Harness presents it as the tools block, which is then byte-identical for every
 *     Turn of the conversation and never breaks the provider's prompt cache.
 *   - `allowed` is this Turn's ALLOWED PICKS — the invoking state's derived set, narrowed to what its
 *     guards would accept now, in Menu order. The Harness states it in the Briefing's Turn part,
 *     after the Frame's prompt (ADR-0062). Enforced at delivery, not here.
 *
 * `sandbox` is the Sandbox that may deliver here. It is not a secret from that pod (the pod IS the
 * sandbox), and serving it lets a caller fail loudly on a surface that is not its own.
 */
export type AgentSurfaceView = {
  instanceId: string;
  runId: string;
  sandbox?: string;
  /** The slot this surface belongs to (ADR-0076): its Agent's actor path and agent name — the slot
   * the Harness must state to speak here. Absent on a registration no pod hosts. */
  slot?: string;
  menu: SurfaceEvent[];
  allowed: string[];
};

/**
 * The answer to one Agent delivery (`POST /agents/:iid/events`) — a receipt that DESCRIBES ITSELF
 * (ADR-0024). The Harness renders it as prose, because a bare `deliveryId` told the Agent nothing
 * about whether it was finished, and the model answered that silence by calling again.
 *
 * `turnComplete` is the HINT, never the guarantee (the abort on invocation end is): it is read off
 * the registration table right after delivery, so it says whether the state that asked for this
 * turn has stopped waiting. It fails conservatively — anything that made the read unreliable reads
 * `false`, which is today's behavior, never a false claim.
 *
 * `deliveryId` keeps the outcome ADDRESSABLE after the fact (ADR-0013): a pick the workflow is still
 * running when the POST answers is OUTSTANDING (`outstanding: true`), and its answer is read at
 * `GET /agents/:iid/deliveries/:id` — the same shape, `answered: true`, once the workflow is back at
 * Rest in the Agent's state or has left it (ADR-0024).
 */
export type AgentDeliveryReceipt = {
  /** The workflow is running the pick: the answer comes on the delivery's poll. `allowed` is empty:
   * no other pick is taken until it answers. */
  outstanding?: true;
  /** ISO time the pick was delivered — with `outstanding`. */
  since?: string;
  /** This receipt is a pick's answer, read at Rest (or once the Turn left the Agent's state): an outstanding
   * pick's, a reply inside the pick's own send, or a guard straight back with no reply. */
  answered?: true;
  /** With `answered`: a guard straight back (ADR-0024) — the pick entered a state below the Agent's
   * and came back inside its own send, nothing replying. The one answer that says "moved; nothing
   * ran"; an outstanding pick's answer never carries it. */
  straightBack?: true;
  /** The last reply since the pick (ADR-0024); absent with `answered`: no reply came. */
  answer?: PickAnswer;
  /** With `answered` and `turnComplete`: something other than the pick's route left the Agent's
   * state while the pick's work ran, and that exit stopped the work before it finished. `answer`,
   * if any, is an earlier link's reply, kept (ADR-0024). */
  stopped?: true;
  delivered: true;
  /** The event delivered — the Agent reads its own pick back, by name. */
  event: string;
  /**
   * A transition accepted it. False means the pick was well-formed, arrived, and moved nothing —
   * every transition for it was guarded false in the current state (ADR-0029). Distinct from
   * {@link turnComplete}: a pick can move the Machine WITHIN the invoking state, which is
   * `moved: true, turnComplete: false`. Before this existed the two were indistinguishable, so an
   * Agent whose pick a guard rejected was told the workflow was "still in the state that asked",
   * and its only move was to call again.
   */
  moved: boolean;
  /** The invoking state stopped waiting: this Agent's turn is over. */
  turnComplete: boolean;
  /**
   * The Allowed picks read AFTER the delivery (ADR-0029): what this Turn may pick now — narrowed by
   * a pick that moved the Machine within the invoking state, empty once the Turn is over. The
   * Harness renders it ("Allowed now: `finish`"); it does not pre-check against it.
   */
  allowed: string[];
  deliveryId: string;
};

/**
 * One item on a run's observation feed (the `GET /runs/:id/events` SSE stream — ADR-0009). A
 * `status` snapshot delta (emitted on every transition, and replayed once on attach); an `emit` — a
 * message the workflow author surfaced via xstate `emit({...})` for whoever is watching; a Turn's
 * `admission`/`pick` markers (ADR-0023 — what the run-narrative echo projects for remotely-hosted
 * Turns); absorbed-retry telemetry; and `closed`, the host going away underneath a feed that would
 * never end. This feed is the Instance token's (http.ts); markers never reach ADR-0014's open band.
 */
export type RunFeedEvent =
  | { kind: "status"; status: RunStatus }
  | { kind: "emit"; event: { type: string } & Record<string, unknown> }
  | RunMarker
  // Absorbed-retry telemetry (ADR-0016): `{ child, attempt }` is state-key-class data — no iids
  // ride the feed (ADR-0014). `reason` is mechanism text, guarded like `fault`.
  | RetryTelemetry
  | { kind: "closed" };

/**
 * The feed-so-far cap. The buffer exists so a Workspace attaching mid-run can open its log with
 * the run's preamble (ADR-0023); a run long enough to blow past it loses its OLDEST markers and
 * Emits, which is the same trade kubelet's log rotation already makes on the printed side — the
 * feed remains the record, the buffer serves a courtesy view. Statuses do not count against it:
 * the buffer keeps only the latest (a status is a level — ADR-0023).
 */
const FEED_SO_FAR_CAP = 1000;

/** Project one feed event for the echo at `target` (ADR-0023), or nothing: markers of Turns
 * hosted AT the target are dropped (the transcript prints there — markers, not mirrors), a status
 * sheds everything but where the run stands, and retries/`closed` are mechanism, not narrative. */
function echoEventOf(event: RunFeedEvent, target: string): EchoEvent | undefined {
  if (event.kind === "status") {
    const children = echoChildrenOf(event.status.children);
    return {
      kind: "status",
      status: event.status.status,
      value: event.status.value,
      ...(children.length ? { children } : {}),
    };
  }
  if (event.kind === "emit") return { kind: "emit", event: event.event };
  if (event.kind === "admission" && event.endpoint !== target) {
    return { kind: "admission", agent: event.agent, prompt: event.prompt };
  }
  if (event.kind === "pick" && event.endpoint !== target) {
    const { agent, payload } = event;
    return { kind: "pick", agent, event: event.event, ...(payload ? { payload } : {}) };
  }
  return undefined;
}

/**
 * The echo's outbox (ADR-0023): one push in flight per attachment, and whatever the feed produces
 * meanwhile rides the NEXT push, together — a burst of transitions costs the Harness one push per
 * flush, not one per transition.
 *
 * A status is a level, so a pending status is REPLACED by a newer one, never queued behind it. The
 * ordering rule, exactly: markers and Emits keep feed order among themselves, and the one pending
 * status sits where the NEWEST status arrived — after every marker and Emit fed before it, before
 * every one fed after it. A superseded status drops out; nothing else moves. So a Harness that
 * answers slowly holds at most one status plus the markers since its last push.
 *
 * A status the same as the last one pushed is dropped, with the pending one: the feed sends a
 * status on each inspection event, and an Agent actor's own transitions move nothing that the echo
 * shows, so without this each line of the log would print two times or more.
 *
 * Fire-and-forget: a failed push goes to `report` and the outbox drains on — nothing here can
 * fail a turn, a state, or a run. Exported for its unit test; {@link RunHost} is its one caller.
 */
export function echoOutbox(
  push: (events: EchoEvent[]) => Promise<void>,
  report: (err: unknown) => void,
): (events: EchoEvent[]) => void {
  let pending: EchoEvent[] = [];
  let flushing = false;
  // The last status that left in a push, as its JSON: the level the log shows now.
  let shown: string | undefined;
  const flush = async (): Promise<void> => {
    while (pending.length > 0) {
      const batch = pending;
      pending = [];
      // A batch holds at most one status (see the enqueue below).
      const status = batch.find((p) => p.kind === "status");
      if (status) shown = JSON.stringify(status);
      try {
        await push(batch);
      } catch (err) {
        report(err);
      }
    }
    flushing = false;
  };
  return (events) => {
    for (const event of events) {
      if (event.kind === "status") {
        pending = pending.filter((p) => p.kind !== "status");
        if (JSON.stringify(event) === shown) continue;
      }
      pending.push(event);
    }
    if (flushing || pending.length === 0) return;
    flushing = true;
    // A microtask, so a synchronous burst (the replay; one transition's Emits and status) leaves
    // as one push rather than as its first event alone.
    queueMicrotask(() => void flush());
  };
}

/** The child-machine tree for the echo's status: spawn ids and state values alone — a root's
 * value says almost nothing about where a run is, and a {@link RunChild} is already context-free
 * by construction. `src`/`status` stay behind: they are join keys for the Console, not story. */
function echoChildrenOf(children: RunChild[]): EchoStatusChild[] {
  return children.map((child) => {
    const nested = echoChildrenOf(child.children);
    return { id: child.id, value: child.value, ...(nested.length ? { children: nested } : {}) };
  });
}

/**
 * One item on a WORKFLOW's observation feed (the `GET /workflows/:name/events` SSE — ADR-0022).
 *
 * The same vocabulary as {@link RunFeedEvent} at a coarser granularity, plus `gone`. Every run-
 * scoped item carries `runId` even where the per-run route makes it redundant, so a consumer can
 * parse both feeds with one reader.
 *
 * `gone` is its own fact rather than an inference from a terminal status, because a run can leave
 * the live set WITHOUT one: `stop()` deliberately leaves the stored status "live" so a later
 * `restore()` picks the run back up (see `spawn`). A watcher that inferred departure from
 * `status === "done"` would show a stopped run as live forever.
 *
 * The opening `runs` snapshot is not an arm here: {@link RunHost.observeWorkflow} returns it, so it
 * cannot be missed by a listener that attached a moment too late. The wire re-frames it as `runs`.
 */
export type WorkflowFeedEvent =
  | { kind: "status"; status: RunStatus }
  | { kind: "gone"; runId: string }
  | { kind: "emit"; runId: string; event: { type: string } & Record<string, unknown> }
  | ({ runId: string } & RetryTelemetry)
  | { kind: "closed" };

type WorkflowListener = (e: WorkflowFeedEvent) => void;

export type RunHostOptions = {
  store: SnapshotStore;
  /** Probe the live world before re-attaching on restore (ADR-0007). Default: always present. */
  reconcile?: (run: RunRecord) => boolean | Promise<boolean>;
  /** Injectable id generator (deterministic ids in tests). Default: `crypto.randomUUID`. */
  newId?: () => string;
  /**
   * Resolve a stamped blob's Workflow inside the Assembly it names (ADR-0069): the Machine that
   * Assembly's `workflows/<name>.ts` exports, as a def stamped with that hash, or why it cannot be
   * read (`drifted`: not on the volume, published for another Kit version, does not import). The
   * host never learns the volume layout; `startInstance` supplies this over `assemblies/<hash>`.
   * A def it returns is NOT registered: the registry is the current Assembly's alone. A throw is a
   * fault, not a verdict: the row stays live for the next boot (`failed`).
   *
   * Absent (an in-process host): a stamped blob resolves to the registered def of its name only
   * when that def came from the same Assembly hash, since one hash names one tree and so one
   * Machine; otherwise the run is `drifted`.
   */
  resolveDef?: (blob: { workflow: string; assembly: string }) => Promise<WorkflowDef | { drifted: string }>;
  /** Report a run that threw during restore (ADR-0030). The row is left `live` for the next boot,
   * so this is the only account of why — the entrypoint logs it. Default: silent. */
  onRestoreError?: (runId: string, err: unknown) => void;
  /** The Sandbox backend `workspace()` provisions through (ADR-0012). Absent = no cluster:
   * workspace-less workflows run fine; a `workspace()` invocation faults its run pointedly. */
  sandbox?: SandboxPort;
  /** The Instance Harness base URL (ADR-0031) — where `workspace: "none"` Turns are admitted. */
  instanceHarness?: string;
  /** The name this Orchestrator gives itself at another Orchestrator's door, as a foreign
   * dispatch's `dispatchedBy.instance` (ADR-0071): stable and not secret. Deployed, its namespace. */
  orchestratorName?: string;
  /** The Harness bearer for a placement (ADR-0058) — `startInstance` closes `harnessToken` over the
   * signing key. Handed to every run's binding, and to the echo pusher below. Absent, no Harness
   * call bears one: only the stub Harness answers such a host. */
  harnessBearer?: (placement: string) => string;
  /** Where an Effector placement is, and its key (ADR-0068) — `startInstance` derives both, the key
   * from the signing key. Handed to every run's binding; absent, an http Effect faults pointedly. */
  effector?: (placement: EffectorPlacement) => EffectorTarget | undefined;
  /**
   * Why a listed named Chart cannot run now, or undefined (ADR-0070): the registry of named Charts
   * keeps the unrunnable ones, never the host. An in-process `dispatch` of one is refused 409 with
   * this reason, as its start through the door is (ADR-0071). Absent, such a name answers 404:
   * the host registers only the runnable ones.
   */
  unrunnableChart?: (name: string) => string | undefined;
  /**
   * Build the run-narrative echo pusher for one Workspace's Harness (ADR-0023) — the seam a fake
   * echo server rides in tests; `startInstance` binds the real wire push (harness-client.ts).
   * `bearer` is that Workspace's Harness bearer (ADR-0058), when the host derives one. Absent = no
   * echo: a host without it runs identically, because the echo is a courtesy view of the feed,
   * never a dependency of the run.
   */
  echo?: (endpoint: string, bearer: string | undefined) => (events: EchoEvent[]) => Promise<void>;
  /**
   * Build the live-set statement to the Instance Harness (ADR-0031) — the seam a fake rides in
   * tests; `startInstance` binds the real wire push (harness-client.ts). `bearer` is the Instance
   * Harness's (ADR-0058). Absent, or with no `instanceHarness`, nothing is stated.
   */
  liveSet?: (endpoint: string, bearer: string | undefined) => (live: LiveConversation[]) => Promise<unknown>;
  /** How often the live set is stated, before jitter. Default: the Lease's cadence (ADR-0021).
   * Tests shrink it. */
  liveSetIntervalMs?: number;
  /** The wall clock a run's timer table is written and read on (ADR-0007, timers.ts): each pending
   * timer's deadline is a time on it. Default: `Date.now`. Tests pass a clock that does not step. */
  now?: () => number;
  /** The bound of a standing run and the back-off after its `error` (ADR-0017). Tests shrink them. */
  standing?: StandingOptions;
};

/** The bound of a standing run, and the wait before a hand-over from a run in which no item that
 * it took started a run (ADR-0017). */
export type StandingOptions = {
  /** Hand the run over once it has taken this many items, each one a dispatch. When no item that it
   * took itself started a run (a carried key does not count), the hand-over waits out the
   * back-off, as after `error`. Default: 500. */
  dispatches?: number;
  /** Hand the run over once it is this old, in milliseconds. Default: one day. */
  ageMs?: number;
  /** The wait before the hand-over after the `n`-th run in a row that ended `error`, ended
   * `failed` (ADR-0073, as `error`) or took its bound, and in which no item that it took itself
   * started a run (a carried key does not count). n is from 1; a run in which such an item started
   * a run waits as n = 1. Default: 1 s, 4 s, then 16 s. */
  backoffMs?: (n: number) => number;
};

/** The bound of a standing run (ADR-0017): 500 dispatches or one day. Not measured past the size
 * of a save: each dispatch keeps a ledger row of about 217 bytes, so 500 is about 110 KB. */
export const STANDING_BOUND = { dispatches: 500, ageMs: 24 * 60 * 60 * 1000 } as const;
/** How many hand-overs jr2 makes from runs in a row that end `error`, end `failed` or take their
 * bound, in which no item that the run took itself started a run (ADR-0017). When the next such
 * run ends, jr2 pauses the standing Pool. Not measured. */
export const STANDING_ERRORS_PAUSE = 3;
/** How many times one delivery follows a standing Pool's hand-overs to the new run's Source. After
 * more hand-overs in one delivery's fan-in, the door answers 503, as for a Pool with no live run. */
const STANDING_HOPS = 3;
const standingBackoff = (n: number): number => Math.min(60_000, 1000 * 4 ** (n - 1));

/** A standing Workflow as `jr2 up` and `jr2 status` print it (ADR-0017): its Pool, its callee, its
 * state, its run, and how many items it holds. `live`: a run is live. `paused`: a cancel (`why`:
 * `cancel`), or a fourth run in a row in which no item that the run took started a run, after 3
 * hand-overs: the last one ended `error` or `failed` (`errors`), or took its bound (`bound`). The
 * held items are in the blob of `run`.
 * `waiting`: no run is live, and jr2 starts one after the back-off. Structure and counts only: no
 * key and no item, so it is on the open band with the Assembly. */
export type StandingView = {
  workflow: string;
  pool: string;
  callee: string;
  state: "live" | "paused" | "waiting";
  run?: string;
  held: number;
  why?: "cancel" | "errors" | "bound";
};

/** jr2 starts a standing Workflow's run, and a Caller's start only resumes a paused one (ADR-0017):
 * the door answers 409 with the message. */
export class StandingRefused extends Error {
  override name = "StandingRefused";
}

/** What we persist per run: the machine snapshot wrapped with the run metadata restore needs.
 * `agents` is the admission LEDGER (ADR-0016) — iid → durable admission, reported by the Agent's Actor
 * through the run binding and saved in the same blob (same store, same atomicity). */
type RunBlob = {
  workflow: string;
  instanceId: string;
  /** The run that dispatched this one (ADR-0071), its key included: the store finds a run by its
   * key here (`findByDispatch`), so a re-sent start answers the run it already made. */
  dispatchedBy?: DispatchedBy;
  /** Who started the run (ADR-0078). */
  startedBy?: RunStarter;
  /** The Caller that cancelled the run (ADR-0078). */
  cancelledBy?: CallerRecord;
  /** The Caller whose `jr2 run` resumed this standing run (ADR-0017). */
  resumedBy?: CallerRecord;
  /** The run that took over from this standing run at a hand-over (ADR-0017). */
  handedOverTo?: string;
  /** The last answers to the run's Gates, with their Callers (ADR-0078). */
  answers?: GateAnswer[];
  /** The shape of the Machine that WROTE this snapshot (ADR-0030). `workflow` says which def to
   * look up; this says whether the def found there is still the one this snapshot can be read by.
   * Absent means written before the stamp existed, which restore treats as drift — the point is to
   * never interpret a snapshot whose Machine cannot be vouched for. */
  machine?: string;
  /** The hash of the Assembly the run started under (ADR-0069), stamped on every save. A blob
   * without one cannot be vouched for, so restore treats it as drift, as it treats a blob with no
   * `machine` stamp. */
  assembly?: string;
  snapshot: unknown;
  agents?: Record<string, AgentAdmission>;
  /**
   * The EPOCH ledger (ADR-0057): a continued conversation's base Instance ID
   * (`<runId>/<machine actor path>/<agent>`) → the epoch the next `continue` on it lands on. An
   * entry appears only once a terminal `agent.fault` has burned that conversation; everything
   * else reads 0, which is the unsuffixed id itself.
   *
   * It rides THIS blob rather than a store of its own for the same reasons `agents` does: it is
   * per-run state with the run's exact lifetime, and saving it in the same write gives it the
   * snapshot's atomicity — a restore that re-attached a Turn but forgot which conversations were
   * burned would hand the next `continue` a dead one. Keyed by the BASE id (never the minted
   * `<id>/<epoch>`), so one conversation has exactly one counter however often it burns.
   */
  epochs?: Record<string, number>;
  /**
   * The pending NOTICES (ADR-0062): what the next Turn in a scope must be told — a memory kill in
   * its Workspace, a conversation that is new. The Orchestrator is their only keeper, so they ride
   * this blob beside the two ledgers, for the same reasons: the run's exact lifetime, and the
   * snapshot's atomicity. A notice is cleared for a conversation in the save that ledgers the
   * admission that carried it there, so a restart before that save delivers it again and a restart
   * after does not. A conversation notice then leaves it; a Workspace notice stays, with the
   * conversations that heard it, for the Workspace's other conversations.
   */
  notices?: NoticeLedgerState;
  /**
   * The pending TIMERS (`after`, named delays, delayed `raise` and `sendTo`), each with its
   * absolute deadline (ADR-0007, timers.ts). xstate 5 keeps them on the actor system, not in the
   * snapshot, so a restore without this table loses every one. Same blob for the snapshot's
   * atomicity: the timers saved are exactly the ones the saved states scheduled.
   */
  timers?: PendingTimer[];
  /**
   * The outstanding picks (ADR-0024, holds.ts): each conversation's latest pick that the workflow ran, its
   * delivery id, the last reply since it, and its answer once read at Rest. Same blob for the
   * snapshot's atomicity: a restored host answers the same poll from the same Machine.
   */
  holds?: Hold[];
  /**
   * The Effect LEDGER (ADR-0067): one row per Effect, by its id — `intent` before the call,
   * `settled` with its output, `aborted` when its state exited while it ran. Same blob for the
   * snapshot's atomicity: an intent row is saved with the snapshot that holds its Effect, so a restore
   * reads which Effects may have acted and runs none of them twice. A row is never dropped: the
   * settled and aborted rows keep id, kind and outcome, the record of what the run's Effects did; a
   * settled row's output tail is dropped once a save carries its transition (`dropSavedTails`).
   */
  effects?: Record<string, EffectRow>;
  /**
   * Which Agent started each live child (ADR-0067), by the child's key — the invoke ids from below
   * the root down to the child, encoded and joined by `/` (`childKey`), so a child of one Machine is
   * never another Machine's child of the same local id: the Agent whose pick's
   * own send started it, or whose event the Machine was taking when it started. A done event of that
   * child names that Agent, so an `answer` on a transition below no Agent's state that the done event
   * takes shapes that Agent's pick and no other — whether the pick that started it is still
   * outstanding or not. Same blob, so a restore names the same Agent. A child no longer in the tree
   * is dropped at the save.
   */
  childAgents?: Record<string, ChildAgent>;
  fault?: string;
  /** The Failure that ended the run `failed` (ADR-0073), as plain data: the run's output. xstate
   * keeps the error of an errored snapshot, and serializes it to `{}`, so it is kept here. */
  failure?: FailureInput;
};

type LiveRun = {
  record: RunRecord;
  actor: AnyActor;
  def: WorkflowDef;
  /** What this run's callback actors resolve off the actor system — kept so `stop()` can tell
   * them the HOST is the one ending the run (ADR-0024's one exception). */
  binding: RunBinding;
  /** The live admission ledger (ADR-0016): persisted as `RunBlob.agents`, seeded on restore. */
  agents: Record<string, AgentAdmission>;
  /** The live epoch ledger (ADR-0057): persisted as `RunBlob.epochs`, seeded on restore. */
  epochs: Record<string, number>;
  /** The pending notices (ADR-0062): persisted as `RunBlob.notices`, seeded on restore. */
  notices: NoticeLedger;
  /** The outstanding picks by Agent address (ADR-0024): persisted as `RunBlob.holds`, seeded on restore. */
  holds: Map<string, Hold>;
  /** The Effect ledger (ADR-0067): persisted as `RunBlob.effects`, seeded on restore. */
  effects: Record<string, EffectRow>;
  /** Which Agent started each live child (ADR-0067): persisted as `RunBlob.childAgents`, seeded on restore. */
  childAgents: Record<string, ChildAgent>;
  /** The error that killed the run, if it errored (xstate serializes Error to `{}`, so the
   * message is captured here at the observer and persisted onto the blob for `read`). */
  fault?: string;
  /** The Failure that ended the run, if it failed (ADR-0073): persisted as `RunBlob.failure`. */
  failure?: FailureInput;
  /** The Caller that cancelled the run (ADR-0078): persisted as `RunBlob.cancelledBy`. */
  cancelledBy?: CallerRecord;
  /** The run that took over from this standing run (ADR-0017): persisted as `RunBlob.handedOverTo`. */
  handedOverTo?: string;
  /** This standing run took its bound of items and none of them started a run (ADR-0017): jr2 ended
   * it `done`, and its hand-over waits out the back-off. Not persisted: the head's streak keeps it. */
  boundWithNoRun?: boolean;
  /** The last answers to the run's Gates (ADR-0078): persisted as `RunBlob.answers`, seeded on
   * restore. */
  answers: GateAnswer[];
  /** Per-run observers fed by `persist()` (status) and the actor's `emit` (emit) — SSE/CLI watch. */
  listeners: Set<(e: RunFeedEvent) => void>;
  /** The run's feed-so-far (ADR-0023): what a Workspace attaching mid-run gets replayed as its
   * log's preamble — its markers and Emits, in feed order. In-memory and this-boot only — a
   * restored run's preamble starts at restore, the same live-only contract the printed log already
   * has. Capped ({@link FEED_SO_FAR_CAP}). */
  feedSoFar: RunFeedEvent[];
  /** The preamble's last line: where the run stands now. A status is a level (ADR-0023), so the
   * buffer keeps the latest alone — old statuses are not interleaved between old markers. */
  latestStatus?: RunFeedEvent & { kind: "status" };
};

export class RunHost {
  /** The internal registration table both delivery surfaces share (ADR-0011). Callback actors
   * (`gate`, the Agent slots) reach it via the run binding, not this field. */
  private readonly table = new RegistrationTable();

  private readonly store: SnapshotStore;
  private readonly reconcile: (run: RunRecord) => boolean | Promise<boolean>;
  private readonly newId: () => string;
  private readonly onRestoreError?: (runId: string, err: unknown) => void;
  private readonly resolveDef?: RunHostOptions["resolveDef"];
  private readonly sandbox?: SandboxPort;
  private readonly instanceHarness?: string;
  private readonly orchestratorName?: string;
  private readonly harnessBearer?: (placement: string) => string;
  private readonly effector?: (placement: EffectorPlacement) => EffectorTarget | undefined;
  private readonly unrunnableChart?: (name: string) => string | undefined;
  /**
   * Run id → what waits for that run to settle (ADR-0071): a `dispatch` with `wait`. Keyed by the
   * run, not kept on its {@link LiveRun}, because a restored caller may attach before its callee is
   * hosted again (`store.live()` row order) or while the callee is not hosted at all.
   */
  private readonly settleListeners = new Map<string, Set<(status: RunStatus) => void>>();
  /** (Workflow, idempotency key) → the start in flight under it (ADR-0071): a second start of the
   * same Workflow with the same key before the first has spawned its run answers the first's run,
   * never a second. */
  private readonly dispatching = new Map<string, Promise<DispatchedRun>>();
  private readonly echoFactory?: (
    endpoint: string,
    bearer: string | undefined,
  ) => (events: EchoEvent[]) => Promise<void>;
  private readonly liveSetPush?: (live: LiveConversation[]) => Promise<unknown>;
  private readonly liveSetIntervalMs: number;
  private readonly now: () => number;
  private liveSetTimer?: ReturnType<typeof setTimeout>;
  /** Whether the last live-set statement failed — a failing streak logs one line (ADR-0031). */
  private liveSetFailing = false;
  private readonly workflowDefs = new Map<string, WorkflowDef>();
  private readonly runs = new Map<string, LiveRun>();
  /**
   * The admission ledgers of the runs restore could not host this boot (a `reconcile` that threw).
   * Their rows stay `live` for the next boot to retry, so their conversations on the Instance
   * Harness are still held: the live set names them from here (ADR-0031), or the retry would find
   * nothing to re-attach to.
   */
  private readonly unhosted = new Map<string, Record<string, AgentAdmission>>();
  /**
   * Workflow name → its observers. Deliberately on the HOST and not on `LiveRun`: a workflow's
   * watcher outlives every individual run it watches, and `persist()` clears a settled run's own
   * listener set. Keeping it here is what makes that structurally impossible to get wrong, rather
   * than a comment asking the next reader not to clear the wrong Set.
   */
  private readonly workflowListeners = new Map<string, Set<WorkflowListener>>();
  /** Every timer a run's actor system has armed and not yet fired or cleared: an `after`, a Chart's
   * wall clock (ADR-0070). `close()` unrefs them, so a timer of hours never holds the process. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** The clock every run's actor system arms its timers on: xstate's own, with each timer kept in
   * {@link timers} and unref'd once the host is closing. The scheduled events stay in the system's
   * snapshot, so a restore arms them again. */
  private readonly clock = {
    setTimeout: (fn: (...args: unknown[]) => void, ms: number) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        fn();
      }, ms);
      this.timers.add(timer);
      if (this.#stopping) (timer as { unref?: () => void }).unref?.();
      return timer;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
      this.timers.delete(timer);
      clearTimeout(timer);
    },
  };
  /** The registration each hold was opened under, this boot: the same address re-registered by
   * another invocation (`continue: true`) is another Turn. A restored hold adopts the first. */
  private readonly holdRegs = new WeakMap<Hold, Registration>();
  /** The long polls waiting on each open hold (ADR-0024). */
  private readonly holdWaiters = new Map<Hold, Set<() => void>>();
  /** The pick being delivered now, and the last reply from below its Agent's state inside its own
   * send (ADR-0024). A child that settles in the same macrostep as the pick — a decision Machine
   * that is final as it starts — replies before a hold can exist, so the chain records it here. */
  private sending: Sending | undefined;
  /** `<iid> <deliveryId>` of every outstanding pick of a run this host parked (`stop`). */
  private readonly parked = new Set<string>();
  #stopping = false;
  #restorePending = false;
  /** The bound and the back-off of standing runs (ADR-0017). */
  private readonly standingOpts: Required<StandingOptions>;
  /** The head of each standing Workflow (ADR-0017), read from the store at first use and written
   * through to it. */
  #heads: Map<string, StandingHead> | undefined;
  /** Each standing Workflow's timer: the back-off before a hand-over after `error`, or the age
   * bound of its live run. One a Workflow. */
  private readonly standingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: RunHostOptions) {
    this.store = opts.store;
    this.reconcile = opts.reconcile ?? (() => true);
    this.newId = opts.newId ?? (() => randomUUID());
    this.onRestoreError = opts.onRestoreError;
    this.resolveDef = opts.resolveDef;
    this.sandbox = opts.sandbox;
    this.instanceHarness = opts.instanceHarness;
    this.orchestratorName = opts.orchestratorName;
    this.harnessBearer = opts.harnessBearer;
    this.effector = opts.effector;
    this.unrunnableChart = opts.unrunnableChart;
    this.echoFactory = opts.echo;
    this.liveSetPush =
      opts.instanceHarness && opts.liveSet
        ? opts.liveSet(opts.instanceHarness, opts.harnessBearer?.(INSTANCE_HARNESS_SERVICE))
        : undefined;
    this.liveSetIntervalMs = opts.liveSetIntervalMs ?? DEFAULT_LEASE_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.standingOpts = {
      dispatches: opts.standing?.dispatches ?? STANDING_BOUND.dispatches,
      ageMs: opts.standing?.ageMs ?? STANDING_BOUND.ageMs,
      backoffMs: opts.standing?.backoffMs ?? standingBackoff,
    };
  }

  /** Register a workflow so `start`/`restore` can run it. Re-registering replaces (dev reload).
   * Nothing about the vocabulary is copied here: event names are scoped to the Machine that
   * declared them and resolved at invoke time off the invoking Machine (ADR-0011, ADR-0049), so
   * a nested Machine's defs are never the root's — or this host's — to hold. */
  register(def: WorkflowDef): void {
    const wrapper = def.wrapper ?? wrapperOf(def.machine);
    this.workflowDefs.set(def.name, wrapper ? { ...def, wrapper } : def);
  }

  /**
   * Register a named Chart as the Workflow `<wrapper>/<name>` (ADR-0070). The registry of named
   * Charts (charts.ts) calls this for each runnable one; it keeps where the Charts are stored, and
   * the unrunnable ones, itself. Replacing a Chart a live run holds is fine: the run holds its text.
   */
  registerChart(def: WorkflowDef & { chart: NonNullable<WorkflowDef["chart"]> }): void {
    this.register(def);
  }

  /** Drop a named Chart's Workflow. A live run of it keeps its text and runs on. */
  unregisterChart(wrapper: string, name: string): void {
    const key = `${wrapper}/${name}`;
    if (this.workflowDefs.get(key)?.chart) this.workflowDefs.delete(key);
  }

  /** The registered named Chart `<wrapper>/<name>`, or undefined. */
  namedChart(wrapper: string, name: string): NamedChart | undefined {
    const chart = this.workflowDefs.get(`${wrapper}/${name}`)?.chart;
    return (
      chart && { wrapper: chart.wrapper, name: chart.name, text: chart.text, hash: chart.hash, origin: chart.origin }
    );
  }

  /**
   * Every registered Workflow with its origin (ADR-0070): a Machine, or a named Chart from a file or
   * at run time. A Chart wrapper's entry carries its Open body, whether its door takes a Chart, and
   * its named Charts: a named Chart lists inside its wrapper's entry, not beside it, and has an
   * entry of its own only when its wrapper is not registered.
   */
  workflowList(): WorkflowListing[] {
    const defs = [...this.workflowDefs.values()];
    const wrappers = new Set(defs.filter((d) => !d.chart && d.wrapper).map((d) => d.name));
    return defs.flatMap((def): WorkflowListing[] => {
      if (def.chart) return wrappers.has(def.chart.wrapper) ? [] : [{ name: def.name, origin: def.chart.origin }];
      if (!def.wrapper) return [{ name: def.name, origin: "machine" }];
      const charts = defs
        .filter((d) => d.chart?.wrapper === def.name)
        .map((d) => ({ name: d.chart!.name, origin: d.chart!.origin }));
      return [
        {
          name: def.name,
          origin: "machine",
          wrapper: { body: def.wrapper.body, oneShot: def.wrapper.chartFields.length > 0, charts },
        },
      ];
    });
  }

  /** Drop a workflow's registration (a workflow the host no longer discovers). In-flight
   * runs keep their already-assembled definition; only future `start`s are affected.
   *
   * Observers stay ATTACHED, deliberately. Their runs are still running, so a feed that ended here
   * would be reporting that the work stopped when it did not — and the file may well come back on
   * the next reload, which the still-open feed then picks up with no reconnect. */
  unregister(name: string): void {
    this.workflowDefs.delete(name);
  }

  /** The names of every registered workflow (the `GET /workflows` listing — ADR-0009). */
  workflows(): string[] {
    return [...this.workflowDefs.keys()];
  }

  /** The runs this process hosts, by the hash of the Assembly each started under (ADR-0069). A
   * run from a def with no Assembly holds none. The store's live rows are the hold
   * (`SnapshotStore.liveAssemblies`); this adds a run started a moment ago, before its first save. */
  assemblyHolds(): Map<string, string[]> {
    const holds = new Map<string, string[]>();
    for (const [runId, run] of this.runs) {
      const hash = run.def.assembly;
      if (hash === undefined) continue;
      holds.set(hash, [...(holds.get(hash) ?? []), runId]);
    }
    return holds;
  }

  /** The registered template Machine's serialized structure (`GET /workflows/:name/machine`). */
  machine(name: string): MachineDoc | undefined {
    const def = this.workflowDefs.get(name);
    return def && serializeMachine(name, def.machine);
  }

  /**
   * The run's bound Machine (ADR-0070): the Workflow's Machine with each bound Open body's subgraph
   * the compiled Chart's (its `src` stays the slot key, so the live child joins it as before) —
   * from the live actor's bound Machine, or, for a stored run, compiled again from the text its
   * blob holds. Undefined for an unknown run, and for a stored run whose Workflow is not registered.
   */
  async runMachine(runId: string): Promise<MachineDoc | undefined> {
    const live = this.runs.get(runId);
    let workflow: string;
    let machine: AnyStateMachine;
    let bodies: Array<{ route: BoundChartRoute; compiled: AnyStateMachine | string }>;
    if (live) {
      workflow = live.record.workflow;
      machine = live.def.machine;
      const refs = new Map<string, AnyActorRef>();
      const collect = (ref: AnyActorRef, path: string[]): void => {
        for (const [id, child] of Object.entries(childrenOfRef(ref))) {
          refs.set([...path, id].join("/"), child);
          collect(child, [...path, id]);
        }
      };
      collect(live.actor, []);
      bodies = boundChartRoutesOf(live.actor.getSnapshot()).map((route) => {
        const ref = refs.get(route.path.join("/"));
        return { route, compiled: (ref && boundMachineOf(ref)) ?? "the live body holds no compiled Chart" };
      });
    } else {
      const stored = await this.store.load(runId);
      const blob = stored?.snapshot as RunBlob | null | undefined;
      if (!blob) return undefined;
      const def = this.workflowDefs.get(blob.workflow) ?? this.workflowDefs.get(wrapperName(blob.workflow));
      if (!def) return undefined;
      workflow = blob.workflow;
      machine = def.machine;
      bodies = boundChartRoutesOf(blob.snapshot).map((route) => ({
        route,
        compiled: compileStored(def.machine, route),
      }));
    }
    const doc = serializeMachine(workflow, machine);
    const notDrawn: NonNullable<MachineDoc["chartsNotDrawn"]> = [];
    for (const { route, compiled } of bodies) {
      if (typeof compiled === "string") {
        // The doc keeps the slot's own subgraph, and says so: a doc that drew the wrapper's body
        // with no word would disagree with the run's `bound` (ADR-0070, D-B).
        notDrawn.push({ path: route.path.join("/"), src: route.src, reason: compiled });
        continue;
      }
      const { workflow: _w, opaqueStates: _o, ...body } = serializeMachine(route.src, compiled);
      placeBody(doc, route.srcs, body);
    }
    return notDrawn.length ? { ...doc, chartsNotDrawn: notDrawn } : doc;
  }

  /**
   * The workflow's declared run-input contract as JSON Schema (ADR-0033) — what the workflow
   * detail serves and the Console's start form generates from. `null` for a machine that
   * declares none (a run of it starts with anything), undefined for an unknown workflow. A
   * schema is STRUCTURE, the same class of thing as the Machine doc — open band (ADR-0014).
   */
  inputSchema(name: string): Record<string, unknown> | null | undefined {
    const def = this.workflowDefs.get(name);
    if (!def) return undefined;
    let schema = inputSchemaOf(def.machine);
    // A named Chart's door is its wrapper's minus the Chart fields, which the Chart supplies (ADR-0070).
    if (schema && def.chart && def.wrapper?.chartFields.length) {
      schema = schema.omit(Object.fromEntries(def.wrapper.chartFields.map((f) => [f, true])) as never);
    }
    // `io: "input"`: this schema describes what a caller SENDS — a defaulted field is optional
    // at the door (the default is applied by `start`'s parse), not required of the form.
    return schema ? (z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>) : null;
  }

  /**
   * Start a fresh run of a registered workflow; returns its durable ids.
   *
   * With `dispatchedBy` (ADR-0071), the start is a `dispatch` Effect's, and its `effect` is the
   * idempotency key, scoped to `workflow`: a run of `workflow` that already carries the key is
   * answered, `existing`, and none is started. The same key in another Workflow is another run. That is what lets a caller re-send a start whose answer it lost. The key is looked for
   * among the runs this process hosts first — a run's first save is a microtask after its spawn —
   * then in the store. A key on a row the weekly sweep removed (ADR-0065) starts a new run: known,
   * and not guarded. The depth is recorded as sent: the caller states the callee's.
   *
   * `startedBy` is who starts it (ADR-0078), which the run records. Absent with `dispatchedBy`, the
   * start is a local dispatch's, and the run records the caller's run and slot.
   */
  async start(
    workflow: string,
    input: Record<string, unknown> = {},
    opts: { dispatchedBy?: DispatchedBy; startedBy?: RunStarter } = {},
  ): Promise<{ runId: string; instanceId: string; existing?: true }> {
    const by = opts.dispatchedBy;
    const startedBy: RunStarter | undefined =
      opts.startedBy ?? (by ? { kind: "run", run: by.run, slot: by.slot } : undefined);
    if (!by) return this.startFresh(workflow, input, undefined, startedBy);
    // The starts in flight are held by the key in its Workflow's scope.
    const scoped = JSON.stringify([workflow, dispatchKeyOf(by)]);
    const inFlight = this.dispatching.get(scoped);
    if (inFlight) return { ...(await inFlight), existing: true };
    let existing = false;
    const started = (async (): Promise<DispatchedRun> => {
      const found = await this.dispatched(workflow, dispatchKeyOf(by));
      if (found) {
        existing = true;
        return found;
      }
      return this.startFresh(workflow, input, by, startedBy);
    })();
    this.dispatching.set(scoped, started);
    try {
      const ids = await started;
      return existing ? { ...ids, existing: true } : ids;
    } finally {
      this.dispatching.delete(scoped);
    }
  }

  /**
   * The run of `workflow` that carries the idempotency key `key` (ADR-0071), or undefined: a hosted
   * run first, then a stored one, in any status, while its row lives. The key is scoped to the
   * Workflow: a run of another Workflow under the same key is not this one.
   */
  async dispatched(workflow: string, key: string): Promise<DispatchedRun | undefined> {
    for (const run of this.runs.values()) {
      if (
        run.record.workflow === workflow &&
        run.record.dispatchedBy !== undefined &&
        dispatchKeyOf(run.record.dispatchedBy) === key
      ) {
        return { runId: run.record.runId, instanceId: run.record.instanceId };
      }
    }
    const runId = await this.store.findByDispatch(workflow, key);
    if (runId === undefined) return undefined;
    const blob = (await this.store.load(runId))?.snapshot as RunBlob | null | undefined;
    return blob ? { runId, instanceId: blob.instanceId } : undefined;
  }

  /**
   * The in-process start of a `dispatch` Effect (ADR-0071, the binding's `dispatch.start`): every
   * refusal the door would answer, with its status, as output — the body may have come from a
   * model, and the report must reach it through the Chain. Any other throw is a defect, and is the
   * invoke's error.
   */
  private async dispatchStart(
    workflow: string,
    input: Record<string, unknown>,
    by: DispatchedBy,
  ): Promise<DispatchStart> {
    // The key first: a re-sent start answers its run whatever the Assembly holds now.
    const found = await this.dispatched(workflow, dispatchKeyOf(by));
    if (found) return { ok: true, runId: found.runId, existing: true };
    // jr2 starts a standing Workflow's run (ADR-0017): a dispatch never starts one.
    if (this.isStanding(workflow)) {
      return {
        ok: false,
        status: 409,
        report: [`"${workflow}" is a standing Workflow: jr2 starts its run, and a dispatch cannot (ADR-0017)`],
      };
    }
    const unrunnable = this.unrunnableChart?.(workflow);
    if (unrunnable !== undefined) {
      return { ok: false, status: 409, report: [`named Chart "${workflow}" cannot run: ${unrunnable}`] };
    }
    try {
      const started = await this.start(workflow, input, { dispatchedBy: by });
      return { ok: true, runId: started.runId, existing: started.existing === true };
    } catch (err) {
      if (err instanceof ChartRefusal) return { ok: false, status: 422, report: err.report };
      if (err instanceof EventValidationError) {
        return {
          ok: false,
          status: 400,
          report: [err.message, `the door of "${workflow}" takes ${JSON.stringify(this.inputSchema(workflow))}`],
        };
      }
      if (err instanceof UnknownWorkflowError) return { ok: false, status: 404, report: [err.message] };
      throw err;
    }
  }

  /** A fresh run: the door, the Chart admission, the spawn. Synchronous after its call, so the run
   * is hosted — and its key findable in {@link dispatched} — before anything else runs. */
  private async startFresh(
    workflow: string,
    input: Record<string, unknown>,
    dispatchedBy?: DispatchedBy,
    startedBy?: RunStarter,
  ): Promise<{ runId: string; instanceId: string }> {
    return this.startNow(workflow, input, dispatchedBy, startedBy);
  }

  /** {@link startFresh}, synchronous: a standing Pool's hand-over starts the new run and ends the old
   * one in one step (ADR-0017). Throws what the door refuses. */
  private startNow(
    workflow: string,
    input: Record<string, unknown>,
    dispatchedBy?: DispatchedBy,
    startedBy?: RunStarter,
    resumedBy?: CallerRecord,
  ): { runId: string; instanceId: string } {
    const def = this.workflowDefs.get(workflow);
    if (!def) throw new UnknownWorkflowError(`no workflow registered as "${workflow}"`);

    // A named Chart supplies every Chart field of its wrapper's door, and the caller the rest
    // (ADR-0070): what the caller sent under a Chart field is not the run's.
    if (def.chart && def.wrapper) {
      input = { ...input };
      for (const field of def.wrapper.chartFields) input[field] = def.chart.text;
    }

    // A declared schema is enforced at the door (ADR-0033), and what starts the run is the
    // PARSED shape (defaults applied, unknown keys stripped) — exactly what a gate delivery
    // lands as, and the same error class: `EventValidationError`, which the wire maps to a 400
    // naming what is accepted. No schema → accept anything (the permissive door the wire was).
    const declared = inputSchemaOf(def.machine);
    let runInput = input;
    if (declared) {
      const parsed = declared.safeParse(input);
      if (!parsed.success) {
        throw new EventValidationError(`invalid input for workflow "${workflow}": ${parsed.error.message}`);
      }
      runInput = parsed.data;
    }

    const runId = this.newId();
    const instanceId = this.newId();
    const record: RunRecord = {
      runId,
      workflow,
      instanceId,
      ...(dispatchedBy ? { dispatchedBy } : {}),
      ...(startedBy ? { startedBy } : {}),
      ...(resumedBy ? { resumedBy } : {}),
    };

    const machine = this.assemble(def, instanceId);
    // Every Chart field of a Chart wrapper's door is admitted BEFORE the run exists (ADR-0070): a
    // refusal throws `ChartRefusal`, which the wire answers `422 { error: "refused", report }`. The
    // lent set is the run's own Machine's, with its providers in.
    this.admitDoorCharts(def, machine, runInput);
    // The root machine gets the parsed door PLUS what the host injects beside it —
    // `HostInjectedInput` (vocabulary.ts): the seed Instance ID, added after the parse because no
    // caller sends it and nothing serves it (ADR-0033). Only the root: a machine invoked below is
    // fed by its parent, which is why the type is placement-dependent and `workspace()`'s body
    // guard counts those keys as provided rather than claiming to know where the wrapper sits.
    const actor = this.spawn(machine, { input: { ...runInput, instanceId } }, record, def);
    actor.start();
    return { runId, instanceId };
  }

  /**
   * Admit every Chart field present in a Chart wrapper's parsed door (ADR-0070): the whole door,
   * the compile included, against each Open body (the door cannot tell which body a field feeds).
   * `input.*` references are the body's to check at its start: the Chart's `input` is what the
   * wrapper's invoke sends, which is not the door. Throws ChartRefusal.
   */
  private admitDoorCharts(def: WorkflowDef, machine: AnyStateMachine, input: Record<string, unknown>): void {
    for (const field of def.wrapper?.chartFields ?? []) {
      if (input[field] === undefined) continue;
      admitWrapperChart(machine, input[field]);
    }
  }

  /**
   * The def that reads `blob` (ADR-0069), or the verdict when none can. A stamped blob resolves
   * inside the Assembly it names, through `resolveDef`; an unstamped blob resolves by name in the
   * registry, and only on a host that loads no Assembly. A blob that names no Workflow the
   * registry holds is `lost`: there is nothing it could ever be read by.
   */
  private async defFor(blob: RunBlob): Promise<WorkflowDef | { drifted: string } | { lost: string }> {
    const registered = this.workflowDefs.get(blob.workflow);
    if (blob.assembly !== undefined) {
      const ref = { workflow: blob.workflow, assembly: blob.assembly };
      if (this.resolveDef) {
        const found = await this.resolveDef(ref);
        return "drifted" in found ? found : { ...found, assembly: blob.assembly };
      }
      if (registered?.assembly === blob.assembly) return registered;
      return {
        drifted: `workflow "${blob.workflow}" saved under Assembly ${blob.assembly}, which this host does not hold`,
      };
    }
    // A blob that names no Assembly cannot be vouched for on a host that loads Assemblies:
    // greenfield, no migration (ADR-0069).
    if (this.resolveDef || registered?.assembly !== undefined) {
      return { drifted: `workflow "${blob.workflow}": saved under no Assembly` };
    }
    return registered ?? { lost: `no workflow "${blob.workflow}"` };
  }

  /**
   * Restore every persisted live run: hydrate, reconcile against the live world, and either
   * re-attach (re-spawn from the rewritten child input), mark lost, or refuse as drifted. Returns
   * the run ids handled, by outcome — the caller announces it, because a boot that silently skipped
   * work is the failure this whole path exists to avoid.
   *
   * Every run is handled INDEPENDENTLY (ADR-0030). The loop is sequential and one throw used to
   * reject the whole method, which rejects `startInstance`, which crash-loops the pod — and every
   * later run in the store never restored at all. One run that cannot be resumed is one run, not an
   * outage.
   *
   * `drifted` and `failed` are different claims, deliberately. Drift is a DURABLE verdict — this
   * Orchestrator cannot read what it saved (the Assembly is gone, at another Kit version, does not
   * load, or its Machine's shape does not match), and the next boot will not read it either — so it
   * is written to the row.
   * A throw is not: `reconcile` talks to a cluster, and a kubectl blip must not permanently condemn
   * a run. Those rows are left `live` to be retried on the next boot, and reported every time until
   * they stop failing.
   */
  async restore(): Promise<{ reattached: string[]; lost: string[]; drifted: string[]; failed: string[] }> {
    const reattached: string[] = [];
    const lost: string[] = [];
    const drifted: string[] = [];
    const failed: string[] = [];

    for (const stored of await this.store.live()) {
      // A run this process hosts already is not restored a second time. A deferred restore
      // (ADR-0069) that throws as a whole stays pending, and the next publish tries it again; a run
      // started under the current Assembly between those two publishes has a live row and a live
      // actor, and must not get a second actor.
      if (this.runs.has(stored.runId)) continue;
      const blob = stored.snapshot as RunBlob | null;
      if (!blob) {
        await this.store.markLost(stored.runId, "empty snapshot");
        this.settledUnhosted(stored.runId, "lost", "empty snapshot");
        lost.push(stored.runId);
        continue;
      }

      // Which Machine reads this snapshot (ADR-0069). One rule: a stamped blob restores from its
      // Assembly; an unstamped blob restores from the registry; a stamped host never has unstamped
      // blobs it can vouch for. So a publish strands nothing: the def comes from the Assembly the
      // run started under, never from the current one. Drift is only "I can no longer read what I
      // saved", and it keeps the snapshot (`markDrifted`), so `jr2 status` still reads the run.
      let def: WorkflowDef;
      try {
        const found = await this.defFor(blob);
        if ("lost" in found) {
          await this.store.markLost(stored.runId, found.lost);
          this.settledUnhosted(stored.runId, "lost", found.lost, blob);
          lost.push(stored.runId);
          continue;
        }
        if ("drifted" in found) {
          await this.store.markDrifted(stored.runId, found.drifted);
          this.settledUnhosted(stored.runId, "drifted", found.drifted, blob);
          drifted.push(stored.runId);
          continue;
        }
        def = found;
      } catch (err) {
        // A fault while reading the Assembly, not a verdict on it: left live, as below.
        this.onRestoreError?.(stored.runId, err);
        failed.push(stored.runId);
        this.unhosted.set(stored.runId, blob.agents ?? {});
        continue;
      }

      // The def is the Machine this snapshot names; this asks whether it is still the shape this
      // snapshot was written by (ADR-0030). Inside one Assembly the same bytes give the same
      // Machine, so this guards a hash collision or a hand-edited volume. Refused BEFORE
      // `reconcile`, which talks to the cluster: there is no point proving a Sandbox is alive for
      // a run that cannot be read.
      const expected = fingerprintOf(def.machine);
      if (blob.machine !== expected) {
        const reason =
          `workflow "${blob.workflow}"${def.assembly !== undefined ? ` in Assembly ${def.assembly}` : ""} changed shape since this run was saved ` +
          `(saved under ${blob.machine ?? "an unstamped Machine"}, now ${expected})`;
        await this.store.markDrifted(stored.runId, reason);
        this.settledUnhosted(stored.runId, "drifted", reason, blob);
        drifted.push(stored.runId);
        continue;
      }

      // The Charts the run binds (ADR-0070, D-B): the shape stamp is the wrapper's, and each Chart's
      // identity is its text, kept in its body's snapshot. Each is admitted again against the Open
      // body it binds and the lent set the Machine has now; one that no longer admits is drift.
      const charts = chartDrift(def.machine, boundChartRoutesOf(blob.snapshot));
      if (charts !== undefined) {
        await this.store.markDrifted(stored.runId, charts);
        this.settledUnhosted(stored.runId, "drifted", charts, blob);
        drifted.push(stored.runId);
        continue;
      }

      // The run's place in a chain of dispatches comes back with it (ADR-0071): its key keeps
      // answering a re-sent start, and its depth is the one it started at.
      const record: RunRecord = {
        runId: stored.runId,
        workflow: blob.workflow,
        instanceId: blob.instanceId,
        ...(blob.dispatchedBy ? { dispatchedBy: blob.dispatchedBy } : {}),
        ...(blob.startedBy ? { startedBy: blob.startedBy } : {}),
        ...(blob.resumedBy ? { resumedBy: blob.resumedBy } : {}),
      };

      try {
        if (!(await this.reconcile(record))) {
          await this.store.markLost(stored.runId, "reconcile: live world absent");
          this.settledUnhosted(stored.runId, "lost", "reconcile: live world absent", blob);
          lost.push(stored.runId);
          continue;
        }

        // Re-attach every persisted Agent input in the TREE from the admission ledger
        // (ADR-0016): iids are globally unique, so one flat map covers every nesting depth.
        const agents = blob.agents ?? {};
        const hydrated = reattachAgentRuns(blob.snapshot, agents);

        const actor = this.spawn(
          this.assemble(def, blob.instanceId),
          { snapshot: hydrated as never },
          record,
          // The def of the Assembly the run started under (ADR-0069), so every later save names
          // that hash. The config the run provisions under is the CURRENT Assembly's all the same:
          // the ports read it through the binding a publish replaces, and a held Assembly lends
          // only its Machines (ADR-0069).
          def,
          agents,
          // The burned conversations come back with the admissions (ADR-0057): a restored run's
          // next `continue` must land where this run's last one did, not on a dead conversation.
          blob.epochs ?? {},
          // …and so do the undelivered notices (ADR-0062), reservations forgotten: a notice whose
          // admission never reached the ledger is delivered again.
          blob.notices,
          // …and the outstanding picks (ADR-0024): the restored Machine says when each is answered.
          blob.holds,
          // …and the Effect ledger (ADR-0067): a restored Effect reads its row and never runs twice.
          blob.effects ?? {},
          // …and which Agent started each child (ADR-0067): its done event names the same Agent.
          blob.childAgents ?? {},
        );
        // …and the answers to its Gates, with their Callers (ADR-0078): the record of who acted.
        const restored = this.runs.get(stored.runId);
        if (restored) restored.answers = [...(blob.answers ?? [])];
        // `start()`, then the pending timers again (ADR-0007, see `startAndRearm`). The next save
        // records them again.
        startAndRearm(actor, blob.timers ?? [], this.now());
        // A run an earlier restore left live to retry is hosted now.
        this.unhosted.delete(stored.runId);
        reattached.push(stored.runId);
      } catch (err) {
        // Left `live` on purpose — see the note above. The row is unchanged, so the next boot tries
        // again; what must not happen is this taking the remaining runs down with it.
        this.onRestoreError?.(stored.runId, err);
        failed.push(stored.runId);
        this.unhosted.set(stored.runId, blob.agents ?? {});
      }
    }

    // Every run this boot will host is live now, so the set is whole: state it, and keep stating it
    // (ADR-0031). Not before — a statement ahead of restore would free the conversations of the
    // runs about to be re-attached.
    this.stateLiveSet();
    this.scheduleLiveSet();

    this.#restorePending = false;
    return { reattached, lost, drifted, failed };
  }

  /**
   * The conversations the live runs hold on the Instance Harness (ADR-0031): every admission in
   * their ledgers whose endpoint is the Instance Harness, as the `(agent, instanceId)` pair it runs
   * under. From MEMORY, never the store: the store also holds runs this process does not host, and
   * a run this process hosts is exactly one that may still continue its conversation — and so is a
   * run restore left `live` to retry (`unhosted`). A Sandbox's Harness is not in it — its
   * Workspace's teardown frees everything there.
   */
  liveConversations(): LiveConversation[] {
    const live = new Map<string, LiveConversation>();
    const ledgers = [...[...this.runs.values()].map((run) => run.agents), ...this.unhosted.values()];
    for (const agents of ledgers) {
      for (const [iid, admission] of Object.entries(agents)) {
        if (admission.endpoint !== this.instanceHarness || admission.agent === undefined) continue;
        const instanceId = admission.instanceId ?? iid;
        live.set(JSON.stringify([admission.agent, instanceId]), { agent: admission.agent, instanceId });
      }
    }
    return [...live.values()];
  }

  /**
   * State the live set to the Instance Harness (ADR-0031), which frees every other conversation.
   * FIRE-AND-FORGET: level-triggered and idempotent, so a missed statement costs nothing and the
   * next one says it all again. A failing streak logs one line; nothing here can touch a run.
   */
  private stateLiveSet(): void {
    const push = this.liveSetPush;
    if (!push || this.#stopping) return;
    push(this.liveConversations()).then(
      () => {
        this.liveSetFailing = false;
      },
      (err: unknown) => {
        if (this.liveSetFailing) return;
        this.liveSetFailing = true;
        console.error(
          `live-set statement to ${this.instanceHarness} failed (the Instance Harness keeps what it holds): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      },
    );
  }

  /** Every Lease interval, ±20% (ADR-0021's cadence, which ADR-0031 names). The timer holds no
   * process alive, and `close()` clears it. */
  private scheduleLiveSet(): void {
    if (!this.liveSetPush || this.liveSetTimer !== undefined || this.#stopping) return;
    const next = () => {
      this.liveSetTimer = setTimeout(
        () => {
          if (this.#stopping) return;
          this.stateLiveSet();
          next();
        },
        leaseDelay(this.liveSetIntervalMs, "next", Math.random()),
      );
      this.liveSetTimer.unref?.();
    };
    next();
  }

  /**
   * An agent instance's LIVE surface (`GET /agents/:iid/surface` — ADR-0013): what the state that
   * invoked this Agent accepts, right now. Undefined once nothing is registered (the state exited,
   * the run settled, the iid is unknown) — the one catch point, and the reason the Harness never
   * has to learn which turn is live: it asks, per turn, and the answer IS the turn.
   *
   * "Right now" is the Allowed picks' half (ADR-0029): the registered defs are the state's
   * VOCABULARY, derived statically from its transitions, and the guards on those transitions are
   * asked here, as this Agent's sender (`allowedPicks`, ADR-0015). The pick has not happened yet, so
   * the question is payload-blind: a guard that would have judged the Agent's arguments is left
   * allowed and settled at delivery. The Menu does not move with them — it is the conversation's,
   * fixed at the Machine's build.
   */
  agentSurface(instanceId: string): AgentSurfaceView | undefined {
    const reg = this.table.lookup(agentAddress(instanceId));
    if (!reg) return undefined;
    return {
      instanceId,
      runId: reg.runId,
      sandbox: reg.sandbox,
      ...(reg.slot !== undefined ? { slot: reg.slot } : {}),
      menu: [...menuOf(reg).values()].map((def) => ({
        name: def.name,
        description: def.description,
        input: z.toJSONSchema(def.input),
        semantics: def.semantics,
        ...briefingOf(def.input),
      })),
      allowed: allowedOf(reg),
    };
  }

  /** The Harness read this Turn's surface and was answered (ADR-0026): the notices its admission
   * carried reach a model now, so an end to the Turn no longer raises them again (ADR-0062). */
  agentSurfaceServed(instanceId: string): void {
    this.table.lookup(agentAddress(instanceId))?.served?.();
  }

  /** The notices this Turn's conversation hears at a step boundary (ADR-0062): its pending notices
   * in their audience, reserved for this read until the Harness acknowledges them
   * ({@link noticesHeard}) or the Turn ends. Empty for a registration that hears none. */
  async boundaryNotices(instanceId: string): Promise<Array<{ id: string; notice: LedgerBody }>> {
    return (await this.table.lookup(agentAddress(instanceId))?.boundaryNotices?.()) ?? [];
  }

  /** The Harness appended these step-boundary notices to the Turn (ADR-0062): they are heard in its
   * conversation, ledgered in one save. Answers how many were this conversation's reservations. */
  noticesHeard(instanceId: string, ids: readonly string[]): number {
    return this.table.lookup(agentAddress(instanceId))?.noticesHeard?.(ids) ?? 0;
  }

  /**
   * The Agent slots of a live run (ADR-0002): each slot of each live Machine instance, whether a
   * Turn of it is open, and whether a Caller may steer it. Undefined for a run that is not live.
   */
  agents(runId: string): RunAgent[] | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const open = new Set(
      this.table
        .byRun(runId)
        .filter((reg) => reg.kind === "agent" && reg.slot !== undefined)
        .map((reg) => reg.slot!),
    );
    return liveSlots(run.actor).map((s) => ({ agent: s.agent, open: open.has(s.agent), steerable: s.steerable }));
  }

  /**
   * A Caller's Steering message to one Agent slot of a live run (ADR-0002, ADR-0062). It is held
   * in the run's notice ledger, saved at once: the slot's open Turn hears it at its next step
   * boundary, or its next Turn in the same Machine instance at admission. Refused (409) when the
   * run is not live or no live Machine instance holds the slot, and (403) when the Agent is not
   * steerable. Answers the message's id, and whether a Turn of the slot is open now.
   */
  steer(runId: string, agent: string, text: string, by: CallerRecord): { id: string; agent: string; open: boolean } {
    const run = this.runs.get(runId);
    if (!run) throw new SteeringRefused(`run "${runId}" is not live: no Agent of it can hear a message`, 409);
    const agents = this.agents(runId) ?? [];
    const slot = agents.find((a) => a.agent === agent);
    if (!slot) {
      throw new SteeringRefused(
        `no live Machine instance of run "${runId}" holds the Agent slot "${agent}"` +
          (agents.length > 0 ? ` (its slots: ${agents.map((a) => a.agent).join(", ")})` : " (it has none now)"),
        409,
        agents,
      );
    }
    if (!slot.steerable) {
      throw new SteeringRefused(
        `the Agent slot "${agent}" is not steerable: its definition says steerable: false`,
        403,
      );
    }
    const id = run.notices.steer(
      {
        kind: "steering",
        scope: "slot",
        text,
        author: {
          kind: "caller",
          via: by.via,
          name: by.shown ?? by.name,
          ...(by.onBehalfOf !== undefined ? { onBehalfOf: by.onBehalfOf } : {}),
        },
        at: new Date(this.now()).toISOString(),
      },
      agent,
    );
    this.persist(run);
    return { id, agent, open: slot.open };
  }

  /**
   * Deliver one event from an Agent's Harness (`POST /agents/:iid/events` — ADR-0013). Validation
   * and delivery are the table's; this only agent-scopes the address and mints the receipt. (A
   * `poll` event never reaches here: `jr2Setup` refuses to build a Machine that declares one —
   * ADR-0013.)
   */
  sendToAgent(instanceId: string, event: { type?: unknown } & Record<string, unknown>): AgentDeliveryReceipt {
    const { type, ...payload } = event;
    if (typeof type !== "string" || !type) {
      throw new EventValidationError(`event body must carry a string "type" (one of the surface's Allowed picks)`);
    }
    refuseSenderField(payload);
    const address = agentAddress(instanceId);
    const invoking = this.table.lookup(address);
    const run = invoking ? this.runs.get(invoking.runId) : undefined;
    // One pick at a time per Turn (ADR-0024): while a pick is outstanding, or the Agent's state is
    // busy with work it started in, every pick is refused — `finish` included, and before any other
    // judgment. Decided from the Machine (the Rest rule) and the run's holds, both of which a
    // restore brings back, so it holds after a restart. xstate itself would take the pick, and one
    // the Agent's state handles would exit the child state and stop the work running there.
    if (invoking && run) {
      this.settleHolds(run);
      const hold = run.holds.get(instanceId);
      const out = hold?.answer === undefined ? hold?.pick : undefined;
      if (out !== undefined || restOf(invoking) === "busy") {
        throw new OutstandingError(
          out !== undefined
            ? `"${type}" was not delivered: the pick "${out}" is still running in the workflow, and no other pick is taken until it answers`
            : `"${type}" was not delivered: the workflow is still running work in the state that asked for this Turn, and no pick is taken until it is back at rest`,
          out,
        );
      }
    }
    if (invoking && !invoking.defs.has(type)) {
      // A pick on the Menu that another state of this Agent handles (ADR-0029): answered, not
      // refused — `moved: false` is the correction receipt, whatever its arguments, so the payload
      // is not read. It never reaches the Machine: the invoking state does not handle it, so it
      // could move nothing of this Turn's, and only a state the Agent does not own (a nested
      // Agent's, a Gate's) could act on it — a widening the audience rule forbids (ADR-0015).
      if (menuOf(invoking).has(type)) {
        return {
          delivered: true,
          event: type,
          moved: false,
          turnComplete: false,
          allowed: allowedOf(invoking),
          deliveryId: this.newId(),
        };
      }
      // A name off the Menu is refused HERE, in the Agent's own terms: the table's refusal lists the
      // derived set, bare and unnarrowed, where the Harness is about to write the Allowed picks in
      // the model's tool names (ADR-0029, ADR-0062) — two lists that disagree.
      const refused = new EventValidationError(`the workflow's current state does not accept "${type}"`);
      refused.allowed = allowedOf(invoking);
      throw refused;
    }

    // Ask the guard question BEFORE delivering, and ask it with the VALIDATED payload — this is the
    // exact form of the check the surface build can only approximate payload-blind (ADR-0029).
    // Parsed here rather than read back out of `deliver` because `deliver` is void by design (it is
    // the one behavior behind both dialects); a zod default applied there but not here would leave
    // a guard reading that field answering on `undefined`. An unaccepted name or a bad payload
    // makes this unreliable and `deliver` throws on the next line anyway — so it fails open.
    const def = invoking?.defs.get(type);
    const parsed = def?.input.safeParse(payload ?? {});
    const probe = {
      ...(parsed?.success ? { type, ...parsed.data } : { type, ...payload }),
      ...(invoking?.sender ? { [SENDER_KEY]: invoking.sender } : {}),
    };
    const moved = wouldMove(invoking?.invoker, probe);
    // The states the pick names as targets, and the state value it leaves: after the send, the same
    // value with a target no longer active means it entered a state and came straight back
    // (ADR-0024); a new value, an in-Turn mode move.
    const targets = moved ? targetsOf(invoking?.invoker, probe) : [];
    const before = targets.length > 0 ? stateValueOf(invoking?.invoker) : undefined;

    const outer = this.sending;
    const sending: Sending | undefined = invoking && { reg: invoking, pick: type, chain: [] };
    this.sending = sending;
    try {
      this.table.deliver(address, type, payload);
    } catch (err) {
      // The writing xstate would run for this pick is another party's (ADR-0015, ADR-0029): the
      // pick is ANSWERED, never delivered — `moved: false`, and the Harness picks the receipt by
      // whether the name is in `allowed`. Not in it: the correction receipt. In it: a guard that
      // read the payload turned the selection outward, and the receipt says to change the arguments.
      if (err instanceof NotTakenError && invoking) {
        return {
          delivered: true,
          event: type,
          moved: false,
          turnComplete: false,
          allowed: allowedOf(invoking),
          deliveryId: this.newId(),
        };
      }
      // A refused pick names the Allowed picks, read after the refusal (ADR-0029): one refusal
      // naming them is what brings a wrong pick back — the statement in the Briefing carries the
      // everyday case, and this is the net under it.
      if (err instanceof EventValidationError && invoking) err.allowed = allowedOf(invoking);
      throw err;
    } finally {
      this.sending = outer;
    }
    // Read AFTER the delivery, off the SAME table the ADR-0024 guarantee uses — so the receipt
    // reports what happened rather than what was hoped. `deliver` reached the invoking state's
    // `sendBack` synchronously, so a pick that moved the Machine out of that state has already
    // destroyed this registration by now.
    //
    // IDENTITY, not existence: under `continue: true` the next state re-registers the SAME
    // address for its own turn, and that is a new turn — this one still ended.
    const turnComplete = this.table.lookup(address) !== invoking;
    // A reply from below the Agent's state inside the pick's own send (ADR-0024): a child that
    // settled in the same macrostep. It is the answer's default as any later reply would be.
    const replied = moved && sending ? answerOf(sending) : undefined;
    // Where the answer goes if the route leaves the Agent's state: the conversation the picking
    // Turn continues. A fresh Turn has none — its conversation is never heard again, and a later
    // continued Turn of the same slot never made this pick.
    const conversation = invoking?.conversation;
    // The pick moved the workflow to work inside the Agent's state (ADR-0024): it is OUTSTANDING,
    // answered once the workflow is back at Rest there — read after the mailbox drains, by the
    // persist that follows every transition (`settleHolds`). The POST answers now, with the delivery
    // id the Harness polls; no single request waits on the work (ADR-0013).
    if (!turnComplete && invoking && run && moved && restOf(invoking) === "busy") {
      const deliveryId = this.newId();
      const since = new Date(this.now()).toISOString();
      const hold: Hold = {
        instanceId,
        deliveryId,
        pick: type,
        agent: invoking.sender?.id ?? "",
        since,
        ...(invoking.sandbox !== undefined ? { sandbox: invoking.sandbox } : {}),
        ...(invoking.slot !== undefined ? { slot: invoking.slot } : {}),
        ...(invoking.invokeId !== undefined ? { invokeId: invoking.invokeId } : {}),
        ...(conversation !== undefined ? { conversation } : {}),
        ...(sending && sending.chain.length > 0 ? { chain: [...sending.chain] } : {}),
        ...(sending?.shaped !== undefined ? { shaped: sending.shaped } : {}),
      };
      this.closeHold(run.holds.get(instanceId));
      run.holds.set(instanceId, hold);
      this.holdRegs.set(hold, invoking);
      this.persist(run);
      return {
        delivered: true,
        event: type,
        moved: true,
        turnComplete: false,
        allowed: [],
        deliveryId,
        outstanding: true,
        since,
      };
    }
    // The child replied and the route ran inside the send: the pick is answered on its own POST,
    // as its poll would have answered it — back at Rest with the Allowed picks read after the
    // route, or out of the Agent's state with the answer as a notice to the conversation the picking
    // Turn continued (none for a fresh Turn).
    if (replied !== undefined && invoking) {
      if (turnComplete && conversation !== undefined && run) {
        run.notices.raise(
          { kind: "pick-answer", scope: "conversation", pick: type, cut: false, answer: replied },
          conversation,
        );
      }
      return {
        delivered: true,
        event: type,
        moved: true,
        turnComplete,
        allowed: turnComplete ? [] : allowedOf(invoking),
        deliveryId: this.newId(),
        answered: true,
        answer: replied,
      };
    }
    // It entered a state below the Agent's and came straight back inside its own send — a guard
    // back (an `always`), nothing replying: answered, "moved; nothing ran" (ADR-0024). A pick that
    // changed the state value moved to a mode, and one whose target is still active (the state it
    // was taken in) entered nothing it left: both get the plain receipt below.
    if (
      !turnComplete &&
      invoking &&
      before !== undefined &&
      stateValueOf(invoking.invoker) === before &&
      leftAgain(invoking.invoker, targets)
    ) {
      return {
        delivered: true,
        event: type,
        moved: true,
        turnComplete: false,
        allowed: allowedOf(invoking),
        deliveryId: this.newId(),
        answered: true,
        straightBack: true,
      };
    }
    return {
      delivered: true,
      event: type,
      moved,
      turnComplete,
      // Read off the SAME registration, after the delivery: a pick that moved the Machine within
      // the invoking state may have changed its guards. A Turn that is over may pick nothing.
      allowed: turnComplete || !invoking ? [] : allowedOf(invoking),
      deliveryId: this.newId(),
    };
  }

  /**
   * The registrations whose Agents' picks `event` comes from (ADR-0024, `cause.ts`): the one whose
   * pick it is, in its own send; and each one whose pick, in its own send or out, it answers — an
   * event that the Machine invoking that Agent takes from below the Agent's state, the sources of a
   * reply or a child's error (a nested Agent's pick, a Gate's answer, a child's output or error).
   */
  private pickCause(
    runId: string,
    holds: Map<string, Hold>,
    target: AnyActorRef,
    source: AnyActorRef | undefined,
    event: AnyEventObject,
  ): Set<Registration> | undefined {
    const out = new Set<Registration>();
    const sending = this.sending;
    if (sending && sending.reg.runId === runId && sending.reg.invoker === target && event.type === sending.pick) {
      out.add(sending.reg);
    }
    const picking: Registration[] = [];
    if (sending && sending.reg.runId === runId) picking.push(sending.reg);
    for (const hold of holds.values()) {
      if (hold.answer !== undefined) continue;
      const live = this.table.lookup(agentAddress(hold.instanceId));
      const reg = this.holdRegs.get(hold) ?? live;
      if (reg !== undefined && reg === live) picking.push(reg);
    }
    for (const reg of picking) {
      if (reg.invoker !== target || !reg.invokeId) continue;
      const seat = seatOf(target.getSnapshot() as AnyMachineSnapshot, reg.invokeId);
      if (!seat) continue;
      if (
        replyOf(event, source, target, seat) !== undefined ||
        childErrorOf(event, source, target, seat) !== undefined
      ) {
        out.add(reg);
      }
    }
    return out.size > 0 ? out : undefined;
  }

  /**
   * Answer every outstanding pick of `run` that can be answered now (ADR-0024). Called by the persist that
   * follows every transition — a microtask after the snapshot, so the mailbox has drained — and
   * before any read of a hold, so no reader sees a hold the Machine already answered.
   *
   *   - The Agent's state is busy: still outstanding.
   *   - Back at Rest in it: answered with the last reply since the pick and the Allowed picks read
   *     AFTER the route — the guards read the context the route wrote (ADR-0029).
   *   - It left the Agent's state (the registration is gone, or is another invocation's): the Turn
   *     is over, and the answer goes as a notice to the next Turn of the conversation the picking
   *     Turn continued; a fresh picking Turn's answer goes nowhere (ADR-0062).
   */
  private settleHolds(run: LiveRun): void {
    for (const hold of run.holds.values()) {
      if (hold.answer !== undefined) continue;
      const reg = this.table.lookup(agentAddress(hold.instanceId));
      let same = reg !== undefined && reg.runId === run.record.runId && reg.invokeId === hold.invokeId;
      if (same) {
        const opened = this.holdRegs.get(hold);
        if (opened === undefined) this.holdRegs.set(hold, reg!);
        else same = opened === reg;
      }
      const reading = same ? restOf(reg!) : "gone";
      if (reading === "busy") continue;
      // The answer's default is the last reply since the pick, whatever moved the Machine after it
      // (ADR-0024); with none, the answer carries no reply. Never `straightBack`: an outstanding
      // pick's work was running, so "nothing ran" is not this answer's to say.
      const answered = answerOf(hold);
      const answer = answered ? { answer: answered } : {};
      if (reading === "gone") {
        // Left by the route of the last reply — its own events and the events it sent itself at once
        // included — or by something else while work below still ran (a timer the Machine set, an
        // outside event): then the exit stopped that work, and the answer says so. It keeps the last
        // reply an earlier link gave.
        const stopped = hold.cutShort === true ? { stopped: true as const } : {};
        hold.answer = { turnComplete: true, allowed: [], ...answer, ...stopped };
        if (hold.conversation !== undefined) {
          run.notices.raise(
            {
              kind: "pick-answer",
              scope: "conversation",
              pick: hold.pick,
              cut: false,
              ...answer,
              ...stopped,
            },
            hold.conversation,
          );
        }
      } else {
        hold.answer = { turnComplete: false, allowed: allowedOf(reg!), ...answer };
      }
      // The answer is fixed: nothing reads the chain or the shaped value again, so the next save
      // drops them. A loop below the Agent's state grows the blob by its tails only while one pick
      // is outstanding (ADR-0067, ADR-0065).
      delete hold.chain;
      delete hold.shaped;
      this.closeHold(hold);
    }
  }

  /**
   * The pick an `answer` action in `machine` shapes (ADR-0067), from `seat`, the one place it runs
   * from (`placeAnswers`). At an Agent's state: only a pick of the Agent seated there — the one in
   * its own send, else the one outstanding. On a transition below no Agent's state (`null`): the
   * event that took the transition names the Agent — the sender of a pick, or the Agent whose pick
   * started the child whose done or error event it is — and that Agent's pick is the one shaped, and
   * no other; none when that Agent has no pick being answered. When one slot is invoked by two
   * states, the event names an invoke too, and only the pick at that invoke is shaped: the sending
   * pick, or the pick at the invoke whose pick started the child; none when that pick is not being
   * answered (its Turn ended, and its child runs on). An event that names no Agent (a timer,
   * a Gate's answer, an outside send) shapes the pick in its own send. Outside one, it shapes the one
   * outstanding pick only while one Agent's state is active; while two Agents' states are active it
   * shapes none, whatever is outstanding: the event cannot say whose pick it is, and the other
   * Agent's pick keeps its default answer.
   */
  private answeringIn(
    machine: AnyActorRef,
    seat: AnswerSeat,
    runId: string,
    holds: Map<string, Hold>,
    childAgents: Record<string, ChildAgent>,
    event?: AnyEventObject,
  ): Sending | Hold | undefined {
    const seatedFor = (reg: Registration | undefined): boolean => {
      if (reg?.invoker !== machine) return false;
      if (seat === null) return true;
      const snapshot = machine.getSnapshot() as AnyMachineSnapshot;
      return reg.invokeId !== undefined && seatOf(snapshot, reg.invokeId) === seat;
    };
    const regOf = (hold: Hold): Registration | undefined =>
      this.holdRegs.get(hold) ?? this.table.lookup(agentAddress(hold.instanceId));
    const sending = this.sending && this.sending.reg.runId === runId ? this.sending : undefined;
    const open = [...holds.values()].filter((hold) => hold.answer === undefined && seatedFor(regOf(hold)));
    if (seat === null && event !== undefined) {
      const named = agentOfEvent(event, childAgents, machine, sending);
      if (named !== undefined) {
        const { agent } = named;
        const own = sending && sending.reg.sender?.id === agent ? sending : undefined;
        // That Agent's picks being answered: the one in its own send, and the ones outstanding at
        // its other invokes (one slot invoked by two states). The event names the invoke of the
        // pick that sent it or started its child, and only the pick at that invoke is shaped; none
        // when that pick is not being answered, and each other pick keeps its default answer.
        const held = open.filter((hold) => hold.agent === agent && hold.instanceId !== own?.reg.id);
        const picks = [...(own ? [own] : []), ...held];
        const at = (pick: Sending | Hold): string | undefined =>
          pick === own ? own.reg.invokeId : (pick as Hold).invokeId;
        const same = named.invoke === undefined ? picks : picks.filter((pick) => at(pick) === named.invoke);
        if (same.length !== 1) return undefined;
        const pick = same[0]!;
        if (pick === own) return seatedFor(own.reg) ? own : undefined;
        return pick;
      }
    }
    if (sending && seatedFor(sending.reg)) return sending;
    if (seat === null && activeAgentStates(machine.getSnapshot() as AnyMachineSnapshot) > 1) return undefined;
    return open.length === 1 ? open[0] : undefined;
  }

  /**
   * The Agent whose outstanding pick holds the child `childId` that `machine` just started, or
   * undefined: the child is invoked on a state strictly below that Agent's state, so by the Rest rule
   * it is that pick's work (ADR-0024). Below two such states (one Agent's state inside another's),
   * it is the work of the nearer one's pick. `snapshot` is `machine`'s snapshot after the step.
   */
  private outstandingAbove(
    machine: AnyActorRef,
    snapshot: AnyMachineSnapshot,
    childId: string,
    holds: Map<string, Hold>,
  ): ChildAgent | undefined {
    const node = seatOf(snapshot, childId);
    if (node === undefined) return undefined;
    const byState = new Map<unknown, ChildAgent>();
    for (const hold of holds.values()) {
      if (hold.answer !== undefined) continue;
      const reg = this.holdRegs.get(hold) ?? this.table.lookup(agentAddress(hold.instanceId));
      if (reg?.invoker !== machine || reg.invokeId === undefined) continue;
      const agentState = seatOf(snapshot, reg.invokeId);
      if (agentState !== undefined) byState.set(agentState, { agent: hold.agent, invoke: reg.invokeId });
    }
    // The nearest Agent's state above the child: with B's state inside A's, the child is B's work.
    for (let n = node.parent; n; n = n.parent) {
      const starter = byState.get(n);
      if (starter !== undefined) return starter;
    }
    return undefined;
  }

  /** Wake every long poll on a hold: it was answered, replaced, or the host is going away. */
  private closeHold(hold: Hold | undefined): void {
    if (hold === undefined) return;
    const waiters = this.holdWaiters.get(hold);
    this.holdWaiters.delete(hold);
    for (const wake of waiters ?? []) wake();
  }

  /** An outstanding pick's delivery: its run and hold, by Agent address and delivery id. */
  private holdAt(instanceId: string, deliveryId: string): { run: LiveRun; hold: Hold } | undefined {
    for (const run of this.runs.values()) {
      const hold = run.holds.get(instanceId);
      if (hold?.deliveryId === deliveryId) return { run, hold };
    }
    return undefined;
  }

  /** Is this delivery an outstanding pick of a run this host parked? Its poll is asked again. */
  parkedDelivery(instanceId: string, deliveryId: string): boolean {
    return this.parked.has(`${instanceId} ${deliveryId}`);
  }

  /** The pod and slot that may read a delivery's answer (ADR-0013, ADR-0076), or undefined for an
   * unknown one. */
  deliveryScope(instanceId: string, deliveryId: string): { sandbox?: string; slot?: string } | undefined {
    const found = this.holdAt(instanceId, deliveryId);
    return (
      found && {
        ...(found.hold.sandbox !== undefined ? { sandbox: found.hold.sandbox } : {}),
        ...(found.hold.slot !== undefined ? { slot: found.hold.slot } : {}),
      }
    );
  }

  /**
   * One long poll of an outstanding pick's answer (`GET /agents/:iid/deliveries/:id` — ADR-0013, ADR-0024):
   * the answer when the workflow is back at Rest in the Agent's state or has left it, else
   * `outstanding` after at most `waitMs`, and the Harness asks again. Undefined for a delivery this
   * host does not hold — a pick that was never outstanding, or a run that ended.
   *
   * `signal` is the poll's connection. A poll whose caller went away (a killed Harness) ends then,
   * `outstanding`, and never marks the answer read: no model read it, so the re-admission after
   * the restart must still carry it (ADR-0031).
   */
  async awaitDelivery(
    instanceId: string,
    deliveryId: string,
    waitMs = 25_000,
    signal?: AbortSignal,
  ): Promise<AgentDeliveryReceipt | undefined> {
    const found = this.holdAt(instanceId, deliveryId);
    if (!found) return undefined;
    const { run, hold } = found;
    this.settleHolds(run);
    if (hold.answer === undefined && !this.#stopping && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        let waiters = this.holdWaiters.get(hold);
        if (!waiters) this.holdWaiters.set(hold, (waiters = new Set()));
        const timer = setTimeout(wake, waitMs);
        signal?.addEventListener("abort", wake, { once: true });
        function wake(): void {
          clearTimeout(timer);
          signal?.removeEventListener("abort", wake);
          waiters!.delete(wake);
          resolve();
        }
        waiters.add(wake);
      });
    }
    const base = { delivered: true as const, event: hold.pick, moved: true, deliveryId };
    if (hold.answer === undefined || signal?.aborted) {
      return { ...base, turnComplete: false, allowed: [], outstanding: true, since: hold.since };
    }
    hold.fetched = true;
    return {
      ...base,
      turnComplete: hold.answer.turnComplete,
      allowed: hold.answer.allowed,
      answered: true,
      ...(hold.answer.answer !== undefined ? { answer: hold.answer.answer } : {}),
      ...(hold.answer.stopped ? { stopped: true as const } : {}),
    };
  }

  /** A run's open gates as callers discover them (`GET /runs/:id` — ADR-0011). Settled/unknown
   * run → empty: a gate is a LIVE surface, it does not outlive its state. */
  gates(runId: string): GateView[] {
    return this.table
      .byRun(runId)
      .filter((reg) => reg.kind === "gate")
      .map((reg) => ({
        gate: reg.id,
        path: reg.path ?? [],
        accepts: [...reg.defs.values()].map((def) => ({
          name: def.name,
          description: def.description,
          input: z.toJSONSchema(def.input),
        })),
        acceptsNow: acceptsNow(reg),
        meta: reg.meta,
      }));
  }

  /**
   * Deliver one external event to a run's open gate (`POST /runs/:id/gates/:gate/events`).
   * Validation and delivery are the table's — this run-scopes the address, and returns only when
   * the run TOOK the event (ADR-0013): one that would run another party's writing, or that no
   * writing would take with this payload, throws {@link NotTakenError} naming what the Gate takes
   * now, and nothing is delivered.
   *
   * `by` is the Caller that answers (ADR-0078). The event's Sender carries it, with the fields that
   * jr2 checked (ADR-0011), and the run records it as the answer's `answeredBy`.
   */
  sendToGate(
    runId: string,
    gate: string,
    event: { type?: unknown } & Record<string, unknown>,
    by?: CallerRecord,
    delivery?: string,
  ): void {
    const { type, ...payload } = event;
    if (typeof type !== "string" || !type) {
      throw new EventValidationError(`event body must carry a string "type" (one of the gate's accepted names)`);
    }
    const reg = this.table.lookup(gateAddress(runId, gate));
    const refused = (why: string): NotTakenError =>
      new NotTakenError(
        `gate "${gate}" is open, and the run does not take "${type}" now: ${why} — not delivered ` +
          `(takes now: ${reg ? acceptsNow(reg).join(", ") || "nothing" : "nothing"})`,
      );
    try {
      // Exact, with the validated payload: a send no writing would move on is refused, never
      // answered `{ ok: true }`. A bad payload or an unaccepted name falls through to the table,
      // which refuses it with its own words.
      const def = reg?.defs.get(type);
      const parsed = def && !(payload && SENDER_KEY in payload) ? def.input.safeParse(payload ?? {}) : undefined;
      const caller = by ? senderCallerOf(by) : undefined;
      const sender = reg?.sender && caller ? { ...reg.sender, ...caller } : reg?.sender;
      if (reg && parsed?.success && !wouldMove(reg.invoker, { type, ...parsed.data, [SENDER_KEY]: sender })) {
        throw refused("no writing of it would move the run with this payload");
      }
      this.table.deliver(gateAddress(runId, gate), type, payload, caller);
      // Taken: the run records who answered (ADR-0078), in the save that this transition schedules.
      const run = this.runs.get(runId);
      if (run && by) {
        run.answers.push({
          gate,
          type,
          at: new Date(this.now()).toISOString(),
          answeredBy: by,
          ...(delivery !== undefined ? { delivery } : {}),
        });
        if (run.answers.length > GATE_ANSWERS_KEPT) run.answers.splice(0, run.answers.length - GATE_ANSWERS_KEPT);
      }
    } catch (err) {
      if (err instanceof NotTakenError && err.writings.length) {
        throw refused(
          err.writings
            .map(
              (w) =>
                `it would run the writing on "${w.state}"${w.owners.length ? `, which is ${w.owners.map(senderText).join(" and ")}'s` : ""}`,
            )
            .join("; "),
        );
      }
      if (err instanceof UnknownAddressError) {
        const open = this.gates(runId).map((g) => g.gate);
        throw new UnknownAddressError(
          `no open gate "${gate}" on run "${runId}"${open.length ? ` (open: ${open.join(", ")})` : ""}`,
        );
      }
      throw err;
    }
  }

  /**
   * A Hook's fan-in (ADR-0011): give one delivery to every open Gate, in every live run of a Workflow
   * that `may` names, whose handlers hear `kind` and `key`, and to nothing else. Each handler reads
   * `{ payload, meta, caller }` and gives one event of its Gate's `delivers`, or `undefined` (not a
   * target: `ignored`). The event goes in as `jr2 send` sends it, with the Hook as its Caller, and
   * the run records the answer with the delivery's id. A handler that throws, an event that is not
   * in `delivers`, and an event that the run does not take now are each a line in `refused` and a
   * `hook-refused` mark on that run's feed: the run goes on. A Gate that already took this delivery
   * (a pair in the run's answers) is passed over, so a restore never gives it twice.
   *
   * Synchronous, as a handler is: the registrations are read once, and a Gate that a delivery before
   * it in the same fan-in closed is passed over.
   */
  async deliverHook(d: {
    hook: string;
    kind: string;
    key: string;
    delivery: string;
    payload: unknown;
    caller: CallerRecord;
    may: (workflow: string) => boolean;
    /** A person reads the answer (ADR-0011): run the `reply` of each target. */
    person?: boolean;
  }): Promise<HookFanIn> {
    const out: HookFanIn = { delivered: [], refused: [], ignored: 0, sources: [] };
    const replies: HookReply[] = [];
    const targets: Array<{ run: LiveRun; reg: Registration; handler: AnyHandler }> = [];
    const sources: Array<{ run: LiveRun; reg: Registration }> = [];
    for (const run of this.runs.values()) {
      if (!d.may(run.record.workflow)) continue;
      for (const reg of this.table.byRun(run.record.runId)) {
        if (reg.kind !== "gate") continue;
        const handler = reg.hooked?.hooks[d.kind]?.[d.key];
        if (handler) targets.push({ run, reg, handler });
        if (reg.source?.hears(d.kind, d.key)) sources.push({ run, reg });
      }
    }
    for (const { run, reg, handler } of targets) {
      const runId = run.record.runId;
      // Closed by an earlier target of this fan-in, or the run ended.
      if (this.table.lookup(reg.address) !== reg || this.runs.get(runId) !== run) continue;
      if (run.answers.some((a) => a.delivery === d.delivery && a.gate === reg.id)) continue;
      // The Gate's `reply` runs after the run answers, from that Gate's own outcome (ADR-0011).
      const gateReply = d.person ? reg.hooked?.reply : undefined;
      const place = { target: "gate" as const, workflow: run.record.workflow, run: runId, gate: reg.id };
      const meta = reg.meta;
      const refuse = (reason: string, event?: string, given?: unknown): void => {
        out.refused.push({ run: runId, gate: reg.id, ...(event !== undefined ? { event } : {}), reason });
        if (gateReply) {
          const outcome = {
            state: "refused" as const,
            ...(given !== undefined ? { event: given } : {}),
            reason,
            run: runId,
          };
          replies.push(runReply(place, () => gateReply(outcome as never, { meta, caller: d.caller })));
        }
        this.feed(run, {
          kind: "hook-refused",
          hook: d.hook,
          delivery: d.delivery,
          gate: reg.id,
          ...(event !== undefined ? { event } : {}),
          reason,
        });
      };
      let event: unknown;
      try {
        event = handler({ payload: d.payload, meta: reg.meta, caller: d.caller });
      } catch (err) {
        refuse(`its handler threw: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (event === undefined) {
        out.ignored++;
        continue;
      }
      const type = (event as { type?: unknown } | null)?.type;
      if (typeof type !== "string" || !reg.hooked?.delivers.includes(type)) {
        refuse(
          `its handler gave ${typeof type === "string" ? `"${type}"` : "no event type"}, which is not in the Gate's ` +
            `delivers (${reg.hooked?.delivers.join(", ")})`,
          typeof type === "string" ? type : undefined,
        );
        continue;
      }
      try {
        this.sendToGate(runId, reg.id, event as { type: string } & Record<string, unknown>, d.caller, d.delivery);
      } catch (err) {
        refuse(err instanceof Error ? err.message : String(err), type, event);
        continue;
      }
      out.delivered.push({ run: runId, workflow: run.record.workflow, gate: reg.id, event: type });
      if (gateReply) {
        const outcome = { state: "delivered" as const, event, run: runId };
        replies.push(runReply(place, () => gateReply(outcome as never, { meta, caller: d.caller })));
      }
    }
    // The Sources (ADR-0017), after the Gates: each one's handler, its key check and its hold. A
    // held item is durable before the answer leaves, so the run is saved before the next line.
    // A hand-over can end a standing run while a Source awaits (its key lookup, or an earlier
    // Source's save): the bound, a publish or the age timer. The start and the end of a hand-over are
    // one synchronous step, so the delivery goes on to the new run's Source; with no live run, the
    // last step below answers `paused` or `waiting` (503), and the delivery claims nothing.
    const handedOn: string[] = [];
    for (const first of sources) {
      let { run, reg } = first;
      for (let hops = 0; ; hops++) {
        const runId = run.record.runId;
        if (this.table.lookup(reg.address) !== reg || this.runs.get(runId) !== run) {
          const next = this.standingSourceAfter(run, d.kind, d.key);
          if (!next) break;
          if (hops >= STANDING_HOPS) {
            handedOn.push(run.record.workflow); // the door answers 503, and the delivery claims nothing
            break;
          }
          ({ run, reg } = next);
          continue;
        }
        const seat = reg.source!;
        const { item, ...line } = await seat.hear({
          hook: d.hook,
          kind: d.kind,
          key: d.key,
          delivery: d.delivery,
          payload: d.payload,
          caller: d.caller,
        });
        // A skip from a run that ended while it was heard: ask the new run's Source.
        if (line.verdict === "skipped" && this.runs.get(runId) !== run && this.isStanding(run.record.workflow)) {
          continue;
        }
        out.sources.push({ pool: runId, workflow: run.record.workflow, source: reg.id, ...line });
        if (line.verdict === "held" && this.runs.get(runId) === run) await this.persist(run);
        if (d.person && seat.reply) {
          const place = { target: "source" as const, workflow: run.record.workflow, run: runId, gate: reg.id };
          const verdict = { ...line, ...(item !== undefined ? { item } : {}) };
          const said = runReply(place, () => seat.reply!(verdict, d.caller));
          replies.push(line.verdict === "skipped" ? { ...said, skipped: true } : said);
        }
        break;
      }
    }
    // A standing Pool with no live run (ADR-0017): a paused one says `paused` and holds nothing, so a
    // read Source finds the item at the resume; one in its back-off makes the door answer 503, so
    // the service sends the delivery again.
    const without = this.standingWithoutRun(d.kind, d.key, d.may);
    for (const p of without.paused) {
      out.sources.push({ pool: p.run, workflow: p.workflow, source: "source", verdict: "paused" });
    }
    const waiting = [...new Set([...without.waiting, ...handedOn])];
    if (waiting.length) out.waiting = waiting;
    if (d.person) out.replies = replies;
    return out;
  }

  /**
   * Observe a live run's feed (the `GET /runs/:id/events` SSE — ADR-0009): status deltas after every
   * transition, plus the author's `emit`s. Returns an unsubscribe fn. The current status is **replayed
   * immediately** on attach, so a freshly-attached watcher sees where the run is now (e.g. parked on an
   * approval) rather than waiting for the next transition. The final status is emitted on the terminal
   * transition right before the run is dropped from the registry. Attaching to an unknown/settled run
   * is a no-op — read its terminal status via {@link read} instead.
   */
  subscribe(runId: string, listener: (e: RunFeedEvent) => void): () => void {
    const run = this.runs.get(runId);
    if (!run) return () => {};
    run.listeners.add(listener);
    // The status the feed last carried, the SAME object for every attach, so http.ts renders the
    // replay once however many readers attach — a reconnect after a close is the common attach
    // (ADR-0022). A transition not yet persisted follows on the feed within the microtask.
    listener(run.latestStatus ?? { kind: "status", status: this.liveStatus(run) });
    return () => run.listeners.delete(listener);
  }

  /**
   * Hear once that a run is no longer live (ADR-0071): `listener` gets its last status — `done`,
   * `failed`, `error` or `cancelled` with its `output`, or the store's `lost` or `drifted` — and is
   * then dropped. Returns the detach. What an in-process `dispatch` with `wait` waits on.
   *
   * Keyed by the run id, not by the run's hosting, so the order of a restore does not matter: a
   * caller restored before its callee attaches to a run this process does not host yet, and hears
   * it when the restored callee settles, or when restore marks it lost or drifted. A run that has
   * settled already is answered at once, from {@link read}. `subscribe` is the feed, and unchanged:
   * it attaches only to a hosted run.
   */
  onSettled(runId: string, listener: (status: RunStatus) => void): () => void {
    let listeners = this.settleListeners.get(runId);
    if (!listeners) this.settleListeners.set(runId, (listeners = new Set()));
    // Its own entry, so one listener attached twice is heard twice and detached once each.
    const entry = (status: RunStatus): void => listener(status);
    listeners.add(entry);
    const attached = (): boolean => this.settleListeners.get(runId)?.has(entry) === true;
    const detach = (): void => {
      const now = this.settleListeners.get(runId);
      now?.delete(entry);
      if (now?.size === 0) this.settleListeners.delete(runId);
    };
    if (!this.runs.has(runId)) {
      // Not hosted: settled already, or a live row a restore has not reached. Only the first is
      // answered here; a settle heard in the meantime has detached the entry.
      this.read(runId).then(
        (status) => {
          if (!status || !attached() || !settledStatus(status.status)) return;
          detach();
          hear(entry, status);
        },
        () => {},
      );
    }
    return detach;
  }

  /** A hosted run's depth in a chain of dispatches (ADR-0071): 0 for a run nothing dispatched, and
   * undefined for a run this process does not host — not hosted is not a root run. */
  depthOf(runId: string): number | undefined {
    const run = this.runs.get(runId);
    return run && (run.record.dispatchedBy?.depth ?? 0);
  }

  /** Tell everything waiting on `runId` that it settled, once (ADR-0071). */
  private fireSettled(runId: string, status: RunStatus): void {
    const listeners = this.settleListeners.get(runId);
    if (!listeners) return;
    this.settleListeners.delete(runId);
    for (const listener of listeners) hear(listener, status);
  }

  /**
   * A run restore did not host settled: marked `lost` (its status is the row's identity and reason
   * alone: a lost run is not read back, though a row that was saved keeps its blob and its key) or
   * `drifted` (its snapshot is read back).
   * Only when something waits on it (ADR-0071).
   */
  private settledUnhosted(runId: string, status: "lost" | "drifted", reason: string, blob?: RunBlob): void {
    if (!this.settleListeners.has(runId)) return;
    const bare: RunStatus = {
      runId,
      workflow: blob?.workflow ?? "",
      instanceId: blob?.instanceId ?? "",
      ...(blob?.dispatchedBy ? { dispatchedBy: blob.dispatchedBy } : {}),
      ...(blob?.startedBy ? { startedBy: blob.startedBy } : {}),
      status,
      value: undefined,
      context: undefined,
      children: [],
      waiting: [],
      held: [],
      reason,
    };
    if (status === "lost") return this.fireSettled(runId, bare);
    this.read(runId).then(
      (read) => this.fireSettled(runId, read ?? bare),
      () => this.fireSettled(runId, bare),
    );
  }

  /** The binding's `dispatch.settled` (ADR-0071): {@link onSettled} as a promise that an abort —
   * the Effect's state exiting, its wait timing out — rejects and detaches. */
  private settledOf(runId: string, signal: AbortSignal): Promise<RunStatus> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      let detach = (): void => {};
      const onAbort = (): void => {
        detach();
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      detach = this.onSettled(runId, (status) => {
        signal.removeEventListener("abort", onAbort);
        resolve(status);
      });
    });
  }

  /**
   * Observe a whole WORKFLOW (the `GET /workflows/:name/events` SSE — ADR-0022): every run of it
   * appearing, moving, emitting and leaving, for as long as the caller stays attached.
   *
   * The current set is RETURNED rather than replayed through the listener, and the subscription is
   * registered in the same synchronous call. That is the whole point of the signature: split into
   * a list-then-subscribe pair, a run starting between the two calls appears in neither, and the
   * watcher is quietly wrong until something else happens to move it.
   *
   * Subscribing to a NAME, not to a registration — an unknown workflow attaches to an empty set
   * (a later registration may supply it, and the feed should just start working).
   */
  observeWorkflow(workflow: string, listener: WorkflowListener): { runs: RunStatus[]; unsubscribe: () => void } {
    let listeners = this.workflowListeners.get(workflow);
    if (!listeners) this.workflowListeners.set(workflow, (listeners = new Set()));
    listeners.add(listener);
    return {
      runs: this.list().filter((s) => s.workflow === workflow),
      unsubscribe: () => {
        listeners.delete(listener);
        // Drop the empty Set, but ONLY if the map still holds this one. A stale unsubscribe (called
        // twice, or after `close()`) would otherwise evict whatever Set replaced it under the same
        // name — silently orphaning a watcher that has nothing to do with this one.
        if (listeners.size === 0 && this.workflowListeners.get(workflow) === listeners) {
          this.workflowListeners.delete(workflow);
        }
      },
    };
  }

  /** How many observers a workflow's feed currently has. Exists so a test can prove that a client
   * going away actually DETACHES — a leak here is invisible until the process runs out of memory. */
  observerCount(workflow: string): number {
    return this.workflowListeners.get(workflow)?.size ?? 0;
  }

  /** Feed one workflow's observers. The projection to the wire happens in http.ts, not here. */
  private announce(workflow: string, event: WorkflowFeedEvent): void {
    for (const listener of this.workflowListeners.get(workflow) ?? []) listener(event);
  }

  /** A run's LIVE status — undefined once it settles and is dropped from the registry. Sync. */
  status(runId: string): RunStatus | undefined {
    const run = this.runs.get(runId);
    return run && this.liveStatus(run);
  }

  /**
   * Read a run's status, **reading through to the store** when it is no longer live (ADR-0009). A
   * completed run's final snapshot is persisted before `persist()` drops it from the registry, so a
   * terminal run reports its `done`/`error` status + final context here rather than 404-ing. Returns
   * undefined only for a genuinely unknown run (or one marked `lost` with no row saved before, so no
   * snapshot: `markLost` keeps a saved row's blob, whose key must keep answering, ADR-0071) — and a
   * swept one is unknown: a finished run's row lives a week (ADR-0065).
   */
  async read(runId: string): Promise<RunStatus | undefined> {
    const live = this.status(runId);
    if (live) return live;
    const stored = await this.store.load(runId);
    const blob = stored?.snapshot as RunBlob | null | undefined;
    if (!stored || !blob) return undefined;
    const snap = (blob.snapshot ?? {}) as { status?: string; value?: unknown; context?: unknown; output?: unknown };
    // The STORE row is the authority on the run's lifecycle, the snapshot on the Machine's: a
    // cancelled run's actor reports xstate's "stopped", which is mechanism, not an outcome
    // (ADR-0025). While the row still says "live", the Machine's own status is the answer.
    const status = stored.status === "live" ? (snap.status ?? stored.status) : stored.status;
    return {
      runId,
      workflow: blob.workflow,
      instanceId: blob.instanceId,
      status,
      value: snap.value,
      context: snap.context,
      children: runChildren(snap), // the persisted `children` map — same tree, off the store
      waiting: status === "active" ? runWaiting(snap) : [],
      held: status === "active" ? heldOf(blob.holds ?? []) : [],
      fault: blob.fault,
      reason: stored.reason,
      ...(blob.assembly !== undefined ? { assembly: blob.assembly } : {}),
      ...boundFields(snap),
      ...(blob.dispatchedBy ? { dispatchedBy: blob.dispatchedBy } : {}),
      ...(blob.startedBy ? { startedBy: blob.startedBy } : {}),
      ...(blob.resumedBy ? { resumedBy: blob.resumedBy } : {}),
      ...(blob.cancelledBy ? { cancelledBy: blob.cancelledBy } : {}),
      ...(blob.handedOverTo ? { handedOverTo: blob.handedOverTo } : {}),
      ...(blob.answers?.length ? { answers: blob.answers } : {}),
      ...steeringOf(blob.notices?.steering ?? []),
      // The Machine's output once the row says the run is over (ADR-0071), never while it is live;
      // for a failed run, its Failure (ADR-0073).
      ...(stored.status !== "live" && blob.failure !== undefined ? { output: blob.failure } : {}),
      ...(stored.status !== "live" && blob.failure === undefined && snap.output !== undefined
        ? { output: snap.output }
        : {}),
      ...dispatchedField(blob.effects ?? {}),
      ...worktreesField(blob.effects ?? {}),
    };
  }

  /**
   * The first Caller of a run's chain of starts (ADR-0078): its `startedBy` when that is a Caller,
   * else the first Caller of the run that dispatched it, and so on, live or stored. Undefined when
   * jr2 started the chain, or a run of it is no longer known. `jr2 status` walks the same chain.
   */
  async firstCaller(runId: string): Promise<CallerRecord | undefined> {
    const seen = new Set<string>();
    for (let id: string | undefined = runId; id !== undefined && !seen.has(id); ) {
      seen.add(id);
      const by: RunStarter | undefined = (await this.read(id))?.startedBy;
      if (by?.kind === "caller") {
        const { kind: _kind, ...caller } = by;
        return caller;
      }
      id = by?.kind === "run" ? by.run : undefined;
    }
    return undefined;
  }

  list(): RunStatus[] {
    return [...this.runs.keys()].map((id) => this.status(id)).filter((s): s is RunStatus => s !== undefined);
  }

  /**
   * Run ids sharing a prefix — the live registry unioned with the store — backing abbreviated run
   * ids in the CLI (ADR-0009). The live half is not belt-and-braces: `persist()` is scheduled on a
   * microtask, so a just-started run is in `runs` before it is anywhere in the store. The store
   * half is what makes a settled run abbreviate-able. A run past its first transition sits in both,
   * hence the `Set`.
   */
  async candidates(prefix: string, limit: number): Promise<string[]> {
    const live = [...this.runs.keys()].filter((id) => id.startsWith(prefix));
    const stored = await this.store.findIdsByPrefix(prefix, limit);
    return [...new Set([...live, ...stored])].sort().slice(0, limit);
  }

  /** The live runs of ONE workflow, projected for observers (the Console's run list). Scoped
   * server-side: an observer asks about a workflow it can already name, and gets back only runs of
   * it — never a listing of everything this orchestrator happens to be running. */
  observations(workflow: string): RunObservation[] {
    return this.list()
      .filter((s) => s.workflow === workflow)
      .map(observe);
  }

  /** The host is going away (`close()` has begun): its Turns are not over, and the Agents' surface
   * must not say they are (ADR-0026). */
  get stopping(): boolean {
    return this.#stopping;
  }

  /** The live rows of a prior process are not restored yet: a boot with no current Assembly
   * deferred their restore to the first publish (ADR-0069). Those Turns are not over, so the
   * Agents' surface must not say they are (ADR-0026). Set by `deferRestore`, cleared when a
   * `restore()` completes; a restore that throws as a whole leaves it set. */
  get restorePending(): boolean {
    return this.#restorePending;
  }

  /** Mark the restore deferred: until a `restore()` completes, `restorePending` is true. */
  deferRestore(): void {
    this.#restorePending = true;
  }

  /**
   * End every open feed because the host is going away — the shutdown counterpart to `subscribe`.
   *
   * A feed has no natural end: a run parked on a gate transitions for hours, and its watchers hold
   * an in-flight HTTP request the whole time. `server.close()` (instance.ts) waits for in-flight
   * requests, so without this a single attached `jr2 run` wedges shutdown indefinitely. `closed` is
   * the frame that lets those handlers exit. Runs themselves are untouched: this ends the
   * OBSERVATION, not the work — the snapshots are already durable, and `restore()` picks them up.
   */
  async close(): Promise<void> {
    // From here on the Orchestrator is going away, not its Turns: `/agents/*` answers 503, which a
    // Harness re-asks on ADR-0042's ladder, and never 404, which says a Turn is over (ADR-0026).
    this.#stopping = true;
    clearTimeout(this.liveSetTimer);
    // A run's timers stay armed (a run is untouched by a close), but none holds the process alive.
    for (const timer of this.timers) (timer as { unref?: () => void }).unref?.();
    // Every long poll answers `outstanding` now, so the server can close; the Harness asks again,
    // and a restarted Orchestrator answers it from the same hold (ADR-0024).
    for (const hold of [...this.holdWaiters.keys()]) this.closeHold(hold);
    for (const run of this.runs.values()) {
      for (const listener of run.listeners) listener({ kind: "closed" });
      run.listeners.clear();
    }
    for (const listeners of this.workflowListeners.values()) {
      for (const listener of listeners) listener({ kind: "closed" });
    }
    this.workflowListeners.clear();
  }

  /**
   * TEARDOWN: stop hosting a run in this process, leaving it RESTORABLE (ADR-0007/0025). The run
   * keeps its stored status "live", so the next `restore()` picks it up where it left off — which
   * is why this is ADR-0024's one exception: the Agents' submissions must stay alive for that
   * re-attach, and the actor cannot infer "the host did this", so the binding is told before the
   * stop.
   *
   * This is NOT the user's CANCEL — that is {@link cancel}, which ends the work. Nothing in a
   * deployed Orchestrator calls this today (process shutdown stops no actors: `instance.ts` ends
   * observation and nothing else); it is the teardown primitive, and the seam an orchestrator
   * restart is simulated through.
   */
  async stop(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.binding.hostStopping = true;
    // A parked run's outstanding picks are not over (ADR-0024): their polls are answered `503` —
    // ask again — never `404`, which tells the Harness its Turn ended. The host that restores the
    // run answers them from the saved holds.
    for (const hold of run.holds.values()) {
      if (hold.answer !== undefined) continue;
      this.parked.add(`${hold.instanceId} ${hold.deliveryId}`);
      this.closeHold(hold);
    }
    // Say so BEFORE the actor stops, while there is still a status to read. A stopped run is not a
    // settled one — `persist()` never runs for it (the tracked-run guard drops the scheduled save,
    // keeping the stored status "live" for restore — see `spawn`), so nothing else on this path
    // would ever tell a watcher the run left. Without it the page shows it live forever.
    this.announceGone(run);
    run.actor.stop();
    this.untrack(run.record);
  }

  /**
   * CANCEL: the human's "abandon this run" (`jr2 send <run> --event CANCEL` — ADR-0025). It ends
   * the work rather than parking it: stopping the actor with no `hostStopping` flag ends every
   * live Agent invocation, and each one ends its Agent's turn remotely (ADR-0024). The run
   * is then persisted TERMINAL, so `restore()` leaves it alone and `read()` reports how it ended.
   *
   * Ending the turns and refusing to restore are one decision, not two: a cancelled run that came
   * back would re-attach to submissions that settled `aborted`, and `settle`'s rejection would
   * fault a run whose Agents were stopped on purpose.
   *
   * It then destroys every Sandbox the run owns, unless `keep` (`jr2 send <run> --event CANCEL
   * --keep`): kept, they age out at the operator's idle timeout, and `jr2 ssh` reaches them until
   * then. A faulted run never comes through here, and keeps its Workspaces (ADR-0012).
   */
  async cancel(runId: string, opts: { keep?: boolean; by?: CallerRecord } = {}): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    // The Caller that cancelled it (ADR-0078), saved with the terminal snapshot below.
    if (opts.by) run.cancelledBy = opts.by;
    // Named BEFORE the stop, while the tree still says which Workspaces are live.
    const sandboxes = opts.keep ? [] : runSandboxes(run.actor, runId);
    run.actor.stop();
    // Persist AFTER the stop: the snapshot is final, and `persist` fans out the last status,
    // announces `gone`, and untracks — the same terminal path a run that settled on its own takes.
    this.persist(run, "cancelled");
    // The run is over, so nothing can use its Workspaces, and each holds its whole Size (ADR-0025).
    // An actor stop skips the wrapper's `teardown` state, so the host runs the same idempotent
    // delete here, after the stop, so no lease renews what was deleted. `keep` leaves them to the
    // operator's idle timeout, for inspection.
    await this.destroySandboxes(runId, sandboxes, "the cancel");
  }

  /**
   * End a run `error` because a Machine of its tree dropped a mechanism event (ADR-0074): `fault`
   * says which. The actor stops as a cancel stops it, so each live Agent's Turn ends, and the run
   * is persisted terminal. Its Sandboxes stay as evidence, as a fault's do (ADR-0012): the Machine
   * did not choose this end. Once per run: a second dropped event in the same step adds nothing.
   */
  private faultUnrouted(runId: string, binding: RunBinding, fault: string): void {
    const run = this.runs.get(runId);
    if (!run || run.binding !== binding || run.fault !== undefined) return;
    run.fault = fault;
    run.actor.stop();
    this.persist(run, "error");
  }

  /**
   * Delete the Sandboxes of a run that is over and stopped: a cancelled one (ADR-0025) and a failed
   * one (ADR-0073). After the stop, so no lease renews what was deleted. The delete is idempotent:
   * for a failed run, the Workspace a Failure went through deleted its own already, so this is a
   * backstop for the others. A delete that fails is the idle GC's, as in `teardown` (ADR-0012
   * backstop): the run has already ended. `why` names that end in the log line of a delete that
   * fails.
   */
  private async destroySandboxes(runId: string, sandboxes: readonly string[], why: string): Promise<void> {
    const port = this.sandbox;
    if (!port) return;
    await Promise.all(
      sandboxes.map((name) =>
        port.destroy(name).catch((err: unknown) => {
          console.error(
            `run ${runId}: Sandbox ${name} was not deleted at ${why} (the idle timeout will delete it): ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }),
      ),
    );
  }

  /** Feed a run's final word to both granularities: where it ended, then that it is gone. */
  private announceGone(run: LiveRun, status: RunStatus = this.liveStatus(run)): void {
    this.announce(run.record.workflow, { kind: "status", status });
    this.announce(run.record.workflow, { kind: "gone", runId: run.record.runId });
  }

  // --- standing Pools (ADR-0017) ---

  /** The heads of the standing Workflows, by Workflow. */
  private get heads(): Map<string, StandingHead> {
    if (!this.#heads) this.#heads = new Map(this.store.standingHeads().map((h) => [h.workflow, h]));
    return this.#heads;
  }

  private writeHead(head: StandingHead): void {
    this.heads.set(head.workflow, head);
    this.store.writeStanding(head);
  }

  /** Is `workflow` a standing Workflow of the registry: its Machine a standing Pool (ADR-0017)? */
  isStanding(workflow: string): boolean {
    return standingPoolOf(this.workflowDefs.get(workflow)?.machine) !== undefined;
  }

  /** The hosted runs of `workflow`, oldest first. */
  private hostedOf(workflow: string): LiveRun[] {
    return [...this.runs.values()].filter((r) => r.record.workflow === workflow);
  }

  /** The live standing run of `workflow`: the head when this process hosts it, else the newest
   * hosted run. */
  private standingRun(workflow: string): LiveRun | undefined {
    const hosted = this.hostedOf(workflow);
    const head = this.heads.get(workflow);
    return hosted.find((r) => r.record.runId === head?.run) ?? hosted.at(-1);
  }

  private clearStandingTimer(workflow: string): void {
    const timer = this.standingTimers.get(workflow);
    if (timer !== undefined) clearTimeout(timer);
    this.standingTimers.delete(workflow);
  }

  private setStandingTimer(workflow: string, ms: number, fn: () => void): void {
    this.clearStandingTimer(workflow);
    const timer = setTimeout(
      () => {
        this.standingTimers.delete(workflow);
        if (!this.#stopping) fn();
      },
      Math.max(0, ms),
    );
    // A day's bound never holds the process: the next boot arms it again from the head's `since`.
    (timer as { unref?: () => void }).unref?.();
    this.standingTimers.set(workflow, timer);
  }

  /** Arm the age bound of a standing Workflow's live run: at `since` + the bound, hand it over. */
  private armAge(workflow: string, run: LiveRun): void {
    const since = Date.parse(this.heads.get(workflow)?.since ?? "") || this.now();
    this.setStandingTimer(workflow, since + this.standingOpts.ageMs - this.now(), () => {
      if (this.runs.get(run.record.runId) === run && this.heads.get(workflow)?.run === run.record.runId) {
        this.handOverLive(run, "hand-over");
      }
    });
  }

  /**
   * Keep one live run of each standing Workflow under the current registry (ADR-0017). At boot,
   * after the restore, and at each publish, after the swap. A live run of an older Assembly (or of
   * another Machine) is handed over. A run that ended `error`, `drifted` or `lost` is handed over
   * from its blob. A paused Workflow gets no run, and nor does one in its back-off. A Workflow with
   * no head gets its first run, which records `why`.
   */
  async keepStanding(why: "boot" | "publish"): Promise<void> {
    for (const [workflow, def] of [...this.workflowDefs]) {
      if (!standingPoolOf(def.machine)) continue;
      try {
        await this.keepOne(workflow, def, why);
      } catch (err) {
        // One standing Workflow that cannot start is one Workflow, not the boot (ADR-0030).
        console.error(
          `standing workflow "${workflow}": no run was started: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async keepOne(workflow: string, def: WorkflowDef, why: "boot" | "publish"): Promise<void> {
    const head = this.heads.get(workflow);
    const live = this.standingRun(workflow);
    if (live) {
      if (head?.run !== live.record.runId) {
        this.writeHead({ workflow, run: live.record.runId, since: new Date(this.now()).toISOString(), streak: 0 });
      }
      // A hand-over at every publish: the Assembly is one hash, and a handler has no stamp of its own.
      if (live.def.assembly !== def.assembly || live.def.machine !== def.machine) {
        this.handOverLive(live, "hand-over");
      } else {
        this.armAge(workflow, live);
      }
      return;
    }
    if (head?.paused) return;
    if (this.standingTimers.has(workflow)) return; // in its back-off
    if (head) {
      if (this.unhosted.has(head.run)) return; // restore left it live to try again
      const stored = await this.store.load(head.run);
      const blob = stored?.snapshot as RunBlob | null | undefined;
      // A live row that this process does not host is not ended: never a second run beside it.
      if (stored?.status === "live") return;
      if (stored && blob) {
        if (stored.status === "cancelled") {
          this.writeHead({ ...head, paused: "cancel" });
          return;
        }
        this.handOverFrom(workflow, blob.snapshot, "hand-over", { streak: head.streak });
        return;
      }
    }
    this.startStanding(workflow, why, {});
  }

  /** Start a standing run with what a hand-over carries, and make it the head. */
  private startStanding(
    workflow: string,
    why: "boot" | "publish" | "hand-over" | "resume",
    opts: { context?: unknown; dropHeld?: boolean; resumedBy?: CallerRecord; streak?: number },
  ): { runId: string; instanceId: string } {
    this.clearStandingTimer(workflow);
    const carry = standingCarryOf(opts.context, { dropHeld: opts.dropHeld === true });
    const ids = this.startNow(workflow, { [HAND_OVER]: carry }, undefined, { kind: "jr2", why }, opts.resumedBy);
    this.writeHead({
      workflow,
      run: ids.runId,
      since: new Date(this.now()).toISOString(),
      streak: opts.streak ?? 0,
    });
    const run = this.runs.get(ids.runId);
    if (run) this.armAge(workflow, run);
    return ids;
  }

  /**
   * Hand a live standing run over (ADR-0017): start the new run with its held items and active keys,
   * and end it `done` with `handedOverTo`, in one synchronous step, so no delivery and no settle
   * falls between the two runs.
   */
  private handOverLive(run: LiveRun, why: "hand-over"): void {
    const workflow = run.record.workflow;
    const ids = this.startStanding(workflow, why, { context: run.actor.getSnapshot().context });
    run.handedOverTo = ids.runId;
    run.actor.stop();
    this.persist(run, "done");
  }

  /** Hand over from a run that is no longer live, by its saved context: `error`, `drifted`, `lost`,
   * or a paused run that a Caller resumes. */
  private handOverFrom(
    workflow: string,
    snapshot: unknown,
    why: "hand-over" | "resume",
    opts: { dropHeld?: boolean; resumedBy?: CallerRecord; streak?: number },
  ): { runId: string; instanceId: string } {
    const context = (snapshot as { context?: unknown } | null | undefined)?.context;
    return this.startStanding(workflow, why, { ...opts, context });
  }

  /**
   * What the end of a standing run means (ADR-0017), from `persist`: a cancel pauses the Workflow;
   * an `error` or a `failed` (ADR-0073) hands it over after the back-off, and so does a run that
   * took its bound with no run started. One rule for each of these ends: a run in which an item that
   * it took itself (not a carried key) started a run starts the count again, and any other run
   * counts. After 3 hand-overs from counted runs in a row, the next counted run pauses it. A
   * hand-over's own end, and a run that is not the head, mean nothing more.
   */
  private standingEnded(run: LiveRun, status: string): void {
    const workflow = run.record.workflow;
    const head = this.heads.get(workflow);
    if (head?.run !== run.record.runId || run.handedOverTo !== undefined) return;
    this.clearStandingTimer(workflow);
    if (status === "cancelled") {
      this.writeHead({ ...head, paused: "cancel" });
      return;
    }
    const atBound = run.boundWithNoRun === true;
    if (!atBound && status !== "error" && status !== "failed") return;
    // One rule for each end that counts: only a run in which an item that it took itself (not a
    // carried key) started a run starts the count again. Any other run is part of a poison loop.
    const streak = atBound || !tookOf(run).started ? head.streak + 1 : 0;
    if (streak > STANDING_ERRORS_PAUSE) {
      this.writeHead({ ...head, streak, paused: atBound ? "bound" : "errors" });
      const last = atBound ? `took its bound of ${this.standingOpts.dispatches} items` : `ended ${status}`;
      console.error(
        `standing workflow "${workflow}": paused — in ${streak} runs in a row, no item that the run took started a ` +
          `run, after ${STANDING_ERRORS_PAUSE} hand-overs; the last one ${last}; \`jr2 run ${workflow}\` resumes it (ADR-0017)`,
      );
      return;
    }
    this.writeHead({ ...head, streak });
    const context = run.actor.getSnapshot().context;
    this.setStandingTimer(workflow, this.standingOpts.backoffMs(Math.max(1, streak)), () => {
      if (this.heads.get(workflow)?.run !== run.record.runId || this.hostedOf(workflow).length > 0) return;
      if (!this.isStanding(workflow)) return;
      try {
        this.startStanding(workflow, "hand-over", { context, streak });
      } catch (err) {
        console.error(
          `standing workflow "${workflow}": the hand-over after ${atBound ? "the bound with no run started" : status} failed: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    });
  }

  /**
   * A live standing run that took its bound of items, each one a dispatch, is handed over after the
   * save that counted the last one (ADR-0017). When none of the items it took itself started a run
   * (a carried key's run does not count: it was started before), the
   * run ends `done` and the hand-over waits out the back-off, as after `error`: an item that ends
   * with no run is known only in its run's life, so a backlog of such items fills the bound again
   * in each new run, and a hand-over at once would loop with no pause and no end. While no item has
   * an answer yet (each one in flight), jr2 waits: the save of the first answer asks again.
   */
  private checkBound(run: LiveRun): void {
    const workflow = run.record.workflow;
    if (this.heads.get(workflow)?.run !== run.record.runId) return;
    // The items it took, not the keys a hand-over carried: each carried key is sent again, so a
    // count of its ledger's rows would hand a run with `cap` at the bound over again at once.
    if (standingTaken(run.actor.getSnapshot().context) < this.standingOpts.dispatches) return;
    const took = tookOf(run);
    if (!took.started && took.answered === 0) return;
    queueMicrotask(() => {
      if (this.runs.get(run.record.runId) !== run || this.heads.get(workflow)?.run !== run.record.runId) return;
      if (!this.isStanding(workflow)) return;
      if (tookOf(run).started) {
        this.handOverLive(run, "hand-over");
        return;
      }
      run.boundWithNoRun = true;
      run.actor.stop();
      this.persist(run, "done");
    });
  }

  /**
   * Resume a paused standing Workflow (ADR-0017): a hand-over from the run that the pause ended,
   * with its held items (none with `dropHeld`) and its active keys. The new run records the Caller
   * as `resumedBy`. Throws {@link StandingRefused} when the Workflow is live, or not paused.
   */
  async resumeStanding(
    workflow: string,
    by: CallerRecord,
    opts: { dropHeld?: boolean } = {},
  ): Promise<{ runId: string; instanceId: string }> {
    if (!this.isStanding(workflow)) throw new StandingRefused(`"${workflow}" is not a standing Workflow`);
    const live = this.standingRun(workflow);
    if (live) {
      throw new StandingRefused(
        `"${workflow}" is a standing Workflow, and its run ${live.record.runId} is live: jr2 keeps its run, and ` +
          "`jr2 run` only resumes a paused one (ADR-0017)",
      );
    }
    const head = this.heads.get(workflow);
    if (!head?.paused) {
      throw new StandingRefused(
        `"${workflow}" is a standing Workflow, and it is not paused: jr2 starts its next run after the back-off, and ` +
          "`jr2 run` only resumes a paused one (ADR-0017)",
      );
    }
    const blob = (await this.store.load(head.run))?.snapshot as RunBlob | null | undefined;
    // Asked again after the read: another resume may have started the run.
    if (this.standingRun(workflow) || !this.heads.get(workflow)?.paused) {
      throw new StandingRefused(`"${workflow}" was resumed a moment ago`);
    }
    return this.handOverFrom(workflow, blob?.snapshot, "resume", {
      resumedBy: by,
      dropHeld: opts.dropHeld === true,
      streak: 0,
    });
  }

  /** Each standing Workflow of the registry, as `jr2 up` and `jr2 status` print it (ADR-0017). */
  async standingView(): Promise<StandingView[]> {
    const out: StandingView[] = [];
    for (const [workflow, def] of this.workflowDefs) {
      const info = standingPoolOf(def.machine);
      if (!info) continue;
      const head = this.heads.get(workflow);
      const live = this.standingRun(workflow);
      const base = { workflow, pool: info.id, callee: info.callee };
      if (live) {
        const held = standingCarryOf(live.actor.getSnapshot().context).held.length;
        out.push({ ...base, state: "live", run: live.record.runId, held });
        continue;
      }
      let held = 0;
      if (head) {
        const blob = (await this.store.load(head.run).catch(() => null))?.snapshot as RunBlob | null | undefined;
        held = standingCarryOf((blob?.snapshot as { context?: unknown } | undefined)?.context).held.length;
      }
      out.push({
        ...base,
        state: head?.paused ? "paused" : "waiting",
        ...(head ? { run: head.run } : {}),
        held,
        ...(head?.paused ? { why: head.paused } : {}),
      });
    }
    return out;
  }

  /** The live run that took over from a standing run that a hand-over ended (ADR-0017), and its
   * Source's registration, or undefined when the Workflow does not stand or has no live run. */
  private standingSourceAfter(
    ended: LiveRun,
    kind: string,
    key: string,
  ): { run: LiveRun; reg: Registration } | undefined {
    const workflow = ended.record.workflow;
    if (!this.isStanding(workflow)) return undefined;
    const run = this.standingRun(workflow);
    if (!run || run === ended) return undefined;
    for (const reg of this.table.byRun(run.record.runId)) {
      if (reg.kind === "gate" && reg.source?.hears(kind, key)) return { run, reg };
    }
    return undefined;
  }

  /** The standing Workflows that hear a Hook's kind and key and have no live run (ADR-0017): the
   * paused ones, by their head, and the ones waiting out a back-off. */
  private standingWithoutRun(
    kind: string,
    key: string,
    may: (workflow: string) => boolean,
  ): { paused: Array<{ workflow: string; run: string }>; waiting: string[] } {
    const paused: Array<{ workflow: string; run: string }> = [];
    const waiting: string[] = [];
    for (const [workflow, def] of this.workflowDefs) {
      const info = standingPoolOf(def.machine);
      if (!info || !info.hears(kind, key) || !may(workflow) || this.standingRun(workflow)) continue;
      const head = this.heads.get(workflow);
      if (head?.paused) paused.push({ workflow, run: head.run });
      else waiting.push(workflow);
    }
    return { paused, waiting };
  }

  // --- internals ---

  /** Put one event on the run's feed: buffer it for ADR-0023's backfill, then fan it out. The
   * buffer and the fan-out share one seat so an attached echo and a later attach see the SAME
   * feed — a projection cannot drift from a record it is read out of. Every listener is handed the
   * SAME event object, which is what lets http.ts render each frame once (ADR-0022). */
  private feed(run: LiveRun, event: RunFeedEvent): void {
    if (event.kind === "status") {
      run.latestStatus = event;
    } else {
      run.feedSoFar.push(event);
      if (run.feedSoFar.length > FEED_SO_FAR_CAP) run.feedSoFar.shift();
    }
    for (const listener of run.listeners) listener(event);
  }

  /**
   * Attach the run-narrative echo (ADR-0023): replay the run's feed-so-far to the Workspace's
   * Harness at `endpoint` — the backfilled preamble, why this Workspace exists: its markers and
   * Emits in feed order, then where the run stands now — then tee live until detached, through an
   * {@link echoOutbox}, which coalesces statuses. FIRE-AND-FORGET is this method's contract: a
   * failure is logged once and swallowed — the feed remains the record, the log is a courtesy
   * view, and nothing here can fail a turn, a state, or a run.
   * Scoped to the OWNING run's lineage by construction: it reads one run's buffer and listeners
   * and nothing else — a sibling run's events cannot reach this endpoint through here.
   */
  private attachEcho(runId: string, endpoint: string, placement: string): () => void {
    const run = this.runs.get(runId);
    const factory = this.echoFactory;
    if (!run || !factory) return () => {};
    let reported = false;
    const enqueue = echoOutbox(factory(endpoint, this.harnessBearer?.(placement)), (err) => {
      // Log-and-continue, ONCE per attachment — an unreachable Harness must not turn every
      // transition into an error line, and must not surface anywhere a run could trip on.
      if (reported) return;
      reported = true;
      console.error(
        `run ${runId}: echo to ${endpoint} failed (log only — the run is unaffected): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    });
    const preamble = run.latestStatus ? [...run.feedSoFar, run.latestStatus] : run.feedSoFar;
    enqueue(preamble.map((ev) => echoEventOf(ev, endpoint)).filter((ev): ev is EchoEvent => ev !== undefined));
    const listener = (ev: RunFeedEvent): void => {
      const projected = echoEventOf(ev, endpoint);
      if (projected) enqueue([projected]);
    };
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  /** A live run's status, read off its actor — the one place the shape is built. */
  private liveStatus(run: LiveRun): RunStatus {
    const snap = run.actor.getSnapshot();
    return {
      ...run.record,
      status: snap.status,
      value: snap.value,
      context: snap.context,
      children: runChildren(snap),
      waiting: runWaiting(snap, run.actor.logic),
      held: heldOf(run.holds.values()),
      fault: run.fault,
      ...(run.cancelledBy ? { cancelledBy: run.cancelledBy } : {}),
      ...(run.handedOverTo ? { handedOverTo: run.handedOverTo } : {}),
      ...(run.answers.length ? { answers: [...run.answers] } : {}),
      ...steeringOf(run.notices.steeringRecord()),
      ...(run.def.assembly !== undefined ? { assembly: run.def.assembly } : {}),
      ...boundFields(snap),
      // A Machine that reached its final state has its output (ADR-0071); an active one has none.
      // A failed run's output is its Failure (ADR-0073).
      ...(run.failure !== undefined ? { output: run.failure } : {}),
      ...(run.failure === undefined && snap.status !== "active" && snap.output !== undefined
        ? { output: snap.output }
        : {}),
      ...dispatchedField(run.effects),
      ...worktreesField(run.effects),
    };
  }

  /** Fill the machine's named actor slots for one run (`.provide()`, the ADR-0015 test seam). */
  private assemble(def: WorkflowDef, instanceId: string): AnyStateMachine {
    const providers = def.provide({ instanceId });
    return def.machine.provide(providers as Parameters<AnyStateMachine["provide"]>[0]);
  }

  /**
   * Create + track a run's root actor. Persistence is driven by the actor system's INSPECTION
   * stream, not the root subscription: a nested body's transition never notifies root
   * subscribers, but it must hit the store, or a crash would restore a stale tree. Snapshot
   * events within one macrostep are coalesced per microtask, and a persist scheduled around
   * stop/untrack is dropped by the tracked-run guard (so `stop()` keeps the stored status
   * "live" for restore).
   */
  private spawn(
    machine: AnyStateMachine,
    options: { input?: Record<string, unknown>; snapshot?: never },
    record: RunRecord,
    def: WorkflowDef,
    agents: Record<string, AgentAdmission> = {},
    epochs: Record<string, number> = {},
    noticeState?: NoticeLedgerState,
    holdState: Hold[] = [],
    effects: Record<string, EffectRow> = {},
    childAgents: Record<string, ChildAgent> = {},
  ): AnyActor {
    const notices = new NoticeLedger(noticeState, this.newId);
    const holds = new Map(holdState.map((hold) => [hold.instanceId, hold]));
    // What took the Machine out of each Agent's state: that Agent's own pick, or something else
    // (ADR-0024). Read off the inspection stream below.
    const causes = new PickCauses();
    let live: LiveRun | undefined;
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (live && this.runs.get(record.runId) === live) this.persist(live);
      });
    };
    const binding: RunBinding = {
      runId: record.runId,
      workflow: record.workflow,
      ...(this.orchestratorName !== undefined ? { orchestratorName: this.orchestratorName } : {}),
      depth: record.dispatchedBy?.depth ?? 0,
      firstCaller: () => this.firstCaller(record.runId),
      // A `dispatch` with no target (ADR-0071): the run host itself, with no wire and no token.
      dispatch: {
        start: (workflow, input, by) => this.dispatchStart(workflow, input, by),
        settled: (runId, signal) => this.settledOf(runId, signal),
        lookup: (workflow, key) => this.dispatched(workflow, key),
      },
      ...(def.assembly !== undefined ? { assembly: def.assembly } : {}),
      table: this.table,
      sandbox: this.sandbox,
      heldSandboxes: () => {
        const run = this.runs.get(record.runId);
        return new Set(run ? runSandboxes(run.actor, record.runId, { placing: true }) : []);
      },
      instanceHarness: this.instanceHarness,
      ...(this.harnessBearer ? { harnessBearer: this.harnessBearer } : {}),
      ...(this.effector ? { effector: this.effector } : {}),
      // The admission ledger's write half (ADR-0016): the Agent's Actor reports the durable handle the
      // moment the Harness admits it, and the ledger hits the store in the same RunBlob save. An
      // admission arriving around stop/untrack still lands in `agents` but skips the save,
      // exactly like the persist scheduler's tracked-run guard.
      recordAdmission: (instanceId, admission, delivered = [], taker, member) => {
        agents[instanceId] = admission;
        // The notices this admission carried are delivered by THIS save, in the conversation it
        // rode (ADR-0062): a Workspace notice stays pending for the rest of its audience. And the
        // conversation is a member of its Workspace's audiences from now on, in the same save.
        notices.delivered(delivered, taker);
        if (member !== undefined && taker !== undefined) {
          notices.admitted(member.workspace, {
            taker,
            slot: member.slot,
            continued: member.continued,
            since: new Date().toISOString(),
          });
        }
        const run = this.runs.get(record.runId);
        if (run && run.agents === agents) this.persist(run);
      },
      admissionOf: (instanceId) => agents[instanceId],
      // The epoch ledger's two halves (ADR-0057). The read is what the input mapper mints from;
      // the write is the terminal `agent.fault` burning the conversation it ended, saved in the
      // same RunBlob as the admission ledger — and, like it, saved AT THE WRITE rather than
      // waiting for the next transition, because a crash between the fault and the next state's
      // invoke would otherwise restore into the burned conversation.
      epochOf: (conversation) => epochs[conversation] ?? 0,
      bumpEpoch: (conversation, reason) => {
        // The burned conversation can take no Turn again: it leaves every audience (ADR-0062).
        const burned = epochs[conversation] ? `${conversation}/${epochs[conversation]}` : conversation;
        notices.forget(burned);
        epochs[conversation] = (epochs[conversation] ?? 0) + 1;
        // The next `continue` lands on a virgin conversation and is told so, with the fault's own
        // words (ADR-0062) — raised in the SAME save as the bump, so no restart can split them.
        notices.raise({ kind: "conversation-new", scope: "conversation", reason }, conversation);
        const run = this.runs.get(record.runId);
        if (run && run.epochs === epochs) this.persist(run);
      },
      // The notices' other halves (ADR-0062). A raise is saved at the write, like the ledgers; a
      // take is a reservation in memory, delivered by `recordAdmission` or released on failure.
      raiseNotice: (notice, to, source, older, raiseOpts) => {
        if (!notices.raise(notice, to, source, older, raiseOpts)) return;
        const run = this.runs.get(record.runId);
        if (run && run.notices === notices) this.persist(run);
      },
      restoreNotice: (notice, to, source, taker) => {
        if (!notices.restore(notice, to, source, taker)) return;
        const run = this.runs.get(record.runId);
        if (run && run.notices === notices) this.persist(run);
      },
      // The Machine's `steer` action (ADR-0002): saved with the transition that runs it.
      steer: (machine, agentName, text, from) => {
        const actors = ((machine as { logic?: AnyStateMachine }).logic?.implementations.actors ?? {}) as Record<
          string,
          unknown
        >;
        if (!isAgent(actors[agentName])) {
          throw new Error(
            `steer("${agentName}", …): this Machine carries no Agent "${agentName}" — a Steering message goes to ` +
              "an Agent slot of the Machine whose transition sends it (ADR-0002)",
          );
        }
        notices.steer(
          {
            kind: "steering",
            scope: "slot",
            text,
            author: { kind: "machine", ...(from !== undefined ? { from: { party: from.party, id: from.id } } : {}) },
            at: new Date(this.now()).toISOString(),
          },
          agentSlot(machine, agentName),
        );
        schedule();
      },
      takeNotices: (scope) => notices.take(scope),
      releaseNotices: (ids, taker) => notices.release(ids, taker),
      peekNotices: (scope) => notices.peek(scope),
      acknowledgeNotices: (ids, taker) => {
        const heard = notices.acknowledge(ids, taker);
        const run = this.runs.get(record.runId);
        if (heard > 0 && run && run.notices === notices) this.persist(run);
        return heard;
      },
      noticesTold: (told) => {
        let changed = false;
        for (const { source, takers } of told) changed = notices.told(source, takers) || changed;
        const run = this.runs.get(record.runId);
        if (changed && run && run.notices === notices) this.persist(run);
      },
      noticeTurnEnded: (workspace, takers) => {
        if (!notices.ended(workspace, takers)) return;
        const run = this.runs.get(record.runId);
        if (run && run.notices === notices) this.persist(run);
      },
      // Absorbed-retry attempts go straight to the run's observers (SSE/CLI watch) — they are
      // feed events, not machine events (ADR-0016: the workflow sees only the terminal fault).
      telemetry: (event) => {
        for (const listener of this.runs.get(record.runId)?.listeners ?? []) listener(event);
        this.announce(record.workflow, { ...event, runId: record.runId });
      },
      // Turn markers (ADR-0023) ride the per-run feed alone — the prompt is Instance-token-class
      // data, so they never touch the workflow feed (ADR-0014's open band strips even Emit
      // payloads there).
      // An Effect's line that comes after its run ended — a stop's answer on a cancel or a final
      // state (ADR-0067) — has no feed left to ride, so it goes to the Orchestrator's log.
      marker: (event) => {
        const run = this.runs.get(record.runId);
        if (run && run.binding === binding) this.feed(run, event);
        else if (!run && event.kind === "effect") {
          console.error(`run ${record.runId}: effect ${event.slot} (${event.effect}) ${event.stage}: ${event.text}`);
        }
      },
      // The run-narrative echo attach (ADR-0023), called from `workspace()`'s registrar.
      echo: (endpoint, placement) => this.attachEcho(record.runId, endpoint, placement),
      // The outstanding pick of the Turn now at this address, as the Agent's Actor reads it when its
      // Harness restarted (ADR-0024/0031). Settled first, so a hold whose Turn is over reads
      // `turnComplete`: that is an EARLIER Turn's pick (a route left its state, and the answer went as
      // a notice to the next Turn, or nowhere) — never this Turn's, whatever it continues.
      outstandingOf: (instanceId) => {
        const run = this.runs.get(record.runId);
        if (run && run.holds === holds) this.settleHolds(run);
        const hold = holds.get(instanceId);
        if (hold?.answer?.turnComplete) return undefined;
        return (
          hold && {
            pick: hold.pick,
            answered: hold.answer !== undefined,
            turnComplete: hold.answer?.turnComplete ?? false,
            ...(hold.answer?.answer !== undefined ? { answer: hold.answer.answer } : {}),
            fetched: hold.fetched === true,
          }
        );
      },
      // The `answer` action's two halves (ADR-0067): the chain of the one pick being answered of an
      // Agent whose state the action is written below — the one in its own send first, else the one
      // outstanding — and the value that replaces its default answer.
      chainOf: (machine, seat, event) => {
        const pick = this.answeringIn(machine, seat, record.runId, holds, childAgents, event);
        if (pick === undefined) return undefined;
        return "reg" in pick ? [...pick.chain] : [...(pick.chain ?? [])];
      },
      setAnswer: (machine, seat, value, event) => {
        const pick = this.answeringIn(machine, seat, record.runId, holds, childAgents, event);
        if (pick === undefined) return;
        // Not saved here: the action runs inside a transition, and the persist that follows it carries
        // the value — a save now would read the Machine before its route, and answer too early.
        pick.shaped = jsonOf(value);
      },
      // The Effect ledger's two halves (ADR-0067). A write is saved AT THE WRITE, like an admission:
      // an intent row must be on disk, with the snapshot that holds its Effect, before the call
      // leaves. A row written inside a transition (an abort) waits for the save that carries that
      // transition — a cancel's final save included, which untracks the run — and is saved after
      // it only when nothing else did. A row written around a park lands in memory and skips the save.
      effectRow: (effectId) => effects[effectId],
      effectRows: () => effects,
      recordEffect: (effectId, row, save = "now") => {
        effects[effectId] = row;
        const persist = (): void => {
          const run = this.runs.get(record.runId);
          if (run && run.effects === effects) this.persist(run);
        };
        if (save === "now") persist();
        else queueMicrotask(persist);
      },
      heldAnswerDelivered: (instanceId) => {
        const hold = holds.get(instanceId);
        if (hold) hold.fetched = true;
      },
      // Read as the invocation stops, while its registration is still there (ADR-0024).
      turnEndedByPick: (instanceId) => {
        const reg = this.table.lookup(agentAddress(instanceId));
        return reg !== undefined && reg.runId === record.runId && causes.endedByPick(reg);
      },
      // A Chart by name (ADR-0070, D-C): among the Charts of the wrapper that is the run's Workflow.
      chartNamed: (name) => this.namedChart(wrapperName(record.workflow), name)?.text,
    };
    let bound = false;
    let firedTimer: ((source: unknown, event: unknown) => boolean) | undefined;
    // The children each Machine of the tree had after its last microstep: what the next one started
    // is the difference (ADR-0067's attribution of a child to the pick whose work started it).
    const childrenAfter = new WeakMap<AnyActorRef, Set<AnyActorRef>>();
    const childRefsOf = (snapshot: unknown): Set<AnyActorRef> =>
      new Set(Object.values((snapshot as { children?: Record<string, AnyActorRef> } | undefined)?.children ?? {}));
    const actor = createActor(machine, {
      // Each timer keeps the cause of the relay that armed it (`cause.ts`, ADR-0024).
      clock: causes.clockOver(this.clock),
      ...options,
      inspect: (ev) => {
        // Bind the run's actor SYSTEM on the ROOT's creation event — the first inspection event,
        // fired inside createActor BEFORE any child of the initial state is constructed. That
        // ordering matters: jr2Setup's wrapped invoke inputs (iid minting — ADR-0016) run at child
        // construction and must already see the run identity. The system is shared by every actor
        // in the tree, which is what run-scopes gate ids with zero workflow plumbing (ADR-0011).
        if (!bound && ev.type === "@xstate.actor") {
          bound = true;
          bindRun((ev.actorRef as AnyActorRef).system, binding);
          // …and watch its scheduler before anything is armed: whether an event the Machine took
          // was a timer it set, or an event an actor sent at once, decides `cutShort` below.
          // The same watch keeps the cause of each timer: the relay that armed it (ADR-0024).
          firedTimer = watchTimers((ev.actorRef as AnyActorRef).system, {
            arming: (source) => causes.armingFrom(source),
          });
        }
        // A restored hold is the Turn of the FIRST registration of its address in this tree: bind
        // it as soon as one exists, before an event can end that Turn and start another at the same
        // address (`continue: true` re-registers it). Every inspection event, so it is bound before
        // the restored Machine processes anything: the root's snapshot comes after its children
        // start and before its mailbox drains.
        for (const hold of holds.values()) {
          if (hold.answer !== undefined || this.holdRegs.has(hold)) continue;
          const reg = this.table.lookup(agentAddress(hold.instanceId));
          if (reg && reg.runId === record.runId && reg.invokeId === hold.invokeId) this.holdRegs.set(hold, reg);
        }
        // Forward the workflow author's `emit({...})` onto the feeds, from EVERY actor in the
        // tree as it is created: xstate scopes emitted events to the actor that emits them — no
        // bubbling — and a run's Emits mostly happen in child machines (a `workspace()` body IS
        // one). A root-only subscription silently dropped exactly the Emits ADR-0022/0023 exist
        // to surface. The subscription dies with its actor; restore re-creates both.
        // The children a pick's own send starts are its Agent's (ADR-0067): their done events name
        // the Agent an `answer` below no Agent's state shapes. Each place an `answer` is written runs
        // as its own seat: each Machine of the tree is placed as its actor is created, before its
        // first state is entered (`placeAnswers`).
        if (ev.type === "@xstate.actor") {
          const sending = this.sending;
          const child = ev.actorRef as AnyActorRef;
          const logic = (child as { logic?: unknown }).logic as AnyStateMachine | undefined;
          if (logic && typeof logic === "object" && "root" in logic) placeAnswers(logic);
          if (sending && child._parent !== undefined && child._parent === sending.reg.invoker) {
            const agent = sending.reg.sender?.id;
            const invoke = sending.reg.invokeId;
            const key = childKey(child._parent, child.id);
            if (agent !== undefined) childAgents[key] = invoke !== undefined ? { agent, invoke } : { agent };
            else delete childAgents[key];
          }
        }
        // …and so are the children its later work starts: a child started while the Machine takes an
        // event that is already that Agent's — a done event of a child it started, or its own event —
        // is that Agent's too, so the work its pick began stays its own (ADR-0067). A child started
        // on an event that names no Agent (a timer) below the state of an Agent whose pick is
        // outstanding is that pick's work by the Rest rule, so it is that Agent's (ADR-0024); any
        // other child started on such an event is no Agent's.
        if (ev.type === "@xstate.microstep") {
          const taker = ev.actorRef as AnyActorRef;
          const before = childrenAfter.get(taker) ?? childRefsOf(taker.getSnapshot());
          const snapshot = (ev as { snapshot?: unknown }).snapshot;
          const after = childRefsOf(snapshot);
          childrenAfter.set(taker, after);
          const started = [...after].filter((c) => !before.has(c)).map((c) => c.id);
          // A Machine instance that left the tree ended (ADR-0002): the Steering messages held for
          // its slots, and for the slots of the Machines below it, retire "not delivered".
          for (const gone of before) {
            if (!after.has(gone) && isMachineActor(gone) && notices.retire(slotPath(gone))) schedule();
          }
          if (started.length > 0 && !this.sending) {
            const agent = agentOfEvent(ev.event as AnyEventObject, childAgents, taker);
            for (const id of started) {
              const owner = agent ?? this.outstandingAbove(taker, snapshot as AnyMachineSnapshot, id, holds);
              if (owner !== undefined) childAgents[childKey(taker, id)] = owner;
              else delete childAgents[childKey(taker, id)];
            }
          }
        }
        if (ev.type === "@xstate.actor") {
          const ref = ev.actorRef as AnyActorRef & { on?: (type: string, handler: (e: unknown) => void) => unknown };
          ref.on?.("*", (emitted) => {
            const event = emitted as { type: string } & Record<string, unknown>;
            const run = this.runs.get(record.runId);
            if (!run || run.binding !== binding) return;
            this.feed(run, { kind: "emit", event });
            this.announce(record.workflow, { kind: "emit", runId: record.runId, event });
          });
        }
        // The chain (ADR-0024): every reply from below the Agent's state while one of its picks is
        // outstanding — inspected as it is relayed, before the Machine processes it, so the states
        // it came from are still active — and the last is the answer's default. The Machine's own
        // events, and events from outside the states below the Agent's, are skipped (`replyOf`).
        // A reply inside the pick's own send comes before any hold exists: `sending` records it.
        if (ev.type === "@xstate.event") {
          const replyTo = (reg: Registration | undefined): PickAnswer | undefined => {
            if (!reg?.invoker || !reg.invokeId || reg.invoker !== ev.actorRef) return undefined;
            const seat = seatOf(reg.invoker.getSnapshot() as AnyMachineSnapshot, reg.invokeId);
            return seat && replyOf(ev.event, ev.sourceRef as AnyActorRef | undefined, reg.invoker, seat);
          };
          // A child's error from below the Agent's state is no reply: the pick's answer carries none,
          // and the operator reads it on the run's feed (ADR-0024).
          const errorTo = (reg: Registration | undefined, pick: string): void => {
            if (!reg?.invoker || !reg.invokeId || reg.invoker !== ev.actorRef) return;
            const seat = seatOf(reg.invoker.getSnapshot() as AnyMachineSnapshot, reg.invokeId);
            const failed = seat && childErrorOf(ev.event, ev.sourceRef as AnyActorRef | undefined, reg.invoker, seat);
            const run = this.runs.get(record.runId);
            if (!failed || !run || run.binding !== binding) return;
            this.feed(run, { kind: "child-error", agent: reg.sender?.id ?? "", pick, ...failed });
          };
          // Every relayed event is asked, so the watch forgets each timer as it fires.
          const timer = firedTimer?.(ev.sourceRef, ev.event) === true;
          for (const hold of holds.values()) {
            if (hold.answer !== undefined) continue;
            const live = this.table.lookup(agentAddress(hold.instanceId));
            const reg = this.holdRegs.get(hold) ?? live;
            const reply = replyTo(reg);
            if (reply) hold.chain = [...(hold.chain ?? []), reply];
            errorTo(reg, hold.pick);
            // While the Agent's state is still the hold's, each event the Machine takes says who would
            // move it out (`cutShort`), when the Machine that invokes the Agent or one above it takes
            // it — events between the children below do not move it; once the state is gone, the next
            // state's events are not the hold's:
            //   - a reply: its route;
            //   - an event a Machine sent itself at once (`sendTo(self)`; a `raise` is never relayed):
            //     part of the route of the event whose actions sent it — no change;
            //   - anything else — a timer the Machine set, an event from outside the states below, a
            //     party's event, the Agent's own end: it stops the work below, if any still runs.
            const taker = ev.actorRef as AnyActorRef;
            if (reg === undefined || reg !== live || !reg.invoker || !atOrBelow(reg.invoker, taker)) continue;
            if (reply) delete hold.cutShort;
            else if (!timer && ev.sourceRef === taker) continue;
            else if (stillRunning(reg)) hold.cutShort = true;
            else delete hold.cutShort;
          }
          const sending = this.sending;
          const reply = sending && replyTo(sending.reg);
          if (sending && reply) sending.chain.push(reply);
          if (sending) errorTo(sending.reg, sending.pick);
          // The cause of this relay (`cause.ts`, ADR-0024): read before the Machine takes it.
          const target = ev.actorRef as AnyActorRef;
          const source = ev.sourceRef as AnyActorRef | undefined;
          const event = ev.event as AnyEventObject;
          causes.relayed(
            source,
            target,
            event,
            () => this.pickCause(record.runId, holds, target, source, event),
            () => this.table.byRun(record.runId).filter((reg) => reg.kind === "agent"),
          );
          // A Failure ended a Machine that a Machine above can catch (ADR-0073). xstate does not stop
          // the children of a Machine that ends `error`, so the host stops them, as `stopTree` does for
          // the run: an Agent in that Machine settles its Turn, and a Gate or a timer there does not
          // wait for nobody. After the parent takes the event, so its exit is recorded first. A stop
          // skips `teardown`, so a Workspace in another region of that Machine does not delete its
          // Sandbox: the host names them before the stop and deletes them after it, as for a failed run.
          // A name that a live Workspace of the run holds after the stop is not deleted: a parent that
          // invokes the same Machine again gives its new Workspace the same invoke id, and so the same
          // name, and that Workspace is in `placing` by now.
          if (
            source !== undefined &&
            source._parent === target &&
            event.type === `xstate.error.actor.${source.id}` &&
            isFailure((event as { error?: unknown }).error)
          ) {
            queueMicrotask(() => {
              const sandboxes = runSandboxes(source, record.runId);
              stopTree(source);
              const held = this.runs.get(record.runId)?.binding.heldSandboxes?.() ?? new Set<string>();
              const ended = sandboxes.filter((name) => !held.has(name));
              void this.destroySandboxes(record.runId, ended, "the end of the failed Machine");
            });
          }
        }
        // A mechanism event that no transition took (ADR-0074): `agent.fault` or `workspace.lost`
        // that a Machine got and dropped, as a guard that was false when it came. The run would wait
        // for ever, so it faults. After the macrostep, so the stop does not cut xstate's own step.
        if (ev.type === "@xstate.microstep") {
          const unrouted = unroutedMechanismEvent(ev as unknown as MicrostepView);
          if (unrouted !== undefined) queueMicrotask(() => this.faultUnrouted(record.runId, binding, unrouted));
        }
        // The exit of each Agent's state (`cause.ts`, ADR-0024).
        if (ev.type === "@xstate.microstep") {
          const machine = ev.actorRef as AnyActorRef;
          const agents = this.table.byRun(record.runId).filter((reg) => reg.kind === "agent");
          causes.microstep(
            machine,
            (ev as unknown as { snapshot: AnyMachineSnapshot }).snapshot,
            ev.event as AnyEventObject,
            agents,
          );
        }
        if (ev.type === "@xstate.snapshot") {
          causes.taken(ev.actorRef as AnyActorRef, ev.event as AnyEventObject);
          // A Machine instance that reached its end — `done`, or `error` — takes no Turn again, even
          // while its parent still holds it (ADR-0002). A stop is not an end here: a host that stops
          // parks the run, and its restore goes on.
          const ended = (ev as { snapshot?: { status?: string } }).snapshot?.status;
          const ref = ev.actorRef as AnyActorRef;
          if ((ended === "done" || ended === "error") && isMachineActor(ref)) {
            notices.retire(ref._parent === undefined ? undefined : slotPath(ref));
          }
          schedule();
        }
      },
    });
    live = this.track(record, actor, def, agents, epochs, notices, binding, holds, effects, childAgents);
    return actor;
  }

  private track(
    record: RunRecord,
    actor: AnyActor,
    def: WorkflowDef,
    agents: Record<string, AgentAdmission>,
    epochs: Record<string, number>,
    notices: NoticeLedger,
    binding: RunBinding,
    holds: Map<string, Hold>,
    effects: Record<string, EffectRow>,
    childAgents: Record<string, ChildAgent>,
  ): LiveRun {
    const run: LiveRun = {
      record,
      actor,
      def,
      agents,
      epochs,
      notices,
      holds,
      effects,
      childAgents,
      binding,
      answers: [],
      listeners: new Set(),
      feedSoFar: [],
    };
    this.runs.set(record.runId, run);
    // Ordinary persistence rides the inspection stream (see `spawn`); the subscription exists
    // for the ERROR channel: an errored actor (an invoke threw — e.g. ADR-0011's invoke-time
    // manifest check) reports here. Capture the message (xstate serializes the Error itself to
    // `{}`), then persist: the snapshot's "error" status stores the run and untracks it.
    actor.subscribe({
      error: (err) => {
        // A Failure that no state caught (ADR-0073): the end the Machine chose, so the run ends
        // `failed`, with no fault and the Failure as its output, and its Sandboxes go as a cancel's
        // do (ADR-0025). Named BEFORE the stop, while the tree still says which Workspaces are live.
        if (isFailure(err)) {
          run.failure = failurePayload(err);
          const sandboxes = runSandboxes(actor, record.runId);
          this.persist(run, "failed");
          stopTree(actor);
          void this.destroySandboxes(record.runId, sandboxes, "the end of the failed run");
          return;
        }
        run.fault = err instanceof Error ? err.message : String(err);
        this.persist(run);
        // A faulted run stops its actors — each workspace's lease among them (ADR-0021), and a
        // Workspace still `placing` deletes the Sandbox that never ran (ADR-0064). Said here, not
        // assumed: xstate ends a machine on an unhandled child error WITHOUT stopping its other
        // children, so a lease beside the actor that failed would renew for nobody, forever. The
        // pod that was placed stays up for inspection (ADR-0012's destroy-less terminal) and ages
        // out of the operator's idle timeout on its own.
        stopTree(actor);
      },
    });
    // (The author's `emit({...})` forwarding lives in `spawn`'s inspect handler — per actor,
    // because emitted events do not bubble — not here on the root alone.)
    // The run has appeared. This is the convergence point of `start()` and `restore()` — both reach
    // the live set through here, so one fan-out covers a fresh run and a resumed one alike.
    //
    // It runs BEFORE `actor.start()` (see the call in `spawn`), so this first frame is the pre-start
    // snapshot, corrected on the next microtask by the first `persist()`. That is fine because the
    // feed is level-triggered — every frame is a whole status, so a momentarily-early one is simply
    // overwritten rather than accumulated. Do NOT "fix" this by moving the fan-out into `start()`:
    // `restore()` does not go through it, and resumed runs would silently stop appearing.
    this.announce(record.workflow, { kind: "status", status: this.liveStatus(run) });
    return run;
  }

  private untrack(record: RunRecord): void {
    this.runs.delete(record.runId);
  }

  /**
   * Persist the run's snapshot after a transition; drop it from the registry once final.
   *
   * `terminal` is the run-lifecycle verdict the MACHINE cannot supply. Three callers pass it:
   * `cancel()` passes "cancelled", because xstate only knows its actor was stopped (ADR-0025); the
   * error observer passes "failed" for a Failure that no state caught, because xstate gives a
   * Failure and a defect the same `error` status (ADR-0073); and `faultUnrouted()` passes "error"
   * for a mechanism event that no transition took, because the host stops the actor and xstate
   * then knows only that it was stopped (ADR-0074). It is the stored status and the one the feeds report.
   */
  private persist(run: LiveRun, terminal?: string): Promise<void> {
    // The holds first: an answer read at Rest, and a notice a route out raised, ride this same save.
    this.settleHolds(run);
    const snapshot = run.actor.getPersistedSnapshot();
    const machineStatus = (snapshot as { status?: string }).status ?? "active";
    const status = terminal ?? (machineStatus === "active" ? "live" : machineStatus);
    // A run that ended holds no Steering message: each one still held retires, "not delivered"
    // (ADR-0002). Before the blob is built, so this save records it.
    if (status !== "live") run.notices.retire();
    const serialized = serializeSnapshot(snapshot, {
      stripContext: (ctx) => ctx, // see ADR-0007: live infra lives in `.provide` closures, not context
      stripChildInput: (input) => input,
    });
    const blob: RunBlob = {
      workflow: run.record.workflow,
      instanceId: run.record.instanceId,
      ...(run.record.dispatchedBy ? { dispatchedBy: run.record.dispatchedBy } : {}),
      ...(run.record.startedBy ? { startedBy: run.record.startedBy } : {}),
      ...(run.record.resumedBy ? { resumedBy: run.record.resumedBy } : {}),
      ...(run.cancelledBy ? { cancelledBy: run.cancelledBy } : {}),
      ...(run.handedOverTo ? { handedOverTo: run.handedOverTo } : {}),
      ...(run.answers.length ? { answers: run.answers } : {}),
      // Stamped on every save, off the registered TEMPLATE (never the per-run `.provide()` result —
      // providers do not change shape, and `fingerprintOf` memoizes per machine object). ADR-0030.
      machine: fingerprintOf(run.def.machine),
      // The Assembly the run started under (ADR-0069): the def it was spawned with, never the
      // current one, so a publish mid-run does not restamp it, and a restore spawns it with the
      // hash its blob named.
      ...(run.def.assembly !== undefined ? { assembly: run.def.assembly } : {}),
      snapshot: serialized,
      agents: run.agents,
      epochs: run.epochs,
      notices: run.notices.state(),
      timers: pendingTimers(run.actor, this.now()),
      holds: [...run.holds.values()],
      effects: run.effects,
      childAgents: liveChildAgents(run.childAgents, run.actor),
      fault: run.fault,
      ...(run.failure !== undefined ? { failure: run.failure } : {}),
    };
    // A save that fails is this run's fault, never the process's: an unhandled rejection would end
    // the Orchestrator and every run on it. The run keeps its last saved snapshot.
    const saved = this.store.save(run.record.runId, blob, status).catch((err: unknown) => {
      console.error(
        `run ${run.record.runId}: its snapshot was not saved: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    // The save is on disk (the store writes synchronously, ADR-0065): a settled row whose transition
    // it carries keeps no tail in the next one (ADR-0067).
    dropSavedTails(run.effects, snapshot);

    // Feed per-run observers (SSE/CLI watch). On the terminal transition emit the final status
    // BEFORE untrack drops the run from the registry, then drop the now-useless listener set.
    //
    // Persistence rides the INSPECTION stream (see `spawn`), which fires on a child's transitions
    // too — so this frame lands on child movement, and its `children` tree carries the new state.
    // That is the entire live half of the Console's child diagrams: no extra subscription.
    const runStatus = terminal ? { ...this.liveStatus(run), status: terminal } : this.liveStatus(run);
    this.feed(run, { kind: "status", status: runStatus });

    if (status !== "live") {
      // The workflow's watchers get the same final status, then `gone` — the run's last word on
      // both feeds, still before untrack, while there is a status to read.
      this.announceGone(run, runStatus);
      this.untrack(run.record);
      run.listeners.clear();
      // After the save and the untrack: a listener that reads the run back reads it settled.
      this.fireSettled(run.record.runId, runStatus);
      // A standing run's end (ADR-0017): a pause, or a hand-over after the back-off.
      this.standingEnded(run, status);
    } else {
      this.announce(run.record.workflow, { kind: "status", status: runStatus });
      this.checkBound(run);
    }
    return saved;
  }
}

/** A status that is no longer live (ADR-0071): the store's terminal words. A live row reads its
 * Machine's `active`; the store's own `live` is never a status a reader is handed, but is not
 * settled either. */
function settledStatus(status: string): boolean {
  return status !== "active" && status !== "live";
}

/** Call a settle listener; one that throws is its own fault, never the run's or the host's. */
function hear(listener: (status: RunStatus) => void, status: RunStatus): void {
  try {
    listener(status);
  } catch (err) {
    console.error(`run ${status.runId}: a settle listener threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Does work still run below the Agent's state of `reg` — a live child of an active state under it?
 * A timer that holds Rest is no work: when the state exits, nothing it started is stopped. */
function stillRunning(reg: Registration): boolean {
  if (!reg.invoker || !reg.invokeId) return false;
  const seat = seatOf(reg.invoker.getSnapshot() as AnyMachineSnapshot, reg.invokeId);
  return seat !== undefined && runningBelow(reg.invoker, seat).length > 0;
}

/** `actor` is `ref`, or `ref` is its parent, its parent's parent, and so on up to the root. */
function atOrBelow(actor: AnyActorRef, ref: AnyActorRef): boolean {
  for (let at: AnyActorRef | undefined = actor; at !== undefined; at = at._parent) if (at === ref) return true;
  return false;
}

/** What the items that a standing run took itself did (ADR-0017): whether one started a run, and
 * how many ended. A live worker's run is on its ledger row (ADR-0071). */
function tookOf(run: LiveRun): { started: boolean; answered: number } {
  return standingTook(run.actor.getSnapshot(), (effectId) => {
    const row = run.effects[effectId];
    if (row?.kind !== "dispatch") return undefined;
    const r =
      row.state === "settled"
        ? (row.output as { run?: unknown } | null | undefined)?.run
        : (row as { run?: unknown }).run;
    return typeof r === "string" && r !== "" ? r : undefined;
  });
}

/** The runs a run's `dispatch` Effects started (ADR-0071), from its ledger: an intent row the
 * start's answer re-wrote with its run, a settled row whose output names one (`started`,
 * `settled`), and an aborted row that kept it. A row that never learned its run names none. */
function dispatchedField(effects: Record<string, EffectRow>): { dispatched?: Dispatched[] } {
  const out: Dispatched[] = [];
  for (const row of Object.values(effects)) {
    if (row.kind !== "dispatch") continue;
    const run =
      row.state === "settled"
        ? (row.output as { run?: unknown } | null | undefined)?.run
        : (row as { run?: unknown }).run;
    if (typeof run === "string" && run !== "") out.push({ slot: row.slot, run, at: row.at });
  }
  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return out.length ? { dispatched: out } : {};
}

/** The Worktrees a run's cuts made (ADR-0075), from the settled `ready` rows of its ledger, in the
 * order of each Worktree's first cut. A cut also reads a Worktree, so one path and branch has many
 * rows and one entry. */
function worktreesField(effects: Record<string, EffectRow>): { worktrees?: RunWorktree[] } {
  const rows = Object.values(effects).flatMap((row) =>
    row.state === "settled" && row.cut !== undefined && row.repo !== undefined
      ? [{ at: row.at, slot: row.repo, ...row.cut }]
      : [],
  );
  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const out = new Map<string, RunWorktree>();
  for (const { slot, path, branch } of rows) {
    const key = JSON.stringify([path, branch]);
    if (!out.has(key)) out.set(key, { slot, path, branch });
  }
  return out.size ? { worktrees: [...out.values()] } : {};
}

/** A status's bound fields (ADR-0070): `bound`, and the hashes of the Charts bound, distinct and
 * sorted. Both absent when the snapshot binds no Chart. */
function boundFields(snap: unknown): { bound?: true; chartHashes?: string[] } {
  const hashes = [...new Set(boundChartRoutesOf(snap).map((route) => route.chartHash))].sort();
  return hashes.length ? { bound: true, chartHashes: hashes } : {};
}

/** A live actor's children, by id. */
function childrenOfRef(ref: AnyActorRef): Record<string, AnyActorRef> {
  return (ref.getSnapshot() as { children?: Record<string, AnyActorRef> } | undefined)?.children ?? {};
}

/** A stored run's bound Chart, compiled again from its text under the Open body it binds, for the
 * run's doc — or why it is not: the doc then keeps the slot's subgraph and names the reason. */
function compileStored(machine: AnyStateMachine, route: BoundChartRoute): AnyStateMachine | string {
  let at: AnyStateMachine = machine;
  for (const src of route.srcs.slice(0, -1)) {
    const logic = (at.implementations.actors as Record<string, unknown>)[src];
    if (isOpenBody(logic)) continue;
    if (!(logic as AnyStateMachine | undefined)?.root) return `no Machine at slot "${src}"`;
    at = logic as AnyStateMachine;
  }
  const logic = (at.implementations.actors as Record<string, unknown>)[route.src];
  if (!isOpenBody(logic)) return `slot "${route.src}" is no Open body`;
  const decl = openBodyDeclarationOf(logic);
  const lent = lentIn(at.implementations as never, decl);
  try {
    return compileChart(admitChart(route.chart, decl, lent), lent, decl, { id: route.src });
  } catch (err) {
    return err instanceof ChartRefusal
      ? `the door refuses the Chart: ${err.report.join("; ")}`
      : err instanceof Error
        ? err.message
        : String(err);
  }
}

/** Put a compiled Chart's body under the states of `doc` that invoke the Open body at the end of
 * `srcs`, descending through the child Machine docs the earlier slots name. */
function placeBody(doc: MachineBodyDoc, srcs: readonly string[], body: MachineBodyDoc): void {
  const [src, ...rest] = srcs;
  if (src === undefined) return;
  const visit = (state: MachineStateDoc): void => {
    if (rest.length === 0) {
      for (const inv of state.invoke) {
        if (inv.src !== src) continue;
        const child: ChildMachineDoc = { src, label: inv.id, via: "invoke", machine: body };
        const at = state.children.findIndex((c) => c.src === src);
        if (at >= 0) state.children[at] = child;
        else state.children.push(child);
      }
    } else {
      for (const child of state.children) if (child.src === src && child.machine) placeBody(child.machine, rest, body);
    }
    for (const nested of state.states) visit(nested);
  };
  visit(doc.root);
}
