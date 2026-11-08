// Nested Workspaces on kind (ADR-0012): each Workspace has a Sandbox of its own, named by its actor
// path, and a Workspace that a Machine of the run stops loses its Sandbox. One scenario holds more
// than one run, so each run has a label. The Sandboxes of a run are read off the cluster by the
// run's label, and each one's path off its `jr2.dev/workspace-path` annotation: a root Workspace's
// path has no `/`, and a nested one's has.

import { Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { kubectl } from "./kind.steps.ts";
import { isSettled } from "../lib/run-settled.ts";
import { E2EWorld } from "./world.ts";

type Sandbox = { name: string; path: string; phase?: string };
type Status = {
  status?: string;
  output?: unknown;
  gates?: Array<{ gate: string }>;
};

const runsOf = (world: E2EWorld): Map<string, string> => {
  const w = world as E2EWorld & { nestedRuns?: Map<string, string> };
  w.nestedRuns ??= new Map();
  return w.nestedRuns;
};

function runOf(world: E2EWorld, label: string): string {
  const runId = runsOf(world).get(label);
  assert.ok(runId, `no run was started as "${label}"`);
  return runId;
}

async function sandboxesOf(world: E2EWorld, runId: string): Promise<Sandbox[]> {
  const out = await kubectl(world, ["get", "sandbox", "-l", `jr2.dev/run=${runId}`, "-o", "json"]);
  const items = (
    JSON.parse(out) as {
      items: Array<{
        metadata: { name: string; annotations?: Record<string, string>; deletionTimestamp?: string };
        status?: { phase?: string };
      }>;
    }
  ).items;
  // A CR that is going away is gone for these claims: the delete was sent.
  return items
    .filter((s) => s.metadata.deletionTimestamp === undefined)
    .map((s) => ({
      name: s.metadata.name,
      path: s.metadata.annotations?.["jr2.dev/workspace-path"] ?? "",
      phase: s.status?.phase,
    }));
}

async function statusOf(world: E2EWorld, runId: string): Promise<Status> {
  const r = await world.runCli(["status", runId]);
  assert.equal(r.code, 0, `jr2 status ${runId} failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as Status;
}

const nested = (s: Sandbox): boolean => s.path.includes("/");

When(
  "I start the {string} workflow as {string} with input {string}",
  async function (this: E2EWorld, workflow: string, label: string, input: string): Promise<void> {
    const r = await this.runCli(["run", workflow, "--detach", "--input", input]);
    assert.equal(r.code, 0, `jr2 run ${workflow} failed: ${r.stderr}`);
    runsOf(this).set(label, (JSON.parse(r.stdout) as { runId: string }).runId);
  },
);

Then(
  "{string} has its parent's Sandbox and its nested Workspace's Sandbox Ready",
  { timeout: 600_000 },
  async function (this: E2EWorld, label: string): Promise<void> {
    const runId = runOf(this, label);
    let seen: Sandbox[] = [];
    for (let i = 0; i < 280; i++) {
      seen = await sandboxesOf(this, runId);
      const ready = seen.filter((s) => s.phase === "Ready");
      if (ready.some(nested) && ready.some((s) => !nested(s))) return;
      await sleep(2000);
    }
    throw new Error(`run ${runId} never had both Sandboxes Ready: ${JSON.stringify(seen)}`);
  },
);

When("I send {string} to the Gate of {string}", async function (this: E2EWorld, event: string, label: string) {
  const runId = runOf(this, label);
  const gates = (await statusOf(this, runId)).gates ?? [];
  assert.equal(gates.length, 1, `run ${runId} has one open Gate: ${JSON.stringify(gates)}`);
  const r = await this.runCli(["send", runId, "--gate", gates[0]!.gate, "--event", event]);
  assert.equal(r.code, 0, `jr2 send ${event} failed: ${r.stderr}`);
});

/** The parent left the state that invokes the child. The child's Sandbox goes at the stop, not at
 * the operator's idle timeout (30 minutes); the parent's stays while the run goes on. */
Then(
  "the nested Workspace's Sandbox of {string} is deleted within {int} seconds, and the run and its parent's Sandbox go on",
  { timeout: 300_000 },
  async function (this: E2EWorld, label: string, bound: number): Promise<void> {
    const runId = runOf(this, label);
    const started = Date.now();
    let seen: Sandbox[] = [];
    for (;;) {
      seen = await sandboxesOf(this, runId);
      if (!seen.some(nested)) break;
      assert.ok(Date.now() - started < bound * 1000, `the nested Sandbox outlived ${bound} s: ${JSON.stringify(seen)}`);
      await sleep(1000);
    }
    assert.equal(seen.filter((s) => !nested(s)).length, 1, `the parent's Sandbox stays: ${JSON.stringify(seen)}`);
    assert.equal((await statusOf(this, runId)).status, "active", "the run goes on");
  },
);

When("I cancel {string}", async function (this: E2EWorld, label: string): Promise<void> {
  const r = await this.runCli(["send", runOf(this, label), "--event", "CANCEL"]);
  assert.equal(r.code, 0, `jr2 send CANCEL failed: ${r.stderr}`);
});

Then(
  "no Sandbox of {string} is left within {int} seconds",
  { timeout: 300_000 },
  async function (this: E2EWorld, label: string, bound: number): Promise<void> {
    const runId = runOf(this, label);
    const started = Date.now();
    for (;;) {
      const seen = await sandboxesOf(this, runId);
      if (seen.length === 0) return;
      assert.ok(Date.now() - started < bound * 1000, `Sandboxes outlived ${bound} s: ${JSON.stringify(seen)}`);
      await sleep(1000);
    }
  },
);

/**
 * Each Pool worker invokes its child Workspace from one state, with one invoke id, for two rounds.
 * The child prints its pod's hostname, which is its Sandbox's name. Each worker's two rounds ran in
 * one name (the second round took the name over), and the two workers' names differ.
 */
Then(
  "{string} ends done, and each worker ran its two rounds in a Sandbox name that no other worker had",
  { timeout: 900_000 },
  async function (this: E2EWorld, label: string): Promise<void> {
    const runId = runOf(this, label);
    let status: Status = {};
    for (let i = 0; i < 400; i++) {
      status = await statusOf(this, runId);
      if (isSettled(status.status)) break;
      await sleep(2000);
    }
    assert.equal(status.status, "done", `the Pool drains: ${JSON.stringify(status.output)}`);
    const items = (status.output as { items?: Record<string, { tails?: string[]; error?: string }> }).items ?? {};
    assert.deepEqual(Object.keys(items).sort(), ["item-a", "item-b"]);
    const names = new Map<string, string>();
    for (const [item, out] of Object.entries(items)) {
      assert.equal(out.error, undefined, `${item}'s child failed: ${out.error}`);
      const hosts = (out.tails ?? []).map((t) => /child round (\d) on (\S+)/.exec(t));
      assert.deepEqual(
        hosts.map((m) => m?.[1]),
        ["1", "2"],
        `${item} ran two rounds: ${JSON.stringify(out.tails)}`,
      );
      assert.equal(hosts[0]![2], hosts[1]![2], `${item}'s second round took the first round's name over`);
      names.set(item, hosts[0]![2]!);
    }
    assert.notEqual(names.get("item-a"), names.get("item-b"), "each worker's nested Workspace has its own Sandbox");
  },
);
