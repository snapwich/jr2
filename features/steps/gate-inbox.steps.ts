// Steps for the Gate inbox (ADR-0011, ADR-0078): `jr2 gates`, the entries of `GET /gates`, a
// Caller's per-Gate `answer` scope, and `jr2 send --gate` as that Caller.

import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { E2EWorld } from "./world.ts";

type InboxEntry = {
  runId: string;
  workflow: string;
  gate: string;
  path: string[];
  accepts: Array<{ name: string }>;
  acceptsNow: string[];
  openedAt: string;
} & Record<string, unknown>;

Given(
  "the instance declares the Caller token {string} with scopes {string}",
  async function (this: E2EWorld, name: string, scopes: string): Promise<void> {
    await this.declareCallerToken(name, JSON.parse(scopes) as Record<string, unknown>);
  },
);

When("I list the Gates", async function (this: E2EWorld): Promise<void> {
  await this.runCli(["gates"]);
});

When("I list the Gates with {string}", async function (this: E2EWorld, flags: string): Promise<void> {
  await this.runCli(["gates", ...flags.split(" ")]);
});

When("the Caller {string} lists the Gates", async function (this: E2EWorld, caller: string): Promise<void> {
  await this.runCli(["gates"], { as: caller });
});

When("I answer Gate {string} with {string}", async function (this: E2EWorld, gate: string, event: string) {
  await this.runCli(["send", this.runId!, "--gate", gate, "--event", event]);
});

When(
  "the Caller {string} answers Gate {string} with {string}",
  async function (this: E2EWorld, caller: string, gate: string, event: string): Promise<void> {
    await this.runCli(["send", this.runId!, "--gate", gate, "--event", event], { as: caller });
  },
);

/** `jr2 gates` prints the entries as one array: each as `<workflow>:<gate id>`, in its order. */
Then("the Gate list is exactly {string}", function (this: E2EWorld, list: string): void {
  assert.equal(this.last?.code, 0, `jr2 gates failed: ${this.last?.stderr}`);
  const gates = this.resultJson<InboxEntry[]>();
  const want = list === "" ? [] : list.split(",").map((s) => s.trim());
  assert.deepEqual(
    gates.map((g) => `${g.workflow}:${g.gate}`),
    want,
    `oldest first: ${JSON.stringify(gates)}`,
  );
});

Then(
  "each Gate entry has its run, its Workflow, its accepted events, its meta and when it opened, and no context",
  function (this: E2EWorld): void {
    const gates = this.resultJson<InboxEntry[]>();
    assert.ok(gates.length > 0);
    let before = "";
    for (const g of gates) {
      assert.match(g.runId, /\S/);
      assert.ok(Array.isArray(g.path));
      assert.ok(g.accepts.length > 0 && g.accepts.every((a) => typeof a.name === "string"), JSON.stringify(g));
      assert.ok(Array.isArray(g.acceptsNow));
      assert.ok(Number.isFinite(Date.parse(g.openedAt)), `openedAt is a time: ${g.openedAt}`);
      assert.ok(g.openedAt >= before, "the oldest first");
      before = g.openedAt;
      assert.equal(g.context, undefined, "an entry never carries the run's context (ADR-0014)");
      assert.ok(!JSON.stringify(g).includes("s3cret"), "nothing of the run's context rides an entry");
    }
    // The signoff fixture gives L-1 a meta, and S-1 none (ADR-0011).
    const meta = (gate: string) => gates.find((g) => g.workflow === "signoff" && g.gate === gate)?.meta;
    assert.deepEqual(meta("L-1"), { team: "legal" });
    const none = meta("S-1");
    assert.ok(
      none === undefined || Object.keys(none as object).length === 0,
      `S-1 has no meta: ${JSON.stringify(none)}`,
    );
  },
);

Then(
  "the Caller {string} reads the run's Gates as exactly {string}",
  async function (this: E2EWorld, caller: string, list: string): Promise<void> {
    const r = await this.runCli(["status", this.runId!], { as: caller });
    assert.equal(r.code, 0, r.stderr);
    const gates = this.resultJson<{ gates?: Array<{ gate: string }> }>().gates ?? [];
    assert.deepEqual(
      gates.map((g) => g.gate),
      list.split(",").map((s) => s.trim()),
    );
  },
);

Then(
  "stderr says the Caller {string} needs the {string} scope for Gate {string} of Workflow {string}",
  function (this: E2EWorld, caller: string, scope: string, gate: string, wf: string): void {
    const stderr = this.last?.stderr ?? "";
    assert.ok(
      stderr.includes(`the Caller ${caller} needs the "${scope}" scope for Gate "${gate}" of Workflow "${wf}"`),
      stderr,
    );
  },
);

Then(
  "stderr says the Caller {string} has no {string} scope for any Workflow",
  function (this: E2EWorld, caller: string, scope: string): void {
    const stderr = this.last?.stderr ?? "";
    assert.ok(stderr.includes(`the Caller ${caller} has no "${scope}" scope for any Workflow`), stderr);
  },
);
