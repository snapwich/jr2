// Steps for the ADR-0011 mechanics tier: drive the two delivery surfaces the Orchestrator serves —
// `/agents/<iid>/*` (the AGENT's, as its Adapter speaks it) and `/runs/:id/gates/*` (the HUMAN's).
// The run itself is observed black-box via `j2 status`.
//
// These steps used to open an MCP client to `/mcp/<iid>`. That surface is gone from the Orchestrator
// (ADR-0013): MCP now lives in the Adapter, inside the Sandbox. So what these steps play is the
// ADAPTER, not an Agent — which is what they were always really doing, since there was never a pod
// here (this tier is workspace-less: the Agent admits against the host's stub Harness). The tier
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

// The same start, with the one input the `guarded` fixture's context guard reads (ADR-0029) — so a
// scenario can put the run on either side of that guard without driving it there first.
Given(
  "I start the {string} workflow against the stub harness with {int} attempts",
  async function (this: E2EWorld, wf: string, attempts: number): Promise<void> {
    const endpoint = await this.stubHarnessUrl();
    await this.runCli(["run", wf, "--detach", "--input", JSON.stringify({ endpoint, attempts })]);
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

// A pick the Agent is allowed to make and the Machine declines to act on (ADR-0029). The delivery
// still succeeds — it was well-formed and it arrived — so the outcome is on the RECEIPT, which is
// the only thing the Agent gets to read.
When(
  "the agent calls {string} with summary {string} and is told it moved nothing",
  async function (this: E2EWorld, tool: string, summary: string): Promise<void> {
    const s = await status(this);
    const res = await fetch(`${this.server?.url}/agents/${s.instanceId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ type: tool, summary }),
    });
    const body = (await res.json()) as { moved?: boolean; turnComplete?: boolean; error?: string };
    assert.equal(res.status, 200, `the delivery was accepted (got: ${body.error})`);
    assert.equal(body.moved, false, "no transition accepted it");
    assert.equal(body.turnComplete, false, "…which is not the same claim as the turn being over");
  },
);

// The redeploy, played honestly: the orchestrator goes away, the workflow's CODE changes under the
// same name, and a new process comes up on the same store — exactly `j2 up` after an edit, minus
// the cluster (ADR-0030). Sequential on purpose; the store brooks one writer.
When(
  "the {string} workflow is replaced with the {string} fixture and the orchestrator restarts",
  async function (this: E2EWorld, name: string, fixture: string): Promise<void> {
    await this.stopServer();
    await this.installFixtureWorkflow(fixture, name);
    await this.startServer();
  },
);

Then("the boot reports the run as drifted", function (this: E2EWorld): void {
  // Not merely discoverable by asking after a run id — announced, because nobody knows to ask.
  assert.deepEqual(this.announced?.drifted, [this.runId], "the announce line names the refused run");
  assert.equal(this.announced?.failed, undefined, "a shape change is a verdict, not an error");
});

When("I cancel the run", async function (this: E2EWorld): Promise<void> {
  const r = await this.runCli(["send", this.runId!, "--event", "CANCEL"]);
  assert.equal(r.code, 0, `j2 send CANCEL failed: ${r.stderr}`);
});

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

// A refused run is still a READABLE run — the difference from `lost`, which nulls the snapshot and
// so answers `no run "<id>"`, indistinguishable from one that never existed (ADR-0030).
Then(
  "the run reads as drifted, still parked at {string}, and says why",
  async function (this: E2EWorld, value: string): Promise<void> {
    const r = await this.runCli(["status", this.runId!]);
    assert.equal(r.code, 0, `j2 status on a drifted run must still succeed: ${r.stderr}`);
    const s = this.resultJson<{ status: string; value: unknown; reason?: string }>();
    assert.equal(s.status, "drifted");
    assert.equal(s.value, value, "kept exactly where it was — nothing was interpreted");
    assert.match(s.reason ?? "", /changed shape/, "and the refusal explains itself");
  },
);

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

// What each Turn was admitted to RUN (ADR-0049): the definition rides the admission, so the stub
// can report which persona a state actually ran — the only place, short of a real Harness, where a
// customized definition is observable from outside.
Then(
  "the stub Harness was asked to run {string} at models {string}",
  async function (this: E2EWorld, agentName: string, models: string): Promise<void> {
    const want = models.split(",").map((m) => m.trim());
    let seen: string[] = [];
    for (let i = 0; i < 100; i++) {
      seen = this.stubAdmissions()
        .filter((a) => a.agentName === agentName)
        .map((a) => String((a.definition as { model?: unknown } | undefined)?.model))
        .sort();
      if (seen.length >= want.length) break;
      await sleep(50);
    }
    assert.deepEqual(seen, [...want].sort(), "one admission per invoking Machine, each with its own definition");
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
