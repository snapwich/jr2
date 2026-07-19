// Setup steps: bring an instance into the state a scenario needs — scaffolded, optionally carrying a
// long-running workflow, and (when required) actually serving an orchestrator on an ephemeral port.

import { Given, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { E2EWorld } from "./world.ts";

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
