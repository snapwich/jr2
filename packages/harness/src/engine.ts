// The engine seam (ADR-0027): what the Turn (`turn.ts`) needs from the engine that runs a model's
// requests and their tool calls. pi is the engine, not the contract: `pi-engine.ts` is the one
// adapter, and the one module that imports pi-agent-core. The Harness's choice of adapter is
// `engine-choice.ts`. The Turn gives the engine one Submission's run — the model, the level, the
// system prompt, the tools, the context and the prompt — and hears the run as events. The hooks
// below are the Turn's decisions inside a run (Compaction, the runaway watch, the provider's
// messages). How the engine carries the system prompt and the tools, how it queues a steer, and how
// it streams a request stay behind the seam.
//
// The messages, the tool declarations and the model registry are pi-ai's: that is the provider
// library (`provider.ts`), not the engine, and every engine sends its requests through it.
//
// Two facts of every run that the Turn depends on:
//
//   - The engine runs no tool call of a model answer that ended `error` or `aborted`, and makes no
//     request after it: that model answer is the run's last (`turn.ts`, `settleCutPicks` and the
//     step boundary).
//   - A run that a throw ends before a provider answers (from `beforeRequest` or from a listener)
//     still ends with an assistant message. Its `stopReason` is `error`, or `aborted` when the run
//     was aborted, and every usage number is 0 (`turn.ts`, `isFailureShell`).

import type {
  Api,
  ImageContent,
  Message,
  Model,
  Models,
  ModelThinkingLevel,
  Static,
  TextContent,
  Tool,
  ToolResultMessage,
  TSchema,
} from "@earendil-works/pi-ai";
import type { EngineSeat } from "./record.ts";
import type { EnginePart } from "./transcript.ts";

/** A Compaction's summary as the loop carries it (ADR-0036): the context's first message after a
 * cut. `convertToLlm` makes it the user message the model reads (`turn.ts`). */
export type CompactionSummaryMessage = {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
};

/** A message the loop carries: a provider message, or a Compaction's summary. */
export type EngineMessage = Message | CompactionSummaryMessage;

/** A tool's result: the content the model reads. */
export type EngineToolResult = { content: (TextContent | ImageContent)[] };

/**
 * A tool in the shape the engine runs: a Working tool or a Menu item. The declaration (`name`,
 * `description`, `parameters`) is what the model reads. `execute` gets the call's id (pi's
 * argument order; no jr2 tool reads it) and the validated arguments, and throws on failure: the
 * engine makes the throw the error result that the model reads. `prepareArguments` shapes the raw
 * arguments before the validation (`edit`'s legacy form).
 */
export interface EngineTool<P extends TSchema = TSchema> extends Tool<P> {
  prepareArguments?: (args: unknown) => Static<P>;
  execute: (toolCallId: string, params: Static<P>, signal?: AbortSignal) => Promise<EngineToolResult>;
}

/** What the engine tells its listeners, in the order it occurs. A model answer is one request's
 * assistant message; each of its tool calls is a step (GLOSSARY.md). */
export type EngineEvent =
  /** A message is complete: the prompt, a steer, a model answer, or a tool result. */
  | { type: "message_end"; message: EngineMessage }
  /** A model answer and every tool result of it are complete: the step boundary (GLOSSARY.md,
   * ADR-0029). A message that is steered here is the next request's newest message. */
  | { type: "step_boundary"; message: EngineMessage; toolResults: ToolResultMessage[] }
  | { type: "tool_start"; toolCallId: string }
  | { type: "tool_end"; toolCallId: string };

/** A listener gets the run's abort signal. The engine awaits each listener, in subscription order,
 * before it goes on; a listener that throws fails the run. */
export type EngineListener = (event: EngineEvent, signal: AbortSignal) => void | Promise<void>;

/** One Submission's run. */
export type EngineRun = {
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  /** The instructions and the Briefing's standing part. With the tools' declarations it leads each
   * request, and a changed one replaces the last one: it is never appended. */
  systemPrompt: string;
  tools: EngineTool[];
  /** The conversation so far, without the system prompt: the engine part's context. */
  context: EngineMessage[];
  prompt: string;
};

/** What `beforeToolCall` returns to block a call. */
export type ToolCallBlock = {
  /** The call does not run. Without `abortRun`, the model reads this text as the call's error
   * result. */
  block: string;
  /** Also abort the run, as `Engine.abort()` does: no other tool call and no other request. The
   * model then reads `Operation aborted` as the call's error result, not `block`. */
  abortRun?: true;
};

/** The Turn's decisions inside a run. Set once for each conversation; they read the Turn's own
 * per-Submission state. */
export type EngineHooks = {
  /** The messages the provider gets, from the loop's. It must not throw. */
  convertToLlm(messages: EngineMessage[]): Message[];
  /** Before each provider request, the first one included, after the pending messages are
   * complete. A context returned (without the system prompt) replaces the run's, for this request
   * and the next ones. A throw fails the run. */
  beforeRequest(signal: AbortSignal | undefined): Promise<EngineMessage[] | undefined>;
  /** Before each tool call, with the validated arguments. A block returned stops the call. It must
   * not throw. */
  beforeToolCall(call: { name: string; args: unknown }): ToolCallBlock | undefined;
  /** At each step boundary: true ends the run, with no steer and no other request. An aborted run
   * ends there too. It must not throw. */
  endsRun(): boolean;
};

/** What makes an engine for one conversation. */
export type EngineOptions = {
  /** The engine part's identity: a provider's prompt-cache key (pi-ai's `sessionId`). */
  id: string;
  /** The model registry each request streams through (`provider.ts`). */
  models: Models;
  /** The provider retries of each request (ADR-0016, ADR-0064). */
  maxRetries: number;
  hooks: EngineHooks;
};

/**
 * The engine of one conversation, made once and run once for each Submission. One run at a time.
 */
export interface Engine {
  /** Run one Submission. Nothing that was steered before this call reaches it. It resolves when
   * the run ends, also after a provider error or an abort: the outcome is on the last assistant
   * message (`message_end`). */
  run(run: EngineRun): Promise<void>;
  /** Queue a user message for the run's next request. */
  steer(text: string): void;
  /** Abort the run in flight: no other request, no other tool call. It does not throw, and it does
   * nothing when no run is in flight. */
  abort(): void;
  /** Returns the unsubscribe. */
  subscribe(listener: EngineListener): () => void;
}

/**
 * An engine adapter: it opens its engine part (ADR-0031) and makes its engine, for one
 * conversation. The part is jr2's transcript (`transcript.ts`), which the Turn and Compaction read
 * and write; the adapter chooses its directory under the conversation (`engine/<name>`), so a
 * Harness on another engine does not read this engine's part, and continues from the record.
 */
export type EngineAdapter = {
  /** The conversation's engine part: opened from `seat`, or new and seeded with the record's
   * history. `first` is the first Turn's: the transcript's header, and the identity a seeded
   * assistant message is written under. `say` is where a fallback is logged. */
  open(
    seat: EngineSeat | undefined,
    first: { cwd: string; model: Model<Api> },
    say?: (line: string) => void,
  ): EnginePart;
  make(options: EngineOptions): Engine;
};
