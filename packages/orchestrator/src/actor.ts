// The run-lifecycle Actor (ADR-0002/0011/0016): an xstate `fromCallback` actor that drives one
// Agent run. It does two things on start, and undoes both on stop:
//
//   1. REGISTERS the invocation's event surface: `tools` names are resolved against the
//      workflow's own vocabulary (per-workflow scoping — an unlisted name fails at invoke time)
//      and registered in the host's table under the instance's agent address, with a deliver
//      closure over THIS invocation's `sendBack`. The Agent's domain tool calls arrive from its
//      Adapter (`/agents/<iid>/events` — ADR-0013), are validated by the table, and land on the
//      state that invoked the agent — at any nesting depth, no routing, no `instanceId` on
//      domain events (the closure IS the provenance). `/agents/<iid>/surface` serves exactly
//      this registration, so menus are state-scoped by lifecycle (ADR-0006's dynamic
//      advertisement, for free — and, per ADR-0013, with no `list_changed` needed: flue
//      re-lists per submission).
//
//   2. ADMITS the run over the Harness at `input.endpoint` — the port is constructed
//      per-invocation from serializable input (ADR-0007/0011 doctrine), and a dev stub is just
//      a different URL, never a different code path. The admission flue answers with
//      (`{ streamUrl, offset, submissionId }`) IS the durable re-attach handle (ADR-0016): the
//      actor reports it through the run binding into the HOST LEDGER (persisted beside the
//      snapshot, in the same save), and on restore the host rewrites the child's persisted
//      input (drop `prompt`, set `attach`) so the actor re-follows the admitted submission
//      instead of re-POSTing the prompt. The flue stream carries lifecycle only (`agent.fault`
//      when the submission settles failed); domain events never ride it.
//
// The port factory — `(endpoint) => AgentRunPort`, not `@flue/sdk` — is the dependency, so the
// actor is unit-testable without a live Harness: `agentRunActorWith(() => mock)` is the seam,
// and the canonical `agentRun` (bound to the real flue client) lives in flue-client.ts so this
// module never pulls the SDK onto the test load path.
//
// Stopping the actor abandons the run LOCALLY (aborts admission/settlement consumption) and
// never `agents.abort()`s the durable work: a host shutdown stops every actor, and the runs it
// stops must stay alive server-side for restore to re-attach (ADR-0007). Remote abort is a
// distinct, deliberate act (flue ≥ beta.8 has it), not a stop side effect.

import { fromCallback } from "xstate";
import { agentAddress, resolveAccepts, runBindingOf } from "./registration.ts";

/**
 * One admitted flue submission — the durable re-attach handle (ADR-0016). All fields are
 * server-provided opaque strings (structurally `@flue/sdk`'s `AgentSendResult`), so the whole
 * record is serializable: it lives in the host ledger and rides the rewritten child input on
 * restore.
 */
export type AgentAdmission = {
  /** Fully resolved DS-compatible stream URL for observing the agent instance's events. */
  streamUrl: string;
  /** Opaque DS stream offset captured at admission — replaying from here yields exactly this
   * submission's events (compared and stored verbatim, never arithmetic'd). */
  offset: string;
  /** Correlates the admitted prompt with its settlement. */
  submissionId: string;
};

/** What the actor is invoked with: the durable handle, the Harness, and this turn's surface. */
export type AgentRunInput = {
  agentName: string;
  instanceId: string;
  /** The Harness base URL (which Sandbox). Rides the persisted child input so restore
   * re-attaches to the right Harness; a dev stub is just a different URL (ADR-0011). */
  endpoint: string;
  /**
   * The Sandbox this Agent runs in (`workspace.sandbox` — ADR-0013). Recorded on the registration,
   * where it becomes the scope of the Sandbox token allowed to deliver here: only THIS pod's
   * Adapter can drive this turn. Absent for a workspace-less run (the stub Harness on the host).
   */
  sandbox?: string;
  prompt?: string;
  /**
   * Re-attach to this already-admitted submission instead of admitting a fresh prompt. Set by
   * the host on restore (which also drops `prompt`) from the run's admission ledger.
   */
  attach?: AgentAdmission;
  /** Event names (from the workflow's vocabulary) this invocation accepts over MCP. */
  tools: readonly string[];
};

/** Telemetry sent up when the run's submission settles failed/aborted (infra fault, not an
 * Agent-reported block). */
export type FaultTelemetry = {
  type: "agent.fault";
  instanceId: string;
  reason: string;
};

/** What the actor itself originates upward — telemetry. Domain events also flow through its
 * `sendBack`, but they are the registration table's deliveries, typed by the workflow's defs. */
export type AgentRunUpEvent = FaultTelemetry;

/** The only event the parent sends down: an interrupt that abandons the run. */
export type AgentRunReceiveEvent = { type: "CANCEL" };

/**
 * The port the Actor drives. Narrow by design — admit a prompt (returning the durable
 * admission) and follow an admission to settlement — so a test can supply a synthetic client
 * and settle or fault it by hand. The real, `@flue/sdk`-backed implementation lives in
 * flue-client.ts. Both operations honor `signal`: aborting abandons the LOCAL consumption only
 * (see module header), and the rejection it causes is swallowed by the stopped actor.
 */
export interface AgentRunPort {
  /** Admit one prompt; resolves with the admission the moment flue accepts it. */
  admit(input: AgentRunInput, opts?: { signal?: AbortSignal }): Promise<AgentAdmission>;
  /**
   * Follow an admitted submission until it settles. Resolving means the submission completed;
   * rejecting means it settled failed/aborted (or the stream is gone).
   */
  settle(admission: AgentAdmission, opts?: { signal?: AbortSignal }): Promise<void>;
}

/** Build a port for one invocation from its serializable input (ADR-0011 static-import doctrine). */
export type AgentRunPortFactory = (endpoint: string) => AgentRunPort;

/**
 * Build the run-lifecycle actor logic over an injected port factory.
 *
 * On start it registers the invocation's event surface, then either admits `prompt` (recording
 * the admission in the host ledger — the durable handle) or, when the host set `attach` on
 * restore, re-follows the persisted admission. A `CANCEL` from the parent (or the actor being
 * stopped) abandons local consumption and destroys the registration; a failed settlement
 * surfaces as `agent.fault` so the Machine can react rather than hang on a dead run.
 */
export function agentRunActorWith(portFactory: AgentRunPortFactory) {
  return fromCallback<AgentRunReceiveEvent, AgentRunInput>(({ input, system, sendBack, receive }) => {
    const { instanceId } = input;

    // Register this invocation's event surface (throws on a name outside the vocabulary —
    // ADR-0011's invoke-time check — which errors the run loudly at the invoking state).
    const binding = runBindingOf(system);
    const dispose = binding.table.register({
      address: agentAddress(instanceId),
      runId: binding.runId,
      kind: "agent",
      id: instanceId,
      defs: resolveAccepts(binding, input.tools),
      sandbox: input.sandbox,
      deliver: (event) => sendBack(event),
    });

    const client = portFactory(input.endpoint);
    const controller = new AbortController();
    let stopped = false;

    const abandon = () => {
      if (stopped) return;
      stopped = true;
      dispose();
      // Local abandon only: the durable run stays alive for restore (module header).
      controller.abort();
    };

    // Down-channel: interrupts only (ADR-0002 split-channel model).
    receive((event) => {
      if (event.type === "CANCEL") abandon();
    });

    // Admit (or re-attach) kicked off async; the synchronous callback returns the cleanup fn
    // immediately. The admission is recorded in the host ledger BEFORE settlement is awaited,
    // so a crash right after admission still restores into re-attach, never a re-prompt.
    void (async () => {
      try {
        let admission = input.attach;
        if (!admission) {
          admission = await client.admit(input, { signal: controller.signal });
          binding.recordAdmission?.(instanceId, admission);
        }
        await client.settle(admission, { signal: controller.signal });
        // Settled completed: the turn is over. Whether that is success (a domain event already
        // landed over MCP) or silence (jr's no-signal case) is the Machine's — and, once
        // absorbed, this actor's — concern; nothing to send today.
      } catch (err) {
        if (stopped) return;
        sendBack({
          type: "agent.fault",
          instanceId,
          reason: err instanceof Error ? err.message : String(err),
        } satisfies FaultTelemetry);
      }
    })();

    // Stop (parent stopped the child) == abandon. Idempotent with an explicit CANCEL.
    return abandon;
  });
}
