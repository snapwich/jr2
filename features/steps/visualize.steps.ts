// Steps for `j2 visualize`: the verb's one stdout result is the page URL, and that URL (plus the
// Machine-structure route behind it) actually answers — asserted with real fetches against the real
// fixture server, black-box like everything else here.

import { When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { E2EWorld } from "./world.ts";

When("I visualize {string}", async function (this: E2EWorld, wf: string): Promise<void> {
  await this.runCli(["visualize", wf, "--no-open"]);
});

Then("stdout is a visualizer url for {string}", function (this: E2EWorld, wf: string): void {
  const { url, workflow } = this.resultJson<{ url?: string; workflow?: string }>();
  assert.equal(workflow, wf);
  assert.equal(url, `${this.server?.url}/viz/${wf}`, "the page rides on the serving orchestrator");
});

Then("the visualizer page is served at that url", async function (this: E2EWorld): Promise<void> {
  const { url } = this.resultJson<{ url: string }>();
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await res.text(), /machine-svg/, "the page shell renders the Machine mount");
});

Then("the Machine structure is served for {string}", async function (this: E2EWorld, wf: string): Promise<void> {
  const res = await fetch(`${this.server?.url}/workflows/${wf}/machine`);
  assert.equal(res.status, 200);
  const doc = (await res.json()) as { id: string; root: { states: unknown[] } };
  assert.equal(doc.id, wf, "the scaffolded machine's id is its workflow name");
  assert.ok(doc.root.states.length > 0, "the Machine has states to render");
});

Then("stderr lists the available workflows", function (this: E2EWorld): void {
  assert.match(this.last?.stderr ?? "", /no workflow .* available:/);
});
