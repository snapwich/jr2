// Steps for the `j2 dev` address lifecycle: it advertises its live url in `.j2/dev.json` while serving
// and removes the file on a clean SIGINT, so the run-control verbs only ever attach to a real server.

import { When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { E2EWorld } from "./world.ts";

When("the orchestrator receives SIGINT", async function (this: E2EWorld): Promise<void> {
  await this.stopDev();
});

// Regex, not a Cucumber Expression: the `/` in `.j2/dev.json` is an alternation operator there.
Then(/^\.j2\/dev\.json points at the live url$/, async function (this: E2EWorld): Promise<void> {
  const info = await this.readDevJson();
  assert.ok(info, ".j2/dev.json exists while serving");
  assert.equal(info.url, this.dev?.url, "advertised url matches the running server");
  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+$/, "an ephemeral loopback address");
  assert.ok(info.pid > 0, "carries the dev pid");
});

Then(/^\.j2\/dev\.json is removed$/, async function (this: E2EWorld): Promise<void> {
  assert.equal(await this.readDevJson(), undefined, "dev.json removed on clean exit");
});
