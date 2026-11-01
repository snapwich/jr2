// The rules around `worktree()` that hold with no Harness: the branch rule, which has one copy on
// each side of the cut, the refusal under a Workspace with no Repo Slot, and the clone of a push.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assign } from "xstate";
import { workspacePodsOf } from "../src/parts.ts";
import { RunHost } from "../src/run-host.ts";
import { repoRefOf } from "../src/sandbox-effect.ts";
import { refuseEffectSecrets } from "../src/secret-placement.ts";
import { jr2Setup } from "../src/setup.ts";
import { workspace, type Workspaced } from "../src/workspace.ts";
import { BRANCH_NAME, branchName, worktreeWith } from "../src/worktree.ts";
import { fakeWorkspace, FakeHarnessExec, handles } from "./_effects.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

test("the branch rule: the Orchestrator's copy is the program's, because the program runs alone in the pod", async () => {
  // By a held string: the file is outside this package's root, and only the test reads across.
  const program = "../../harness/src/cut.ts";
  const cut = (await import(program)) as { BRANCH_NAME: RegExp };
  assert.equal(BRANCH_NAME.source, cut.BRANCH_NAME.source);
  assert.equal(BRANCH_NAME.flags, cut.BRANCH_NAME.flags);
});

test("the branch rule: a name git and the push both take, and no other", () => {
  for (const good of ["main", "fix/one", "feature/auth", "v1.2", "a_b", "x-1"]) {
    assert.ok(branchName.safeParse(good).success, good);
  }
  const bad = [
    "-f",
    "/a",
    "a/",
    "a//b",
    "a..b",
    "a.lock",
    "a.lock/b",
    "HEAD",
    "refs/heads/x",
    "origin/x",
    ".a",
    "a/.b",
    "a/-b",
    "a.",
    "abcdef1",
    "a@b",
    "a#b",
    "a+b",
    "a b",
    "",
  ];
  for (const name of bad) assert.ok(!branchName.safeParse(name).success, name);
});

const noCutWorkspace = () => {
  const body = jr2Setup({
    types: {} as { input: Workspaced<{}, never> },
    actors: {
      cut: worktreeWith(() => {
        throw new Error("no port");
      }, {}),
    },
  }).createMachine({
    id: "nocut",
    on: { "workspace.lost": ".done" },
    initial: "cutting",
    states: {
      cutting: { invoke: { src: "cut", input: { path: "/work/app/x", branch: "b" } as never, onDone: "done" } },
      done: { type: "final" },
    },
  });
  return workspace(body, {});
};

test("`jr2 up` refuses a worktree() under a Workspace with no Repo Slot (ADR-0075)", () => {
  const [pod] = workspacePodsOf(noCutWorkspace());
  assert.ok(pod);
  assert.equal(pod.noSlot, true);
  assert.deepEqual(pod.cuts, ["cut"]);
  assert.deepEqual(pod.effects, [], "a cut runs in the Harness container, and holds no Effector");
  assert.throws(
    () => refuseEffectSecrets({}, { effects: [], workspaces: [{ workflow: "w", pod }] }),
    /workflow "w": worktree "cut" runs in .*, which has no Repo Slot: a cut makes a Worktree of a Repo Slot, and there is none/,
  );
});

test("the invoke refuses a cut under a Workspace with no Repo Slot, as a defect, and sends nothing (ADR-0075)", async () => {
  const exec = new FakeHarnessExec();
  const machine = jr2Setup({
    types: {} as { context: { error?: string } },
    actors: { cut: worktreeWith(exec.factory, {}), ws: fakeWorkspace(handles({})) },
  }).createMachine({
    id: "nocut",
    context: {},
    invoke: { src: "ws" },
    initial: "cutting",
    states: {
      cutting: {
        invoke: {
          src: "cut",
          input: { path: "/work/app/x", branch: "b" } as never,
          onDone: "wrong",
          onError: {
            target: "defect",
            actions: assign({ error: ({ event }) => (event.error as Error).message }),
          },
        },
      },
      wrong: {},
      defect: {},
    },
  });
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "nocut", machine, provide: () => ({}) });
  const { runId } = await host.start("nocut");
  await waitFor(() => host.status(runId)?.value !== "cutting");
  assert.equal(host.status(runId)?.value, "defect");
  assert.match(
    (host.status(runId)?.context as { error: string }).error,
    /worktree "cut" runs under a Workspace with no Repo Slot: a cut makes a Worktree of a Repo Slot/,
  );
  assert.equal(exec.starts.length, 0, "nothing reached the Harness");
  await host.stop(runId);
});

test("the clone of a push is the slot's, whatever the Worktree's folder says", () => {
  const ambient = {
    endpoint: "e",
    sandbox: "s",
    repos: { app: "/work/app", docs: "/work/docs" },
    bindings: { app: "https://github.com/acme/app.git", docs: "https://github.com/acme/docs.git" },
  };
  assert.equal(repoRefOf(ambient, "app", "/work/docs/x").gitDir, "app/default/.git");
  assert.equal(repoRefOf(ambient, "app", "/work/app/fix").worktree, "app/fix");
});
