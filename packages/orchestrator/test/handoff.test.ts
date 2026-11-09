// A cut at a Handoff (ADR-0080): the ledger check, alone and through the real RunHost and `drive`
// on a fake Harness. Each fact of a Handoff that the run's ledger does not hold is a routable
// `refused`, and nothing reaches the child's Harness. An accepted cut sends what the ledger found,
// and keeps it on its intent row.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { duplexPair } from "node:stream";
import { test } from "node:test";
import { assign } from "xstate";
import type { AmbientHandles } from "../src/ambient.ts";
import { inputShapeOf, oneOfHolds, type EffectRow } from "../src/effect.ts";
import { handoff, handoffShapeFault, handoffSourceOf, type Handoff, type HandoffCarrier } from "../src/handoff.ts";
import { handoffCarrier } from "../src/handoff-carry.ts";
import { HANDOFF_CONTENT_TYPE } from "../src/wire.ts";
import { RunHost } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { isReady, readyOf, worktree, worktreeWith, type WorktreeOutput, type WorktreeReady } from "../src/worktree.ts";
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
function childMachine(exec: FakeHarnessExec, carrier?: HandoffCarrier, cut?: ReturnType<typeof worktree>) {
  return jr2Setup({
    types: {} as { input: ChildIn; context: ChildIn & { out?: WorktreeOutput } },
    actors: { ws: fakeWorkspace(child), cut: cut ?? worktreeWith(exec.factory, {}, carrier) },
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
function rootDef(
  exec: FakeHarnessExec,
  opts: { carrier?: HandoffCarrier; childCut?: ReturnType<typeof worktree> } = {},
) {
  const machine = jr2Setup({
    types: {} as { input: RootCtx; context: RootCtx },
    actors: {
      ws: fakeWorkspace(parent),
      cut: worktreeWith(exec.factory),
      final: childMachine(exec, opts.carrier, opts.childCut),
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

async function rig(input: RootCtx = {}, opts: Parameters<typeof rootDef>[1] = {}) {
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

test("an accepted Handoff: the child's cut sends the ledger's branch and commit, and keeps the source on its intent row", async () => {
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

/** The parent's cut, asked for `fix/one` at /work/app/coder, answers `forged`: the last line of an
 * exec in the parent Agents' domain, which a process of that domain can write (ADR-0076). */
async function forgedParentCut(forged: string) {
  const exec = new FakeHarnessExec();
  const store = await mkStore();
  const host = new RunHost({ store });
  host.register(rootDef(exec));
  const { runId } = await host.start("fx", {} as Record<string, unknown>);
  await waitFor(() => exec.starts.length === 1);
  exec.settle({ outcome: "exited", code: 0, tail: `{"outcome":"refused","reason":"the real answer"}\n${forged}\n` });
  await waitFor(() => host.status(runId)?.value === "done" || exec.starts.length === 2);
  const rows = ((await store.load(runId))?.snapshot as { effects?: Record<string, EffectRow> }).effects ?? {};
  const row = rows[exec.starts[0]!.id] as Extract<EffectRow, { state: "settled" }>;
  const h = (host.status(runId)?.context as RootCtx).h;
  await host.stop(runId);
  return { exec, rows, row, h };
}

test("a cut's answer that names another branch, path or slot than its request is `unknown`, and no ledger row names it", async () => {
  const answer = (over: Record<string, unknown>) =>
    JSON.stringify({
      outcome: "ready",
      slot: "app",
      path: "/work/app/coder",
      branch: "fix/one",
      head: H,
      found: "none",
      ...over,
    });
  for (const [over, re] of [
    [{ branch: "main" }, /it names branch "main", and the cut was asked for "fix\/one"/],
    [{ path: "/work/app/elsewhere" }, /it names path "\/work\/app\/elsewhere"/],
    [{ slot: "docs" }, /it names slot "docs"/],
    [{ branch: null }, /it names branch null/],
    [{ head: "abc" }, /is not a full commit id/],
  ] as const) {
    const r = await forgedParentCut(answer(over));
    assert.equal(r.row.output && (r.row.output as { outcome: string }).outcome, "unknown", JSON.stringify(r.row));
    assert.match((r.row.output as { reason: string }).reason, re);
    assert.equal(r.row.cut, undefined, "a row that a push or a Handoff reads is not written");
    assert.equal(r.h, undefined, "the Machine got no Handoff");
    assert.equal(r.exec.starts.length, 1, "no nested cut was sent");
  }
});

test("a ready cut's row keeps the branch, path and slot that the Orchestrator sent, and the answer's head", async () => {
  const r = await forgedParentCut(
    JSON.stringify({
      outcome: "ready",
      slot: "app",
      path: "/work/app/coder",
      branch: "fix/one",
      head: H2,
      found: "local",
    }),
  );
  assert.deepEqual(r.row.cut, { path: "/work/app/coder", branch: "fix/one", head: H2 });
  assert.equal(r.row.repo, "app");
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

test("a carrier that throws settles the cut `unknown`, never the invoke's error: an Agent's files can cause it", async () => {
  const r = await rig(
    {},
    {
      carrier: async () => {
        throw new Error("the stream ended early");
      },
    },
  );
  await waitFor(() => r.host.status(r.runId)?.value === "done");
  const out = r.out() as { outcome: string; reason: string };
  assert.equal(out.outcome, "unknown", JSON.stringify(out));
  assert.match(out.reason, /the files of the Handoff were not carried: the stream ended early/);
  assert.equal(r.exec.starts.length, 1, "the child's cut did not start");
  await r.host.stop(r.runId);
});

test("a child Harness that restarts after the carry: the files are carried again before the cut is sent again", async () => {
  const calls: string[] = [];
  const r = await rig({}, { carrier: async (args) => (calls.push(args.effect), { outcome: "carried" }) });
  await waitFor(() => r.exec.starts.length === 2);
  const id = r.exec.starts[1]!.id;
  assert.deepEqual(calls, [id]);
  // The child's Harness restarts: it knows no exec, and the files of the last carry may be gone.
  r.exec.forgetAll();
  await waitFor(() => r.exec.starts.length === 3);
  assert.equal(r.exec.starts[2]!.id, id, "the cut is sent again under its id");
  assert.deepEqual(calls, [id, id], "and its files went again first");
  r.exec.settle(readyAnswer("/work/app/final", "fix/one", H, "handoff"));
  await waitFor(() => r.host.status(r.runId)?.value === "done");
  assert.equal((r.out() as WorktreeReady).found, "handoff");
  await r.host.stop(r.runId);
});

/** A fake `fetch` for the carry's two legs. The source answers `frames` and then ends, or hangs
 * with `hang`. Each request honours its signal, as `dialFetch` does. */
function carryFetch(frames: string, opts: { hang?: boolean } = {}) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const signal = init.signal!;
    calls.push({
      method: init.method!,
      url: String(input),
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    });
    if (init.method === "POST") {
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          if (!sent) return void ((sent = true), ctrl.enqueue(new TextEncoder().encode(frames)));
          if (opts.hang) return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
          ctrl.close();
        },
      });
      return new Response(stream, { headers: { "content-type": HANDOFF_CONTENT_TYPE } });
    }
    const reader = (init.body as ReadableStream<Uint8Array>).getReader();
    const stopped = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    stopped.catch(() => {});
    for (;;) {
      const next = await Promise.race([reader.read(), stopped]);
      if (next.done) break;
    }
    return Response.json({ landed: true });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const WHOLE = '{"bundle":4}\n{"data":4}\nBNDL{"end":true}\n';

test("an Orchestrator restart mid-carry: the restored cut carries again under its id, from the source its intent row keeps, at the source's Harness where it runs now", async () => {
  const exec = new FakeHarnessExec();
  const store = await mkStore();
  const stalled = carryFetch('{"bundle":4}\n{"data":2}\nBN', { hang: true });
  const first = new RunHost({ store });
  first.register(rootDef(exec, { carrier: handoffCarrier({ fetch: stalled.fetch }) }));
  const { runId } = await first.start("fx", {});
  await waitFor(() => exec.starts.length === 1);
  exec.settle(readyAnswer("/work/app/coder", "fix/one", H));
  await waitFor(() => stalled.calls.some((c) => c.method === "PUT"));
  const put = stalled.calls.find((c) => c.method === "PUT")!.url;
  assert.equal(exec.starts.length, 1, "the child's cut waits for its files");
  await first.stop(runId);
  exec.forgetAll();

  // In the saved run: the parent's row moves on (a check made again would find no row for H), and
  // the intent row names an endpoint that the source no longer has.
  const saved = (await store.load(runId))!.snapshot as { effects: Record<string, EffectRow> };
  for (const row of Object.values(saved.effects)) {
    if (row.state === "settled" && row.cut) {
      row.cut.head = H2;
      (row.output as { head: string }).head = H2;
    }
    if (row.state === "intent" && "handoff" in row && row.handoff)
      row.handoff.endpoint = "http://ws-parent-then.invalid";
  }
  await store.save(runId, saved);

  const whole = carryFetch(WHOLE);
  const host = new RunHost({ store });
  host.register(rootDef(exec, { carrier: handoffCarrier({ fetch: whole.fetch }) }));
  await host.restore();
  await waitFor(() => exec.starts.length === 2);
  assert.deepEqual(
    whole.calls.map((c) => [c.method, c.url]),
    [
      ["POST", "http://ws-parent.invalid/handoff"],
      ["PUT", put],
    ],
    "the same Effect id, at the source's Harness where it runs now",
  );
  assert.deepEqual(JSON.parse(whole.calls[0]!.body!), { path: "/work/app/coder", head: H }, "the intent row's source");
  assert.equal(
    put,
    `http://ws-child.invalid/handoffs/${exec.starts[1]!.id}`,
    "the cut starts under the id of its files",
  );
  exec.settle(readyAnswer("/work/app/final", "fix/one", H, "handoff"));
  await waitFor(() => host.status(runId)?.value === "done");
  assert.equal((host.status(runId)?.context as RootCtx).out?.outcome, "ready");
  await host.stop(runId);
});

test("a restored cut whose source Workspace no longer runs is `unknown`, and nothing is carried or started", async () => {
  const exec = new FakeHarnessExec();
  const store = await mkStore();
  const stalled = carryFetch('{"bundle":4}\n', { hang: true });
  const first = new RunHost({ store });
  first.register(rootDef(exec, { carrier: handoffCarrier({ fetch: stalled.fetch }) }));
  const { runId } = await first.start("fx", {});
  await waitFor(() => exec.starts.length === 1);
  exec.settle(readyAnswer("/work/app/coder", "fix/one", H));
  await waitFor(() => stalled.calls.some((c) => c.method === "PUT"));
  await first.stop(runId);
  const saved = (await store.load(runId))!.snapshot as { effects: Record<string, EffectRow> };
  for (const row of Object.values(saved.effects)) {
    if (row.state === "intent" && "handoff" in row && row.handoff) row.handoff.sandbox = "ws-gone";
  }
  await store.save(runId, saved);

  const whole = carryFetch(WHOLE);
  const host = new RunHost({ store });
  host.register(rootDef(exec, { carrier: handoffCarrier({ fetch: whole.fetch }) }));
  await host.restore();
  await waitFor(() => host.status(runId)?.value === "done");
  assert.deepEqual((host.status(runId)?.context as RootCtx).out, {
    outcome: "unknown",
    reason: "the files of the Handoff were not carried: the Workspace ws-gone that made it is not running",
  });
  assert.equal(whole.calls.length, 0);
  assert.equal(exec.starts.length, 1);
  await host.stop(runId);
});

test("the real carrier through the RunHost: a source's refusal settles the child's cut `refused`, and the Machine routes it", async () => {
  const r = await rig(
    {},
    {
      carrier: handoffCarrier({
        fetch: carryFetch(`{"refused":"the parent's clone does not hold the commit ${H}"}\n`).fetch,
      }),
    },
  );
  await waitFor(() => r.host.status(r.runId)?.value === "done");
  assert.deepEqual(r.out(), {
    outcome: "refused",
    reason: `the Handoff of /work/app/coder at ${H}: the parent's clone does not hold the commit ${H}`,
  });
  assert.equal(r.exec.starts.length, 1);
  await r.host.stop(r.runId);
});

test("worktree() carries with the real carrier: its source leg dials the parent's Harness, and the parent's refusal settles the cut", async (t) => {
  // The parent's Harness, over an in-memory connection: `dialFetch` makes each connection with
  // `net.createConnection`, read at call time.
  const dialed: string[] = [];
  const server = createServer((req, res) => {
    dialed.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": HANDOFF_CONTENT_TYPE });
      res.end(`${JSON.stringify({ refused: `the parent's clone does not hold the commit ${H}` })}\n`);
    });
  });
  t.after(() => server.close());
  t.mock.method(net, "createConnection", (args: { host?: string }) => {
    if (args.host !== "ws-parent.invalid")
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", syscall: "connect" });
    const [client, side] = duplexPair();
    server.emit("connection", side);
    return client;
  });
  // The cut's exec goes through the global fetch: the child's Harness must not be asked.
  const execs: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    execs.push(String(input));
    throw new TypeError("fetch failed");
  });
  const r = await rig({}, { childCut: worktree() });
  t.after(() => r.host.stop(r.runId));
  await waitFor(() => dialed.length > 0 || execs.length > 0);
  assert.deepEqual(execs, [], "the cut did not start on the child's Harness");
  await waitFor(() => r.host.status(r.runId)?.value === "done");
  assert.deepEqual(r.out(), {
    outcome: "refused",
    reason: `the Handoff of /work/app/coder at ${H}: the parent's clone does not hold the commit ${H}`,
  });
  assert.deepEqual(dialed, ["POST /handoff"]);
  assert.deepEqual(execs, []);
});

// --- Through the real actor chain: more than one level, and siblings ------------------------------

/** A nested Workspace `name` that cuts with `mk(context)`, and outputs the cut. */
function nestedCut(
  exec: FakeHarnessExec,
  name: string,
  mk: (ctx: { h?: WorktreeReady }) => unknown,
  options: Parameters<typeof worktreeWith>[1] = {},
  carrier?: HandoffCarrier,
) {
  return jr2Setup({
    types: {} as { input: { h?: WorktreeReady }; context: { h?: WorktreeReady; out?: WorktreeOutput } },
    actors: { ws: fakeWorkspace(ws(name)), cut: worktreeWith(exec.factory, options, carrier) },
  }).createMachine({
    id: name,
    context: ({ input }) => input,
    invoke: { src: "ws" },
    initial: "cutting",
    states: {
      cutting: {
        invoke: {
          src: "cut",
          input: ({ context }) => mk(context) as never,
          onDone: { target: "done", actions: assign({ out: ({ event }) => event.output }) },
        },
      },
      done: { type: "final" },
    },
    output: ({ context }) => context.out,
  });
}

/** A root Workspace `ws-parent` that cuts the coder's Worktree, then invokes `next` with its Handoff. */
function cutThen(
  exec: FakeHarnessExec,
  next: ReturnType<typeof nestedCut>,
  options: Parameters<typeof worktreeWith>[1] = {},
) {
  return jr2Setup({
    types: {} as { context: { h?: WorktreeReady; out?: WorktreeOutput } },
    actors: { ws: fakeWorkspace(ws("ws-parent")), cut: worktreeWith(exec.factory, options), next },
  }).createMachine({
    id: "root",
    context: {},
    invoke: { src: "ws" },
    initial: "cutting",
    states: {
      cutting: {
        invoke: {
          src: "cut",
          input: { path: "/work/app/coder", branch: "fix/one" },
          onDone: { target: "nested", actions: assign({ h: ({ event }) => readyOf(event.output) }) },
        },
      },
      nested: {
        invoke: {
          src: "next",
          input: ({ context }) => ({ h: context.h }),
          onDone: { target: "done", actions: assign({ out: ({ event }) => event.output as WorktreeOutput }) },
          onError: { target: "done", actions: assign({ out: () => ({ outcome: "ERROR" }) as never }) },
        },
      },
      done: {},
    },
  });
}

async function runRoot(exec: FakeHarnessExec, machine: ReturnType<typeof cutThen>, first = "/work/app/coder") {
  const store = await mkStore();
  const host = new RunHost({ store });
  host.register({ name: "chain", machine, provide: () => ({}) });
  const { runId } = await host.start("chain");
  await waitFor(() => exec.starts.length === 1);
  exec.settle(readyAnswer(first, "fix/one", H));
  const rows = async () => ((await store.load(runId))?.snapshot as { effects: Record<string, EffectRow> }).effects;
  const out = () => (host.status(runId)?.context as { out?: { outcome: string; reason?: string } }).out;
  return { host, runId, rows, out };
}

test("a Handoff of a Workspace two levels up, through the real actor chain: accepted, the source is the top Workspace, and its files come from the top Workspace's Harness", async () => {
  const exec = new FakeHarnessExec();
  const asked: Parameters<HandoffCarrier>[0][] = [];
  const carrier: HandoffCarrier = async (args) => {
    asked.push(args);
    return { outcome: "carried" };
  };
  const leaf = nestedCut(exec, "ws-leaf", (c) => ({ path: "/work/app/final", handoff: c.h }), {}, carrier);
  // The middle Workspace cuts nothing: it passes the Handoff down.
  const mid = jr2Setup({
    types: {} as { input: { h?: WorktreeReady }; context: { h?: WorktreeReady; out?: WorktreeOutput } },
    actors: { ws: fakeWorkspace(ws("ws-mid")), leaf },
  }).createMachine({
    id: "mid",
    context: ({ input }) => input,
    invoke: { src: "ws" },
    initial: "n",
    states: {
      n: {
        invoke: {
          src: "leaf",
          input: ({ context }) => ({ h: context.h }),
          onDone: { target: "done", actions: assign({ out: ({ event }) => event.output as WorktreeOutput }) },
        },
      },
      done: { type: "final" },
    },
    output: ({ context }) => context.out,
  });
  const r = await runRoot(exec, cutThen(exec, mid as unknown as ReturnType<typeof nestedCut>));
  await waitFor(() => exec.starts.length === 2);
  assert.equal(exec.starts[1]!.endpoint, "http://ws-leaf.invalid");
  const intent = (await r.rows())[exec.starts[1]!.id] as { handoff?: { sandbox: string; endpoint: string } };
  assert.equal(intent.handoff?.sandbox, "ws-parent");
  assert.equal(intent.handoff?.endpoint, "http://ws-parent.invalid");
  // The source runs two levels up, not in the leaf's own parent: it is still found live.
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0]!.from, { endpoint: "http://ws-parent.invalid", sandbox: "ws-parent" });
  assert.deepEqual(asked[0]!.target, { endpoint: "http://ws-leaf.invalid", sandbox: "ws-leaf" });
  await r.host.stop(r.runId);
});

test("a Handoff of a sibling nested Workspace's cut, through the real actor chain, is refused", async () => {
  const exec = new FakeHarnessExec();
  const s1 = nestedCut(exec, "ws-s1", () => ({ path: "/work/app/coder", branch: "fix/one" }));
  const s2 = nestedCut(exec, "ws-s2", (c) => ({ path: "/work/app/final", handoff: c.h }));
  const root = jr2Setup({
    types: {} as { context: { h?: WorktreeReady; out?: WorktreeOutput } },
    actors: { ws: fakeWorkspace(ws("ws-parent")), s1, s2 },
  }).createMachine({
    id: "root",
    context: {},
    invoke: { src: "ws" },
    initial: "one",
    states: {
      one: {
        invoke: {
          src: "s1",
          input: {},
          onDone: { target: "two", actions: assign({ h: ({ event }) => readyOf(event.output as WorktreeOutput) }) },
        },
      },
      two: {
        invoke: {
          src: "s2",
          input: ({ context }) => ({ h: context.h }),
          onDone: { target: "done", actions: assign({ out: ({ event }) => event.output as WorktreeOutput }) },
        },
      },
      done: {},
    },
  });
  const r = await runRoot(exec, root as unknown as ReturnType<typeof cutThen>);
  await waitFor(() => r.host.status(r.runId)?.value === "done");
  const out = r.out()!;
  assert.equal(out.outcome, "refused", JSON.stringify(out));
  assert.match(out.reason!, /a Workspace that does not enclose this one made it/);
  assert.equal(exec.starts.length, 1, "the sibling's cut reached no Harness");
  await r.host.stop(r.runId);
});

test("a `branch` that is not a string beside a Handoff is refused, not the invoke's error", async () => {
  const exec = new FakeHarnessExec();
  const child = nestedCut(exec, "ws-child", (c) => ({ path: "/work/app/final", handoff: c.h, branch: 7 }));
  const r = await runRoot(exec, cutThen(exec, child));
  await waitFor(() => r.host.status(r.runId)?.value === "done");
  const out = r.out()!;
  assert.equal(out.outcome, "refused", JSON.stringify(out));
  assert.match(out.reason!, /a cut's `branch` is a string/);
  assert.equal(exec.starts.length, 1);
  await r.host.stop(r.runId);
});

test("a slot's static `expect` goes with a cut at a Handoff, so a `branch` cannot name a branch that exists", async () => {
  // The child's Harness applies it to the child's branch, as at a branch cut (ADR-0080, ADR-0075).
  const exec = new FakeHarnessExec();
  const child = nestedCut(exec, "ws-child", (c) => ({ path: "/work/app/final", handoff: c.h, branch: "release" }), {
    expect: "new",
  });
  const r = await runRoot(exec, cutThen(exec, child, { expect: "new" }));
  await waitFor(() => exec.starts.length === 2);
  const req = cutRequest(exec.starts[1]!.req);
  assert.equal(req.branch, "release");
  assert.equal(req.expect, "new");
  await r.host.stop(r.runId);
});
