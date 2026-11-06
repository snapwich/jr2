// Steps for run history (ADR-0009, ADR-0065): `GET /runs` and its filters, the run summary, the
// cursor, the scope `read` filter, and the config's `runs: { retain, volume }` at the door. The
// `jr2 runs` steps read stdout, the one result: an array of summaries.

import { Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { E2EWorld } from "./world.ts";

type Summary = { runId: string; workflow: string; status: string } & Record<string, unknown>;
type Page = { runs: Summary[]; next?: string };

/** The fields a run summary may have (ADR-0009): never `context`, `value` or `children`. */
const SUMMARY_FIELDS = new Set([
  "runId",
  "workflow",
  "status",
  "reason",
  "startedBy",
  "startedAt",
  "endedAt",
  "assembly",
  "openGates",
  "placing",
  "dispatchedBy",
  "swept",
]);

/** The page that the last HTTP read of `GET /runs` answered, by scenario. */
const pages = new WeakMap<E2EWorld, { status: number; body: Page & { error?: string } }>();

When("I list the runs with {string} expecting a refusal", async function (this: E2EWorld, flags: string) {
  await this.runCli(["runs", ...flags.split(" ")]);
});

When(
  "the Caller {string} lists the runs with {string}",
  async function (this: E2EWorld, caller: string, flags: string): Promise<void> {
    const r = await this.runCli(["runs", ...flags.split(" ")], { as: caller });
    assert.equal(r.code, 0, `jr2 runs ${flags} as ${caller} failed: ${r.stderr}`);
  },
);

When("I cancel the run and it ends", async function (this: E2EWorld): Promise<void> {
  const r = await this.runCli(["send", this.runId!, "--event", "CANCEL"]);
  assert.equal(r.code, 0, `jr2 send CANCEL failed: ${r.stderr}`);
  for (let i = 0; i < 100; i++) {
    const read = await this.api<{ status: string }>("GET", `/runs/${this.runId}`);
    if (read.body.status === "cancelled") return;
    await sleep(50);
  }
  throw new Error(`run ${this.runId} did not end as cancelled`);
});

Then("the runs list is exactly {string}", function (this: E2EWorld, workflows: string): void {
  const list = this.resultJson<Summary[]>();
  assert.ok(Array.isArray(list), `jr2 runs prints an array: ${this.last?.stdout}`);
  assert.deepEqual(
    list.map((r) => r.workflow),
    workflows.split(",").map((w) => w.trim()),
    `the newest start first: ${JSON.stringify(list)}`,
  );
});

Then("stderr names {string}", function (this: E2EWorld, needle: string): void {
  assert.ok((this.last?.stderr ?? "").includes(needle), `stderr names "${needle}": ${this.last?.stderr}`);
});

When("I read the ended runs over HTTP", async function (this: E2EWorld): Promise<void> {
  pages.set(this, await this.api<Page>("GET", "/runs?status=ended"));
});

When("I read the runs over HTTP with {string}", async function (this: E2EWorld, query: string): Promise<void> {
  pages.set(this, await this.api<Page & { error?: string }>("GET", `/runs?${query}`));
});

Then("the read is refused with {int} naming {string}", function (this: E2EWorld, status: number, needle: string): void {
  const page = pages.get(this);
  assert.equal(page?.status, status, JSON.stringify(page?.body));
  assert.ok(String(page?.body.error).includes(needle), `the refusal names "${needle}": ${page?.body.error}`);
});

Then("each summary has only the summary fields", function (this: E2EWorld): void {
  const page = pages.get(this);
  assert.equal(page?.status, 200, JSON.stringify(page?.body));
  assert.ok(page.body.runs.length > 0, "the read lists a run");
  for (const run of page.body.runs) {
    const extra = Object.keys(run).filter((k) => !SUMMARY_FIELDS.has(k));
    assert.deepEqual(extra, [], `a summary carries no other field: ${JSON.stringify(run)}`);
  }
});

Then(
  "the summary of that run has a start, an end and the current Assembly, and {int} open Gates",
  function (this: E2EWorld, gates: number): void {
    const run = pages.get(this)?.body.runs.find((r) => r.runId === this.runId);
    assert.ok(run, `the run is listed: ${JSON.stringify(pages.get(this)?.body)}`);
    assert.equal(run.workflow, "ping");
    assert.equal(run.status, "done");
    const started = Date.parse(String(run.startedAt));
    const ended = Date.parse(String(run.endedAt));
    assert.ok(Number.isFinite(started) && Number.isFinite(ended), JSON.stringify(run));
    assert.ok(ended >= started, "a run ends after it starts");
    assert.equal(run.assembly, this.currentHash, "the hash of the Assembly the run started under");
    assert.equal(run.openGates, gates);
    assert.deepEqual(run.startedBy, { kind: "caller", via: "token", name: "instance" });
  },
);

Then(
  "the {int} ended runs read {int} at a time come in {int} pages, newest first, each run once",
  async function (this: E2EWorld, runs: number, limit: number, count: number): Promise<void> {
    const seen: Summary[] = [];
    let cursor: string | undefined;
    let read = 0;
    do {
      const query = `status=ended&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await this.api<Page>("GET", `/runs?${query}`);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.ok(page.body.runs.length <= limit, `a page holds at most ${limit}`);
      seen.push(...page.body.runs);
      cursor = page.body.next;
      read++;
    } while (cursor !== undefined && read < 10);
    assert.equal(read, count, `pages read: ${read}`);
    assert.equal(new Set(seen.map((r) => r.runId)).size, seen.length, "each run once");
    assert.equal(seen.length, runs, `every ended run is on a page: ${JSON.stringify(seen.map((r) => r.runId))}`);
    const starts = seen.map((r) => String(r.startedAt));
    assert.deepEqual(starts, [...starts].sort().reverse(), "the newest start first");
  },
);

/** Give the instance's config a `runs` block (ADR-0065), as an author writes it in `jr2.config.ts`. */
When("the instance's config sets runs to {string}", async function (this: E2EWorld, runs: string): Promise<void> {
  const config = join(this.dir, "jr2.config.ts");
  const text = await readFile(config, "utf8");
  const set = text.replace("export default defineConfig({", `export default defineConfig({\n  runs: ${runs},`);
  assert.notEqual(set, text, "the scaffolded config has a defineConfig call to set runs in");
  await writeFile(config, set);
});

When("I publish the Assembly expecting a refusal", async function (this: E2EWorld): Promise<void> {
  await this.publish({ expectRefusal: true });
});

Then("the publish lands", function (this: E2EWorld): void {
  assert.equal(this.published?.status, 200, JSON.stringify(this.published?.body));
});

Then("the run's summary gives the reason {string}", function (this: E2EWorld, needle: string): void {
  const run = this.resultJson<Summary[]>().find((r) => r.runId === this.runId);
  assert.ok(run, "the run is listed");
  assert.ok(String(run.reason).includes(needle), `the reason names "${needle}": ${run.reason}`);
});
