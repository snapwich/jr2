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
// could not tell two Machines' `coder`s apart — and every admission carries it to the Harness,
// which holds no roster either and runs what this Turn handed it.
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
import {
  requireBoundAgent,
  type AgentDeclaration,
  type AgentDefinition,
  type ThinkingLevel,
  type WorkspaceAccess,
} from "./agent.ts";
import { ambientHandlesFor, type AmbientHandles } from "./ambient.ts";
import { INSTANCE_HARNESS_SERVICE } from "./names.ts";
import { agentAddress, continuedIid, resolveAccepts, runBindingOf } from "./registration.ts";

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
 * What a WORKFLOW writes on an Agent slot's invoke (ADR-0015/0016/0049/0057): this Turn's FRAME,
 * its DIALS, and whether it CONTINUES — nothing else. The AGENT is not written here at all: the
 * slot key is its name (`actors: { coder: agent(def) }`, `src: "coder"`), so a name the Machine
 * does not carry is a compile error on `src` instead of a runtime miss.
 *
 * `jr2Setup.createMachine` wraps the invoke input to finalize it into {@link AgentRunInput}: the
 * slot key lands as `agentName`, the tool menu derives from the invoking state's transitions, the
 * instance id is MINTED (never written here — fresh by default; `continue: true` derives the
 * Agent's one conversation in this Machine instance), and endpoint/sandbox resolve ambiently from
 * the enclosing `workspace()`.
 */
export type AgentTurnInput = {
  /** Half this Turn's FRAME (ADR-0057) — what it is about: the prompt lands as the conversation's
   * next user message. Neither identity nor a Dial. */
  prompt: string;
  /**
   * The other half of the FRAME (ADR-0057) — WHERE this Turn works: the absolute directory the
   * Harness roots the Working tools at. Per Turn by nature, which is why no definition names one:
   * a Worktree path (`/work/<slot>/<branch>`) exists only once a run has a branch.
   *
   * Absent, the actor resolves it before admission: a `workspace: "none"` Agent frames no
   * directory (it has no Working tools to root — ADR-0028), a Workspace with ONE Repo Slot frames
   * that slot's Worktree, a Workspace with more REFUSES the Turn (the kit gives no slot a meaning
   * — ADR-0051 — so the state must say which), and a run with no Workspace at all frames nothing
   * and the Harness keeps `/work`. A relative path is refused at admission, by the Harness.
   */
  cwd?: string;
  /**
   * This turn's DIALS (ADR-0018) — how hard to run, layered over the definition's own
   * values. One definition value may be carried by several Machines, so the same persona
   * legitimately runs at different settings in different workflows: a reviewer on a one-line diff
   * and the same reviewer on an architecture change want identical instructions and different
   * effort.
   *
   * IDENTITY is deliberately absent — no `instructions` or `workspace` here. A call site that
   * rewrote those would make the Agent's name a lie, and `workspace` in particular carries
   * ADR-0028's containment claim, which per-invocation escalation would void.
   */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /**
   * Continue this Agent's ONE conversation in this Machine instance (ADR-0016, ADR-0057) — the
   * whole continuation surface. Absent, every invocation is a FRESH conversation (jr's lossy
   * handoff — revision agents read notes + code, never the prior conversation). Present, the
   * prompt lands as the next user turn of that conversation, whichever state of the Machine
   * invokes it: states differ by Menu (a coder in `implement` offers `finish`; the same coder in
   * `fix` offers `finish` and `dispute`) and the conversation is wanted across them.
   *
   * It names nothing, because the id is STRUCTURAL — `<runId>/<machine actor path>/<agent>` — and
   * a caller-chosen key could only restate that, or contradict it. Two Agents therefore never
   * share a conversation (the name is in the id), and two Pool children never collide (each
   * worker is its own Machine instance). A conversation jr2 has faulted is never continued: the
   * next `continue` lands on a virgin one (ADR-0035, ADR-0057) — and re-briefing that Turn is the
   * author's, because jr2 cannot write that prompt.
   */
  continue?: true;
};

/**
 * MECHANISM, not authoring surface (ADR-0057): where a Turn's Harness is and which Sandbox scopes
 * its deliveries, STATED instead of resolved. It is the seat the stub tier sits in — a
 * mechanics-tier test has no `workspace()` to resolve from, and a dev Harness is just a URL
 * (ADR-0011) — so it is exported for those tests and for nothing else.
 *
 * A real run states neither: a Sandbox Agent resolves both ambiently from the enclosing
 * `workspace()` (ADR-0016), and a `workspace: "none"` Agent lands on the Instance Harness
 * (ADR-0031). Stated, it wins over both, because a URL a test wrote is the one thing no ambient
 * walk can know about.
 */
export type AgentTurnPlacement = {
  /** The Harness base URL this Turn is admitted over. */
  endpoint?: string;
  /** The Sandbox whose Adapter token may deliver this Turn's picks (ADR-0013). */
  sandbox?: string;
};

/** What the actor is invoked with AFTER jr2Setup finalization: the durable handle, this turn's
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
  /** The other half of this Turn's Frame (ADR-0057): where the Working tools are rooted. Rides the
   * admit body beside the prompt; absent, the Harness keeps `/work`. */
  cwd?: string;
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
   * This invocation CONTINUES an existing conversation — set by the input mapper from
   * `continue: true` alone (ADR-0057), and nothing else. Two things hang off it:
   *
   *   - it is closed to the ADR-0035 reroll: the runaway's one recovery is a fresh conversation,
   *     which is exactly what a continuation opted out of, and a continued Turn's prompt
   *     ("Continue.") is meaningless replayed fresh. A gated runaway goes straight to the fault;
   *   - a terminal `agent.fault` BURNS the conversation (ADR-0057): the epoch bumps in the host
   *     ledger, so the next `continue` on this Agent mints a virgin id. Nothing is burned for a
   *     fresh invocation, which already mints its own conversation.
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
  /** Admit one prompt; resolves with the admission the moment the Harness accepts it. The
   * DEFINITION rides the admission (ADR-0049) — it is the Agent slot's, read off the logic this
   * invocation named, never off the persisted input: the Harness holds no roster, and a restore
   * must run the definition the Machine carries NOW, not a copy a snapshot froze. */
  admit(input: AgentRunInput, opts: AgentAdmitOptions): Promise<AgentAdmission>;
  /**
   * Follow an admitted submission until it settles. Resolving means the submission completed;
   * rejecting means it settled failed/aborted (or the conversation is gone).
   */
  settle(admission: AgentAdmission, opts?: { signal?: AbortSignal }): Promise<void>;
  /**
   * End the instance's in-flight (and queued) work — the turn is over (ADR-0024). Resolving means
   * the intent is RECORDED, not that the submission has settled; jr2 never observes that outcome,
   * because the actor is already stopped by the time this is called. The actor passes no `signal`
   * for exactly that reason — its own controller is already aborted — but the option is here for
   * parity with the other two.
   */
  abort(agentName: string, instanceId: string, opts?: { signal?: AbortSignal }): Promise<void>;
}

/** What every admission carries beside the input: the Agent definition this Turn runs (ADR-0049),
 * plus the local abandon signal. Not part of {@link AgentRunInput} on purpose — that shape is
 * PERSISTED as the child's input, and a definition frozen into a snapshot would outlive the
 * Machine edit that changed it. */
export type AgentAdmitOptions = { definition: AgentDefinition; signal?: AbortSignal };

/** Build a port for one invocation from its serializable input (ADR-0011 static-import doctrine). */
export type AgentRunPortFactory = (endpoint: string) => AgentRunPort;

/** Absorbed-turn-mechanics knobs (ADR-0016): defaulted, never Machine context. */
export type AgentRunOptions = {
  /**
   * How many times a turn that settles COMPLETED without having called any menu tool is
   * re-prompted ("you must call one of: …") before the terminal `agent.fault`. jr's dominant
   * failure mode: the Harness settles a silent turn `completed` like any other (ADR-0006), so
   * this loop is jr2-owned. Default 2.
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
 * so the literal is restated (`SUBMISSION_RUNAWAY` in `./wire.ts`) and the shape
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

/**
 * Where this Turn works — the Frame's other half (ADR-0057), resolved before admission.
 *
 * The state's own `cwd` IS the Frame and wins outright, for every Agent: what is resolved here is
 * an ABSENT one, and a directory a state named is never second-guessed — a Menu-only Agent handed
 * one simply has no Working tools to root there (ADR-0028/0031).
 *
 * Absent, a Menu-only Agent frames no directory; a Workspace with ONE Repo Slot frames that
 * slot's Worktree, which privileges nothing because there is nothing to choose between (ADR-0051);
 * a Workspace with more REFUSES the Turn, naming the slots in declaration order and the line that
 * ends it, because the kit gives no slot a meaning and a wrong guess is the silent failure
 * ADR-0057 was written for; and a run outside any Workspace frames nothing, so the Harness keeps
 * `/work`.
 *
 * Resolution counts SLOTS, and a slot's Worktree is the writable branch checkout. The detached
 * review Worktree (`AmbientHandles.review`, ADR-0028's reviewer seat) is never resolved to: it is
 * per review round, so only the reviewing state knows which one, and it frames it (ADR-0028 hands
 * the reviewer its path as "cwd and prompt"). A `workspace: "read"` Agent that frames nothing
 * under a one-slot Workspace therefore works in the branch checkout with `write`/`edit` withheld
 * and `bash` kept — the tool layer's hint, not containment (ADR-0028): containment is the
 * detached review Worktree, and only a reviewing state that requested one can frame it.
 *
 * The refusal throws at invoke, like the Open-model fence: loudly, at the first Turn, before a
 * surface is registered or a pod is spent.
 */
function frameCwd(
  instanceId: string,
  input: AgentRunInput,
  workspace: WorkspaceAccess,
  ambient: AmbientHandles | undefined,
): string | undefined {
  if (input.cwd !== undefined) return input.cwd;
  if (workspace === "none") return undefined;
  const slots = Object.keys(ambient?.repos ?? {});
  if (slots.length === 0) return undefined;
  if (slots.length === 1) return ambient!.repos[slots[0]!];
  throw new Error(
    `turn ${instanceId}: agent "${input.agentName}" works under a Workspace carrying more than one ` +
      `Repo Slot (${slots.join(", ")}) and its Turn framed no \`cwd\` — say which Worktree it works ` +
      `in (\`cwd: context.workspace.repos.<slot>\`, one of those), because the kit gives no slot a ` +
      `meaning (ADR-0051) and a Turn's Frame is where it works (ADR-0057)`,
  );
}

/** One Agent slot's logic: the run-lifecycle actor closed over ONE definition and BRANDED with it
 * (ADR-0049). The brand is the whole resolution mechanism — the actor reads its definition off its
 * own closure, `jr2Setup` recognizes the slot by `isAgent`, and a `.provide()` that swaps the slot
 * swaps the definition with it, because the two are one object.
 *
 * The brand is a RUNTIME property, read back through `isAgent`, and deliberately NOT part of this
 * type: the unit-test seam is `provide({ actors: { coder: fake } })` (ADR-0049), and a required
 * `definition` here would make every fake carry a definition it never uses. */
export type AgentLogic = CallbackActorLogic<
  AgentRunReceiveEvent,
  AgentTurnInput | (AgentTurnInput & AgentTurnPlacement) | AgentRunInput
>;

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
 * The `declaration` is a CLOSURE, not a lookup: the Turn's placement (ADR-0031) reads it off the
 * logic the invoke actually named, so two Machines carrying different `coder`s each resolve their
 * own, and no roster is consulted anywhere (ADR-0049). It is the AUTHOR's declaration, model
 * possibly Open — narrowed to the wire's definition on start (ADR-0054), before anything is
 * admitted and before placement is resolved, so that everything below this line reads a model.
 */
export function agentActorWith(
  portFactory: AgentRunPortFactory,
  declaration: AgentDeclaration,
  options: AgentRunOptions = {},
): AgentLogic {
  const nudgeBudget = options.nudgeBudget ?? 2;
  const runawayBudget = options.runawayBudget ?? 1;
  // Typed as the union so BOTH shapes typecheck on an invoke: jr2Setup machines write
  // AgentTurnInput (and the config wrapper finalizes it before the actor ever runs); plain
  // setup() machines must pass the finalized shape themselves — checked loudly below.
  const logic = fromCallback<
    AgentRunReceiveEvent,
    AgentTurnInput | (AgentTurnInput & AgentTurnPlacement) | AgentRunInput
  >((args) => {
    const { system, self, sendBack, receive } = args;
    const input = args.input as AgentRunInput;
    const { instanceId } = input;
    if (!instanceId || !input.agentName) {
      throw new Error(
        `an Agent slot was invoked with unfinalized input — declare it on a jr2Setup(...) machine ` +
          `(\`actors: { <name>: agent(def) }\`, which names the Agent, mints the instance id and ` +
          `derives the menu), or pass \`agentName\`/\`instanceId\`/\`tools\` explicitly`,
      );
    }

    // The second fence (ADR-0054): a Turn is never admitted under an Open model. `jr2 up`'s walk is
    // the first and catches every registered Machine; this one catches what it never walked, and
    // refuses HERE rather than sending a Symbol the wire would drop silently.
    const definition = requireBoundAgent(input.agentName, declaration);

    // Resolve the Harness coordinates (ADR-0016/0031). Explicit input wins (the workspace-less
    // stub path); then the DEFINITION decides: `workspace: "none"` pins the Turn to the Instance
    // Harness always — even inside an enclosing workspace(), because a conversation is an
    // Instance ID on ONE Harness and a continued advisor must land on the server that holds it
    // (definition-wins, ADR-0031); everyone else resolves the nearest enclosing workspace()'s
    // handles — walked structurally via the actor parent chain, so a sibling workspace's handles
    // are unreachable (ADR-0013).
    const binding = runBindingOf(system);
    const workspace = definition.workspace ?? "write";
    // The enclosing workspace()'s handles, walked structurally up the actor parent chain — the
    // Harness coordinates below and the Frame's `cwd` both read them (ADR-0013/0016/0057).
    const ambient = ambientHandlesFor(self);
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

    // The Frame's other half (ADR-0057): WHERE this Turn works. Resolved HERE, before any surface
    // is registered and before a pod is spent, because the answer is a fact about the run — a
    // Worktree path exists only once a run has a branch, so no definition could have named it.
    const cwd = frameCwd(instanceId, input, workspace, ambient);
    const framed: AgentRunInput = cwd === undefined ? input : { ...input, cwd };

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
    //     failed/aborted, or the conversation is lost (ADR-0027). Terminal, no jr2 re-run.
    //   - NO-SIGNAL: the Submission settles COMPLETED but no menu tool was called. The Harness
    //     calls that a normal turn, so jr2 owns a budgeted re-prompt on the SAME iid (the conversation
    //     continues; each nudge is a fresh admission, ledgered like any other).
    //   - RUNAWAY: the Harness ended a turn that would not conclude and settled it failed with
    //     the typed "runaway" error (ADR-0035). The degenerate context is poisoned, so the
    //     budgeted reroll is the OPPOSITE of a nudge: a fresh conversation under a derived iid,
    //     admitting the identical prompt — closed to continuations, which opted out of exactly that.
    // Any budget exhausting emits the ONE terminal `agent.fault { reason }`.
    void (async () => {
      const fault = (reason: string) => {
        if (stopped) return;
        // Burn the conversation before the fault lands (ADR-0057): the state the fault routes to
        // may invoke this Agent again in the same macrostep, and its mapper must already read the
        // bumped epoch. Continuations only — a fresh invocation mints its own conversation, so
        // there is nothing to burn.
        if (input.continuation) binding.bumpEpoch?.(continuedIid(self._parent, binding.runId, input.agentName));
        sendBack({ type: "agent.fault", instanceId, reason } satisfies FaultTelemetry);
      };
      try {
        // Queue behind any abort still in flight for this iid (ADR-0024). Non-trivial only under
        // `continue: true`, which is the only way two invocations share an instance id — and
        // there it is mandatory: the Harness queues per conversation and an abort settles what
        // is queued behind it, so losing this race would kill the new turn before it ran, silently.
        await pendingAborts.get(instanceId);
        let admission = input.attach;
        if (!admission) {
          admission = await client.admit(framed, { definition, signal: controller.signal });
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
              { ...framed, attach: undefined, instanceId: currentIid },
              { definition, signal: controller.signal },
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
            { ...framed, attach: undefined, instanceId: currentIid, prompt: nudgePrompt(input.tools) },
            { definition, signal: controller.signal },
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
  // `jr2 up`'s model preflight, a Machine doc — can name what this slot runs without invoking it.
  // The DECLARATION, not the narrowed definition: an Open model is exactly what those readers
  // must be able to see and refuse (ADR-0054).
  return Object.assign(logic, { definition: declaration });
}
