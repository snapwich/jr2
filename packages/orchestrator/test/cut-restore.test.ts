// An Orchestrator restart and a Harness restart in the middle of a cut, through the real RunHost and the real `drive`,
// on a fake Harness. And the path as plain data in the snapshot.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assign } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { arg, commandWith, type CommandOutput, type ExecPortFactory } from "../src/effect.ts";
import { createApp } from "../src/http.ts";
import { observe, RunHost, type RunStatus, type WorkflowDef } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { isReady, readyOf, worktreeWith, type WorktreeOutput, type WorktreeReady } from "../src/worktree.ts";
import { fakeWorkspace, FakeHarnessExec, handles } from "./_effects.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

const go = defineEvent({ name: "go", input: z.object({}) });
type Ctx = { wt?: WorktreeReady; out?: WorktreeOutput };

const answer = (found: string) => ({
  outcome: "ready",
  slot: "app",
  path: "/work/app/run",
  branch: "fix/one",
  head: "a".repeat(40),
  found,
});
const exited = (a: unknown) => ({ outcome: "exited" as const, code: 0, tail: JSON.stringify(a) });

function defOf(factory: ExecPortFactory): WorkflowDef {
  const machine = jr2Setup({
    types: {} as { context: Ctx },
    events: [go],
    actors: {
      ws: fakeWorkspace({ ...handles({ app: "/work/app" }), bases: { app: "main" } }),
      cut: worktreeWith(factory),
      run: commandWith(factory, ["make", arg("target")]),
    },
  }).createMachine({
    id: "wf",
    context: {},
    invoke: { src: "ws" },
    initial: "cutting",
    states: {
      cutting: {
        invoke: {
          src: "cut",
          input: { path: "/work/app/run", branch: "fix/one" },
          onDone: [
            {
              guard: ({ event }) => isReady(event.output),
              target: "parked",
              actions: assign({ wt: ({ event }) => readyOf(event.output) }),
            },
            { target: "bad", actions: assign({ out: ({ event }) => event.output }) },
          ],
        },
      },
      parked: { invoke: { src: "gate", id: "hold" }, on: { go: "building" } },
      building: {
        invoke: {
          src: "run",
          input: ({ context }) => ({ target: "all", worktree: context.wt!.path }),
          onDone: "done",
        },
      },
      done: {},
      bad: {},
    },
  });
  return { name: "fx", machine, provide: () => ({}) };
}

const restored = async (store: Awaited<ReturnType<typeof mkStore>>, fake: FakeHarnessExec) => {
  const host = new RunHost({ store });
  host.register(defOf(fake.factory));
  await host.restore();
  return host;
};
const cutRequest = (req: { argv: string[] }) => JSON.parse(req.argv[req.argv.length - 1]!) as Record<string, unknown>;

test("the cut's argument: the input, the Effect's id, and the base the Orchestrator holds", async () => {
  const fake = new FakeHarnessExec();
  const host = new RunHost({ store: await mkStore() });
  host.register(defOf(fake.factory));
  await host.start("fx");
  await waitFor(() => fake.starts.length === 1);
  const start = fake.starts[0]!;
  assert.deepEqual(cutRequest(start.req), {
    id: start.id,
    path: "/work/app/run",
    branch: "fix/one",
    base: "main",
  });
  assert.equal(start.req.argv[0], "/opt/jr2/bin/node");
  assert.equal(start.req.root, undefined);
});

test("Orchestrator restart mid-cut, the Harness runs it: re-attach, one cut, the path reaches context", async () => {
  const fake = new FakeHarnessExec();
  const store = await mkStore();
  const first = new RunHost({ store });
  first.register(defOf(fake.factory));
  const { runId } = await first.start("fx");
  await waitFor(() => fake.starts.length === 1);
  await first.stop(runId);

  const host = await restored(store, fake);
  await waitFor(() => fake.reads.filter((r) => r.offset === undefined).length === 1);
  fake.settle(exited(answer("none")));
  await waitFor(() => host.status(runId)?.value === "parked");
  assert.equal(fake.starts.length, 1);
  assert.equal((host.status(runId)?.context as Ctx).wt?.path, "/work/app/run");
});

test("Orchestrator restart mid-cut, the Harness lost it: the cut goes again, under the same id", async () => {
  const fake = new FakeHarnessExec();
  const store = await mkStore();
  const first = new RunHost({ store });
  first.register(defOf(fake.factory));
  const { runId } = await first.start("fx");
  await waitFor(() => fake.starts.length === 1);
  await first.stop(runId);
  fake.forgetAll();

  const host = await restored(store, fake);
  await waitFor(() => fake.starts.length === 2);
  assert.equal(fake.starts[0]!.id, fake.starts[1]!.id, "one Effect, one id");
  assert.deepEqual(fake.starts[0]!.req.argv, fake.starts[1]!.req.argv, "the same cut: the input is in the snapshot");
  // The cut sees its own id, and answers the first `found` (cut.test.ts): a restart is no resumed work.
  fake.settle(exited(answer("none")));
  await waitFor(() => host.status(runId)?.value === "parked");
  assert.equal((host.status(runId)?.context as Ctx).wt?.found, "none");
});

test("Harness restart while a cut runs: it goes again, and it settles; the live Orchestrator never says unknown", async () => {
  const fake = new FakeHarnessExec();
  const host = new RunHost({ store: await mkStore() });
  host.register(defOf(fake.factory));
  const { runId } = await host.start("fx");
  await waitFor(() => fake.starts.length === 1);
  fake.forgetAll();
  await waitFor(() => fake.starts.length === 2);
  assert.equal(fake.starts[0]!.id, fake.starts[1]!.id);
  fake.settle(exited(answer("none")));
  await waitFor(() => host.status(runId)?.value === "parked");
});

test("a Harness that keeps restarting: a bounded number of sends, then `unknown`, and the Machine routes", async () => {
  const fake = new FakeHarnessExec();
  const host = new RunHost({ store: await mkStore() });
  host.register(defOf(fake.factory));
  const { runId } = await host.start("fx");
  for (let n = 1; n <= 4; n++) {
    await waitFor(() => fake.starts.length === n);
    fake.forgetAll();
  }
  await waitFor(() => host.status(runId)?.value === "bad");
  assert.equal(fake.starts.length, 4);
  assert.equal((host.status(runId)?.context as Ctx).out?.outcome, "unknown");
});

test("an author's command is at most once: a Harness restart settles it `unknown`, not run again", async () => {
  const fake = new FakeHarnessExec();
  const host = new RunHost({ store: await mkStore() });
  host.register(defOf(fake.factory));
  const { runId } = await host.start("fx");
  await waitFor(() => fake.starts.length === 1);
  fake.settle(exited(answer("none")));
  await waitFor(() => host.status(runId)?.value === "parked");
  host.sendToGate(runId, "hold", { type: "go" });
  await waitFor(() => fake.starts.length === 2);
  fake.forgetAll();
  await waitFor(() => host.status(runId)?.value === "done");
  assert.equal(fake.starts.length, 2);
});

test("after the cut, a restart: the path is plain data in the snapshot, and the next Effect reads it", async () => {
  const fake = new FakeHarnessExec();
  const store = await mkStore();
  const first = new RunHost({ store });
  first.register(defOf(fake.factory));
  const { runId } = await first.start("fx");
  await waitFor(() => fake.starts.length === 1);
  fake.settle(exited(answer("none")));
  await waitFor(() => first.status(runId)?.value === "parked");
  await first.stop(runId);

  const host = await restored(store, fake);
  await waitFor(() => host.gates(runId).length === 1);
  host.sendToGate(runId, "hold", { type: "go" });
  await waitFor(() => fake.starts.length === 2);
  assert.equal(fake.starts[1]!.req.cwd, "/work/app/run");
  assert.equal(fake.starts[1]!.req.root, true);
  assert.equal(fake.starts.filter((s) => s.req.argv[0] === "/opt/jr2/bin/node").length, 1, "no second cut");
  fake.settle({ outcome: "exited", code: 0, tail: "" });
  await waitFor(() => host.status(runId)?.value === "done");
});

test("a refused cut is output: the Machine routes on it, and nothing goes to onError", async () => {
  const fake = new FakeHarnessExec();
  const host = new RunHost({ store: await mkStore() });
  host.register(defOf(fake.factory));
  const { runId } = await host.start("fx");
  await waitFor(() => fake.starts.length === 1);
  fake.settle(exited({ outcome: "refused", reason: '"bad..name" is not a branch name' }));
  await waitFor(() => host.status(runId)?.value === "bad");
  assert.equal((host.status(runId)?.context as Ctx).out?.outcome, "refused");
});

test("a cut that ended with no answer is `unknown`, never a guess", async () => {
  const fake = new FakeHarnessExec();
  const host = new RunHost({ store: await mkStore() });
  host.register(defOf(fake.factory));
  const { runId } = await host.start("fx");
  await waitFor(() => fake.starts.length === 1);
  fake.settle({ outcome: "timeout", tail: "" });
  await waitFor(() => host.status(runId)?.value === "bad");
  assert.equal((host.status(runId)?.context as Ctx).out?.outcome, "unknown");
});

function commandMachine(fake: FakeHarnessExec, input: unknown, repos: Record<string, string> = { app: "/work/app" }) {
  const machine = jr2Setup({
    types: {} as { context: { out?: CommandOutput } },
    actors: { ws: fakeWorkspace(handles(repos)), run: commandWith(fake.factory, ["make"]) },
  }).createMachine({
    id: "wf",
    context: {},
    invoke: { src: "ws" },
    initial: "building",
    states: {
      building: {
        invoke: {
          src: "run",
          input: input as never,
          onDone: { target: "done", actions: assign({ out: ({ event }) => event.output }) },
          onError: "defect",
        },
      },
      done: {},
      defect: {},
    },
  });
  return { name: "fx", machine, provide: () => ({}) } satisfies WorkflowDef;
}

test("a command's bad Worktree is `exited` 127 with the reason in its tail, and nothing runs (C's form)", async () => {
  for (const [worktree, why] of [
    ["/work/other/x", /Repo Slot "other"/],
    ["/work/app/../docs", /not a Worktree path/],
    ["/work/app/a/b", /not a Worktree path/],
    ["/work/app/-x", /neither/],
  ] as const) {
    const fake = new FakeHarnessExec();
    const host = new RunHost({ store: await mkStore() });
    host.register(commandMachine(fake, () => ({ worktree })));
    const { runId } = await host.start("fx");
    await waitFor(() => host.status(runId)?.value === "done");
    assert.equal(fake.starts.length, 0);
    const out = (host.status(runId)?.context as { out: { outcome: string; code: number; tail: string } }).out;
    assert.equal(out.outcome, "exited");
    assert.equal(out.code, 127);
    assert.match(out.tail, why);
  }
});

test("a command that names no Worktree in a Workspace with Repo Slots is a defect: onError", async () => {
  const fake = new FakeHarnessExec();
  const host = new RunHost({ store: await mkStore() });
  host.register(commandMachine(fake, () => ({})));
  const { runId } = await host.start("fx");
  await waitFor(() => host.status(runId)?.value === "defect");
  assert.equal(fake.starts.length, 0);
});

test("a command with no Repo Slot runs in /work, and names no Worktree", async () => {
  const fake = new FakeHarnessExec();
  const host = new RunHost({ store: await mkStore() });
  host.register(commandMachine(fake, undefined, {}));
  await host.start("fx");
  await waitFor(() => fake.starts.length === 1);
  assert.equal(fake.starts[0]!.req.cwd, "/work");
});

// `GET /runs/:runId` carries the cuts, read off the ledger: the row is what a push trusts, and an
// Agent can change neither it nor this view.
test("a run's status lists each Worktree its cuts made: slot, path, branch, one entry for a re-cut", async () => {
  const fake = new FakeHarnessExec();
  const machine = jr2Setup({
    events: [],
    actors: {
      ws: fakeWorkspace({ ...handles({ app: "/work/app" }), bases: { app: "main" } }),
      cut: worktreeWith(fake.factory),
    },
  }).createMachine({
    id: "wf",
    invoke: { src: "ws" },
    initial: "first",
    states: {
      first: { invoke: { src: "cut", input: { path: "/work/app/run", branch: "fix/one" }, onDone: "again" } },
      again: { invoke: { src: "cut", input: { path: "/work/app/run", branch: "fix/one" }, onDone: "detached" } },
      detached: { invoke: { src: "cut", input: { path: "/work/app/review", detach: "abc1234" }, onDone: "refused" } },
      refused: { invoke: { src: "cut", input: { path: "/work/app/no", branch: "no" }, onDone: "parked" } },
      parked: {},
    },
  });
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "fx", machine, provide: () => ({}) });
  const app = createApp(host);
  const { runId } = await host.start("fx");
  const read = async () => (await (await app.request(`/runs/${runId}`)).json()) as RunStatus;

  await waitFor(() => fake.starts.length === 1);
  assert.equal("worktrees" in (await read()), false, "a run that has cut nothing has no field");
  fake.settle(exited(answer("none")));
  await waitFor(() => fake.starts.length === 2);
  fake.settle(exited(answer("held")));
  await waitFor(() => fake.starts.length === 3);
  fake.settle(exited({ ...answer("commit"), path: "/work/app/review", branch: null }));
  await waitFor(() => fake.starts.length === 4);
  fake.settle(exited({ outcome: "refused", reason: "no" }));
  await waitFor(() => host.status(runId)?.value === "parked");

  const worktrees = [
    { slot: "app", path: "/work/app/run", branch: "fix/one" },
    { slot: "app", path: "/work/app/review", branch: null },
  ];
  assert.deepEqual((await read()).worktrees, worktrees, "a refused cut made nothing, so it has no entry");
  assert.equal("worktrees" in observe(host.status(runId)!), false, "a branch name stays behind the token");
  await host.stop(runId);
  assert.deepEqual((await read()).worktrees, worktrees, "the store's blob gives the same answer");
});
