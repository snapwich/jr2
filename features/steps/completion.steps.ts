// Steps for `jr2 completion` (ADR-0009): the script for each shell, and the words that its hidden
// `jr2 completion __complete <words>` answers. The last word is the one the cursor is in: a phrase
// that ends in a space completes a new, empty word. `<run>` in a phrase is the scenario's run id.

import { Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { E2EWorld } from "./world.ts";

When("I ask for the {word} completion script", async function (this: E2EWorld, shell: string): Promise<void> {
  await this.runCli(["completion", shell]);
});

When("I complete the words {string}", async function (this: E2EWorld, phrase: string): Promise<void> {
  const words = phrase.replace("<run>", this.runId ?? "<run>").split(" ");
  const r = await this.runCli(["completion", "__complete", ...words]);
  assert.equal(r.code, 0, r.stderr);
});

const completions = (world: E2EWorld): string[] => (world.last?.stdout ?? "").split("\n").filter((w) => w !== "");

Then("the completions are exactly {string}", function (this: E2EWorld, list: string): void {
  assert.deepEqual(
    completions(this),
    list.split(",").map((w) => w.trim()),
  );
});

Then("the completions are exactly the run's id", function (this: E2EWorld): void {
  assert.deepEqual(completions(this), [this.runId]);
});

Then("the completions include {string} and {string}", function (this: E2EWorld, a: string, b: string): void {
  const got = completions(this);
  assert.ok(got.includes(a) && got.includes(b), JSON.stringify(got));
});

Then("stdout holds {string}", function (this: E2EWorld, needle: string): void {
  assert.ok((this.last?.stdout ?? "").includes(needle), `stdout holds "${needle}": ${this.last?.stdout}`);
});

When("I watch that run as a person reads it", async function (this: E2EWorld): Promise<void> {
  assert.ok(this.runId, "a runId was carried from a prior step");
  await this.runCli(["watch", this.runId]);
});

Then("stdout starts with the attach line of the {string} run", function (this: E2EWorld, wf: string): void {
  const first = (this.last?.stdout ?? "").split("\n")[0];
  assert.equal(first, `run ${this.runId} (${wf}) — attached`);
});
