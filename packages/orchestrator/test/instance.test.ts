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
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { defaultImageContext, loadWorkflows, startInstance, type RunningInstance } from "../src/instance.ts";
import { KIT_VERSION } from "../src/config.ts";
import { SqliteSnapshotStore } from "../src/snapshot-store.ts";
import { admitTree, FIXTURE_ASSEMBLY, publishTree, scratchInstance } from "./_assembly.ts";
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
    assert.deepEqual(instB.waiting, []);
  } finally {
    await instB.close();
    for (const d of [dir, dbDir]) await rm(d, { recursive: true, force: true });
  }
});

test("a boot with no current Assembly leaves live runs waiting, and the first publish restores them (ADR-0069)", async () => {
  // The Kit bump window: the new image boots on a pointer it may not load, so it serves no
  // Workflows. A restore then would write `lost` on every run. The runs wait, and the publish that
  // follows restores them under the Assembly it brings.
  const dbDir = await mkdtemp(join(tmpdir(), "jr2-instance-"));
  const dbPath = join(dbDir, "state.db");
  const storeA = new SqliteSnapshotStore(dbPath);
  const { inst: instA, dir } = await bootPublished({ store: storeA });
  const { runId } = await instA.host.start("echo");
  await waitFor(async () => (await storeA.load(runId)) !== undefined);
  await instA.close();
  // The volume loses its Assemblies; the state database stays.
  await rm(join(dir, ".jr2", "assemblies"), { recursive: true, force: true });

  const storeB = new SqliteSnapshotStore(dbPath);
  const restoredAfter: unknown[] = [];
  const instB = await startInstance({
    dir,
    store: storeB,
    reconcile: () => true,
    signingKey: KEY,
    onRestore: (r) => restoredAfter.push(r),
  });
  try {
    assert.equal(instB.assembly, null);
    assert.deepEqual(instB.restored, { reattached: [], lost: [], drifted: [], failed: [] });
    assert.deepEqual(instB.waiting, [runId], "named, and left untouched");
    assert.equal((await instB.host.read(runId))?.status, "active", "no verdict was written");

    const hash = await publishTree(instB, dir, FIXTURE_ASSEMBLY);
    assert.equal(instB.host.status(runId)?.workflow, "echo", "the publish re-attached it");
    assert.equal(instB.host.status(runId)?.assembly, hash);
    assert.deepEqual(restoredAfter, [{ assembly: hash, reattached: [runId], lost: [], drifted: [], failed: [] }]);
  } finally {
    await instB.close();
    for (const d of [dir, dbDir]) await rm(d, { recursive: true, force: true });
  }
});

test("a publish that changed a workflow's shape refuses its parked runs at the next boot (ADR-0030)", async () => {
  // The real sequence: a run is parked, someone edits `workflows/<name>.ts`, `jr2 up` publishes,
  // and the restart restores the old snapshot into the new Machine. Step 1 of ADR-0069 resolves the
  // name in the CURRENT Assembly, so the name still resolves, and xstate does not validate a
  // restored `value`: it just starts with `value: undefined`. The fingerprint is what refuses it.
  const dir = await scratchInstance("drift");
  const dbDir = await mkdtemp(join(tmpdir(), "jr2-drift-"));
  const dbPath = join(dbDir, "state.db");

  try {
    const storeA = new SqliteSnapshotStore(dbPath);
    const instA = await startInstance({ dir, store: storeA, signingKey: KEY });
    const first = await publishTree(instA, dir, { "workflows/task.ts": machineSrc("task", "coding") });
    const { runId } = await instA.host.start("task");
    await waitFor(async () => (await storeA.load(runId)) !== undefined);
    // The edit: same workflow NAME, a state that is no longer there. The live run keeps its def.
    const second = await publishTree(instA, dir, { "workflows/task.ts": machineSrc("task", "implementing") });
    assert.notEqual(second, first);
    assert.equal(instA.host.status(runId)?.value, "coding");
    assert.equal(instA.host.status(runId)?.assembly, first, "a publish mid-run does not restamp it");
    await instA.close();

    const storeB = new SqliteSnapshotStore(dbPath);
    const instB = await startInstance({ dir, store: storeB, reconcile: () => true, signingKey: KEY });
    try {
      assert.equal(instB.assembly?.hash, second, "the restart boots from `current`");
      assert.deepEqual(instB.restored.drifted, [runId], "the boot refuses it, and says which run");
      assert.deepEqual(instB.restored.reattached, []);
      assert.equal(instB.host.status(runId), undefined, "and it is NOT live");

      // Refused, not erased: the run still reads, and says why. This is the difference from
      // `markLost`, whose nulled snapshot would answer `jr2 status` with `no run "<id>"`.
      const read = await instB.host.read(runId);
      assert.equal(read?.status, "drifted");
      assert.match(read?.reason ?? "", /task.*changed shape/);
      assert.deepEqual(read?.value, "coding", "still parked exactly where it was");
    } finally {
      await instB.close();
    }
  } finally {
    for (const d of [dir, dbDir]) await rm(d, { recursive: true, force: true });
  }
});

test("a run started after a publish runs the new Machine and holds the new Assembly; the live run holds the old one (ADR-0009, ADR-0069)", async () => {
  // ADR-0009: an in-flight run keeps the definition it started on; only the next `start` sees the
  // new code. Step 1 of ADR-0069 lists, under `held`, the current Assembly and the runs that hold
  // it: the earlier run holds the one it started under, which is not listed until step 2 holds it.
  const dir = await scratchInstance("next-start");
  const inst = await startInstance({ dir, store: new SqliteSnapshotStore(":memory:"), signingKey: KEY });
  try {
    const first = await publishTree(inst, dir, { "workflows/task.ts": machineSrc("task", "coding") });
    const early = await inst.host.start("task");
    const second = await publishTree(inst, dir, { "workflows/task.ts": machineSrc("task", "implementing") });
    const late = await inst.host.start("task");

    assert.equal(inst.host.status(late.runId)?.value, "implementing", "the next start runs the new Machine");
    assert.equal(inst.host.status(late.runId)?.assembly, second);
    assert.equal(inst.host.status(early.runId)?.value, "coding", "the live run keeps the Machine it started on");
    assert.equal(inst.host.status(early.runId)?.assembly, first);

    const holds = inst.host.assemblyHolds();
    assert.deepEqual(holds.get(first), [early.runId]);
    assert.deepEqual(holds.get(second), [late.runId]);
    const view = (await (await fetch(`${inst.url}/assembly`)).json()) as {
      current: { hash: string };
      held: Array<{ hash: string; runs: string[] }>;
    };
    assert.equal(view.current.hash, second);
    assert.deepEqual(view.held, [{ hash: second, kitVersion: KIT_VERSION, runs: [late.runId] }]);
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
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
