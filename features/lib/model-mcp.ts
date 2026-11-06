// The `mcp-then-pick` claim's reading (ADR-0079, ADR-0066), pure so a unit test pins it without a
// cluster or a model. The measure is the order of the Agent's calls in its printed conversation:
// the MCP call (`<server>/<tool>`, ADR-0023), then a pick. A model that picks before it calls the
// tool did not use the tool's answer. A model that stops after the tool, so that jr2 asks it again
// (a nudge, ADR-0016), read the MCP call as the end of its Turn: that is the miss the Briefing's
// line is there to prevent (ADR-0062).

import { isNudge, type Said } from "./model-said.ts";

/** What one trial's conversation says about the claim. */
export type McpThenPick = {
  /** The MCP call came first, and a pick followed it with no ask between. */
  measured: boolean;
  /** The first pick, if any. */
  pick?: string;
  /** Why, in a few words, for the trial's note. */
  why: string;
};

export function readMcpThenPick(said: readonly Said[], mcpCall: string, menu: ReadonlySet<string>): McpThenPick {
  let called = false;
  for (const s of said) {
    if ("prompt" in s) {
      if (called && isNudge(s)) return { measured: false, why: "stopped after the MCP call, and was asked again" };
      continue;
    }
    if (s.call === mcpCall) called = true;
    else if (menu.has(s.call)) {
      return called
        ? { measured: true, pick: s.call, why: `the MCP call, then the pick ${s.call}` }
        : { measured: false, pick: s.call, why: `picked ${s.call} before it called the MCP tool` };
    }
  }
  return { measured: false, why: called ? "no pick after the MCP call" : "never called the MCP tool, and no pick" };
}
