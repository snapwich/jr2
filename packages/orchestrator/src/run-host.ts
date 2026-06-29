// The Machine host: runs an xstate Machine as a durable run and wires the three slice-1 modules
// together (ADR-0002/0003/0007). It is the integration seam the modules left open.
//
// Wiring (host-owned MCP mux — ADR-0002 "Refined: multi-run instance"):
//   - The host owns ONE ControlPlane. Each run's tool server (`controlPlane.server(instanceId)`)
//     is exposed via `mcpServer(instanceId)` for the hono slice to mount on `/mcp/:instanceId`.
//   - Domain tool calls arrive over MCP → `ControlPlane.onEvent(event)` (carrying `instanceId`) →
//     `routeUp` looks up the owning run → `actor.send(event)` into that Machine. (MCP = domain.)
//   - The run's `agentRun` child surfaces `agent.offset` telemetry UP to its own parent Machine
//     directly via `sendBack`; the Machine `assign`s it into context so the durable handle rides
//     in the snapshot. (flue stream = offset/telemetry.)
//   - Deferred approvals are answered centrally: `answer(runId, decision)` →
//     `controlPlane.resolveApproval(instanceId, decision)` releases the Agent's blocked tool call.
//
// Durability (ADR-0007): a snapshot is persisted after every transition. Live infrastructure (the
// FlueClient-backed `agentRun` actor) is injected via `.provide()` at start AND restore, never
// persisted — so the snapshot is JSON-safe and restore re-attaches by rewriting the child's
// persisted input (drop `prompt`, set `attachOffset`) rather than re-POSTing the prompt.

import { randomUUID } from "node:crypto";
import { createActor, type AnyActor, type AnyActorLogic, type AnyStateMachine } from "xstate";
import type { ControlEvent } from "@j2/agent-protocol";
import { ControlPlane } from "./control-plane.ts";
import type { SnapshotStore } from "./snapshot-store.ts";
import { hydrateSnapshot, serializeSnapshot } from "./durability.ts";

/** The live providers a run is assembled with (ADR-0003). Built fresh at start and at restore. */
export type RunProviders = { actors?: Record<string, AnyActorLogic> };

/** A registered workflow: a template Machine plus how to fill its live slots for one run. */
export type WorkflowDef = {
  name: string;
  /** The template; slots (e.g. `agentRun`) are referenced by name and filled by `provide`. */
  machine: AnyStateMachine;
  /** Build this run's live providers. `controlPlane` lets a provider wire the run's MCP surface. */
  provide: (ctx: { instanceId: string; controlPlane: ControlPlane }) => RunProviders;
};

/** The serializable identity of a run — what reconcile sees and what restore rebuilds from. */
export type RunRecord = { runId: string; workflow: string; instanceId: string };

/** A run's current observable state. */
export type RunStatus = RunRecord & { status: string; value: unknown; context: unknown };

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
};

/** What we persist per run: the machine snapshot wrapped with the run metadata restore needs. */
type RunBlob = { workflow: string; instanceId: string; snapshot: unknown };

type LiveRun = {
  record: RunRecord;
  actor: AnyActor;
  def: WorkflowDef;
  /** Per-run observers fed by `persist()` (status) and the actor's `emit` (emit) — SSE/CLI watch. */
  listeners: Set<(e: RunFeedEvent) => void>;
};

export class RunHost {
  /** The single MCP control plane; its events are routed by `instanceId` into the owning run. */
  readonly controlPlane: ControlPlane;

  private readonly store: SnapshotStore;
  private readonly reconcile: (run: RunRecord) => boolean | Promise<boolean>;
  private readonly newId: () => string;
  private readonly workflowDefs = new Map<string, WorkflowDef>();
  private readonly runs = new Map<string, LiveRun>();
  private readonly byInstance = new Map<string, string>();

  constructor(opts: RunHostOptions) {
    this.store = opts.store;
    this.reconcile = opts.reconcile ?? (() => true);
    this.newId = opts.newId ?? (() => randomUUID());
    this.controlPlane = new ControlPlane((e) => this.routeUp(e));
  }

  /** Register a workflow so `start`/`restore` can run it. */
  register(def: WorkflowDef): void {
    this.workflowDefs.set(def.name, def);
  }

  /** The names of every registered workflow (the `GET /workflows` listing — ADR-0009). */
  workflows(): string[] {
    return [...this.workflowDefs.keys()];
  }

  /** Start a fresh run of a registered workflow; returns its durable ids. */
  async start(workflow: string, input: Record<string, unknown> = {}): Promise<{ runId: string; instanceId: string }> {
    const def = this.workflowDefs.get(workflow);
    if (!def) throw new Error(`no workflow registered as "${workflow}"`);

    const runId = this.newId();
    const instanceId = this.newId();
    const record: RunRecord = { runId, workflow, instanceId };

    const machine = this.assemble(def, instanceId);
    const actor = createActor(machine, { input: { ...input, instanceId } });
    this.track(record, actor, def);
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

      const offsets = offsetsOf(blob.snapshot);
      const hydrated = hydrateSnapshot(blob.snapshot, {
        injectContext: (ctx) => ctx, // providers are re-supplied via `.provide`, so context is data-only
        rewriteChildInput: (input) =>
          isChildInput(input) ? { ...input, prompt: undefined, attachOffset: offsets[input.instanceId] } : input,
      });

      const actor = createActor(this.assemble(def, blob.instanceId), { snapshot: hydrated as never });
      this.track(record, actor, def);
      actor.start();
      reattached.push(stored.runId);
    }

    return { reattached, lost };
  }

  /** Answer a run's outstanding `request_approval` (ADR-0009 human-in-the-loop down-channel). */
  answer(runId: string, decision: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`no active run "${runId}"`);
    this.controlPlane.resolveApproval(run.record.instanceId, decision);
  }

  /** Steer a live run: queue a down-channel message the Agent pulls on `check_inbox` (ADR-0009). */
  steer(runId: string, msg: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`no active run "${runId}"`);
    this.controlPlane.enqueueInbox(run.record.instanceId, msg);
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

  /** The MCP server for a run's instance — the hono slice mounts this on `/mcp/:instanceId`. */
  mcpServer(instanceId: string) {
    return this.controlPlane.server(instanceId);
  }

  /** A run's LIVE status — undefined once it settles and is dropped from the registry. Sync. */
  status(runId: string): RunStatus | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const snap = run.actor.getSnapshot();
    return { ...run.record, status: snap.status, value: snap.value, context: snap.context };
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

  /** Route a domain ControlEvent from the MCP plane into the Machine that owns its instance. */
  private routeUp(event: ControlEvent): void {
    const runId = this.byInstance.get(event.instanceId);
    if (!runId) return; // orphaned event (run already settled / unknown instance) — the catch point
    this.runs.get(runId)?.actor.send(event);
  }

  private track(record: RunRecord, actor: AnyActor, def: WorkflowDef): void {
    const run: LiveRun = { record, actor, def, listeners: new Set() };
    this.runs.set(record.runId, run);
    this.byInstance.set(record.instanceId, record.runId);
    actor.subscribe(() => this.persist(run));
    // Forward the workflow author's `emit({...})` to observers as the SSE `emit` channel. These are
    // human-facing progress/notice messages, distinct from the auto status deltas `persist()` feeds.
    actor.on("*", (emitted) => {
      const event = emitted as { type: string } & Record<string, unknown>;
      for (const listener of run.listeners) listener({ kind: "emit", event });
    });
  }

  private untrack(record: RunRecord): void {
    this.runs.delete(record.runId);
    this.byInstance.delete(record.instanceId);
  }

  /** Persist the run's snapshot after a transition; drop it from the registry once final. */
  private persist(run: LiveRun): void {
    const snapshot = run.actor.getPersistedSnapshot();
    const machineStatus = (snapshot as { status?: string }).status ?? "active";
    const serialized = serializeSnapshot(snapshot, {
      stripContext: (ctx) => ctx, // see ADR-0007: live infra lives in `.provide` closures, not context
      stripChildInput: (input) => input,
    });
    const blob: RunBlob = { workflow: run.record.workflow, instanceId: run.record.instanceId, snapshot: serialized };
    const status = machineStatus === "active" ? "live" : machineStatus;
    void this.store.save(run.record.runId, blob, status);

    // Feed per-run observers (SSE/CLI watch). On the terminal transition emit the final status
    // BEFORE untrack drops the run from the registry, then drop the now-useless listener set.
    const snap = run.actor.getSnapshot();
    const runStatus: RunStatus = { ...run.record, status: snap.status, value: snap.value, context: snap.context };
    for (const listener of run.listeners) listener({ kind: "status", status: runStatus });

    if (status !== "live") {
      this.untrack(run.record);
      run.listeners.clear();
    }
  }
}

/** Read `context.offsets` (the durable handle map) out of a persisted machine snapshot. */
function offsetsOf(snapshot: unknown): Record<string, string> {
  const ctx = (snapshot as { context?: { offsets?: Record<string, string> } } | null)?.context;
  return ctx?.offsets ?? {};
}

/** A persisted `agentRun` child input carries an `instanceId`; that's how we key its offset. */
function isChildInput(input: unknown): input is { instanceId: string; [k: string]: unknown } {
  return !!input && typeof input === "object" && typeof (input as { instanceId?: unknown }).instanceId === "string";
}
