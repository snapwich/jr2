// Steps for the ADR-0011 mechanics tier: play the AGENT over its MCP surface (`/mcp/<iid>`,
// with the real MCP SDK client — the same wire a Harness-hosted agent speaks) and the HUMAN
// over the gates HTTP API. The run itself is observed black-box via `j2 status`.

import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { E2EWorld } from "./world.ts";

type Status = { runId: string; instanceId: string; status: string; value: unknown };
type Gate = { gate: string; accepts: Array<{ name: string }>; meta?: Record<string, unknown> };

/** `j2 status <runId>` → the machine-readable RunStatus (black-box observation path). */
async function status(world: E2EWorld): Promise<Status> {
  assert.ok(world.runId, "a runId was carried from a prior step");
  const r = await world.runCli(["status", world.runId]);
  assert.equal(r.code, 0, `j2 status failed: ${r.stderr}`);
  return world.resultJson<Status>();
}

/** Poll `j2 status` until the run's state value matches (transitions are asynchronous). */
async function waitForValue(world: E2EWorld, value: string): Promise<Status> {
  let last: Status | undefined;
  for (let i = 0; i < 100; i++) {
    last = await status(world);
    if (last.value === value || last.status === value) return last;
    await sleep(50);
  }
  throw new Error(`run never reached "${value}" (last: ${JSON.stringify(last)})`);
}

/** The run's open gates, from the HTTP discovery listing (`GET /runs/:id` — ADR-0011). */
async function gates(world: E2EWorld): Promise<Gate[]> {
  const res = await fetch(`${world.dev?.url}/runs/${world.runId}`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { gates?: Gate[] }).gates ?? [];
}

/** Connect the real MCP client to the run's agent surface. */
async function connectAgent(world: E2EWorld): Promise<{ client: Client; close: () => Promise<void> }> {
  const s = await status(world);
  const transport = new StreamableHTTPClientTransport(new URL(`${world.dev?.url}/mcp/${s.instanceId}`));
  const client = new Client({ name: "e2e-agent", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

Given("the instance also has the {string} workflow", async function (this: E2EWorld, name: string): Promise<void> {
  await this.addFixtureWorkflow(name);
});

Given(
  "I start the {string} workflow against the stub harness",
  async function (this: E2EWorld, wf: string): Promise<void> {
    assert.ok(this.dev?.stubHarness, "j2 dev advertised its stub harness in dev.json");
    await this.runCli(["run", wf, "--detach", "--input", JSON.stringify({ endpoint: this.dev.stubHarness })]);
    this.runId = this.resultJson<{ runId: string }>().runId;
    assert.ok(this.runId, "run --detach printed a runId");
  },
);

When(
  "the agent calls {string} with summary {string}",
  async function (this: E2EWorld, tool: string, summary: string): Promise<void> {
    const { client, close } = await connectAgent(this);
    try {
      await client.callTool({ name: tool, arguments: { summary } });
    } finally {
      await close();
    }
  },
);

When("I deliver {string} to gate {string}", async function (this: E2EWorld, type: string, gate: string) {
  const res = await fetch(`${this.dev?.url}/runs/${this.runId}/gates/${gate}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type }),
  });
  this.last = { stdout: JSON.stringify(await res.json()), stderr: "", code: res.status };
});

Then("the agent's MCP surface offers exactly {string}", async function (this: E2EWorld, tools: string) {
  const { client, close } = await connectAgent(this);
  try {
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(
      listed,
      tools
        .split(",")
        .map((t) => t.trim())
        .sort(),
    );
  } finally {
    await close();
  }
});

Then("the agent's MCP surface is gone", async function (this: E2EWorld): Promise<void> {
  // The invoking state exited, so the registration — and with it the endpoint — is gone.
  await assert.rejects(() => connectAgent(this), /404|no live agent surface|HTTP/i);
});

Then("the run's status shows state {string}", async function (this: E2EWorld, value: string) {
  await waitForValue(this, value);
});

Then("the run's status shows {string}", async function (this: E2EWorld, terminal: string) {
  const s = await waitForValue(this, terminal);
  assert.equal(s.status, terminal);
});

Then(
  "the run's status lists gate {string} accepting {string} with meta summary {string}",
  async function (this: E2EWorld, gateId: string, accepts: string, summary: string): Promise<void> {
    await waitForValue(this, "humanReview");
    const open = await gates(this);
    const g = open.find((x) => x.gate === gateId);
    assert.ok(g, `gate "${gateId}" is listed (got: ${JSON.stringify(open)})`);
    assert.deepEqual(
      g.accepts.map((a) => a.name).sort(),
      accepts
        .split(",")
        .map((a) => a.trim())
        .sort(),
    );
    assert.equal(g.meta?.summary, summary);
  },
);

Then("gate {string} is gone", async function (this: E2EWorld, gateId: string): Promise<void> {
  const open = await gates(this);
  assert.ok(!open.some((g) => g.gate === gateId), `gate "${gateId}" must be destroyed with its state`);
});

Then("the run faults mentioning {string}", async function (this: E2EWorld, needle: string): Promise<void> {
  const s = (await waitForValue(this, "error")) as Status & { fault?: string };
  assert.match(s.fault ?? "", new RegExp(needle));
});

Then("the delivery is refused naming the accepted events", function (this: E2EWorld): void {
  assert.equal(this.last?.code, 400);
  assert.match(this.last?.stdout ?? "", /accepts: approve/);
});
