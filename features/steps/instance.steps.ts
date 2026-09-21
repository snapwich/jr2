// Setup steps: bring an instance into the state a scenario needs — scaffolded, optionally carrying a
// long-running workflow, and (when required) actually serving an orchestrator on an ephemeral port.

import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { E2EWorld } from "./world.ts";

/** The number this checkout's CLI carries — what `cli:` must print, and what the fixture's
 * orchestrator answers on `/healthz` (one release train, ADR-0019). */
async function checkoutVersion(): Promise<string> {
  const manifest = new URL("../../packages/cli/package.json", import.meta.url);
  return (JSON.parse(await readFile(manifest, "utf8")) as { version: string }).version;
}

Given("a fresh instance", async function (this: E2EWorld): Promise<void> {
  await this.init();
});

Given("the instance also has a long-running workflow", async function (this: E2EWorld): Promise<void> {
  await this.addLoopWorkflow();
});

// Phrased as a When or an And/Given depending on the Rule — Cucumber matches on text,
// not keyword, so one definition serves every use.
When("the orchestrator is serving", async function (this: E2EWorld): Promise<void> {
  await this.startServer();
  assert.ok(this.server?.url, "the server entrypoint announced a url");
});

// --- jr2 version (ADR-0009 as amended) -----------------------------------------------------------

When("I ask for the version", async function (this: E2EWorld): Promise<void> {
  await this.runCli(["version"]);
});

When("I ask for the version as JSON", async function (this: E2EWorld): Promise<void> {
  await this.runCli(["version", "--json"]);
});

Then("the version table names this CLI and the serving orchestrator", async function (this: E2EWorld): Promise<void> {
  const v = (await checkoutVersion()).replace(/\./g, "\\.");
  const out = this.last?.stdout ?? "";
  assert.match(out, new RegExp(`^cli:\\s+${v}\\s+\\S+$`, "m"), "the copy that runs, with its real path");
  assert.match(out, new RegExp(`^orchestrator:\\s+${v}\\b`, "m"), "what the fixture's orchestrator says it is");
  assert.match(out, /^node:\s+v\d+/m);
  assert.doesNotMatch(out, /^\{/, "a report verb prints no JSON without --json");
});

Then("the version table says the kit is this checkout's", async function (this: E2EWorld): Promise<void> {
  const v = (await checkoutVersion()).replace(/\./g, "\\.");
  assert.match(
    this.last?.stdout ?? "",
    new RegExp(`^kit:\\s+${v}\\s+\\S+\\s+ok$`, "m"),
    "the instance under the checkout resolves the workspace's orchestrator — one copy, ADR-0056",
  );
  assert.doesNotMatch(this.last?.stderr ?? "", /Kit version mismatch/, "a report, never the refusal");
});

Then("the version report's orchestrator is the CLI's own version", async function (this: E2EWorld): Promise<void> {
  const report = this.resultJson<{
    cli: { version: string; path: string };
    kit?: { check: string };
    deployed?: { url?: string; orchestrator?: { version?: string; error?: string } };
    skew: string;
  }>();
  assert.equal(report.cli.version, await checkoutVersion());
  assert.equal(report.kit?.check, "ok", "the instance under the checkout resolves the workspace's kit");
  assert.equal(report.deployed?.orchestrator?.version, report.cli.version, "one release train");
  assert.equal(report.skew, "same");
});
