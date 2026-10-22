// Steps for the `dispatch` Effect in the mechanics tier (ADR-0071): a run that starts a run in this
// Orchestrator's own process. The caller is the `dispatcher` fixture, the callee `intake`. Both
// runs are observed black-box, the way a user sees them — `jr2 status`, `jr2 runs`, `jr2 send` —
// and the door's idempotency key is driven by HTTP, because only a foreign caller sends it and no
// verb does (`jr2 run` sends no `jr2-dispatched-by` header).

import { Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DISPATCHED_BY_HEADER } from "@jr2/orchestrator/internal";
import { E2EWorld } from "./world.ts";

type DispatchedBy = { run: string; slot: string; effect?: string; depth: number; instance?: string };
type Status = {
  runId: string;
  workflow: string;
  status: string;
  value: unknown;
  output?: Record<string, unknown>;
  dispatchedBy?: DispatchedBy;
};
type Started = { runId: string; instanceId: string; existing?: boolean };

/** What a scenario carries between steps: the caller is `world.runId`; these are the rest. */
type Carried = { callee?: string; starts?: Array<{ status: number; body: Started }> };
const carried = new WeakMap<E2EWorld, Carried>();
const carry = (world: E2EWorld): Carried => {
  let c = carried.get(world);
  if (!c) carried.set(world, (c = {}));
  return c;
};

/** `jr2 status <id>`, as the one machine-readable result. */
async function statusOf(world: E2EWorld, runId: string): Promise<Status> {
  const r = await world.runCli(["status", runId]);
  assert.equal(r.code, 0, `jr2 status ${runId} failed: ${r.stderr}`);
  return world.resultJson<Status>();
}

/** The live runs, as `jr2 runs` prints them. */
async function liveRuns(world: E2EWorld): Promise<Status[]> {
  const r = await world.runCli(["runs"]);
  assert.equal(r.code, 0, `jr2 runs failed: ${r.stderr}`);
  return world.resultJson<Status[]>();
}

/** A run is live while its status is xstate's `active` (the store's `live`). */
const isLive = (s: Status): boolean => s.status === "active" || s.status === "live";

/** Poll a run until it is no longer live. */
async function settled(world: E2EWorld, runId: string): Promise<Status> {
  let last: Status | undefined;
  for (let i = 0; i < 200; i++) {
    last = await statusOf(world, runId);
    if (!isLive(last)) return last;
    await sleep(50);
  }
  throw new Error(`run ${runId} never settled (last: ${JSON.stringify(last)})`);
}

/** The run the dispatcher started, found the way a user finds it: in `jr2 runs`, by the caller it
 * names. Polled, since the Effect starts it a moment after the caller's own start answered. */
async function dispatchedRun(world: E2EWorld): Promise<Status> {
  const caller = world.runId;
  assert.ok(caller, "the dispatcher was started");
  for (let i = 0; i < 200; i++) {
    const found: Status[] = (await liveRuns(world)).filter((r) => r.dispatchedBy?.run === caller);
    assert.ok(found.length <= 1, `one dispatch is one run: ${JSON.stringify(found)}`);
    if (found[0]) {
      const c = carry(world);
      if (c.callee) assert.equal(found[0].runId, c.callee, "the run the dispatcher started is the same run");
      c.callee = found[0].runId;
      return found[0];
    }
    await sleep(50);
  }
  throw new Error(`no live run names ${caller} as its dispatcher`);
}

/** The dispatcher's output — the Effect's, which the fixture copies through. */
async function dispatcherOutput(world: E2EWorld): Promise<Record<string, unknown>> {
  const s = await settled(world, world.runId!);
  assert.equal(s.status, "done", `the dispatcher settled ${s.status}: ${JSON.stringify(s)}`);
  assert.ok(s.output, `a settled run serves its Machine's output (ADR-0071): ${JSON.stringify(s)}`);
  return s.output;
}

// --- actions -------------------------------------------------------------------------------------

When("the dispatcher starts with {string}", async function (this: E2EWorld, input: string): Promise<void> {
  const r = await this.runCli(["run", "dispatcher", "--detach", "--input", input]);
  assert.equal(r.code, 0, `jr2 run dispatcher failed: ${r.stderr}`);
  this.runId = this.resultJson<{ runId: string }>().runId;
});

When("the dispatched run is live", async function (this: E2EWorld): Promise<void> {
  await dispatchedRun(this);
});

When(
  "the dispatched run's {string} Gate takes the note {string}",
  async function (this: E2EWorld, gate: string, note: string): Promise<void> {
    const callee = (await dispatchedRun(this)).runId;
    const r = await this.runCli(["send", callee, "--gate", gate, "--event", gate, "--input", JSON.stringify({ note })]);
    assert.equal(r.code, 0, `jr2 send to the dispatched run failed: ${r.stderr}`);
  },
);

When("I cancel the dispatcher", async function (this: E2EWorld): Promise<void> {
  const r = await this.runCli(["send", this.runId!, "--event", "CANCEL"]);
  assert.equal(r.code, 0, `jr2 send CANCEL failed: ${r.stderr}`);
});

When("the dispatcher is parked on its {string} Gate", async function (this: E2EWorld, gate: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const s = await statusOf(this, this.runId!);
    if (s.value === "holding") return;
    await sleep(50);
  }
  throw new Error(`the dispatcher never parked on its "${gate}" Gate`);
});

When("the dispatcher's {string} Gate is answered", async function (this: E2EWorld, gate: string): Promise<void> {
  const r = await this.runCli(["send", this.runId!, "--gate", gate, "--event", gate]);
  assert.equal(r.code, 0, `jr2 send to the dispatcher's Gate failed: ${r.stderr}`);
});

/** A publish that drops Workflows a live run holds: the run keeps its Assembly (ADR-0069), and the
 * new one is current for every start after it. */
When(
  "I publish an Assembly without {string} and {string}",
  async function (this: E2EWorld, a: string, b: string): Promise<void> {
    for (const name of [a, b]) await rm(join(this.dir, "workflows", `${name}.ts`));
    await this.publish();
  },
);

When("the orchestrator boots and I publish the Assembly", async function (this: E2EWorld): Promise<void> {
  await this.bootServer();
  await this.publish({ expectRefusal: true });
});

/** A foreign caller's start, sent twice with one key: what an Instance Effector does when it cannot
 * tell whether its first start arrived (ADR-0071). */
When(
  "I start {string} twice by HTTP with one dispatch key from instance {string}",
  async function (this: E2EWorld, workflow: string, instance: string): Promise<void> {
    assert.ok(this.server, "the orchestrator is serving");
    const by = { run: randomUUID(), slot: "watch", effect: randomUUID(), depth: 1, instance };
    const starts: Array<{ status: number; body: Started }> = [];
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${this.server.url.replace(/\/+$/, "")}/workflows/${encodeURIComponent(workflow)}/runs`, {
        method: "POST",
        headers: {
          ...this.authHeaders(),
          "content-type": "application/json",
          [DISPATCHED_BY_HEADER]: JSON.stringify(by),
        },
        body: JSON.stringify({ subject: "sent twice" }),
      });
      starts.push({ status: res.status, body: (await res.json()) as Started });
    }
    carry(this).starts = starts;
  },
);

// --- assertions ----------------------------------------------------------------------------------

Then(
  "the dispatcher settles {string} with the outcome {string}",
  async function (this: E2EWorld, status: string, outcome: string): Promise<void> {
    const s = await settled(this, this.runId!);
    assert.equal(s.status, status, `the dispatcher settled ${s.status}: ${JSON.stringify(s)}`);
    assert.equal(s.output?.outcome, outcome, `the Effect's output: ${JSON.stringify(s.output)}`);
  },
);

Then(
  "`jr2 runs` lists the dispatched run as dispatched by the dispatcher's {string} slot at depth {int}",
  async function (this: E2EWorld, slot: string, depth: number): Promise<void> {
    const run = await dispatchedRun(this);
    assert.equal(run.workflow, "intake");
    assert.equal(run.dispatchedBy?.slot, slot);
    assert.equal(run.dispatchedBy?.depth, depth, "a root run is depth 0, the run it dispatches depth 1");
    assert.equal(run.dispatchedBy?.instance, undefined, "an in-process caller names no other Instance");
    assert.ok(run.dispatchedBy?.effect, "the Instance band shows the key: the caller's ledger row id");
  },
);

Then("the dispatcher's output names the dispatched run", async function (this: E2EWorld): Promise<void> {
  const output = await dispatcherOutput(this);
  assert.equal(output.run, carry(this).callee, "the Effect settled with the run it started");
});

Then(
  "`jr2 status` of the dispatched run says it was dispatched by the dispatcher",
  async function (this: E2EWorld): Promise<void> {
    const callee = carry(this).callee;
    assert.ok(callee, "the dispatched run was found");
    const s = await statusOf(this, callee);
    assert.equal(s.dispatchedBy?.run, this.runId);
    assert.match(
      this.last?.stderr ?? "",
      new RegExp(`dispatched by: ${this.runId} \\(intake\\), depth 1`),
      "the activity line names the caller, its slot and the depth",
    );
  },
);

Then(
  "the dispatcher's output is the dispatched run's: status {string}, subject {string} and note {string}",
  async function (this: E2EWorld, status: string, subject: string, note: string): Promise<void> {
    const output = await dispatcherOutput(this);
    const callee = carry(this).callee;
    assert.equal(output.run, callee, "the Effect waited on the run it started");
    assert.equal(output.status, status, "the callee's status, in the store's words");
    assert.deepEqual(output.output, { subject, note }, "the callee Machine's own output");
    const s = await statusOf(this, callee!);
    assert.equal(s.status, status);
    assert.deepEqual(s.output, { subject, note }, "GET /runs/<id> serves a settled run's output");
  },
);

/** The callee seen before the restart is the one the wait settled on, and no second `intake` is
 * left live: a second start would have parked on its `finish` Gate, where nothing answers it. The
 * callee is on the caller's row before the restart (the step that sees it live polls until then),
 * so the restore resumes the wait on the run the row names and sends no start; the restore that
 * finds the run by its key alone is the unit tier's (dispatch-effect.test.ts). */
Then("the dispatcher started exactly one run", async function (this: E2EWorld): Promise<void> {
  const output = await dispatcherOutput(this);
  assert.equal(output.run, carry(this).callee);
  const left = (await liveRuns(this)).filter((r) => r.workflow === "intake");
  assert.deepEqual(left, [], "the restore resumed the wait on the run its row names, and started no second run");
});

Then("the dispatcher's status is {string}", async function (this: E2EWorld, status: string): Promise<void> {
  const s = await settled(this, this.runId!);
  assert.equal(s.status, status);
});

Then("the dispatched run is still live", async function (this: E2EWorld): Promise<void> {
  const callee = carry(this).callee;
  assert.ok(callee, "the dispatched run was found");
  // Read after the caller settled, and again a moment later: a cancel that reached the callee would
  // land within that window.
  await sleep(250);
  const s = await statusOf(this, callee);
  assert.ok(isLive(s), `the caller's cancel never cancels the run it started: ${s.status}`);
  assert.equal(s.value, "working");
});

Then("the dispatched run's status is {string}", async function (this: E2EWorld, status: string): Promise<void> {
  const s = await settled(this, carry(this).callee!);
  assert.equal(s.status, status);
});

Then(
  "the refusal has status {int} and its report names {string}",
  async function (this: E2EWorld, status: number, needle: string): Promise<void> {
    const output = await dispatcherOutput(this);
    assert.equal(output.outcome, "refused");
    assert.equal(output.status, status, JSON.stringify(output));
    const report = (output.report as string[] | undefined) ?? [];
    assert.ok(report.join("\n").includes(needle), `the report names "${needle}": ${JSON.stringify(report)}`);
  },
);

Then("no run of {string} was started", async function (this: E2EWorld, workflow: string): Promise<void> {
  const found = (await liveRuns(this)).filter((r) => r.workflow === workflow);
  assert.deepEqual(found, [], "a refused start starts nothing");
});

Then(
  "the first start answered 201 and the second 200 naming the same run as existing",
  function (this: E2EWorld): void {
    const [first, second] = carry(this).starts ?? [];
    assert.ok(first && second, "two starts were sent");
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.ok(first.body.runId, "the first start names its run");
    assert.equal(first.body.existing, undefined, "a new run is not an existing one");
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.runId, first.body.runId, "the key answers with the run it started");
    assert.equal(second.body.existing, true);
    carry(this).callee = first.body.runId;
  },
);

Then(
  "`jr2 runs` lists exactly one run of {string}, dispatched from instance {string}",
  async function (this: E2EWorld, workflow: string, instance: string): Promise<void> {
    const found = (await liveRuns(this)).filter((r) => r.workflow === workflow);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0]!.runId, carry(this).callee);
    assert.equal(found[0]!.dispatchedBy?.instance, instance, "a foreign caller's Instance, as opaque text");
    assert.equal(found[0]!.dispatchedBy?.depth, 1, "the host records the depth as sent");
  },
);
