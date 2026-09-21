// Action + assertion steps for the run-control verbs (`run`, `runs`, `status`) and the generic output
// contract (stdout = the one machine-readable result, stderr = human activity, plus the exit code).

import { When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { E2EWorld } from "./world.ts";

type RunStatus = { runId: string; status: string; context: { reply?: string } };

// --- actions -------------------------------------------------------------------------------------

When("I run {string} with message {string}", async function (this: E2EWorld, wf: string, message: string) {
  await this.runCli(["run", wf, "--input", JSON.stringify({ message })]);
  this.runId = this.resultJson<RunStatus>().runId; // blocking run prints the terminal RunStatus
});

When("I run {string} detached", async function (this: E2EWorld, wf: string): Promise<void> {
  await this.runCli(["run", wf, "--detach"]);
});

When("I start the {string} workflow detached", async function (this: E2EWorld, wf: string): Promise<void> {
  await this.runCli(["run", wf, "--detach"]);
  this.runId = this.resultJson<{ runId: string }>().runId;
});

When("I list the runs", async function (this: E2EWorld): Promise<void> {
  await this.runCli(["runs"]);
});

When("I check the status of that run", async function (this: E2EWorld): Promise<void> {
  assert.ok(this.runId, "a runId was carried from a prior step");
  await this.runCli(["status", this.runId]);
});

When("I check the status of that run by its first {int} characters", async function (this: E2EWorld, n: number) {
  assert.ok(this.runId, "a runId was carried from a prior step");
  await this.runCli(["status", this.runId.slice(0, n)]);
});

When("I check the status of run id {string}", async function (this: E2EWorld, runId: string): Promise<void> {
  await this.runCli(["status", runId]);
});

When("I run an unknown command", async function (this: E2EWorld): Promise<void> {
  await this.runCli(["frobnicate"]);
});

/** A start with a caller-chosen payload — what the workflow's declared input schema judges
 * (ADR-0033). Detached: the refusal is the door's, and there is no feed to attach to. */
When("I start {string} with input {string}", async function (this: E2EWorld, wf: string, input: string) {
  await this.runCli(["run", wf, "--detach", "--input", input]);
});

/** `jr2 logs <runId>` with no `-f`: the feed replays the run's current status on attach, and the
 * verb prints that and stops — on a settled run, its terminal status, once. */
When("I read the logs of that run", async function (this: E2EWorld): Promise<void> {
  assert.ok(this.runId, "a runId was carried from a prior step");
  await this.runCli(["logs", this.runId]);
});

/**
 * `jr2 logs -f` on a LIVE run, ended from outside: the follow is started and left running, the run
 * is cancelled by a second invocation, and the follow must then print the settled status and
 * exit on its own. The two invocations overlap on purpose — that is what "follows until it
 * settles" means — and `last` is the follow's, assigned after both are done.
 */
When("I follow the logs of that run while it is cancelled", async function (this: E2EWorld): Promise<void> {
  assert.ok(this.runId, "a runId was carried from a prior step");
  const following = this.runCli(["logs", this.runId, "-f"]);
  // Let the follow attach before the run ends, so what it sees is a delta and not only a replay;
  // either way the assertion holds, since a settled run streams its final status once.
  await sleep(500);
  const cancel = await this.runCli(["send", this.runId, "--event", "CANCEL"]);
  assert.equal(cancel.code, 0, `jr2 send CANCEL failed: ${cancel.stderr}`);
  this.last = await following;
});

/** `jr2 status` with NO run names the instance (ADR-0048/0051): its data-plane switch and the
 * per-node state of every Repo resource — the report a human asks for when a Repo will not clone.
 * A REPORT verb (ADR-0009 as amended): `--json` for the object the assertion reads. */
When("I ask for the instance's status", async function (this: E2EWorld): Promise<void> {
  await this.runCli(["status", "--json"]);
});

// --- assertions ----------------------------------------------------------------------------------

Then("the run reaches {string} on stderr", function (this: E2EWorld, state: string): void {
  assert.match(this.last?.stderr ?? "", new RegExp(`→ ${state}\\b`), "status delta streamed to stderr");
});

Then("stdout is the terminal status with reply {string}", function (this: E2EWorld, reply: string): void {
  const s = this.resultJson<RunStatus>();
  assert.equal(s.status, "done");
  assert.equal(s.context.reply, reply);
});

Then("stdout is a bare runId", function (this: E2EWorld): void {
  const printed = this.resultJson<{ runId?: string }>();
  assert.ok(printed.runId, "detach prints the runId");
  assert.deepEqual(Object.keys(printed), ["runId"], "and nothing else");
});

Then("the run appears in the runs list", function (this: E2EWorld): void {
  const list = this.resultJson<Array<{ runId: string }>>();
  assert.ok(
    list.some((r) => r.runId === this.runId),
    "the live run is listed",
  );
});

/** The data plane is read off the registered Machines (ADR-0051), not off config: an instance
 * none of whose Machines compose a Sandbox has none, and says so rather than listing zero Repos. */
Then("it reports no data plane", async function (this: E2EWorld): Promise<void> {
  assert.equal(this.last?.code, 0, `jr2 status failed: ${this.last?.stderr}`);
  const report = this.resultJson<{ dataPlane: boolean; repos: unknown[] }>();
  assert.equal(report.dataPlane, false, "no registered Machine composes a Sandbox");
  assert.deepEqual(report.repos, [], "and there are no Repo resources to report");
  // And the table, the form without `--json`: the answer is spelled out, not left as an empty list.
  const table = await this.runCli(["status"]);
  assert.equal(table.code, 0, `jr2 status failed: ${table.stderr}`);
  assert.match(table.stdout, /no data plane/, "the table says so in words");
  assert.doesNotMatch(table.stdout, /^\{/, "a report verb prints no JSON without --json");
});

Then("the status is {string}", function (this: E2EWorld, status: string): void {
  assert.equal(this.resultJson<RunStatus>().status, status);
});

/** A drifted run is kept and readable by id (ADR-0030), but it is not LIVE: `jr2 runs` lists the
 * runs the host resumed, and a refused one was never registered. */
Then("the run is absent from the runs list", async function (this: E2EWorld): Promise<void> {
  assert.ok(this.runId, "a runId was carried from a prior step");
  const r = await this.runCli(["runs"]);
  assert.equal(r.code, 0, `jr2 runs failed: ${r.stderr}`);
  const list = this.resultJson<Array<{ runId: string }>>();
  assert.ok(!list.some((run) => run.runId === this.runId), "a run the boot refused is not a live run");
});

/** The last status line the follow printed — a `-f` prints one per delta and ends on the
 * settled one, so the terminal line is the run's end. */
Then("the last status printed is {string}", function (this: E2EWorld, status: string): void {
  assert.equal(this.resultJson<RunStatus>().status, status);
});

/** The door's refusal (ADR-0033), as the CLI relays it: the workflow by name, and the field the
 * declared schema rejected — the same words `POST /workflows/:name/runs` answers 400 with. */
Then(
  "stderr refuses the input for workflow {string} naming {string}",
  function (this: E2EWorld, wf: string, field: string): void {
    assert.match(this.last?.stderr ?? "", new RegExp(`error: invalid input for workflow "${wf}"`));
    assert.match(this.last?.stderr ?? "", new RegExp(field), "the refusal names what the schema expected");
  },
);

Then("the reply is {string}", function (this: E2EWorld, reply: string): void {
  assert.equal(this.resultJson<RunStatus>().context.reply, reply);
});

Then("the command exits {int}", function (this: E2EWorld, code: number): void {
  assert.equal(this.last?.code, code);
});

Then("stderr reports an error", function (this: E2EWorld): void {
  assert.match(this.last?.stderr ?? "", /error:/);
});

// A usage complaint, not a runtime `error:` — the argument itself is malformed, so nothing was asked
// of the orchestrator. That split is what the 2-vs-1 exit code carries.
Then("stderr says the run id is too short", function (this: E2EWorld): void {
  assert.match(this.last?.stderr ?? "", /too short/);
});

Then("stderr reports an unknown command", function (this: E2EWorld): void {
  assert.match(this.last?.stderr ?? "", /unknown command/);
});
