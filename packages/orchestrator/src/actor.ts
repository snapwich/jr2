// The run-lifecycle Actor (ADR-0002/0011/0016): an xstate `fromCallback` actor that drives one
// Agent run. It does two things on start, and undoes both on stop:
//
//   1. REGISTERS the invocation's event surface: `tools` names are resolved against the
//      INVOKING MACHINE's vocabulary (per-Machine scoping — an unlisted name fails at invoke time)
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
// actor is unit-testable without a live Harness: `agentActorWith(() => mock, def)` is the seam,
// and the canonical `agent(def)` (bound to the real wire client) lives in harness-client.ts so
// this module never pulls the wire client onto the test load path.
//
// The other closure is the DEFINITION (ADR-0049): one logic object per Agent slot, carrying the
// definition it runs. Placement (ADR-0031) reads `workspace` off it — never off a roster, which
// could not tell two Machines' `coder`s apart.
//
// Stopping the actor ENDS THE TURN (ADR-0024). It abandons the run locally (admission/settlement
// consumption) AND aborts the submission remotely, because an Agent slot is an invoke: leaving the
// state means "I am no longer interested in this answer", and an Agent whose turn has ended but
// whose submission has not is an unaccounted-for writer in the Workspace.
//
// The ONE exception is the host ending the run for its own reasons — `RunHost.stop()`, whose runs
// must stay alive server-side for ADR-0007's restore to re-attach. That is a FLAG the host sets on
// the run binding (`hostStopping`), never a fact inferred here: process shutdown stops no actors
// at all, and restore is a fresh process, so there is nothing to infer it from.

import { fromCallback, type CallbackActorLogic } from "xstate";
import type { AgentDefinition, ThinkingLevel } from "./agent.ts";
import { ambientHandlesFor } from "./ambient.ts";
import { INSTANCE_HARNESS_SERVICE } from "./names.ts";
import { agentAddress, resolveAccepts, runBindingOf } from "./registration.ts";

/**
 * One admitted Submission — the durable re-attach handle (ADR-0016). The wire fields are
 * server-provided opaque strings (the wire's `AdmissionResponse` — ADR-0027) plus the
 * actor-stamped `instanceId`, so the whole record is serializable: it lives in the host ledger
 * and rides the rewritten child input on restore.
 */
export type AgentAdmission = {
  /** Fully resolved stream URL for observing the conversation's durable stream. */
  streamUrl: string;
  /** Opaque stream offset captured at admission — replaying from here yields exactly this
   * submission's events (compared and stored verbatim, never arithmetic'd). */
  offset: string;
  /** Correlates the admitted prompt with its settlement. */
  submissionId: string;
  /**
   * The conversation this admission was admitted under — stamped by the ACTOR at ledger time
   * (the wire response carries no iid). Equal to the invocation's iid until a runaway reroll
   * (ADR-0035) advances it; a restore reads it back so a rerolled run re-registers, nudges and
   * aborts the LIVE conversation, never the dead original the ledger is keyed by.
   */
  instanceId?: string;
};

/**
 * What a WORKFLOW writes on an Agent slot's invoke (ADR-0015/0016/0049): this turn's prompt —
 * everything else is derived. The AGENT is not written here at all: the slot key is its name
 * (`actors: { coder: agent(def) }`, `src: "coder"`), so a name the Machine does not carry is a
 * compile error on `src` instead of a runtime miss. `j2Setup.createMachine` wraps the invoke
 * input to finalize it into {@link AgentRunInput}: the slot key lands as `agentName`, the tool
 * menu derives from the invoking state's transitions, the instance id is minted (fresh session by
 * default; `session: "continue"` or a `conversation` pin derives a deterministic id so
 * re-invocations continue one conversation), and endpoint/sandbox resolve ambiently from the
 * enclosing `workspace()`.
 */
export type AgentTurnInput = {
  /** This turn's task framing — lands as the conversation's next user message. */
  prompt: string;
  /**
   * This turn's DIALS (ADR-0018) — how hard to run, layered over the definition's own
   * values. One definition value may be carried by several Machines, so the same persona
   * legitimately runs at different settings in different workflows: a reviewer on a one-line diff
   * and the same reviewer on an architecture change want identical instructions and different
   * effort.
   *
   * IDENTITY is deliberately absent — no `instructions`, `workspace` or `cwd` here. A call site
   * that rewrote those would make the Agent's name a lie, and `workspace` in particular carries
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
  /**
   * Pin the conversation to a workflow-chosen name — the CROSS-MACHINE continue (ADR-0016's
   * opt-in continuation, where `session: "continue"` cannot reach: its derived id carries the
   * invoking actor's path, so it only spans states of one machine). Invocations naming the same
   * `conversation` derive ONE deterministic, run-scoped instance id (`<runId>/<name>/<agent>`)
   * wherever in the actor tree they sit — a triage state before the `workspace()` and an assess
   * state inside its body continue one conversation, the prompt landing as its next user turn.
   * Only sound where every invocation lands on the same Harness, because a conversation is an
   * Instance ID on ONE server: a `workspace: "none"` Agent (always the Instance Harness —
   * definition-wins, ADR-0031) or a fixed explicit `endpoint`.
   */
  conversation?: string;
  /** Workspace-less runs only (stub Harness): explicit endpoint, no ambient resolution. */
  endpoint?: string;
  /** Escape hatch: override the derived menu. */
  tools?: readonly string[];
};

/** What the actor is invoked with AFTER j2Setup finalization: the durable handle, this turn's
 * surface, and — only outside a workspace — an explicit Harness. */
export type AgentRunInput = {
  /** The Agent's name — its SLOT KEY, injected by the menu walk (ADR-0049), never authored. It
   * is what the Harness route, the minted iid, the markers and the telemetry all name. */
  agentName: string;
  instanceId: string;
  /**
   * The Harness base URL, EXPLICIT (ADR-0016): only for a workspace-less run (the mechanics
   * tier's stub Harness, a dev endpoint — just a URL, ADR-0011). Inside a `workspace()` leave it
   * unset: the actor resolves endpoint AND sandbox ambiently from the enclosing wrapper via the
   * actor parent chain, and the registration records that wrapper's Sandbox — the ADR-0013 token
   * scope — with no way for the workflow to forget it. Explicit `endpoint` wins when both exist.
   * A `workspace: "none"` definition needs neither: its Turn resolves to the Instance Harness,
   * whatever encloses the invocation (definition-wins — ADR-0031).
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
  /**
   * This invocation is closed to the ADR-0035 reroll — set by the input mapper for
   * `session: "continue"` and a `conversation` pin (both name an EXISTING conversation, and
   * the runaway's one recovery is a fresh one — exactly what they opted out of), and for a
   * caller-passed `instanceId` (fresh on its first invocation, but j2 did not mint the id and
   * must not derive reroll identity from one it does not own — ADR-0016's minting doctrine).
   * A gated runaway goes straight to the terminal fault.
   */
  continuation?: boolean;
  /** Event names (from the invoking Machine's vocabulary) this invocation accepts over MCP. */
  tools: readonly string[];
};

/** Telemetry sent up when the run is out of options: the Submission settled failed/aborted
 * (infra fault after the turn's own provider retries — ADR-0027), the no-signal nudge budget ran
 * dry, or the runaway reroll budget did (ADR-0035). The ONE terminal event (ADR-0016) — where it
 * routes is workflow policy. */
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
  /**
   * How many times a RUNAWAY — a turn the Harness itself ended because it would not conclude,
   * settled failed with the typed `"runaway"` error (ADR-0035) — is rerolled: a FRESH
   * conversation under an iid derived from the original, admitting the IDENTICAL prompt. The
   * degenerate context is poisoned, so the recovery is a new roll of the dice, never a nudge into
   * the same conversation — and a continuation gets none at all (it opted out of fresh
   * conversations). Default 1: two independent runaways are evidence the task itself is
   * pathological, which belongs with the workflow's fault routing.
   */
  runawayBudget?: number;
};

/**
 * The runaway settlement class (ADR-0035), read STRUCTURALLY off a settle rejection: the wire
 * client's `SettlementFault` carries the Settlement, but this module is wire-free (see header),
 * so the literal is restated (`SUBMISSION_RUNAWAY` in `@j2/harness/wire`) and the shape
 * duck-typed. A lost conversation (404) carries no settlement, so it stays terminal like every
 * other class.
 */
function runawayReason(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const error = (err as { settlement?: { error?: { type?: string; message?: string } } }).settlement?.error;
  return error?.type === "runaway" ? (error.message ?? "runaway") : undefined;
}

/** The forced-final-pick re-prompt (ADR-0006, absorbed here by ADR-0016). */
function nudgePrompt(tools: readonly string[]): string {
  return (
    `Your previous turn ended without calling one of the required workflow tools. ` +
    `You MUST end your turn by calling exactly one of: ${tools.join(", ")}. ` +
    `Pick the one that matches the true state of your work and call it now.`
  );
}

/** One Agent slot's logic: the run-lifecycle actor closed over ONE definition and BRANDED with it
 * (ADR-0049). The brand is the whole resolution mechanism — the actor reads its definition off its
 * own closure, `j2Setup` recognizes the slot by `isAgent`, and a `.provide()` that swaps the slot
 * swaps the definition with it, because the two are one object.
 *
 * The brand is a RUNTIME property, read back through `isAgent`, and deliberately NOT part of this
 * type: the unit-test seam is `provide({ actors: { coder: fake } })` (ADR-0049), and a required
 * `definition` here would make every fake carry a definition it never uses. */
export type AgentLogic = CallbackActorLogic<AgentRunReceiveEvent, AgentTurnInput | AgentRunInput>;

/**
 * Build one Agent slot's actor logic over an injected port factory — the seam `agent()` (bound to
 * the real wire client, harness-client.ts) and every unit test share.
 *
 * On start it registers the invocation's event surface, then either admits `prompt` (recording
 * the admission in the host ledger — the durable handle) or, when the host set `attach` on
 * restore, re-follows the persisted admission. A `CANCEL` from the parent (or the actor being
 * stopped) abandons local consumption and destroys the registration; a failed settlement
 * surfaces as `agent.fault` so the Machine can react rather than hang on a dead run.
 *
 * The `definition` is a CLOSURE, not a lookup: the Turn's placement (ADR-0031) reads it off the
 * logic the invoke actually named, so two Machines carrying different `coder`s each resolve their
 * own, and no roster is consulted anywhere (ADR-0049).
 */
export function agentActorWith(
  portFactory: AgentRunPortFactory,
  definition: AgentDefinition,
  options: AgentRunOptions = {},
): AgentLogic {
  const nudgeBudget = options.nudgeBudget ?? 2;
  const runawayBudget = options.runawayBudget ?? 1;
  // Typed as the union so BOTH shapes typecheck on an invoke: j2Setup machines write
  // AgentTurnInput (and the config wrapper finalizes it before the actor ever runs); plain
  // setup() machines must pass the finalized shape themselves — checked loudly below.
  const logic = fromCallback<AgentRunReceiveEvent, AgentTurnInput | AgentRunInput>((args) => {
    const { system, self, sendBack, receive } = args;
    const input = args.input as AgentRunInput;
    const { instanceId } = input;
    if (!instanceId || !input.agentName) {
      throw new Error(
        `an Agent slot was invoked with unfinalized input — declare it on a j2Setup(...) machine ` +
          `(\`actors: { <name>: agent(def) }\`, which names the Agent, mints the instance id and ` +
          `derives the menu), or pass \`agentName\`/\`instanceId\`/\`tools\` explicitly`,
      );
    }

    // Resolve the Harness coordinates (ADR-0016/0031). Explicit input wins (the workspace-less
    // stub path); then the DEFINITION decides: `workspace: "none"` pins the Turn to the Instance
    // Harness always — even inside an enclosing workspace(), because a conversation is an
    // Instance ID on ONE Harness and a continued advisor must land on the server that holds it
    // (definition-wins, ADR-0031); everyone else resolves the nearest enclosing workspace()'s
    // handles — walked structurally via the actor parent chain, so a sibling workspace's handles
    // are unreachable (ADR-0013).
    const binding = runBindingOf(system);
    const workspace = definition.workspace ?? "write";
    let endpoint: string;
    let sandbox: string | undefined;
    if (input.endpoint) {
      endpoint = input.endpoint;
      sandbox = input.sandbox;
    } else if (workspace === "none") {
      if (!binding.instanceHarness) {
        throw new Error(
          `turn ${instanceId}: agent "${input.agentName}" has workspace: "none" — its Turn runs on ` +
            `the Instance Harness (ADR-0031), and this host knows no Instance Harness address (deployed ` +
            `instances derive it from their namespace; tests pass an explicit \`endpoint\`)`,
        );
      }
      endpoint = binding.instanceHarness;
      // The registration records the PLACEMENT's name as its delivery scope — ADR-0013's
      // doctrine, extended to the second placement: the Instance Harness Adapter bears a token
      // signed for this name (deploy.ts), so it may speak for the Turns hosted there and for no
      // Workspace's. The Instance token still may (it is the operator, tokens.ts).
      sandbox = INSTANCE_HARNESS_SERVICE;
    } else {
      const ambient = ambientHandlesFor(self);
      if (!ambient?.endpoint) {
        throw new Error(
          `turn ${instanceId}: agent "${input.agentName}" has workspace: "${workspace}" — ` +
            `invoke it inside a workspace() (ambient resolution), or pass an explicit \`endpoint\` ` +
            `(workspace-less stub path)`,
        );
      }
      endpoint = ambient.endpoint;
      sandbox = input.sandbox ?? ambient.sandbox;
    }

    // Register this invocation's event surface (throws on a name outside the INVOKING MACHINE's
    // vocabulary — ADR-0011's invoke-time check, scoped to `self._parent.logic` because names are
    // per-Machine — which errors the run loudly at the invoking state).
    // `signaled` is the no-signal detector: a delivered menu event means the Agent ended its
    // turn the intended way, so a completed settlement needs no nudge. ONE invocation can hold
    // more than one surface: a runaway reroll (ADR-0035) is a fresh conversation whose menu
    // dials `/mcp/<derived iid>`, so its address must be live too — same defs, same deliver,
    // because whichever conversation answers, it answers THIS invocation.
    let signaled = false;
    // The conversation this turn currently rides — advanced by a runaway reroll (ADR-0035) and,
    // on restore, read back off the ledgered admission's stamp: a reroll is ledgered under the
    // ORIGINAL iid (the persisted input's key) but stamped with its OWN, so a restored run
    // registers, nudges and aborts the LIVE conversation, never the dead original the Harness
    // already ended.
    let currentIid = input.attach?.instanceId ?? instanceId;
    const defs = resolveAccepts(self, input.tools);
    const disposers: Array<() => void> = [];
    const registerSurface = (iid: string) =>
      disposers.push(
        binding.table.register({
          address: agentAddress(iid),
          runId: binding.runId,
          kind: "agent",
          id: iid,
          defs,
          sandbox,
          deliver: (event) => {
            signaled = true;
            // The settlement-pick marker (ADR-0023), BEFORE the delivery moves the Machine: the pick
            // must land on the feed ahead of the status delta it causes, or the narrative reads
            // effect-then-cause.
            const { type, ...payload } = event;
            binding.marker?.({
              kind: "pick",
              agent: input.agentName,
              endpoint,
              event: type,
              ...(Object.keys(payload).length ? { payload } : {}),
            });
            sendBack(event);
          },
          // The state that invoked us — the machine the menu derived from, so the only one whose
          // guards can say whether a pick would move anything (ADR-0029). Same `_parent` the ambient
          // walk above uses; structural, so a sibling's snapshot is unreachable.
          invoker: self._parent,
        }),
      );
    registerSurface(currentIid);

    const client = portFactory(endpoint);
    const controller = new AbortController();
    // Shared per run, created on demand so the ordering guarantee holds for any binding.
    const pendingAborts = (binding.pendingAborts ??= new Map<string, Promise<void>>());
    let stopped = false;
    // Ledgered under the ORIGINAL iid — the persisted input's key, like a nudge's — with the
    // LIVE conversation stamped on the record, so a restore settle-follows the live submission
    // AND re-addresses it (see `currentIid` above).
    const ledger = (admission: AgentAdmission) =>
      binding.recordAdmission?.(instanceId, { ...admission, instanceId: currentIid });

    const abandon = () => {
      if (stopped) return;
      stopped = true;
      for (const dispose of disposers.splice(0)) dispose();
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
      const iid = currentIid;
      const aborting = client.abort(input.agentName, iid).catch(() => {});
      pendingAborts.set(iid, aborting);
      void aborting.then(() => {
        if (pendingAborts.get(iid) === aborting) pendingAborts.delete(iid);
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
    // Three absorbed fault classes (ADR-0016), deliberately distinct:
    //   - INFRA faults: provider retries run inside the turn, Harness-side, and the wire
    //     client reconnects transparently — so a `settle` rejection means the Submission settled
    //     failed/aborted, or the conversation is lost (ADR-0027). Terminal, no j2 re-run.
    //   - NO-SIGNAL: the Submission settles COMPLETED but no menu tool was called. The Harness
    //     calls that a normal turn, so j2 owns a budgeted re-prompt on the SAME iid (the conversation
    //     continues; each nudge is a fresh admission, ledgered like any other).
    //   - RUNAWAY: the Harness ended a turn that would not conclude and settled it failed with
    //     the typed "runaway" error (ADR-0035). The degenerate context is poisoned, so the
    //     budgeted reroll is the OPPOSITE of a nudge: a fresh conversation under a derived iid,
    //     admitting the identical prompt — closed to continuations, which opted out of exactly that.
    // Any budget exhausting emits the ONE terminal `agent.fault { reason }`.
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
          ledger(admission);
          // The admission marker (ADR-0023): the Turn and its framing, once — a re-attach
          // continues a Turn already announced, and a nudge (below) is mechanism, not narrative
          // (its telemetry already rides the feed).
          binding.marker?.({ kind: "admission", agent: input.agentName, endpoint, prompt: input.prompt ?? "" });
        }
        let nudges = 0;
        let rerolls = 0;
        for (;;) {
          try {
            await client.settle(admission, { signal: controller.signal });
          } catch (err) {
            // The reroll gate closes on `signaled` like the nudge gate below: a delivered pick
            // means the workflow already holds this turn's signal, so replaying the identical
            // prompt would re-deliver it (a targetless pick keeps the actor alive through the
            // settlement). It also closes when restore dropped `prompt` (`attach` rides instead):
            // there is nothing identical to replay, and the thrown settlement still carries the
            // legible runaway reason.
            const reason = stopped || signaled ? undefined : runawayReason(err);
            if (reason === undefined || input.continuation || input.prompt === undefined || rerolls >= runawayBudget)
              throw err;
            rerolls++;
            binding.telemetry?.({
              kind: "retry",
              child: self._parent?.id ?? self.id,
              attempt: rerolls,
              reason: "runaway reroll",
            });
            // Deterministically derived, so a reroll never mints identity (ADR-0016: minting
            // lives in the input mapper). Surface FIRST: the fresh conversation's menu dials
            // `/mcp/<currentIid>`, so its address must be live before the Harness can run it.
            currentIid = `${instanceId}-r${rerolls}`;
            registerSurface(currentIid);
            admission = await client.admit(
              { ...input, attach: undefined, instanceId: currentIid },
              { signal: controller.signal },
            );
            ledger(admission);
            continue;
          }
          if (stopped || signaled || input.tools.length === 0) return; // the turn ended as intended
          if (nudges >= nudgeBudget) {
            fault(`agent completed its turn without calling any of: ${input.tools.join(", ")}`);
            return;
          }
          nudges++;
          binding.telemetry?.({
            kind: "retry",
            child: self._parent?.id ?? self.id,
            attempt: nudges,
            reason: "no-signal nudge",
          });
          admission = await client.admit(
            { ...input, attach: undefined, instanceId: currentIid, prompt: nudgePrompt(input.tools) },
            { signal: controller.signal },
          );
          ledger(admission);
        }
      } catch (err) {
        if (stopped) return;
        fault(err instanceof Error ? err.message : String(err));
      }
    })();

    // Stop (parent stopped the child) == abandon. Idempotent with an explicit CANCEL.
    return abandon;
  });
  // The brand (ADR-0049): a readable property, so `isAgent` is a plain shape test and a reader —
  // `j2 up`'s model preflight, a Machine doc — can name what this slot runs without invoking it.
  return Object.assign(logic, { definition });
}
