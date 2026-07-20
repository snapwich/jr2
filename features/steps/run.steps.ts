// Action + assertion steps for the run-control verbs (`run`, `runs`, `status`) and the generic output
// contract (stdout = the one machine-readable result, stderr = human activity, plus the exit code).

import { When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
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

Then("the status is {string}", function (this: E2EWorld, status: string): void {
  assert.equal(this.resultJson<RunStatus>().status, status);
});

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
