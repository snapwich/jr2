// The engine jr2 runs today: pi (ADR-0027). pi is the ENGINE, not the contract — jr2's record
// (`record.ts`), the seam's shapes (`engine.ts`) and the transcript (`transcript.ts`) are the
// contract — so everything that knows pi lives here, and this is the one module that imports
// pi-agent-core. `piAdapter` is the seam's adapter: pi-agent-core's `Agent` loop, its tool hooks,
// its abort and its steering queue, behind `Engine`. It makes the leading system message that
// carries the system prompt and the tools, which is how pi 1.x carries them. pi 1.x keeps no
// conversation, so the adapter's engine part is jr2's transcript, under `engine/pi`.

import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration, type SystemMessage } from "@earendil-works/pi-ai";
import type {
  CompactionSummaryMessage,
  Engine,
  EngineAdapter,
  EngineEvent,
  EngineOptions,
  EngineTool,
} from "./engine.ts";
import { openEnginePart } from "./transcript.ts";

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    compactionSummary: CompactionSummaryMessage;
  }
}

/** The engine's name: its directory under the conversation (`engine/pi`). */
const ENGINE = "pi";

/** pi as the seam's adapter: its engine part is the transcript under `engine/pi`. */
export const piAdapter: EngineAdapter = {
  open: (seat, first, say) => openEnginePart(seat, ENGINE, first, say),
  make: (options) => piEngine(options),
};

/**
 * The seam's adapter (`engine.ts`): one pi `Agent` for one conversation, made once. For each run
 * it sets the model, the level and the tools, and puts the leading system message before the
 * context. pi compares the declarations in that message with the tools it runs before each request
 * (`declareToolChanges`); they are equal, so pi adds no system message of its own.
 *
 * The seam's messages are pi-ai's, with the Compaction summary merged into `CustomAgentMessages`
 * above, so the adapter passes them through without a copy; the compiler checks each direction
 * where they cross. A seam tool becomes a pi tool here (`agentTool`).
 */
function piEngine(options: EngineOptions): Engine {
  const { hooks, models, maxRetries } = options;
  /** The leading system message of this run's context: the system prompt and the tools'
   * declarations, in order. It is never in the engine part, so a changed prompt or tools block
   * REPLACES it, as a system prompt is replaced. */
  let lead: SystemMessage | undefined;
  const agent: Agent = new Agent({
    // The transcript's identity rides as pi-ai's `sessionId` (a prompt-cache key).
    sessionId: options.id,
    // jr2 is not pi: no attribution headers on its requests.
    identity: { attribution: null },
    // pi's `Agent` does not forward `maxRetries`, so the stream states it.
    streamFn: (streamModel, context, streamOptions) =>
      models.streamSimple(streamModel, context, { ...streamOptions, maxRetries }),
    convertToLlm: (messages) => hooks.convertToLlm(messages),
    // Before EVERY provider request, the first one included: pi has appended and emitted the
    // pending messages. A context returned is what pi uses for this request and the rest of the
    // run; a throw is a failed run.
    prepareRequest: async (request, signal) => {
      const messages = await hooks.beforeRequest(signal);
      if (!messages) return undefined;
      return { context: { messages: lead ? [lead, ...messages] : messages, tools: request.context.tools ?? [] } };
    },
    // pi hands the VALIDATED args. A block's text is the error result the model reads. A block
    // that also aborts the run (the runaway watch) aborts it HERE, before pi checks the signal the
    // moment this hook returns: pi then answers the call `Operation aborted` (`ToolCallBlock`).
    beforeToolCall: async ({ toolCall, args }) => {
      const verdict = hooks.beforeToolCall({ name: toolCall.name, args });
      if (verdict === undefined) return undefined;
      if (verdict.abortRun) agent.abort();
      return { block: true, reason: verdict.block };
    },
    // `{ action: "end" }` ends the run before pi polls the steering queue or makes a request.
    finishTurn: (_turn, signal) => (hooks.endsRun() || signal?.aborted ? { action: "end" } : undefined),
  });
  return {
    async run(run) {
      lead = createInitialSystemMessage(run.systemPrompt, run.tools.map(toToolDeclaration));
      agent.state.model = run.model;
      agent.state.thinkingLevel = run.thinkingLevel;
      agent.state.tools = run.tools.map(agentTool);
      agent.state.messages = lead ? [lead, ...run.context] : run.context;
      // pi's `abort()` does not clear the queues.
      agent.clearAllQueues();
      await agent.prompt(run.prompt);
    },
    steer(text) {
      // The shape pi 0.82's `createUserMessage` made.
      agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
    },
    abort() {
      agent.abort();
    },
    subscribe(listener) {
      return agent.subscribe((event, signal) => {
        const seen = engineEvent(event);
        return seen ? listener(seen, signal) : undefined;
      });
    },
  };
}

/** A seam tool as pi runs it. pi wants a `label` (for a UI; it reads none) and a result's `details`,
 * which no model reads: the label is the name, and the result has no details. pi's `onUpdate` (the
 * partial results of a running call) is not passed on: no seam event carries one. */
function agentTool(tool: EngineTool): AgentTool {
  return {
    ...tool,
    label: tool.name,
    execute: async (toolCallId, params, signal) => ({
      content: (await tool.execute(toolCallId, params, signal)).content,
      details: undefined,
    }),
  };
}

/** A pi event as the seam names it, or none: the seam has no use for the others. pi's `turn_end`
 * (one model answer and its tool results) is the seam's `step_boundary`. */
export function engineEvent(event: AgentEvent): EngineEvent | undefined {
  switch (event.type) {
    case "message_end":
      return { type: "message_end", message: event.message };
    case "turn_end":
      return { type: "step_boundary", message: event.message, toolResults: event.toolResults };
    case "tool_execution_start":
      return { type: "tool_start", toolCallId: event.toolCallId };
    case "tool_execution_end":
      return { type: "tool_end", toolCallId: event.toolCallId };
    default:
      return undefined;
  }
}
