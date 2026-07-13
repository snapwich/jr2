// The Machine host: runs an xstate Machine as a durable run and wires the three slice-1 modules
// together (ADR-0002/0003/0007). It is the integration seam the modules left open.
//
// Wiring (ADR-0011 registration table — no routing layer):
//   - The host owns ONE RegistrationTable and binds each run's actor system to it at track time;
//     `gate` and `agentRun` register their invocation's event surface there, with deliver
//     closures over their own `sendBack` — so delivery lands on the invoking state at any
//     nesting depth and the host routes nothing.
//   - The ControlPlane is the MCP dialect adapter over the table: `mcpServer(instanceId)` builds
//     a server from the iid's LIVE registration for the hono slice to mount on `/mcp/:iid` (no
//     registration → no server → 404, the one catch point). The gates HTTP routes are the other
//     adapter (`gates` / `sendToGate`).
//   - The run's `agentRun` child surfaces `agent.offset` telemetry UP to its own parent Machine
//     directly via `sendBack`; the Machine `assign`s it into context so the durable handle rides
//     in the snapshot. (flue stream = offset/telemetry; MCP = domain events.)
//   - A held `deferred` tool result is answered centrally: `answer(runId, decision)` →
//     `controlPlane.answerRun` releases the Agent's blocked call.
//
// Durability (ADR-0007): a snapshot is persisted after every transition. Live infrastructure (the
// FlueClient-backed `agentRun` actor) is injected via `.provide()` at start AND restore, never
// persisted — so the snapshot is JSON-safe and restore re-attaches by rewriting the child's
// persisted input (drop `prompt`, set `attachOffset`) rather than re-POSTing the prompt.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createActor, type AnyActor, type AnyActorLogic, type AnyStateMachine } from "xstate";
import { eventMap, type EventDef } from "@j2/agent-protocol";
import { ControlPlane } from "./control-plane.ts";
import { bindRun, EventValidationError, gateAddress, RegistrationTable, UnknownAddressError } from "./registration.ts";
import type { SandboxPort } from "./workspace.ts";
import { serializeMachine, type MachineDoc } from "./machine-doc.ts";
import type { SnapshotStore } from "./snapshot-store.ts";
import { reattachAgentRuns, serializeSnapshot } from "./durability.ts";

/** The live providers a run is assembled with (ADR-0003). Built fresh at start and at restore. */
export type RunProviders = { actors?: Record<string, AnyActorLogic> };

/** A registered workflow: a template Machine plus how to fill its live slots for one run. */
export type WorkflowDef = {
  name: string;
  /** The template; slots (e.g. `agentRun`) are referenced by name and filled by `provide`. */
  machine: AnyStateMachine;
  /**
   * The workflow's declared event vocabulary (its `export const events` manifest — ADR-0011).
   * Names resolve per-workflow against this set; absent means "accepts no workflow events".
   */
  events?: readonly EventDef[];
  /** Build this run's live providers. `controlPlane` lets a provider wire the run's MCP surface. */
  provide: (ctx: { instanceId: string; controlPlane: ControlPlane }) => RunProviders;
};

/** The serializable identity of a run — what reconcile sees and what restore rebuilds from. */
export type RunRecord = { runId: string; workflow: string; instanceId: string };

/** A run's current observable state. `fault` carries the error message when status is "error"
 * (e.g. a gate invoked with a name outside the workflow's manifest — ADR-0011). */
export type RunStatus = RunRecord & { status: string; value: unknown; context: unknown; fault?: string };

/** One open gate as external callers discover it (`GET /runs/:id` — ADR-0011): the accepted
 * events with their input schemas as JSON Schema (what drives a form or a `j2 send` prompt),
 * plus the workflow-supplied `meta` (what a UI renders and a webhook translator matches on). */
export type GateView = {
  gate: string;
  accepts: Array<{ name: string; description?: string; input: unknown }>;
  meta?: Record<string, unknown>;
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

/** What we persist per run: the machine snapshot wrapped with the run metadata restore needs. */
type RunBlob = { workflow: string; instanceId: string; snapshot: unknown; fault?: string };

type LiveRun = {
  record: RunRecord;
  actor: AnyActor;
  def: WorkflowDef;
  /** The error that killed the run, if it errored (xstate serializes Error to `{}`, so the
   * message is captured here at the observer and persisted onto the blob for `read`). */
  fault?: string;
  /** Per-run observers fed by `persist()` (status) and the actor's `emit` (emit) — SSE/CLI watch. */
  listeners: Set<(e: RunFeedEvent) => void>;
};

export class RunHost {
  /** The MCP dialect adapter over the registration table (deferred holds + inboxes live there). */
  readonly controlPlane: ControlPlane;
  /** The internal registration table both delivery dialects share (ADR-0011). Callback actors
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
    this.controlPlane = new ControlPlane(this.table);
  }

  /** Register a workflow so `start`/`restore` can run it. Re-registering replaces (dev reload).
   * The events manifest is resolved here so a malformed vocabulary (duplicate names, non-defs)
   * fails at registration — naming the workflow — rather than at delivery. */
  register(def: WorkflowDef): void {
    this.workflowEvents.set(def.name, eventMap(def.name, def.events ?? []));
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

      // Re-attach every persisted agentRun input in the TREE (GAP(5)): bodies own their durable
      // handles, so each machine level's `context.offsets` scopes the rewrites below it.
      const hydrated = reattachAgentRuns(blob.snapshot);

      const actor = this.spawn(this.assemble(def, blob.instanceId), { snapshot: hydrated as never }, record, def);
      actor.start();
      reattached.push(stored.runId);
    }

    return { reattached, lost };
  }

  /** Answer a run's outstanding held `deferred` tool call (ADR-0009 APPROVE down-channel). */
  answer(runId: string, decision: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`no active run "${runId}"`);
    this.controlPlane.answerRun(runId, { decision });
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

  /** Steer a live run: queue a down-channel message its Agent pulls on its next poll (ADR-0009). */
  steer(runId: string, msg: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`no active run "${runId}"`);
    this.controlPlane.steerRun(runId, msg);
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
    const snap = run.actor.getSnapshot();
    listener({
      kind: "status",
      status: { ...run.record, status: snap.status, value: snap.value, context: snap.context },
    });
    return () => run.listeners.delete(listener);
  }

  /** The MCP server over an instance's LIVE registration — mounted on `/mcp/:instanceId`.
   * Undefined when nothing is registered (settled run, exited state): the one catch point. */
  mcpServer(instanceId: string) {
    return this.controlPlane.server(instanceId);
  }

  /** A run's LIVE status — undefined once it settles and is dropped from the registry. Sync. */
  status(runId: string): RunStatus | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const snap = run.actor.getSnapshot();
    return { ...run.record, status: snap.status, value: snap.value, context: snap.context, fault: run.fault };
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
      fault: blob.fault,
    };
  }

  list(): RunStatus[] {
    return [...this.runs.keys()].map((id) => this.status(id)).filter((s): s is RunStatus => s !== undefined);
  }

  /** Stop a run in-process (abandons its Agent via the actor's stop path). Does not delete state. */
  async stop(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.actor.stop();
    this.untrack(run.record);
  }

  // --- internals ---

  /** Fill the template's live slots for one run (ADR-0003 provider injection). */
  private assemble(def: WorkflowDef, instanceId: string): AnyStateMachine {
    const providers = def.provide({ instanceId, controlPlane: this.controlPlane });
    return def.machine.provide(providers as Parameters<AnyStateMachine["provide"]>[0]);
  }

  /**
   * Create + track a run's root actor. Persistence is driven by the actor system's INSPECTION
   * stream, not the root subscription: a nested body's transition (e.g. a grandchild
   * `agent.offset` assigned into the body's context — GAP(5)) never notifies root subscribers,
   * but it must hit the store, or a crash would restore stale offsets. Snapshot events within
   * one macrostep are coalesced per microtask, and a persist scheduled around stop/untrack is
   * dropped by the tracked-run guard (so `stop()` keeps the stored status "live" for restore).
   */
  private spawn(
    machine: AnyStateMachine,
    options: { input?: Record<string, unknown>; snapshot?: never },
    record: RunRecord,
    def: WorkflowDef,
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
    live = this.track(record, actor, def);
    return actor;
  }

  private track(record: RunRecord, actor: AnyActor, def: WorkflowDef): LiveRun {
    // Bind the run's actor SYSTEM (shared by every actor in the tree, at any nesting depth) to
    // its identity BEFORE start, so gate/agentRun registrations resolve their run mechanically —
    // this is what run-scopes gate ids with zero workflow plumbing (ADR-0011).
    bindRun(actor.system, {
      runId: record.runId,
      workflow: record.workflow,
      events: this.workflowEvents.get(def.name) ?? new Map(),
      table: this.table,
      sandbox: this.sandbox,
    });
    const run: LiveRun = { record, actor, def, listeners: new Set() };
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
      fault: run.fault,
    };
    const status = machineStatus === "active" ? "live" : machineStatus;
    void this.store.save(run.record.runId, blob, status);

    // Feed per-run observers (SSE/CLI watch). On the terminal transition emit the final status
    // BEFORE untrack drops the run from the registry, then drop the now-useless listener set.
    const snap = run.actor.getSnapshot();
    const runStatus: RunStatus = {
      ...run.record,
      status: snap.status,
      value: snap.value,
      context: snap.context,
      fault: run.fault,
    };
    for (const listener of run.listeners) listener({ kind: "status", status: runStatus });

    if (status !== "live") {
      this.untrack(run.record);
      run.listeners.clear();
    }
  }
}
