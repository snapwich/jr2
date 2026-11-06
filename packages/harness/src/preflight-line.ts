// The provider preflight's result lines (ADR-0019): what `provider-preflight.ts` writes, one per model, and
// what `jr2 up` reads off the check container's log. No import, so the CLI's test can load this
// file from beside it and hold its own parser to the same format.
//
//   jr2.preflight model=<specifier> start
//   jr2.preflight model=<specifier> ok
//   jr2.preflight model=<specifier> <fault|busy|warn>=<reason on one line>
//
// A `start` line comes before each model's check, so a reader of a pod that was stopped knows
// which model the check was on, and which it never reached.

/** How one model answered the check (`checkModel`): `ok` — it called the tool; `fault` — the
 * converge fails; `busy` — the provider refused the load after the retries, and so answered with
 * the key (ADR-0064); `warn` — it answered but did not call a tool it was not forced to call. */
export type PreflightVerdict = { kind: "ok" } | { kind: "fault" | "busy" | "warn"; reason: string };

export const PREFLIGHT_PREFIX = "jr2.preflight";

/** One result line. The reason goes on one line: the reader splits on newlines. */
export function preflightLine(specifier: string, verdict: PreflightVerdict): string {
  const said = verdict.kind === "ok" ? "ok" : `${verdict.kind}=${verdict.reason.replace(/\s+/g, " ").trim()}`;
  return `${PREFLIGHT_PREFIX} model=${specifier} ${said}`;
}

/** The line before a model's check. */
export function preflightStart(specifier: string): string {
  return `${PREFLIGHT_PREFIX} model=${specifier} start`;
}

/** Each model's whole budget in the check, in seconds: up to two calls, each up to 120 s to its
 * first event and 60 s of the gaps that follow. `provider-preflight.ts` stops a model at it, and
 * `jr2 up` gives the pod as long for each model; the CLI's test holds its own number to this one. */
export const PREFLIGHT_MODEL_BUDGET_SECONDS = 360;

// The MCP check's lines (ADR-0079), after the models' lines, one server at a time:
//
//   jr2.preflight mcp=<server> start
//   jr2.preflight mcp=<server> listed=<JSON list of the tool names, sorted>
//   jr2.preflight mcp=<server> <refused|warn|fault>=<reason on one line>
//
// `refused` is the server's 401 or 403 (the reason is the status); `warn` is a server that did not
// answer as MCP; `fault` is a check this Harness cannot make. `jr2 up` compares each list with the
// allowlists: the pod does not know which Agent lists which tool.

/** How one server answered the MCP check. */
export type McpPreflightVerdict =
  | { kind: "listed"; tools: string[] }
  | { kind: "refused" | "warn" | "fault"; reason: string };

/** One MCP result line. A list is JSON on one line; a reason goes on one line. */
export function mcpPreflightLine(server: string, verdict: McpPreflightVerdict): string {
  const said =
    verdict.kind === "listed"
      ? `listed=${JSON.stringify(verdict.tools)}`
      : `${verdict.kind}=${verdict.reason.replace(/\s+/g, " ").trim()}`;
  return `${PREFLIGHT_PREFIX} mcp=${server} ${said}`;
}

/** The line before a server's check. */
export function mcpPreflightStart(server: string): string {
  return `${PREFLIGHT_PREFIX} mcp=${server} start`;
}

/** Each MCP server's whole budget in the check, in seconds: every request of its listing. The check
 * stops a server at it, and `jr2 up` gives the pod as long for each server; the CLI's test holds
 * its own number (`CHECK_MCP_SECONDS`) to this one. */
export const PREFLIGHT_MCP_BUDGET_SECONDS = 60;

/** The argv word that comes before the MCP servers to check: no model specifier is this. */
export const PREFLIGHT_MCP_ARG = "--mcp";
