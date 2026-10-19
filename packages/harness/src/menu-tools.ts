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
  return `${MENU_TOOL_PREFIX}${name}`;
}

/** The prefix every Menu tool's name carries — what tells a Menu call from a Working-tool call in a
 * conversation the history settles (`settleCutPicks`, turn.ts). */
export const MENU_TOOL_PREFIX = "mcp__jr2__";

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
    prepareArguments: (args) => parsedObjectArguments(args, item.parameters),
    execute: async (_toolCallId, params, signal) => ({
      content: [{ type: "text", text: await item.pick(params, signal) }],
      details: undefined,
    }),
  }));
}

/**
 * A model's argument that is a JSON text where the pick's schema declares an object is that
 * value (ADR-0029): pi validates the result against the parameters as it would have, and the
 * Orchestrator validates the pick again at delivery, so nothing is accepted that the schema would
 * not. Measured: a 35B model writes a Chart, the first Menu parameter of any size, as a string in
 * about one call of three, and read "chart: must be object" for it. Anything else passes through
 * untouched: a string that is not JSON, or not an object, is still the model's and still refused.
 */
export function parsedObjectArguments(args: unknown, parameters: Record<string, unknown>): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const properties = (parameters.properties ?? {}) as Record<string, { type?: unknown }>;
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value !== "string" || properties[key]?.type !== "object") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    out ??= { ...(args as Record<string, unknown>) };
    out[key] = parsed;
  }
  return out ?? args;
}
