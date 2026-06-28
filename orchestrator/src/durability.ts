// Orchestrator crash/restore wiring (PoC #7) — the load-bearing module.
//
// `runOrchestrator` is the seam the entrypoint calls. It:
//   • loads any persisted snapshot for this run id,
//   • on a restore, RECONCILES against the live world before trusting it,
//   • restores (or freshly creates) the driveMachine actor,
//   • persists the snapshot on EVERY transition (so the next crash loses nothing),
//   • drives the mocked-human approval decision,
//   • and re-attaches to the in-flight Agent run rather than restarting it.
//
// The re-attach itself lives in machine.ts (`attachOffset: context.attachOffset ??
// context.offset`); this module's job is to feed that a faithfully-restored context.
//
// Two facts shape the codec below:
//   • xstate re-spawns invoked actors FRESH on restore — their fromCallback closure
//     is gone, so only the Machine's serializable context survives. Re-attach must
//     ride persisted context (the offset), which it does.
//   • DriveContext carries a LIVE `controlPlane` (an http.Server). It cannot be
//     JSON-persisted, so we strip it before saving and re-inject it on restore.

import { createActor, type AnyActorRef } from "xstate";
import { driveMachine, type DriveContext } from "./machine.ts";
import type { AgentRunInput } from "./actor.ts";
import type { ControlPlane } from "./control-plane.ts";
import type { SnapshotStore } from "./snapshot-store.ts";
import { reconcile, type ReconcileDeps } from "./reconcile.ts";

// --- Snapshot codec: strip / re-inject the live ControlPlane ----------------
//
// Important xstate-v5 behaviour we verified empirically (it corrects the handoff's
// mental model): an invoked actor's **input is persisted** in
// `snapshot.children.<id>.snapshot.input`, and on restore the child is re-spawned
// from THAT persisted input — the parent's invoke `input: ({context}) => …` is NOT
// re-evaluated. So:
//   • the live `controlPlane` hides in TWO places — parent `context` AND the child's
//     persisted `input` — and BOTH must be stripped or `JSON.stringify` throws on the
//     started `http.Server`; and
//   • re-attach is driven by the child's persisted `input` (its `attachOffset`), which
//     `hydrateSnapshot` rewrites — not by machine.ts's invoke input (that only governs
//     a fresh start). machine.ts keeps the `?? context.offset` line as defence in depth
//     for any xstate version that does re-evaluate.

interface PersistedSnapshot {
  context?: Record<string, unknown>;
  children?: Record<string, { snapshot?: { input?: Record<string, unknown> } } & Record<string, unknown>>;
}

function stripLive(obj: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!obj) return obj;
  const { controlPlane: _drop, ...rest } = obj;
  return rest;
}

/** Persisted form: the xstate snapshot with every live `controlPlane` removed. */
export function serializeSnapshot(actor: AnyActorRef): unknown {
  const snap = actor.getPersistedSnapshot() as PersistedSnapshot;
  const children = snap.children
    ? Object.fromEntries(
        Object.entries(snap.children).map(([k, child]) => [
          k,
          child.snapshot?.input
            ? { ...child, snapshot: { ...child.snapshot, input: stripLive(child.snapshot.input) } }
            : child,
        ]),
      )
    : snap.children;
  return { ...snap, context: stripLive(snap.context), children };
}

/**
 * Restore form: re-attach the live ControlPlane to parent context AND the invoked
 * child's persisted input, and FORCE re-attach on the child — drop its `prompt` and
 * point `attachOffset` at the persisted admission offset so the Actor resumes the
 * in-flight run instead of POSTing a second prompt.
 */
export function hydrateSnapshot(stored: unknown, deps: { controlPlane: ControlPlane; attachOffset: string }): unknown {
  const snap = stored as PersistedSnapshot;
  const context = snap.context ? { ...snap.context, controlPlane: deps.controlPlane } : snap.context;
  const children = snap.children
    ? Object.fromEntries(
        Object.entries(snap.children).map(([k, child]) => {
          if (!child.snapshot?.input) return [k, child];
          const input = {
            ...child.snapshot.input,
            controlPlane: deps.controlPlane,
            prompt: undefined,
            attachOffset: deps.attachOffset,
          };
          return [k, { ...child, snapshot: { ...child.snapshot, input } }];
        }),
      )
    : snap.children;
  return { ...snap, context, children };
}

// --- runOrchestrator --------------------------------------------------------

/** Auto-decision policy = the mocked human (PoC #5 mocked APPROVE/DENY the same way). */
export interface DecisionPolicy {
  /**
   * Send APPROVE once the Machine has been in `waitingForApproval` for this long.
   * On restore the timer restarts, so a large value on the first process keeps the
   * gate HELD long enough to crash it; a small value on the restarted process
   * answers the re-issued approval. Omit to leave approvals to an external sender.
   */
  autoApproveAfterMs?: number;
  decision?: string;
}

export interface RunOrchestratorArgs {
  store: SnapshotStore;
  controlPlane: ControlPlane;
  /** Durable Machine run id — the snapshot key. */
  runId: string;
  /** Initial input for a FRESH start (ignored on restore). */
  input: AgentRunInput;
  /** Sandbox CR name this run depends on (drives the reconcile failure path). */
  sandboxName?: string;
  reconcileDeps: ReconcileDeps;
  decision?: DecisionPolicy;
  log?: (msg: string) => void;
}

export type RunOrchestratorResult =
  | { outcome: "lost"; reason: string }
  | { outcome: "running"; actor: AnyActorRef; done: Promise<string> };

export async function runOrchestrator(args: RunOrchestratorArgs): Promise<RunOrchestratorResult> {
  const { store, controlPlane, runId, input, reconcileDeps, decision } = args;
  const log = args.log ?? ((m: string) => console.log(m));

  const persisted = await store.load(runId);

  // --- decide: fresh start vs restore vs lost -------------------------------
  let actorConfig: { snapshot?: unknown; input?: AgentRunInput };

  if (!persisted || persisted.snapshot == null) {
    // No durable snapshot. Usually a genuine first start. But if we have a prompt
    // and an in-flight run already exists on the Harness, a prior process admitted
    // and crashed before persisting the offset — re-attach instead of re-POSTing.
    if (input.prompt && !input.attachOffset) {
      const live = await reconcileDeps.liveness.isLive(input.agentName, input.instanceId);
      if (live) {
        log(
          `[durability] run='${runId}' NO snapshot but '${input.agentName}/${input.instanceId}' is LIVE — ` +
            `re-attaching (offset='-1' replay) rather than re-POSTing (crash-between-admit-and-persist edge)`,
        );
        actorConfig = { input: { ...input, prompt: undefined, attachOffset: "-1" } };
      } else {
        log(`[durability] run='${runId}' FRESH START — admitting (POST) '${input.agentName}/${input.instanceId}'`);
        actorConfig = { input };
      }
    } else {
      log(`[durability] run='${runId}' FRESH START — admitting (POST) '${input.agentName}/${input.instanceId}'`);
      actorConfig = { input };
    }
  } else if (persisted.status === "lost") {
    log(`[durability] run='${runId}' previously marked LOST (${persisted.reason}) — not re-attaching`);
    return { outcome: "lost", reason: persisted.reason ?? "previously lost" };
  } else if (["done", "blocked", "cancelled"].includes(persisted.status)) {
    log(`[durability] run='${runId}' already terminal (${persisted.status}) — nothing to resume`);
    return { outcome: "lost", reason: `already ${persisted.status}` };
  } else {
    // RESTORE path. Reconcile against the live world before trusting the snapshot.
    const ctx = (persisted.snapshot as { context?: Partial<DriveContext> }).context ?? {};
    log(
      `[durability] run='${runId}' RESTORE — reconciling (sandbox='${args.sandboxName ?? "-"}', ` +
        `instance='${ctx.agentName}/${ctx.instanceId}', offset='${ctx.offset ?? "-"}')`,
    );
    const result = await reconcile(
      {
        agentName: ctx.agentName ?? input.agentName,
        instanceId: ctx.instanceId ?? input.instanceId,
        offset: ctx.offset,
        sandboxName: args.sandboxName,
      },
      reconcileDeps,
    );
    if (result.outcome === "lost") {
      log(`[durability] run='${runId}' reconcile LOST: ${result.reason} — defined failure path (no re-attach)`);
      await store.markLost(runId, result.reason);
      return { outcome: "lost", reason: result.reason };
    }

    // Resolve the offset to re-attach from. Normal restore: the persisted admission
    // offset. Crash-between-admit-and-persist: no offset in the snapshot — probe the
    // Harness; a live run replays from '-1', otherwise the prior never admitted and a
    // fresh start (re-POST) is the only at-most-once-safe choice.
    let attachOffset = ctx.offset;
    if (!attachOffset) {
      const live = await reconcileDeps.liveness.isLive(
        ctx.agentName ?? input.agentName,
        ctx.instanceId ?? input.instanceId,
        "-1",
      );
      if (live) {
        attachOffset = "-1";
        log(`[durability] run='${runId}' snapshot has no offset but run is LIVE — re-attaching from '-1' (replay)`);
      }
    }

    if (attachOffset) {
      log(
        `[durability] run='${runId}' reconcile OK — RE-ATTACHING by (name,instanceId)+offset='${attachOffset}' ` +
          `(no second prompt POSTed)`,
      );
      actorConfig = { snapshot: hydrateSnapshot(persisted.snapshot, { controlPlane, attachOffset }) };
    } else {
      log(
        `[durability] run='${runId}' reconcile OK but no live run/offset (crashed before admit) — ` +
          `FRESH START, admitting (POST)`,
      );
      actorConfig = { input };
    }
  }

  // --- create, persist-on-transition, drive ---------------------------------
  const actor = createActor(driveMachine, actorConfig as never);

  let settle!: (outcome: string) => void;
  const done = new Promise<string>((resolve) => (settle = resolve));
  const terminal = new Set(["done", "blocked", "cancelled"]);

  actor.subscribe((s) => {
    const status = s.status === "done" ? String(s.value) : "live";
    // Persist every transition. JSON.stringify happens in the store; the codec has
    // already stripped the live ControlPlane, so this is safe.
    void store.save(runId, serializeSnapshot(actor), status).catch((e) => log(`[durability] persist failed: ${e}`));
    if (s.status === "done") {
      const outcome = String(s.value);
      if (terminal.has(outcome)) {
        log(`[durability] run='${runId}' reached terminal '${outcome}' (outcome=${JSON.stringify(s.context.outcome)})`);
        settle(outcome);
      }
    }
  });

  // Mocked-human approval: a RETRYING approver. answerApproval is a no-op until the
  // Agent's (re-issued, post-restart) request_approval re-creates the deferred, so
  // sending APPROVE on an interval closes the restore/retry race without touching
  // the frozen control plane.
  if (decision?.autoApproveAfterMs !== undefined) {
    const delay = decision.autoApproveAfterMs;
    const verdict = decision.decision ?? "APPROVED: auto (PoC #7 mocked human)";
    let waitingSince: number | null = null;
    const timer = setInterval(() => {
      const s = actor.getSnapshot();
      if (s.status !== "active") return;
      if (s.matches({ active: "waitingForApproval" })) {
        if (waitingSince === null) {
          waitingSince = Date.now();
          log(`[durability] run='${runId}' entered waitingForApproval — auto-approve in ${delay}ms`);
        }
        if (Date.now() - waitingSince >= delay) actor.send({ type: "APPROVE", decision: verdict });
      } else {
        waitingSince = null;
      }
    }, 1000);
    void done.then(() => clearInterval(timer));
  }

  actor.start();
  return { outcome: "running", actor, done };
}
