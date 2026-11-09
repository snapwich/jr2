// A push names a Worktree; its branch is the cut's row. The real `drive` for a
// cut and a push, a fake Harness and a fake Effector. What the Effector is asked is what would reach
// a remote.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { assign, type AnyStateMachine } from "xstate";
import { commandWith } from "../src/effect.ts";
import { httpFileWith, pushWith } from "../src/sandbox-effect.ts";
import { secret, file } from "../src/http-effect.ts";
import { RunHost, type WorkflowDef } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { dropSavedTails, lastPushOf, pushPairsOf, type EffectRow } from "../src/effect.ts";
import { worktreeWith } from "../src/worktree.ts";
import { FakeHarnessExec, fakeWorkspace, handles } from "./_effects.ts";
import { EFFECTOR_KEY, FakeEffector } from "./_effector.ts";
import { createEffectorClient } from "../src/effector-wire.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

const SHA = "b".repeat(40);
const ambient = {
  ...handles({ app: "/work/app", docs: "/work/docs" }),
  bindings: { app: "https://example.test/app.git", docs: "https://example.test/docs.git" },
};
const exited = (a: unknown) => ({ outcome: "exited" as const, code: 0, tail: JSON.stringify(a) });
const ready = (path: string, branch: string | null, slot = "app") => ({
  outcome: "ready",
  slot,
  path,
  branch,
  head: "a".repeat(40),
  found: "none",
});

type Rig = ReturnType<typeof rig>;
const hosts: RunHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) for (const run of host.list()) await host.stop(run.runId);
});
const target = { effector: () => ({ placement: "sandbox" as const, service: "ws-1:8082", key: EFFECTOR_KEY }) };
const port = (fake: FakeEffector) => () => createEffectorClient({ key: EFFECTOR_KEY, transport: fake.transport });

/** Cut `cutInput`, then run `effect` with `input`. */
function rig(cutInput: unknown, effect: unknown, input: unknown, cutOptions: Parameters<typeof worktreeWith>[1] = {}) {
  const harness = new FakeHarnessExec();
  const effector = new FakeEffector();
  const machine = jr2Setup({
    types: {} as { context: { out?: unknown } },
    actors: {
      ws: fakeWorkspace(ambient),
      cut: worktreeWith(harness.factory, cutOptions),
      act: (effect as (e: FakeEffector) => never)(effector),
    },
  }).createMachine({
    id: "wf",
    context: {},
    invoke: { src: "ws" },
    initial: "cutting",
    states: {
      cutting: { invoke: { src: "cut", input: cutInput as never, onDone: "acting" } },
      acting: {
        invoke: {
          src: "act",
          input: (() => input) as never,
          onDone: { target: "done", actions: assign({ out: ({ event }) => event.output }) },
          onError: {
            target: "done",
            actions: ({ event }) => console.log("DEFECT", event.error),
          },
        },
      },
      done: {},
    },
  }) as unknown as AnyStateMachine;
  const def: WorkflowDef = { name: "fx", machine, provide: () => ({}) };
  return { harness, effector, def };
}

async function run(r: Rig, answer: unknown, store?: SnapshotStore) {
  const host = new RunHost({ store: store ?? (await mkStore()), ...target });
  hosts.push(host);
  host.register(r.def);
  const { runId } = await host.start("fx");
  await waitFor(() => r.harness.starts.length === 1);
  r.harness.settle(exited(answer));
  await waitFor(() => host.status(runId)?.value === "done" || r.effector.starts.length > 0).catch((e) => {
    console.log(JSON.stringify(host.status(runId)));
    throw e;
  });
  return { host, runId };
}

const pushed = () => ({ outcome: "pushed", published: SHA, source: SHA, newCommits: 1 });
const pushEffect =
  (options = {}) =>
  (e: FakeEffector) =>
    pushWith(port(e), options);

test("the push's branch is the cut's, not a word of any input; a `git switch` in the pod changes nothing", async () => {
  const r = rig({ path: "/work/app/run", branch: "fix/one" }, pushEffect({ slot: "app" }), {
    worktree: "/work/app/run",
  });
  await run(r, ready("/work/app/run", "fix/one"));
  await waitFor(() => r.effector.starts.length === 1);
  const start = r.effector.starts[0]!.req as { push: { branch: string; repo: { worktree: string; gitDir: string } } };
  assert.equal(start.push.branch, "fix/one");
  assert.equal(start.push.repo.worktree, "app/run");
  assert.equal(start.push.repo.gitDir, "app/default/.git");
});

test('the first push of a cut with `expect: "new"` asks the Effector for a branch that the remote does not hold; another cut\'s push does not', async () => {
  const fresh = rig(
    { path: "/work/app/run", branch: "fix/one" },
    pushEffect({ slot: "app" }),
    { worktree: "/work/app/run" },
    {
      expect: "new",
    },
  );
  await run(fresh, ready("/work/app/run", "fix/one"));
  await waitFor(() => fresh.effector.starts.length === 1);
  assert.equal((fresh.effector.starts[0]!.req as { push: { fresh?: boolean } }).push.fresh, true);
  const plain = rig({ path: "/work/app/run", branch: "fix/one" }, pushEffect({ slot: "app" }), {
    worktree: "/work/app/run",
  });
  await run(plain, ready("/work/app/run", "fix/one"));
  await waitFor(() => plain.effector.starts.length === 1);
  assert.equal((plain.effector.starts[0]!.req as { push: { fresh?: boolean } }).push.fresh, undefined);
});

const rejected = async (cutInput: unknown, answer: unknown, input: unknown, options = { slot: "app" }) => {
  const r = rig(cutInput, pushEffect(options), input);
  const { host, runId } = await run(r, answer);
  await waitFor(() => host.status(runId)?.value === "done");
  assert.equal(r.effector.starts.length, 0, "nothing went to the Effector");
  const out = (host.status(runId)?.context as { out: { outcome: string; stage: string; reason: string } }).out;
  assert.equal(out.outcome, "rejected");
  assert.equal(out.stage, "start");
  return out.reason;
};

test("no row: a Worktree no cut made, default/ included, settles `rejected` at start", async () => {
  const cut = { path: "/work/app/run", branch: "fix/one" };
  const answer = ready("/work/app/run", "fix/one");
  assert.match(await rejected(cut, answer, { worktree: "/work/app/default" }), /no cut made/);
  assert.match(await rejected(cut, answer, { worktree: "/work/app/other" }), /no cut made/);
});

test("a row of another slot: `rejected`", async () => {
  const cut = { path: "/work/docs/run", branch: "fix/one" };
  const reason = await rejected(cut, ready("/work/docs/run", "fix/one", "docs"), { worktree: "/work/docs/run" });
  assert.match(reason, /of Repo Slot "docs", not of "app"/);
});

test("traversal and a bad shape: `rejected`", async () => {
  const cut = { path: "/work/app/run", branch: "fix/one" };
  const answer = ready("/work/app/run", "fix/one");
  assert.match(await rejected(cut, answer, { worktree: "/work/app/../docs/x" }), /not a Worktree path/);
  assert.match(await rejected(cut, answer, { worktree: "/work/app/run/" }), /not a Worktree path/);
  assert.match(await rejected(cut, answer, { worktree: undefined }), /not a Worktree path/);
});

test("a detached Worktree publishes nothing: `rejected`, and the name of why", async () => {
  const cut = { path: "/work/app/review", detach: "a".repeat(40) };
  const reason = await rejected(cut, ready("/work/app/review", null), { worktree: "/work/app/review" });
  assert.match(reason, /detached/);
});

test("a credentialed command has the same row check: exited 127, nothing sent", async () => {
  const effect = (e: FakeEffector) =>
    commandWith(new FakeHarnessExec().factory, ["deploy"], { env: { TOKEN: secret("t") } }, port(e));
  const r = rig({ path: "/work/app/run", branch: "b" }, effect, { worktree: "/work/app/default" });
  const { host, runId } = await run(r, ready("/work/app/run", "b"));
  await waitFor(() => host.status(runId)?.value === "done");
  assert.equal(r.effector.starts.length, 0);
  const out = (host.status(runId)?.context as { out: { outcome: string; code: number; tail: string } }).out;
  assert.equal(out.code, 127);
  assert.match(out.tail, /no cut made/);
});

test("an http file body has the same row check: `refused`, nothing sent", async () => {
  const effect = (e: FakeEffector) =>
    httpFileWith(port(e), { method: "PUT", url: "https://x.test/up", body: file("report.md") });
  const r = rig({ path: "/work/app/run", branch: "b" }, effect, { worktree: "/work/docs/x" });
  const { host, runId } = await run(r, ready("/work/app/run", "b"));
  await waitFor(() => host.status(runId)?.value === "done");
  assert.equal(r.effector.starts.length, 0);
  const out = (host.status(runId)?.context as { out: { outcome: string; reason: string } }).out;
  assert.equal(out.outcome, "refused");
  assert.match(out.reason, /no cut made/);
});

test("a settled row keeps slot, path and branch after its tail is dropped", () => {
  const rows: Record<string, EffectRow> = {
    c: {
      state: "settled",
      kind: "command",
      slot: "cut",
      sandbox: "s",
      repo: "app",
      cut: { path: "/work/app/run", branch: "fix" },
      output: { outcome: "ready", tail: "long" },
      at: "1",
    },
  };
  dropSavedTails(rows, {});
  const row = rows.c as Extract<EffectRow, { state: "settled" }>;
  assert.deepEqual(row.cut, { path: "/work/app/run", branch: "fix" });
  assert.equal(row.repo, "app");
  assert.equal((row.output as { tail?: string }).tail, undefined);
});

test("the ledger key is (slot, branch): two branches of one slot have two pair lists", () => {
  const row = (branch: string, published: string, at: string): EffectRow => ({
    state: "settled",
    kind: "push",
    slot: "p",
    sandbox: "s",
    repo: "app",
    branch,
    output: { outcome: "pushed", published, source: "x".repeat(40) },
    at,
  });
  const rows = { a: row("one", "1".repeat(40), "1"), b: row("two", "2".repeat(40), "2") };
  assert.equal(lastPushOf(rows, "s", "app", "one")?.rowId, "a");
  assert.equal(lastPushOf(rows, "s", "app", "two")?.rowId, "b");
  assert.deepEqual(
    pushPairsOf(rows, "s", "app", "one").map((p) => p.published),
    ["1".repeat(40)],
  );
});

test("a restored pinned push: it goes again with only its commit, to the row's branch", async () => {
  const store = await mkStore();
  const options = { slot: "app", pin: true };
  const input = { worktree: "/work/app/run", sha: SHA };
  const r = rig({ path: "/work/app/run", branch: "fix/one" }, pushEffect(options), input);
  const { host, runId } = await run(r, ready("/work/app/run", "fix/one"), store);
  await waitFor(() => r.effector.starts.length === 1);
  // The restart reads the saved row, so the row is saved first.
  for (let tries = 0; ; tries++) {
    const saved = (await store.load(runId))?.snapshot as { effects?: object } | undefined;
    if (saved?.effects !== undefined) break;
    assert.ok(tries < 100, "the push's row was saved");
    await new Promise((r) => setTimeout(r, 5));
  }
  await host.stop(runId);
  r.effector.restart("effector-a");

  const again = new RunHost({ store, ...target });
  hosts.push(again);
  again.register(r.def);
  await again.restore();
  await waitFor(() => r.effector.starts.length === 2);
  const start = r.effector.starts[1]!.req as { push: { branch: string; pin: string } };
  assert.equal(start.push.branch, "fix/one");
  assert.equal(start.push.pin, SHA);
  r.effector.settle(pushed());
  await waitFor(() => again.status(runId)?.value === "done");
});
