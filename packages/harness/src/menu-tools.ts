// The Menu, presented to pi (ADR-0013/0027): each item as an `AgentTool`, handed to the model by
// this process, with no MCP between them.
//
// The presenter's whole job (ADR-0029): map each Menu item to pi's tool API, and name it. The words
// the model reads about picks — the Allowed picks, receipts, refusals — are `menu.ts`'s; this module
// only hands `menu.ts` its naming.
//
// Tools surface to the model as `mcp__jr2__<name>`: a NAME, kept because shipped instructions and
// the printer's prefix-stripping depend on it, not a transport. The prefix lives here, not in the
// Menu, because it is how pi's model sees the Menu: an MCP client names a server's tools
// `mcp__<server>__<name>` itself, so a Menu served over MCP as `jr2` gets the same names.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import type { Menu } from "./menu.ts";

/** The name pi's model sees for a Menu item. Handed to `menu.ts` too (`MenuOptions.toolName`), so
 * the Allowed-picks text and every receipt name the tool the model can actually call (ADR-0029). */
export function menuToolName(name: string): string {
  return `mcp__jr2__${name}`;
}

/**
 * The Menu's items as pi tools. `execute` throws on every failure, as the item's `pick` does — pi's
 * contract ("throw on failure instead of encoding errors in content") turns the message into the
 * error result the model reads, so it can pick again or differently.
 */
export function menuTools(menu: Menu): AgentTool[] {
  return menu.map((item) => ({
    name: menuToolName(item.name),
    label: item.event,
    description: item.description,
    parameters: item.parameters as unknown as TSchema,
    execute: async (_toolCallId, params, signal) => ({
      content: [{ type: "text", text: await item.pick(params, signal) }],
      details: undefined,
    }),
  }));
}
