// The Turn (ADR-0027): one Submission's execution — the `runSubmission` a Conversation pumps.
// Per Submission the definition is read off the ADMISSION that queued it (ADR-0049: the Agent
// definition rides the Turn; model, instructions and thinkingLevel resolve when the turn starts,
// with the Frame's cwd beside them — ADR-0057 — so a later Submission on the same conversation may
// carry a retuned one and a different worktree), the surface is read afresh through the Custodian
// (menu.ts) — the Menu, fixed for the conversation, becomes the tools block, and the Turn's Allowed
// picks go into the Briefing's Turn part after the prompt (ADR-0029/0062) — and the same pi session
// carries the conversation: a later Submission is the next `prompt()` on the same AgentHarness.
// Settlement mapping: a surface read that finds the Turn over throws `TurnOverError`, which settles
// `aborted` with the model never asked (ADR-0026); any other throw settles `failed` (the Menu
// read, or a provider failure after pi's retries — pi RESOLVES `prompt()` even then,
// with the outcome on the message's `stopReason`, so this module inspects and throws, and a
// provider's refusal of the load reads `provider limit …`, ADR-0064); the
// signal aborts pi's run, and the prompt winding down rejects promptly so the pump can promote.

import {
  AgentHarness,
  type AgentMessage,
  type ExecutionToolContext,
  type Session,
  type ThinkingLevel as PiThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type {
  Api,
  AssistantMessage,
  Model,
  Models,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { between, ToldPicks } from "./between-steps.ts";
import { briefedPrompt, standingBriefing, turnPart, type StandingBriefing } from "./briefing.ts";
import { compactIfOver, compactionSettingsFor, summaryRetryPolicy } from "./compaction.ts";
import { RunawayError, TurnOverError, type RunSubmission, type SubmissionSeat } from "./conversation.ts";
import { cutPickResult, readMenu, type MenuItem, type MenuOptions } from "./menu.ts";
import { MENU_TOOL_PREFIX, menuToolName, menuTools } from "./menu-tools.ts";
import { attachPrinter, printLines, renderCompaction, type PrinterOut } from "./printer.ts";
import { piSession } from "./pi-engine.ts";
import { mapThinkingLevel, providerLimit, resolveModel } from "./provider.ts";
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
  /** Where pi keeps its session for this conversation, and the record it continues from when that
   * session will not open (ADR-0031, `pi-engine.ts`). Omitted, the session lives in memory. */
  engine?: EngineSeat;
  /** Provider-stream retry attempts — the seat ADR-0016 delegated to flue's `durability{}`,
   * re-owned as pi's `maxRetries`. Omitted → pi's default. */
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
// Compaction's numbers (ADR-0036) live in `compaction.ts`, beside the derivation that reads them:
// `reserve = max(16384, maxTokens)` with the small-window floor, and a 20000-token retained tail.

/** The conversation's assembled runtime: one AgentHarness on one pi session, plus the seat the
 * lazy `systemPrompt`/`toolContext` callbacks and the once-registered hooks read — so each turn
 * works from what was resolved at ITS start, on a harness constructed once. The Session is held
 * because pi keeps its own reference private and Compaction writes to it (ADR-0036). */
type Assembled = {
  harness: AgentHarness<ExecutionToolContext>;
  session: Session;
  current: {
    definition: ResolvedDefinition;
    /** This Submission's resolved model and level — the summarizer inherits both (ADR-0036), and
     * the model carries the `contextWindow`/`maxTokens` the thresholds derive from. */
    model: Model<Api>;
    thinkingLevel: PiThinkingLevel;
    /** The run's abort signal. pi's loop hands `transformContext` a signal but `AgentHarness`
     * drops it before the hook sees it, so a summary would outlive the sweep that cancelled its
     * turn (ADR-0024) unless jr2 carries the signal itself. */
    signal: AbortSignal;
  };
};

/** Build the turn executor for one conversation (the `RunSubmission` its Conversation pumps). */
export function runSubmissionFor(deps: TurnDeps): RunSubmission {
  let assembled: Assembled | undefined;
  const stepBudget = deps.stepBudget ?? STEP_BUDGET;
  const identicalCallLimit = deps.identicalCallLimit ?? IDENTICAL_CALL_LIMIT;
  /** The `context` hook writes the Compaction line itself (there is no pi event to subscribe to),
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
  const turn = { over: false };
  /** The runaway watch (ADR-0035), per Submission — reset when each turn starts. The
   * once-per-conversation `tool_call` hook reads it through this seat, like `current.definition`. */
  const watch = { steps: 0, streak: 0, signature: "", tripped: "" };

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
    // This Submission's Frame and dials layer over the definition it carries (ADR-0018/0049/0057).
    // Read HERE, per Submission, so one `continue` conversation can queue turns at different
    // settings and in different worktrees — the `setModel`/`setThinkingLevel` reconciliation below
    // handles a changed dial, and a changed `cwd` re-roots the Working tools two ways, because
    // they take their root two ways (`working-tools.ts`): `setTools` below rebuilds grep and glob,
    // which close over it, while pi's read/write/edit/bash read the `toolContext` callback below,
    // which pi resolves per turn off `current.definition`.
    const definition = resolveDefinition(submission.definition, submission);
    const model = resolveModel(deps.models, definition.model);
    const thinkingLevel = definition.thinkingLevel ? mapThinkingLevel(definition.thinkingLevel) : "off";

    // A turn that cannot see its Menu settles `failed` — the throw propagates to the pump. The
    // signal rides along so an abort landing mid read cancels it: promotion of the next admission
    // (the ADR-0024 hot path) must not park behind a retry ladder. Read BEFORE the harness is
    // assembled or touched, so a Turn that is over leaves nothing behind: no model call, no
    // history entry, and no tools block that differs from the conversation's Menu (ADR-0026).
    const read = await readMenu(menuOptions, deps.instanceId, signal);
    if (!read) {
      throw new TurnOverError(
        "the Turn was over before it started: its state exited, so the surface is gone (ADR-0026)",
      );
    }

    if (!assembled) {
      const current = { definition, model, thinkingLevel, signal };
      // Held, not inlined: Compaction appends its entry to THIS session (ADR-0036), and
      // `AgentHarness` exposes no accessor for the one it was given. Opened, not created, when the
      // conversation was rebuilt: the engine part a previous process wrote (ADR-0031).
      const session = await piSession(deps.engine, { cwd: definition.cwd, model });
      const harness = new AgentHarness<ExecutionToolContext>({
        session,
        models: deps.models,
        model,
        thinkingLevel,
        // The instructions, then the Briefing's standing part — byte-stable for the seat (ADR-0062).
        systemPrompt: () => standing(current.definition.instructions, current.definition.workspace),
        toolContext: () => ({ env: new NodeExecutionEnv({ cwd: current.definition.cwd }) }),
        ...(deps.maxRetries === undefined ? {} : { streamOptions: { maxRetries: deps.maxRetries } }),
      });
      // Once per conversation — the subscriptions survive across Submissions; re-attaching per
      // Submission would duplicate every line and every stream event.
      attachPrinter(harness, deps.agentName, out);
      // The step boundary — pi's placement of the engine-neutral check (`between-steps.ts`, ADR-0029):
      // after a step's tool results and before its next model request, the Turn part is restated
      // when the Allowed picks changed since the model last read them. pi awaits `turn_end`
      // subscribers and drains its steering queue right after (agent-loop.js), so a message steered
      // HERE is the next request's newest message, after every tool result of the step — the one
      // position every provider accepts — and it keeps the loop going after a text-only answer.
      // A subscriber that throws fails the run, so this one never throws. It says nothing to a Turn
      // that is ending: a steer that missed its drain would ride into the conversation's NEXT
      // Submission (pi drains the queue first thing), so both ends are checked again after the read.
      // A Turn is ending once a runaway trips, the run's signal aborts, or a pick's answer said the
      // Turn is over — the last is the Harness's own fact, and the only one that never races the
      // Orchestrator's abort.
      harness.subscribe(async (event) => {
        if (event.type !== "turn_end") return;
        const live = () => !watch.tripped && !current.signal.aborted && !turn.over;
        if (!live()) return;
        // A step with no tool result is the model stopping: the ask-again rule (ADR-0016).
        const stopped = event.toolResults.length === 0;
        const text = await between(menuOptions, deps.instanceId, told, current.signal, { stopped }).catch(
          () => undefined,
        );
        if (text === undefined || !live()) return;
        await harness.steer(text).catch((err: unknown) => {
          console.error(`[${deps.agentName}] could not restate the Allowed picks:`, err);
        });
      });
      // What is executing (`work`): every tool call between its start and its end.
      harness.subscribe((event) => {
        if (event.type === "tool_execution_start") work.running.add(event.toolCallId);
        else if (event.type === "tool_execution_end") work.running.delete(event.toolCallId);
        else return;
        work.report();
      });
      harness.subscribe((event) => {
        if (event.type !== "message_end") return;
        const entry = historyMessage(event.message);
        if (entry) deps.appendMessage(entry);
      });
      // The `context` hook, which jr2 owns twice over — ONE handler, because pi's `emitHook` hands
      // every handler the same untransformed event and keeps only the LAST non-undefined result,
      // so a second registration would silently discard the first's transform rather than chain
      // onto it.
      //
      // First the Compaction (ADR-0036). This hook fires before EVERY provider request, including
      // a turn's first — pi emits the prompt's `message_end` straight to the Session before the
      // loop starts, and `prepareNextTurn` rebuilds from the Session after every later step, so
      // the Session is complete and consistent at this moment either way. Firing on a first
      // request is what rescues ADR-0016's nudge ladder: a nudge is a fresh admission on the same
      // conversation, so it compacts before it asks. A cut answers with the rebuilt context, so
      // the request that NOTICED is already compacted; a failure throws, which pi turns into a
      // failed run and `prompt()` reports below as an infra fault. It touches no ADR-0035 counter:
      // the watch counts tool calls, the summarizer makes none, and a turn that compacts and
      // continues is still spending its one step budget.
      //
      // Then the abandoned trailing state, on whichever array will be sent. pi keeps an aborted
      // partial message in the session but REPLAYS none of it — its API layer drops any assistant
      // message whose stopReason is `aborted` from every later request, which is byte-for-byte the
      // flue defect ADR-0027 inverts (an abort mid-stream must NOT erase the assistant message).
      // So it settles at read time: an aborted message that carried real content re-enters the
      // context completed (pi synthesizes results for its orphaned tool calls); the empty
      // synthesized failure shells stay dropped. The rebuilt context needs the same pass — the
      // Session stores the aborted message verbatim, cut or no cut.
      harness.on("context", async ({ messages }) => {
        // A tripped watch (ADR-0035) already ended this turn, so there is nothing left to compact
        // FOR. pi does not agree yet: it has no signal check between a blocked tool batch and the
        // next request, so the loop takes one more pass through here — and the signal this seat
        // carries is the pump's, which a runaway trip never touches (the trip aborts pi's OWN
        // controller, and pi's `transformContext` wrapper drops the signal before the hook sees
        // it). Without this gate the cut would run a full summarization, on a full window, for a
        // request that is aborted before it is sent: real tokens and an unbounded wait — the very
        // liveness ADR-0035's watch exists to guarantee — plus a compaction entry and a
        // `[compacted]` line that make a killed turn read as a healthy one. Skipping beats
        // cancelling: there is no round-trip to cancel.
        const cut = watch.tripped
          ? undefined
          : await compactIfOver(
              {
                session,
                models: deps.models,
                model: current.model,
                thinkingLevel: current.thinkingLevel,
                settings: compactionSettingsFor(current.model, deps.keepRecentTokens),
                retry: summaryRetry,
                signal: current.signal,
              },
              messages,
            );
        if (cut) {
          printLines(out, deps.agentName, [
            renderCompaction(cut.tokensBefore, cut.tokensAfter, current.model.contextWindow),
          ]);
        }
        return { messages: settleCutPicks((cut?.messages ?? messages).map(settleAbandonedMessage)) };
      });
      // The runaway watch (ADR-0035): steps are the tool calls this Submission observed; K
      // consecutive byte-identical calls is the early exit, the step budget the unconditional
      // backstop. Identity is name + JSON arguments — pi hands the PARSED args, and stringify
      // keeps the wire's key order, so byte-identical provider frames compare equal. Tripping
      // ends the run: abort() is fire-and-forget — it awaits waitForIdle, which is parked on
      // this very hook, so awaiting would deadlock; and it REJECTS when a wind-down step throws
      // (see onAbort below). pi re-checks the run signal the moment this hook returns, so the
      // tripping call never executes; the block is the belt over that check, and it also answers
      // any parallel sibling calls in flight behind the trip.
      harness.on("tool_call", ({ toolName, input }) => {
        if (!watch.tripped) {
          watch.steps += 1;
          const signature = `${toolName} ${JSON.stringify(input)}`;
          watch.streak = signature === watch.signature ? watch.streak + 1 : 1;
          watch.signature = signature;
          if (watch.streak >= identicalCallLimit) {
            watch.tripped = `repeated an identical tool call ${identicalCallLimit} times`;
          } else if (watch.steps > stepBudget) {
            watch.tripped = `exceeded ${stepBudget} steps`;
          }
          if (!watch.tripped) return undefined;
          harness.abort().catch((err: unknown) => {
            console.error(`[${deps.agentName}] abort wind-down failed:`, err);
          });
        }
        return { block: true, reason: watch.tripped };
      });
      assembled = { harness, session, current };
    } else {
      assembled.current.definition = definition;
      assembled.current.model = model;
      assembled.current.thinkingLevel = thinkingLevel;
      assembled.current.signal = signal;
      const live = assembled.harness.getModel() as { provider: string; id: string };
      if (live.provider !== model.provider || live.id !== model.id) await assembled.harness.setModel(model);
      if (assembled.harness.getThinkingLevel() !== thinkingLevel) {
        await assembled.harness.setThinkingLevel(thinkingLevel);
      }
    }

    const harness = assembled.harness;
    // The Turn part below states this list: it is the first the model reads this Submission.
    told.heard(read.allowed);
    // The whole Menu, never the Allowed picks: the tools lead the provider's prefix cache, so they
    // are the same bytes on every Turn of the conversation (ADR-0029). What this Turn may pick is
    // said in the Turn part below, and enforced at delivery.
    const menu = seat ? read.menu.map((item) => cutWith(item, seat.cut)) : read.menu;
    const tools = [...workingToolsFor(definition, definition.cwd, { guard: deps.guard }), ...menuTools(menu)];
    // The active names go explicitly: without them setTools KEEPS the previous active set, which
    // is empty on a harness constructed with no tools — every tool would ride to pi inactive.
    await harness.setTools(
      tools,
      tools.map((tool) => tool.name),
    );

    // pi's abort() REJECTS when a wind-down step throws (queue flush, idle wait, a subscriber on
    // the abort event — e.g. an EPIPE from the printer during shutdown). Nothing awaits this
    // listener, so an uncaught rejection would take down the whole process — every conversation,
    // not just this Submission. Logged to the pod log instead; the settlement is the sweep's.
    const onAbort = () => {
      harness.abort().catch((err: unknown) => {
        console.error(`[${deps.agentName}] abort wind-down failed:`, err);
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted) throw new Error("swept before its turn started");
      // The Briefing's Turn part FOLLOWS the Frame's prompt (ADR-0062): the author's task reads
      // first, and the Allowed picks last, where a model obeys them (ADR-0029, measured).
      const answer = await harness.prompt(
        briefedPrompt(
          message,
          turnPart({
            workspace: definition.workspace,
            cwd: definition.cwd,
            allowed: read.allowed,
            toolName: menuToolName,
            ...(submission.notices ? { notices: submission.notices } : {}),
          }),
        ),
      );
      // The watch's SELF-abort (ADR-0035): pi resolved with stopReason `aborted`, but the pump's
      // signal never fired. Checked first so the runaway reason wins over the generic mapping
      // below; a sweep that raced the trip still settles `aborted` — the pump's own signal check
      // outranks any throw.
      if (watch.tripped) throw new RunawayError(watch.tripped);
      // pi 0.82 resolves prompt() even on abort/failure — the synthesized message carries the
      // outcome. Rejecting here is what lets the pump promote the next admission promptly.
      if (signal.aborted || answer.stopReason === "aborted") {
        throw new Error(answer.errorMessage ?? "the run aborted");
      }
      // A provider that still refused the load after pi's retries is NAMED (ADR-0064): the fixed
      // prefix `provider limit`, so the fault reason tells provider pressure from a bug.
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
 * then never returns. pi gets no result for it, writes none to the session, and asks the model
 * nothing more; the next process answers the call with jr2's text (`settleCutPicks`), and the
 * re-admission carries the answer.
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
 * dropping it (see the `context` hook above). Anything else passes through — including pi's
 * synthesized failure shells, whose only content is an empty text block. */
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
 * Answer every Menu call left with no result (ADR-0031): a restart of this Harness cut the Turn while
 * the call was out, and the rebuilt session ends in it. pi would answer it itself when it sends the
 * history — "No result provided", an error, which reads as a failed pick and invites a second one.
 * jr2's text says what happened instead: the pick reached the workflow, which does not run it twice,
 * and its answer comes in the next message (the re-admission's notice, ADR-0024). Placed before pi's
 * transform, so pi finds a result and adds none. A Working-tool call is pi's to answer.
 */
export function settleCutPicks(messages: AgentMessage[]): AgentMessage[] {
  const answered = new Set(
    messages.flatMap((m) =>
      (m as { role?: string }).role === "toolResult" ? [(m as ToolResultMessage).toolCallId] : [],
    ),
  );
  const out: AgentMessage[] = [];
  let open: ToolCall[] = [];
  const close = (): void => {
    for (const call of open) {
      if (answered.has(call.id) || !call.name.startsWith(MENU_TOOL_PREFIX)) continue;
      out.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: cutPickResult(call.name) }],
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage);
    }
    open = [];
  };
  for (const message of messages) {
    const role = (message as { role?: string }).role;
    if (role !== "toolResult") close();
    out.push(message);
    if (role === "assistant") {
      open = (message as AssistantMessage).content.filter((block): block is ToolCall => block.type === "toolCall");
    }
  }
  close();
  return out;
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
