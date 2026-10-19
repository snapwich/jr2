// Instance-bootstrap tests: prove `startInstance` turns an instance folder into a running,
// curl-able orchestrator — workflows discovered from `workflows/*.ts`, the HTTP surface served on a
// real socket, and in-flight runs resumed from the store on a fresh boot (ADR-0007/0008/0009).
//
// These drive the surface the REAL way: a live `@hono/node-server` on an ephemeral port hit with
// global `fetch`. The agent side is the no-flue stub (the default), so runs admit + stay live
// without a Harness — enough to exercise discover → serve → restore end to end. Every Workflow
// arrives through the door (ADR-0069): a boot serves the Assembly `current` names, and nothing else.

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  defaultImageContext,
  loadWorkflows,
  startInstance,
  type RestoreOutcome,
  type RunningInstance,
} from "../src/instance.ts";
import { collectAssemblies } from "../src/assembly.ts";
import { KIT_VERSION } from "../src/config.ts";
import { SqliteSnapshotStore } from "../src/snapshot-store.ts";
import {
  admitTree,
  FIXTURE_ASSEMBLY,
  hashesOnVolume,
  onVolume,
  publishTree,
  scratchInstance,
  stageTree,
} from "./_assembly.ts";
// The surface is authenticated (ADR-0013), so these tests must present the Instance token the boot
// minted — exactly as the CLI does after reading `.jr2/dev.json`. The signing key is supplied rather
// than loaded, so a test never writes `.jr2/secret`.
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

/** A scratch instance with the fixture Assembly published, booted with `opts`. */
async function bootPublished(
  opts: Partial<Parameters<typeof startInstance>[0]> = {},
): Promise<{ inst: RunningInstance; dir: string }> {
  const dir = opts.dir ?? (await scratchInstance());
  const inst = await startInstance({ store: new SqliteSnapshotStore(":memory:"), signingKey: KEY, ...opts, dir });
  await publishTree(inst, dir, FIXTURE_ASSEMBLY);
  return { inst, dir };
}

async function waitFor(pred: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: predicate never became true");
}

test("discovers workflows and serves the HTTP surface", async () => {
  const { inst, dir } = await bootPublished();
  try {
    assert.deepEqual(inst.host.workflows(), ["echo"]);

    const health = await fetch(`${inst.url}/healthz`, auth(inst));
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { ok: boolean }).ok, true);

    const workflows = await (await fetch(`${inst.url}/workflows`, auth(inst))).json();
    assert.deepEqual(workflows, ["echo"]);

    // Push work over HTTP → a run is minted and observable.
    const started = await fetch(`${inst.url}/workflows/echo/runs`, { method: "POST", body: "{}", ...auth(inst) });
    assert.equal(started.status, 201);
    const { runId } = (await started.json()) as { runId: string };
    assert.ok(runId);

    const runs = (await (await fetch(`${inst.url}/runs`, auth(inst))).json()) as Array<{
      runId: string;
      workflow: string;
    }>;
    assert.ok(runs.some((r) => r.runId === runId && r.workflow === "echo"));

    const status = (await (await fetch(`${inst.url}/runs/${runId}`, auth(inst))).json()) as {
      workflow: string;
      status: string;
    };
    assert.equal(status.workflow, "echo");
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unknown workflow start is a 404", async () => {
  const { inst, dir } = await bootPublished();
  try {
    const res = await fetch(`${inst.url}/workflows/nope/runs`, { method: "POST", body: "{}", ...auth(inst) });
    assert.equal(res.status, 404);
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a supplied Instance token is the accepted credential (deployed: it comes from the Secret)", async () => {
  const { inst, dir } = await bootPublished({ instanceToken: "tok-from-secret" });
  try {
    assert.equal(inst.instanceToken, "tok-from-secret");
    const ok = await fetch(`${inst.url}/runs`, { headers: { authorization: "Bearer tok-from-secret" } });
    assert.equal(ok.status, 200);
    const bad = await fetch(`${inst.url}/runs`, { headers: { authorization: "Bearer minted-elsewhere" } });
    assert.equal(bad.status, 401);
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fresh boot on the same store restores an in-flight run", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "jr2-instance-"));
  const dbPath = join(dbDir, "state.db");

  // Boot A: publish, start a run (the stub keeps it live), let it persist, then shut down.
  const storeA = new SqliteSnapshotStore(dbPath);
  const { inst: instA, dir } = await bootPublished({ store: storeA });
  const { runId } = await instA.host.start("echo");
  await waitFor(async () => (await storeA.load(runId)) !== undefined);
  await instA.close();

  // Boot B: a brand-new process on the SAME db file and volume → it boots from `current`, and
  // restore re-attaches the run.
  const storeB = new SqliteSnapshotStore(dbPath);
  const instB = await startInstance({ dir, store: storeB, reconcile: () => true, signingKey: KEY });
  try {
    assert.ok(instB.host.status(runId), "run must be re-attached after a fresh boot");
    assert.equal(instB.host.status(runId)?.workflow, "echo");
    assert.deepEqual(instB.collected, [], "the current Assembly is held");
  } finally {
    await instB.close();
    for (const d of [dir, dbDir]) await rm(d, { recursive: true, force: true });
  }
});

// ---- A run holds the Assembly it started under (ADR-0069) -----------------------------------
// A publish strands nothing: a live run restores inside the Assembly its snapshot names, and that
// Assembly stays on the volume until no live run holds it (ADR-0039's reachability).

type Held = Array<{ hash: string; kitVersion: string; runs: string[] }>;
const heldOf = async (inst: RunningInstance): Promise<Held> =>
  ((await (await fetch(`${inst.url}/assembly`)).json()) as { held: Held }).held;

/** A scratch volume and a file-backed store, with `task` published as A and one run R parked in
 * A's `coding`; then `task` reshaped and published as B. The process is closed: the next boot is a
 * restart. */
async function heldScenario(): Promise<{
  dir: string;
  dbDir: string;
  dbPath: string;
  a: string;
  b: string;
  r: string;
}> {
  const dir = await scratchInstance("held");
  const dbDir = await mkdtemp(join(tmpdir(), "jr2-held-"));
  const dbPath = join(dbDir, "state.db");
  const store = new SqliteSnapshotStore(dbPath);
  const inst = await startInstance({ dir, store, signingKey: KEY });
  const a = await publishTree(inst, dir, { "workflows/task.ts": machineSrc("task", "coding") });
  const { runId: r } = await inst.host.start("task");
  await waitFor(async () => (await store.load(r)) !== null);
  const b = await publishTree(inst, dir, { "workflows/task.ts": machineSrc("task", "implementing") });
  await inst.close();
  return { dir, dbDir, dbPath, a, b, r };
}

async function restart(
  s: { dir: string; dbPath: string },
  opts: Partial<Parameters<typeof startInstance>[0]> = {},
): Promise<RunningInstance> {
  return startInstance({
    dir: s.dir,
    store: new SqliteSnapshotStore(s.dbPath),
    reconcile: () => true,
    signingKey: KEY,
    ...opts,
  });
}

async function cleanup(s: { dir: string; dbDir: string }): Promise<void> {
  for (const d of [s.dir, s.dbDir]) await rm(d, { recursive: true, force: true });
}

test("publish A, start R, publish B with another shape, restart: R resumes under A, and new runs start under B", async () => {
  const s = await heldScenario();
  const inst = await restart(s);
  try {
    assert.equal(inst.assembly?.hash, s.b, "the restart boots from `current`");
    assert.deepEqual(inst.restored, { reattached: [s.r], lost: [], drifted: [], failed: [] });
    assert.equal(inst.host.status(s.r)?.value, "coding", "A's state: the reshape stranded nothing");
    assert.equal(inst.host.status(s.r)?.assembly, s.a);
    assert.deepEqual(inst.host.workflows(), ["task"], "the registry is B's alone");
    const next = await inst.host.start("task");
    assert.equal(inst.host.status(next.runId)?.value, "implementing", "a new start runs B");
    assert.equal(inst.host.status(next.runId)?.assembly, s.b);
    assert.deepEqual(inst.collected, []);
  } finally {
    await inst.close();
    await cleanup(s);
  }
});

test("held lists every Assembly a live run holds, current first; R finishing lets the next sweep collect A", async () => {
  const s = await heldScenario();
  const collectedHourly: string[][] = [];
  mock.timers.enable({ apis: ["setInterval"] });
  const inst = await restart(s, { onCollect: (c) => collectedHourly.push(c) });
  // The sweep is not awaited by the timer, so a sweep that collects nothing is given time to.
  const hour = async () => {
    mock.timers.tick(60 * 60 * 1000);
    await new Promise((r) => setTimeout(r, 100));
  };
  try {
    assert.deepEqual(await heldOf(inst), [
      { hash: s.b, kitVersion: KIT_VERSION, runs: [] },
      { hash: s.a, kitVersion: KIT_VERSION, runs: [s.r] },
    ]);
    // While R is live, a sweep removes nothing.
    await hour();
    assert.deepEqual(collectedHourly, []);
    assert.deepEqual(onVolume(s.dir, s.a), { tree: true, record: true });

    await inst.host.cancel(s.r);
    mock.timers.tick(60 * 60 * 1000);
    await waitFor(() => collectedHourly.length > 0);
    assert.deepEqual(collectedHourly, [[s.a]], "the hourly sweep names what it collected");
    assert.deepEqual(onVolume(s.dir, s.a), { tree: false, record: false });
    assert.deepEqual(onVolume(s.dir, s.b), { tree: true, record: true }, "B is current");
    assert.deepEqual(await heldOf(inst), [{ hash: s.b, kitVersion: KIT_VERSION, runs: [] }]);
  } finally {
    await inst.close();
    mock.timers.reset();
    await cleanup(s);
  }
});

test("a publish collects what nothing holds: A stays while R holds it, the unheld B goes when C lands", async () => {
  const s = await heldScenario();
  const inst = await restart(s);
  try {
    const answer = await admitTree(inst, s.dir, { "workflows/task.ts": machineSrc("task", "reviewing") });
    assert.equal(answer.status, 200);
    const c = answer.body.hash as string;
    assert.deepEqual(answer.body.collected, [s.b], "B was current, and no run holds it");
    assert.deepEqual(answer.body.held, [
      { hash: c, kitVersion: KIT_VERSION, runs: [] },
      { hash: s.a, kitVersion: KIT_VERSION, runs: [s.r] },
    ]);
    assert.deepEqual(await hashesOnVolume(s.dir), [s.a, c].sort());
  } finally {
    await inst.close();
    await cleanup(s);
  }
});

/** Restart `s`, and keep what each deferred restore did (ADR-0069). */
async function restartWaiting(s: { dir: string; dbPath: string }) {
  const restores: Array<{
    assembly: string;
    reattached: string[];
    lost: string[];
    drifted: string[];
    failed: string[];
  }> = [];
  const inst = await restart(s, { onRestore: (o) => restores.push(o) });
  return { inst, restores };
}

test("a boot whose `current` names a missing tree restores nothing: R waits, and the first publish restores it inside A (ADR-0069)", async () => {
  const s = await heldScenario();
  await writeFile(join(s.dir, ".jr2", "assemblies", "current"), "0123456789ab\n");
  const { inst, restores } = await restartWaiting(s);
  try {
    assert.equal(inst.assembly, null);
    assert.match(inst.assemblyError ?? "", /current names 0123456789ab, which is not on the volume/);
    assert.deepEqual(inst.host.workflows(), []);
    assert.deepEqual(inst.restored, { reattached: [], lost: [], drifted: [], failed: [] });
    assert.deepEqual(inst.waiting, [s.r], "no config is bound, so the row waits for the publish");
    assert.equal(inst.host.status(s.r), undefined, "not re-attached");
    assert.equal((await inst.host.read(s.r))?.status, "active", "the row is untouched");
    assert.deepEqual(
      await heldOf(inst),
      [{ hash: s.a, kitVersion: KIT_VERSION, runs: [s.r] }],
      "a waiting row holds A",
    );
    assert.deepEqual(inst.collected, [s.b], "B is neither the pointer's target nor held");

    const c = await publishTree(inst, s.dir, { "workflows/task.ts": machineSrc("task", "reviewing") });
    assert.deepEqual(restores, [{ assembly: c, reattached: [s.r], lost: [], drifted: [], failed: [] }]);
    assert.equal(inst.host.status(s.r)?.value, "coding", "inside A, the Assembly its blob names");
    assert.equal(inst.host.status(s.r)?.assembly, s.a);
  } finally {
    await inst.close();
    await cleanup(s);
  }
});

test("a deferred restore that throws as a whole stays pending; the next publish retries it and does not restore a run started between them a second time (ADR-0069)", async () => {
  const s = await heldScenario();
  await rm(join(s.dir, ".jr2", "assemblies", "current"));
  // A store whose next `live()` throws, as a store blip would: the restore fails as a whole.
  class FlakyStore extends SqliteSnapshotStore {
    failLive = false;
    override async live(): ReturnType<SqliteSnapshotStore["live"]> {
      if (this.failLive) {
        this.failLive = false;
        throw new Error("store blip");
      }
      return super.live();
    }
  }
  const store = new FlakyStore(s.dbPath);
  const restores: Array<{ assembly: string } & RestoreOutcome> = [];
  const inst = await restart(s, { store, onRestore: (o) => restores.push(o) });
  try {
    assert.deepEqual(inst.waiting, [s.r]);
    assert.equal(inst.host.restorePending, true);

    store.failLive = true;
    await publishTree(inst, s.dir, { "workflows/task.ts": machineSrc("task", "reviewing") });
    assert.deepEqual(restores, [], "the restore threw, so nothing is announced");
    assert.equal(inst.host.restorePending, true, "left pending for the next publish");
    assert.equal(inst.host.status(s.r), undefined, "R is not re-attached");

    // N starts under the published Assembly while the restore is pending, and gets a row.
    const { runId: n } = await inst.host.start("task");
    await waitFor(async () => (await store.load(n)) !== null);

    const d = await publishTree(inst, s.dir, { "workflows/task.ts": machineSrc("task", "merging") });
    assert.deepEqual(restores, [{ assembly: d, reattached: [s.r], lost: [], drifted: [], failed: [] }]);
    assert.equal(inst.host.restorePending, false);
    assert.equal(inst.host.status(s.r)?.assembly, s.a, "R restores inside A");
    assert.equal(inst.host.status(n)?.value, "reviewing", "N keeps its one actor");
  } finally {
    await inst.close();
    await cleanup(s);
  }
});

test("a boot with no pointer leaves R waiting; the first publish restores R inside A, and a new start runs the published one (ADR-0069)", async () => {
  const s = await heldScenario();
  await rm(join(s.dir, ".jr2", "assemblies", "current"));
  const { inst, restores } = await restartWaiting(s);
  try {
    assert.equal(inst.assembly, null);
    assert.equal(inst.assemblyError, undefined, "no pointer is no error: nothing was ever published");
    assert.deepEqual(inst.waiting, [s.r]);
    assert.deepEqual(inst.restored.reattached, []);
    assert.deepEqual(onVolume(s.dir, s.a), { tree: true, record: true });

    const answer = await admitTree(inst, s.dir, { "workflows/task.ts": machineSrc("task", "reviewing") });
    assert.equal(answer.status, 200);
    const c = answer.body.hash as string;
    assert.deepEqual(restores, [{ assembly: c, reattached: [s.r], lost: [], drifted: [], failed: [] }]);
    assert.equal(inst.host.status(s.r)?.value, "coding", "the held Assembly's state");
    assert.equal(inst.host.status(s.r)?.assembly, s.a);
    assert.deepEqual(answer.body.held, [
      { hash: c, kitVersion: KIT_VERSION, runs: [] },
      { hash: s.a, kitVersion: KIT_VERSION, runs: [s.r] },
    ]);
    const next = await inst.host.start("task");
    assert.equal(inst.host.status(next.runId)?.value, "reviewing", "a new start runs the published Assembly");
    assert.equal(inst.host.status(next.runId)?.assembly, c);

    // The restore ran once: a second publish restores nothing again.
    await publishTree(inst, s.dir, { "workflows/task.ts": machineSrc("task", "merging") });
    assert.equal(restores.length, 1);
  } finally {
    await inst.close();
    await cleanup(s);
  }
});

/** Restart on a volume `damage` changed, and require R drifted with a reason matching `reason`,
 * its snapshot kept and still read where it was parked. */
async function driftsAfter(
  damage: (s: Awaited<ReturnType<typeof heldScenario>>) => Promise<void>,
  reason: (s: { a: string }) => RegExp,
) {
  const s = await heldScenario();
  await damage(s);
  const aLeft = onVolume(s.dir, s.a);
  const inst = await restart(s);
  try {
    assert.deepEqual(inst.restored.drifted, [s.r]);
    assert.deepEqual(inst.restored.reattached, []);
    // The boot collects after restore (D5): the row drifted at this boot holds nothing, so what
    // the damage left of A goes in the same boot.
    assert.deepEqual(inst.collected, aLeft.tree || aLeft.record ? [s.a] : [], "A goes at the boot R drifts");
    assert.deepEqual(onVolume(s.dir, s.a), { tree: false, record: false });
    assert.equal(inst.host.status(s.r), undefined, "not live");
    const read = await inst.host.read(s.r);
    assert.equal(read?.status, "drifted");
    assert.match(read?.reason ?? "", reason(s));
    assert.equal(read?.value, "coding", "refused, kept: still parked exactly where it was");
    assert.equal(read?.assembly, s.a);
    assert.deepEqual(
      await heldOf(inst),
      [{ hash: s.b, kitVersion: KIT_VERSION, runs: [] }],
      "a drifted row holds nothing",
    );
  } finally {
    await inst.close();
    await cleanup(s);
  }
}

test("an Assembly the volume lost drifts the runs that held it, naming the hash (ADR-0030, ADR-0069)", async () => {
  await driftsAfter(
    async (s) => {
      await rm(join(s.dir, ".jr2", "assemblies", s.a), { recursive: true });
      await rm(join(s.dir, ".jr2", "assemblies", `${s.a}.json`));
    },
    (s) => new RegExp(`task.*Assembly ${s.a} is not on the volume`),
  );
});

test("an Assembly published for another Kit version drifts its runs, naming the hash and both versions", async () => {
  await driftsAfter(
    async (s) => {
      const path = join(s.dir, ".jr2", "assemblies", `${s.a}.json`);
      const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      await writeFile(path, JSON.stringify({ ...record, kitVersion: "0.0.0-old" }));
    },
    (s) =>
      new RegExp(
        `Assembly ${s.a} was published for Kit version 0\\.0\\.0-old; this Orchestrator is ${KIT_VERSION.replace(/\./g, "\\.")}`,
      ),
  );
});

test("an Assembly whose Workflow no longer imports drifts its runs, naming the hash and the error", async () => {
  await driftsAfter(
    (s) => rm(join(s.dir, ".jr2", "assemblies", s.a, "workflows", "task.ts")),
    (s) => new RegExp(`the Assembly ${s.a} does not load: .*workflows/task\\.ts`),
  );
});

test("the fingerprint check still fires inside one Assembly: a stamp that differs is drift (ADR-0030)", async () => {
  await driftsAfter(
    async (s) => {
      const db = new DatabaseSync(s.dbPath);
      db.prepare(
        `UPDATE machine_snapshots SET snapshot = json_set(snapshot, '$.machine', '000000000000') WHERE run_id = ?`,
      ).run(s.r);
      db.close();
    },
    (s) => new RegExp(`task" in Assembly ${s.a} changed shape.*saved under 000000000000`),
  );
});

test("a run whose restore failed still holds its Assembly: the collection keeps A (ADR-0030, ADR-0069)", async () => {
  const s = await heldScenario();
  const logged = mock.method(console, "error", () => {});
  const inst = await restart(s, {
    reconcile: () => {
      throw new Error("kubectl blip");
    },
  });
  try {
    assert.deepEqual(inst.restored.failed, [s.r]);
    assert.deepEqual(inst.collected, [], "the live ROW holds A, not this process");
    assert.deepEqual(onVolume(s.dir, s.a), { tree: true, record: true });
    assert.deepEqual(await heldOf(inst), [
      { hash: s.b, kitVersion: KIT_VERSION, runs: [] },
      { hash: s.a, kitVersion: KIT_VERSION, runs: [s.r] },
    ]);
  } finally {
    logged.mock.restore();
    await inst.close();
    await cleanup(s);
  }
});

test("one import per held Assembly: two runs under A restore from one import", async () => {
  const dir = await scratchInstance("once");
  const dbDir = await mkdtemp(join(tmpdir(), "jr2-once-"));
  const dbPath = join(dbDir, "state.db");
  const s = { dir, dbDir, dbPath };
  try {
    const store = new SqliteSnapshotStore(dbPath);
    const instA = await startInstance({ dir, store, signingKey: KEY });
    const a = await publishTree(instA, dir, { "workflows/task.ts": machineSrc("task", "coding") });
    const one = await instA.host.start("task");
    const two = await instA.host.start("task");
    await waitFor(async () => (await store.load(two.runId)) !== null);
    const b = await publishTree(instA, dir, { "workflows/task.ts": machineSrc("task", "implementing") });
    await instA.close();

    // Counted through the import seam, not the module: Node's ESM cache would hide a second
    // import of the same URL, so only the loads the instance asks for show the per-hash cache.
    const loads: string[] = [];
    const inst = await restart(s, {
      importWorkflows: (root) => {
        loads.push(root);
        return loadWorkflows(root);
      },
    });
    try {
      assert.deepEqual([...inst.restored.reattached].sort(), [one.runId, two.runId].sort());
      assert.equal(inst.host.status(one.runId)?.value, "coding");
      assert.equal(inst.host.status(two.runId)?.value, "coding");
      const root = (hash: string) => join(dir, ".jr2", "assemblies", hash);
      assert.deepEqual(loads, [root(b), root(a)], "one load of the current B, one of the held A");
      await inst.heldMachines();
      assert.equal(loads.length, 2, "the Repo pass reads the same entries");
    } finally {
      await inst.close();
    }
  } finally {
    await cleanup(s);
  }
});

test("a fault while reading a held Assembly's record is `failed`, not drift: the row stays live and A is kept (ADR-0030)", async () => {
  const s = await heldScenario();
  const record = join(s.dir, ".jr2", "assemblies", `${s.a}.json`);
  await chmod(record, 0o000);
  const logged = mock.method(console, "error", () => {});
  const inst = await restart(s);
  try {
    assert.deepEqual(inst.restored.failed, [s.r], "EACCES is a fault, not an Assembly that is gone");
    assert.deepEqual(inst.restored.drifted, []);
    assert.deepEqual(inst.collected, [], "the live row holds A, so the boot that misread it removes nothing");
    assert.equal((await inst.host.read(s.r))?.status, "active", "the row stays live, read as its snapshot");
    assert.deepEqual(onVolume(s.dir, s.a), { tree: true, record: true });
  } finally {
    logged.mock.restore();
    await inst.close();
    await chmod(record, 0o644);
  }
  // The fault clears: the next boot resumes R inside A.
  const next = await restart(s);
  try {
    assert.deepEqual(next.restored.reattached, [s.r]);
    assert.equal(next.host.status(s.r)?.value, "coding");
  } finally {
    await next.close();
    await cleanup(s);
  }
});

test("a held Assembly's record that does not parse is `failed`; a tree with no record drifts naming the record", async () => {
  const s = await heldScenario();
  const record = join(s.dir, ".jr2", "assemblies", `${s.a}.json`);
  await writeFile(record, "{ not json");
  const logged = mock.method(console, "error", () => {});
  const inst = await restart(s);
  try {
    assert.deepEqual(inst.restored.failed, [s.r]);
    assert.deepEqual(inst.collected, []);
    assert.match(
      String(logged.mock.calls.map((c) => c.arguments[0]).join("\n")),
      new RegExp(`${s.a}\\.json does not parse`),
    );
  } finally {
    logged.mock.restore();
    await inst.close();
  }
  await rm(record);
  const again = await restart(s);
  try {
    assert.deepEqual(again.restored.drifted, [s.r]);
    assert.match(
      (await again.host.read(s.r))?.reason ?? "",
      new RegExp(`Assembly ${s.a} is on the volume, but its record ${s.a}\\.json is not`),
    );
  } finally {
    await again.close();
    await cleanup(s);
  }
});

test("a current record this process cannot read is no current Assembly, and the pointer's tree is kept (ADR-0048)", async () => {
  const s = await heldScenario();
  await writeFile(join(s.dir, ".jr2", "assemblies", `${s.b}.json`), "{ not json");
  const inst = await restart(s);
  try {
    assert.equal(inst.assembly, null);
    assert.match(inst.assemblyError ?? "", new RegExp(`current names ${s.b}, which cannot be read: .*does not parse`));
    assert.deepEqual(inst.waiting, [s.r], "no current Assembly: R waits for the publish");
    assert.deepEqual(inst.restored.reattached, []);
    assert.deepEqual(inst.collected, [], "the pointer is a root whatever it names, and R's row holds A");
    assert.deepEqual(onVolume(s.dir, s.b), { tree: true, record: true });
  } finally {
    await inst.close();
    await cleanup(s);
  }
});

test("a `current` pointer this process cannot read is no current Assembly: the boot serves, R waits, and nothing is collected (ADR-0048)", async () => {
  const s = await heldScenario();
  const pointer = join(s.dir, ".jr2", "assemblies", "current");
  await chmod(pointer, 0o000);
  const logged = mock.method(console, "error", () => {});
  try {
    const inst = await restart(s);
    try {
      assert.equal(inst.assembly, null);
      assert.match(inst.assemblyError ?? "", /current cannot be read: .*EACCES/);
      assert.deepEqual(inst.waiting, [s.r], "no current Assembly: R waits for the publish");
      assert.deepEqual(inst.collected, [], "the pointer cannot be read, so nothing it may name is removed");
      assert.deepEqual(onVolume(s.dir, s.a), { tree: true, record: true });
      assert.deepEqual(onVolume(s.dir, s.b), { tree: true, record: true });
    } finally {
      await inst.close();
    }
  } finally {
    logged.mock.restore();
    await chmod(pointer, 0o644);
    await cleanup(s);
  }
});

test("a Kit bump: the boot restores nothing and drifts nothing; the publish drifts the runs of the old Kit version and collects their Assemblies (ADR-0069)", async () => {
  const dir = await scratchInstance("kitbump");
  const dbDir = await mkdtemp(join(tmpdir(), "jr2-kitbump-"));
  const dbPath = join(dbDir, "state.db");
  const s = { dir, dbDir, dbPath };
  try {
    // R1 under the older O, R2 under P, which stays current.
    const store = new SqliteSnapshotStore(dbPath);
    const first = await startInstance({ dir, store, signingKey: KEY });
    const o = await publishTree(first, dir, { "workflows/task.ts": machineSrc("task", "coding") });
    const { runId: r1 } = await first.host.start("task");
    const p = await publishTree(first, dir, { "workflows/task.ts": machineSrc("task", "implementing") });
    const { runId: r2 } = await first.host.start("task");
    await waitFor(async () => (await store.load(r1)) !== null && (await store.load(r2)) !== null);
    await first.close();
    // The image rolled first: every record names the Kit version it was published for.
    for (const hash of [o, p]) {
      const path = join(dir, ".jr2", "assemblies", `${hash}.json`);
      const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      await writeFile(path, JSON.stringify({ ...record, kitVersion: "0.0.0-old" }));
    }

    const restores: Array<{ assembly: string; drifted: string[]; reattached: string[] }> = [];
    const inst = await restart(s, { onRestore: (r) => restores.push(r) });
    try {
      assert.equal(inst.assembly, null);
      assert.match(inst.assemblyError ?? "", new RegExp(`current names ${p}, published for Kit version 0\\.0\\.0-old`));
      assert.deepEqual(inst.restored, { reattached: [], lost: [], drifted: [], failed: [] });
      assert.deepEqual([...inst.waiting].sort(), [r1, r2].sort(), "an image rollback can still resume both");
      for (const r of [r1, r2]) assert.equal((await inst.host.read(r))?.status, "active", "nothing drifted");
      assert.deepEqual(inst.collected, []);
      assert.deepEqual(onVolume(dir, o), { tree: true, record: true });
      assert.deepEqual(onVolume(dir, p), { tree: true, record: true });
      assert.deepEqual(
        await heldOf(inst),
        [
          { hash: o, kitVersion: "0.0.0-old", runs: [r1] },
          { hash: p, kitVersion: "0.0.0-old", runs: [r2] },
        ].sort((x, y) => (x.hash < y.hash ? -1 : 1)),
        "the waiting rows hold their Assemblies",
      );

      // The publish second: both runs drift now, inside the restore it runs.
      const answer = await admitTree(inst, dir, { "workflows/task.ts": machineSrc("task", "reviewing") });
      assert.equal(answer.status, 200);
      const n = answer.body.hash as string;
      assert.equal(restores.length, 1);
      assert.equal(restores[0]!.assembly, n);
      assert.deepEqual([...restores[0]!.drifted].sort(), [r1, r2].sort());
      const version = KIT_VERSION.replace(/\./g, "\\.");
      for (const [r, hash] of [
        [r1, o],
        [r2, p],
      ] as const) {
        const read = await inst.host.read(r);
        assert.equal(read?.status, "drifted");
        assert.match(
          read?.reason ?? "",
          new RegExp(`Assembly ${hash} was published for Kit version 0\\.0\\.0-old; this Orchestrator is ${version}`),
        );
      }
      // The collection that follows the restore takes both: O, which only R1's row held, and P,
      // which was the pointer's target and is neither current nor held now that the pointer moved.
      assert.deepEqual(answer.body.collected, [o, p].sort());
      assert.deepEqual(answer.body.held, [{ hash: n, kitVersion: KIT_VERSION, runs: [] }]);
      assert.deepEqual(await hashesOnVolume(dir), [n]);
    } finally {
      await inst.close();
    }
  } finally {
    await cleanup(s);
  }
});

test("a tree with no record, and a record with no tree, are collected at boot (ADR-0069)", async () => {
  const s = await heldScenario();
  const store = join(s.dir, ".jr2", "assemblies");
  // A crash between the record's removal and the tree's leaves a tree alone; the reverse, a record.
  await mkdir(join(store, "aaaaaaaaaaaa", "workflows"), { recursive: true });
  await writeFile(join(store, "bbbbbbbbbbbb.json"), "{}");
  await mkdir(join(store, ".staging-0123456789ab-dead"), { recursive: true });
  const inst = await restart(s);
  try {
    assert.deepEqual(inst.collected, ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    assert.deepEqual(await hashesOnVolume(s.dir), [s.a, s.b].sort(), "current and held stay");
    assert.ok(existsSync(join(store, "current")));
  } finally {
    await inst.close();
    await cleanup(s);
  }
});

test("module contract (ADR-0011): no `machine` named export is refused at the door with a pointed error", async () => {
  const dir = await scratchInstance("contract");
  const inst = await startInstance({ dir, store: new SqliteSnapshotStore(":memory:"), signingKey: KEY });
  try {
    const answer = await admitTree(inst, dir, {
      "workflows/legacy.ts": `import { setup } from "xstate";\nexport default setup({}).createMachine({ id: "legacy", initial: "a", states: { a: {} } });\n`,
    });
    assert.equal(answer.status, 422);
    assert.match(
      String((answer.body.report as string[])[0]),
      /workflow "legacy" .* has no `machine` named export .*export const machine/,
    );
    assert.deepEqual(inst.host.workflows(), []);
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the vocabulary rides the machine (ADR-0015) and is resolvable on the host after discovery", async () => {
  const dir = await scratchInstance("events");
  const inst = await startInstance({ dir, store: new SqliteSnapshotStore(":memory:"), signingKey: KEY });
  try {
    await publishTree(inst, dir, {
      "workflows/gated.ts":
        `import { z } from "zod";\n` +
        `import { defineEvent } from "@jr2/agent-protocol";\n` +
        `import { jr2Setup } from "@jr2/orchestrator";\n` +
        `const approve = defineEvent({ name: "approve", input: z.object({}) });\n` +
        `export const machine = jr2Setup({ events: [approve] })` +
        `.createMachine({ id: "gated", initial: "a", states: { a: { on: { approve: "b" } }, b: {} } });\n`,
    });
    const vocab = inst.host.machine("gated")?.events;
    assert.deepEqual(
      vocab?.map((e) => e.name),
      ["approve"],
      "the machine's vocabulary must be readable after discovery",
    );
    assert.equal(vocab?.[0]?.audience, undefined, "unset: each writing state decides");
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a publish swaps added, changed and removed workflows, and stamps new runs with its hash (ADR-0069)", async () => {
  const dir = await scratchInstance("reload");
  const inst = await startInstance({ dir, store: new SqliteSnapshotStore(":memory:"), signingKey: KEY });
  try {
    assert.ok(inst.publishToken, "a publish token is minted per boot when none is supplied");
    assert.notEqual(inst.publishToken, inst.instanceToken);
    assert.deepEqual(inst.workflows, [], "nothing is published yet");
    const first = await publishTree(inst, dir, { "workflows/alpha.ts": machineSrc("alpha", "one") });
    assert.deepEqual(inst.host.workflows(), ["alpha"]);
    assert.equal(inst.assembly?.hash, first);
    assert.equal(inst.assembly?.root, join(dir, ".jr2", "assemblies", first));
    const live = await inst.host.start("alpha");
    assert.equal(inst.host.status(live.runId)?.assembly, first);

    // Add a new file AND change an existing one, in one publish.
    const second = await publishTree(inst, dir, {
      "workflows/alpha.ts": machineSrc("alpha", "two"),
      "workflows/beta.ts": machineSrc("beta", "ready"),
    });
    assert.deepEqual([...inst.host.workflows()].sort(), ["alpha", "beta"]);
    // The changed code took effect: a fresh start of alpha lands in its NEW initial state.
    const { runId } = await inst.host.start("alpha");
    assert.equal(inst.host.status(runId)?.value, "two");
    assert.equal(inst.host.status(runId)?.assembly, second);
    // The live run keeps the def and the Assembly it started under.
    assert.equal(inst.host.status(live.runId)?.value, "one");
    assert.equal(inst.host.status(live.runId)?.assembly, first);

    // Drop a file → the publish drops it.
    await publishTree(inst, dir, { "workflows/beta.ts": machineSrc("beta", "ready") });
    assert.deepEqual(inst.host.workflows(), ["beta"]);
    await assert.rejects(inst.host.start("alpha"), /no workflow registered as "alpha"/);
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("images/default is a PATH CONVENTION, not discovery — one path, checked (ADR-0049/0050)", async () => {
  // The `images/<name>` scan retired with the roster it resembled: a Machine carries its own image
  // now, so a dirname is not a name any more. Exactly one path survives — the fallback leg
  // `jr2 init` scaffolds, so a local Machine never has to spell `import.meta.resolve("../images/default")`.
  const dir = await mkdtemp(join(tmpdir(), "jr2-images-"));
  try {
    assert.equal(await defaultImageContext(dir), undefined, "an instance that scaffolded none");

    await mkdir(join(dir, "images", "rust"), { recursive: true });
    await writeFile(join(dir, "images", "rust", "Dockerfile"), "FROM rust:1\n");
    assert.equal(await defaultImageContext(dir), undefined, "no other directory is looked at, let alone named");

    await mkdir(join(dir, "images", "default"), { recursive: true });
    await writeFile(join(dir, "images", "default", "Dockerfile"), "FROM node:24-slim\n");
    assert.equal(await defaultImageContext(dir), join(dir, "images", "default"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("images/default with no Dockerfile THROWS, naming the missing path", async () => {
  // That directory has no other reason to exist — staying quiet would leave a Sandbox Image its
  // author believes in and no converge ever builds.
  const dir = await mkdtemp(join(tmpdir(), "jr2-images-"));
  try {
    await mkdir(join(dir, "images", "default"), { recursive: true });
    await assert.rejects(defaultImageContext(dir), (err: Error) => {
      assert.match(err.message, /`images\/default` has no Dockerfile/);
      assert.ok(err.message.includes(join(dir, "images", "default", "Dockerfile")));
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadWorkflows: the same discovery and module contract, without booting (ADR-0049's walk)", async () => {
  // What `jr2 up` calls: a Machine carries its Agents, so the converge loads the registered
  // Machines and walks them. Filename = name, sorted, `_`-prefixed helpers and `.d.ts` ignored —
  // the `_` rule is load-bearing here (ADR-0049: a Machine meant only for composition, or a
  // module of shared definitions, lives in a `_`-prefixed file).
  const dir = await mkdtemp(join(pkgDir, "test-loadworkflows-"));
  try {
    assert.deepEqual(await loadWorkflows(dir), [], "an instance with no workflows/ yet");

    await mkdir(join(dir, "workflows"), { recursive: true });
    await writeFile(join(dir, "workflows", "second.ts"), machineSrc("second", "idle"));
    await writeFile(join(dir, "workflows", "first.ts"), machineSrc("first", "idle"));
    await writeFile(join(dir, "workflows", "_agents.ts"), "export const shared = 1;\n");
    await writeFile(join(dir, "workflows", "types.d.ts"), "export type T = 1;\n");

    const loaded = await loadWorkflows(dir);
    assert.deepEqual(
      loaded.map((w) => w.name),
      ["first", "second"],
    );
    assert.equal(loaded[0]!.machine.id, "first");

    // The module contract is the SAME one the boot enforces — a file that exports no `machine`
    // fails here too, so `jr2 up` refuses before it converges rather than deploying a broken image.
    await writeFile(join(dir, "workflows", "broken.ts"), "export const nope = 1;\n");
    await assert.rejects(loadWorkflows(dir), /workflow "broken".*no `machine` named export/s);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadWorkflows: only ENOENT maps to empty — an unreadable workflows/ path throws", async () => {
  // A directory that exists but cannot be read must be loud, never "no workflows": the silent
  // reading deploys an instance that runs nothing and preflights nothing.
  const dir = await mkdtemp(join(tmpdir(), "jr2-workflows-"));
  try {
    await writeFile(join(dir, "workflows"), "not a directory\n");
    await assert.rejects(loadWorkflows(dir), (err: NodeJS.ErrnoException) => err.code === "ENOTDIR");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Back-date a row's last write by `daysAgo` days, through a second connection — the store has no
 * clock seam, and the boot must not grow one for a test. */
function age(dbPath: string, runId: string, daysAgo: number): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(`UPDATE machine_snapshots SET updated_at = ? WHERE run_id = ?`).run(
    new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    runId,
  );
  db.close();
}

/** A finished run's row as the host writes it: the blob `read()` projects. */
const finished = { workflow: "echo", instanceId: "i-1", snapshot: { status: "done", value: "end", context: {} } };

test("the boot sweeps a finished run older than a week, and `read()` then answers it unknown (ADR-0065)", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "jr2-sweep-"));
  const dbPath = join(dbDir, "state.db");
  try {
    const seed = new SqliteSnapshotStore(dbPath);
    await seed.init();
    await seed.save("old-run", finished, "done");
    await seed.save("new-run", finished, "done");
    await seed.close();
    age(dbPath, "old-run", 8);
    age(dbPath, "new-run", 6);

    const inst = await startInstance({ dir: dbDir, store: new SqliteSnapshotStore(dbPath), signingKey: KEY });
    try {
      assert.equal(await inst.host.read("old-run"), undefined, "swept: `jr2 status` answers `no run`");
      assert.equal((await inst.host.read("new-run"))?.status, "done", "six days old: still readable");
      assert.deepEqual(await inst.host.candidates("old", 10), [], "a swept id frees its abbreviations");
    } finally {
      await inst.close();
    }
  } finally {
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("the sweep runs again every hour while the Orchestrator is up (ADR-0065)", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "jr2-sweep-"));
  const dbPath = join(dbDir, "state.db");
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const inst = await startInstance({ dir: dbDir, store: new SqliteSnapshotStore(dbPath), signingKey: KEY });
    try {
      // A row that ages past the week while the process is up — the boot sweep already ran.
      const other = new SqliteSnapshotStore(dbPath);
      await other.init();
      await other.save("aged-run", finished, "done");
      await other.close();
      age(dbPath, "aged-run", 8);
      assert.equal((await inst.host.read("aged-run"))?.status, "done");

      mock.timers.tick(60 * 60 * 1000);
      assert.equal(await inst.host.read("aged-run"), undefined, "the hourly sweep deleted it");
    } finally {
      await inst.close();
    }
  } finally {
    mock.timers.reset();
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("a failed sweep, at boot or on the hour, is logged and never fails the Orchestrator (ADR-0065)", async (t) => {
  const dbDir = await mkdtemp(join(tmpdir(), "jr2-sweep-"));
  const store = new SqliteSnapshotStore(join(dbDir, "state.db"));
  const sweep = store.sweep.bind(store);
  let sweeps = 0;
  store.sweep = async (olderThan) => {
    if (++sweeps <= 2) throw new Error("SQLITE_BUSY");
    return sweep(olderThan);
  };
  const logged = t.mock.method(console, "error", () => {});
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    // The boot has resumed runs by the time it sweeps: a failure there is logged, not thrown.
    const inst = await startInstance({ dir: dbDir, store, signingKey: KEY });
    try {
      assert.equal(sweeps, 1);
      for (const _ of [1, 2]) {
        mock.timers.tick(60 * 60 * 1000);
        await new Promise((r) => setImmediate(r));
      }
      assert.equal(sweeps, 3, "the hour after a failure sweeps again");
      const failed = logged.mock.calls.filter((c) => String(c.arguments[0]) === "sweep failed: SQLITE_BUSY");
      assert.equal(failed.length, 2);
    } finally {
      await inst.close();
    }
  } finally {
    mock.timers.reset();
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("a collection waits for a landing publish: an hourly sweep during the door's import takes nothing (ADR-0069)", async () => {
  const dir = await scratchInstance("lock");
  mock.timers.enable({ apis: ["setInterval"] });
  const inst = await startInstance({ dir, store: new SqliteSnapshotStore(":memory:"), signingKey: KEY });
  try {
    // The module holds the door's import open: its tree is under its hash, with no record yet.
    const slow = await stageTree(dir, {
      "workflows/slow.ts": `await new Promise((r) => setTimeout(r, 300));\n` + machineSrc("slow", "a"),
    });
    const landing = inst.admit(slow.staging, { hash: slow.hash, kitVersion: KIT_VERSION });
    await waitFor(() => existsSync(join(dir, ".jr2", "assemblies", slow.hash)));
    mock.timers.tick(60 * 60 * 1000);
    const answer = await landing;
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(onVolume(dir, slow.hash), { tree: true, record: true }, "the landing tree and its record stay");
    assert.equal(inst.assembly?.hash, slow.hash);
  } finally {
    mock.timers.reset();
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an onCollect that throws on the hour is logged, never an unhandled rejection (ADR-0065)", async (t) => {
  const s = await heldScenario();
  const logged = t.mock.method(console, "error", () => {});
  mock.timers.enable({ apis: ["setInterval"] });
  const inst = await restart(s, {
    onCollect: () => {
      throw new Error("stdout closed");
    },
  });
  try {
    await inst.host.cancel(s.r);
    mock.timers.tick(60 * 60 * 1000);
    await waitFor(() => logged.mock.calls.some((c) => String(c.arguments[0]).includes("stdout closed")));
    assert.ok(logged.mock.calls.some((c) => String(c.arguments[0]) === "collection announce failed: stdout closed"));
    assert.deepEqual(onVolume(s.dir, s.a), { tree: false, record: false }, "the collection itself went through");
  } finally {
    mock.timers.reset();
    await inst.close();
    await cleanup(s);
  }
});

test("a held read that fails after the landing never fails the publish: 200, the current Assembly alone (ADR-0069)", async (t) => {
  const dir = await scratchInstance("heldfault");
  const store = new SqliteSnapshotStore(":memory:");
  const live = store.liveAssemblies.bind(store);
  let broken = false;
  store.liveAssemblies = async () => {
    if (broken) throw new Error("SQLITE_BUSY");
    return live();
  };
  const logged = t.mock.method(console, "error", () => {});
  const inst = await startInstance({ dir, store, signingKey: KEY });
  try {
    await publishTree(inst, dir, { "workflows/task.ts": machineSrc("task", "coding") });
    broken = true;
    const next = await admitTree(inst, dir, { "workflows/task.ts": machineSrc("task", "implementing") });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    const hash = next.body.hash as string;
    assert.equal(inst.assembly?.hash, hash);
    assert.deepEqual(next.body.held, [{ hash, kitVersion: KIT_VERSION, runs: [] }]);
    assert.ok(logged.mock.calls.some((c) => String(c.arguments[0]).includes("SQLITE_BUSY")));
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed removal is reported and skipped: the collection goes on to the next hash (ADR-0039)", async (t) => {
  const dir = await scratchInstance("rmfault");
  const store = join(dir, ".jr2", "assemblies");
  for (const hash of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) {
    await mkdir(join(store, hash, "workflows"), { recursive: true });
    await writeFile(join(store, hash, "workflows", "x.ts"), "");
    await writeFile(join(store, `${hash}.json`), "{}");
  }
  // A file under aaaaaaaaaaaa/workflows cannot be unlinked.
  await chmod(join(store, "aaaaaaaaaaaa", "workflows"), 0o500);
  const logged = t.mock.method(console, "error", () => {});
  try {
    assert.deepEqual(await collectAssemblies(dir, new Set()), ["bbbbbbbbbbbb"]);
    assert.deepEqual(onVolume(dir, "bbbbbbbbbbbb"), { tree: false, record: false });
    assert.deepEqual(onVolume(dir, "aaaaaaaaaaaa"), { tree: true, record: false }, "the record went first");
    assert.ok(logged.mock.calls.some((c) => String(c.arguments[0]).includes("could not remove aaaaaaaaaaaa")));
    // The fault clears: a tree with no record is taken by the next sweep.
    await chmod(join(store, "aaaaaaaaaaaa", "workflows"), 0o755);
    assert.deepEqual(await collectAssemblies(dir, new Set()), ["aaaaaaaaaaaa"]);
    assert.deepEqual(onVolume(dir, "aaaaaaaaaaaa"), { tree: false, record: false });
  } finally {
    await chmod(join(store, "aaaaaaaaaaaa", "workflows"), 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
