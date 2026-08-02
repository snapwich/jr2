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
//      advertisement, for free — and, per ADR-0013, with no `list_changed` needed: the
//      Harness re-lists per Submission).
//
//   2. ADMITS the run over the Harness at `input.endpoint` — the port is constructed
//      per-invocation from serializable input (ADR-0007/0011 doctrine), and a dev stub is just
//      a different URL, never a different code path. The Admission the Harness answers with
//      (`{ streamUrl, offset, submissionId }`) IS the durable re-attach handle (ADR-0016): the
//      actor reports it through the run binding into the HOST LEDGER (persisted beside the
//      snapshot, in the same save), and on restore the host rewrites the child's persisted
//      input (drop `prompt`, set `attach`) so the actor re-follows the admitted submission
//      instead of re-POSTing the prompt. The Harness stream carries lifecycle only
//      (`agent.fault` when the Submission settles failed); domain events never ride it.
//
// The port factory — `(endpoint) => AgentRunPort`, not a wire client — is the dependency, so the
// actor is unit-testable without a live Harness: `agentRunActorWith(() => mock)` is the seam,
// and the canonical `agentRun` (bound to the real wire client) lives in harness-client.ts so this
// module never pulls the wire client onto the test load path.
//
// Stopping the actor ENDS THE TURN (ADR-0024). It abandons the run locally (admission/settlement
// consumption) AND aborts the submission remotely, because `agentRun` is an invoke: leaving the
// state means "I am no longer interested in this answer", and an Agent whose turn has ended but
// whose submission has not is an unaccounted-for writer in the Workspace.
//
// The ONE exception is the host ending the run for its own reasons — `RunHost.stop()`, whose runs
// must stay alive server-side for ADR-0007's restore to re-attach. That is a FLAG the host sets on
// the run binding (`hostStopping`), never a fact inferred here: process shutdown stops no actors
// at all, and restore is a fresh process, so there is nothing to infer it from.

import { fromCallback } from "xstate";
import type { ThinkingLevel } from "./agent.ts";
import { ambientHandlesFor } from "./ambient.ts";
import { agentAddress, resolveAccepts, runBindingOf } from "./registration.ts";

/**
 * One admitted Submission — the durable re-attach handle (ADR-0016). All fields are
 * server-provided opaque strings (the wire's `AdmissionResponse` — ADR-0027), so the whole
 * record is serializable: it lives in the host ledger and rides the rewritten child input on
 * restore.
 */
export type AgentAdmission = {
  /** Fully resolved stream URL for observing the conversation's durable stream. */
  streamUrl: string;
  /** Opaque stream offset captured at admission — replaying from here yields exactly this
   * submission's events (compared and stored verbatim, never arithmetic'd). */
  offset: string;
  /** Correlates the admitted prompt with its settlement. */
  submissionId: string;
};

/**
 * What a WORKFLOW writes on an `agentRun` invoke (ADR-0015/0016): the agent and this turn's
 * prompt — everything else is derived. `j2Setup.createMachine` wraps the invoke input to
 * finalize it into {@link AgentRunInput}: the tool menu derives from the invoking state's
 * transitions, the instance id is minted (fresh session by default; `session: "continue"`
 * derives a deterministic id so re-invocations continue one conversation), and endpoint/sandbox
 * resolve ambiently from the enclosing `workspace()`.
 */
export type AgentTurnInput = {
  /** The Agent (persona) to admit the turn against. */
  agent: string;
  /** This turn's task framing — lands as the conversation's next user message. */
  prompt: string;
  /**
   * This turn's DIALS (ADR-0018 as amended) — how hard to run, layered over the definition's own
   * values. Agents are instance-scoped and every workflow may name any of them, so the same
   * persona legitimately runs at different settings in different workflows: a reviewer on a
   * one-line diff and the same reviewer on an architecture change want identical instructions and
   * different effort.
   *
   * IDENTITY is deliberately absent — no `instructions`, `access` or `cwd` here. A call site that
   * rewrote those would make the Agent's name a lie, and `access` in particular carries
   * ADR-0028's containment claim, which per-invocation escalation would void.
   */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /**
   * Session continuity (ADR-0016). Absent = FRESH: every invocation is a new conversation
   * (jr's lossy handoff — revision agents read notes + code, never the prior conversation).
   * `"continue"` = the same `(state path, agent, scope)` re-invocation continues ONE
   * conversation; the prompt lands as its next user turn.
   */
  session?: "continue";
  /** Distinguishes conversations that would otherwise share a `continue` identity (e.g. a
   * reviewer fresh per task: `scope: task.id`). */
  scope?: string;
  /** Workspace-less runs only (dev/stub Harness): explicit endpoint, no ambient resolution. */
  endpoint?: string;
  /** Escape hatch: override the derived menu. */
  tools?: readonly string[];
};

/** What the actor is invoked with AFTER j2Setup finalization: the durable handle, this turn's
 * surface, and — only outside a workspace — an explicit Harness. */
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
  /** This turn's dials, passed through from {@link AgentTurnInput}. Plain strings, so they ride
   * the persisted child input; on restore the Submission already exists server-side with its
   * model fixed, so a re-attach never re-resolves them. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /**
   * Re-attach to this already-admitted submission instead of admitting a fresh prompt. Set by
   * the host on restore (which also drops `prompt`) from the run's admission ledger.
   */
  attach?: AgentAdmission;
  /** Event names (from the workflow's vocabulary) this invocation accepts over MCP. */
  tools: readonly string[];
};

/** Telemetry sent up when the run is out of options: the Submission settled failed/aborted
 * (infra fault after the turn's own provider retries — ADR-0027), or the no-signal nudge budget ran dry.
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
 * admission), follow an admission to settlement, and end one — so a test can supply a synthetic
 * client and settle, fault or abort it by hand. The real, wire-backed implementation lives
 * in harness-client.ts. `admit`/`settle` honor `signal`: aborting abandons the LOCAL consumption only
 * (see module header), and the rejection it causes is swallowed by the stopped actor.
 */
export interface AgentRunPort {
  /** Admit one prompt; resolves with the admission the moment the Harness accepts it. */
  admit(input: AgentRunInput, opts?: { signal?: AbortSignal }): Promise<AgentAdmission>;
  /**
   * Follow an admitted submission until it settles. Resolving means the submission completed;
   * rejecting means it settled failed/aborted (or the conversation is gone).
   */
  settle(admission: AgentAdmission, opts?: { signal?: AbortSignal }): Promise<void>;
  /**
   * End the instance's in-flight (and queued) work — the turn is over (ADR-0024). Resolving means
   * the intent is RECORDED, not that the submission has settled; j2 never observes that outcome,
   * because the actor is already stopped by the time this is called. The actor passes no `signal`
   * for exactly that reason — its own controller is already aborted — but the option is here for
   * parity with the other two.
   */
  abort(agentName: string, instanceId: string, opts?: { signal?: AbortSignal }): Promise<void>;
}

/** Build a port for one invocation from its serializable input (ADR-0011 static-import doctrine). */
export type AgentRunPortFactory = (endpoint: string) => AgentRunPort;

/** Absorbed-turn-mechanics knobs (ADR-0016): defaulted, never Machine context. */
export type AgentRunOptions = {
  /**
   * How many times a turn that settles COMPLETED without having called any menu tool is
   * re-prompted ("you must call one of: …") before the terminal `agent.fault`. jr's dominant
   * failure mode: the Harness settles a silent turn `completed` like any other (ADR-0006), so
   * this loop is j2-owned. Default 2.
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
  // Typed as the union so BOTH shapes typecheck on an invoke: j2Setup machines write
  // AgentTurnInput (and the config wrapper finalizes it before the actor ever runs); plain
  // setup() machines must pass the finalized shape themselves — checked loudly below.
  return fromCallback<AgentRunReceiveEvent, AgentTurnInput | AgentRunInput>((args) => {
    const { system, self, sendBack, receive } = args;
    const input = args.input as AgentRunInput;
    const { instanceId } = input;
    if (!instanceId || !input.agentName) {
      throw new Error(
        `agentRun invoked with unfinalized input — author the machine with j2Setup(...) (which mints ` +
          `the instance id and derives the menu), or pass \`agentName\`/\`instanceId\`/\`tools\` explicitly`,
      );
    }

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
    // Shared per run, created on demand so the ordering guarantee holds for any binding.
    const pendingAborts = (binding.pendingAborts ??= new Map<string, Promise<void>>());
    let stopped = false;

    const abandon = () => {
      if (stopped) return;
      stopped = true;
      dispose();
      // Stop consuming the stream. The remote end of the turn is the next paragraph.
      controller.abort();
      // A turn ends with the state that asked for it (ADR-0024) — whatever ended the invocation:
      // the Agent's own pick settling the state, an `after:` timeout, an ancestor transition, a
      // Pool cancelling a child. The one exception is the host stopping the run for its own
      // reasons, which ADR-0007's restore re-attaches to.
      if (binding.hostStopping) return;
      // Fire-and-forget, and unreportable BY CONSTRUCTION: this actor is stopped, so there is no
      // `agent.fault` left to raise. An orphan that survives a failed abort 404s on every tool
      // call and settles on its own.
      const aborting = client.abort(input.agentName, instanceId).catch(() => {});
      pendingAborts.set(instanceId, aborting);
      void aborting.then(() => {
        if (pendingAborts.get(instanceId) === aborting) pendingAborts.delete(instanceId);
      });
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
    //   - INFRA faults: provider retries run inside the turn, Harness-side, and the wire
    //     client reconnects transparently — so a `settle` rejection means the Submission settled
    //     failed/aborted, or the conversation is lost (ADR-0027). Terminal, no j2 re-run.
    //   - NO-SIGNAL: the Submission settles COMPLETED but no menu tool was called. The Harness
    //     calls that a normal turn, so j2 owns a budgeted re-prompt on the SAME iid (the conversation
    //     continues; each nudge is a fresh admission, ledgered like any other).
    // Either budget exhausting emits the ONE terminal `agent.fault { reason }`.
    void (async () => {
      const fault = (reason: string) => {
        if (!stopped) sendBack({ type: "agent.fault", instanceId, reason } satisfies FaultTelemetry);
      };
      try {
        // Queue behind any abort still in flight for this iid (ADR-0024). Non-trivial only under
        // `session: "continue"`, which is the only way two invocations share an instance id — and
        // there it is mandatory: the Harness queues per conversation and an abort settles what
        // is queued behind it, so losing this race would kill the new turn before it ran, silently.
        await pendingAborts.get(instanceId);
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
