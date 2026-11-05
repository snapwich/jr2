// A Gate's look (ADR-0011), driven black-box: the `looked` fixture's look reads a file whose path the
// run's input names, and the steps write the fact into it — before the run starts, while the run
// waits, or while the Orchestrator is down.

import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { E2EWorld } from "./world.ts";

/** The fact file of the scenario: in the instance's own temp folder, removed with it. */
const factFile = (world: E2EWorld): string => join(world.dir, "fact.txt");

Given("the fact says {string}", async function (this: E2EWorld, fact: string): Promise<void> {
  await writeFile(factFile(this), `${fact}\n`);
});

When("the fact comes to say {string}", async function (this: E2EWorld, fact: string): Promise<void> {
  await writeFile(factFile(this), `${fact}\n`);
});

When("I start the {string} workflow over the fact", async function (this: E2EWorld, wf: string): Promise<void> {
  const r = await this.runCli(["run", wf, "--detach", "--input", JSON.stringify({ file: factFile(this) })]);
  assert.equal(r.code, 0, `jr2 run failed: ${r.stderr}`);
  this.runId = this.resultJson<{ runId: string }>().runId;
  assert.ok(this.runId, "run --detach printed a runId");
});

When("the host-booted orchestrator stops", async function (this: E2EWorld): Promise<void> {
  await this.stopServer();
});

When("the host-booted orchestrator boots again", async function (this: E2EWorld): Promise<void> {
  await this.bootServer();
});

Then("no Caller answered the run", async function (this: E2EWorld): Promise<void> {
  const r = await this.runCli(["status", this.runId!]);
  assert.equal(r.code, 0, `jr2 status failed: ${r.stderr}`);
  const status = this.resultJson<{ answers?: unknown[] }>();
  assert.deepEqual(status.answers ?? [], [], "a looked event has the Gate as its Sender and no Caller");
});
