// An Agent's MCP tools, presented to the engine (ADR-0079): each tool of the conversation's list as
// an `EngineTool`, as `menu-tools.ts` presents the Menu. The declaration is the server's own name,
// description and input schema, under `mcp__<server>__<tool>`. The client is `mcp.ts`; this module
// is the only part of the MCP path that knows the engine's tool shape.
//
// An MCP tool is not a pick (ADR-0079, ADR-0062): its name has a server that is not `jr2`, so the
// Turn's pick rules (`MENU_TOOL_PREFIX`, turn.ts) do not apply to it, and a call of one does not
// end the Turn.

import type { TSchema } from "typebox";
import type { EngineTool } from "./engine.ts";
import type { McpConversation } from "./mcp.ts";
import type { RecordedMcpTool } from "./record.ts";
import { strictArguments } from "./strict-arguments.ts";

/**
 * The conversation's MCP tools as engine tools, in the record's order. `execute` returns the
 * result's text and images, and throws with jr2's text or the server's for an error result: the engine makes
 * the throw the error result that the model reads (the seam's contract). The arguments are checked
 * as the model wrote them, before pi's coercion (`strict-arguments.ts`, ADR-0027): the server gets
 * what the model wrote, or the model reads a refusal.
 */
export function mcpTools(conversation: McpConversation, tools: readonly RecordedMcpTool[]): EngineTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as unknown as TSchema,
    prepareArguments: strictArguments(tool.name, tool.inputSchema),
    execute: async (_toolCallId, params, signal) => {
      const result = await conversation.call(
        tool,
        (params ?? {}) as Record<string, unknown>,
        signal ?? new AbortController().signal,
      );
      if (result.isError) throw new Error(result.text);
      const images = (result.images ?? []).map((image) => ({ type: "image" as const, ...image }));
      const text = result.text === "" && images.length > 0 ? [] : [{ type: "text" as const, text: result.text }];
      return { content: [...text, ...images] };
    },
  }));
}
