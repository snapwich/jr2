// Instance-ID addressing: one MCP endpoint per run, multiplexed by the Instance ID in the URL
// path (ADR-0002/0005). The Agent connects to `mcpPath(instanceId)`; every tool call it makes
// arrives path-routed to the Actor that owns that instance. No shared session across runs.
//
// Pure routing rule only — host/port/scheme are Orchestrator config and do not belong here.

export const MCP_PATH_PREFIX = "/mcp";

/** The path an Agent's MCP client connects to for the given run. */
export function mcpPath(instanceId: string): string {
  return `${MCP_PATH_PREFIX}/${encodeURIComponent(instanceId)}`;
}
