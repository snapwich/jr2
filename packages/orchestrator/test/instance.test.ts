// Instance-bootstrap tests: prove `startInstance` turns an instance folder into a running,
// curl-able orchestrator — workflows discovered from `workflows/*.ts`, the HTTP surface served on a
// real socket, and in-flight runs resumed from the store on a fresh boot (ADR-0007/0008/0009).
//
// These drive the surface the REAL way: a live `@hono/node-server` on an ephemeral port hit with
// global `fetch`. The agent side is the no-flue stub (the default), so runs admit + stay live
// without a Harness — enough to exercise discover → serve → restore end to end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startInstance } from "../src/instance.ts";
import { SqliteSnapshotStore } from "../src/snapshot-store.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "instance");
// A workflow's parent package for module resolution; reload temp dirs live here (under the package so
// generated files resolve `xstate`) but OUTSIDE tsconfig's `src`/`test` globs so `tsc` never sees them.
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Source for a throwaway single-state workflow whose `initial` state name is observable as `value`. */
function machineSrc(id: string, initial: string): string {
  return (
    `import { setup } from "xstate";\n` +
    `export default setup({ types: {} as { input: { instanceId: string } } })` +
    `.createMachine({ id: ${JSON.stringify(id)}, initial: ${JSON.stringify(initial)}, ` +
    `states: { ${JSON.stringify(initial)}: {} } });\n`
  );
}

async function waitFor(pred: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: predicate never became true");
}

test("discovers workflows and serves the HTTP surface", async () => {
  const store = new SqliteSnapshotStore(":memory:");
  const inst = await startInstance({ dir: fixtureDir, store });
  try {
    assert.deepEqual(inst.workflows, ["echo"]);

    const health = await fetch(`${inst.url}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const workflows = await (await fetch(`${inst.url}/workflows`)).json();
    assert.deepEqual(workflows, ["echo"]);

    // Push work over HTTP → a run is minted and observable.
    const started = await fetch(`${inst.url}/workflows/echo/runs`, { method: "POST", body: "{}" });
    assert.equal(started.status, 201);
    const { runId } = (await started.json()) as { runId: string };
    assert.ok(runId);

    const runs = (await (await fetch(`${inst.url}/runs`)).json()) as Array<{ runId: string; workflow: string }>;
    assert.ok(runs.some((r) => r.runId === runId && r.workflow === "echo"));

    const status = (await (await fetch(`${inst.url}/runs/${runId}`)).json()) as { workflow: string; status: string };
    assert.equal(status.workflow, "echo");
  } finally {
    await inst.close();
  }
});

test("an unknown workflow start is a 404", async () => {
  const inst = await startInstance({ dir: fixtureDir, store: new SqliteSnapshotStore(":memory:") });
  try {
    const res = await fetch(`${inst.url}/workflows/nope/runs`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404);
  } finally {
    await inst.close();
  }
});

test("a fresh boot on the same store restores an in-flight run", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "j2-instance-"));
  const dbPath = join(dbDir, "state.db");

  // Boot A: start a run (the stub keeps it live), let it persist, then shut down.
  const storeA = new SqliteSnapshotStore(dbPath);
  const instA = await startInstance({ dir: fixtureDir, store: storeA });
  const { runId } = await instA.host.start("echo");
  await waitFor(async () => (await storeA.load(runId)) !== undefined);
  await instA.close();

  // Boot B: a brand-new process on the SAME db file → restore re-attaches the run.
  const storeB = new SqliteSnapshotStore(dbPath);
  const instB = await startInstance({ dir: fixtureDir, store: storeB, reconcile: () => true });
  try {
    assert.ok(instB.host.status(runId), "run must be re-attached after a fresh boot");
    assert.equal(instB.host.status(runId)?.workflow, "echo");
  } finally {
    await instB.close();
  }
});

test("reload picks up added, changed, and removed workflow files (dev hot-reload)", async () => {
  const dir = await mkdtemp(join(pkgDir, ".reload-"));
  const wfDir = join(dir, "workflows");
  await mkdir(wfDir, { recursive: true });
  const write = (name: string, initial: string): Promise<void> =>
    writeFile(join(wfDir, `${name}.ts`), machineSrc(name, initial));

  await write("alpha", "one");
  const inst = await startInstance({ dir, store: new SqliteSnapshotStore(":memory:") });
  try {
    assert.deepEqual(inst.workflows, ["alpha"]);

    // Add a new file AND change an existing one, then reload once.
    await write("beta", "ready");
    await write("alpha", "two");
    const added = await inst.reload();
    assert.deepEqual(added.added, ["beta"]);
    assert.deepEqual(added.updated, ["alpha"]);
    assert.deepEqual(added.removed, []);
    assert.deepEqual([...added.workflows].sort(), ["alpha", "beta"]);

    // The changed code took effect: a fresh start of alpha lands in its NEW initial state (cache-bust).
    const { runId } = await inst.host.start("alpha");
    assert.equal(inst.host.status(runId)?.value, "two");

    // Delete a file → reload drops it.
    await rm(join(wfDir, "alpha.ts"));
    const removed = await inst.reload();
    assert.deepEqual(removed.removed, ["alpha"]);
    assert.deepEqual(removed.workflows, ["beta"]);
    await assert.rejects(inst.host.start("alpha"), /no workflow registered as "alpha"/);
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});
