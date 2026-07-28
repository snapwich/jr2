// Steps for the ADR-0011 mechanics tier: drive the two delivery surfaces the Orchestrator serves —
// `/agents/<iid>/*` (the AGENT's, as its Adapter speaks it) and `/runs/:id/gates/*` (the HUMAN's).
// The run itself is observed black-box via `j2 status`.
//
// These steps used to open an MCP client to `/mcp/<iid>`. That surface is gone from the Orchestrator
// (ADR-0013): MCP now lives in the Adapter, inside the Sandbox. So what these steps play is the
// ADAPTER, not an Agent — which is what they were always really doing, since there was never a pod
// here (this tier is workspace-less: `agentRun` admits against the host's stub Harness). The tier
// that makes a real Agent originate a real MCP call is `@kind`, where there is a real pod to do it.
//
// They carry the INSTANCE token, not a Sandbox token: these registrations belong to no Sandbox, and
// a Sandbox token is scoped to one. The credential is the fixture server's Instance token.

import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { E2EWorld } from "./world.ts";

type Status = { runId: string; instanceId: string; status: string; value: unknown };
type Gate = { gate: string; accepts: Array<{ name: string }>; meta?: Record<string, unknown> };
type Surface = { accepts: Array<{ name: string }> };

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
  const res = await fetch(`${world.server?.url}/runs/${world.runId}`, { headers: world.authHeaders() });
  assert.equal(res.status, 200);
  return ((await res.json()) as { gates?: Gate[] }).gates ?? [];
}

/** `GET /agents/:iid/surface` — what the Adapter would render as this turn's `tools/list`. */
async function agentSurface(world: E2EWorld): Promise<Response> {
  const s = await status(world);
  return fetch(`${world.server?.url}/agents/${s.instanceId}/surface`, { headers: world.authHeaders() });
}

Given("the instance also has the {string} workflow", async function (this: E2EWorld, name: string): Promise<void> {
  await this.addFixtureWorkflow(name);
});

Given(
  "I start the {string} workflow against the stub harness",
  async function (this: E2EWorld, wf: string): Promise<void> {
    const endpoint = await this.stubHarnessUrl();
    await this.runCli(["run", wf, "--detach", "--input", JSON.stringify({ endpoint })]);
    this.runId = this.resultJson<{ runId: string }>().runId;
    assert.ok(this.runId, "run --detach printed a runId");
  },
);

// What a `tools/call` becomes once the Adapter has translated it: one delivery, into the state that
// invoked the Agent.
When(
  "the agent calls {string} with summary {string}",
  async function (this: E2EWorld, tool: string, summary: string): Promise<void> {
    const s = await status(this);
    const res = await fetch(`${this.server?.url}/agents/${s.instanceId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ type: tool, summary }),
    });
    const body = (await res.json()) as { deliveryId?: string; error?: string };
    assert.equal(res.status, 200, `the delivery was accepted (got: ${body.error})`);
    // Every delivery answers with an addressable receipt (ADR-0013).
    assert.ok(body.deliveryId, "a delivery answers with a receipt");
  },
);

When("I deliver {string} to gate {string}", async function (this: E2EWorld, type: string, gate: string) {
  const res = await fetch(`${this.server?.url}/runs/${this.runId}/gates/${gate}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", ...this.authHeaders() },
    body: JSON.stringify({ type }),
  });
  this.last = { stdout: JSON.stringify(await res.json()), stderr: "", code: res.status };
});

Then("the agent's surface offers exactly {string}", async function (this: E2EWorld, tools: string) {
  const res = await agentSurface(this);
  assert.equal(res.status, 200);
  const listed = ((await res.json()) as Surface).accepts.map((a) => a.name).sort();
  assert.deepEqual(
    listed,
    tools
      .split(",")
      .map((t) => t.trim())
      .sort(),
  );
});

Then("the agent's surface is gone", async function (this: E2EWorld): Promise<void> {
  // The invoking state exited, so the registration — and with it the whole surface — is gone. This
  // is what the Adapter sees when a turn is over: not an empty menu, but no menu.
  assert.equal((await agentSurface(this)).status, 404);
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

/**
 * What the HARNESS says became of the Agent's turn (ADR-0024). The Orchestrator cannot answer this
 * — it aborts from an already-stopped actor and never observes the settlement — so the claim is
 * checked where it is true: the stub Harness's own conversation history, over its own wire.
 */
Then(
  "the stub Harness reports the Agent's turn settled as {string}",
  async function (this: E2EWorld, outcome: string): Promise<void> {
    const iid = (await status(this)).instanceId;
    const url = `${await this.stubHarnessUrl()}/agents/coder/${encodeURIComponent(iid)}?view=history`;
    let settlements: Array<{ outcome: string }> = [];
    for (let i = 0; i < 100; i++) {
      const res = await fetch(url);
      assert.equal(res.status, 200);
      settlements = ((await res.json()) as { settlements?: Array<{ outcome: string }> }).settlements ?? [];
      if (settlements.length > 0) break;
      await sleep(50);
    }
    assert.deepEqual(
      settlements.map((s) => s.outcome),
      [outcome],
      "the submission the state stopped waiting for is over, at the Harness",
    );
  },
);

Then("the run faults mentioning {string}", async function (this: E2EWorld, needle: string): Promise<void> {
  const s = (await waitForValue(this, "error")) as Status & { fault?: string };
  assert.match(s.fault ?? "", new RegExp(needle));
});

Then("the delivery is refused naming the accepted events", function (this: E2EWorld): void {
  assert.equal(this.last?.code, 400);
  assert.match(this.last?.stdout ?? "", /accepts: approve/);
});
