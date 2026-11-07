// Conformance for MCP tools (ADR-0027, ADR-0079): the claims that the socket-free MCP tests cannot
// see, driven through the REAL turn loop — pi at the exact pin, the Menu over a real socket to the
// Custodian's address, a scripted provider, and a stdio MCP server that the real spawner starts in
// a Landlock domain. An MCP tool call is a step and not a pick: the Turn goes on after it, and the
// pick after it delivers. The tools block is the Working tools, then the MCP tools, then the Menu,
// and it is the same bytes on every Turn of the conversation (ADR-0029).

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { harnessServer } from "../src/app.ts";
import { MCP_TOOLS_LINE } from "../src/briefing.ts";
import { McpHost } from "../src/mcp.ts";
import { admissionFault, modelsFor } from "../src/provider.ts";
import type { AgentDefinition, HarnessSpec } from "../src/spec.ts";
import { runSubmissionFor } from "../src/turn.ts";
import { unixFetch } from "../src/unix-fetch.ts";
import type { Settlement, StreamEvent } from "../src/wire.ts";
import type { Surface } from "../src/menu.ts";
import { testChildren } from "./support/children.ts";
import {
  CONTROL_STAND_IN,
  severKeepAliveSockets,
  startFakeCustodian,
  startFakeProvider,
  type FakeProvider,
  type FakeSandbox,
} from "./support/rig.ts";

const STDIO_SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-stdio-server.mjs");
const AGENT = "researcher";

const surface: Surface = {
  instanceId: "run-1/machine.researching/researcher/s1",
  runId: "run-1",
  sandbox: "ws-1",
  menu: [
    {
      name: "review_verdict",
      description: "Deliver it. Call it once, then stop.",
      input: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
      semantics: "ack" as const,
    },
  ],
  allowed: ["review_verdict"],
};

const definitions: Record<string, AgentDefinition> = {
  withNotes: {
    model: "fake/model-x",
    instructions: "Look the term up in the notes, then give your verdict.",
    mcp: [{ server: "notes" }],
  },
  withMissing: {
    model: "fake/model-x",
    instructions: "Look the term up.",
    mcp: [{ server: "gone" }],
  },
};

let provider: FakeProvider;
let sandbox: FakeSandbox;
let app: Hono;
let host: McpHost;
const printed = new Map<string, string>();

before(async () => {
  provider = await startFakeProvider();
  sandbox = await startFakeCustodian(surface);
  const spec: HarnessSpec = {
    provider: {
      id: "fake",
      api: "openai-completions",
      baseUrl: provider.url,
      contextWindow: 200_000,
      maxTokens: 8192,
      models: { "model-x": {} },
    },
    mcp: {
      notes: { command: process.execPath, args: [STDIO_SERVER, "--serve"], timeoutMs: 10_000 },
      // A program the Sandbox Image does not have: its first Turn fails.
      gone: { command: "/nonexistent/mcp-server", args: [], timeoutMs: 10_000 },
    },
  };
  const models = modelsFor(spec, {});
  const children = testChildren({ tmp: tmpdir(), work: tmpdir() });
  host = new McpHost({ servers: spec.mcp!, standIns: new Map(), children, say: () => {} });
  const key = (agent: string, iid: string) => `${agent}/${iid}`;
  app = harnessServer({
    conversationsDir: mkdtempSync(join(tmpdir(), "jr2-mcp-conf-")),
    longPollMs: 250,
    sweepWaitMs: 50,
    checkBearer: () => true,
    checkAdmission: (resolved) => admissionFault(models, resolved),
    conversationFreed: (agent, iid) => void host.end(key(agent, iid)),
    runSubmissionFor: (seat) =>
      runSubmissionFor({
        models,
        menu: {
          url: "http://jr2-custodian",
          token: CONTROL_STAND_IN,
          fetch: unixFetch(sandbox.socket),
          retryWindowMs: 50,
          retryInitialMs: 1,
        },
        children,
        maxRetries: 0,
        mcp: { conversation: host.conversation(key(seat.agentName, seat.instanceId), seat.mcpTools), servers: spec },
        printerOut: {
          write: (chunk) => printed.set(seat.instanceId, (printed.get(seat.instanceId) ?? "") + chunk),
        },
        ...seat,
      }),
  }).app;
});

after(async () => {
  await host.close();
  await severKeepAliveSockets();
  await sandbox.close();
  await provider.close();
});

async function admit(
  iid: string,
  definition: AgentDefinition,
  message: string,
): Promise<{ offset: string; submissionId: string }> {
  const res = await app.request(`/agents/${AGENT}/${encodeURIComponent(iid)}`, {
    method: "POST",
    body: JSON.stringify({ message, cwd: tmpdir(), definition }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as { offset: string; submissionId: string };
}

async function settled(iid: string, admission: { offset: string; submissionId: string }): Promise<Settlement> {
  let offset = admission.offset;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const res = await app.request(`/agents/${AGENT}/${encodeURIComponent(iid)}?offset=${offset}&live=long-poll`);
    offset = res.headers.get("stream-next-offset") ?? offset;
    if (res.status === 204) continue;
    for (const event of (await res.json()) as StreamEvent[]) {
      if (event.type === "submission-settled" && event.submissionId === admission.submissionId) return event;
    }
  }
  throw new Error(`timed out waiting for ${admission.submissionId}`);
}

const toolNames = (call: { tools?: Array<{ function?: { name?: string } }> } | undefined) =>
  (call?.tools ?? []).map((t) => t.function?.name);

const systemText = (call: { messages: Array<Record<string, unknown>> } | undefined) =>
  String((call?.messages ?? []).find((m) => m.role === "system")?.content ?? "");

test("an MCP tool call, then a pick: the call is a step and no pick, the pick delivers, and the tools block is Working, MCP, Menu (ADR-0079, ADR-0029)", async () => {
  provider.reset([
    { toolCall: { id: "call_1", name: "mcp__notes__lookup", args: '{"term":"Gate"}' } },
    { toolCall: { id: "call_2", name: "mcp__jr2__review_verdict", args: '{"verdict":"approved"}' } },
    { text: "Done." },
    { text: "Again." },
  ]);
  sandbox.reset(surface);
  const iid = "conf/mcp-then-pick";
  const first = await settled(iid, await admit(iid, definitions.withNotes!, "Is a Gate defined?"));
  assert.equal(first.outcome, "aborted", "the pick ended the Turn, and no sweep came");

  const names = toolNames(provider.calls[0]);
  assert.deepEqual(names, [
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "glob",
    "mcp__notes__echo",
    "mcp__notes__env",
    "mcp__notes__exit",
    "mcp__notes__lookup",
    "mcp__notes__pid",
    "mcp__notes__read",
    "mcp__jr2__review_verdict",
  ]);
  // The server's answer is the result the model read on the next request.
  const results = provider.calls[1]!.messages.filter((m) => m.role === "tool");
  assert.ok(JSON.stringify(results).includes("notes on Gate: it is defined in GLOSSARY.md"));
  // The MCP call was not a pick: the pick after it delivered, and was not blocked as a second pick.
  assert.deepEqual(sandbox.delivered, [{ type: "review_verdict", verdict: "approved" }]);
  // The standing part says that MCP tools are not picks.
  assert.ok(systemText(provider.calls[0]).includes(MCP_TOOLS_LINE));
  // The log prints the MCP call as `<server>/<tool>`, and the pick by its event's name.
  const log = printed.get(iid) ?? "";
  assert.match(log, /\[notes\/lookup\] \{"term":"Gate"\}/);
  assert.match(log, /\[review_verdict\] \{"verdict":"approved"\}/);
  assert.doesNotMatch(log, /notes on Gate/, "an MCP result does not print");

  // A second Turn of the conversation sends the same tools block and system prompt, byte for byte.
  sandbox.reset(surface);
  const before = provider.calls.length;
  const second = await settled(iid, await admit(iid, definitions.withNotes!, "And now?"));
  assert.equal(second.outcome, "completed");
  const again = provider.calls[before]!;
  assert.equal(JSON.stringify(again.tools), JSON.stringify(provider.calls[0]!.tools));
  assert.equal(systemText(again), systemText(provider.calls[0]));
});

test("an MCP tool's plain JSON Schema is coerced by pi-schema: the server gets the coerced value (pi-ai 1.5)", async () => {
  // pi-ai 1.5 coerces EVERY tool schema with pi-schema, an MCP server's too. On 1.4 `3.5` for an
  // integer and one value for an array were refused, and `null` for a string became `""`. This
  // test locks in the 1.5 behaviour, so a pin bump that moves it fails here.
  provider.reset([
    { toolCall: { id: "call_1", name: "mcp__notes__echo", args: '{"count":3.5,"label":null,"tags":"one"}' } },
    { text: "Done." },
  ]);
  sandbox.reset(surface);
  const iid = "conf/mcp-coerced";
  assert.equal((await settled(iid, await admit(iid, definitions.withNotes!, "Echo it."))).outcome, "completed");
  const results = provider.calls[1]!.messages.filter((m) => m.role === "tool");
  assert.ok(
    JSON.stringify(results).includes(
      JSON.stringify(JSON.stringify({ count: 3, label: "null", tags: ["one"] })).slice(1, -1),
    ),
    `the server got the coerced arguments (got: ${JSON.stringify(results)})`,
  );
  assert.match(printed.get(iid) ?? "", /\[notes\/echo\] \{"count":3\.5,"label":null,"tags":"one"\}/);
});

test("a server that does not answer at the first Turn fails the Turn before the model reads anything (ADR-0079)", async () => {
  provider.reset([{ text: "never reached" }]);
  sandbox.reset(surface);
  const iid = "conf/mcp-no-answer";
  const settlement = await settled(iid, await admit(iid, definitions.withMissing!, "Look it up."));
  assert.equal(settlement.outcome, "failed");
  assert.match(String(settlement.error?.message), /^gone did not answer: spawn \/nonexistent\/mcp-server ENOENT/);
  assert.equal(provider.calls.length, 0, "the model was never asked");
});
