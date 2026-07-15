// The Machine host: runs an xstate Machine as a durable run and wires the three slice-1 modules
// together (ADR-0002/0003/0007). It is the integration seam the modules left open.
//
// Wiring (ADR-0011 registration table — no routing layer):
//   - The host owns ONE RegistrationTable and binds each run's actor system to it at track time;
//     `gate` and `agentRun` register their invocation's event surface there, with deliver
//     closures over their own `sendBack` — so delivery lands on the invoking state at any
//     nesting depth and the host routes nothing.
//   - Two thin surfaces sit on that table, and NEITHER is MCP (ADR-0013 — the Orchestrator does
//     not speak it): `agentSurface` / `sendToAgent` serve the Agent's Adapter (`/agents/:iid/*`),
//     `gates` / `sendToGate` serve humans, webhooks and CI (`/runs/:id/gates/*`). Lookup,
//     validation, delivery and lifecycle stay implemented once, in the table.
//   - The run's `agentRun` children report their durable admissions through the run binding into
//     the host LEDGER (`RunBlob.agents` — ADR-0016), persisted in the same save as the snapshot.
//     (flue surface = lifecycle; the agent surface = domain events.)
//
// Durability (ADR-0007): a snapshot is persisted after every transition. Live infrastructure (the
// FlueClient-backed `agentRun` actor) is injected via `.provide()` at start AND restore, never
// persisted — so the snapshot is JSON-safe and restore re-attaches by rewriting the child's
// persisted input (drop `prompt`, set `attach` from the ledger) rather than re-POSTing the prompt.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createActor, type AnyActor, type AnyActorLogic, type AnyStateMachine } from "xstate";
import type { EventDef, EventSemantics } from "@j2/agent-protocol";
import { vocabularyOf } from "./vocabulary.ts";
import {
  agentAddress,
  bindRun,
  EventValidationError,
  gateAddress,
  RegistrationTable,
  UnknownAddressError,
} from "./registration.ts";
import type { SandboxPort } from "./workspace.ts";
import { serializeMachine, type MachineDoc } from "./machine-doc.ts";
import type { SnapshotStore } from "./snapshot-store.ts";
import type { AgentAdmission } from "./actor.ts";
import { reattachAgentRuns, serializeSnapshot } from "./durability.ts";

/** The live providers a run is assembled with (ADR-0003). Built fresh at start and at restore. */
export type RunProviders = { actors?: Record<string, AnyActorLogic> };

/** A registered workflow: a template Machine plus how to fill its live slots for one run. */
export type WorkflowDef = {
  name: string;
  /** The template; slots (e.g. `agentRun`) are referenced by name and filled by `provide`. */
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
};

/**
 * A run as an UNAUTHENTICATED observer may see it: which run, of what workflow, and where in the
 * Machine it is. That is the whole set — enough to light up a state in the visualizer, and nothing
 * more.
 *
 * What is absent is the point. `context` is the workflow's working data (branch names, ticket
 * bodies, review verdicts, flue endpoints) and `instanceId`/`fault` name live infrastructure and
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
 * One item on a run's observation feed (the `GET /runs/:id/events` SSE stream — ADR-0009). Two kinds:
 * a `status` snapshot delta (emitted on every transition, and replayed once on attach), and an `emit`
 * — a message the workflow author surfaced via xstate `emit({...})` for whoever is watching.
 */
export type RunFeedEvent =
  | { kind: "status"; status: RunStatus }
  | { kind: "emit"; event: { type: string } & Record<string, unknown> };

export type RunHostOptions = {
  store: SnapshotStore;
  /** Probe the live world before re-attaching on restore (ADR-0007). Default: always present. */
  reconcile?: (run: RunRecord) => boolean | Promise<boolean>;
  /** Injectable id generator (deterministic ids in tests). Default: `crypto.randomUUID`. */
  newId?: () => string;
  /** The Sandbox backend `workspace()` provisions through (ADR-0012). Absent = no cluster:
   * workspace-less workflows run fine; a `workspace()` invocation faults its run pointedly. */
  sandbox?: SandboxPort;
};

/** What we persist per run: the machine snapshot wrapped with the run metadata restore needs.
 * `agents` is the admission LEDGER (ADR-0016) — iid → durable admission, reported by `agentRun`
 * through the run binding and saved in the same blob (same store, same atomicity). */
type RunBlob = {
  workflow: string;
  instanceId: string;
  snapshot: unknown;
  agents?: Record<string, AgentAdmission>;
  fault?: string;
};

type LiveRun = {
  record: RunRecord;
  actor: AnyActor;
  def: WorkflowDef;
  /** The live admission ledger (ADR-0016): persisted as `RunBlob.agents`, seeded on restore. */
  agents: Record<string, AgentAdmission>;
  /** The error that killed the run, if it errored (xstate serializes Error to `{}`, so the
   * message is captured here at the observer and persisted onto the blob for `read`). */
  fault?: string;
  /** Per-run observers fed by `persist()` (status) and the actor's `emit` (emit) — SSE/CLI watch. */
  listeners: Set<(e: RunFeedEvent) => void>;
};

export class RunHost {
  /** The internal registration table both delivery surfaces share (ADR-0011). Callback actors
   * (`gate`, `agentRun`) reach it via the run binding, not this field. */
  private readonly table = new RegistrationTable();

  private readonly store: SnapshotStore;
  private readonly reconcile: (run: RunRecord) => boolean | Promise<boolean>;
  private readonly newId: () => string;
  private readonly sandbox?: SandboxPort;
  private readonly workflowDefs = new Map<string, WorkflowDef>();
  /** Per-workflow name→def resolution scope, built (and validated) at registration. */
  private readonly workflowEvents = new Map<string, Map<string, EventDef>>();
  private readonly runs = new Map<string, LiveRun>();

  constructor(opts: RunHostOptions) {
    this.store = opts.store;
    this.reconcile = opts.reconcile ?? (() => true);
    this.newId = opts.newId ?? (() => randomUUID());
    this.sandbox = opts.sandbox;
  }

  /** Register a workflow so `start`/`restore` can run it. Re-registering replaces (dev reload).
   * The vocabulary rides the machine object (ADR-0015): `j2Setup.createMachine` attached it,
   * already validated. A machine not built by j2Setup accepts no workflow events. */
  register(def: WorkflowDef): void {
    this.workflowEvents.set(def.name, vocabularyOf(def.machine) ?? new Map());
    this.workflowDefs.set(def.name, def);
  }

  /** Drop a workflow's registration (a `workflows/` file was deleted — `j2 dev` reload). In-flight
   * runs keep their already-assembled definition; only future `start`s are affected. */
  unregister(name: string): void {
    this.workflowDefs.delete(name);
    this.workflowEvents.delete(name);
  }

  /** A workflow's declared event vocabulary, resolved name→def (empty for an eventless workflow). */
  events(name: string): Map<string, EventDef> | undefined {
    return this.workflowEvents.get(name);
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

  /** Start a fresh run of a registered workflow; returns its durable ids. */
  async start(workflow: string, input: Record<string, unknown> = {}): Promise<{ runId: string; instanceId: string }> {
    const def = this.workflowDefs.get(workflow);
    if (!def) throw new Error(`no workflow registered as "${workflow}"`);

    const runId = this.newId();
    const instanceId = this.newId();
    const record: RunRecord = { runId, workflow, instanceId };

    const machine = this.assemble(def, instanceId);
    const actor = this.spawn(machine, { input: { ...input, instanceId } }, record, def);
    actor.start();
    return { runId, instanceId };
  }

  /**
   * Restore every persisted live run: hydrate, reconcile against the live world, and either
   * re-attach (re-spawn from the rewritten child input) or mark lost. Returns the run ids handled.
   */
  async restore(): Promise<{ reattached: string[]; lost: string[] }> {
    const reattached: string[] = [];
    const lost: string[] = [];

    for (const stored of await this.store.list()) {
      if (stored.status !== "live") continue;
      const blob = stored.snapshot as RunBlob | null;
      const def = blob ? this.workflowDefs.get(blob.workflow) : undefined;
      if (!blob || !def) {
        await this.store.markLost(stored.runId, blob ? `no workflow "${blob.workflow}"` : "empty snapshot");
        lost.push(stored.runId);
        continue;
      }

      const record: RunRecord = { runId: stored.runId, workflow: blob.workflow, instanceId: blob.instanceId };
      if (!(await this.reconcile(record))) {
        await this.store.markLost(stored.runId, "reconcile: live world absent");
        lost.push(stored.runId);
        continue;
      }

      // Re-attach every persisted agentRun input in the TREE from the admission ledger
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
    }

    return { reattached, lost };
  }

  /**
   * An agent instance's LIVE surface (`GET /agents/:iid/surface` — ADR-0013): what the state that
   * invoked this Agent accepts, right now. Undefined once nothing is registered (the state exited,
   * the run settled, the iid is unknown) — the one catch point, and the reason the Adapter never
   * has to learn which turn is live: it asks, per turn, and the answer IS the turn.
   */
  agentSurface(instanceId: string): AgentSurfaceView | undefined {
    const reg = this.table.lookup(agentAddress(instanceId));
    if (!reg) return undefined;
    return {
      instanceId,
      runId: reg.runId,
      sandbox: reg.sandbox,
      accepts: [...reg.defs.values()].map((def) => ({
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
   *
   * The `deliveryId` is that receipt: an outcome stays ADDRESSABLE after the fact, which is the
   * room a deferred result needs when it lands (flue's 60s MCP timeout means the answer will be
   * poll-with-progress, not a held socket). Nothing polls it today, deliberately.
   */
  sendToAgent(instanceId: string, event: { type?: unknown } & Record<string, unknown>): { deliveryId: string } {
    const { type, ...payload } = event;
    if (typeof type !== "string" || !type) {
      throw new EventValidationError(`event body must carry a string "type" (one of the surface's accepted names)`);
    }
    this.table.deliver(agentAddress(instanceId), type, payload);
    return { deliveryId: this.newId() };
  }

  /** A run's open gates as callers discover them (`GET /runs/:id` — ADR-0011). Settled/unknown
   * run → empty: a gate is a LIVE surface, it does not outlive its state. */
  gates(runId: string): GateView[] {
    return this.table
      .byRun(runId)
      .filter((reg) => reg.kind === "gate")
      .map((reg) => ({
        gate: reg.id,
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
      status: snap.status ?? stored.status,
      value: snap.value,
      context: snap.context,
      children: runChildren(snap), // the persisted `children` map — same tree, off the store
      fault: blob.fault,
    };
  }

  list(): RunStatus[] {
    return [...this.runs.keys()].map((id) => this.status(id)).filter((s): s is RunStatus => s !== undefined);
  }

  /** The live runs of ONE workflow, projected for observers (the visualizer's run list). Scoped
   * server-side: an observer asks about a workflow it can already name, and gets back only runs of
   * it — never a listing of everything this orchestrator happens to be running. */
  observations(workflow: string): RunObservation[] {
    return this.list()
      .filter((s) => s.workflow === workflow)
      .map(observe);
  }

  /** Stop a run in-process (abandons its Agent via the actor's stop path). Does not delete state. */
  async stop(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.actor.stop();
    this.untrack(run.record);
  }

  // --- internals ---

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

  /** Fill the template's live slots for one run (ADR-0003 provider injection). */
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
    const actor = createActor(machine, {
      ...options,
      inspect: (ev) => {
        if (ev.type === "@xstate.snapshot") schedule();
      },
    });
    live = this.track(record, actor, def, agents);
    return actor;
  }

  private track(record: RunRecord, actor: AnyActor, def: WorkflowDef, agents: Record<string, AgentAdmission>): LiveRun {
    const run: LiveRun = { record, actor, def, agents, listeners: new Set() };
    // Bind the run's actor SYSTEM (shared by every actor in the tree, at any nesting depth) to
    // its identity BEFORE start, so gate/agentRun registrations resolve their run mechanically —
    // this is what run-scopes gate ids with zero workflow plumbing (ADR-0011).
    bindRun(actor.system, {
      runId: record.runId,
      workflow: record.workflow,
      events: this.workflowEvents.get(def.name) ?? new Map(),
      table: this.table,
      sandbox: this.sandbox,
      // The admission ledger's write half (ADR-0016): `agentRun` reports the durable handle the
      // moment flue admits it, and the ledger hits the store in the same RunBlob save. An
      // admission arriving around stop/untrack still lands in `run.agents` but skips the save,
      // exactly like the persist scheduler's tracked-run guard.
      recordAdmission: (instanceId, admission) => {
        run.agents[instanceId] = admission;
        if (this.runs.get(record.runId) === run) this.persist(run);
      },
    });
    this.runs.set(record.runId, run);
    // Ordinary persistence rides the inspection stream (see `spawn`); the subscription exists
    // for the ERROR channel: an errored actor (an invoke threw — e.g. ADR-0011's invoke-time
    // manifest check) reports here. Capture the message (xstate serializes the Error itself to
    // `{}`), then persist: the snapshot's "error" status stores the run and untracks it.
    actor.subscribe({
      error: (err) => {
        run.fault = err instanceof Error ? err.message : String(err);
        this.persist(run);
      },
    });
    // Forward the workflow author's `emit({...})` to observers as the SSE `emit` channel. These are
    // human-facing progress/notice messages, distinct from the auto status deltas `persist()` feeds.
    actor.on("*", (emitted) => {
      const event = emitted as { type: string } & Record<string, unknown>;
      for (const listener of run.listeners) listener({ kind: "emit", event });
    });
    return run;
  }

  private untrack(record: RunRecord): void {
    this.runs.delete(record.runId);
  }

  /** Persist the run's snapshot after a transition; drop it from the registry once final. */
  private persist(run: LiveRun): void {
    const snapshot = run.actor.getPersistedSnapshot();
    const machineStatus = (snapshot as { status?: string }).status ?? "active";
    const serialized = serializeSnapshot(snapshot, {
      stripContext: (ctx) => ctx, // see ADR-0007: live infra lives in `.provide` closures, not context
      stripChildInput: (input) => input,
    });
    const blob: RunBlob = {
      workflow: run.record.workflow,
      instanceId: run.record.instanceId,
      snapshot: serialized,
      agents: run.agents,
      fault: run.fault,
    };
    const status = machineStatus === "active" ? "live" : machineStatus;
    void this.store.save(run.record.runId, blob, status);

    // Feed per-run observers (SSE/CLI watch). On the terminal transition emit the final status
    // BEFORE untrack drops the run from the registry, then drop the now-useless listener set.
    //
    // Persistence rides the INSPECTION stream (see `spawn`), which fires on a child's transitions
    // too — so this frame lands on child movement, and its `children` tree carries the new state.
    // That is the entire live half of the visualizer's child diagrams: no extra subscription.
    const runStatus = this.liveStatus(run);
    for (const listener of run.listeners) listener({ kind: "status", status: runStatus });

    if (status !== "live") {
      this.untrack(run.record);
      run.listeners.clear();
    }
  }
}
