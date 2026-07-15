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
import { ambientHandlesFor } from "./ambient.ts";
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

/** What the actor is invoked with: the durable handle, this turn's surface, and — only outside
 * a workspace — an explicit Harness. */
export type AgentRunInput = {
  agentName: string;
  instanceId: string;
  /**
   * The Harness base URL, EXPLICIT (ADR-0016): only for a workspace-less run (the mechanics
   * tier's stub Harness, a dev endpoint — just a URL, ADR-0011). Inside a `workspace()` leave it
   * unset: the actor resolves endpoint AND sandbox ambiently from the enclosing wrapper via the
   * actor parent chain, and the registration records that wrapper's Sandbox — the ADR-0013 token
   * scope — with no way for the workflow to forget it. Explicit `endpoint` wins when both exist.
   */
  endpoint?: string;
  /**
   * The Sandbox to scope delivery to (ADR-0013), EXPLICIT — normally ambient (above). An
   * explicit workspace-less run has none: no Sandbox token can claim its surface.
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

/** Telemetry sent up when the run is out of options: the submission settled failed/aborted
 * (infra fault after flue's own durability retries), or the no-signal nudge budget ran dry.
 * The ONE terminal event (ADR-0016) — where it routes is workflow policy. */
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

/** Absorbed-turn-mechanics knobs (ADR-0016): defaulted, never Machine context. */
export type AgentRunOptions = {
  /**
   * How many times a turn that settles COMPLETED without having called any menu tool is
   * re-prompted ("you must call one of: …") before the terminal `agent.fault`. jr's dominant
   * failure mode: flue considers a silent turn a normal completion, and its native `finish`
   * nudge is structurally unavailable on the durable agent path (ADR-0006), so this loop is
   * j2-owned. Default 2.
   */
  nudgeBudget?: number;
};

/** The forced-final-pick re-prompt (ADR-0006, absorbed here by ADR-0016). */
function nudgePrompt(tools: readonly string[]): string {
  return (
    `Your previous turn ended without calling one of the required workflow tools. ` +
    `You MUST end your turn by calling exactly one of: ${tools.join(", ")}. ` +
    `Pick the one that matches the true state of your work and call it now.`
  );
}

/**
 * Build the run-lifecycle actor logic over an injected port factory.
 *
 * On start it registers the invocation's event surface, then either admits `prompt` (recording
 * the admission in the host ledger — the durable handle) or, when the host set `attach` on
 * restore, re-follows the persisted admission. A `CANCEL` from the parent (or the actor being
 * stopped) abandons local consumption and destroys the registration; a failed settlement
 * surfaces as `agent.fault` so the Machine can react rather than hang on a dead run.
 */
export function agentRunActorWith(portFactory: AgentRunPortFactory, options: AgentRunOptions = {}) {
  const nudgeBudget = options.nudgeBudget ?? 2;
  return fromCallback<AgentRunReceiveEvent, AgentRunInput>(({ input, system, self, sendBack, receive }) => {
    const { instanceId } = input;

    // Resolve the Harness coordinates (ADR-0016): explicit input wins (the workspace-less dev
    // path); otherwise the nearest enclosing workspace() published them — walked structurally
    // via the actor parent chain, so a sibling workspace's handles are unreachable (ADR-0013).
    const ambient = ambientHandlesFor(self);
    const endpoint = input.endpoint ?? ambient?.endpoint;
    if (!endpoint) {
      throw new Error(
        `agentRun "${instanceId}": no Harness to admit against — invoke it inside a workspace() ` +
          `(ambient resolution), or pass an explicit \`endpoint\` (workspace-less dev/stub path)`,
      );
    }
    const sandbox = input.endpoint ? input.sandbox : (input.sandbox ?? ambient?.sandbox);

    // Register this invocation's event surface (throws on a name outside the vocabulary —
    // ADR-0011's invoke-time check — which errors the run loudly at the invoking state).
    // `signaled` is the no-signal detector: a delivered menu event means the Agent ended its
    // turn the intended way, so a completed settlement needs no nudge.
    let signaled = false;
    const binding = runBindingOf(system);
    const dispose = binding.table.register({
      address: agentAddress(instanceId),
      runId: binding.runId,
      kind: "agent",
      id: instanceId,
      defs: resolveAccepts(binding, input.tools),
      sandbox,
      deliver: (event) => {
        signaled = true;
        sendBack(event);
      },
    });

    const client = portFactory(endpoint);
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
    //
    // Two absorbed fault classes (ADR-0016), deliberately distinct:
    //   - INFRA faults: flue's own submission durability retries them server-side, and the DS
    //     client reconnects transparently — so a `settle` rejection means flue itself gave up.
    //     Terminal, no j2 re-run.
    //   - NO-SIGNAL: the submission settles COMPLETED but no menu tool was called. Flue calls
    //     that a normal turn, so j2 owns a budgeted re-prompt on the SAME iid (the conversation
    //     continues; each nudge is a fresh admission, ledgered like any other).
    // Either budget exhausting emits the ONE terminal `agent.fault { reason }`.
    void (async () => {
      const fault = (reason: string) => {
        if (!stopped) sendBack({ type: "agent.fault", instanceId, reason } satisfies FaultTelemetry);
      };
      try {
        let admission = input.attach;
        if (!admission) {
          admission = await client.admit(input, { signal: controller.signal });
          binding.recordAdmission?.(instanceId, admission);
        }
        for (let attempt = 0; ; attempt++) {
          await client.settle(admission, { signal: controller.signal });
          if (stopped || signaled || input.tools.length === 0) return; // the turn ended as intended
          if (attempt >= nudgeBudget) {
            fault(`agent completed its turn without calling any of: ${input.tools.join(", ")}`);
            return;
          }
          binding.telemetry?.({
            kind: "retry",
            child: self._parent?.id ?? self.id,
            attempt: attempt + 1,
            reason: "no-signal nudge",
          });
          admission = await client.admit(
            { ...input, attach: undefined, prompt: nudgePrompt(input.tools) },
            { signal: controller.signal },
          );
          binding.recordAdmission?.(instanceId, admission);
        }
      } catch (err) {
        if (stopped) return;
        fault(err instanceof Error ? err.message : String(err));
      }
    })();

    // Stop (parent stopped the child) == abandon. Idempotent with an explicit CANCEL.
    return abandon;
  });
}
