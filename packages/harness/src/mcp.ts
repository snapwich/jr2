// The Harness's MCP client (ADR-0079): the tools of the MCP servers that an Agent's definition
// names, behind jr2's own interface. pi-mcp (`@earendil-works/pi-mcp`) speaks the protocol; this
// module and `mcp-stdio.ts` are the only ones that import it, and neither knows the engine. The
// presenter (`mcp-tools.ts`) makes each tool an engine tool, as `menu-tools.ts` does for the Menu.
//
// Two kinds of server, two lifetimes (ADR-0079):
//
//   - A remote server: Streamable HTTP through the global `fetch`, so the pod's proxy sends each
//     request through the Custodian, which puts the secret's value in place of the Stand-in that
//     the request carries (ADR-0059). The Stand-in is read from `/run/jr2/standins/<NAME>`, as every
//     Stand-in is. One connection for each Harness, which every conversation of the pod uses.
//   - A stdio server: Workspace code, started through the spawner in the Landlock domain, with only
//     the Stand-ins that the `workspace()` grants (`mcp-stdio.ts`, ADR-0076). One process for each
//     conversation, from its first Turn to the conversation's end or the Harness's. Never shared.
//
// The tool list is the conversation's (ADR-0029, ADR-0079): read at its first Turn, filtered by the
// allowlist, sorted by name, written to its record, and offered the same to its end, across a park
// and a restart. A `listChanged` notice is not read. jr2 declares no client capability, so a server
// that asks for input gets no answer from a person, and the call fails with jr2's text.

import {
  McpClient,
  McpConnectionClosedError,
  McpError,
  McpHttpError,
  McpSessionExpiredError,
  StreamableHttpTransport,
  type McpTransport,
  type Tool,
} from "@earendil-works/pi-mcp";
import type { ChildPolicy } from "./children.ts";
import { MCP_PROTOCOL_VERSION } from "./mcp-list.ts";
import { SpawnerStdioTransport } from "./mcp-stdio.ts";
import type { McpToolsSeat, RecordedMcpTool } from "./record.ts";
import type { AgentMcpServerSpec, McpServerSpec } from "./spec.ts";

/** What a name in the tools block must match: the bound of the providers' tool names (ADR-0079). */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/** The name the model sees for a server's tool. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** The longest result the model reads, in bytes of UTF-8 (ADR-0079). */
export const MCP_RESULT_BYTES = 64 * 1024;

/** What the model reads at the cut of a long result (ADR-0079). */
export const MCP_CUT_MARK = "[jr2 cut this result at 64 KiB]";

/** The error code of a server that asks for a URL elicitation (MCP 2025-11-25). */
const URL_ELICITATION_REQUIRED = -32042;

/** The result of one MCP tool call as the model reads it: the text, and whether it is an error. */
/** A call's result as the model reads it: the text, and the result's images (ADR-0079). The engine
 * turns an image into a line of text for a model that reads no image. */
export type McpCallResult = { text: string; isError: boolean; images?: McpImage[] };

/** One image of a result, base64 as MCP sends it. */
export type McpImage = { data: string; mimeType: string };

/** The largest image that the model gets, in base64 characters (about 5 MiB of image, the most that
 * a provider takes). A larger image is a line of jr2's text. */
export const MCP_IMAGE_CHARS = 7_000_000;

/** The words of a first Turn that a server did not answer (ADR-0079): the Turn fails with them. */
export function noAnswerText(server: string, reason: string): string {
  return `${server} did not answer: ${reason}`;
}

/** What the model reads when a server took a tool away after the conversation's first Turn. */
export function goneToolText(server: string, tool: string): string {
  return `${server} no longer has the tool ${tool}`;
}

/** What the model reads when a call passed its server's timeout. */
export function timeoutText(server: string, tool: string, timeoutMs: number): string {
  return (
    `${server} did not answer the call of ${tool} in ${formatSeconds(timeoutMs)}, so jr2 cancelled the call. ` +
    "The server can still do the work that the call asked for"
  );
}

/** What the model reads when a server asked for input during a call. */
export function inputRequiredText(server: string, tool: string): string {
  return (
    `${server} asked for input during the call of ${tool}, and no one can answer it: an Agent's MCP call cannot ` +
    "ask for input. The call failed"
  );
}

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

/**
 * A transport of MCP's messages, as the host's test seam takes it: jr2's own shape of one, so that
 * the protocol library's types stay in this module. pi-mcp's transports, the in-memory one too, are
 * of this shape.
 */
export type McpChannel = {
  start(): Promise<void>;
  send(message: object, options?: { signal?: AbortSignal }): Promise<void>;
  close(): Promise<void>;
  onMessage(listener: (message: object) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onClose(listener: () => void): () => void;
};

/** What the host needs: the Instance's servers, the pod's Stand-ins, and the domain, when there is one. */
export type McpHostOptions = {
  /** The Instance's MCP servers, by the config's name (`JR2_HARNESS_JSON`'s `mcp`). */
  servers: Readonly<Record<string, McpServerSpec>>;
  /** Every held secret's Stand-in, by its name (`/run/jr2/standins`). */
  standIns: ReadonlyMap<string, string>;
  /** The domain, where a stdio server starts. Omitted (the Instance Harness), no stdio server starts. */
  children?: ChildPolicy;
  /** The `fetch` of a remote server. Default: the global `fetch`, which the pod's proxy carries. */
  fetch?: typeof globalThis.fetch;
  /** Where the host says what it does not offer. Default: `console.error`. */
  say?: (line: string) => void;
  /** A test's transport for a server, in place of the real one. */
  transport?: (server: string, spec: McpServerSpec, cwd: string) => McpChannel;
};

/** One open client, and the calls that it has in flight. */
type Connection = {
  client: McpClient;
  /** The calls in flight. The one call in flight is marked when the server asks for input. */
  inFlight: Set<{ asked: boolean }>;
};

/** The most transport errors that one connection says; it says that it says no more after them. */
const SAID_ERRORS = 5;

/**
 * The MCP part of one conversation: its tool list, fixed at its first Turn, and its stdio servers.
 * {@link McpHost.conversation} gives it.
 */
export interface McpConversation {
  /**
   * The conversation's MCP tools. The first Turn reads each server's list, keeps the allowed tools
   * sorted by name, and writes them to the record; every later Turn gets the record's, whatever its
   * definition names now (ADR-0029). A server that does not answer at the first Turn fails it, with
   * `<server> did not answer: <reason>` (ADR-0079).
   */
  tools(servers: readonly AgentMcpServerSpec[], cwd: string, signal: AbortSignal): Promise<RecordedMcpTool[]>;
  /**
   * Call one of the conversation's MCP tools. Every failure is a result that the model reads: an
   * error result with jr2's text. `signal` is the Turn's: its abort cancels the call.
   */
  call(tool: RecordedMcpTool, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>;
  /** The conversation is over: its stdio servers end. */
  end(): Promise<void>;
}

/**
 * The MCP servers of one Harness. It holds the remote connections, which every conversation of the
 * pod uses, and each conversation's own stdio processes.
 */
export class McpHost {
  private readonly servers: Servers;
  private readonly conversations = new Map<string, Conversation>();

  constructor(options: McpHostOptions) {
    this.servers = new Servers(options);
  }

  /** The MCP part of one conversation: made at its first use, kept until `end`. */
  conversation(key: string, record: McpToolsSeat): McpConversation {
    let held = this.conversations.get(key);
    // A new record at the key is a new conversation: what the old one held ends.
    if (held !== undefined && !held.keeps(record)) {
      void held.end();
      held = undefined;
    }
    if (held === undefined) {
      held = new Conversation(this.servers, record);
      this.conversations.set(key, held);
    }
    return held;
  }

  /** The conversation is over: its stdio servers end. */
  async end(key: string): Promise<void> {
    const held = this.conversations.get(key);
    this.conversations.delete(key);
    await held?.end();
  }

  /** The Harness is over: every server ends. */
  async close(): Promise<void> {
    const keys = [...this.conversations.keys()];
    await Promise.all(keys.map((key) => this.end(key)));
    await this.servers.close();
  }
}

/** The host's servers: the Instance's specs, and the remote connections of the pod. */
class Servers {
  private readonly options: McpHostOptions;
  private readonly remote = new Map<string, Promise<Connection>>();
  private readonly say: (line: string) => void;

  constructor(options: McpHostOptions) {
    this.options = options;
    this.say = options.say ?? ((line) => console.error(line));
  }

  /** Every remote connection closes. */
  async close(): Promise<void> {
    const remote = [...this.remote.values()];
    this.remote.clear();
    await Promise.all(remote.map((c) => c.then((conn) => conn.client.close()).catch(() => {})));
  }

  /** The Instance's server of this name, or undefined. */
  spec(server: string): McpServerSpec | undefined {
    const servers = this.options.servers;
    return Object.hasOwn(servers, server) ? servers[server] : undefined;
  }

  /** Write one line of what the host does not offer. */
  log(line: string): void {
    this.say(`jr2 harness: ${line}`);
  }

  /** The remote server's one connection for this Harness, opened when there is none. */
  remoteConnection(server: string, spec: McpServerSpec): Promise<Connection> {
    let held = this.remote.get(server);
    if (held === undefined) {
      // The connection is the pod's, not the Turn's: one Turn's abort does not stop it opening.
      held = this.connect(server, spec, "/", new AbortController().signal);
      this.remote.set(server, held);
      // A connection that did not open, or that closed, is opened again by the next call.
      held.then(
        (conn) => conn.client.onClose(() => this.remote.get(server) === held && this.remote.delete(server)),
        () => this.remote.get(server) === held && this.remote.delete(server),
      );
    }
    return held;
  }

  /** Drop a connection that failed, so that the next call opens a new one. */
  dropRemote(server: string, conn: Connection): void {
    void this.remote.get(server)?.then(
      (held) => {
        if (held === conn) this.remote.delete(server);
      },
      () => {},
    );
    void conn.client.close().catch(() => {});
  }

  /** Open a client to one server: its transport, then the handshake, in the server's timeout. */
  async connect(server: string, spec: McpServerSpec, cwd: string, signal: AbortSignal): Promise<Connection> {
    const transport = this.transportFor(server, spec, cwd);
    const client = new McpClient({
      name: "jr2",
      version: "0",
      protocolVersion: MCP_PROTOCOL_VERSION,
      requestTimeoutMs: spec.timeoutMs,
    });
    const conn: Connection = { client, inFlight: new Set() };
    // jr2 declares no elicitation capability (ADR-0079). A server that asks all the same marks the
    // call in flight on this connection: a call that then fails, fails as input that no one gave.
    client.setRequestHandler("elicitation/create", () => {
      // The request names no call. Only the one call in flight is surely the one that asked: with
      // more, none is marked, and each fails with the server's own error.
      if (conn.inFlight.size === 1) for (const call of conn.inFlight) call.asked = true;
      throw new McpError(-32601, "jr2 declared no elicitation capability: no one can answer this request");
    });
    // A transport error (a line that is not JSON-RPC, a stream that broke) is said; a request that
    // it fails, fails on its own. A server that writes many is said a few times, then no more.
    let said = 0;
    client.onError((err) => {
      said++;
      if (said <= SAID_ERRORS) this.log(`the MCP server ${server}: ${cut(err.message, 1024)}`);
      if (said === SAID_ERRORS) this.log(`the MCP server ${server}: jr2 says no more of its errors on this connection`);
    });
    await deadline(client.connect(transport), spec.timeoutMs, signal, () => void client.close().catch(() => {}));
    return conn;
  }

  private transportFor(server: string, spec: McpServerSpec, cwd: string): McpTransport {
    // A test's channel is of the transport's shape (`McpChannel`); its messages are the protocol's.
    if (this.options.transport) return this.options.transport(server, spec, cwd) as McpTransport;
    if ("command" in spec) {
      const children = this.options.children;
      if (children === undefined) {
        throw new Error(`it is a stdio server, and this Harness has no domain to start it in (ADR-0079)`);
      }
      return new SpawnerStdioTransport({ name: server, argv: [spec.command, ...spec.args], cwd, children });
    }
    const headers: Record<string, string> = {};
    if (spec.secret !== undefined) {
      const standIn = this.options.standIns.get(spec.secret);
      if (standIn === undefined) throw new Error(`this Harness holds no Stand-in for its secret ${spec.secret}`);
      headers.authorization = `Bearer ${standIn}`;
    }
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    return new StreamableHttpTransport({
      url: spec.url,
      headers,
      // No redirect is followed: the bearer goes to the url's host and to no other.
      fetch: (input, init) => fetchImpl(input, { ...init, redirect: "manual" }),
      // jr2 reads no notice that a server sends on its own (`listChanged`, ADR-0079).
      openGetStream: false,
    });
  }
}

/** The MCP part of one conversation ({@link McpConversation}). */
class Conversation implements McpConversation {
  private readonly servers: Servers;
  private readonly record: McpToolsSeat;
  private readonly stdio = new Map<string, Promise<Connection>>();
  /** The Frame's `cwd` of the newest Turn: where a stdio server starts. */
  private cwd = "/work";
  private ended = false;

  constructor(servers: Servers, record: McpToolsSeat) {
    this.servers = servers;
    this.record = record;
  }

  async tools(servers: readonly AgentMcpServerSpec[], cwd: string, signal: AbortSignal): Promise<RecordedMcpTool[]> {
    this.cwd = cwd;
    const recorded = this.record.read();
    if (recorded !== undefined) return recorded;
    const lists = await Promise.allSettled(servers.map((server) => this.listOne(server, signal)));
    const offered: RecordedMcpTool[] = [];
    for (const [i, listed] of lists.entries()) {
      // The reason can hold the server's words, which the run keeps as the fault's reason: cut it.
      if (listed.status === "rejected") {
        throw new Error(cut(noAnswerText(servers[i]!.name, reasonOf(listed.reason)), 1024));
      }
      offered.push(...listed.value);
    }
    offered.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    this.record.write(offered);
    return offered;
  }

  /** One server's allowed tools, as the conversation offers them. */
  private async listOne(server: AgentMcpServerSpec, signal: AbortSignal): Promise<RecordedMcpTool[]> {
    const spec = this.servers.spec(server.name);
    if (spec === undefined) throw new Error("this Instance does not declare it");
    const conn = await this.connection(server.name, spec, signal);
    let listed: Tool[];
    try {
      listed = await deadline(conn.client.listTools({ signal }), spec.timeoutMs, signal);
    } catch (err) {
      this.drop(server.name, spec, conn, err);
      throw err;
    }
    // The first tool of a name is the one: a tools block with one name two times is refused by the
    // providers, and so is every Turn of the conversation that it is recorded with.
    const byName = new Map<string, Tool>();
    for (const tool of listed) if (!byName.has(tool.name)) byName.set(tool.name, tool);
    const out: RecordedMcpTool[] = [];
    if (server.tools === "*") {
      for (const tool of byName.values()) {
        const name = mcpToolName(server.name, tool.name);
        if (!MCP_TOOL_NAME.test(name)) {
          this.servers.log(
            `the MCP server ${server.name} lists the tool ${JSON.stringify(tool.name)}, and ${JSON.stringify(name)} ` +
              `does not match ${MCP_TOOL_NAME.source}: the tool is not offered (ADR-0079)`,
          );
          continue;
        }
        out.push(declaration(server.name, tool));
      }
    } else {
      for (const name of new Set(server.tools)) {
        const tool = byName.get(name);
        if (tool === undefined) {
          this.servers.log(
            `the MCP server ${server.name} does not list the allowed tool ${JSON.stringify(name)}: it is not offered ` +
              "(ADR-0079)",
          );
          continue;
        }
        out.push(declaration(server.name, tool));
      }
    }
    return out;
  }

  async call(tool: RecordedMcpTool, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    const { server } = tool;
    // A failure's text holds the server's words (an error's message), so it is cut as a result is.
    const failed = (text: string): McpCallResult => ({ text: cut(text), isError: true });
    // The second fence: the engine runs only the tools of the run, which are the record's.
    if (!(this.record.read() ?? []).some((t) => t.name === tool.name)) {
      return failed(`${tool.name} is not one of this Agent's MCP tools`);
    }
    const spec = this.servers.spec(server);
    if (spec === undefined) return failed(noAnswerText(server, "this Instance does not declare it now"));
    let conn: Connection;
    try {
      conn = await this.connection(server, spec, signal);
    } catch (err) {
      if (signal.aborted) return failed(abortedText(server, tool.tool));
      return failed(noAnswerText(server, reasonOf(err)));
    }
    const state = { asked: false };
    conn.inFlight.add(state);
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), spec.timeoutMs);
    try {
      const result = await conn.client.callTool(tool.tool, args, {
        signal: AbortSignal.any([signal, timer.signal]),
        // jr2's own timer bounds the whole call: a progress notice does not extend it.
        timeoutMs: 0,
      });
      if (result.isError === true && state.asked) return failed(inputRequiredText(server, tool.tool));
      const images = resultImages(result);
      return { text: resultText(result), isError: result.isError === true, ...(images.length > 0 ? { images } : {}) };
    } catch (err) {
      if (signal.aborted) return failed(abortedText(server, tool.tool));
      if (timer.signal.aborted) return failed(timeoutText(server, tool.tool, spec.timeoutMs));
      if (err instanceof McpError) {
        if (err.code === URL_ELICITATION_REQUIRED || state.asked) return failed(inputRequiredText(server, tool.tool));
        if (err.code === -32602 || err.code === -32601) {
          if (await this.lacks(conn, tool.tool, spec.timeoutMs, signal)) return failed(goneToolText(server, tool.tool));
          return failed(`${server} refused the call of ${tool.tool}: ${err.message}`);
        }
        return failed(`${server} answered the call of ${tool.tool} with an error: ${err.message}`);
      }
      if (err instanceof McpHttpError && (err.status === 401 || err.status === 403)) {
        return failed(`${server} refused the call of ${tool.tool}: ${reasonOf(err)}`);
      }
      this.drop(server, spec, conn, err);
      if ("command" in spec && err instanceof McpConnectionClosedError) {
        return failed(`${server} stopped while it ran ${tool.tool}. The next call starts it again`);
      }
      return failed(noAnswerText(server, reasonOf(err)));
    } finally {
      clearTimeout(timeout);
      conn.inFlight.delete(state);
    }
  }

  /** True when this is the conversation of that record. */
  keeps(record: McpToolsSeat): boolean {
    return this.record === record;
  }

  async end(): Promise<void> {
    this.ended = true;
    const held = [...this.stdio.values()];
    this.stdio.clear();
    await Promise.all(held.map((c) => c.then((conn) => conn.client.close()).catch(() => {})));
  }

  /** True when the server's list no longer has the tool. */
  private async lacks(conn: Connection, tool: string, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    try {
      const listed = await deadline(conn.client.listTools({ signal }), timeoutMs, signal);
      return !listed.some((t) => t.name === tool);
    } catch {
      return false;
    }
  }

  /** The server's client for this conversation: the Harness's remote connection, or this
   * conversation's own stdio process, started when it has none. */
  private connection(server: string, spec: McpServerSpec, signal: AbortSignal): Promise<Connection> {
    if (!("command" in spec)) return deadline(this.servers.remoteConnection(server, spec), spec.timeoutMs, signal);
    if (this.ended) return Promise.reject(new Error("the conversation is over"));
    let held = this.stdio.get(server);
    if (held === undefined) {
      held = this.servers.connect(server, spec, this.cwd, signal);
      this.stdio.set(server, held);
      // A process that did not start, or that stopped, starts again at the next call (ADR-0079).
      held.then(
        (conn) => conn.client.onClose(() => this.stdio.get(server) === held && this.stdio.delete(server)),
        () => this.stdio.get(server) === held && this.stdio.delete(server),
      );
    }
    return held;
  }

  private drop(server: string, spec: McpServerSpec, conn: Connection, err: unknown): void {
    if (!("command" in spec)) {
      // Only a connection that is gone, or whose session the server ended, is opened again.
      if (conn.client.connectionState === "closed" || err instanceof McpSessionExpiredError) {
        this.servers.dropRemote(server, conn);
      }
      return;
    }
    if (conn.client.connectionState === "closed") this.stdio.delete(server);
  }
}

/** One server tool as the tools block declares it. The schema is the server's, with `$schema` taken
 * out (as the Menu's is), and an object schema with `properties`, which the providers require. */
function declaration(server: string, tool: Tool): RecordedMcpTool {
  const { $schema: _schema, ...schema } = tool.inputSchema ?? {};
  return {
    name: mcpToolName(server, tool.name),
    server,
    tool: tool.name,
    description: tool.description ?? tool.title ?? "",
    inputSchema: { ...schema, type: "object", properties: (schema.properties as object | undefined) ?? {} },
  };
}

/** The part of a tool call's result that the model reads from: jr2's own shape of it. */
export type McpResultContent = {
  content?: readonly ({ type: string; text?: string } | { type: string; [field: string]: unknown })[];
  structuredContent?: unknown;
};

/**
 * A result as the model reads it (ADR-0079): its text content. A result with no text and with
 * `structuredContent` gives the JSON as text. Other content is one line of jr2's text that names
 * its kind. The whole is cut at 64 KiB.
 */
export function resultText(result: McpResultContent): string {
  const parts: string[] = [];
  let texts = 0;
  for (const block of result.content ?? []) {
    if (block.type === "text") {
      parts.push(typeof block.text === "string" ? block.text : "");
      texts++;
    } else if (block.type === "image" && imageOf(block) !== undefined) {
      // The image itself goes to the model beside the text (resultImages).
    } else if (block.type === "image") {
      parts.push("[jr2: the result has an image that is too large or not base64, which the model does not read]");
    } else {
      parts.push(`[jr2: the result has ${kindOf(block.type)}, which the model does not read]`);
    }
  }
  if (texts === 0 && result.structuredContent !== undefined) parts.unshift(JSON.stringify(result.structuredContent));
  if (parts.length === 0) return resultImages(result).length > 0 ? "" : "[jr2: the result has no content]";
  return cut(parts.join("\n"));
}

/** The images of a result that the model gets: each one base64, with an image media type, and at
 * most MCP_IMAGE_CHARS. */
export function resultImages(result: McpResultContent): McpImage[] {
  const out: McpImage[] = [];
  for (const block of result.content ?? []) {
    const image = block.type === "image" ? imageOf(block) : undefined;
    if (image !== undefined) out.push(image);
  }
  return out;
}

function imageOf(block: { type: string; [field: string]: unknown }): McpImage | undefined {
  const { data, mimeType } = block;
  if (typeof data !== "string" || typeof mimeType !== "string") return undefined;
  if (!/^image\/[a-z0-9.+-]+$/i.test(mimeType) || data.length === 0 || data.length > MCP_IMAGE_CHARS) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return undefined;
  return { data, mimeType };
}

function kindOf(type: string): string {
  switch (type) {
    case "image":
      return "an image";
    case "audio":
      return "audio";
    case "resource_link":
      return "a resource link";
    case "resource":
      return "a resource";
    default:
      return `content of the kind ${JSON.stringify(type)}`;
  }
}

/** The text cut at 64 KiB of UTF-8 (or at `limit` bytes), at a character's boundary, with jr2's
 * mark at the cut. Only the 64 KiB cut is said with the mark; a shorter one ends with "…". */
function cut(text: string, limit = MCP_RESULT_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  let end = limit;
  // Back to the start of a character: a UTF-8 continuation byte is 10xxxxxx.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  const kept = bytes.subarray(0, end).toString("utf8");
  return limit === MCP_RESULT_BYTES ? `${kept}\n${MCP_CUT_MARK}` : `${kept}…`;
}

function abortedText(server: string, tool: string): string {
  return `the Turn ended, so jr2 cancelled the call of ${tool} on ${server}`;
}

/** The reason of a failure, in words a reader can act on. */
function reasonOf(err: unknown): string {
  if (err instanceof McpSessionExpiredError) return "the server ended the session";
  if (err instanceof McpHttpError) {
    if (err.status === 401 || err.status === 403) return `the server refused the credential (HTTP ${err.status})`;
    return `HTTP ${err.status}`;
  }
  if (err instanceof McpConnectionClosedError) return "the connection closed";
  if (err instanceof DeadlineError) return err.message;
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const why = cause instanceof Error ? `: ${cause.message}` : "";
    return `${err.message}${why}`;
  }
  return String(err);
}

class DeadlineError extends Error {}

/** `work`, or a throw when it takes longer than `ms` or `signal` aborts; `onGiveUp` runs then. */
function deadline<T>(work: Promise<T>, ms: number, signal: AbortSignal, onGiveUp?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = (err: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      onGiveUp?.();
      reject(err);
    };
    const onAbort = () => stop(new DeadlineError("the Turn ended before it answered"));
    const timer = setTimeout(() => stop(new DeadlineError(`no answer in ${formatSeconds(ms)}`)), ms);
    // The handlers go on `work` first: when this gives up, `work` can still reject, and a rejection
    // that nothing observes would end the process.
    work.then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
