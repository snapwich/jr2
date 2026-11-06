// The tool list of one remote MCP server, for the provider preflight's check (ADR-0019, ADR-0079):
// `provider-preflight.ts` runs this in the check pod, with the Stand-in of the server's secret as
// the bearer. The pod's proxy sends the request through its Custodian, which swaps the Stand-in for
// the value toward the bound host, as it does for a Turn. So the check takes the path that a Turn
// takes, and the value never reaches this process.
//
// The client is the least of MCP that `tools/list` needs, over Streamable HTTP at protocol
// 2025-11-25: `initialize`, `notifications/initialized`, then `tools/list` page by page. An answer is
// JSON or an event stream; both are read. No redirect is followed. The fetch is injected, so a test
// serves a fake server in-process.

/** A `fetch`, injected for a test. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The MCP protocol revision jr2's clients speak (ADR-0079). */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

/** How long one request of the listing waits for its answer. */
const STEP_TIMEOUT_MS = 10_000;

/** At most this many `tools/list` pages: a server that never stops paging is not listed. */
const MAX_PAGES = 50;

/** What one server's listing came to: its tool names, sorted; a refusal of the credential (401,
 * 403); or no answer that is MCP. */
export type McpListing =
  | { kind: "listed"; tools: string[] }
  | { kind: "refused"; status: number }
  | { kind: "no-answer"; why: string };

/** A failed step of the conversation: the server answered, but not as MCP. */
class NotMcp extends Error {}

/**
 * List one server's tools (ADR-0079). `bearer` is sent as `Authorization: Bearer` — in the check
 * pod, the Stand-in of the server's secret; absent, no credential is sent. `signal` ends the whole
 * listing (the server's budget in the check).
 */
export async function listMcpTools(
  url: string,
  bearer: string | undefined,
  opts: { fetch?: FetchLike; signal?: AbortSignal; stepTimeoutMs?: number; clientVersion?: string } = {},
): Promise<McpListing> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const stepTimeoutMs = opts.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  const signal = () =>
    opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(stepTimeoutMs)])
      : AbortSignal.timeout(stepTimeoutMs);
  const auth: Record<string, string> = bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {};
  let session: string | undefined;
  let version = MCP_PROTOCOL_VERSION;
  let id = 0;
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...auth,
    ...(session !== undefined ? { "mcp-session-id": session } : {}),
    ...(id > 1 ? { "mcp-protocol-version": version } : {}),
  });
  const post = async (body: Record<string, unknown>): Promise<Response> =>
    await fetchImpl(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      redirect: "manual",
      signal: signal(),
    });
  /** One request and its answer's `result`, or the listing that ends the conversation. */
  const call = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | McpListing> => {
    const requestId = ++id;
    const res = await post({ jsonrpc: "2.0", id: requestId, method, params });
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      return { kind: "refused", status: res.status };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new NotMcp(`${method} answered HTTP ${res.status}`);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) session = sid;
    const message = await answerTo(res, requestId);
    if (message.error !== undefined) {
      const error = message.error as { code?: unknown; message?: unknown };
      throw new NotMcp(`${method} answered the error ${String(error.code)}: ${String(error.message)}`);
    }
    if (typeof message.result !== "object" || message.result === null) {
      throw new NotMcp(`${method} answered no result`);
    }
    return message.result as Record<string, unknown>;
  };
  try {
    const init = await call("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "jr2", version: opts.clientVersion ?? "0" },
    });
    if ("kind" in init) return init as McpListing;
    if (typeof init.protocolVersion === "string") version = init.protocolVersion;
    const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    await note.body?.cancel().catch(() => {});
    if (note.status === 401 || note.status === 403) return { kind: "refused", status: note.status };
    const tools: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await call("tools/list", cursor === undefined ? {} : { cursor });
      if ("kind" in result) return result as McpListing;
      if (!Array.isArray(result.tools)) throw new NotMcp("tools/list answered no tools list");
      for (const tool of result.tools as Array<{ name?: unknown }>) {
        if (typeof tool?.name === "string") tools.push(tool.name);
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : undefined;
      if (cursor === undefined) return { kind: "listed", tools: [...new Set(tools)].sort() };
    }
    throw new NotMcp(`tools/list gave more than ${MAX_PAGES} pages`);
  } catch (err) {
    return { kind: "no-answer", why: err instanceof Error ? err.message : String(err) };
  } finally {
    // Best effort: a session the server keeps costs it memory until it times out.
    if (session !== undefined) {
      await fetchImpl(url, {
        method: "DELETE",
        headers: { ...auth, "mcp-session-id": session },
        redirect: "manual",
        signal: AbortSignal.timeout(stepTimeoutMs),
      })
        .then((r) => r.body?.cancel())
        .catch(() => {});
    }
  }
}

/** The JSON-RPC answer to request `id`, from a JSON body or from an event stream. */
async function answerTo(res: Response, id: number): Promise<Record<string, unknown>> {
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  const messages: unknown[] = [];
  if (type.includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data === "") continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        throw new NotMcp("the event stream held data that is not JSON");
      }
    }
  } else {
    try {
      const parsed: unknown = JSON.parse(text);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      throw new NotMcp(`the answer is not JSON (${type || "no content-type"})`);
    }
  }
  const answer = messages.find(
    (m): m is Record<string, unknown> => typeof m === "object" && m !== null && (m as { id?: unknown }).id === id,
  );
  if (answer === undefined) throw new NotMcp("the answer holds no reply to the request");
  return answer;
}
