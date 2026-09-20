// The Menu, fetched (ADR-0013/0027): one Submission's MCP connection to the Adapter, and the
// current turn's Menu wrapped as pi `AgentTool`s. Each Submission connects FRESH to
// `$JR2_ADAPTER_URL/mcp/<iid>` and lists — the iid in the URL is how the Adapter knows which turn
// is live, so the menu is exactly what the invoking Machine state derived, with no push channel
// and no turn index (ADR-0013's enabling fact, now explicit code). Tools surface to the model as
// `mcp__jr2__<name>` — shipped instructions and the printer's prefix-stripping depend on it.
// An empty menu is valid (ADR-0026: a turn that is over has an empty menu): zero tools, no error.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";

/** One turn's Menu: the wrapped tools, and the connection they call through. `close` is
 * idempotent — turn.ts closes the previous turn's connection deterministically, whatever state
 * that turn ended in. */
export type Menu = {
  tools: AgentTool[];
  close(): Promise<void>;
};

/** What one MCP content item contributes to the flattened tool-result text. */
type McpContentItem = { type: string; text?: string };

/** flue's sanitization, reproduced: the model-facing name admits `[A-Za-z0-9_-]` only. */
function sanitizeToolNamePart(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** MCP result content → one text: text items concatenated, non-text items noted by type. */
function flattenContent(content: McpContentItem[]): string {
  return content.map((item) => (item.type === "text" ? (item.text ?? "") : `[${item.type} content]`)).join("\n");
}

/**
 * Connect to the Adapter and list this turn's Menu.
 *
 * Minted iids are hierarchical (slashes — ADR-0015); the Adapter's route is ONE path segment, so
 * the id travels encoded. Connect/list failures propagate: a turn that cannot see its Menu settles
 * `failed` (ADR-0027), and turn.ts owns that mapping. The Submission's `signal` cancels a connect
 * or list in flight — an abort must promote the next admission promptly (ADR-0024), not wait out
 * the MCP SDK's request timeout.
 *
 * Each wrapped tool's `execute` forwards to `tools/call`. It THROWS on both an MCP `isError`
 * result and a transport/server error — pi's contract ("throw on failure instead of encoding
 * errors in content") turns the thrown message into the isError tool result the model reads.
 */
export async function connectMenu(adapterUrl: string, instanceId: string, signal?: AbortSignal): Promise<Menu> {
  const client = new Client({ name: "jr2-harness", version: "0.0.0" });
  const options = signal ? { signal } : undefined;

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${adapterUrl}/mcp/${encodeURIComponent(instanceId)}`)),
      options,
    );
    const tools: AgentTool[] = [];
    // The Adapter serves one page today; follow cursors anyway, guarding against a repeat — an
    // unknown server must not be able to park the turn in a pagination loop.
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, options);
      for (const tool of page.tools) {
        tools.push({
          name: `mcp__jr2__${sanitizeToolNamePart(tool.name)}`,
          label: tool.name,
          description: tool.description ?? "",
          // The MCP input schema IS JSON Schema, which is what a TSchema is at runtime — pass it
          // through as the advertised signature; the Orchestrator re-validates on delivery anyway.
          parameters: tool.inputSchema as unknown as TSchema,
          execute: async (_toolCallId, params, signal) => {
            const result = await client.callTool(
              { name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
              undefined,
              signal ? { signal } : undefined,
            );
            const text = flattenContent((result.content ?? []) as McpContentItem[]);
            if (result.isError) {
              throw new Error(text || `tool "${tool.name}" answered an error with no content`);
            }
            return { content: [{ type: "text", text }], details: undefined };
          },
        });
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor !== undefined && seen.has(cursor)) break;
      if (cursor !== undefined) seen.add(cursor);
    } while (cursor !== undefined);

    let closed = false;
    return {
      tools,
      close: async () => {
        if (closed) return;
        closed = true;
        await client.close();
      },
    };
  } catch (err) {
    // A menu that failed to connect or list leaves no dangling connection behind the thrown error.
    await client.close().catch(() => {});
    throw err;
  }
}
