// The Menu, presented to the engine (ADR-0013/0027): each item as an `EngineTool`, handed to the
// model by this process, with no MCP between them.
//
// The presenter's whole job (ADR-0029): map each Menu item to the engine's tool shape, and name it.
// The words the model reads about picks — the Allowed picks, receipts, refusals — are `menu.ts`'s;
// this module only hands `menu.ts` its naming.
//
// Tools surface to the model as `mcp__jr2__<name>`: a NAME, kept because shipped instructions and
// the printer's prefix-stripping depend on it, not a transport. The prefix lives here, not in the
// Menu, because it is how the model sees the Menu: an MCP client names a server's tools
// `mcp__<server>__<name>` itself, so a Menu served over MCP as `jr2` gets the same names.

import type { TSchema } from "@earendil-works/pi-ai";
import type { EngineTool } from "./engine.ts";
import type { Menu } from "./menu.ts";

/** The name the model sees for a Menu item. Handed to `menu.ts` too (`MenuOptions.toolName`), so
 * the Allowed-picks text and every receipt name the tool the model can actually call (ADR-0029). */
export function menuToolName(name: string): string {
  return `${MENU_TOOL_PREFIX}${name}`;
}

/** The prefix every Menu tool's name carries — what tells a Menu call from a Working-tool call in a
 * conversation the history settles (`settleCutPicks`, turn.ts). */
export const MENU_TOOL_PREFIX = "mcp__jr2__";

/**
 * The Menu's items as engine tools. `execute` throws on every failure, as the item's `pick` does —
 * the seam's contract (the engine makes a throw the error result) turns the message into the error
 * result the model reads, so it can pick again or differently.
 */
export function menuTools(menu: Menu): EngineTool[] {
  return menu.map((item) => ({
    name: menuToolName(item.name),
    description: item.description,
    parameters: item.parameters as unknown as TSchema,
    execute: async (_toolCallId, params, signal) => ({
      content: [{ type: "text", text: await item.pick(params, signal) }],
    }),
  }));
}
