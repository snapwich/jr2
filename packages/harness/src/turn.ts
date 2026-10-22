// The Turn (ADR-0027): one Submission's execution — the `runSubmission` a Conversation pumps.
// Per Submission the definition is read off the ADMISSION that queued it (ADR-0049: the Agent
// definition rides the Turn; model, instructions and thinkingLevel resolve when the turn starts,
// with the Frame's cwd beside them — ADR-0057 — so a later Submission on the same conversation may
// carry a retuned one and a different worktree), the surface is read afresh through the Custodian
// (menu.ts) — the Menu, fixed for the conversation, becomes the tools block, and the Turn's Allowed
// picks go into the Briefing's Turn part after the prompt (ADR-0029/0062) — and the same engine
// part carries the conversation: a later Submission is the next `prompt()` on the same pi `Agent`.
// Settlement mapping: a surface read that finds the Turn over throws `TurnOverError`, which settles
// `aborted` with the model never asked (ADR-0026); any other throw settles `failed` (the Menu
// read, or a provider failure after the Harness's retries — pi RESOLVES `prompt()` even then,
// with the outcome on the last message's `stopReason`, so this module inspects and throws, and a
// provider's refusal of the load reads `provider limit …`, ADR-0064); the
// signal aborts pi's run, and the prompt winding down rejects promptly so the pump can promote.
//
// pi is the engine, not the contract (ADR-0027). jr2 takes pi-agent-core's slim core — the `Agent`
// loop, its tool hooks, its abort and its steering queue — and owns the rest: the engine part on
// disk (`pi-engine.ts`), Compaction (`compaction.ts`), the Working tools (`working-tools.ts`) and
// the leading system message that carries the system prompt and the tools.

import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel as PiThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  createInitialSystemMessage,
  toToolDeclaration,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type Models,
  type SystemMessage,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { between, ToldPicks } from "./between-steps.ts";
import { briefedPrompt, standingBriefing, turnPart, type StandingBriefing } from "./briefing.ts";
import { compactIfOver, compactionSettingsFor, summaryRetryPolicy } from "./compaction.ts";
import { compactionSummaryText } from "./compaction-summary.ts";
import { RunawayError, TurnOverError, type RunSubmission, type SubmissionSeat } from "./conversation.ts";
import { briefingsOf, cutPickResult, readMenu, unsentPickResult, type MenuItem, type MenuOptions } from "./menu.ts";
import { MENU_TOOL_PREFIX, menuToolName, menuTools } from "./menu-tools.ts";
import {
  attachPrinter,
  printLines,
  renderCompaction,
  renderMessage,
  renderThinkingLevel,
  type PrinterOut,
} from "./printer.ts";
import { openEnginePart, type EnginePart } from "./pi-engine.ts";
import { lacksLevel, mapThinkingLevel, providerLimit, ranAt, resolveModel } from "./provider.ts";
import type { EngineSeat } from "./record.ts";
import { resolveDefinition, type ResolvedDefinition } from "./spec.ts";
import type { HistoryMessage } from "./wire.ts";
import type { MemoryGuard } from "./memory-guard.ts";
import { workingToolsFor } from "./working-tools.ts";

/** What one conversation's turn loop needs. `appendMessage` is the Conversation's stream seam —
 * completed messages land on the durable stream and the history view through it. */
export type TurnDeps = {
  /** The model registry (`provider.ts` — pi's catalog + the instance's custom provider). */
  models: Models;
  /** Where the Menu is read and picks go: the Custodian on `localhost` (`$JR2_CUSTODIAN_URL`), with
   * the Sandbox token's Stand-in (`$JR2_SANDBOX_TOKEN`) — ADR-0013, ADR-0059. */
  menu: MenuOptions;
  agentName: string;
  instanceId: string;
  appendMessage: (message: HistoryMessage) => void;
  /** Where the engine part of this conversation is kept, and the record it continues from when
   * that part does not open (ADR-0031, `pi-engine.ts`). Omitted, the part lives in memory. */
  engine?: EngineSeat;
  /** Provider-stream retry attempts — the seat ADR-0016 delegated to flue's `durability{}`,
   * re-owned as the Harness's: pi-ai runs them (`maxRetries`). Omitted → `PROVIDER_RETRIES`. A
   * rig that must see each provider error passes 0. */
  maxRetries?: number;
  /** Where the conversation prints (ADR-0023). Default `process.stdout` (the pod log). */
  printerOut?: PrinterOut;
  /** The process's memory guard (ADR-0061), watching every `bash` call. `main.ts` passes the one
   * over this pod's cgroup; omitted, no guard watches. */
  guard?: MemoryGuard;
  /** The Briefing's standing part for this pod (ADR-0062), composed once from its seat's facts so
   * every Turn sends the same bytes. `main.ts` passes the pod's; omitted, a seat that knows no
   * CPUs and no Size — a host run. */
  standing?: StandingBriefing;
  /** ADR-0035's runaway bounds — jr2-owned defaulted knobs (ADR-0016), no author surface. These
   * seams exist for the conformance suite alone, which cannot afford 128 provider rounds. */
  stepBudget?: number;
  identicalCallLimit?: number;
  /** ADR-0036's retention, in the same register and for the same reason: a scripted transcript is
   * a few hundred characters, so at the shipped 20000 every cut would degenerate to "keep
   * everything, summarize nothing" and no test could see a context shrink. The reserve needs no
   * seam — fabricated provider usage crosses the derived threshold on its own. */
  keepRecentTokens?: number;
};

/** The step budget (ADR-0035): the unconditional backstop on tool calls per Submission. Healthy
 * turns peaked at 53 on a trivial task, and an honest live bug-hunt burned 161 steps — the bound
 * sits above real investigation. It bounds STEPS, not context: a long turn can still exhaust its
 * window first (compaction's seat, not this one). */
const STEP_BUDGET = 256;
/** K consecutive byte-identical tool calls (same name, same JSON arguments) — the early exit.
 * Healthy max observed: 2. */
const IDENTICAL_CALL_LIMIT = 4;
/** The provider retries of each request (ADR-0016, ADR-0064): a 429, a 503 or an overload is
 * retried twice, with backoff, and a server's `retry-after` is honored up to 60 s. pi-ai runs them,
 * but only when the Harness states a number: it reads `maxRetries ?? 0`. 2 is the summarizer's
 * number too (`compaction.ts`), and the SDKs' own default. */
const PROVIDER_RETRIES = 2;
// Compaction's numbers (ADR-0036) live in `compaction.ts`, beside the derivation that reads them:
// `reserve = max(16384, maxTokens)` with the small-window floor, and a 20000-token retained tail.

/** The conversation's assembled runtime: one pi `Agent` on one engine part, plus the seat the
 * once-registered hooks and listeners read — so each turn works from what was resolved at ITS
 * start, on an `Agent` constructed once. */
type Assembled = {
  agent: Agent;
  part: EnginePart;
  current: {
    definition: ResolvedDefinition;
    /** This Submission's resolved model and level — the summarizer inherits both (ADR-0036), and
     * the model carries the `contextWindow`/`maxTokens` the thresholds derive from. */
    model: Model<Api>;
    thinkingLevel: PiThinkingLevel;
    /** The Menu's pick briefings (`briefingsOf`): fixed with the Menu, read once per Submission. */
    briefings: ReadonlyMap<string, string>;
    /** The leading system message of this Submission's context (see `leadOf`). */
    lead: SystemMessage | undefined;
  };
};

/**
 * The leading system message: the instructions, then the Briefing's standing part (byte-stable for
 * the seat, ADR-0062), and the declarations of the tools, in order. jr2 makes it for each Submission
 * and keeps it out of the engine part, so a changed prompt or tools block REPLACES it, as a system
 * prompt is replaced. pi compares these declarations with the tools it runs before each request
 * (`declareToolChanges`); they are equal, so pi adds no system message of its own.
 */
function leadOf(prompt: string, tools: AgentTool[]): SystemMessage | undefined {
  return createInitialSystemMessage(prompt, tools.map(toToolDeclaration));
}

/** True for the message pi makes when a run fails before a provider answered (`handleRunFailure`):
 * ended `error` or `aborted`, with nothing spent. */
function isFailureShell(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return false;
  const u = message.usage;
  return u.input === 0 && u.output === 0 && u.cacheRead === 0 && u.cacheWrite === 0 && u.totalTokens === 0;
}

/**
 * The messages the provider gets (pi's `convertToLlm`), from the loop's: the cut picks settled
 * (`settleCutPicks`), and a Compaction's summary as the user message pi 0.82.1 made of it. The
 * system message, user, assistant and tool result messages pass; nothing else is sent. It must not
 * throw (pi's contract), and nothing in it does.
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  return settleCutPicks(messages).flatMap((m): Message[] => {
    if (m.role === "compactionSummary") {
      return [
        { role: "user", content: [{ type: "text", text: compactionSummaryText(m.summary) }], timestamp: m.timestamp },
      ];
    }
    if (m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult") return [m];
    return [];
  });
}

/** Build the turn executor for one conversation (the `RunSubmission` its Conversation pumps). */
export function runSubmissionFor(deps: TurnDeps): RunSubmission {
  let assembled: Assembled | undefined;
  const stepBudget = deps.stepBudget ?? STEP_BUDGET;
  const identicalCallLimit = deps.identicalCallLimit ?? IDENTICAL_CALL_LIMIT;
  const maxRetries = deps.maxRetries ?? PROVIDER_RETRIES;
  /** The request hook writes the Compaction line itself (there is no pi event to subscribe to),
   * so the printer's destination is resolved once here rather than only inside `attachPrinter`. */
  const out = deps.printerOut ?? process.stdout;
  const summaryRetry = summaryRetryPolicy(deps.maxRetries);
  const standing = deps.standing ?? standingBriefing({});
  /** The last Allowed-picks list the model read (`between-steps.ts`): the Turn part sets it per
   * Submission, every receipt and refusal through `onAllowed`. */
  const told = new ToldPicks();
  // The presenter's naming reaches every text `menu.ts` writes (ADR-0029).
  const menuOptions: MenuOptions = {
    ...deps.menu,
    toolName: menuToolName,
    onAllowed: (allowed) => told.heard(allowed),
    onTurnOver: () => {
      turn.over = true;
    },
    // An outstanding pick's answer is the world moving (ADR-0035): the same call again is a new
    // question, so the identical-call streak starts over. The call itself was one step, whatever
    // the wait: the guard counts calls, not time.
    onAnswered: () => {
      watch.streak = 0;
      watch.signature = "";
    },
    onPolling: (polling) => {
      work.polls += polling ? 1 : -1;
      work.report();
    },
  };
  /** Per Submission: the tool calls pi is executing, and how many of them only poll an outstanding
   * pick's answer. When every running call only polls, the Turn's only pending work is the pick's
   * answer, and the Conversation hears it (`SubmissionSeat.waiting`): a stopping Harness cuts that
   * Turn at once (ADR-0031). pi executes a message's calls after the message is complete, so while
   * any runs the model is not generating. Reset when each Submission starts. */
  const work = {
    running: new Set<string>(),
    polls: 0,
    seat: undefined as SubmissionSeat | undefined,
    report(): void {
      this.seat?.waiting(this.running.size > 0 && this.running.size === this.polls);
    },
  };
  /** Per Submission: a pick's answer said the Turn is over (`turnComplete`, or a 404). From then on
   * the step boundary reads nothing — under `continue: true` the next state re-registers the SAME
   * address before the abort lands, so a read would answer for the NEXT Turn, and steer the NEXT
   * Turn's picks into this Submission. Reset when each Submission starts. */
  const turn = {
    over: false,
    /** The newest assistant message of this Submission's run: what `prompt()` settles on. */
    answer: undefined as AssistantMessage | undefined,
    /** The thinking level line (ADR-0023) is printed, or not needed, for this Submission. */
    levelSaid: false,
  };
  /** The runaway watch (ADR-0035), per Submission — reset when each turn starts. The
   * once-per-conversation `beforeToolCall` hook reads it through this seat, like `current.definition`. */
  const watch = { steps: 0, streak: 0, signature: "", tripped: "" };
  /** The Menu calls whose jr2 answer (`cutPickAnswers`) this process printed: each prints once. */
  const printedCuts = new Set<string>();

  return async (submission, signal, seat) => {
    const { message } = submission;
    work.running.clear();
    work.polls = 0;
    work.seat = seat;
    // Each Submission earns a fresh runaway budget (ADR-0035) — the watch is per-turn state.
    watch.steps = 0;
    watch.streak = 0;
    watch.signature = "";
    watch.tripped = "";
    turn.over = false;
    turn.answer = undefined;
    turn.levelSaid = false;
    // This Submission's Frame and dials layer over the definition it carries (ADR-0018/0049/0057).
    // Read HERE, per Submission, so one `continue` conversation can queue turns at different
    // settings and in different worktrees: the model, the level and the tools (rooted at the
    // Frame's `cwd`) are set on the `Agent` below for each Submission.
    const definition = resolveDefinition(submission.definition, submission);
    const model = resolveModel(deps.models, definition.model);
    const thinkingLevel = definition.thinkingLevel ? mapThinkingLevel(definition.thinkingLevel) : "off";

    // A turn that cannot see its Menu settles `failed` — the throw propagates to the pump. The
    // signal rides along so an abort landing mid read cancels it: promotion of the next admission
    // (the ADR-0024 hot path) must not park behind a retry ladder. Read BEFORE the agent is
    // assembled or touched, so a Turn that is over leaves nothing behind: no model call, no
    // history entry, and no tools block that differs from the conversation's Menu (ADR-0026).
    const read = await readMenu(menuOptions, deps.instanceId, signal);
    if (!read) {
      throw new TurnOverError(
        "the Turn was over before it started: its state exited, so the surface is gone (ADR-0026)",
      );
    }

    if (!assembled) {
      const current: Assembled["current"] = {
        definition,
        model,
        thinkingLevel,
        briefings: briefingsOf(read.menu),
        lead: undefined,
      };
      // Opened, not created, when the conversation was rebuilt: the engine part a previous process
      // wrote (ADR-0031).
      const part = openEnginePart(deps.engine, { cwd: definition.cwd, model });
      const agent = new Agent({
        initialState: { model, thinkingLevel },
        // The transcript's identity rides as pi-ai's `sessionId` (a prompt-cache key).
        sessionId: part.id,
        // jr2 is not pi: no attribution headers on its requests.
        identity: { attribution: null },
        // pi's `Agent` does not forward `maxRetries`, so the stream states it.
        streamFn: (streamModel, context, options) =>
          deps.models.streamSimple(streamModel, context, { ...options, maxRetries }),
        convertToLlm,
        // Compaction (ADR-0036), before EVERY provider request, the first one included — pi has
        // appended and emitted the pending messages, so the engine part is complete at this
        // moment. Firing on a first request is what rescues ADR-0016's nudge ladder: a nudge is a
        // fresh admission on the same conversation, so it compacts before it asks. A cut answers
        // with the rebuilt context, which pi uses for this request and the rest of the run; a
        // failure throws, which pi turns into a failed run and `prompt()` reports below as an infra
        // fault. It touches no ADR-0035 counter: the watch counts tool calls, the summarizer makes
        // none, and a turn that compacts and continues is still spending its one step budget.
        //
        // A run that has ended asks for no summary: a tripped watch (ADR-0035) here, and an abort
        // that landed after the step's end in `compactIfOver`. There is no request left to cut for.
        prepareRequest: async (request, runSignal) => {
          if (watch.tripped) return undefined;
          const cut = await compactIfOver({
            part,
            models: deps.models,
            model: current.model,
            thinkingLevel: current.thinkingLevel,
            settings: compactionSettingsFor(current.model, deps.keepRecentTokens),
            retry: summaryRetry,
            signal: runSignal,
          });
          if (!cut) return undefined;
          printLines(out, deps.agentName, [
            renderCompaction(cut.tokensBefore, cut.tokensAfter, current.model.contextWindow),
          ]);
          return {
            context: {
              messages: current.lead ? [current.lead, ...cut.messages] : cut.messages,
              tools: request.context.tools ?? [],
            },
          };
        },
        // The runaway watch (ADR-0035): steps are the tool calls this Submission observed; K
        // consecutive byte-identical calls is the early exit, the step budget the unconditional
        // backstop. Identity is name + JSON arguments — pi hands the VALIDATED args, and stringify
        // keeps the wire's key order, so byte-identical provider frames compare equal. Tripping
        // aborts the run: pi checks the signal the moment this hook returns, so the tripping call
        // never executes and answers `Operation aborted`; the block is the belt over that check,
        // and it also answers any sibling call of the same message behind the trip.
        beforeToolCall: async ({ toolCall, args }) => {
          if (!watch.tripped) {
            watch.steps += 1;
            const signature = `${toolCall.name} ${JSON.stringify(args)}`;
            watch.streak = signature === watch.signature ? watch.streak + 1 : 1;
            watch.signature = signature;
            if (watch.streak >= identicalCallLimit) {
              watch.tripped = `repeated an identical tool call ${identicalCallLimit} times`;
            } else if (watch.steps > stepBudget) {
              watch.tripped = `exceeded ${stepBudget} steps`;
            }
            if (!watch.tripped) return undefined;
            agent.abort();
          }
          return { block: true, reason: watch.tripped };
        },
        // A tripped watch or an aborted run ends at the step boundary: no steer, no other request.
        finishTurn: (_turn, runSignal) => (watch.tripped || runSignal?.aborted ? { action: "end" } : undefined),
      });
      // Once per conversation — the subscriptions survive across Submissions; re-attaching per
      // Submission would duplicate every line and every stream event. pi awaits each listener, in
      // this order.
      //
      // First the engine part: a completed message is on disk before anything else sees it. A
      // system message never reaches it (`leadOf`).
      agent.subscribe((event) => {
        if (event.type !== "message_end") return;
        const role = event.message.role;
        if (role === "user" || role === "assistant" || role === "toolResult") part.appendMessage(event.message);
      });
      // The thinking level line (ADR-0023, ADR-0018): when this Submission's model has no level of
      // the name the Turn asked for, the first assistant message a provider answered says which
      // level ran. It prints before that message's own lines, once a Submission.
      agent.subscribe((event) => {
        if (event.type !== "message_end" || turn.levelSaid || event.message.role !== "assistant") return;
        if (isFailureShell(event.message)) return;
        turn.levelSaid = true;
        if (!lacksLevel(current.model, current.thinkingLevel)) return;
        printLines(out, deps.agentName, [
          renderThinkingLevel(
            current.model,
            current.thinkingLevel,
            ranAt(current.model, current.thinkingLevel, event.message),
          ),
        ]);
      });
      attachPrinter(agent, deps.agentName, out);
      // The step boundary — pi's placement of the engine-neutral check (`between-steps.ts`, ADR-0029):
      // after a step's tool results and before its next model request, the Turn part is restated
      // when the Allowed picks changed since the model last read them. pi awaits `turn_end`
      // listeners and drains its steering queue right after (agent-loop.js), so a message steered
      // HERE is the next request's newest message, after every tool result of the step — the one
      // position every provider accepts — and it keeps the loop going after a text-only answer.
      // A listener that throws fails the run, so this one never throws. It says nothing to a Turn
      // that is ending: a step that ended `error` or `aborted` is the run's last (pi makes no
      // request after it), and a steer that missed its drain would ride into the conversation's
      // NEXT Submission, so both ends are checked again after the read. A Turn is ending once a
      // runaway trips, the run's signal aborts, or a pick's answer said the Turn is over — the last
      // is the Harness's own fact, and the only one that never races the Orchestrator's abort.
      agent.subscribe(async (event, runSignal) => {
        if (event.type !== "turn_end") return;
        const stop = (event.message as { stopReason?: string }).stopReason;
        if (stop === "error" || stop === "aborted") return;
        const live = () => !watch.tripped && !runSignal.aborted && !turn.over;
        if (!live()) return;
        // A step with no tool result is the model stopping: the ask-again rule (ADR-0016).
        const stopped = event.toolResults.length === 0;
        const text = await between(menuOptions, deps.instanceId, told, runSignal, {
          stopped,
          briefings: current.briefings,
        }).catch(() => undefined);
        if (text === undefined || !live()) return;
        agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
      });
      // What is executing (`work`): every tool call between its start and its end.
      agent.subscribe((event) => {
        if (event.type === "tool_execution_start") work.running.add(event.toolCallId);
        else if (event.type === "tool_execution_end") work.running.delete(event.toolCallId);
        else return;
        work.report();
      });
      agent.subscribe((event) => {
        if (event.type !== "message_end") return;
        if (event.message.role === "assistant") turn.answer = event.message;
        const entry = historyMessage(event.message);
        if (entry) deps.appendMessage(entry);
      });
      assembled = { agent, part, current };
    } else {
      assembled.current.definition = definition;
      assembled.current.model = model;
      assembled.current.thinkingLevel = thinkingLevel;
      assembled.current.briefings = briefingsOf(read.menu);
    }

    const { agent, part, current } = assembled;
    // The Turn part below states this list: it is the first the model reads this Submission.
    told.heard(read.allowed);
    // The whole Menu, never the Allowed picks: the tools lead the provider's prefix cache, so they
    // are the same bytes on every Turn of the conversation (ADR-0029). What this Turn may pick is
    // said in the Turn part below, and enforced at delivery.
    const menu = seat ? read.menu.map((item) => cutWith(item, seat.cut)) : read.menu;
    const tools: AgentTool[] = [
      ...workingToolsFor(definition, definition.cwd, { guard: deps.guard }),
      ...(menuTools(menu) as AgentTool[]),
    ];
    current.lead = leadOf(standing(definition.instructions, definition.workspace), tools);
    agent.state.model = model;
    agent.state.thinkingLevel = thinkingLevel;
    agent.state.tools = tools;
    // The context the model reads: the leading system message, then the engine part's context —
    // the conversation so far, a Compaction's summary in place of what it cut.
    const context = part.context();
    agent.state.messages = current.lead ? [current.lead, ...context] : context;
    // Nothing queued before this Submission reaches it: a restatement belongs to the Turn that asked
    // for it (ADR-0029), and pi's `abort()` does not clear the queues.
    agent.clearAllQueues();
    part.appendSubmission();

    const onAbort = () => agent.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted) throw new Error("swept before its turn started");
      // A conversation that ends in a Menu call with no result — a restart cut its Turn while the
      // call was out, or an abort cut it while the model was still writing the call: the history
      // answers it with jr2's text from here on, which pi adds to no event. So the log shows that
      // answer once, here, before the prompt that follows the call (ADR-0023).
      const cuts = cutPickAnswers(context).filter((answer) => !printedCuts.has(answer.toolCallId));
      for (const answer of cuts) printedCuts.add(answer.toolCallId);
      printLines(out, deps.agentName, cuts.flatMap(renderMessage));
      // The Briefing's Turn part FOLLOWS the Frame's prompt (ADR-0062): the author's task reads
      // first, and the Allowed picks last, where a model obeys them (ADR-0029, measured).
      await agent.prompt(
        briefedPrompt(
          message,
          turnPart({
            workspace: definition.workspace,
            cwd: definition.cwd,
            allowed: read.allowed,
            toolName: menuToolName,
            briefings: current.briefings,
            ...(submission.notices ? { notices: submission.notices } : {}),
          }),
        ),
      );
      // The watch's SELF-abort (ADR-0035): pi ended the run, but the pump's signal never fired.
      // Checked first so the runaway reason wins over the generic mapping below; a sweep that raced
      // the trip still settles `aborted` — the pump's own signal check outranks any throw.
      if (watch.tripped) throw new RunawayError(watch.tripped);
      // Read through the seat: the listener set it while `prompt()` ran.
      const answer = turn.answer as AssistantMessage | undefined;
      // pi resolves prompt() even on abort/failure — its last message carries the outcome.
      // Rejecting here is what lets the pump promote the next admission promptly.
      if (signal.aborted || !answer || answer.stopReason === "aborted") {
        throw new Error(answer?.errorMessage ?? "the run aborted");
      }
      // A provider that still refused the load after the Harness's retries is NAMED (ADR-0064):
      // the fixed prefix `provider limit`, so the fault reason tells provider pressure from a bug.
      if (answer.stopReason === "error") {
        throw new Error(providerLimit(answer) ?? answer.errorMessage ?? "provider failure");
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * A Menu item whose pick a stopping Harness can cut (ADR-0031): `cut` aborts the pick's requests —
 * the poll ends unanswered, so the Orchestrator does not count its answer as read — and the call
 * then never returns. pi gets no result for it, writes none to the engine part, and asks the model
 * nothing more; the next process answers the call with jr2's text (`settleCutPicks`, the pick
 * reached the workflow), and the re-admission carries the answer.
 */
function cutWith(item: MenuItem, cut: AbortSignal): MenuItem {
  return {
    ...item,
    pick: (params, signal) =>
      new Promise<string>((resolve, reject) => {
        item.pick(params, signal ? AbortSignal.any([signal, cut]) : cut).then(
          (text) => cut.aborted || resolve(text),
          (err: unknown) => cut.aborted || reject(err),
        );
      }),
  };
}

/** An aborted assistant message with real content, re-tagged so pi's API layer replays instead of
 * dropping it (`convertToLlm` above). pi keeps an aborted partial message in the engine part but
 * REPLAYS none of it — its API layer drops any assistant message whose stopReason is `aborted` from
 * every later request, which is byte-for-byte the flue defect ADR-0027 inverts (an abort mid-stream
 * must NOT erase the assistant message). So it settles at send time: an aborted message that carried
 * real content re-enters the context completed (pi synthesizes results for its orphaned tool calls).
 * Anything else passes through — including pi's synthesized failure shells, whose only content is an
 * empty text block. */
function settleAbandonedMessage(message: AgentMessage): AgentMessage {
  if ((message as { role?: string }).role !== "assistant") return message;
  const assistant = message as AssistantMessage;
  if (assistant.stopReason !== "aborted") return message;
  const kept = assistant.content.filter(
    (block) =>
      block.type === "toolCall" ||
      (block.type === "text" && block.text.length > 0) ||
      (block.type === "thinking" && block.thinking.length > 0),
  );
  if (kept.length === 0) return message;
  return { ...assistant, content: kept, stopReason: kept.some((b) => b.type === "toolCall") ? "toolUse" : "stop" };
}

/**
 * Settle the messages pi will send (ADR-0031): each aborted message re-tagged
 * (`settleAbandonedMessage`), and each Menu call a cut left with no result answered with jr2's text
 * (a call in a message a provider error ended gets none; see below). pi
 * would answer such a call itself when it sends the history — "No result provided", an error, which
 * reads as a failed pick and invites a second one. Two cuts leave one, and the text tells them apart
 * by whether the call was delivered, read BEFORE the re-tag:
 *
 *   - The model finished the message, so pi ran its calls, and a restart of this Harness cut the
 *     Turn while the call was out: the pick reached the workflow, which does not run it twice, and
 *     its answer comes in the next message (the re-admission's notice, ADR-0024) — `cutPickResult`.
 *   - The message is aborted: an abort cut the Turn while the model was still writing it, and pi runs
 *     no call of such a message. The pick did not reach the workflow, nothing ran, and the model may
 *     make it again — `unsentPickResult`.
 *
 * A message a provider error ended (stopReason `error`) is neither: pi runs none of its calls
 * (agent-loop.js, the `error`/`aborted` return after the stream) and drops the message from every
 * request (transform-messages.js, "Skip errored/aborted assistant messages"). It is not re-tagged,
 * and its calls get no answer: a result with no call before it is one the providers refuse. The
 * pick never reached the workflow, so the model is free to make it again.
 *
 * Placed before pi's transform, so pi finds a result and adds none. A Working-tool call is pi's to
 * answer.
 */
export function settleCutPicks(messages: AgentMessage[]): AgentMessage[] {
  return settled(messages).messages;
}

/**
 * The answers `settleCutPicks` gives the Menu calls a conversation ENDS in: the Turn a restart or an
 * abort cut, which no prompt has followed yet. pi adds them to no event, so the printer never sees
 * them, and the model reads them on every later request: they print once, before the next prompt
 * (ADR-0023). A cut call further back was answered, and printed, before the prompt after it.
 */
export function cutPickAnswers(messages: AgentMessage[]): ToolResultMessage[] {
  const { messages: out, added } = settled(messages);
  const tail: ToolResultMessage[] = [];
  for (let i = out.length - 1; i >= 0 && (out[i] as { role?: string }).role === "toolResult"; i--) {
    if (added.has(out[i]!)) tail.unshift(out[i] as ToolResultMessage);
  }
  return tail;
}

function settled(messages: AgentMessage[]): { messages: AgentMessage[]; added: Set<AgentMessage> } {
  const added = new Set<AgentMessage>();
  const answered = new Set(
    messages.flatMap((m) =>
      (m as { role?: string }).role === "toolResult" ? [(m as ToolResultMessage).toolCallId] : [],
    ),
  );
  const out: AgentMessage[] = [];
  let open: ToolCall[] = [];
  let delivered = true;
  const close = (): void => {
    for (const call of open) {
      if (answered.has(call.id) || !call.name.startsWith(MENU_TOOL_PREFIX)) continue;
      const text = delivered ? cutPickResult(call.name) : unsentPickResult(call.name);
      const answer: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text }],
        isError: false,
        timestamp: Date.now(),
      };
      added.add(answer);
      out.push(answer);
    }
    open = [];
  };
  for (const message of messages) {
    const role = (message as { role?: string }).role;
    if (role !== "toolResult") close();
    const sent = settleAbandonedMessage(message);
    out.push(sent);
    if (role === "assistant") {
      // Read before the re-tag: pi ran the calls of a finished message, and none of a message that
      // ended `aborted` or `error`. An errored one is not re-tagged, and pi drops it from every
      // request, so an answer to its call would be a result with no call before it: it gets none.
      const stop = (message as AssistantMessage).stopReason;
      delivered = stop !== "aborted" && stop !== "error";
      open =
        stop === "error"
          ? []
          : (sent as AssistantMessage).content.filter((block): block is ToolCall => block.type === "toolCall");
    }
  }
  close();
  return { messages: out, added };
}

/** One completed pi message → its history entry, or none. Best-effort by contract (the history
 * view's `messages`): roles and text only; pi's synthesized failure messages (stopReason
 * `error`/`aborted`) and text-less tool-call turns do not land on the stream. */
function historyMessage(message: AgentMessage): HistoryMessage | undefined {
  const role = (message as { role?: string }).role;
  if (role === "user") {
    const content = (message as UserMessage).content;
    const text =
      typeof content === "string"
        ? content
        : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    return text ? { role: "user", text } : undefined;
  }
  if (role === "assistant") {
    const assistant = message as AssistantMessage;
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") return undefined;
    const text = assistant.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    return text ? { role: "assistant", text } : undefined;
  }
  return undefined;
}
