// The Turn (ADR-0027): one Submission's execution — the `runSubmission` a Conversation pumps.
// Per Submission the definition is read off the ADMISSION that queued it (ADR-0049: the Agent
// definition rides the Turn; model, instructions and thinkingLevel resolve when the turn starts,
// with the Frame's cwd beside them — ADR-0057 — so a later Submission on the same conversation may
// carry a retuned one and a different worktree), a FRESH MCP client fetches the Menu from the
// Adapter (the previous turn's connection closes deterministically — the leak is bounded to
// one), and the same pi session carries the conversation: a later Submission is the next
// `prompt()` on the same AgentHarness. Settlement mapping: a throw settles `failed` (the Menu
// connect/list, or a provider failure after pi's retries — pi RESOLVES `prompt()` even then,
// with the outcome on the message's `stopReason`, so this module inspects and throws); the
// signal aborts pi's run, and the prompt winding down rejects promptly so the pump can promote.

import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentMessage,
  type ExecutionToolContext,
  type Session,
  type ThinkingLevel as PiThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, AssistantMessage, Model, Models, UserMessage } from "@earendil-works/pi-ai";
import { compactIfOver, compactionSettingsFor, summaryRetryPolicy } from "./compaction.ts";
import { RunawayError, type RunSubmission } from "./conversation.ts";
import { connectMenu, type Menu } from "./menu.ts";
import { attachPrinter, printLines, renderCompaction, type PrinterOut } from "./printer.ts";
import { mapThinkingLevel, resolveModel } from "./provider.ts";
import { resolveDefinition, type ResolvedDefinition } from "./spec.ts";
import type { HistoryMessage } from "./wire.ts";
import { workingToolsFor } from "./working-tools.ts";

/** What one conversation's turn loop needs. `appendMessage` is the Conversation's stream seam —
 * completed messages land on the durable stream and the history view through it. */
export type TurnDeps = {
  /** The model registry (`provider.ts` — pi's catalog + the instance's custom provider). */
  models: Models;
  /** The Adapter on `localhost` — `$JR2_ADAPTER_URL`; the Menu lives at `/mcp/<iid>` (ADR-0013). */
  adapterUrl: string;
  agentName: string;
  instanceId: string;
  appendMessage: (message: HistoryMessage) => void;
  /** Provider-stream retry attempts — the seat ADR-0016 delegated to flue's `durability{}`,
   * re-owned as pi's `maxRetries`. Omitted → pi's default. */
  maxRetries?: number;
  /** Where the conversation prints (ADR-0023). Default `process.stdout` (the pod log). */
  printerOut?: PrinterOut;
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
  const repo = new InMemorySessionRepo();
  let assembled: Assembled | undefined;
  /** The previous turn's Menu connection — closed when the next turn assembles, whatever state
   * that turn ended in. */
  let menu: Menu | undefined;
  const stepBudget = deps.stepBudget ?? STEP_BUDGET;
  const identicalCallLimit = deps.identicalCallLimit ?? IDENTICAL_CALL_LIMIT;
  /** The `context` hook writes the Compaction line itself (there is no pi event to subscribe to),
   * so the printer's destination is resolved once here rather than only inside `attachPrinter`. */
  const out = deps.printerOut ?? process.stdout;
  const summaryRetry = summaryRetryPolicy(deps.maxRetries);
  /** The runaway watch (ADR-0035), per Submission — reset when each turn starts. The
   * once-per-conversation `tool_call` hook reads it through this seat, like `current.definition`. */
  const watch = { steps: 0, streak: 0, signature: "", tripped: "" };

  return async (submission, signal) => {
    const { message } = submission;
    // Each Submission earns a fresh runaway budget (ADR-0035) — the watch is per-turn state.
    watch.steps = 0;
    watch.streak = 0;
    watch.signature = "";
    watch.tripped = "";
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

    await menu?.close();
    menu = undefined;
    // A turn that cannot see its Menu settles `failed` — the throw propagates to the pump. The
    // signal rides along so an abort landing mid connect/list cancels it: promotion of the next
    // admission (the ADR-0024 hot path) must not park behind the MCP SDK's request timeout.
    menu = await connectMenu(deps.adapterUrl, deps.instanceId, signal);

    if (!assembled) {
      const current = { definition, model, thinkingLevel, signal };
      // Held, not inlined: Compaction appends its entry to THIS session (ADR-0036), and
      // `AgentHarness` exposes no accessor for the one it was given.
      const session = await repo.create();
      const harness = new AgentHarness<ExecutionToolContext>({
        session,
        models: deps.models,
        model,
        thinkingLevel,
        systemPrompt: () => current.definition.instructions,
        toolContext: () => ({ env: new NodeExecutionEnv({ cwd: current.definition.cwd }) }),
        ...(deps.maxRetries === undefined ? {} : { streamOptions: { maxRetries: deps.maxRetries } }),
      });
      // Once per conversation — the subscriptions survive across Submissions; re-attaching per
      // Submission would duplicate every line and every stream event.
      attachPrinter(harness, deps.agentName, out);
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
        return { messages: (cut?.messages ?? messages).map(settleAbandonedMessage) };
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
    const tools = [...workingToolsFor(definition, definition.cwd), ...menu.tools];
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
      const answer = await harness.prompt(message);
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
      if (answer.stopReason === "error") {
        throw new Error(answer.errorMessage ?? "provider failure");
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
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
