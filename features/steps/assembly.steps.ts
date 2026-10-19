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
  /** Every Assembly a live run holds, the current one first. */
  held: Array<{ hash: string; kitVersion: string; runs: string[] }>;
};

/** A run's status as these steps read it off `jr2 status <id>`. */
type RunRead = { status: string; value: unknown; assembly?: string; reason?: string };

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
  assert.match(
    table.stdout,
    new RegExp(`^assembly: ${hash} \\(kit v\\S+, current\\), \\d+ live runs? holds? it$`, "m"),
  );
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

// A run holds the Assembly it started under (ADR-0069). "The first Assembly" is the one the
// fixture published at boot, which every run these scenarios start at boot started under.

/** The hash of the Assembly the fixture published first. */
function firstAssembly(world: E2EWorld): string {
  const first = world.publishedHashes[0];
  assert.ok(first, "the fixture published an Assembly");
  return first;
}

/** The hash of the current Assembly: the one the last landed publish names. */
function currentAssembly(world: E2EWorld): string {
  const current = world.currentHash;
  assert.ok(current, "the fixture published an Assembly");
  return current;
}

/** `jr2 status <id>`, read as JSON, until the run is at `value` or the wait runs out. */
async function readRun(world: E2EWorld, runId: string, value?: string): Promise<RunRead> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const r = await world.runCli(["status", runId]);
    assert.equal(r.code, 0, `jr2 status ${runId} failed: ${r.stderr}`);
    const s = world.resultJson<RunRead>();
    if (value === undefined || s.value === value || Date.now() > deadline) return s;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

Then(
  "the run resumes under the first Assembly, at state {string}",
  async function (this: E2EWorld, value: string): Promise<void> {
    assert.equal(this.announced?.drifted, undefined, "a reshape at the door strands nothing");
    assert.equal(this.announced?.failed, undefined);
    assert.notEqual(currentAssembly(this), firstAssembly(this), "the reshape published another Assembly");
    const s = await readRun(this, this.runId!, value);
    assert.equal(s.status, "active", JSON.stringify(s));
    assert.equal(s.value, value, "resumed where it was parked, in the Machine that wrote it");
    assert.equal(s.assembly, firstAssembly(this), "the run keeps the Assembly it started under");
  },
);

Then(
  "the orchestrator lists the first Assembly as held by the run, and the current one by no run",
  async function (this: E2EWorld): Promise<void> {
    const view = await getJson<AssemblyView>(this, "/assembly");
    assert.equal(view.current?.hash, currentAssembly(this));
    assert.deepEqual(
      view.held.map((h) => [h.hash, h.runs]),
      [
        [currentAssembly(this), []],
        [firstAssembly(this), [this.runId]],
      ],
      "every held Assembly, the current one first",
    );
  },
);

Then(
  "`jr2 status` names the current Assembly first, then the first Assembly held by {int} live run",
  async function (this: E2EWorld, runs: number): Promise<void> {
    const table = await this.runCli(["status"]);
    assert.equal(table.code, 0, `jr2 status failed: ${table.stderr}`);
    const lines = table.stdout.split("\n").filter((l) => l.startsWith("assembly: "));
    assert.equal(lines.length, 2, table.stdout);
    assert.match(
      lines[0]!,
      new RegExp(`^assembly: ${currentAssembly(this)} \\(kit v\\S+, current\\), 0 live runs hold it$`),
    );
    assert.match(
      lines[1]!,
      new RegExp(`^assembly: ${firstAssembly(this)} \\(kit v[^,)]+\\), ${runs} live runs? holds? it$`),
    );
  },
);

Then(
  "a new {string} run starts under the current Assembly, at state {string}",
  async function (this: E2EWorld, workflow: string, value: string): Promise<void> {
    const endpoint = await this.stubHarnessUrl();
    const started = await this.runCli([
      "run",
      workflow,
      "--detach",
      "--input",
      JSON.stringify({ endpoint, attempts: 0 }),
    ]);
    assert.equal(started.code, 0, `jr2 run ${workflow} failed: ${started.stderr}`);
    const runId = this.resultJson<{ runId: string }>().runId;
    assert.ok(runId && runId !== this.runId, "another run");
    const s = await readRun(this, runId, value);
    assert.equal(s.value, value, "a new run starts in the current Assembly's Machine");
    assert.equal(s.assembly, currentAssembly(this));
  },
);

Then("the first Assembly is on the volume", function (this: E2EWorld): void {
  assert.deepEqual(this.assemblyOnVolume(firstAssembly(this)), { tree: true, record: true }, "a live run holds it");
  assert.deepEqual(this.published?.body.collected, [], "the publish let nothing go while the run holds it");
});

When("I publish a third Assembly", async function (this: E2EWorld): Promise<void> {
  // Any change to the published bytes is another Assembly: here, one more Workflow.
  await this.installFixtureWorkflow("guarded", "guarded-third");
  const answer = await this.publish();
  assert.notEqual(answer.body.unchanged, true, "other bytes are another Assembly");
  assert.equal(this.publishedHashes.length, 3, "three Assemblies landed");
});

/** Collection removes both halves of every Assembly that is not current and that no live run
 * holds, and nothing else (ADR-0069, by the reachability of ADR-0039). `expected` is the whole
 * verdict: every hash this scenario published except the current one, since no run is live. */
function assertCollected(world: E2EWorld, collected: string[] | undefined, by: string): void {
  const current = currentAssembly(world);
  const expected = world.publishedHashes.filter((h) => h !== current).sort();
  assert.ok(expected.includes(firstAssembly(world)), "the first Assembly is one of them");
  assert.deepEqual(collected, expected, `${by} names every unheld Assembly that is not current`);
  for (const hash of expected) {
    assert.deepEqual(
      world.assemblyOnVolume(hash),
      { tree: false, record: false },
      `${hash}: the tree and the record are gone`,
    );
  }
  assert.deepEqual(world.assemblyOnVolume(current), { tree: true, record: true }, "never the current Assembly");
}

Then(
  "the publish collected the first and second Assemblies, and they are gone from the volume",
  function (this: E2EWorld): void {
    assert.equal(this.publishedHashes.length, 3, "three Assemblies landed");
    assertCollected(this, this.published?.body.collected, "the publish answer");
  },
);

Then("the boot collected the first Assembly, and it is gone from the volume", function (this: E2EWorld): void {
  assert.equal(this.publishedHashes.length, 2, "two Assemblies landed");
  assertCollected(this, this.announced?.collected, "the boot's announce line");
});

Then("the orchestrator no longer lists the first Assembly as held", async function (this: E2EWorld): Promise<void> {
  const view = await getJson<AssemblyView>(this, "/assembly");
  assert.equal(view.current?.hash, currentAssembly(this));
  assert.ok(!view.held.some((h) => h.hash === firstAssembly(this)), JSON.stringify(view.held));
  assert.equal(view.held[0]?.hash, currentAssembly(this), "the current Assembly is listed first");
});

When(
  "the first Assembly is removed from the volume and the orchestrator restarts",
  async function (this: E2EWorld): Promise<void> {
    await this.stopServer();
    await this.removeAssembly(firstAssembly(this));
    await this.bootServer();
  },
);

// A boot with no current Assembly restores nothing (ADR-0069): the live rows wait, untouched, and
// the first publish that lands restores each inside the Assembly its snapshot names.

When(
  "the current Assembly is removed from the volume and the orchestrator restarts",
  async function (this: E2EWorld): Promise<void> {
    // The pointer stays, and names a tree that is gone. The first Assembly, which the run holds,
    // stays on the volume.
    await this.stopServer();
    await this.removeAssembly(currentAssembly(this));
    await this.bootServer();
  },
);

Then(
  "the boot reports the run as waiting, and serves no current Assembly",
  async function (this: E2EWorld): Promise<void> {
    assert.equal(this.announced?.assembly, null);
    assert.match(this.announced?.assemblyError ?? "", /is not on the volume/);
    assert.deepEqual(this.announced?.waiting, [this.runId], "the announce line names the run it left untouched");
    assert.equal(this.announced?.drifted, undefined, "nothing is drifted before the publish");
    assert.equal(this.announced?.lost, undefined);
    const view = await getJson<AssemblyView>(this, "/assembly");
    assert.equal(view.current, null);
    assert.deepEqual(
      view.held.map((h) => [h.hash, h.runs]),
      [[firstAssembly(this), [this.runId]]],
      "the waiting run's row holds the first Assembly",
    );
  },
);

Then(
  "the run reads as live, still parked at {string}, under the first Assembly",
  async function (this: E2EWorld, value: string): Promise<void> {
    const s = await readRun(this, this.runId!);
    assert.equal(s.status, "active", JSON.stringify(s));
    assert.equal(s.value, value, "the row is untouched");
    assert.equal(s.assembly, firstAssembly(this));
  },
);

Then("`jr2 status` answers while no Assembly is current", async function (this: E2EWorld): Promise<void> {
  const table = await this.runCli(["status"]);
  assert.equal(table.code, 0, `jr2 status failed: ${table.stderr}`);
  assert.match(table.stdout, /^assembly: none/m, table.stdout);
});

Then("the run is in the runs list", async function (this: E2EWorld): Promise<void> {
  const r = await this.runCli(["runs"]);
  assert.equal(r.code, 0, `jr2 runs failed: ${r.stderr}`);
  const list = this.resultJson<Array<{ runId: string }>>();
  assert.ok(
    list.some((run) => run.runId === this.runId),
    "the publish re-attached the run: it is a live run again",
  );
});
