// A stdio MCP server for the tests (ADR-0079): one JSON-RPC message on each line of stdin and of
// stdout. The Harness starts it through the spawner, in the Landlock domain. Its tools tell the
// test what the process holds: `echo` the arguments it got, `env` its environment, `pid` its
// process id, `read` a file's bytes, and `exit` ends the process.
//
// It serves only with `--serve`: `node --test` runs each script under `test/`, and with no flag the
// script ends at once.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (!process.argv.includes("--serve")) process.exit(0);

const tools = [
  {
    name: "echo",
    description: "The arguments the server got, as JSON.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer" },
        label: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["count", "label", "tags"],
    },
  },
  { name: "env", description: "The server's environment, as JSON.", inputSchema: { type: "object" } },
  { name: "pid", description: "The server's process id.", inputSchema: { type: "object" } },
  {
    name: "lookup",
    description: "Look up a term in the notes.",
    inputSchema: { type: "object", properties: { term: { type: "string" } }, required: ["term"] },
  },
  {
    name: "read",
    description: "A file's text, or the error that reading it gave.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  { name: "exit", description: "End the server.", inputSchema: { type: "object" } },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (t) => ({ content: [{ type: "text", text: t }] });

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const ok = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  const params = message.params ?? {};
  if (message.method === "initialize") {
    ok({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "notes", version: "1" } });
  } else if (message.method === "tools/list") {
    ok({ tools });
  } else if (message.method === "tools/call") {
    const args = params.arguments ?? {};
    if (params.name === "echo") ok(text(JSON.stringify(args)));
    else if (params.name === "env") ok(text(JSON.stringify(process.env)));
    else if (params.name === "pid") ok(text(String(process.pid)));
    else if (params.name === "lookup") ok(text(`notes on ${args.term}: it is defined in GLOSSARY.md`));
    else if (params.name === "read") {
      try {
        ok(text(readFileSync(args.path, "utf8")));
      } catch (err) {
        ok({ content: [{ type: "text", text: String(err.code ?? err) }], isError: true });
      }
    } else if (params.name === "exit") process.exit(3);
    else send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Unknown tool: ${params.name}` } });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
