// The Assembly through the door (ADR-0069). The e2e fixture boots the Orchestrator's own
// entrypoint on the instance folder and publishes `workflows/`, `jr2.config.ts` and `images/`
// with the publish token, as `jr2 up` does. `GET /assembly` and `/healthz` are open, so the reads
// here need no token.

import { Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KIT_VERSION } from "@jr2/orchestrator";
import { E2EWorld, type PublishAnswer } from "./world.ts";

/** What `GET /assembly` answers, as these steps read it. */
type AssemblyView = {
  kitVersion: string;
  current: { hash: string; kitVersion: string; workflows: string[] } | null;
};

/** Per scenario: the last `GET /assembly` answer, and the last refused publish. */
const seen = new WeakMap<E2EWorld, AssemblyView>();
const refused = new WeakMap<E2EWorld, PublishAnswer>();
/** The hash that was current before a refused publish. */
const before = new WeakMap<E2EWorld, string>();

async function getJson<T>(world: E2EWorld, path: string): Promise<T> {
  const url = world.server?.url;
  assert.ok(url, "the orchestrator is serving");
  const res = await fetch(`${url.replace(/\/+$/, "")}${path}`);
  assert.equal(res.status, 200, `GET ${path} answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Publish and keep the refusal; the current hash before it is kept too. */
async function publishRefused(world: E2EWorld, opts: Parameters<E2EWorld["publish"]>[0]): Promise<void> {
  const current = world.published?.body.hash;
  assert.ok(current, "the fixture published first");
  before.set(world, current);
  refused.set(world, await world.publish({ ...opts, expectRefusal: true }));
}

Then("the publish listed the scaffold's Workflows", function (this: E2EWorld): void {
  const answer = this.published;
  assert.ok(answer, "the fixture published");
  assert.equal(answer.status, 200);
  assert.equal(answer.body.hash, answer.hash, "the door names the Assembly by the hash the fixture computed");
  assert.ok(answer.body.workflows?.includes("ping"), `the scaffold's Workflows: ${answer.body.workflows}`);
});

When("I ask the orchestrator for its Assembly", async function (this: E2EWorld): Promise<void> {
  seen.set(this, await getJson<AssemblyView>(this, "/assembly"));
});

When("the host-booted orchestrator restarts", async function (this: E2EWorld): Promise<void> {
  await this.restartServer();
});

Then(
  "the current Assembly is the one published, named by the hash \\/healthz reports",
  async function (this: E2EWorld): Promise<void> {
    const view = seen.get(this);
    const current = view?.current;
    assert.ok(current, `a published Assembly is current: ${JSON.stringify(view)}`);
    assert.equal(current.hash, this.published?.hash, "the hash the fixture published");
    assert.equal(current.kitVersion, view!.kitVersion, "published against this Orchestrator's Kit version");
    assert.ok(current.workflows.includes("ping"), `the scaffold's Workflows are registered: ${current.workflows}`);
    const healthz = await getJson<{ hash?: string }>(this, "/healthz");
    assert.equal(healthz.hash, current.hash, "/healthz names the current Assembly by the same hash");
  },
);

Then("`jr2 status` names the current Assembly", async function (this: E2EWorld): Promise<void> {
  const hash = seen.get(this)?.current?.hash;
  assert.ok(hash, "the Assembly was read first");
  const table = await this.runCli(["status"]);
  assert.equal(table.code, 0, `jr2 status failed: ${table.stderr}`);
  assert.match(table.stdout, new RegExp(`^assembly: ${hash} \\(kit v\\S+\\), \\d+ live runs? holds? it$`, "m"));
});

Then("the current Assembly has the hash it had before the restart", async function (this: E2EWorld): Promise<void> {
  const prior = seen.get(this)?.current?.hash;
  assert.ok(prior, "the Assembly was read before the restart");
  assert.equal(this.announced?.assembly, prior, "the boot announces the Assembly `current` names");
  const after = await getJson<AssemblyView>(this, "/assembly");
  assert.equal(after.current?.hash, prior, "the restart boots from the pointer, and publishes nothing");
});

When("I publish the Assembly again", async function (this: E2EWorld): Promise<void> {
  await this.publish();
});

Then("the door answers that the Assembly is unchanged", function (this: E2EWorld): void {
  assert.equal(this.published?.status, 200);
  assert.equal(this.published?.body.unchanged, true, JSON.stringify(this.published?.body));
});

When("I publish the Assembly with the Instance token", async function (this: E2EWorld): Promise<void> {
  const token = this.server?.token;
  assert.ok(token);
  await publishRefused(this, { token });
});

Then("the door refuses it with 403 naming the publish token", function (this: E2EWorld): void {
  const answer = refused.get(this);
  assert.equal(answer?.status, 403);
  assert.match(String(answer?.body.error), /publish token/);
});

When("I publish the Assembly naming Kit version {string}", async function (this: E2EWorld, version: string) {
  await publishRefused(this, { kitVersion: version });
});

Then(
  "the door refuses it with 409 naming {string} and this Orchestrator's Kit version",
  function (this: E2EWorld, version: string): void {
    const answer = refused.get(this);
    assert.equal(answer?.status, 409);
    const error = String(answer?.body.error);
    assert.ok(error.includes(version), error);
    assert.ok(error.includes(KIT_VERSION), error);
    assert.deepEqual(answer?.body.kitVersion, { assembly: version, orchestrator: KIT_VERSION });
  },
);

When(
  "I add a workflow {string} that exports no machine and publish",
  async function (this: E2EWorld, name: string): Promise<void> {
    await mkdir(join(this.dir, "workflows"), { recursive: true });
    await writeFile(join(this.dir, "workflows", `${name}.ts`), "export const notAMachine = 1;\n");
    await publishRefused(this, {});
  },
);

Then("the door refuses it with 422 naming the missing `machine` export", function (this: E2EWorld): void {
  const answer = refused.get(this);
  assert.equal(answer?.status, 422, JSON.stringify(answer?.body));
  assert.equal(answer?.body.error, "refused");
  assert.match((answer?.body.report ?? []).join("\n"), /has no `machine` named export/);
});

Then("the Orchestrator still serves the Assembly it served before", async function (this: E2EWorld): Promise<void> {
  const prior = before.get(this);
  const view = await getJson<AssemblyView>(this, "/assembly");
  assert.equal(view.current?.hash, prior, "the refusal left the old Assembly current");
  const workflows = await getJson<string[]>(this, "/workflows");
  assert.ok(workflows.includes("ping") && !workflows.includes("broken"), JSON.stringify(workflows));
});

When(
  "I publish the {string} fixture as the {string} workflow",
  async function (this: E2EWorld, fixture: string, name: string): Promise<void> {
    await this.installFixtureWorkflow(fixture, name);
    const answer = await this.publish();
    assert.notEqual(answer.body.unchanged, true, "another shape is another Assembly");
  },
);
