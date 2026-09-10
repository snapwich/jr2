// The Machine host: runs an xstate Machine as a durable run and wires the three slice-1 modules
// together (ADR-0002/0007/0011). It is the integration seam the modules left open.
//
// Wiring (ADR-0011 registration table — no routing layer):
//   - The host owns ONE RegistrationTable and binds each run's actor system to it at track time;
//     `gate` and the Agent slots register their invocation's event surface there, with deliver
//     closures over their own `sendBack` — so delivery lands on the invoking state at any
//     nesting depth and the host routes nothing.
//   - Two thin surfaces sit on that table, and NEITHER is MCP (ADR-0013 — the Orchestrator does
//     not speak it): `agentSurface` / `sendToAgent` serve the Agent's Adapter (`/agents/:iid/*`),
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
import { createActor, type AnyActor, type AnyActorLogic, type AnyActorRef, type AnyStateMachine } from "xstate";
import type { EventSemantics } from "@j2/agent-protocol";
import { inputSchemaOf } from "./vocabulary.ts";
import type { EchoEvent, EchoStatusChild } from "./wire.ts";
import {
  agentAddress,
  bindRun,
  EventValidationError,
  gateAddress,
  mayMove,
  RegistrationTable,
  UnknownAddressError,
  wouldMove,
  type RetryTelemetry,
  type RunBinding,
  type TurnMarker,
} from "./registration.ts";
import type { SandboxPort } from "./workspace.ts";
import { fingerprintOf } from "./fingerprint.ts";
import { serializeMachine, type MachineDoc } from "./machine-doc.ts";
import type { SnapshotStore } from "./snapshot-store.ts";
import type { AgentAdmission } from "./actor.ts";
import { reattachAgentRuns, serializeSnapshot } from "./durability.ts";

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
};

/** The serializable identity of a run — what reconcile sees and what restore rebuilds from. */
export type RunRecord = { runId: string; workflow: string; instanceId: string };

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

/** A run's current observable state. `fault` carries the error message when status is "error"
 * (e.g. a gate invoked with a name outside the workflow's manifest — ADR-0011). */
export type RunStatus = RunRecord & {
  status: string;
  value: unknown;
  context: unknown;
  /** The live child machines beneath the root — where most of a run actually is. */
  children: RunChild[];
  fault?: string;
  /**
   * Why the HOST set this status, for the statuses the Machine did not choose — today `drifted`
   * (ADR-0030). Distinct from `fault`, which is a running actor's own error; this is the store's
   * account of a run it declined to resume, and until it was surfaced here nothing on any HTTP
   * route could read it.
   */
  reason?: string;
};

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
};

/** Project a full status down to what an observer may see. The one place the line is drawn. */
export function observe(status: RunStatus): RunObservation {
  return {
    runId: status.runId,
    workflow: status.workflow,
    status: status.status,
    value: status.value,
    children: status.children,
  };
}

/** One open gate as external callers discover it (`GET /runs/:id` — ADR-0011): the accepted
 * events with their input schemas as JSON Schema (what drives a form or a `j2 send` prompt),
 * plus the workflow-supplied `meta` (what a UI renders and a webhook translator matches on). */
export type GateView = {
  gate: string;
  /** The invoking state's actor path below the run root — where the gate lives in the Machine
   * (what the Console's "parked here" pin resolves against its scope tree), stable whether the
   * id was authored ("F-12") or derived. Never parse `gate` for this. */
  path: string[];
  accepts: Array<{ name: string; description?: string; input: unknown }>;
  meta?: Record<string, unknown>;
};

/**
 * One live agent surface, as its Adapter reads it (`GET /agents/:iid/surface` — ADR-0013). The
 * Adapter renders this as `tools/list`: each accepted event becomes a tool, its `input` schema the
 * tool's input schema. `semantics` rides along so the Adapter can tell an awaiting tool from a
 * fire-and-forget one — the room ADR-0006's deferred results will land in, unbuilt today.
 *
 * `sandbox` is the Sandbox that may deliver here. It is not a secret from the Adapter (that pod IS
 * the sandbox), and serving it lets the Adapter fail loudly on a surface that is not its own.
 */
export type AgentSurfaceView = {
  instanceId: string;
  runId: string;
  sandbox?: string;
  accepts: Array<{ name: string; description?: string; input: unknown; semantics: EventSemantics }>;
};

/**
 * The answer to one Agent delivery (`POST /agents/:iid/events`) — a receipt that DESCRIBES ITSELF
 * (ADR-0024). The Adapter renders it as prose, because a bare `deliveryId` told the Agent nothing
 * about whether it was finished, and the model answered that silence by calling again.
 *
 * `turnComplete` is the HINT, never the guarantee (the abort on invocation end is): it is read off
 * the registration table right after delivery, so it says whether the state that asked for this
 * turn has stopped waiting. It fails conservatively — anything that made the read unreliable reads
 * `false`, which is today's behavior, never a false claim.
 *
 * `deliveryId` is unchanged from ADR-0013: an outcome stays ADDRESSABLE after the fact, the room a
 * deferred result needs when it lands. Nothing polls it today, deliberately.
 */
export type AgentDeliveryReceipt = {
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
  | TurnMarker
  // Absorbed-retry telemetry (ADR-0016): `{ child, attempt }` is state-key-class data — no iids
  // ride the feed (ADR-0014). `reason` is mechanism text, guarded like `fault`.
  | RetryTelemetry
  | { kind: "closed" };

/**
 * The feed-so-far cap. The buffer exists so a Workspace attaching mid-run can open its log with
 * the run's preamble (ADR-0023); a run long enough to blow past it loses its OLDEST frames, which
 * is the same trade kubelet's log rotation already makes on the printed side — the feed remains
 * the record, the buffer serves a courtesy view.
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
  /** Report a run that threw during restore (ADR-0030). The row is left `live` for the next boot,
   * so this is the only account of why — the entrypoint logs it. Default: silent. */
  onRestoreError?: (runId: string, err: unknown) => void;
  /** The Sandbox backend `workspace()` provisions through (ADR-0012). Absent = no cluster:
   * workspace-less workflows run fine; a `workspace()` invocation faults its run pointedly. */
  sandbox?: SandboxPort;
  /** The Instance Harness base URL (ADR-0031) — where `workspace: "none"` Turns are admitted. */
  instanceHarness?: string;
  /**
   * Build the run-narrative echo pusher for one Workspace's Harness (ADR-0023) — the seam a fake
   * echo server rides in tests; `startInstance` binds the real wire push (harness-client.ts),
   * closed over the Instance token. Absent = no echo: a host without it runs identically, because
   * the echo is a courtesy view of the feed, never a dependency of the run.
   */
  echo?: (endpoint: string) => (events: EchoEvent[]) => Promise<void>;
};

/** What we persist per run: the machine snapshot wrapped with the run metadata restore needs.
 * `agents` is the admission LEDGER (ADR-0016) — iid → durable admission, reported by the Agent actor
 * through the run binding and saved in the same blob (same store, same atomicity). */
type RunBlob = {
  workflow: string;
  instanceId: string;
  /** The shape of the Machine that WROTE this snapshot (ADR-0030). `workflow` says which def to
   * look up; this says whether the def found there is still the one this snapshot can be read by.
   * Absent means written before the stamp existed, which restore treats as drift — the point is to
   * never interpret a snapshot whose Machine cannot be vouched for. */
  machine?: string;
  snapshot: unknown;
  agents?: Record<string, AgentAdmission>;
  fault?: string;
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
  /** The error that killed the run, if it errored (xstate serializes Error to `{}`, so the
   * message is captured here at the observer and persisted onto the blob for `read`). */
  fault?: string;
  /** Per-run observers fed by `persist()` (status) and the actor's `emit` (emit) — SSE/CLI watch. */
  listeners: Set<(e: RunFeedEvent) => void>;
  /** The run's feed-so-far (ADR-0023): what a Workspace attaching mid-run gets replayed as its
   * log's preamble. In-memory and this-boot only — a restored run's preamble starts at restore,
   * the same live-only contract the printed log already has. Capped ({@link FEED_SO_FAR_CAP}). */
  feedSoFar: RunFeedEvent[];
};

export class RunHost {
  /** The internal registration table both delivery surfaces share (ADR-0011). Callback actors
   * (`gate`, the Agent slots) reach it via the run binding, not this field. */
  private readonly table = new RegistrationTable();

  private readonly store: SnapshotStore;
  private readonly reconcile: (run: RunRecord) => boolean | Promise<boolean>;
  private readonly newId: () => string;
  private readonly onRestoreError?: (runId: string, err: unknown) => void;
  private readonly sandbox?: SandboxPort;
  private readonly instanceHarness?: string;
  private readonly echoFactory?: (endpoint: string) => (events: EchoEvent[]) => Promise<void>;
  private readonly workflowDefs = new Map<string, WorkflowDef>();
  private readonly runs = new Map<string, LiveRun>();
  /**
   * Workflow name → its observers. Deliberately on the HOST and not on `LiveRun`: a workflow's
   * watcher outlives every individual run it watches, and `persist()` clears a settled run's own
   * listener set. Keeping it here is what makes that structurally impossible to get wrong, rather
   * than a comment asking the next reader not to clear the wrong Set.
   */
  private readonly workflowListeners = new Map<string, Set<WorkflowListener>>();

  constructor(opts: RunHostOptions) {
    this.store = opts.store;
    this.reconcile = opts.reconcile ?? (() => true);
    this.newId = opts.newId ?? (() => randomUUID());
    this.onRestoreError = opts.onRestoreError;
    this.sandbox = opts.sandbox;
    this.instanceHarness = opts.instanceHarness;
    this.echoFactory = opts.echo;
  }

  /** Register a workflow so `start`/`restore` can run it. Re-registering replaces (dev reload).
   * Nothing about the vocabulary is copied here: event names are scoped to the Machine that
   * declared them and resolved at invoke time off the invoking Machine (ADR-0011, ADR-0049), so
   * a nested Machine's defs are never the root's — or this host's — to hold. */
  register(def: WorkflowDef): void {
    this.workflowDefs.set(def.name, def);
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

  /** The registered template Machine's serialized structure (`GET /workflows/:name/machine`). */
  machine(name: string): MachineDoc | undefined {
    const def = this.workflowDefs.get(name);
    return def && serializeMachine(name, def.machine);
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
    const schema = inputSchemaOf(def.machine);
    // `io: "input"`: this schema describes what a caller SENDS — a defaulted field is optional
    // at the door (the default is applied by `start`'s parse), not required of the form.
    return schema ? (z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>) : null;
  }

  /** Start a fresh run of a registered workflow; returns its durable ids. */
  async start(workflow: string, input: Record<string, unknown> = {}): Promise<{ runId: string; instanceId: string }> {
    const def = this.workflowDefs.get(workflow);
    if (!def) throw new Error(`no workflow registered as "${workflow}"`);

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
    const record: RunRecord = { runId, workflow, instanceId };

    const machine = this.assemble(def, instanceId);
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
   * `drifted` and `failed` are different claims, deliberately. Drift is a DURABLE verdict — the
   * Machine changed, and it will still have changed on the next boot — so it is written to the row.
   * A throw is not: `reconcile` talks to a cluster, and a kubectl blip must not permanently condemn
   * a run. Those rows are left `live` to be retried on the next boot, and reported every time until
   * they stop failing.
   */
  async restore(): Promise<{ reattached: string[]; lost: string[]; drifted: string[]; failed: string[] }> {
    const reattached: string[] = [];
    const lost: string[] = [];
    const drifted: string[] = [];
    const failed: string[] = [];

    for (const stored of await this.store.list()) {
      if (stored.status !== "live") continue;
      const blob = stored.snapshot as RunBlob | null;
      const def = blob ? this.workflowDefs.get(blob.workflow) : undefined;
      if (!blob || !def) {
        await this.store.markLost(stored.runId, blob ? `no workflow "${blob.workflow}"` : "empty snapshot");
        lost.push(stored.runId);
        continue;
      }

      // The workflow name resolved a def; this asks whether that def is still the Machine this
      // snapshot was written by (ADR-0030). Refused BEFORE `reconcile`, which talks to the cluster:
      // there is no point proving a Sandbox is alive for a run that cannot be read.
      const expected = fingerprintOf(def.machine);
      if (blob.machine !== expected) {
        await this.store.markDrifted(
          stored.runId,
          `workflow "${blob.workflow}" changed shape since this run was saved ` +
            `(saved under ${blob.machine ?? "an unstamped Machine"}, now ${expected})`,
        );
        drifted.push(stored.runId);
        continue;
      }

      const record: RunRecord = { runId: stored.runId, workflow: blob.workflow, instanceId: blob.instanceId };

      try {
        if (!(await this.reconcile(record))) {
          await this.store.markLost(stored.runId, "reconcile: live world absent");
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
          def,
          agents,
        );
        actor.start();
        reattached.push(stored.runId);
      } catch (err) {
        // Left `live` on purpose — see the note above. The row is unchanged, so the next boot tries
        // again; what must not happen is this taking the remaining runs down with it.
        this.onRestoreError?.(stored.runId, err);
        failed.push(stored.runId);
      }
    }

    return { reattached, lost, drifted, failed };
  }

  /**
   * An agent instance's LIVE surface (`GET /agents/:iid/surface` — ADR-0013): what the state that
   * invoked this Agent accepts, right now. Undefined once nothing is registered (the state exited,
   * the run settled, the iid is unknown) — the one catch point, and the reason the Adapter never
   * has to learn which turn is live: it asks, per turn, and the answer IS the turn.
   *
   * "Right now" is load-bearing (ADR-0029): the registered defs are the state's VOCABULARY, derived
   * statically from its transitions, and the guards on those transitions are asked here — so an
   * event the Machine cannot currently accept is not offered. The pick has not happened yet, so the
   * question is `mayMove`, not `wouldMove`: a guard that would have judged the Agent's arguments is
   * left on the menu and settled at delivery. The Adapter rebuilds this per MCP connection and the
   * Harness re-lists per Submission, so the filter lands at turn boundaries and never moves under
   * an Agent mid-turn.
   */
  agentSurface(instanceId: string): AgentSurfaceView | undefined {
    const reg = this.table.lookup(agentAddress(instanceId));
    if (!reg) return undefined;
    return {
      instanceId,
      runId: reg.runId,
      sandbox: reg.sandbox,
      accepts: [...reg.defs.values()]
        .filter((def) => mayMove(reg.invoker, def.name))
        .map((def) => ({
          name: def.name,
          description: def.description,
          input: z.toJSONSchema(def.input),
          semantics: def.semantics,
        })),
    };
  }

  /**
   * Deliver one event from an Agent's Adapter (`POST /agents/:iid/events` — ADR-0013). Validation
   * and delivery are the table's; this only agent-scopes the address and mints the receipt.
   */
  sendToAgent(instanceId: string, event: { type?: unknown } & Record<string, unknown>): AgentDeliveryReceipt {
    const { type, ...payload } = event;
    if (typeof type !== "string" || !type) {
      throw new EventValidationError(`event body must carry a string "type" (one of the surface's accepted names)`);
    }
    const address = agentAddress(instanceId);
    const invoking = this.table.lookup(address);

    // Ask the guard question BEFORE delivering, and ask it with the VALIDATED payload — this is the
    // exact form of the check the surface build can only approximate payload-blind (ADR-0029).
    // Parsed here rather than read back out of `deliver` because `deliver` is void by design (it is
    // the one behavior behind both dialects); a zod default applied there but not here would leave
    // a guard reading that field answering on `undefined`. An unaccepted name or a bad payload
    // makes this unreliable and `deliver` throws on the next line anyway — so it fails open.
    const def = invoking?.defs.get(type);
    const parsed = def?.input.safeParse(payload ?? {});
    const moved = wouldMove(invoking?.invoker, parsed?.success ? { type, ...parsed.data } : { type, ...payload });

    this.table.deliver(address, type, payload);
    // Read AFTER the delivery, off the SAME table the ADR-0024 guarantee uses — so the receipt
    // reports what happened rather than what was hoped. `deliver` reached the invoking state's
    // `sendBack` synchronously, so a pick that moved the Machine out of that state has already
    // destroyed this registration by now.
    //
    // IDENTITY, not existence: under `session: "continue"` the next state re-registers the SAME
    // address for its own turn, and that is a new turn — this one still ended.
    return {
      delivered: true,
      event: type,
      moved,
      turnComplete: this.table.lookup(address) !== invoking,
      deliveryId: this.newId(),
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
        meta: reg.meta,
      }));
  }

  /** Deliver one external event to a run's open gate (`POST /runs/:id/gates/:gate/events`).
   * Validation and delivery are the table's — this only run-scopes the address. */
  sendToGate(runId: string, gate: string, event: { type?: unknown } & Record<string, unknown>): void {
    const { type, ...payload } = event;
    if (typeof type !== "string" || !type) {
      throw new EventValidationError(`event body must carry a string "type" (one of the gate's accepted names)`);
    }
    try {
      this.table.deliver(gateAddress(runId, gate), type, payload);
    } catch (err) {
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
    listener({ kind: "status", status: this.liveStatus(run) });
    return () => run.listeners.delete(listener);
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
   * undefined only for a genuinely unknown run (or one marked `lost`, whose snapshot was cleared).
   */
  async read(runId: string): Promise<RunStatus | undefined> {
    const live = this.status(runId);
    if (live) return live;
    const stored = await this.store.load(runId);
    const blob = stored?.snapshot as RunBlob | null | undefined;
    if (!stored || !blob) return undefined;
    const snap = (blob.snapshot ?? {}) as { status?: string; value?: unknown; context?: unknown };
    return {
      runId,
      workflow: blob.workflow,
      instanceId: blob.instanceId,
      // The STORE row is the authority on the run's lifecycle, the snapshot on the Machine's: a
      // cancelled run's actor reports xstate's "stopped", which is mechanism, not an outcome
      // (ADR-0025). While the row still says "live", the Machine's own status is the answer.
      status: stored.status === "live" ? (snap.status ?? stored.status) : stored.status,
      value: snap.value,
      context: snap.context,
      children: runChildren(snap), // the persisted `children` map — same tree, off the store
      fault: blob.fault,
      reason: stored.reason,
    };
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

  /**
   * End every open feed because the host is going away — the shutdown counterpart to `subscribe`.
   *
   * A feed has no natural end: a run parked on a gate transitions for hours, and its watchers hold
   * an in-flight HTTP request the whole time. `server.close()` (instance.ts) waits for in-flight
   * requests, so without this a single attached `j2 run` wedges shutdown indefinitely. `closed` is
   * the frame that lets those handlers exit. Runs themselves are untouched: this ends the
   * OBSERVATION, not the work — the snapshots are already durable, and `restore()` picks them up.
   */
  async close(): Promise<void> {
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
    // Say so BEFORE the actor stops, while there is still a status to read. A stopped run is not a
    // settled one — `persist()` never runs for it (the tracked-run guard drops the scheduled save,
    // keeping the stored status "live" for restore — see `spawn`), so nothing else on this path
    // would ever tell a watcher the run left. Without it the page shows it live forever.
    this.announceGone(run);
    run.actor.stop();
    this.untrack(run.record);
  }

  /**
   * CANCEL: the human's "abandon this run" (`j2 send <run> --event CANCEL` — ADR-0025). It ends
   * the work rather than parking it: stopping the actor with no `hostStopping` flag ends every
   * live Agent invocation, and each one ends its Agent's turn remotely (ADR-0024). The run
   * is then persisted TERMINAL, so `restore()` leaves it alone and `read()` reports how it ended.
   *
   * Ending the turns and refusing to restore are one decision, not two: a cancelled run that came
   * back would re-attach to submissions that settled `aborted`, and `settle`'s rejection would
   * fault a run whose Agents were stopped on purpose.
   */
  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.actor.stop();
    // Persist AFTER the stop: the snapshot is final, and `persist` fans out the last status,
    // announces `gone`, and untracks — the same terminal path a run that settled on its own takes.
    this.persist(run, "cancelled");
  }

  /** Feed a run's final word to both granularities: where it ended, then that it is gone. */
  private announceGone(run: LiveRun, status: RunStatus = this.liveStatus(run)): void {
    this.announce(run.record.workflow, { kind: "status", status });
    this.announce(run.record.workflow, { kind: "gone", runId: run.record.runId });
  }

  // --- internals ---

  /** Put one event on the run's feed: buffer it for ADR-0023's backfill, then fan it out. The
   * buffer and the fan-out share one seat so an attached echo and a later attach see the SAME
   * feed — a projection cannot drift from a record it is read out of. */
  private feed(run: LiveRun, event: RunFeedEvent): void {
    run.feedSoFar.push(event);
    if (run.feedSoFar.length > FEED_SO_FAR_CAP) run.feedSoFar.shift();
    for (const listener of run.listeners) listener(event);
  }

  /**
   * Attach the run-narrative echo (ADR-0023): replay the run's feed-so-far to the Workspace's
   * Harness at `endpoint` — the backfilled preamble, why this Workspace exists — then tee live
   * until detached. FIRE-AND-FORGET is this method's contract: pushes are chained so events
   * arrive in feed order, and a failure is logged once and swallowed — the feed remains the
   * record, the log is a courtesy view, and nothing here can fail a turn, a state, or a run.
   * Scoped to the OWNING run's lineage by construction: it reads one run's buffer and listeners
   * and nothing else — a sibling run's events cannot reach this endpoint through here.
   */
  private attachEcho(runId: string, endpoint: string): () => void {
    const run = this.runs.get(runId);
    const factory = this.echoFactory;
    if (!run || !factory) return () => {};
    const push = factory(endpoint);
    let chain = Promise.resolve();
    let reported = false;
    const enqueue = (events: EchoEvent[]): void => {
      if (events.length === 0) return;
      chain = chain
        .then(() => push(events))
        .catch((err) => {
          // Log-and-continue, ONCE per attachment — an unreachable Harness must not turn every
          // transition into an error line, and must not surface anywhere a run could trip on.
          if (reported) return;
          reported = true;
          console.error(
            `run ${runId}: echo to ${endpoint} failed (log only — the run is unaffected): ` +
              (err instanceof Error ? err.message : String(err)),
          );
        });
    };
    enqueue(run.feedSoFar.map((ev) => echoEventOf(ev, endpoint)).filter((ev): ev is EchoEvent => ev !== undefined));
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
      fault: run.fault,
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
  ): AnyActor {
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
      table: this.table,
      sandbox: this.sandbox,
      instanceHarness: this.instanceHarness,
      // The admission ledger's write half (ADR-0016): the Agent actor reports the durable handle the
      // moment the Harness admits it, and the ledger hits the store in the same RunBlob save. An
      // admission arriving around stop/untrack still lands in `agents` but skips the save,
      // exactly like the persist scheduler's tracked-run guard.
      recordAdmission: (instanceId, admission) => {
        agents[instanceId] = admission;
        const run = this.runs.get(record.runId);
        if (run && run.agents === agents) this.persist(run);
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
      marker: (event) => {
        const run = this.runs.get(record.runId);
        if (run && run.binding === binding) this.feed(run, event);
      },
      // The run-narrative echo attach (ADR-0023), called from `workspace()`'s registrar.
      echo: (endpoint) => this.attachEcho(record.runId, endpoint),
    };
    let bound = false;
    const actor = createActor(machine, {
      ...options,
      inspect: (ev) => {
        // Bind the run's actor SYSTEM on the ROOT's creation event — the first inspection event,
        // fired inside createActor BEFORE any child of the initial state is constructed. That
        // ordering matters: j2Setup's wrapped invoke inputs (iid minting — ADR-0016) run at child
        // construction and must already see the run identity. The system is shared by every actor
        // in the tree, which is what run-scopes gate ids with zero workflow plumbing (ADR-0011).
        if (!bound && ev.type === "@xstate.actor") {
          bound = true;
          bindRun((ev.actorRef as AnyActorRef).system, binding);
        }
        // Forward the workflow author's `emit({...})` onto the feeds, from EVERY actor in the
        // tree as it is created: xstate scopes emitted events to the actor that emits them — no
        // bubbling — and a run's Emits mostly happen in child machines (a `workspace()` body IS
        // one). A root-only subscription silently dropped exactly the Emits ADR-0022/0023 exist
        // to surface. The subscription dies with its actor; restore re-creates both.
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
        if (ev.type === "@xstate.snapshot") schedule();
      },
    });
    live = this.track(record, actor, def, agents, binding);
    return actor;
  }

  private track(
    record: RunRecord,
    actor: AnyActor,
    def: WorkflowDef,
    agents: Record<string, AgentAdmission>,
    binding: RunBinding,
  ): LiveRun {
    const run: LiveRun = { record, actor, def, agents, binding, listeners: new Set(), feedSoFar: [] };
    this.runs.set(record.runId, run);
    // Ordinary persistence rides the inspection stream (see `spawn`); the subscription exists
    // for the ERROR channel: an errored actor (an invoke threw — e.g. ADR-0011's invoke-time
    // manifest check) reports here. Capture the message (xstate serializes the Error itself to
    // `{}`), then persist: the snapshot's "error" status stores the run and untracks it.
    actor.subscribe({
      error: (err) => {
        run.fault = err instanceof Error ? err.message : String(err);
        this.persist(run);
        // Nothing to release: a faulted run stops its actors, and each workspace's lease is one
        // of them (ADR-0021). The pod stays up for inspection (ADR-0012's destroy-less terminal)
        // and ages out of the operator's idle timeout on its own.
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
   * `terminal` is the run-lifecycle verdict the MACHINE cannot supply: `cancel()` passes
   * "cancelled", because xstate only knows its actor was stopped (ADR-0025). It is the stored
   * status and the one the feeds report.
   */
  private persist(run: LiveRun, terminal?: string): void {
    const snapshot = run.actor.getPersistedSnapshot();
    const machineStatus = (snapshot as { status?: string }).status ?? "active";
    const serialized = serializeSnapshot(snapshot, {
      stripContext: (ctx) => ctx, // see ADR-0007: live infra lives in `.provide` closures, not context
      stripChildInput: (input) => input,
    });
    const blob: RunBlob = {
      workflow: run.record.workflow,
      instanceId: run.record.instanceId,
      // Stamped on every save, off the registered TEMPLATE (never the per-run `.provide()` result —
      // providers do not change shape, and `fingerprintOf` memoizes per machine object). ADR-0030.
      machine: fingerprintOf(run.def.machine),
      snapshot: serialized,
      agents: run.agents,
      fault: run.fault,
    };
    const status = terminal ?? (machineStatus === "active" ? "live" : machineStatus);
    void this.store.save(run.record.runId, blob, status);

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
    } else {
      this.announce(run.record.workflow, { kind: "status", status: runStatus });
    }
  }
}
