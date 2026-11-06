// The Harness's MCP client (ADR-0079), socket-free: `McpHost` and `McpConversation` against a
// scripted server (`support/mcp-server.ts`) over pi-mcp's in-memory transport or an in-process
// Streamable HTTP `fetch`, and a stdio server started through the real spawner, in a Landlock
// domain (`support/children.ts`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  goneToolText,
  inputRequiredText,
  MCP_CUT_MARK,
  McpHost,
  resultImages,
  resultText,
  timeoutText,
  type McpHostOptions,
} from "../src/mcp.ts";
import { mcpTools } from "../src/mcp-tools.ts";
import { mcpToolsSeat, type McpToolsSeat, type RecordedMcpTool } from "../src/record.ts";
import type { AgentMcpServerSpec, McpServerSpec } from "../src/spec.ts";
import { deniedDir, testChildren } from "./support/children.ts";
import { FakeMcpServer, RpcError, type FakeTool } from "./support/mcp-server.ts";

const STDIO_SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-stdio-server.mjs");
const never = new AbortController().signal;
const fault = (err: unknown): never => {
  throw err;
};

/** A seat with no folder: memory only. */
const memorySeat = (): McpToolsSeat => mcpToolsSeat(undefined, fault);

/** A host whose servers are each one scripted server over the in-memory transport. */
function hostOver(
  fakes: Record<string, FakeMcpServer>,
  servers: Record<string, McpServerSpec>,
  extra: Partial<McpHostOptions> = {},
): McpHost {
  return new McpHost({
    servers,
    standIns: new Map(),
    transport: (name) => fakes[name]!.inMemory(),
    say: () => {},
    ...extra,
  });
}

const remote = (url = "https://mcp.example/mcp", timeoutMs = 60_000): McpServerSpec => ({ url, timeoutMs });
const agentServer = (name: string, tools: readonly string[] | "*"): AgentMcpServerSpec => ({
  name,
  transport: { kind: "http", url: "https://mcp.example/mcp" },
  tools,
  timeoutMs: 60_000,
});
const tool = (name: string, extra: Partial<FakeTool> = {}): FakeTool => ({
  name,
  description: `the ${name} tool`,
  ...extra,
});

test("the first Turn reads each server's list: the allowed tools, named mcp__<server>__<tool>, sorted by name, in the record (ADR-0079)", async () => {
  const slack = new FakeMcpServer([
    tool("post"),
    tool("delete_channel"),
    tool("history", { inputSchema: { $schema: "x", type: "object" } }),
  ]);
  const jira = new FakeMcpServer([tool("search"), tool("comment")]);
  const host = hostOver({ slack, jira }, { slack: remote(), jira: remote() });
  const seat = memorySeat();
  const conversation = host.conversation("coder/run-1", seat);
  const offered = await conversation.tools(
    [agentServer("slack", ["post", "history"]), agentServer("jira", "*")],
    "/work",
    never,
  );
  assert.deepEqual(
    offered.map((t) => t.name),
    ["mcp__jira__comment", "mcp__jira__search", "mcp__slack__history", "mcp__slack__post"],
  );
  // The server's own description and schema, with `$schema` out and the object shape the providers want.
  assert.deepEqual(offered[2], {
    name: "mcp__slack__history",
    server: "slack",
    tool: "history",
    description: "the history tool",
    inputSchema: { type: "object", properties: {} },
  });
  assert.deepEqual(seat.read(), offered);
  // Every later Turn gets the record's list, whatever its definition names: no server is asked.
  const listed = slack.requests.filter((r) => r.method === "tools/list").length;
  slack.tools.push(tool("new_tool"));
  const again = await conversation.tools([agentServer("slack", "*")], "/work", never);
  assert.deepEqual(again, offered);
  assert.equal(slack.requests.filter((r) => r.method === "tools/list").length, listed);
  await host.close();
});

test("the list survives a Harness restart: a new host over the same record offers the same tools, and asks no server (ADR-0079)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr2-mcp-record-"));
  const notes = new FakeMcpServer([tool("lookup"), tool("add")]);
  const first = hostOver({ notes }, { notes: remote() });
  const offered = await first
    .conversation("k", mcpToolsSeat(dir, fault))
    .tools([agentServer("notes", "*")], "/work", never);
  await first.close();
  const after = new FakeMcpServer([tool("lookup"), tool("add"), tool("drop")]);
  const second = hostOver({ notes: after }, { notes: remote() });
  const conversation = second.conversation("k", mcpToolsSeat(dir, fault));
  assert.deepEqual(await conversation.tools([agentServer("notes", "*")], "/work", never), offered);
  assert.equal(after.requests.length, 0, "a restart reads no list");
  // The first call opens the connection then.
  const result = await conversation.call(offered[0]!, {}, never);
  assert.equal(result.isError, false);
  await second.close();
});

test('a tool that "*" reaches with a name past the bound is not offered, and one log line names it (ADR-0079)', async () => {
  const lines: string[] = [];
  const odd = new FakeMcpServer([tool("ok"), tool("has.dot"), tool("x".repeat(130))]);
  const host = hostOver({ odd }, { odd: remote() }, { say: (line) => lines.push(line) });
  const offered = await host.conversation("k", memorySeat()).tools([agentServer("odd", "*")], "/work", never);
  assert.deepEqual(
    offered.map((t) => t.name),
    ["mcp__odd__ok"],
  );
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /the MCP server odd lists the tool "has\.dot".*is not offered \(ADR-0079\)/);
  await host.close();
});

test("a server that does not answer at the first Turn fails it: `<server> did not answer: <reason>` (ADR-0079)", async () => {
  const slack = new FakeMcpServer([tool("post")]);
  slack.silent = true;
  const ok = new FakeMcpServer([tool("search")]);
  const host = hostOver({ "slack-acme": slack, jira: ok }, { "slack-acme": remote(undefined, 50), jira: remote() });
  const seat = memorySeat();
  await assert.rejects(
    host.conversation("k", seat).tools([agentServer("jira", "*"), agentServer("slack-acme", ["post"])], "/work", never),
    /^Error: slack-acme did not answer: no answer in 0\.1 s$/,
  );
  assert.equal(seat.read(), undefined, "no list is recorded, so the next Turn asks again");
  // A credential the server refuses names the status.
  const locked = new FakeMcpServer([tool("post")], { token: "the-real-one" });
  const http = new McpHost({
    servers: { locked: { url: "https://mcp.example/mcp", secret: "LOCKED", timeoutMs: 1000 } },
    standIns: new Map([["LOCKED", "a-stand-in"]]),
    fetch: locked.fetch,
    say: () => {},
  });
  await assert.rejects(
    http.conversation("k", memorySeat()).tools([agentServer("locked", ["post"])], "/work", never),
    /locked did not answer: the server refused the credential \(HTTP 401\)/,
  );
  await host.close();
  await http.close();
});

test("a remote server: Streamable HTTP with the Stand-in as the bearer, and one connection for each Harness (ADR-0079, ADR-0059)", async () => {
  const slack = new FakeMcpServer([tool("post")], { token: "stand-in-of-SLACK" });
  const host = new McpHost({
    servers: { slack: { url: "https://mcp.slack.example/mcp", secret: "SLACK", timeoutMs: 5_000 } },
    standIns: new Map([["SLACK", "stand-in-of-SLACK"]]),
    fetch: slack.fetch,
    say: () => {},
  });
  const a = host.conversation("coder/run-1", memorySeat());
  const b = host.conversation("reviewer/run-1", memorySeat());
  const [listA] = await Promise.all([
    a.tools([agentServer("slack", ["post"])], "/work", never),
    b.tools([agentServer("slack", ["post"])], "/work", never),
  ]);
  assert.equal((await a.call(listA[0]!, { text: "hi" }, never)).text, '{"text":"hi"}');
  assert.equal((await b.call(listA[0]!, { text: "yo" }, never)).text, '{"text":"yo"}');
  assert.equal(slack.initializes, 1, "every conversation of the pod uses one connection");
  for (const request of slack.requests) {
    assert.equal(request.headers?.authorization, "Bearer stand-in-of-SLACK", request.method);
  }
  // Every request after the handshake states the protocol revision.
  assert.ok(
    slack.requests
      .filter((r) => r.method !== "initialize")
      .every((r) => r.headers?.["mcp-protocol-version"] === "2025-11-25"),
  );
  await host.close();
});

test("results: the text the model reads, structured content as JSON only with no text, an image to the model, other content as one jr2 line, cut at 64 KiB (ADR-0079)", () => {
  assert.equal(
    resultText({
      content: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
      structuredContent: { n: 1 },
    }),
    "one\ntwo",
  );
  assert.equal(resultText({ content: [], structuredContent: { n: 1 } }), '{"n":1}');
  assert.equal(
    resultText({
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "a chart" },
      ],
    }),
    "a chart",
  );
  assert.deepEqual(
    resultImages({
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "image", data: "not base64!", mimeType: "image/png" },
        { type: "image", data: "AAAA", mimeType: "text/html" },
      ],
    }),
    [{ data: "AAAA", mimeType: "image/png" }],
  );
  assert.equal(resultText({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }), "");
  assert.equal(
    resultText({ content: [{ type: "image", data: "AAAA", mimeType: "text/html" }] }),
    "[jr2: the result has an image that is too large or not base64, which the model does not read]",
  );
  assert.equal(
    resultText({ content: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }] }),
    "[jr2: the result has audio, which the model does not read]",
  );
  assert.equal(resultText({ content: [] }), "[jr2: the result has no content]");
  const long = resultText({ content: [{ type: "text", text: "é".repeat(40_000) }] });
  assert.ok(long.endsWith(`\n${MCP_CUT_MARK}`));
  const kept = long.slice(0, -MCP_CUT_MARK.length - 1);
  assert.equal(Buffer.byteLength(kept), 64 * 1024, "the cut is at 64 KiB, on a character's boundary");
  assert.ok(!kept.includes("�"));
});

test("a call: an error result is an error, a timeout and a Turn's abort cancel it, and a tool gone from the server says so (ADR-0079)", async () => {
  const slack = new FakeMcpServer([
    tool("fails", { call: () => ({ content: [{ type: "text", text: "channel not found" }], isError: true }) }),
    tool("slow", {
      call: (_args, { signal }) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")))),
    }),
    tool("bad", {
      call: () => {
        throw new RpcError(-32603, "it broke");
      },
    }),
    tool("going"),
  ]);
  const host = hostOver({ slack }, { slack: remote(undefined, 100) });
  const conversation = host.conversation("k", memorySeat());
  const offered = await conversation.tools([agentServer("slack", "*")], "/work", never);
  const named = (name: string) => offered.find((t) => t.tool === name)!;

  assert.deepEqual(await conversation.call(named("fails"), {}, never), { text: "channel not found", isError: true });
  assert.deepEqual(await conversation.call(named("slow"), {}, never), {
    text: timeoutText("slack", "slow", 100),
    isError: true,
  });
  assert.equal(timeoutText("slack", "slow", 60_000).startsWith("slack did not answer the call of slow in 60 s"), true);
  assert.ok(slack.cancelled.length >= 1, "the server hears the cancellation");
  const turn = new AbortController();
  const aborted = conversation.call(named("slow"), {}, turn.signal);
  setTimeout(() => turn.abort(), 10);
  assert.deepEqual(await aborted, {
    text: "the Turn ended, so jr2 cancelled the call of slow on slack",
    isError: true,
  });
  assert.deepEqual(await conversation.call(named("bad"), {}, never), {
    text: "slack answered the call of bad with an error: it broke",
    isError: true,
  });
  slack.tools = slack.tools.filter((t) => t.name !== "going");
  assert.deepEqual(await conversation.call(named("going"), {}, never), {
    text: goneToolText("slack", "going"),
    isError: true,
  });
  assert.equal(goneToolText("slack", "going"), "slack no longer has the tool going");
  // A name outside the conversation's list is refused, whatever the server has.
  const stranger: RecordedMcpTool = { ...named("fails"), name: "mcp__slack__other", tool: "other" };
  assert.deepEqual(await conversation.call(stranger, {}, never), {
    text: "mcp__slack__other is not one of this Agent's MCP tools",
    isError: true,
  });
  await host.close();
});

test("a server that asks for input fails the call with jr2's text: no one can answer it (ADR-0079)", async () => {
  const slack = new FakeMcpServer([
    tool("ask", {
      call: async (_args, { elicit }) => {
        const answer = await elicit();
        return answer.error
          ? { content: [{ type: "text", text: "the user gave no channel" }], isError: true }
          : { content: [{ type: "text", text: "posted" }] };
      },
    }),
    tool("url", {
      call: () => {
        throw new RpcError(-32042, "open this url to sign in");
      },
    }),
  ]);
  const host = hostOver({ slack }, { slack: remote() });
  const conversation = host.conversation("k", memorySeat());
  const offered = await conversation.tools([agentServer("slack", "*")], "/work", never);
  for (const t of offered) {
    assert.deepEqual(await conversation.call(t, {}, never), {
      text: inputRequiredText("slack", t.tool),
      isError: true,
    });
  }
  assert.match(
    inputRequiredText("slack", "ask"),
    /^slack asked for input during the call of ask, and no one can answer it/,
  );
  await host.close();
});

test("a failure's text is cut at 64 KiB as a result is: the server's error message is the server's size (ADR-0079)", async () => {
  const huge = "E".repeat(300_000);
  const slack = new FakeMcpServer([
    tool("internal", {
      call: () => {
        throw new RpcError(-32603, huge);
      },
    }),
    tool("params", {
      call: () => {
        throw new RpcError(-32602, huge);
      },
    }),
  ]);
  const host = hostOver({ slack }, { slack: remote() });
  const conversation = host.conversation("k", memorySeat());
  const offered = await conversation.tools([agentServer("slack", "*")], "/work", never);
  for (const t of offered) {
    const result = await conversation.call(t, {}, never);
    assert.equal(result.isError, true);
    assert.ok(Buffer.byteLength(result.text) <= 64 * 1024 + MCP_CUT_MARK.length + 1, t.tool);
    assert.ok(result.text.endsWith(MCP_CUT_MARK), t.tool);
  }
  await host.close();
});

test("one name is offered once: a list that names a tool twice, or a server that lists it twice, gives one tool (ADR-0079)", async () => {
  const slack = new FakeMcpServer([tool("post"), tool("read"), tool("post", { description: "the second post" })]);
  const host = hostOver({ slack, other: slack }, { slack: remote(), other: remote() });
  const listed = await host
    .conversation("a", memorySeat())
    .tools([agentServer("slack", ["post", "post", "read"])], "/work", never);
  assert.deepEqual(
    listed.map((t) => [t.name, t.description]),
    [
      ["mcp__slack__post", "the post tool"],
      ["mcp__slack__read", "the read tool"],
    ],
  );
  const all = await host.conversation("b", memorySeat()).tools([agentServer("other", "*")], "/work", never);
  assert.deepEqual(
    all.map((t) => [t.name, t.description]),
    [
      ["mcp__other__post", "the post tool"],
      ["mcp__other__read", "the read tool"],
    ],
  );
  await host.close();
});

test("a call whose Turn ended before it started opens nothing and leaves no unhandled rejection (ADR-0079)", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const notes = new FakeMcpServer([tool("lookup")]);
    // A stdio spec over the in-memory transport: the conversation's own connection, opened with the Turn's signal.
    const host = hostOver({ notes }, { notes: { command: "notes-mcp", args: [], timeoutMs: 1000 } });
    const seat = memorySeat();
    const lookup: RecordedMcpTool = {
      name: "mcp__notes__lookup",
      server: "notes",
      tool: "lookup",
      description: "the lookup tool",
      inputSchema: { type: "object", properties: {} },
    };
    seat.write([lookup]);
    const turn = new AbortController();
    turn.abort();
    assert.deepEqual(await host.conversation("k", seat).call(lookup, {}, turn.signal), {
      text: "the Turn ended, so jr2 cancelled the call of lookup on notes",
      isError: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.close();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test("an ask for input with two calls in flight marks neither: each fails with the server's own words (ADR-0079)", async () => {
  const slack = new FakeMcpServer([
    tool("ask", {
      call: async (_args, { elicit }) => {
        const answer = await elicit();
        return answer.error
          ? { content: [{ type: "text", text: "the user gave no channel" }], isError: true }
          : { content: [{ type: "text", text: "posted" }] };
      },
    }),
  ]);
  const host = hostOver({ slack }, { slack: remote() });
  const conversation = host.conversation("k", memorySeat());
  const [ask] = await conversation.tools([agentServer("slack", "*")], "/work", never);
  const both = await Promise.all([conversation.call(ask!, {}, never), conversation.call(ask!, {}, never)]);
  assert.deepEqual(both, [
    { text: "the user gave no channel", isError: true },
    { text: "the user gave no channel", isError: true },
  ]);
  await host.close();
});

test("the presenter: each tool is an engine tool with the server's declaration; an error result throws its text (ADR-0079)", async () => {
  const notes = new FakeMcpServer([
    tool("lookup", { inputSchema: { type: "object", properties: { term: { type: "string" } } } }),
    tool("broken", { call: () => ({ content: [{ type: "text", text: "no such note" }], isError: true }) }),
  ]);
  const host = hostOver({ notes }, { notes: remote() });
  const conversation = host.conversation("k", memorySeat());
  const engineTools = mcpTools(conversation, await conversation.tools([agentServer("notes", "*")], "/work", never));
  assert.deepEqual(
    engineTools.map((t) => [t.name, t.description, t.parameters]),
    [
      ["mcp__notes__broken", "the broken tool", { type: "object", properties: {} }],
      ["mcp__notes__lookup", "the lookup tool", { type: "object", properties: { term: { type: "string" } } }],
    ],
  );
  assert.deepEqual(await engineTools[1]!.execute("c1", { term: "Gate" } as never), {
    content: [{ type: "text", text: '{"term":"Gate"}' }],
  });
  await assert.rejects(engineTools[0]!.execute("c2", {} as never), /^Error: no such note$/);
  await host.close();
});

test("a stdio server runs through the spawner, in the domain, with only the Stand-ins the workspace() grants (ADR-0079, ADR-0076)", async () => {
  const runJr2 = deniedDir("mcp-run-jr2-");
  const controlFile = join(runJr2, "control-standin");
  writeFileSync(controlFile, "the-control-stand-in");
  const standIns = new Map([
    ["GH_TOKEN", "stand-in-of-GH"],
    ["SLACK_TOKEN", "stand-in-of-SLACK"],
    ["ANTHROPIC_API_KEY", "stand-in-of-the-model-key"],
  ]);
  const children = testChildren({ standIns, granted: ["GH_TOKEN"], control: "the-control-stand-in", deny: [runJr2] });
  const host = new McpHost({
    servers: { notes: { command: process.execPath, args: [STDIO_SERVER, "--serve"], timeoutMs: 10_000 } },
    // The Harness process holds every Stand-in; the server must get none it was not granted.
    standIns,
    children,
    say: () => {},
  });
  const stdio: AgentMcpServerSpec = {
    name: "notes",
    transport: { kind: "stdio", command: process.execPath, args: [STDIO_SERVER, "--serve"] },
    tools: "*",
    timeoutMs: 10_000,
  };
  const a = host.conversation("coder/run-1", memorySeat());
  const offered = await a.tools([stdio], tmpdir(), never);
  assert.deepEqual(
    offered.map((t) => t.name),
    ["mcp__notes__env", "mcp__notes__exit", "mcp__notes__lookup", "mcp__notes__pid", "mcp__notes__read"],
  );
  const named = (name: string) => offered.find((t) => t.tool === name)!;
  const env = JSON.parse((await a.call(named("env"), {}, never)).text) as Record<string, string>;
  assert.equal(env.GH_TOKEN, "stand-in-of-GH");
  const values = Object.values(env);
  for (const withheld of ["stand-in-of-SLACK", "stand-in-of-the-model-key", "the-control-stand-in"]) {
    assert.ok(!values.includes(withheld), `the server holds ${withheld}`);
  }
  assert.ok(!Object.keys(env).some((k) => k.startsWith("JR2_")), "no JR2_ variable reaches the domain");
  // In the domain: what the domain may not reach, the server cannot read.
  assert.deepEqual(await a.call(named("read"), { path: controlFile }, never), { text: "EACCES", isError: true });

  // One process for each conversation, never shared.
  const pidA = (await a.call(named("pid"), {}, never)).text;
  const b = host.conversation("reviewer/run-1", memorySeat());
  const offeredB = await b.tools([stdio], tmpdir(), never);
  const pidB = (await b.call(offeredB.find((t) => t.tool === "pid")!, {}, never)).text;
  assert.notEqual(pidA, pidB);
  assert.equal((await a.call(named("pid"), {}, never)).text, pidA, "a conversation keeps its process");

  // A process that stops fails its call with jr2's text, and the next call starts a new one.
  assert.deepEqual(await a.call(named("exit"), {}, never), {
    text: "notes stopped while it ran exit. The next call starts it again",
    isError: true,
  });
  const restarted = (await a.call(named("pid"), {}, never)).text;
  assert.notEqual(restarted, pidA);

  // The conversation's end ends its process; the other conversation's runs on.
  await host.end("coder/run-1");
  assert.equal((await b.call(offeredB.find((t) => t.tool === "pid")!, {}, never)).text, pidB);
  await host.close();
});

test("a Harness with no domain starts no stdio server: the first Turn fails with jr2's text (ADR-0079)", async () => {
  const host = new McpHost({
    servers: { notes: { command: "notes-mcp", args: [], timeoutMs: 1000 } },
    standIns: new Map(),
    say: () => {},
  });
  await assert.rejects(
    host
      .conversation("k", memorySeat())
      .tools(
        [{ name: "notes", transport: { kind: "stdio", command: "notes-mcp", args: [] }, tools: "*", timeoutMs: 1000 }],
        "/work",
        never,
      ),
    /notes did not answer: it is a stdio server, and this Harness has no domain to start it in/,
  );
});
