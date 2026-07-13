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
// The surface is authenticated (ADR-0013), so these tests must present the Instance token the boot
// minted — exactly as the CLI does after reading `.j2/dev.json`. The signing key is supplied rather
// than loaded, so a test never writes `.j2/secret` into the fixture folder it shares.
const KEY = Buffer.alloc(32, 3);
const auth = (inst: { instanceToken: string }) => ({ headers: { authorization: `Bearer ${inst.instanceToken}` } });
// A workflow's parent package for module resolution; reload temp dirs live here (under the package so
// generated files resolve `xstate`) but OUTSIDE tsconfig's `src`/`test` globs so `tsc` never sees them.
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Source for a throwaway single-state workflow whose `initial` state name is observable as `value`. */
function machineSrc(id: string, initial: string): string {
  return (
    `import { setup } from "xstate";\n` +
    `export const machine = setup({ types: {} as { input: { instanceId: string } } })` +
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
  const inst = await startInstance({ dir: fixtureDir, store, signingKey: KEY });
  try {
    assert.deepEqual(inst.workflows, ["echo"]);

    const health = await fetch(`${inst.url}/healthz`, auth(inst));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const workflows = await (await fetch(`${inst.url}/workflows`, auth(inst))).json();
    assert.deepEqual(workflows, ["echo"]);

    // Push work over HTTP → a run is minted and observable.
    const started = await fetch(`${inst.url}/workflows/echo/runs`, { method: "POST", body: "{}", ...auth(inst) });
    assert.equal(started.status, 201);
    const { runId } = (await started.json()) as { runId: string };
    assert.ok(runId);

    const runs = (await (await fetch(`${inst.url}/runs`, auth(inst))).json()) as Array<{ runId: string; workflow: string }>;
    assert.ok(runs.some((r) => r.runId === runId && r.workflow === "echo"));

    const status = (await (await fetch(`${inst.url}/runs/${runId}`, auth(inst))).json()) as { workflow: string; status: string };
    assert.equal(status.workflow, "echo");
  } finally {
    await inst.close();
  }
});

test("an unknown workflow start is a 404", async () => {
  const inst = await startInstance({ dir: fixtureDir, store: new SqliteSnapshotStore(":memory:"), signingKey: KEY });
  try {
    const res = await fetch(`${inst.url}/workflows/nope/runs`, { method: "POST", body: "{}", ...auth(inst) });
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
  const instA = await startInstance({ dir: fixtureDir, store: storeA, signingKey: KEY });
  const { runId } = await instA.host.start("echo");
  await waitFor(async () => (await storeA.load(runId)) !== undefined);
  await instA.close();

  // Boot B: a brand-new process on the SAME db file → restore re-attaches the run.
  const storeB = new SqliteSnapshotStore(dbPath);
  const instB = await startInstance({ dir: fixtureDir, store: storeB, reconcile: () => true, signingKey: KEY });
  try {
    assert.ok(instB.host.status(runId), "run must be re-attached after a fresh boot");
    assert.equal(instB.host.status(runId)?.workflow, "echo");
  } finally {
    await instB.close();
  }
});

test("module contract (ADR-0011): no `machine` named export fails discovery with a pointed error", async () => {
  const dir = await mkdtemp(join(pkgDir, ".contract-"));
  const wfDir = join(dir, "workflows");
  await mkdir(wfDir, { recursive: true });
  await writeFile(
    join(wfDir, "legacy.ts"),
    `import { setup } from "xstate";\nexport default setup({}).createMachine({ id: "legacy", initial: "a", states: { a: {} } });\n`,
  );
  try {
    await assert.rejects(
      startInstance({ dir, store: new SqliteSnapshotStore(":memory:"), signingKey: KEY }),
      /workflow "legacy" .* has no `machine` named export .*export const machine/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the `events` manifest is collected per workflow and resolvable on the host", async () => {
  const dir = await mkdtemp(join(pkgDir, ".events-"));
  const wfDir = join(dir, "workflows");
  await mkdir(wfDir, { recursive: true });
  await writeFile(
    join(wfDir, "gated.ts"),
    `import { setup } from "xstate";\n` +
      `import { z } from "zod";\n` +
      `import { defineEvent } from "@j2/agent-protocol";\n` +
      `const approve = defineEvent({ name: "approve", input: z.object({}) });\n` +
      `export const events = [approve];\n` +
      `export const machine = setup({}).createMachine({ id: "gated", initial: "a", states: { a: {} } });\n`,
  );
  const inst = await startInstance({ dir, store: new SqliteSnapshotStore(":memory:"), signingKey: KEY });
  try {
    const vocab = inst.host.events("gated");
    assert.ok(vocab?.has("approve"), "manifest must be collected at discovery");
    assert.equal(vocab?.get("approve")?.semantics, "ack");
    // An eventless workflow resolves to an empty scope, not undefined (echo has no manifest).
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reload picks up added, changed, and removed workflow files (dev hot-reload)", async () => {
  const dir = await mkdtemp(join(pkgDir, ".reload-"));
  const wfDir = join(dir, "workflows");
  await mkdir(wfDir, { recursive: true });
  const write = (name: string, initial: string): Promise<void> =>
    writeFile(join(wfDir, `${name}.ts`), machineSrc(name, initial));

  await write("alpha", "one");
  const inst = await startInstance({ dir, store: new SqliteSnapshotStore(":memory:"), signingKey: KEY });
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
