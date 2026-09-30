// A Workspace that waits for capacity (ADR-0064), as the CLI reports it: `jr2 status <runId>` carries
// the RunStatus's `waiting`, `jr2 runs` marks the run `placing`, and `jr2 run` streams the feed's
// `placing`/`placed` lines as activity. Socket-free against a real RunHost; the Sandbox port is a
// fake that holds `place()` until the test schedules it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMachine, setup } from "xstate";
import {
  RunHost,
  SqliteSnapshotStore,
  createApp,
  workspace,
  type Continuity,
  type PlaceRequest,
  type PlacingWait,
  type SandboxPort,
} from "@jr2/orchestrator";
import { main } from "../src/cli.ts";
import { markPlacing } from "../src/commands/runs.ts";
import type { RunStatus } from "../src/client.ts";
import type { Io } from "../src/output.ts";

/** Holds every `place()` until {@link schedule}; {@link waitFor} plays the operator's reason. */
class HeldSandbox implements SandboxPort {
  private held = new Set<{ onWait: (wait: PlacingWait) => void; resolve: () => void }>();
  get waiting(): number {
    return this.held.size;
  }
  waitFor(wait: PlacingWait): void {
    for (const h of this.held) h.onWait(wait);
  }
  schedule(): void {
    for (const h of this.held) h.resolve();
    this.held.clear();
  }
  async place(_req: PlaceRequest, opts: { onWait: (wait: PlacingWait) => void; signal?: AbortSignal }) {
    await new Promise<void>((resolve, reject) => {
      const entry = { onWait: opts.onWait, resolve };
      this.held.add(entry);
      opts.signal?.addEventListener("abort", () => {
        this.held.delete(entry);
        reject(opts.signal!.reason);
      });
    });
  }
  async provision(): Promise<{ endpoint: string }> {
    return { endpoint: "http://sandbox.test" };
  }
  async attach(req: { repos: Array<{ slot: string }> }): Promise<{ repos: Record<string, string> }> {
    return { repos: Object.fromEntries(req.repos.map((r) => [r.slot, `/work/${r.slot}`])) };
  }
  async renew(): Promise<void> {}
  continuity(_name: string, listener: (seen: Continuity) => void): () => void {
    queueMicrotask(() => listener({ present: true }));
    return () => {};
  }
  harnessRestarts(): () => void {
    return () => {};
  }
  async memoryFault(): Promise<undefined> {
    return undefined;
  }
  async destroy(): Promise<void> {}
  leaseIntervalMs = 1_000;
}

/** `coord` invokes one Workspace as `F-1`; its body ends at once, so a scheduled run completes. */
function coordMachine() {
  const body = createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });
  const ws = workspace(body, { repos: { app: "https://example.test/app.git" }, spec: () => ({ branch: "b" }) });
  return setup({ actors: { ws } }).createMachine({
    id: "coord",
    initial: "going",
    states: { going: { invoke: { id: "F-1", src: "ws", onDone: "done" } }, done: { type: "final" } },
  });
}

const loop = createMachine({ id: "loop", initial: "working", states: { working: {} } });

async function mkPlacing() {
  const store = new SqliteSnapshotStore(":memory:");
  await store.init();
  const sandbox = new HeldSandbox();
  const host = new RunHost({ store, sandbox });
  host.register({ name: "coord", machine: coordMachine(), provide: () => ({}) });
  host.register({ name: "loop", machine: loop, provide: () => ({}) });
  const app = createApp(host);
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: { JR2_URL: "http://test" },
    cwd: "/",
    fetch: (url, init) => Promise.resolve(app.request(url, init)),
  };
  return { host, sandbox, io, out: () => out.join(""), err: () => err.join("") };
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const NODE: PlacingWait = { on: "node", message: "0/3 nodes are available: 3 Insufficient memory." };

test("status <runId> carries `waiting`: which Workspace, on what, in the scheduler's words", async () => {
  const { host, sandbox, io, out } = await mkPlacing();
  const { runId } = await host.start("coord");
  await until(() => sandbox.waiting === 1);
  sandbox.waitFor(NODE);
  await until(() => host.status(runId)!.waiting.length === 1);

  assert.equal(await main(["status", runId], io), 0);
  const status = JSON.parse(out()) as RunStatus;
  assert.equal(status.waiting?.length, 1);
  const [wait] = status.waiting!;
  assert.deepEqual({ child: wait!.child, on: wait!.on, message: wait!.message }, { child: "F-1", ...NODE });
  assert.ok(!Number.isNaN(Date.parse(wait!.since)));
  await host.stop(runId);
});

test("runs marks a run with a Workspace in `placing`, and only that run", async () => {
  const { host, sandbox, io, out } = await mkPlacing();
  const { runId: waits } = await host.start("coord");
  const { runId: idle } = await host.start("loop");
  // Marked before the scheduler has said a word: `placing` is the state, `waiting` the reason.
  await until(() => sandbox.waiting === 1);

  assert.equal(await main(["runs"], io), 0);
  const list = JSON.parse(out()) as Array<RunStatus & { placing?: string[] }>;
  assert.deepEqual(list.find((r) => r.runId === waits)?.placing, ["F-1"]);
  assert.equal("placing" in list.find((r) => r.runId === idle)!, false);
  await host.stop(waits);
  await host.stop(idle);
});

test("markPlacing names a run whose root IS the Workspace with the empty path", () => {
  const run = { runId: "r", workflow: "w", instanceId: "i", status: "active", value: "placing", context: {} };
  assert.deepEqual(markPlacing({ ...run, children: [] }).placing, [""]);
  const nested = {
    ...run,
    value: "fanning",
    children: [
      { id: "F-1", src: "ws", status: "active", value: "running", children: [] },
      {
        id: "G",
        src: "g",
        status: "active",
        value: "x",
        children: [{ id: "F-2", src: "ws", status: "active", value: "placing", children: [] }],
      },
    ],
  };
  assert.deepEqual(markPlacing(nested).placing, ["G/F-2"]);
  assert.equal(markPlacing({ ...run, value: "working" }).placing, undefined);
});

test("run streams the wait as activity: `placing` with the reason, then `placed`", async () => {
  const { sandbox, io, out, err } = await mkPlacing();
  const done = main(["run", "coord"], io);
  // The replayed status says the feed is attached; a wait said before then is the status's alone.
  await until(() => sandbox.waiting === 1 && err().includes("→ active"));
  sandbox.waitFor(NODE);
  await until(() => err().includes("placing F-1"));
  sandbox.schedule();

  assert.equal(await done, 0);
  assert.match(err(), /placing F-1: waits for a node — 0\/3 nodes are available: 3 Insufficient memory\./);
  assert.match(err(), /placed F-1 after \d+s/);
  assert.equal((JSON.parse(out().trim()) as RunStatus).status, "done", "stdout is still the terminal status alone");
});
