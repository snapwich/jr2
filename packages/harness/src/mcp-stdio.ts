// A stdio MCP server's transport, over the spawner (ADR-0079, ADR-0076). A stdio server is
// Workspace code: the spawner starts it in the Landlock domain, with the domain's env, so it holds
// only the Stand-ins that the `workspace()` grants. It never holds the control Stand-in, and it
// cannot read `/run/jr2`. pi-mcp's own `StdioTransport` is not used: it starts the program from
// this process, outside the domain, with this process's env and every Stand-in in it.
//
// The framing is MCP's stdio framing: one JSON-RPC message on each line, on the server's stdin and
// stdout. The server is in the domain, so each line that it writes is DATA OF THE DOMAIN: a line
// that does not parse is said and dropped, and a line longer than the bound ends the server. Its
// stderr is not read. The end follows the spec: close stdin, then SIGTERM, then SIGKILL, to the
// server's whole process group.

import { parseJsonRpcMessage, type JsonRpcMessage, type McpTransport } from "@earendil-works/pi-mcp";
import type { ChildPolicy } from "./children.ts";
import type { Spawned } from "./spawner.ts";

/** The longest line that the transport reads from a server: a longer one ends the server. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** How long the end waits after it closes stdin, and again after SIGTERM. */
const END_GRACE_MS = 2_000;

type Listeners = {
  message: Set<(message: JsonRpcMessage) => void>;
  error: Set<(error: Error) => void>;
  close: Set<() => void>;
};

/** What starts one stdio server: its argv, its cwd, and the domain it runs in. */
export type StdioServer = {
  /** The config's name, for what the transport says. */
  name: string;
  argv: readonly string[];
  cwd: string;
  children: ChildPolicy;
};

/** One stdio server process, started through the spawner at `start()`, as one MCP transport. */
export class SpawnerStdioTransport implements McpTransport {
  private readonly server: StdioServer;
  private readonly listeners: Listeners = { message: new Set(), error: new Set(), close: new Set() };
  private proc: Spawned | undefined;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private closed = false;
  private closeSaid = false;

  constructor(server: StdioServer) {
    this.server = server;
  }

  async start(): Promise<void> {
    if (this.proc !== undefined) throw new Error(`the stdio MCP server ${this.server.name} has started already`);
    const { argv, cwd, children } = this.server;
    // The domain's env as it is, and nothing more: only the Stand-ins that the `workspace()` grants
    // (`children.ts`). The server's own `secret` does not exist: a stdio server spends what its
    // Workspace grants (ADR-0079).
    const proc = children.spawner.spawn(
      { argv, env: children.env, cwd, stdin: true },
      { onStdout: (chunk) => this.read(chunk) },
    );
    this.proc = proc;
    proc.exited.then(
      () => this.ended(),
      (err: unknown) => {
        this.emitError(err);
        this.ended();
      },
    );
    await proc.started;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed || this.proc === undefined) {
      throw new Error(`the stdio MCP server ${this.server.name} is not running`);
    }
    this.proc.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const proc = this.proc;
    if (proc === undefined) {
      this.emitClose();
      return;
    }
    const exited = proc.exited.then(
      () => true,
      () => true,
    );
    const within = (ms: number) =>
      Promise.race([exited, new Promise<false>((resolve) => setTimeout(() => resolve(false), ms).unref())]);
    proc.end();
    if (!(await within(END_GRACE_MS))) {
      proc.signal("SIGTERM");
      if (!(await within(END_GRACE_MS))) proc.signal("SIGKILL");
    }
    this.emitClose();
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.listeners.message.add(listener);
    return () => this.listeners.message.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.listeners.error.add(listener);
    return () => this.listeners.error.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.listeners.close.add(listener);
    return () => this.listeners.close.delete(listener);
  }

  /** The server's stdout, cut into lines. */
  private read(chunk: Buffer): void {
    let start = 0;
    for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, start)) {
      this.buffered.push(chunk.subarray(start, at));
      const line = Buffer.concat(this.buffered).toString("utf8");
      this.buffered = [];
      this.bufferedBytes = 0;
      start = at + 1;
      this.line(line);
    }
    if (start < chunk.length) {
      this.buffered.push(chunk.subarray(start));
      this.bufferedBytes += chunk.length - start;
      if (this.bufferedBytes > MAX_LINE_BYTES) {
        this.buffered = [];
        this.bufferedBytes = 0;
        this.emitError(new Error(`the stdio MCP server ${this.server.name} wrote a line longer than 16 MiB`));
        void this.close();
      }
    }
  }

  private line(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") return;
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpcMessage(JSON.parse(trimmed));
    } catch {
      this.emitError(new Error(`the stdio MCP server ${this.server.name} wrote a line that is not JSON-RPC`));
      return;
    }
    for (const listener of this.listeners.message) listener(message);
  }

  private ended(): void {
    this.closed = true;
    this.emitClose();
  }

  private emitError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    for (const listener of this.listeners.error) listener(error);
  }

  private emitClose(): void {
    if (this.closeSaid) return;
    this.closeSaid = true;
    for (const listener of this.listeners.close) listener();
  }
}
