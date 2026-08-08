// The Turn (ADR-0027): one Submission's execution — the `runSubmission` a Conversation pumps.
// Per Submission the definition is re-read from the mounted spec (model, instructions, cwd,
// thinkingLevel resolve when the turn starts), a FRESH MCP client fetches the Menu from the
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
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage, Models, UserMessage } from "@earendil-works/pi-ai";
import { RunawayError, type RunSubmission } from "./conversation.ts";
import { connectMenu, type Menu } from "./menu.ts";
import { attachPrinter, type PrinterOut } from "./printer.ts";
import { mapThinkingLevel, resolveModel } from "./provider.ts";
import { resolveDefinition, type AgentsSpec, type ResolvedDefinition } from "./spec.ts";
import type { HistoryMessage } from "./wire.ts";
import { workingToolsFor } from "./working-tools.ts";

/** What one conversation's turn loop needs. `appendMessage` is the Conversation's stream seam —
 * completed messages land on the durable stream and the history view through it. */
export type TurnDeps = {
  spec: AgentsSpec;
  /** The model registry (`provider.ts` — pi's catalog + the instance's custom provider). */
  models: Models;
  /** The Adapter on `localhost` — `$J2_ADAPTER_URL`; the Menu lives at `/mcp/<iid>` (ADR-0013). */
  adapterUrl: string;
  agentName: string;
  instanceId: string;
  appendMessage: (message: HistoryMessage) => void;
  /** Provider-stream retry attempts — the seat ADR-0016 delegated to flue's `durability{}`,
   * re-owned as pi's `maxRetries`. Omitted → pi's default. */
  maxRetries?: number;
  /** Where the conversation prints (ADR-0023). Default `process.stdout` (the pod log). */
  printerOut?: PrinterOut;
  /** ADR-0035's runaway bounds — j2-owned defaulted knobs (ADR-0016), no author surface. These
   * seams exist for the conformance suite alone, which cannot afford 128 provider rounds. */
  stepBudget?: number;
  identicalCallLimit?: number;
};

/** The step budget (ADR-0035): the unconditional backstop on tool calls per Submission. Healthy
 * turns peaked at 53 on a trivial task, and an honest live bug-hunt burned 161 steps — the bound
 * sits above real investigation. It bounds STEPS, not context: a long turn can still exhaust its
 * window first (compaction's seat, not this one). */
const STEP_BUDGET = 256;
/** K consecutive byte-identical tool calls (same name, same JSON arguments) — the early exit.
 * Healthy max observed: 2. */
const IDENTICAL_CALL_LIMIT = 4;

/** The conversation's assembled runtime: one AgentHarness on one pi session, plus the seat the
 * lazy `systemPrompt`/`toolContext` callbacks read — so each turn works from the definition
 * resolved at ITS start, on a harness constructed once. */
type Assembled = {
  harness: AgentHarness<ExecutionToolContext>;
  current: { definition: ResolvedDefinition };
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
    // This Submission's dials layer over the definition (ADR-0018). Read HERE, per
    // Submission, so one `continue` conversation can queue turns at different settings — the
    // `setModel`/`setThinkingLevel` reconciliation below already handles the change.
    const definition = resolveDefinition(deps.spec, deps.agentName, submission);
    const model = resolveModel(deps.models, definition.model);
    const thinkingLevel = definition.thinkingLevel ? mapThinkingLevel(definition.thinkingLevel) : "off";

    await menu?.close();
    menu = undefined;
    // A turn that cannot see its Menu settles `failed` — the throw propagates to the pump. The
    // signal rides along so an abort landing mid connect/list cancels it: promotion of the next
    // admission (the ADR-0024 hot path) must not park behind the MCP SDK's request timeout.
    menu = await connectMenu(deps.adapterUrl, deps.instanceId, signal);

    if (!assembled) {
      const current = { definition };
      const harness = new AgentHarness<ExecutionToolContext>({
        session: await repo.create(),
        models: deps.models,
        model,
        thinkingLevel,
        systemPrompt: () => current.definition.instructions,
        toolContext: () => ({ env: new NodeExecutionEnv({ cwd: current.definition.cwd }) }),
        ...(deps.maxRetries === undefined ? {} : { streamOptions: { maxRetries: deps.maxRetries } }),
      });
      // Once per conversation — the subscriptions survive across Submissions; re-attaching per
      // Submission would duplicate every line and every stream event.
      attachPrinter(harness, deps.agentName, deps.printerOut);
      harness.subscribe((event) => {
        if (event.type !== "message_end") return;
        const entry = historyMessage(event.message);
        if (entry) deps.appendMessage(entry);
      });
      // pi keeps an aborted partial message in the session but REPLAYS none of it — its API layer
      // drops any assistant message whose stopReason is `aborted` from every later request, which
      // is byte-for-byte the flue defect ADR-0027 inverts (an abort mid-stream must NOT erase the
      // assistant message). So the abandoned trailing state settles at read time: an aborted
      // message that carried real content re-enters the context completed (pi synthesizes results
      // for its orphaned tool calls); the empty synthesized failure shells stay dropped.
      harness.on("context", ({ messages }) => ({ messages: messages.map(settleAbandonedMessage) }));
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
      assembled = { harness, current };
    } else {
      assembled.current.definition = definition;
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
