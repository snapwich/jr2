// A stdio MCP server with one tool, next_version. It reads one JSON-RPC message on each line of
// stdin, and writes each answer as one line on stdout. Node runs this file as it is.
import { createInterface } from "node:readline";

type Message = { id?: number | string; method?: string; params?: { name?: string; arguments?: unknown } };

const tools = [
  {
    name: "next_version",
    description: "The next version number after a release. Give the current version and the kind of change.",
    inputSchema: {
      type: "object",
      properties: {
        version: { type: "string", description: "The current version, such as 1.4.2." },
        change: { type: "string", enum: ["major", "minor", "patch"] },
      },
      required: ["version", "change"],
    },
  },
];

// The tool itself: a function of its arguments.
function nextVersion(version: string, change: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) throw new Error(`${version} is not a version such as 1.4.2`);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (change === "major") return `${major + 1}.0.0`;
  if (change === "minor") return `${major}.${minor + 1}.0`;
  if (change === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`${change} is not major, minor or patch`);
}

function call(name: string | undefined, args: unknown): object {
  const { version, change } = (args ?? {}) as { version?: unknown; change?: unknown };
  if (name !== "next_version") return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  try {
    const text = nextVersion(String(version), String(change));
    return { result: { content: [{ type: "text", text }] } };
  } catch (err) {
    // A tool's own error: the model reads the text, and the call is an error.
    return { result: { content: [{ type: "text", text: (err as Error).message }], isError: true } };
  }
}

function handle(message: Message): object {
  switch (message.method) {
    case "initialize":
      return {
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "semver", version: "1.0.0" },
        },
      };
    case "tools/list":
      return { result: { tools } };
    case "tools/call":
      return call(message.params?.name, message.params?.arguments);
    default:
      return { error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const message = JSON.parse(line) as Message;
  // A notification has no id, and gets no answer.
  if (message.id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...handle(message) })}\n`);
});
