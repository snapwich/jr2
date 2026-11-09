// A cut at a Handoff (ADR-0080): the ledger check, alone and through the real RunHost and `drive`
// on a fake Harness. Each fact of a Handoff that the run's ledger does not hold is a routable
// `refused`, and nothing reaches the child's Harness. An accepted cut sends what the ledger found,
// and keeps it on its intent row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assign } from "xstate";
import type { AmbientHandles } from "../src/ambient.ts";
import { inputShapeOf, oneOfHolds, type EffectRow } from "../src/effect.ts";
import { handoff, handoffShapeFault, handoffSourceOf, type Handoff, type HandoffCarrier } from "../src/handoff.ts";
import { RunHost } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { isReady, readyOf, worktreeWith, type WorktreeOutput, type WorktreeReady } from "../src/worktree.ts";
import { fakeWorkspace, FakeHarnessExec } from "./_effects.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

const URL_APP = "https://github.com/acme/app.git";
const H = "a".repeat(40);
const H2 = "b".repeat(40);

const ws = (sandbox: string, bindings: Record<string, string> = { app: URL_APP }): AmbientHandles => ({
  endpoint: `http://${sandbox}.invalid`,
  sandbox,
  repos: Object.fromEntries(Object.keys(bindings).map((s) => [s, `/work/${s}`])),
  bindings,
});
const parent = ws("ws-parent");
const child = ws("ws-child");

/** A settled `ready` cut row of a Workspace. */
const cutRow = (sandbox: string, path: string, branch: string | null, head: string, at = "2026-11-08T00:00:00Z") =>
  ({
    state: "settled",
    kind: "command",
    slot: "cut",
    sandbox,
    repo: path.split("/")[2]!,
    cut: { path, branch, head },
    output: { outcome: "ready", slot: path.split("/")[2], path, branch, head, found: "none" },
    at,
  }) as const;

const given = (over: Partial<Handoff> = {}): Handoff => ({
  slot: "app",
  path: "/work/app/coder",
  branch: "fix/one",
  head: H,
  ...over,
});
const check = (
  h: Handoff,
  rows: Record<string, ReturnType<typeof cutRow>>,
  opts: { chain?: AmbientHandles[]; branch?: string } = {},
) =>
  handoffSourceOf(h, {
    rows,
    chain: opts.chain ?? [child, parent],
    run: "run-1",
    path: "/work/app/final",
    ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
  });
const refusedOf = (r: ReturnType<typeof check>): string => {
  assert.ok("refused" in r, JSON.stringify(r));
  return r.refused;
};

// --- The check, alone ---------------------------------------------------------------------------

test("the ledger check finds a Handoff of an enclosing Workspace, and names the source and the branch", () => {
  const r = check(given(), { r1: cutRow("ws-parent", "/work/app/coder", "fix/one", H) });
  assert.deepEqual(r, {
    source: {
      run: "run-1",
      sandbox: "ws-parent",
      endpoint: "http://ws-parent.invalid",
      row: "r1",
      slot: "app",
      path: "/work/app/coder",
      head: H,
      branch: "fix/one",
    },
  });
  const named = check(given(), { r1: cutRow("ws-parent", "/work/app/coder", "fix/one", H) }, { branch: "review/one" });
  assert.equal("source" in named && named.source.branch, "review/one", "the cut's `branch` names the child's branch");
});

test("the ledger check takes the head of an earlier ready cut of the path, and an enclosing Workspace two levels up", () => {
  const rows = {
    r1: cutRow("ws-top", "/work/app/coder", "fix/one", H, "2026-11-08T00:00:00Z"),
    r2: cutRow("ws-top", "/work/app/coder", "fix/one", H2, "2026-11-08T00:01:00Z"),
  };
  const r = check(given(), rows, { chain: [child, parent, ws("ws-top")] });
  assert.ok("source" in r, JSON.stringify(r));
  assert.equal(r.source.row, "r1");
  assert.equal(r.source.sandbox, "ws-top");
});

test("the ledger check refuses a head that no ready cut of the run made at that path", () => {
  const rows = { r1: cutRow("ws-parent", "/work/app/coder", "fix/one", H) };
  assert.match(refusedOf(check(given({ head: H2 }), rows)), /no ready cut of this run made that commit at that path/);
  assert.match(refusedOf(check(given({ path: "/work/app/other" }), rows)), /no ready cut of this run/);
  // A run's ledger holds only its own cuts: a Handoff of another run, a dispatched one too, finds none.
  assert.match(refusedOf(check(given(), {})), /no ready cut of this run/);
});

test("the ledger check refuses a Handoff of the child's own cut and of a sibling Workspace", () => {
  assert.match(
    refusedOf(check(given(), { r1: cutRow("ws-child", "/work/app/coder", "fix/one", H) })),
    /this nested Workspace's own cut made it, and a Handoff comes from an enclosing Workspace/,
  );
  assert.match(
    refusedOf(
      check(given(), { r1: cutRow("ws-sibling", "/work/app/coder", "fix/one", H) }, { chain: [child, parent] }),
    ),
    /a Workspace that does not enclose this one made it/,
  );
});

test("the ledger check refuses another branch, another slot, and another Repo", () => {
  const rows = { r1: cutRow("ws-parent", "/work/app/coder", "fix/one", H) };
  // A Chart could forge `main`, and a signed push in the child would publish there.
  assert.match(refusedOf(check(given({ branch: "main" }), rows)), /made it on fix\/one, not on main/);
  assert.match(refusedOf(check(given({ branch: null }), rows)), /made it on fix\/one, not on a detached Worktree/);
  assert.match(refusedOf(check(given({ slot: "docs" }), rows)), /in Repo Slot "app", not "docs"/);
  const otherRepo = ws("ws-child", { app: "https://github.com/acme/other.git" });
  assert.match(refusedOf(check(given(), rows, { chain: [otherRepo, parent] })), /a Handoff stays in one Repo/);
  // One Repo in two spellings is one Repo (ADR-0051).
  const spelled = ws("ws-child", { app: "git@github.com:acme/app" });
  assert.ok("source" in check(given(), rows, { chain: [spelled, parent] }));
});

test("the ledger check refuses a detached Handoff with no `branch`, and takes one with it", () => {
  const rows = { r1: cutRow("ws-parent", "/work/app/review", null, H) };
  const h = given({ path: "/work/app/review", branch: null });
  assert.match(refusedOf(check(h, rows)), /the Handoff is detached, so the cut names the branch/);
  const r = check(h, rows, { branch: "review/one" });
  assert.ok("source" in r && r.source.branch === "review/one");
});

test("the Handoff schema: a WorktreeReady is a Handoff; a short head or a missing field is not", () => {
  const ready: WorktreeReady<"app"> = {
    outcome: "ready",
    slot: "app",
    path: "/work/app/coder",
    branch: "fix/one",
    head: H,
    found: "none",
  };
  const h: Handoff = ready;
  assert.deepEqual(handoff.parse(h), { slot: "app", path: "/work/app/coder", branch: "fix/one", head: H });
  assert.equal(handoffShapeFault(ready), undefined);
  assert.match(handoffShapeFault({ ...ready, head: "abc1234" })!, /`head`: a full commit id/);
  assert.match(handoffShapeFault({ slot: "app", path: "/work/app/x", head: H })!, /`branch`/);
  assert.match(handoffShapeFault("x")!, /a cut's `handoff` is a Handoff/);
});

test("the cut's shape: one of branch, detach or handoff, and handoff may come with branch", () => {
  const shape = inputShapeOf(worktreeWith(new FakeHarnessExec().factory).effect)!;
  assert.ok(oneOfHolds(shape, ["path", "branch"]));
  assert.ok(oneOfHolds(shape, ["path", "detach"]));
  assert.ok(oneOfHolds(shape, ["path", "handoff"]));
  assert.ok(oneOfHolds(shape, ["path", "handoff", "branch"]));
  assert.ok(!oneOfHolds(shape, ["path", "branch", "detach"]));
  assert.ok(!oneOfHolds(shape, ["path", "handoff", "detach"]));
  assert.ok(!oneOfHolds(shape, ["path"]));
  assert.deepEqual(shape.handoffs, ["handoff"]);
});

// --- Through the RunHost ------------------------------------------------------------------------

type ChildIn = { handoff: unknown; branch?: string; path?: string; extra?: Record<string, unknown> };
type RootCtx = {
  forged?: unknown;
  branch?: string;
  extra?: Record<string, unknown>;
  h?: WorktreeReady;
  out?: WorktreeOutput;
};

/** The child: a nested Workspace whose body cuts `/work/app/final` at the Handoff. Its output is the
 * cut's. */
function childMachine(exec: FakeHarnessExec, carrier?: HandoffCarrier) {
  return jr2Setup({
    types: {} as { input: ChildIn; context: ChildIn & { out?: WorktreeOutput } },
    actors: { ws: fakeWorkspace(child), cut: worktreeWith(exec.factory, {}, carrier) },
  }).createMachine({
    id: "child",
    context: ({ input }) => input,
    invoke: { src: "ws" },
    initial: "cutting",
    states: {
      cutting: {
        invoke: {
          src: "cut",
          input: ({ context }) =>
            ({
              path: context.path ?? "/work/app/final",
              handoff: context.handoff,
              ...(context.branch !== undefined ? { branch: context.branch } : {}),
              ...context.extra,
            }) as never,
          onDone: { target: "done", actions: assign({ out: ({ event }) => event.output }) },
        },
      },
      done: { type: "final" },
    },
    output: ({ context }) => context.out,
  });
}

/** The root: the parent Workspace cuts the coder's Worktree, then invokes the child with that cut's
 * `ready` output as its Handoff, or with `forged` in its place. */
function rootDef(exec: FakeHarnessExec, opts: { carrier?: HandoffCarrier } = {}) {
  const machine = jr2Setup({
    types: {} as { input: RootCtx; context: RootCtx },
    actors: {
      ws: fakeWorkspace(parent),
      cut: worktreeWith(exec.factory),
      final: childMachine(exec, opts.carrier),
    },
  }).createMachine({
    id: "root",
    context: ({ input }) => input,
    invoke: { src: "ws" },
    initial: "cutting",
    states: {
      cutting: {
        invoke: {
          src: "cut",
          input: { path: "/work/app/coder", branch: "fix/one" },
          onDone: [
            {
              guard: ({ event }) => isReady(event.output),
              target: "nested",
              actions: assign({ h: ({ event }) => readyOf(event.output) }),
            },
            { target: "done" },
          ],
        },
      },
      nested: {
        invoke: {
          src: "final",
          input: ({ context }) => ({
            handoff: context.forged ?? context.h,
            ...(context.branch !== undefined ? { branch: context.branch } : {}),
            ...(context.extra !== undefined ? { extra: context.extra } : {}),
          }),
          onDone: { target: "done", actions: assign({ out: ({ event }) => event.output as WorktreeOutput }) },
        },
      },
      done: {},
    },
  });
  return { name: "fx", machine, provide: () => ({}) };
}

const readyAnswer = (path: string, branch: string | null, head: string, found = "none") => ({
  outcome: "exited" as const,
  code: 0,
  tail: JSON.stringify({ outcome: "ready", slot: "app", path, branch, head, found }),
});
const cutRequest = (req: { argv: string[] }) => JSON.parse(req.argv[req.argv.length - 1]!) as Record<string, unknown>;

async function rig(input: RootCtx = {}, opts: { carrier?: HandoffCarrier } = {}) {
  const exec = new FakeHarnessExec();
  const store = await mkStore();
  const host = new RunHost({ store });
  host.register(rootDef(exec, opts));
  const { runId } = await host.start("fx", input as Record<string, unknown>);
  await waitFor(() => exec.starts.length === 1);
  exec.settle(readyAnswer("/work/app/coder", "fix/one", H));
  const rows = async () =>
    ((await store.load(runId))?.snapshot as { effects?: Record<string, EffectRow> }).effects ?? {};
  const out = () => (host.status(runId)?.context as RootCtx).out;
  return { exec, host, runId, rows, out };
}

test("an accepted Handoff: the child's cut sends the ledger's branch and commit, no `expect`, and keeps the source on its intent row", async () => {
  const r = await rig();
  await waitFor(() => r.exec.starts.length === 2);
  const start = r.exec.starts[1]!;
  assert.equal(start.endpoint, "http://ws-child.invalid", "the cut runs on the child's Harness");
  assert.deepEqual(cutRequest(start.req), {
    id: start.id,
    path: "/work/app/final",
    branch: "fix/one",
    handoff: H,
    timeoutMs: 600_000,
  });
  const intent = (await r.rows())[start.id] as Extract<EffectRow, { state: "intent"; kind: "command" }>;
  assert.equal(intent.state, "intent");
  const parentCut = Object.entries(await r.rows()).find(([, row]) => row.state === "settled")![0];
  assert.deepEqual(intent.handoff, {
    run: r.runId,
    sandbox: "ws-parent",
    endpoint: "http://ws-parent.invalid",
    row: parentCut,
    slot: "app",
    path: "/work/app/coder",
    head: H,
    branch: "fix/one",
  });
  r.exec.settle(readyAnswer("/work/app/final", "fix/one", H, "handoff"));
  await waitFor(() => r.host.status(r.runId)?.value === "done");
  assert.equal((r.out() as WorktreeReady).found, "handoff");
  const settled = (await r.rows())[start.id] as Extract<EffectRow, { state: "settled" }>;
  assert.deepEqual(settled.cut, { path: "/work/app/final", branch: "fix/one", head: H });
  await r.host.stop(r.runId);
});

test("the cut's `branch` names the child's branch", async () => {
  const r = await rig({ branch: "review/one" });
  await waitFor(() => r.exec.starts.length === 2);
  assert.equal(cutRequest(r.exec.starts[1]!.req).branch, "review/one");
  await r.host.stop(r.runId);
});

/** A forged Handoff settles `refused`, the Machine routes it, and the child's Harness hears nothing. */
async function refusedFor(forged: unknown, re: RegExp, extra?: Record<string, unknown>) {
  const r = await rig({ ...(forged !== undefined ? { forged } : {}), ...(extra ? { extra } : {}) });
  await waitFor(() => r.host.status(r.runId)?.value === "done");
  const out = r.out();
  assert.equal(out?.outcome, "refused", JSON.stringify(out));
  assert.match((out as { reason: string }).reason, re);
  assert.equal(r.exec.starts.length, 1, "only the parent's cut reached a Harness");
  await r.host.stop(r.runId);
}

test("a forged head is refused, and nothing reaches the child's Harness", async () => {
  await refusedFor(given({ head: H2 }), /no ready cut of this run made that commit at that path/);
});

test("a forged branch is refused: a Chart cannot hand off `main`", async () => {
  await refusedFor(given({ branch: "main" }), /made it on fix\/one, not on main/);
});

test("a forged slot is refused", async () => {
  await refusedFor(given({ slot: "docs" }), /in Repo Slot "app", not "docs"/);
});

test("a Handoff of the wrong shape is refused at the cut's start", async () => {
  await refusedFor({ slot: "app", path: "/work/app/coder", head: "abc" }, /a cut's `handoff` is a Handoff/);
  await refusedFor("not a handoff", /a cut's `handoff` is a Handoff/);
});

test("a cut at a Handoff takes no `from` and no `detach`", async () => {
  await refusedFor(undefined, /a cut at a Handoff takes no `from`/, { from: "main" });
  await refusedFor(undefined, /a cut at a Handoff takes no `detach`/, { detach: H });
});

test("a Handoff of another run is refused: each run has its own ledger", async () => {
  const exec = new FakeHarnessExec();
  const host = new RunHost({ store: await mkStore() });
  host.register(rootDef(exec));
  // Run A cuts, and its Handoff is real there.
  const a = await host.start("fx", {});
  await waitFor(() => exec.starts.length === 1);
  exec.settle(readyAnswer("/work/app/coder", "fix/one", H2), exec.starts[0]!.id);
  await waitFor(() => exec.starts.length === 2);
  // Run B's own cut gives H; its child takes run A's commit.
  const b = await host.start("fx", { forged: given({ head: H2 }) });
  await waitFor(() => exec.starts.length === 3);
  exec.settle(readyAnswer("/work/app/coder", "fix/one", H), exec.starts[2]!.id);
  await waitFor(() => host.status(b.runId)?.value === "done");
  const out = (host.status(b.runId)?.context as RootCtx).out as { outcome: string; reason: string };
  assert.equal(out.outcome, "refused");
  assert.match(out.reason, /no ready cut of this run made that commit/);
  assert.equal(exec.starts.length, 3, "run B's child sent nothing");
  await host.stop(a.runId);
  await host.stop(b.runId);
});

test("a Handoff of the child's own cut is refused", async () => {
  const exec = new FakeHarnessExec();
  // The child cuts its own Worktree first, then gives that cut to its second cut as a Handoff.
  const own = jr2Setup({
    types: {} as { context: { out?: WorktreeOutput; h?: WorktreeReady } },
    actors: { ws: fakeWorkspace(child), cut: worktreeWith(exec.factory) },
  }).createMachine({
    id: "own",
    context: {},
    invoke: { src: "ws" },
    initial: "first",
    states: {
      first: {
        invoke: {
          src: "cut",
          input: { path: "/work/app/coder", branch: "fix/one" },
          onDone: { target: "second", actions: assign({ h: ({ event }) => readyOf(event.output) }) },
        },
      },
      second: {
        invoke: {
          src: "cut",
          input: ({ context }) => ({ path: "/work/app/final", handoff: context.h! }),
          onDone: { target: "done", actions: assign({ out: ({ event }) => event.output }) },
        },
      },
      done: { type: "final" },
    },
    output: ({ context }) => context.out,
  });
  const outer = jr2Setup({
    types: {} as { context: { out?: WorktreeOutput } },
    actors: { ws: fakeWorkspace(parent), own },
  }).createMachine({
    id: "outer",
    context: {},
    invoke: { src: "ws" },
    initial: "nested",
    states: {
      nested: {
        invoke: {
          src: "own",
          onDone: { target: "done", actions: assign({ out: ({ event }) => event.output as WorktreeOutput }) },
        },
      },
      done: {},
    },
  });
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "own", machine: outer, provide: () => ({}) });
  const { runId } = await host.start("own");
  await waitFor(() => exec.starts.length === 1);
  exec.settle(readyAnswer("/work/app/coder", "fix/one", H));
  await waitFor(() => host.status(runId)?.value === "done");
  const out = (host.status(runId)?.context as { out: { outcome: string; reason: string } }).out;
  assert.equal(out.outcome, "refused");
  assert.match(out.reason, /this nested Workspace's own cut made it, and a Handoff comes from an enclosing Workspace/);
  assert.equal(exec.starts.length, 1);
  await host.stop(runId);
});

test("the carrier's seam: `refused` and `unknown` settle the cut with no exec; `nothing` and `carried` start it", async () => {
  for (const answer of [
    { outcome: "refused", reason: "the source answered that the commit is not there" },
    { outcome: "unknown", reason: "the source Harness did not answer" },
  ] as const) {
    const calls: Parameters<HandoffCarrier>[0][] = [];
    const r = await rig({}, { carrier: async (args) => (calls.push(args), answer) });
    await waitFor(() => r.host.status(r.runId)?.value === "done");
    assert.deepEqual(r.out(), answer);
    assert.equal(r.exec.starts.length, 1, "the child's cut did not start");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.source.head, H);
    assert.deepEqual(calls[0]!.target, { endpoint: "http://ws-child.invalid", sandbox: "ws-child" });
    // The intent row was written before the carrier ran: the source is on it.
    await r.host.stop(r.runId);
  }
  for (const outcome of ["nothing", "carried"] as const) {
    let effect = "";
    const r = await rig({}, { carrier: async (args) => ((effect = args.effect), { outcome }) });
    await waitFor(() => r.exec.starts.length === 2);
    assert.equal(r.exec.starts[1]!.id, effect, "the files are carried under the cut's Effect id");
    await r.host.stop(r.runId);
  }
});

test("an Orchestrator restart mid-cut at a Handoff: the cut goes again under its id, with the source its intent row keeps", async () => {
  const exec = new FakeHarnessExec();
  const store = await mkStore();
  const first = new RunHost({ store });
  first.register(rootDef(exec));
  const { runId } = await first.start("fx", {});
  await waitFor(() => exec.starts.length === 1);
  exec.settle(readyAnswer("/work/app/coder", "fix/one", H));
  await waitFor(() => exec.starts.length === 2);
  const sent = exec.starts[1]!;
  await first.stop(runId);
  exec.forgetAll();
  // The parent's row moves on in the saved ledger: a check made again would find no row for H. The
  // restored cut keeps the source of its intent row, so it asks the same source.
  const saved = (await store.load(runId))!.snapshot as { effects: Record<string, EffectRow> };
  for (const row of Object.values(saved.effects)) {
    if (row.state === "settled" && row.cut) {
      row.cut.head = H2;
      (row.output as { head: string }).head = H2;
    }
  }
  await store.save(runId, saved);

  const host = new RunHost({ store });
  host.register(rootDef(exec));
  await host.restore();
  await waitFor(() => exec.starts.length === 3);
  const again = exec.starts[2]!;
  assert.equal(again.id, sent.id, "a cut is idempotent: the same id");
  assert.deepEqual(cutRequest(again.req), cutRequest(sent.req));
  const rows = ((await store.load(runId))?.snapshot as { effects: Record<string, EffectRow> }).effects;
  assert.equal((rows[sent.id] as { handoff?: { head: string } }).handoff?.head, H);
  exec.settle(readyAnswer("/work/app/final", "fix/one", H, "handoff"));
  await waitFor(() => host.status(runId)?.value === "done");
  await host.stop(runId);
});
