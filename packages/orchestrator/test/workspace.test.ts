// workspace(body, { repos, workGroup }) — ADR-0012, ADR-0051, ADR-0075. Driven through a REAL RunHost (store +
// binding + restore) against a fake SandboxPort at the seam, so lifecycle, input passthrough,
// parked-body retention, the Repo Slots' three states, and the restore-reconcile `workspace.lost`
// path are exercised the way a run experiences them. The kind-backed port has its own suite; the
// cluster itself is e2e-tier.

import { mock, test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { assign, fromPromise, setup, spawnChild, type AnyStateMachine } from "xstate";
import { jr2Setup } from "../src/setup.ts";
import { agentActorWith } from "../src/actor.ts";
import { customize } from "../src/customize.ts";
import { open, partsOf, sandboxPartsOf, workspacePodsOf, type PlacementRoute } from "../src/parts.ts";
import { fail, isFailure } from "../src/fail.ts";
import { workspaceHeldPod } from "../src/held-secrets.ts";
import {
  leaseDelay,
  workspace,
  workspaceName,
  type Continuity,
  type MemoryKill,
  type PlaceRequest,
  type PlacingWait,
  type ProvisionedRepo,
  type SandboxLoss,
  type SandboxPort,
  type Workspaced,
} from "../src/workspace.ts";
import { observe, RunHost, type WorkflowDef } from "../src/run-host.ts";
import { pool, source, type PoolNextInput } from "../src/pool.ts";
import { approveDef, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

class FakeSandbox implements SandboxPort {
  calls: string[] = [];
  provisioned = new Map<string, { runId: string; workflow: string }>();
  /** The Assembly each place request named (ADR-0069). */
  assemblies: Array<string | undefined> = [];
  /** The Workspace path each place request named (ADR-0012): the label and the annotation. */
  paths: string[] = [];
  /** Who is listening to the watch, per Sandbox name (ADR-0063). */
  private listeners = new Map<string, Set<(seen: Continuity) => void>>();
  private _present = true;
  private _lost: SandboxLoss | undefined;
  /** What the watch says — flip to false to simulate a reaped Sandbox; every listener hears it. */
  get present(): boolean {
    return this._present;
  }
  set present(v: boolean) {
    this._present = v;
    this.tell();
  }
  /** The operator's Lost verdict (ADR-0021): set it to simulate an eviction or a node loss — same
   * CR, same name, same endpoint, and a pod that ended with the `work` volume on it. */
  get lost(): SandboxLoss | undefined {
    return this._lost;
  }
  set lost(v: SandboxLoss | undefined) {
    this._lost = v;
    this.tell();
  }
  /** Make every `renew()` throw — a failed write is "unknown", never "lost". */
  failRenew = false;
  /** Fast enough that a test can observe several ticks without sleeping on wall clock. */
  leaseIntervalMs = 5;

  /**
   * Hold every `place()` until {@link schedule} — a Sandbox with no node (ADR-0064). While held,
   * {@link waitFor} plays the operator's reason for the wait.
   */
  holdPlacing = false;
  private placing = new Set<{
    onWait: (wait: PlacingWait) => void;
    resolve: () => void;
    reject: (err: unknown) => void;
  }>();
  /** Say why the held Sandboxes wait, as the operator does on its status. */
  waitFor(wait: PlacingWait): void {
    for (const p of this.placing) p.onWait(wait);
  }
  /** The scheduler found a node: every held `place()` resolves. */
  schedule(): void {
    for (const p of [...this.placing]) p.resolve();
    this.placing.clear();
  }
  /** A Sandbox that is Lost before it is placed: every held `place()` rejects, by name. */
  loseWhilePlacing(reason: string): void {
    for (const p of [...this.placing]) p.reject(new Error(`Sandbox is Lost while it waited for a node: ${reason}`));
    this.placing.clear();
  }
  /** How many `place()` calls are waiting right now. */
  get waiting(): number {
    return this.placing.size;
  }

  private seen(): Continuity {
    if (!this._present) return { present: false };
    return this._lost ? { present: true, lost: this._lost } : { present: true };
  }
  private tell(): void {
    for (const set of this.listeners.values()) for (const l of set) l(this.seen());
  }
  /** How many listeners the watch has right now — a stopped lease must leave none. */
  get listening(): number {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }

  /** The Sandbox Image NAME each provision was asked for (ADR-0037) — resolution is the port's. */
  images: Array<string | undefined> = [];
  /** The pod-composition fields beside it (ADR-0005), same passthrough rule. */
  composition: Array<{ user?: string; workGroup?: number }> = [];
  /** The `projectContext` each provision was asked for (ADR-0062), as the Machine states it. */
  projectContexts: Array<string | undefined> = [];
  /** The Repo Slots each provision resolved (ADR-0051), in declaration order. */
  repos: ProvisionedRepo[][] = [];
  /** The Size each provision was handed, as the Machine states it (ADR-0060). */
  sizes: Array<{ resources?: unknown; userResources?: unknown }> = [];
  /** The `customize()` route each provision was asked for, read off the live actor (ADR-0059). */
  routes: PlacementRoute[] = [];
  /** What each attach was asked to attach — the persisted bindings, as the port sees them. */
  attached: Array<Array<{ slot: string; url: string; ref?: string }>> = [];

  async place(req: PlaceRequest, opts: { onWait: (wait: PlacingWait) => void; signal?: AbortSignal }): Promise<void> {
    this.calls.push(`place:${req.name}`);
    this.sizes.push({
      ...(req.resources !== undefined ? { resources: req.resources } : {}),
      ...(req.userResources !== undefined ? { userResources: req.userResources } : {}),
    });
    this.images.push(req.image);
    this.composition.push({ user: req.user, workGroup: req.workGroup });
    this.projectContexts.push(req.projectContext);
    this.repos.push(req.repos);
    this.routes.push(req.route);
    this.assemblies.push(req.assembly);
    this.paths.push(req.path);
    this.provisioned.set(req.name, { runId: req.runId, workflow: req.workflow });
    if (!this.holdPlacing) return;
    await new Promise<void>((resolve, reject) => {
      const entry = { onWait: opts.onWait, resolve, reject };
      this.placing.add(entry);
      opts.signal?.addEventListener("abort", () => {
        this.placing.delete(entry);
        reject(opts.signal!.reason);
      });
    });
  }
  async provision(name: string): Promise<{ endpoint: string }> {
    this.calls.push(`provision:${name}`);
    return { endpoint: "http://sandbox.test" };
  }
  async attach(
    req: {
      name: string;
      repos: Array<{ slot: string; url: string; ref?: string }>;
    },
    _opts?: { signal?: AbortSignal },
  ): Promise<{ repos: Record<string, string> }> {
    this.calls.push(`attach:${req.name}`);
    this.attached.push(req.repos);
    return { repos: Object.fromEntries(req.repos.map((r) => [r.slot, `/work/${r.slot}`])) };
  }
  async renew(name: string): Promise<void> {
    this.calls.push(`renew:${name}`);
    if (this.failRenew) throw new Error("the API server is having a day");
  }
  /** The Sandboxes the Lease marked `released` (ADR-0021), in order. */
  released: string[] = [];
  async releaseHold(name: string): Promise<void> {
    this.released.push(name);
  }
  continuity(name: string, listener: (seen: Continuity) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(listener);
    // The watch has listed: what it holds is the first answer (the restore reconcile).
    queueMicrotask(() => set.has(listener) && listener(this.seen()));
    return () => set.delete(listener);
  }
  harnessRestarts(): () => void {
    return () => {};
  }
  async memoryFault(): Promise<MemoryKill | undefined> {
    return undefined;
  }
  async destroy(name: string): Promise<void> {
    this.calls.push(`destroy:${name}`);
  }
}

/** Calls with the lease's periodic renews collapsed away — the lifecycle verbs, in order. */
const lifecycle = (sandbox: FakeSandbox): string[] =>
  sandbox.calls.filter((c) => !c.startsWith("renew:")).map((c) => c.split(":")[0]!);

const renews = (sandbox: FakeSandbox): number => sandbox.calls.filter((c) => c.startsWith("renew:")).length;

/** A body that parks on a gate inside its Sandbox; `workspace.lost` routes to its own policy
 * (final `lost`) exactly as ADR-0012's "the wrapper emits, the body decides". jr2Setup-authored:
 * the wrapper PROPAGATES this vocabulary onto the exported machine (ADR-0015). */
const body = jr2Setup({
  types: {} as {
    context: { handles?: { repos: Record<string, string> }; loss?: string };
    // Body-facing handles only (ADR-0016): endpoint/sandbox never reach workflow code.
    input: { workspace: { repos: Record<string, string> } };
  },
  events: [approveDef],
}).createMachine({
  id: "body",
  context: ({ input }) => ({ handles: input.workspace }),
  initial: "working",
  states: {
    working: {
      invoke: { src: "gate", input: { gate: "hold", accepts: ["approve"] } },
      on: {
        approve: "done",
        // The loss carries why (ADR-0021): the body's policy may tell a reap from an eviction.
        "workspace.lost": { target: "lost", actions: assign({ loss: ({ event }) => event.reason }) },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ status: "done", app: context.handles?.repos.app }),
    },
    lost: { type: "final", output: ({ context }) => ({ status: "lost", reason: context.loss }) },
  },
  // xstate v5: a machine's output is its ROOT `output`; final-state outputs ride the done event.
  output: ({ event }) => (event as { output?: unknown }).output,
});

const APP = "https://example.test/app.git";
const wrapped = workspace(body, { repos: { app: { url: APP, ref: "main" } } });

function wsDef(): WorkflowDef {
  return { name: "ws", machine: wrapped, provide: () => ({}) };
}

test("a place request names the Assembly the run holds, so a held run's image failure can name it (ADR-0069)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ ...wsDef(), assembly: "aaaaaaaaaaaa" });
  host.register({ ...wsDef(), name: "bare" });
  const held = await host.start("ws");
  await waitFor(() => host.gates(held.runId).length === 1);
  const bare = await host.start("bare");
  await waitFor(() => host.gates(bare.runId).length === 1);
  assert.deepEqual(sandbox.assemblies, ["aaaaaaaaaaaa", undefined], "a run no Assembly started names none");
});

test("workspaceName is deterministic, DNS-1123, and distinct per (run, wsId)", () => {
  const a = workspaceName("run-A", "feature/42");
  assert.equal(a, workspaceName("run-A", "feature/42"));
  assert.notEqual(a, workspaceName("run-B", "feature/42"));
  assert.notEqual(a, workspaceName("run-A", "feature/43"));
  for (const name of [a, workspaceName("x".repeat(80), "Y".repeat(80))]) {
    assert.match(name, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, name);
    assert.ok(name.length <= 63, name);
  }
});

test("lifecycle: place → provision → attach → body(input+handles) → body final → destroy; output = body output", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());

  const { runId } = await host.start("ws");
  await waitFor(() => host.gates(runId).length === 1); // body parked in its Sandbox

  const name = [...sandbox.provisioned.keys()][0]!;
  assert.deepEqual(sandbox.provisioned.get(name), { runId, workflow: "ws" });
  // The LIVE half of the Console's join (ADR-0049): the body is a named slot, so the running child
  // reports `src: "body"` — the same string `serializeMachine` records for it, and no longer
  // xstate's positional `xstate.invoke.<i>.<state>` key.
  assert.deepEqual(
    host.status(runId)!.children.map((c) => ({ id: c.id, src: c.src })),
    [{ id: "body", src: "body" }],
  );
  // Parking IS retention (ADR-0012): the body is holding its gate, the Sandbox must be alive.
  assert.ok(!sandbox.calls.some((c) => c.startsWith("destroy:")));
  // The lease stamps while the body holds its gate. Waited for, not assumed: the first renewal is
  // jittered (ADR-0021), so a loaded runner can reach the gate before it lands.
  await waitFor(() => renews(sandbox) > 0);

  host.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => host.status(runId) === undefined); // run settled + dropped from registry

  assert.deepEqual(lifecycle(sandbox), ["place", "provision", "attach", "destroy"]);
  const final = await host.read(runId);
  assert.equal(final?.status, "done");
  const ctx = final?.context as { output?: { status: string; app?: string } };
  assert.deepEqual(ctx.output, { status: "done", app: "/work/app" });
});

test("restore-reconcile: Sandbox CR gone → workspace.lost lands in the restored body's policy", async () => {
  const store = await mkStore();
  const sandbox = new FakeSandbox();
  const first = new RunHost({ store, sandbox });
  first.register(wsDef());
  const { runId } = await first.start("ws");
  await waitFor(() => first.gates(runId).length === 1);
  await first.stop(runId); // orchestrator "dies" mid-park; store keeps the live snapshot

  sandbox.present = false; // idle-timeout reaped the Sandbox while we were down
  const second = new RunHost({ store, sandbox });
  second.register(wsDef());
  const { reattached } = await second.restore();
  assert.deepEqual(reattached, [runId]);

  // The re-invoked probe found the CR absent → the body decided (its `lost` final state),
  // and the wrapper still tore down through its normal path (destroy is idempotent-absent).
  await waitFor(() => second.status(runId) === undefined);
  const final = await second.read(runId);
  assert.equal(final?.status, "done");
  assert.deepEqual((final?.context as { output?: unknown }).output, { status: "lost", reason: "Deleted" });
  assert.ok(sandbox.calls.filter((c) => c.startsWith("place:")).length === 1, "never silently re-provisioned");
});

test("restore-reconcile: Sandbox present → the body resumes parked, nothing is delivered", async () => {
  const store = await mkStore();
  const sandbox = new FakeSandbox();
  const first = new RunHost({ store, sandbox });
  first.register(wsDef());
  const { runId } = await first.start("ws");
  await waitFor(() => first.gates(runId).length === 1);
  await first.stop(runId);

  const second = new RunHost({ store, sandbox });
  second.register(wsDef());
  await second.restore();
  await waitFor(() => second.gates(runId).length === 1); // gate re-registered, still parked
  assert.equal(second.status(runId)?.status, "active");

  // Same Sandbox, same name: the probe and any re-run provision address ONE CR.
  const names = new Set(sandbox.calls.map((c) => c.split(":")[1]));
  assert.equal(names.size, 1);

  second.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => second.status(runId) === undefined);
  assert.equal((await second.read(runId))?.status, "done");
});

/** A body under a Workspace with no Repo Slot (ADR-0051): it parks on a gate, then answers with
 * the handles it was handed, so a test reads exactly what the wrapper gave it. */
const slotlessBody = jr2Setup({
  types: {} as { context: { handles: unknown }; input: Workspaced<{}, never> },
  events: [approveDef],
}).createMachine({
  id: "slotless",
  context: ({ input }) => ({ handles: input.workspace }),
  on: { "workspace.lost": ".lost" },
  initial: "working",
  states: {
    working: { invoke: { src: "gate", input: { gate: "hold", accepts: ["approve"] } }, on: { approve: "done" } },
    done: { type: "final", output: ({ context }) => ({ handles: context.handles }) },
    lost: { type: "final" },
  },
  output: ({ event }) => (event as { output?: unknown }).output,
});

test("no Repo Slot: place with no Repo, no attach, the body gets { repos: {} } and no branch (ADR-0051)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "job", machine: workspace(slotlessBody, {}), provide: () => ({}) });
  const { runId } = await host.start("job");
  await waitFor(() => host.gates(runId).length === 1);
  host.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);

  // The Harness's attach refuses an empty list, and `/work` needs nothing from it.
  assert.deepEqual(lifecycle(sandbox), ["place", "provision", "destroy"]);
  assert.deepEqual(sandbox.repos, [[]], "the Sandbox names no Repo, so no cache is mounted");
  const final = await host.read(runId);
  assert.equal(final?.status, "done");
  assert.deepEqual((final?.context as { output?: unknown }).output, { handles: { repos: {} } });
});

test("`workGroup` is a static option, with or without a Repo Slot, and a Workspace reads it (ADR-0075)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "job", machine: workspace(slotlessBody, { workGroup: 3000 }), provide: () => ({}) });
  const { runId } = await host.start("job");
  await waitFor(() => host.gates(runId).length === 1);
  assert.deepEqual(sandbox.composition, [{ user: undefined, workGroup: 3000 }]);
  await host.stop(runId);
});

test("`projectContext` is a static option that reaches the provision as the Machine states it (ADR-0062)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({
    name: "shared",
    machine: workspace(slotlessBody, { projectContext: "workspace" }),
    provide: () => ({}),
  });
  host.register({ name: "own", machine: workspace(slotlessBody, {}), provide: () => ({}) });
  for (const name of ["shared", "own"]) {
    const { runId } = await host.start(name);
    await waitFor(() => host.gates(runId).length === 1);
    await host.stop(runId);
  }
  // Absent stays absent: the port's default is "worktree".
  assert.deepEqual(sandbox.projectContexts, ["workspace", undefined]);
});

test("a `projectContext` that is not worktree or workspace is refused when the Machine is built", () => {
  for (const projectContext of ["user", "", 1, null] as never[]) {
    assert.throws(
      () => workspace(slotlessBody, { projectContext }),
      /workspace\(\): `projectContext` is "worktree" or "workspace" \(got .*\) \(ADR-0062\)/,
    );
  }
});

test("a `workGroup` that is not a gid is refused when the Machine is built, so it never costs a pod", () => {
  for (const workGroup of [2000.5, -1, "2000" as never]) {
    assert.throws(() => workspace(slotlessBody, { workGroup }), /workspace\(\): `workGroup` must be a gid/);
    assert.throws(() => workspace(body, { repos: { app: APP }, workGroup }), /`workGroup` must be a gid/);
  }
});

test("no Repo Slot: a restore resumes the parked body, and the handles still hold no branch", async () => {
  const store = await mkStore();
  const sandbox = new FakeSandbox();
  const job = () => ({ name: "job", machine: workspace(slotlessBody, {}), provide: () => ({}) });
  const first = new RunHost({ store, sandbox });
  first.register(job());
  const { runId } = await first.start("job");
  await waitFor(() => first.gates(runId).length === 1);
  await first.stop(runId);

  const second = new RunHost({ store, sandbox });
  second.register(job());
  await second.restore();
  await waitFor(() => second.gates(runId).length === 1);
  second.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => second.status(runId) === undefined);
  assert.deepEqual(lifecycle(sandbox), ["place", "provision", "destroy"], "placed once, never attached");
  assert.deepEqual(((await second.read(runId))?.context as { output?: unknown }).output, { handles: { repos: {} } });
});

test("no Repo Slot: customize() binds no slot onto it (ADR-0051)", () => {
  assert.throws(
    () => customize(workspace(slotlessBody, {}), { repos: { app: APP } } as never),
    /customize\(\): machine "workspace" declares no Repo Slot "app" — its slots are: /,
  );
  // A customize() that retunes the pod keeps it a Workspace with no slot.
  const [pod] = workspacePodsOf(customize(workspace(slotlessBody, {}), { resources: { limits: { memory: "4Gi" } } }));
  assert.equal(pod?.noSlot, true);
});

test("no Repo Slot: the walk says so, and an Open map is not 'no slot' (ADR-0051)", () => {
  const [none] = workspacePodsOf(workspace(slotlessBody, {}));
  assert.equal(none?.noSlot, true);
  assert.deepEqual(none?.bindings, {});
  const [some] = workspacePodsOf(wrapped);
  assert.equal(some?.noSlot, undefined);
  const openBody = jr2Setup({ types: {} as { input: Workspaced<{}, string> } }).createMachine({
    id: "enumerates",
    on: { "workspace.lost": ".done" },
    initial: "done",
    states: { done: { type: "final" } },
  });
  const [opened] = workspacePodsOf(workspace(openBody, { repos: open }));
  assert.equal(opened?.noSlot, undefined, "an Open map's slots are the composer's, and customize() names one");
  assert.ok(partsOf([workspace(slotlessBody, {})]).repos.length === 0, "no Repo to warm");
});

test("the Workspace reads no branch from the run input: a run with none clones, and its handle is the slot's folder (ADR-0075)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "clones", machine: workspace(body, { repos: { app: APP } }), provide: () => ({}) });
  const { runId } = await host.start("clones", { prompt: "fix it" }); // no branch
  await waitFor(() => host.gates(runId).length === 1);
  assert.deepEqual(lifecycle(sandbox).slice(0, 3), ["place", "provision", "attach"]);
  host.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.deepEqual((final?.context as { output?: unknown }).output, { status: "done", app: "/work/app" });
});

/** A parent that invokes a `workspace()` with a door, and passes it `passed`. With `catches`, its
 * `onError` keeps the error's message and ends the run. */
const doorParent = (passed: unknown, catches: boolean) =>
  jr2Setup({
    types: {} as { context: { why?: string } },
    actors: { child: workspace(slotlessBody, { input: z.object({ ticket: z.string() }) }) },
  }).createMachine({
    id: "door-parent",
    context: {},
    initial: "running",
    states: {
      running: {
        invoke: {
          src: "child",
          input: () => passed as { ticket: string },
          onDone: "done",
          ...(catches
            ? {
                onError: {
                  target: "caught",
                  actions: assign({ why: ({ event }) => (event.error as Error).message }),
                },
              }
            : {}),
        },
      },
      caught: { type: "final" },
      done: { type: "final" },
    },
    output: ({ context }) => ({ why: context.why }),
  });

test("a parent that passes less than a workspace()'s door requires fails the invoke before any pod, and its onError takes it (ADR-0033)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "parent", machine: doorParent({ nope: 1 }, true), provide: () => ({}) });
  const { runId } = await host.start("parent");
  await waitFor(() => host.status(runId) === undefined);

  const final = await host.read(runId);
  assert.equal(final?.status, "done", "the parent's onError took the failure");
  const { why } = final?.output as { why: string };
  assert.match(why, /^workspace input invalid, before any pod: /);
  assert.match(why, /ticket/, "the zod message names the field");
  assert.deepEqual(sandbox.calls, [], "a door value that is wrong costs no pod");
});

test("a parent with no onError ends `error` on a door value that is wrong, and no pod is spent (ADR-0033)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "parent", machine: doorParent({ nope: 1 }, false), provide: () => ({}) });
  const { runId } = await host.start("parent");
  await waitFor(() => host.status(runId) === undefined);

  const final = await host.read(runId);
  assert.equal(final?.status, "error");
  assert.match(final?.fault ?? "", /workspace input invalid, before any pod: /);
  assert.deepEqual(sandbox.calls, [], "a door value that is wrong costs no pod");
});

test("a parent that passes what the door requires places the Workspace", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "parent", machine: doorParent({ ticket: "T-1" }, true), provide: () => ({}) });
  const { runId } = await host.start("parent");
  await waitFor(() => host.gates(runId).length === 1);
  host.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);

  const final = await host.read(runId);
  assert.equal(final?.status, "done");
  assert.deepEqual(lifecycle(sandbox), ["place", "provision", "destroy"]);
  assert.deepEqual(final?.output, {}, "the onError never ran");
});

/** A body that parks on a gate, then answers with the input it was handed. */
const echoBody = jr2Setup({
  types: {} as { context: { seen: unknown }; input: Workspaced<{}, never> },
  events: [approveDef],
}).createMachine({
  id: "echo",
  context: ({ input }) => ({ seen: input }),
  on: { "workspace.lost": ".lost" },
  initial: "working",
  states: {
    working: { invoke: { src: "gate", input: { gate: "hold", accepts: ["approve"] } }, on: { approve: "done" } },
    done: { type: "final", output: ({ context }) => context.seen },
    lost: { type: "final" },
  },
  output: ({ event }) => (event as { output?: unknown }).output,
});

/** What the body of `machine` read when `host.start` gave it `input`. */
const bodyInput = async (machine: AnyStateMachine, input?: Record<string, unknown>) => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "job", machine, provide: () => ({}) });
  const { runId, instanceId } = await host.start("job", input);
  await waitFor(() => host.gates(runId).length === 1 || host.status(runId) === undefined);
  assert.equal(host.gates(runId).length, 1, (await host.read(runId))?.fault ?? "no Gate");
  host.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);
  const { workspace: _handles, ...seen } = (await host.read(runId))?.output as Record<string, unknown>;
  return { seen, instanceId };
};

/** A parent that invokes `child` and passes it `passed`. */
const parentOf = (child: AnyStateMachine, passed: Record<string, unknown>) =>
  jr2Setup({ actors: { child } }).createMachine({
    id: "door-parent",
    initial: "running",
    states: {
      running: { invoke: { src: "child", input: () => passed as never, onDone: { target: "done" } } },
      done: { type: "final", output: ({ event }) => (event as { output?: unknown }).output },
    },
    output: ({ event }) => (event as { output?: unknown }).output,
  });

test("a root run's strict door refuses no key the host added: the door is parsed once, by RunHost (ADR-0033)", async () => {
  const root = workspace(echoBody, { input: z.strictObject({ ticket: z.string() }) });
  const { seen, instanceId } = await bodyInput(root, { ticket: "T-1" });
  assert.deepEqual(seen, { ticket: "T-1", instanceId });
});

test("a root run's door transforms a value once, so a transform that takes the raw value still runs (ADR-0033)", async () => {
  const root = workspace(echoBody, { input: z.object({ n: z.string().transform((s) => s.split(",")) }) });
  const { seen, instanceId } = await bodyInput(root, { n: "a,b" });
  assert.deepEqual(seen, { n: ["a", "b"], instanceId });
});

test("under a parent the body gets the door's parsed shape: a default applied, an unknown key stripped (ADR-0033)", async () => {
  const child = workspace(echoBody, { input: z.object({ workers: z.number().default(2) }) });
  const { seen } = await bodyInput(parentOf(child, { extra: "unknown key" }));
  assert.deepEqual(seen, { workers: 2 });
});

test("under a parent `instanceId` stays out of the door's parse, and the body gets it if the parent gave it", async () => {
  const child = workspace(echoBody, { input: z.strictObject({ ticket: z.string() }) });
  const { seen } = await bodyInput(parentOf(child, { ticket: "T-1", instanceId: "given" }));
  assert.deepEqual(seen, { ticket: "T-1", instanceId: "given" });
});

test("the image is a STATIC option read off the Machine at invoke time", async () => {
  // ADR-0049: what the Sandbox is MADE OF rides the wrapper, because `jr2 up` must find it by
  // WALKING the Machine. Resolution to a ref is still the port's, so the Machine stays cluster-agnostic and no
  // content-addressed tag ever lands in a snapshot.
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const named = workspace(body, {
    image: "file:///srv/pkg/image",
    repos: { app: APP },
  });
  host.register({ name: "named", machine: named, provide: () => ({}) });

  const { runId } = await host.start("named");
  await waitFor(() => host.gates(runId).length === 1);
  assert.deepEqual(sandbox.images, ["file:///srv/pkg/image"]);
  // It is read off the WRAPPER, so the host's per-run `provide()` clone still finds it — the
  // attachment is keyed on `machine.config`, which `.provide()` passes through unchanged.
  assert.ok(
    !JSON.stringify((await host.read(runId))?.context ?? {}).includes("file:///srv/pkg/image"),
    "and it is nowhere in the persisted context: a restore re-reads what the Machine carries NOW",
  );

  // The request carries what the wrapper carries, and this wrapper carries none.
  const unnamed = workspace(body, { repos: { app: APP } });
  host.register({ name: "unnamed", machine: unnamed, provide: () => ({}) });
  const second = await host.start("unnamed");
  await waitFor(() => host.gates(second.runId).length === 1);
  assert.deepEqual(sandbox.images, ["file:///srv/pkg/image", undefined]);
});

test("pod composition: `user` and `workGroup` are static options too", async () => {
  // ADR-0005/0037/0049: the User Container's image rides the same rule as the Sandbox Image's —
  // two origins, one resolution, static so the converge can build it (ADR-0075).
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const composed = workspace(body, {
    image: "ghcr.io/acme/toolchain:2024-11",
    user: "ghcr.io/acme/sshd:1",
    repos: { app: APP },
    workGroup: 4000,
  });
  host.register({ name: "composed", machine: composed, provide: () => ({}) });
  const { runId } = await host.start("composed");
  await waitFor(() => host.gates(runId).length === 1);
  assert.deepEqual(sandbox.images, ["ghcr.io/acme/toolchain:2024-11"]);
  assert.deepEqual(sandbox.composition, [{ user: "ghcr.io/acme/sshd:1", workGroup: 4000 }]);
});

test("a terminal fault after placing leaves the pod inspectable, and its lease stops (idle GC reaps it)", async () => {
  const sandbox = new FakeSandbox();
  sandbox.attach = async () => {
    throw new Error("attach exploded");
  };
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());

  const { runId } = await host.start("ws");
  await waitFor(() => host.status(runId) === undefined);

  assert.equal((await host.read(runId))?.status, "error");
  // Placed, then faulted: no destroy (the pod stays inspectable — ADR-0012, ADR-0064). Nothing
  // releases anything: the lease is one of the run's actors, so it stopped with them, and the
  // operator's idle GC reaps the CR one idle timeout after its last renewal.
  assert.ok(sandbox.calls.some((c) => c.startsWith("place:")));
  assert.ok(!sandbox.calls.some((c) => c.startsWith("destroy:")));
  const settled = renews(sandbox);
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));
  assert.equal(renews(sandbox), settled, "no renewal after the fault");
});

test("the lease stops with the run — no process-global timer outlives the actor", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());

  const { runId } = await host.start("ws");
  await waitFor(() => host.gates(runId).length === 1);
  await waitFor(() => renews(sandbox) > 0);

  assert.equal(sandbox.listening, 1, "the lease listens to the watch for its Sandbox");
  await host.stop(runId);
  const settled = renews(sandbox);
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));

  assert.equal(renews(sandbox), settled, "stopping the run stopped its lease");
  assert.equal(sandbox.listening, 0, "…and its subscription");
});

test("live reap: the Sandbox goes while the run is UP → workspace.lost, no restart needed", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());

  const { runId } = await host.start("ws");
  await waitFor(() => host.gates(runId).length === 1); // parked on its gate, hours could pass

  sandbox.present = false; // `kubectl delete sandbox`, a lapsed lease, a cleared namespace

  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(final?.status, "done"); // settled through the body's own policy, not a fault
  assert.deepEqual((final?.context as { output?: unknown }).output, { status: "lost", reason: "Deleted" });
  assert.ok(
    sandbox.calls.some((c) => c.startsWith("destroy:")),
    "tore down through the normal path",
  );
});

test("a workspace.lost the body takes no transition for faults the run `error`, and its Sandbox stays (ADR-0074)", async () => {
  // The walk reads a route; it cannot read its guard. This one is false when the loss comes.
  const guarded = jr2Setup({ events: [approveDef] }).createMachine({
    id: "guarded-body",
    on: { "workspace.lost": { guard: () => false, target: ".lost" } },
    initial: "working",
    states: {
      working: { invoke: { src: "gate", input: { gate: "hold", accepts: ["approve"] } }, on: { approve: "done" } },
      done: { type: "final" },
      lost: { type: "final" },
    },
  });
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({
    name: "guarded",
    machine: workspace(guarded, { repos: { app: { url: APP, ref: "main" } } }),
    provide: () => ({}),
  });
  const { runId } = await host.start("guarded");
  await waitFor(() => host.gates(runId).length === 1);

  sandbox.present = false;

  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(final?.status, "error");
  assert.match(
    final?.fault ?? "",
    /^machine "guarded-body" got "workspace\.lost" in state "working", and no transition took it \(Deleted\)/,
    "the body's microstep, not the wrapper's: the wrapper always takes its own forwarding transition",
  );
  assert.ok(!sandbox.calls.some((c) => c.startsWith("destroy:")), "a fault keeps its Sandbox as evidence");
});

test("live Lost: same CR, its one pod ended → workspace.lost carrying the pod's reason (ADR-0021)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());

  const { runId } = await host.start("ws");
  await waitFor(() => host.gates(runId).length === 1);

  // Eviction or node loss: the CR is present and the endpoint still resolves — but the pod that
  // held `work` ended, and the operator never gives the Sandbox another (ADR-0021). Presence alone
  // cannot see this; the operator's Lost verdict can.
  sandbox.lost = { reason: "Evicted", message: "The node was low on resource: memory." };

  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.deepEqual((final?.context as { output?: unknown }).output, { status: "lost", reason: "Evicted" });
  assert.equal(
    sandbox.calls.filter((c) => c.startsWith("place:")).length,
    1,
    "never silently re-provisioned into an inconsistent world",
  );
});

test("renewal is a write only: it never reads continuity, and loss arrives from the watch at once", async () => {
  // ADR-0021/0063: the watch answers, the lease asserts. A lease interval of an HOUR proves the
  // loss below cannot have come from a renewal.
  const sandbox = new FakeSandbox();
  sandbox.leaseIntervalMs = 60 * 60_000;
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());
  const { runId } = await host.start("ws");
  await waitFor(() => host.gates(runId).length === 1);
  sandbox.lost = { reason: "NodeLost", message: "the node is gone" };
  await waitFor(() => host.status(runId) === undefined);
  assert.deepEqual(((await host.read(runId))?.context as { output?: unknown }).output, {
    status: "lost",
    reason: "NodeLost",
  });
});

test("renewals land at the interval ±20%, the first within a fifth of it (ADR-0021)", () => {
  // At the extremes of the draw: never in lockstep, never outside the band.
  assert.equal(Math.round(leaseDelay(1_000, "first", 0)), 0);
  assert.equal(Math.round(leaseDelay(1_000, "first", 1)), 200);
  assert.equal(Math.round(leaseDelay(1_000, "next", 0)), 800);
  assert.equal(Math.round(leaseDelay(1_000, "next", 0.5)), 1_000);
  assert.equal(Math.round(leaseDelay(1_000, "next", 1)), 1_200);
});

test("a failing renew is UNKNOWN, never lost — an API blip must not settle a live run", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());

  const { runId } = await host.start("ws");
  await waitFor(() => host.gates(runId).length === 1);

  sandbox.failRenew = true;
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 8));

  assert.equal(host.status(runId)?.status, "active", "still parked — loss is never fabricated");
  assert.equal(host.gates(runId).length, 1);

  sandbox.failRenew = false; // and it recovers without intervention
  host.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);
  assert.equal((await host.read(runId))?.status, "done");
});

test("a host without a Sandbox backend faults a workspace() run pointedly", async () => {
  const host = new RunHost({ store: await mkStore() }); // no sandbox option
  host.register(wsDef());
  const { runId } = await host.start("ws");
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(final?.status, "error");
  assert.match(final?.fault ?? "", /no Sandbox backend/);
  // The named cause and fix must exist: a Workspace is always a real Sandbox (ADR-0012), the
  // switch is "deployed in a cluster" (server.ts), and the converging command is `jr2 up`.
  assert.match(final?.fault ?? "", /JR2_NAMESPACE unset/);
  assert.match(final?.fault ?? "", /`jr2 up`/);
  assert.doesNotMatch(final?.fault ?? "", /jr2\.config\.ts/, "config declares no Repos any more (ADR-0051)");
});

test("ambient resolution (ADR-0016): an Agent inside a workspace finds endpoint + sandbox itself", async () => {
  // The body invokes its Agent with NO endpoint and NO sandbox: both must resolve from the
  // enclosing wrapper via the parent chain — and the registration must record the wrapper's
  // Sandbox (the ADR-0013 token scope) with zero workflow plumbing.
  const endpoints: string[] = [];
  const client = new MockFlueClient();
  const ambientBody = jr2Setup({
    types: {} as { context: Record<string, never>; input: Workspaced<{}, "app"> },
    events: [approveDef],
    actors: {
      coder: agentActorWith(
        (endpoint: string) => {
          endpoints.push(endpoint);
          return client;
        },
        { model: "test/model", instructions: "i" },
      ),
    },
  }).createMachine({
    on: { "workspace.lost": {}, "agent.fault": {} },
    id: "ambient",
    context: {},
    initial: "coding",
    states: {
      coding: {
        invoke: { src: "coder", input: { prompt: "go", cwd: "/work/app/fix" } },
        on: { approve: "done" },
      },
      done: { type: "final" },
    },
  });
  const wrappedAmbient = workspace(ambientBody, { repos: { app: APP } });

  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "amb", machine: wrappedAmbient, provide: () => ({}) });
  const { runId } = await host.start("amb");

  await waitFor(() => endpoints.length === 1);
  assert.deepEqual(endpoints, ["http://sandbox.test"], "the wrapper's endpoint, never threaded by the workflow");

  // jr2 minted the iid (ADR-0057); the admission is where a reader learns it.
  const surface = host.agentSurface(client.admits[0]!.instanceId);
  const crName = [...sandbox.provisioned.keys()][0]!;
  assert.equal(surface?.sandbox, crName, "the registration records the ENCLOSING wrapper's Sandbox (ADR-0013)");
  assert.ok(host.status(runId), "run parked on the mock agent, alive");
});

// --- Repo Slots (ADR-0051) ----------------------------------------------------------------------

/** A body that records the handles it was given and finishes — the geography is the claim. */
const recorder = jr2Setup({
  types: {} as {
    context: { handles?: { repos: Record<string, string> } };
    input: { workspace: { repos: Record<string, string> } };
  },
  events: [],
}).createMachine({
  id: "recorder",
  context: ({ input }) => ({ handles: input.workspace }),
  initial: "done",
  states: { done: { type: "final", output: ({ context }) => context.handles } },
  output: ({ event }) => (event as { output?: unknown }).output,
});

test("a provision reads the pod key jr2 up writes, at every route an author can write; an inline workspace() is refused (ADR-0059, ADR-0049)", async () => {
  // `jr2 up` keys each Workspace's held manifest by the walk's route; the provision keys its read by
  // the route off the live actor (`actorRoute`). A Workspace, like every Part, is a key of `actors`,
  // and the build refuses the inline form with the slot form; a plain Machine invoked inline above
  // it is a hop of its own — xstate's generated src, which the walk computes from the state node.
  const ws = workspace(recorder, { repos: { app: APP } });
  // A plain Machine that holds no Workspace and never finishes: it fills an invoke index.
  const idle = jr2Setup({ events: [] }).createMachine({ id: "idle", initial: "w", states: { w: {} } });
  const invoking = (id: string, src: unknown, actors: Record<string, unknown> = {}) =>
    jr2Setup({ events: [], actors: actors as never }).createMachine({
      id,
      initial: "x",
      states: { x: { invoke: { src, onDone: "done" } as never }, done: { type: "final" } },
    });
  assert.throws(
    () => invoking("inline", ws),
    /machine "inline": state "inline\.x" invokes a Workspace inline — a Part is a key of actors.*actors: \{ <name>: workspace\(\.\.\.\) \}, then invoke: \{ src: "<name>" \}/,
  );
  const named = invoking("named", "review", { review: ws });
  const shapes: Record<string, unknown> = {
    root: ws,
    named,
    nested: invoking("nested", "outer", { outer: named }),
    inline: invoking("inline-above", named),
    "inline-twice": invoking("twice", invoking("inner", named)),
    // The <index> of the hop is the invoke's place in its state's list, and the <state id> is the
    // node's id: an explicit `id:` where the author wrote one, the dotted path where not.
    "inline-second": jr2Setup({ events: [], actors: { idle } }).createMachine({
      id: "second",
      initial: "x",
      states: { x: { invoke: [{ src: "idle" }, { src: named, onDone: "done" } as never] }, done: { type: "final" } },
    }),
    "inline-state-id": jr2Setup({ events: [] }).createMachine({
      id: "explicit",
      initial: "x",
      states: { x: { id: "placing", invoke: { src: named, onDone: "done" } as never }, done: { type: "final" } },
    }),
    "inline-deep": jr2Setup({ events: [], actors: { idle } }).createMachine({
      id: "deep",
      initial: "a",
      states: {
        a: {
          initial: "b",
          states: { b: { invoke: [{ src: "idle" }, { src: idle }, { src: named, onDone: "#deep.done" } as never] } },
        },
        done: { type: "final" },
      },
    }),
  };
  const routes: Record<string, unknown[]> = {
    root: [],
    named: ["review"],
    nested: ["outer", "review"],
    inline: [{ inline: "xstate.invoke.0.inline-above.x" }, "review"],
    "inline-twice": [{ inline: "xstate.invoke.0.twice.x" }, { inline: "xstate.invoke.0.inner.x" }, "review"],
    "inline-second": [{ inline: "xstate.invoke.1.second.x" }, "review"],
    "inline-state-id": [{ inline: "xstate.invoke.0.placing" }, "review"],
    "inline-deep": [{ inline: "xstate.invoke.2.deep.a.b" }, "review"],
  };
  for (const [workflow, machine] of Object.entries(shapes)) {
    const sandbox = new FakeSandbox();
    const host = new RunHost({ store: await mkStore(), sandbox });
    host.register({ name: workflow, machine: machine as never, provide: () => ({}) });
    await host.start(workflow);
    await waitFor(() => sandbox.routes.length === 1);
    const walked = workspacePodsOf(machine as never);
    assert.equal(walked.length, 1, workflow);
    assert.deepEqual(walked[0]!.route, routes[workflow], `${workflow}: the walk's route`);
    assert.deepEqual(sandbox.routes[0], walked[0]!.route, `${workflow}: the live route is the walk's`);
    assert.equal(
      workspaceHeldPod({ workflow, route: sandbox.routes[0]! }),
      workspaceHeldPod({ workflow, route: walked[0]!.route }),
      `${workflow}: one pod key`,
    );
  }
  // A pod key reached by slot keys alone is what it was before routes went on past an inline hop.
  assert.equal(
    workspaceHeldPod({ workflow: "nested", route: ["outer", "review"] }),
    `ws-${createHash("sha256")
      .update(JSON.stringify(["nested", ["outer", "review"]]))
      .digest("hex")
      .slice(0, 16)}`,
  );
});

test("two plain Machines invoked inline in one state place two Workspaces, each with a pod key of its own (ADR-0059)", async () => {
  // The invoke index is the half of the inline hop that tells them apart: the same Machine object
  // at index 0 and index 1 of one state is two placements, two routes, two pods.
  const ws = workspace(recorder, { repos: { app: APP } });
  const named = jr2Setup({ events: [], actors: { review: ws } }).createMachine({
    id: "named",
    initial: "x",
    states: { x: { invoke: { src: "review", onDone: "done" } }, done: { type: "final" } },
  });
  const both = jr2Setup({ events: [] }).createMachine({
    id: "both",
    initial: "x",
    states: { x: { invoke: [{ src: named }, { src: named }] as never } },
  });
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "both", machine: both as never, provide: () => ({}) });
  await host.start("both");
  await waitFor(() => sandbox.routes.length === 2);
  const walked = workspacePodsOf(both as never).map((pod) => pod.route);
  assert.deepEqual(walked, [
    [{ inline: "xstate.invoke.0.both.x" }, "review"],
    [{ inline: "xstate.invoke.1.both.x" }, "review"],
  ]);
  const key = (route: PlacementRoute) => workspaceHeldPod({ workflow: "both", route });
  assert.deepEqual(new Set(sandbox.routes.map(key)), new Set(walked.map(key)), "the live routes are the walk's");
  assert.notEqual(key(walked[0]!), key(walked[1]!), "two pod keys");
});

test("a Workspace reached through a Machine handed to spawnChild as an object fails at provision with the slot form (ADR-0059)", async () => {
  // No walk can see it, so jr2 up placed nothing for it: its provision names the fix, never a pod.
  const ws = workspace(recorder, { repos: { app: APP } });
  const holder = jr2Setup({ events: [], actors: { review: ws } }).createMachine({
    id: "holder",
    initial: "x",
    states: { x: { invoke: { src: "review", onDone: "done" } }, done: { type: "final" } },
  });
  const root = jr2Setup({ events: [] }).createMachine({
    id: "spawner",
    entry: spawnChild(holder as never),
    initial: "waiting",
    states: { waiting: {} },
  });
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "spawner", machine: root as never, provide: () => ({}) });
  const { runId } = await host.start("spawner");
  await waitFor(() => host.status(runId) === undefined);
  assert.match(
    (await host.read(runId))?.fault ?? "",
    /spawned from a logic object, which no walk can see.*spawnChild\("<name>"\)/,
  );
  assert.deepEqual(sandbox.routes, [], "nothing was provisioned");
});

test("slots resolve in declaration order; the handles are keyed by slot, in that order, and name no workdir", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const two = workspace(recorder, {
    repos: { docs: { url: "https://example.test/handbook.git", ref: "v3" }, app: APP },
  });
  host.register({ name: "two", machine: two, provide: () => ({}) });
  const { runId } = await host.start("two");
  await waitFor(() => host.status(runId) === undefined);

  // The port is handed every slot, resolved, in the order the Machine declared them — and told
  // which ones the RUN chose (none here): that flag is what the credentials fence keys on.
  assert.deepEqual(sandbox.repos, [
    [
      { slot: "docs", url: "https://example.test/handbook.git", ref: "v3", perRun: false },
      { slot: "app", url: APP, perRun: false },
    ],
  ]);
  assert.deepEqual(sandbox.attached, [
    [
      { slot: "docs", url: "https://example.test/handbook.git", ref: "v3" },
      { slot: "app", url: APP },
    ],
  ]);
  const out = (await host.read(runId))?.context as { output?: Record<string, unknown> };
  // The kit gives no slot a privileged meaning (ADR-0051): the handles are the map of folders.
  // What it does promise is the ORDER — a Machine may read a meaning into it (`task` does).
  assert.deepEqual(Object.keys(out.output ?? {}).sort(), ["repos"]);
  assert.deepEqual(out.output?.repos, { docs: "/work/docs", app: "/work/app" });
  assert.deepEqual(
    Object.keys(out.output?.repos as object),
    ["docs", "app"],
    "declaration order, not alphabetical — through the persisted snapshot too",
  );
});

test("a Turn that frames no cwd under Repo Slots: a literal input is refused at build, a mapper's at its first Turn (ADR-0057, ADR-0075)", async () => {
  // A Workspace that only clones has no Worktree for a default to name. The walk reads a literal
  // input; only the start can read a mapper's answer, so the refusal there is explicit at the FIRST
  // Turn, and it is asserted against a real Machine, because the WORKSPACE's slots decide.
  const client = new MockFlueClient();
  const unframed = (input: unknown) =>
    jr2Setup({
      types: {} as { context: Record<string, never>; input: { workspace: { repos: Record<string, string> } } },
      events: [],
      actors: { coder: agentActorWith(() => client, { model: "test/model", instructions: "i" }) },
    }).createMachine({
      on: { "workspace.lost": {}, "agent.fault": {} },
      id: "unframed",
      context: {},
      initial: "coding",
      // The Frame is a prompt and nothing else.
      states: { coding: { invoke: { src: "coder", input: input as never } } },
    });
  const repos = { docs: { url: "https://example.test/handbook.git", ref: "v3" }, app: APP };

  assert.throws(
    () => workspace(unframed({ prompt: "go" }), { repos }),
    /workspace\(\): state "unframed\.coding": "coder" names no `cwd`, and a Workspace with Repo Slots says where/,
  );

  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({
    name: "twoSlots",
    machine: workspace(
      unframed(() => ({ prompt: "go" })),
      { repos },
    ),
    provide: () => ({}),
  });
  const { runId } = await host.start("twoSlots");
  await waitFor(() => host.status(runId) === undefined);

  const fault = (await host.read(runId))?.fault ?? "";
  assert.equal((await host.read(runId))?.status, "error");
  // The slots in DECLARATION order, which is the order the composer wrote and the only order that
  // helps them pick (ADR-0051) — and the line that ends it.
  assert.match(fault, /agent "coder" works under a Workspace with Repo Slots \(docs, app\)/);
  assert.match(fault, /say where it works, a Worktree, or `cwd: "\/work"` above them/);
  assert.deepEqual(client.admits, [], "refused BEFORE admission — no Turn, so no model was spent");
});

test("a per-run slot's mapper is called with the run input, validated, and flagged for the fence", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const perRun = workspace(recorder, {
    repos: {
      target: ({ input }: { input: { repo: string; base?: string } }) => ({ url: input.repo, ref: input.base }),
      docs: APP,
    },
  });
  host.register({ name: "perRun", machine: perRun, provide: () => ({}) });
  const { runId } = await host.start("perRun", { repo: "git@github.com:acme/app.git" });
  await waitFor(() => host.status(runId) === undefined);
  assert.deepEqual(sandbox.repos, [
    [
      { slot: "target", url: "git@github.com:acme/app.git", ref: undefined, perRun: true },
      { slot: "docs", url: APP, perRun: false },
    ],
  ]);

  // A mapper that derives nothing (the input never carried the field) faults BEFORE the port,
  // pointing at `jr2 run --input`.
  const bad = new FakeSandbox();
  const host2 = new RunHost({ store: await mkStore(), sandbox: bad });
  host2.register({ name: "perRun", machine: perRun, provide: () => ({}) });
  const run2 = await host2.start("perRun", { prompt: "fix it" });
  await waitFor(() => host2.status(run2.runId) === undefined);
  const final = await host2.read(run2.runId);
  assert.equal(final?.status, "error");
  assert.match(final?.fault ?? "", /workspace invalid: repos\.target mapper returned url \(got undefined\)/);
  assert.match(final?.fault ?? "", /run input/);
  assert.deepEqual(bad.calls, [], "a bad binding never costs a pod");
});

test("an OPEN slot nobody bound faults before the port, naming the customize line that binds it", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const packaged = workspace(recorder, { repos: { target: open } });
  host.register({ name: "packaged", machine: packaged, provide: () => ({}) });
  const { runId } = await host.start("packaged");
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(final?.status, "error");
  // Named as `jr2 up`'s walk names it: the Workflow, the slot, and a line that pastes — never the
  // wrapper's xstate id, which every `workspace()` shares.
  assert.match(final?.fault ?? "", /workflow "packaged": Repo Slot "target" is open — nobody bound it/);
  assert.match(final?.fault ?? "", /export const machine = customize\(<import>, \{ repos: \{ target: "<url>" \} \}\)/);
  assert.match(final?.fault ?? "", /ADR-0051/);
  assert.deepEqual(sandbox.calls, [], "an open slot never costs a pod");

  // Composed under a child slot, the line nests through `actors` — read off the live actor tree,
  // the same route the static walk reports (`actorSlotPath` is `partsOf`'s runtime twin).
  const nested = jr2Setup({ events: [], actors: { review: packaged } }).createMachine({
    id: "host",
    initial: "reviewing",
    states: { reviewing: { invoke: { src: "review" } } },
  });
  const host3 = new RunHost({ store: await mkStore(), sandbox: new FakeSandbox() });
  host3.register({ name: "top", machine: nested, provide: () => ({}) });
  const run3 = await host3.start("top");
  await waitFor(() => host3.status(run3.runId) === undefined);
  const fault3 = (await host3.read(run3.runId))?.fault ?? "";
  assert.match(fault3, /workflow "top": Repo Slot "target" is open/);
  assert.match(fault3, /customize\(<import>, \{ actors: \{ review: \{ repos: \{ target: "<url>" \} \} \} \}\)/);

  // A map declared Open whole faults the same way, with no slot to name: the line leaves `<slot>`
  // to the composer, whose word it is (ADR-0051).
  const host4 = new RunHost({ store: await mkStore(), sandbox: new FakeSandbox() });
  host4.register({
    name: "mapped",
    machine: workspace(recorder, { repos: open }),
    provide: () => ({}),
  });
  const run4 = await host4.start("mapped");
  await waitFor(() => host4.status(run4.runId) === undefined);
  const fault4 = (await host4.read(run4.runId))?.fault ?? "";
  assert.match(fault4, /workflow "mapped": Repo Slots are open — nobody named any/);
  assert.match(fault4, /customize\(<import>, \{ repos: \{ <slot>: "<url>" \} \}\)/);

  // Bound by the consumer, the SAME Machine runs: the binding is read off the Machine the run
  // was invoked as, exactly like the image (ADR-0049).
  const bound = new FakeSandbox();
  const host2 = new RunHost({ store: await mkStore(), sandbox: bound });
  host2.register({ name: "bound", machine: customize(packaged, { repos: { target: APP } }), provide: () => ({}) });
  const run2 = await host2.start("bound");
  await waitFor(() => host2.status(run2.runId) === undefined);
  assert.deepEqual(bound.repos, [[{ slot: "target", url: APP, perRun: false }]]);
});

test("restore into `attaching` reuses the PERSISTED bindings — a per-run mapper is not re-run", async () => {
  // The resolved bindings are this run's fact (ADR-0051): a restart between provision and attach
  // must attach exactly what was provisioned, never re-derive it from an input re-parsed later.
  const store = await mkStore();
  const sandbox = new FakeSandbox();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const firstAttach = sandbox.attach.bind(sandbox);
  let parked = 0;
  sandbox.attach = async (req) => {
    parked++;
    await held; // park the first process in `attaching`
    return firstAttach(req);
  };
  const first = new RunHost({ store, sandbox });
  const perRun = workspace(body, {
    repos: { target: ({ input }: { input: { repo: string } }) => input.repo },
  });
  first.register({ name: "perRun", machine: perRun, provide: () => ({}) });
  const { runId } = await first.start("perRun", { repo: APP });
  await waitFor(() => parked === 1);
  await first.stop(runId); // the orchestrator dies mid-attach; the snapshot holds the bindings
  release();

  sandbox.attach = firstAttach;
  const second = new RunHost({ store, sandbox });
  second.register({ name: "perRun", machine: perRun, provide: () => ({}) });
  await second.restore();
  await waitFor(() => second.gates(runId).length === 1);
  assert.equal(sandbox.repos.length, 1, "provisioned once — the restore re-entered `attaching`, not `provisioning`");
  assert.deepEqual(sandbox.attached.at(-1), [{ slot: "target", url: APP }]);
  await second.stop(runId);
});

test("workspace() refuses an empty or malformed `repos` at build time, by slot", () => {
  // Left out is a Workspace with no Repo Slot; written empty is refused, so "none" has one spelling.
  assert.throws(
    () => workspace(body as never, { repos: {} } as never),
    /`repos: \{\}` names no Repo Slot — leave `repos` out/,
  );
  assert.throws(() => workspace(body as never, { repos: [] } as never), /`repos` must be a map of Repo Slots/);
  assert.throws(() => workspace(body as never, { repos: "app" } as never), /`repos` must be a map of Repo Slots/);
  assert.throws(() => workspace(body, { repos: { app: "" } }), /Repo Slot "app" is bound to an empty url/);
  assert.throws(() => workspace(body, { repos: { app: { url: APP, ref: "" } } }), /"app" is bound with an empty ref/);
  assert.throws(() => workspace(body, { repos: { app: 42 as never } }), /"app" is not a binding/);
  // A url that names no Repo — a relative path has no identity to key a cache by.
  assert.throws(
    () => workspace(body, { repos: { app: "../infra" } }),
    /"app" binds "\.\.\/infra", which names no Repo/,
  );
  // A slot key becomes `/work/<slot>`, so it is held to what a path segment can carry.
  assert.throws(() => workspace(body, { repos: { "../x": APP } }), /Repo Slot key "\.\.\/x" is not a directory name/);
  assert.throws(() => workspace(body, { repos: { "a b": APP } }), /"a b" is not a directory name/);
  // An integer-like key would be read FIRST by `Object.keys` wherever it was declared — and the
  // handles promise declaration order, which a Machine may read — so a key starts with a letter.
  assert.throws(() => workspace(body, { repos: { app: APP, "1": APP } }), /key "1" is not a directory name/);
  assert.throws(() => workspace(body, { repos: { "2024": APP } }), /key "2024" is not a directory name/);
  assert.throws(() => workspace(body, { repos: { "0app": APP } }), /key "0app" is not a directory name/);
});

test("workspace() keeps the Repo Slots in declaration order — the order the handles promise", () => {
  const w = workspace(body, { repos: { app: APP, infra: APP, "v2.x": APP } });
  assert.deepEqual(Object.keys(sandboxPartsOf(w).repos), ["app", "infra", "v2.x"]);
});

test("the Size is a static option: the port gets it as stated, and the User Container's split beside it (ADR-0060)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const sized = workspace(body, {
    user: { image: "ghcr.io/acme/sshd:1", resources: { limits: { memory: "256Mi" } } },
    resources: { limits: { memory: "3Gi", cpu: "2" } },
    repos: { app: APP },
  });
  host.register({ name: "sized", machine: sized, provide: () => ({}) });
  const { runId } = await host.start("sized");
  await waitFor(() => host.gates(runId).length === 1);
  // The object form of `user` reaches the port as its two halves: the image where it always went,
  // the split beside the Size. The port resolves the rest of the chain.
  assert.deepEqual(sandbox.composition, [{ user: "ghcr.io/acme/sshd:1", workGroup: undefined }]);
  assert.deepEqual(sandbox.sizes, [
    { resources: { limits: { memory: "3Gi", cpu: "2" } }, userResources: { limits: { memory: "256Mi" } } },
  ]);

  // A Workspace that states none hands the port nothing: the Instance default and the kit's are
  // the port's to apply, never baked into the Machine.
  const bare = new FakeSandbox();
  const host2 = new RunHost({ store: await mkStore(), sandbox: bare });
  host2.register({
    name: "bare",
    machine: workspace(body, { repos: { app: APP } }),
    provide: () => ({}),
  });
  const second = await host2.start("bare");
  await waitFor(() => host2.gates(second.runId).length === 1);
  assert.deepEqual(bare.sizes, [{}]);
});

test("workspace() refuses requests, and any key beside limits.memory/limits.cpu, by field (ADR-0060)", () => {
  assert.throws(
    () =>
      workspace(body, {
        repos: { app: APP },
        resources: { limits: { memory: "3Gi" }, requests: { memory: "1Gi" } } as never,
      }),
    /workspace\(\): resources\.requests is not accepted/,
  );
  assert.throws(
    () => workspace(body, { repos: { app: APP }, resources: { limits: { gpu: "1" } } as never }),
    /workspace\(\): resources\.limits\.gpu is not accepted/,
  );
  assert.throws(
    () =>
      workspace(body, {
        repos: { app: APP },
        user: { image: "x", resources: { requests: { cpu: "1" } } } as never,
      }),
    /workspace\(\) user\.resources\.requests is not accepted/,
  );
});

// --- placing (ADR-0064) -------------------------------------------------------------------------

/** Every placing line a run's feed carries, in order. */
function placingLines(host: RunHost, runId: string): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  host.subscribe(runId, (ev) => {
    if (ev.kind === "placing" || ev.kind === "placed") lines.push(ev);
  });
  return lines;
}

const NODE = { on: "node" as const, message: "0/3 nodes are available: 3 Insufficient memory." };
const QUOTA = { on: "quota" as const, message: "exceeded quota: jr2, requested: requests.cpu=500m" };

test("placing: the wait has no deadline, its reason rides RunStatus.waiting, and the feed says it twice", async () => {
  const sandbox = new FakeSandbox();
  sandbox.holdPlacing = true;
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());
  const { runId } = await host.start("ws");
  const lines = placingLines(host, runId);
  await waitFor(() => sandbox.waiting === 1);
  assert.equal(host.status(runId)?.value, "placing");
  // A pod the scheduler has not explained yet is no wait worth a line.
  assert.deepEqual(host.status(runId)?.waiting, []);

  sandbox.waitFor(NODE);
  await waitFor(() => host.status(runId)!.waiting.length === 1);
  const [first] = host.status(runId)!.waiting;
  assert.deepEqual({ ...first, since: undefined }, { child: "", ...NODE, since: undefined });
  assert.ok(!Number.isNaN(Date.parse(first!.since)));

  // A changed reason updates the status and adds no line; `since` is when the wait began.
  sandbox.waitFor(QUOTA);
  await waitFor(() => host.status(runId)!.waiting[0]?.on === "quota");
  assert.deepEqual(host.status(runId)!.waiting, [{ child: "", ...QUOTA, since: first!.since }]);
  assert.deepEqual(lines.slice(), [{ kind: "placing", child: "", ...NODE, since: first!.since }]);
  // Behind the token: the open band sees `placing` lit, never the scheduler's words.
  const open = observe(host.status(runId)!);
  assert.equal("waiting" in open, false);
  assert.doesNotMatch(JSON.stringify(open), /Insufficient|quota/);

  // The lease renews while it waits (ADR-0064): the idle GC must never take it for abandoned.
  const before = renews(sandbox);
  await waitFor(() => renews(sandbox) > before);

  sandbox.schedule();
  await waitFor(() => host.gates(runId).length === 1);
  assert.deepEqual(host.status(runId)!.waiting, []);
  assert.equal(lines.length, 2);
  assert.equal(lines[1]!.kind, "placed");
  assert.equal(lines[1]!.since, first!.since);
  assert.ok(typeof lines[1]!.after === "number" && (lines[1]!.after as number) >= 0);
  assert.deepEqual(lifecycle(sandbox), ["place", "provision", "attach"]);
});

test("placing: a restart re-enters placing — same CR, same `since`, no second opening line", async () => {
  const store = await mkStore();
  const sandbox = new FakeSandbox();
  sandbox.holdPlacing = true;
  const first = new RunHost({ store, sandbox });
  first.register(wsDef());
  const { runId } = await first.start("ws");
  await waitFor(() => sandbox.waiting === 1);
  sandbox.waitFor(NODE);
  await waitFor(() => first.status(runId)!.waiting.length === 1);
  const since = first.status(runId)!.waiting[0]!.since;
  await first.stop(runId);
  assert.ok(!sandbox.calls.some((c) => c.startsWith("destroy:")), "a host stop is not an end: it keeps its place");
  // The persisted snapshot still says why, before any watch has spoken.
  assert.deepEqual((await first.read(runId))?.waiting, [{ child: "", ...NODE, since }]);

  const second = new RunHost({ store, sandbox });
  second.register(wsDef());
  await second.restore();
  const lines = placingLines(second, runId);
  await waitFor(() => sandbox.waiting === 1);
  sandbox.waitFor(NODE);
  sandbox.schedule();
  await waitFor(() => second.gates(runId).length === 1);
  assert.equal(sandbox.calls.filter((c) => c.startsWith("place:")).length, 2, "the apply re-ran, idempotently");
  assert.equal(new Set(sandbox.calls.map((c) => c.split(":")[1])).size, 1, "one CR");
  assert.deepEqual(
    lines.map((l) => l.kind),
    ["placed"],
    "the wait was opened before the restart; only its end is new",
  );
  assert.equal(lines[0]!.since, since);
});

test("placing: a wall clock that steps back during the wait gives no negative `after` — the wait it opened is timed on a monotonic clock (ADR-0064)", async () => {
  // A host clock step (NTP, a WSL2 resume) between the opening line and the end. Only `Date` is
  // mocked: the monotonic clock is not the wall clock, which is the point.
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-13T12:00:00Z") });
  try {
    const sandbox = new FakeSandbox();
    sandbox.holdPlacing = true;
    const host = new RunHost({ store: await mkStore(), sandbox });
    host.register(wsDef());
    const { runId } = await host.start("ws");
    const lines = placingLines(host, runId);
    await waitFor(() => sandbox.waiting === 1);
    sandbox.waitFor(NODE);
    await waitFor(() => lines.length === 1);
    mock.timers.setTime(Date.parse("2026-10-13T11:59:58Z"));
    sandbox.schedule();
    await waitFor(() => lines.length === 2);
    assert.equal(lines[1]!.kind, "placed");
    assert.ok((lines[1]!.after as number) >= 0, `after: ${String(lines[1]!.after)}`);
  } finally {
    mock.timers.reset();
  }
});

test("placing: a wall clock that steps forward during the wait is not the wait's duration — `after` is read from the monotonic clock, not two wall-clock reads (ADR-0064)", async () => {
  // A clamp alone would pass the step-back test; a step forward tells the two clocks apart.
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-13T12:00:00Z") });
  try {
    const sandbox = new FakeSandbox();
    sandbox.holdPlacing = true;
    const host = new RunHost({ store: await mkStore(), sandbox });
    host.register(wsDef());
    const { runId } = await host.start("ws");
    const lines = placingLines(host, runId);
    await waitFor(() => sandbox.waiting === 1);
    sandbox.waitFor(NODE);
    await waitFor(() => lines.length === 1);
    mock.timers.setTime(Date.parse("2026-10-13T13:00:00Z"));
    sandbox.schedule();
    await waitFor(() => lines.length === 2);
    assert.equal(lines[1]!.kind, "placed");
    const after = lines[1]!.after as number;
    assert.ok(after >= 0 && after < 60_000, `after: ${String(after)} (the wall clock stepped one hour)`);
  } finally {
    mock.timers.reset();
  }
});

test("placing: a wait opened before a restart is timed from its stored start, clamped at zero when the wall clock stepped back (ADR-0064)", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-13T12:00:00Z") });
  try {
    const store = await mkStore();
    const sandbox = new FakeSandbox();
    sandbox.holdPlacing = true;
    const first = new RunHost({ store, sandbox });
    first.register(wsDef());
    const { runId } = await first.start("ws");
    await waitFor(() => sandbox.waiting === 1);
    sandbox.waitFor(NODE);
    await waitFor(() => first.status(runId)!.waiting.length === 1);
    await first.stop(runId);

    mock.timers.setTime(Date.parse("2026-10-13T11:59:58Z"));
    const second = new RunHost({ store, sandbox });
    second.register(wsDef());
    await second.restore();
    const lines = placingLines(second, runId);
    await waitFor(() => sandbox.waiting === 1);
    sandbox.waitFor(NODE);
    sandbox.schedule();
    await waitFor(() => lines.length === 1);
    assert.equal(lines[0]!.kind, "placed");
    assert.equal(lines[0]!.after, 0, "a stored start later than now is no negative duration");
  } finally {
    mock.timers.reset();
  }
});

test("placing: a Workspace nested under a parent reports its path; the parent's `after` deletes what never ran", async () => {
  const sandbox = new FakeSandbox();
  sandbox.holdPlacing = true;
  const host = new RunHost({ store: await mkStore(), sandbox });
  // The body's bound is the Machine's own `after` (ADR-0064): jr2 sets none.
  const bounded = setup({ actors: { feature: wrapped } }).createMachine({
    id: "bounded",
    initial: "working",
    states: {
      working: { invoke: { id: "F-1", src: "feature" }, after: { 80: "gaveUp" } },
      gaveUp: { type: "final" },
    },
  });
  host.register({ name: "bounded", machine: bounded, provide: () => ({}) });
  const { runId } = await host.start("bounded");
  await waitFor(() => sandbox.waiting === 1);
  sandbox.waitFor(NODE);
  await waitFor(() => host.status(runId)?.waiting.length === 1);
  assert.equal(host.status(runId)!.waiting[0]!.child, "F-1");

  await waitFor(() => host.status(runId) === undefined);
  assert.equal((await host.read(runId))?.status, "done");
  // Stopped with no node: nothing on it to inspect, and left alone it could take a node for nobody.
  await waitFor(() => sandbox.calls.some((c) => c.startsWith("destroy:")));
  assert.deepEqual(lifecycle(sandbox), ["place", "destroy"]);
});

test("placing: a cancelled run deletes its Sandbox that never ran", async () => {
  const sandbox = new FakeSandbox();
  sandbox.holdPlacing = true;
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());
  const { runId } = await host.start("ws");
  await waitFor(() => sandbox.waiting === 1);
  sandbox.waitFor(NODE);
  await waitFor(() => host.status(runId)?.waiting.length === 1);
  // The cancel names no Sandbox still `placing`: that one is its own abort's to delete, once the
  // apply has settled (ADR-0064) — so the cancel resolves, and the CR is deleted exactly once.
  await host.cancel(runId);
  await waitFor(() => sandbox.calls.some((c) => c.startsWith("destroy:")));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(lifecycle(sandbox), ["place", "destroy"]);
  assert.deepEqual((await host.read(runId))?.waiting, [], "a cancelled run waits for nothing");
});

/** Two Workspaces under one run, each parked on its own gate in `running`. */
const holdOther = jr2Setup({ events: [approveDef] }).createMachine({
  on: { "workspace.lost": {} },
  id: "holdOther",
  initial: "working",
  states: {
    working: { invoke: { src: "gate", input: { gate: "other", accepts: ["approve"] } }, on: { approve: "done" } },
    done: { type: "final" },
  },
});
const twoFeatures = setup({
  actors: {
    feature: wrapped,
    other: workspace(holdOther, { repos: { app: APP } }),
  },
}).createMachine({
  id: "two",
  type: "parallel",
  states: {
    a: { invoke: { id: "F-1", src: "feature" } },
    b: { invoke: { id: "F-2", src: "other" } },
  },
});
const twoDef = (): WorkflowDef => ({ name: "two", machine: twoFeatures, provide: () => ({}) });
const destroyed = (sandbox: FakeSandbox): string[] =>
  sandbox.calls.filter((c) => c.startsWith("destroy:")).map((c) => c.slice("destroy:".length));

test("cancel destroys every Sandbox the run owns — an actor stop skips `teardown` (ADR-0025)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(twoDef());
  const { runId } = await host.start("two");
  await waitFor(() => host.gates(runId).length === 2);
  assert.deepEqual(destroyed(sandbox), [], "parked is retained");

  await host.cancel(runId);
  assert.deepEqual(destroyed(sandbox).sort(), [workspaceName(runId, "F-1"), workspaceName(runId, "F-2")].sort());
  assert.equal((await host.read(runId))?.status, "cancelled");
  const settled = renews(sandbox);
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));
  assert.equal(renews(sandbox), settled, "no lease renews what was deleted");
});

test("cancel finds a restored run's Sandboxes from its own snapshot, before any watch has listed", async () => {
  const store = await mkStore();
  const sandbox = new FakeSandbox();
  const first = new RunHost({ store, sandbox });
  first.register(wsDef());
  const { runId } = await first.start("ws");
  await waitFor(() => first.gates(runId).length === 1);
  const [placed] = sandbox.calls.filter((c) => c.startsWith("place:")).map((c) => c.slice("place:".length));
  await first.stop(runId);

  const second = new RunHost({ store, sandbox });
  second.register(wsDef());
  await second.restore();
  await second.cancel(runId);
  assert.deepEqual(destroyed(sandbox), [placed], "the same CR the wrapper placed");
});

test("cancel with keep destroys nothing: the Sandboxes age out at the idle timeout (ADR-0025)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(twoDef());
  const { runId } = await host.start("two");
  await waitFor(() => host.gates(runId).length === 2);

  await host.cancel(runId, { keep: true });
  assert.equal((await host.read(runId))?.status, "cancelled");
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));
  assert.deepEqual(destroyed(sandbox), []);
  const settled = renews(sandbox);
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));
  assert.equal(renews(sandbox), settled, "kept is not leased: nothing claims it");
});

test("the hold mark: a park writes nothing, a step of the wrapper writes nothing, a kept cancel releases (ADR-0021)", async () => {
  const store = await mkStore();
  const sandbox = new FakeSandbox();
  const first = new RunHost({ store, sandbox });
  first.register(twoDef());
  const { runId } = await first.start("two");
  await waitFor(() => first.gates(runId).length === 2);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sandbox.released, [], "placing → running is a step: each next state has its own Lease");

  await first.stop(runId); // a park: the CR stays `held` for the restored run's Lease
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sandbox.released, []);

  const second = new RunHost({ store, sandbox });
  second.register(twoDef());
  await second.restore();
  await waitFor(() => second.gates(runId).length === 2);
  await second.cancel(runId, { keep: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([...sandbox.released].sort(), [...sandbox.provisioned.keys()].sort());
});

/** A body that a defect ends: its gate's answer runs an action that throws. */
const defectBody = jr2Setup({
  types: {} as { input: Workspaced<{}, never> },
  events: [approveDef],
}).createMachine({
  id: "defect",
  on: { "workspace.lost": ".lost" },
  initial: "working",
  states: {
    lost: { type: "final" },
    working: {
      invoke: { src: "gate", input: { gate: "hold", accepts: ["approve"] } },
      on: {
        approve: {
          actions: () => {
            throw new Error("a body defect");
          },
        },
      },
    },
  },
});

/** A parent that keeps its run live after the Workspace: it waits at the gate `after`. `invoke` is
 * the Workspace's invoke, beside the parent's own gate `leave`, whose answer leaves the state. */
const liveParent = (child: AnyStateMachine, invoke: Record<string, unknown>) =>
  jr2Setup({ actors: { child }, events: [approveDef] }).createMachine({
    id: "live-parent",
    initial: "running",
    states: {
      running: {
        invoke: [
          { id: "F-1", src: "child", ...invoke },
          { src: "gate", input: { gate: "leave", accepts: ["approve"] } },
        ],
        on: { approve: "after" },
      },
      caught: { invoke: { src: "gate", input: { gate: "after", accepts: ["approve"] } } },
      after: { invoke: { src: "gate", input: { gate: "after", accepts: ["approve"] } } },
    },
  });

test("the hold mark: a body defect that ends the run releases its Sandbox, and leaves it (ADR-0021)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "defect", machine: workspace(defectBody, { repos: { app: APP } }), provide: () => ({}) });
  const { runId } = await host.start("defect");
  await waitFor(() => host.gates(runId).length === 1);
  host.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => sandbox.released.length === 1);
  assert.deepEqual(sandbox.released, [...sandbox.provisioned.keys()]);
  assert.deepEqual(destroyed(sandbox), [], "a fault leaves the Sandbox as evidence");
});

test("the hold mark: a body defect that the parent catches releases its Sandbox, and the renewals stop (ADR-0021)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const ws = workspace(defectBody, { repos: { app: APP } });
  host.register({ name: "caught", machine: liveParent(ws, { onError: "caught" }), provide: () => ({}) });
  const { runId } = await host.start("caught");
  await waitFor(() => host.gates(runId).length === 2);
  host.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => host.gates(runId).some((g) => g.gate.endsWith("after")));
  await waitFor(() => sandbox.released.length === 1);
  assert.deepEqual(sandbox.released, [...sandbox.provisioned.keys()]);
  const settled = renews(sandbox);
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));
  assert.equal(renews(sandbox), settled, "no Lease renews a Workspace that is over");
  assert.equal(host.status(runId)?.status, "active", "the run lives on");
});

test("the hold mark: a parent that catches a body defect and invokes the same Machine again keeps the new Workspace `held` (ADR-0021)", async () => {
  const sandbox = new FakeSandbox();
  sandbox.leaseIntervalMs = 300; // the old Lease's next tick comes after the re-invoke
  const host = new RunHost({ store: await mkStore(), sandbox });
  // The first body ends in a defect; the second works on. Neither holds a gate, because the errored
  // wrapper's children are not stopped.
  let attempt = 0;
  const once = jr2Setup({
    types: {} as { input: Workspaced<{}, never> },
    actors: {
      work: fromPromise(async ({ signal }) => {
        if (++attempt === 1) throw new Error("a body defect");
        await new Promise((r) => signal.addEventListener("abort", r));
      }),
    },
  }).createMachine({
    id: "once",
    on: { "workspace.lost": ".lost" },
    initial: "working",
    states: { lost: { type: "final" }, working: { invoke: { src: "work" } } },
  });
  const ws = workspace(once, { repos: { app: APP } });
  const retry = jr2Setup({ actors: { child: ws }, events: [approveDef] }).createMachine({
    id: "retry-parent",
    initial: "running",
    states: {
      running: { invoke: { id: "F-1", src: "child", onError: "waiting" } },
      waiting: { invoke: { src: "gate", input: { gate: "again", accepts: ["approve"] } }, on: { approve: "running" } },
    },
  });
  host.register({ name: "retry", machine: retry, provide: () => ({}) });
  const { runId } = await host.start("retry");
  // Each release records whether a live Workspace of the run held the name at that time.
  const whileLive: boolean[] = [];
  sandbox.releaseHold = async (name: string) => {
    sandbox.released.push(name);
    whileLive.push(JSON.stringify(host.status(runId)?.value) === '"running"');
  };
  await waitFor(() => host.gates(runId).some((g) => g.gate.endsWith("again")));
  host.sendToGate(runId, "again", { type: "approve" });
  await waitFor(() => sandbox.calls.filter((c) => c.startsWith("place:")).length === 2);
  assert.equal(new Set(sandbox.provisioned.keys()).size, 1, "the re-invoke places the same Sandbox name");
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 3));
  assert.equal(JSON.stringify(host.status(runId)?.value), '"running"');
  assert.deepEqual(whileLive.filter(Boolean), [], "no Lease releases a Sandbox that a live Workspace holds");
});

test("the hold mark: a parent that leaves the Workspace's state releases its Sandbox (ADR-0021)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const ws = workspace(slotlessBody, { repos: { app: APP } });
  host.register({ name: "leaves", machine: liveParent(ws, {}), provide: () => ({}) });
  const { runId } = await host.start("leaves");
  await waitFor(() => host.gates(runId).length === 2);
  assert.deepEqual(sandbox.released, []);
  host.sendToGate(runId, "leave", { type: "approve" });
  await waitFor(() => sandbox.released.length === 1);
  assert.deepEqual(sandbox.released, [...sandbox.provisioned.keys()]);
  assert.equal(host.status(runId)?.status, "active");
});

test("a place request's path is the wrapper's actor path: the wsId at the root, the invoke ids below", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const ws = workspace(slotlessBody, { repos: { app: APP } });
  host.register({ name: "nested", machine: liveParent(ws, {}), provide: () => ({}) });
  const outer = jr2Setup({ actors: { inner: liveParent(ws, {}) } }).createMachine({
    id: "outer",
    invoke: { id: "outer", src: "inner" },
  });
  host.register({ name: "deeper", machine: outer, provide: () => ({}) });
  host.register(wsDef());
  for (const name of ["ws", "nested", "deeper"]) {
    const { runId } = await host.start(name);
    await waitFor(() => host.gates(runId).length >= 1);
  }
  assert.equal(sandbox.paths.length, 3);
  assert.notEqual(sandbox.paths[0], "", "a root Workspace's path is its wsId");
  assert.deepEqual(sandbox.paths.slice(1), ["F-1", "outer/F-1"]);
});

test("cancel shrugs off a delete that fails: the run is cancelled, the idle GC has the CR", async () => {
  const sandbox = new FakeSandbox();
  sandbox.destroy = async (name) => {
    sandbox.calls.push(`destroy:${name}`);
    throw new Error("the API server is having a day");
  };
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());
  const { runId } = await host.start("ws");
  await waitFor(() => host.gates(runId).length === 1);
  await host.cancel(runId);
  assert.equal(destroyed(sandbox).length, 1);
  assert.equal((await host.read(runId))?.status, "cancelled");
});

// --- A Failure from the body (ADR-0073) ---------------------------------------------------------

const rejectDef = defineEvent({ name: "reject", input: z.object({}) });

/** A body that waits at its gate, then fails on `approve`, or throws a plain error on `reject`. */
const failingBody = jr2Setup({
  events: [approveDef, rejectDef],
  actors: {
    stop: fail(),
    boom: fromPromise(async () => {
      throw new Error("a bug in the step");
    }),
  },
}).createMachine({
  on: { "workspace.lost": {} },
  id: "failingBody",
  initial: "working",
  states: {
    working: {
      invoke: { src: "gate", input: { gate: "hold", accepts: ["approve", "reject"] } },
      on: { approve: "giving-up", reject: "breaking" },
    },
    "giving-up": { invoke: { src: "stop", input: { reason: "the tests did not pass", detail: { failed: 2 } } } },
    breaking: { invoke: { src: "boom" } },
  },
});
const failingWs = workspace(failingBody, { repos: { app: APP } });

test("a Failure from the body: the Workspace deletes its Sandbox, then the run ends `failed` with the Failure", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "wsf", machine: failingWs, provide: () => ({}) });
  const { runId } = await host.start("wsf");
  await waitFor(() => host.gates(runId).length === 1);
  host.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);

  const final = await host.read(runId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.fault, undefined);
  assert.deepEqual(final?.output, { reason: "the tests did not pass", detail: { failed: 2 } });
  assert.deepEqual(final?.value, { failing: "raising" }, "the wrapper sent it up from `failing`");
  // The wrapper's `failing` deleted it, before the Failure went up. The host's backstop names only
  // the Workspaces still live, and this one was not, so it is deleted once.
  assert.equal(destroyed(sandbox).length, 1);
  assert.deepEqual(lifecycle(sandbox), ["place", "provision", "attach", "destroy"]);
  const settled = renews(sandbox);
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));
  assert.equal(renews(sandbox), settled, "no lease renews what was deleted");
});

test("a defect from the body still goes up at once: the run ends `error`, and its Sandbox stays as evidence", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "wsf", machine: failingWs, provide: () => ({}) });
  const { runId } = await host.start("wsf");
  await waitFor(() => host.gates(runId).length === 1);
  host.sendToGate(runId, "hold", { type: "reject" });
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(final?.status, "error");
  assert.equal(final?.fault, "a bug in the step");
  assert.deepEqual(destroyed(sandbox), []);
});

test("a failed run's other Sandboxes go too: the host deletes them after the stop, as a cancel does (ADR-0025)", async () => {
  const two = setup({
    actors: {
      feature: failingWs,
      other: workspace(holdOther, { repos: { app: APP } }),
    },
  }).createMachine({
    id: "two",
    type: "parallel",
    states: {
      a: { invoke: { id: "F-1", src: "feature", input: {} } },
      b: { invoke: { id: "F-2", src: "other" } },
    },
  });
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "two", machine: two, provide: () => ({}) });
  const { runId } = await host.start("two");
  await waitFor(() => host.gates(runId).length === 2);
  host.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);
  assert.equal((await host.read(runId))?.status, "failed");
  await waitFor(() => destroyed(sandbox).length === 2);
  assert.deepEqual(destroyed(sandbox).sort(), [workspaceName(runId, "F-1"), workspaceName(runId, "F-2")].sort());
  const settled = renews(sandbox);
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));
  assert.equal(renews(sandbox), settled, "no lease renews what was deleted");
});

test("a caught Failure deletes the Sandbox of a Workspace in another region of the Machine it ended, once, and the run goes on (ADR-0073)", async () => {
  // Region `a` holds a Workspace at its Gate; region `b` fails. The Failure ends `inner`, and
  // `outer` catches it. The host stops the children of `inner`, and a stop skips `teardown`.
  const inner = jr2Setup({
    events: [approveDef],
    actors: {
      other: workspace(holdOther, { repos: { app: APP } }),
      stop: fail(),
    },
  }).createMachine({
    id: "inner",
    type: "parallel",
    states: {
      a: { invoke: { id: "F-2", src: "other" } },
      b: {
        initial: "working",
        states: {
          working: {
            invoke: { src: "gate", input: { gate: "hold", accepts: ["approve"] } },
            on: { approve: "giving-up" },
          },
          "giving-up": { invoke: { src: "stop", input: { reason: "region b gave up" } } },
        },
      },
    },
  });
  const outer = jr2Setup({ events: [approveDef], actors: { inner } }).createMachine({
    id: "outer",
    initial: "trying",
    states: {
      trying: {
        invoke: {
          id: "inner",
          src: "inner",
          onError: { guard: ({ event }) => isFailure(event.error), target: "caught" },
        },
      },
      caught: {
        invoke: { src: "gate", input: { gate: "after", accepts: ["approve"] } },
        on: { approve: "done" },
      },
      done: { type: "final" },
    },
  });
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "outer", machine: outer, provide: () => ({}) });
  const { runId } = await host.start("outer");
  await waitFor(() => host.gates(runId).length === 2);
  host.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => host.gates(runId).some((g) => g.gate === "after"));

  await waitFor(() => destroyed(sandbox).length === 1);
  assert.deepEqual(destroyed(sandbox), [workspaceName(runId, "inner/F-2")]);
  assert.equal(host.status(runId)?.status, "active", "the parent caught the Failure: the run goes on");
  const settled = renews(sandbox);
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));
  assert.equal(renews(sandbox), settled, "no lease renews what was deleted");

  host.sendToGate(runId, "after", { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);
  assert.equal((await host.read(runId))?.status, "done");
  assert.equal(destroyed(sandbox).length, 1, "deleted once");
});

test("a parent that catches a Failure and invokes the same Machine again keeps the Sandbox of its new Workspace (ADR-0073)", async () => {
  // The retry's Workspace has the same actor path, so it has the same Sandbox name. It is in
  // `placing` when the host stops the children of the Machine that the Failure ended. The host must
  // not delete that name: the retry holds it.
  const inner = jr2Setup({
    events: [approveDef],
    actors: {
      other: workspace(holdOther, { repos: { app: APP } }),
      stop: fail(),
    },
  }).createMachine({
    id: "inner",
    type: "parallel",
    states: {
      a: { invoke: { id: "F-2", src: "other" } },
      b: {
        initial: "working",
        states: {
          working: {
            invoke: { src: "gate", input: { gate: "hold", accepts: ["approve"] } },
            on: { approve: "giving-up" },
          },
          "giving-up": { invoke: { src: "stop", input: { reason: "region b gave up" } } },
        },
      },
    },
  });
  const outer = jr2Setup({ actors: { inner } }).createMachine({
    id: "outer",
    initial: "trying",
    states: {
      trying: {
        invoke: {
          id: "inner",
          src: "inner",
          onError: { guard: ({ event }) => isFailure(event.error), target: "trying", reenter: true },
        },
      },
    },
  });
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "outer", machine: outer, provide: () => ({}) });
  const { runId } = await host.start("outer");
  await waitFor(() => host.gates(runId).length === 2);
  host.sendToGate(runId, "hold", { type: "approve" });
  const name = workspaceName(runId, "inner/F-2");
  const verbs = (): string[] => sandbox.calls.filter((c) => !c.startsWith("renew:"));
  await waitFor(() => verbs().filter((c) => c === `attach:${name}`).length === 2);
  await waitFor(() => host.gates(runId).length === 2);

  const settled = renews(sandbox);
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));
  assert.deepEqual(destroyed(sandbox), [], "the retry holds the name: the host does not delete it");
  assert.ok(renews(sandbox) > settled, "the retry's lease is renewed");
  assert.equal(host.status(runId)?.status, "active", "the run goes on with the retry's Sandbox");

  // The retry's Workspace ends, and its own `teardown` deletes its Sandbox, once.
  host.sendToGate(runId, "other", { type: "approve" });
  await waitFor(() => destroyed(sandbox).length === 1);
  assert.deepEqual(destroyed(sandbox), [name]);
});

test("a parent that catches a Failure while the old Workspace is in `placing` keeps the Sandbox of its retry (ADR-0064, ADR-0073)", async () => {
  // The old Workspace's own delete rides the abort of its wait, after the write in flight settles. By
  // then the retry has placed the same name again, so the delete leaves it.
  const inner = jr2Setup({
    events: [approveDef],
    actors: {
      other: workspace(holdOther, { repos: { app: APP } }),
      stop: fail(),
    },
  }).createMachine({
    id: "inner",
    type: "parallel",
    states: {
      a: { invoke: { id: "F-2", src: "other" } },
      b: {
        initial: "working",
        states: {
          working: {
            invoke: { src: "gate", input: { gate: "hold", accepts: ["approve"] } },
            on: { approve: "giving-up" },
          },
          "giving-up": { invoke: { src: "stop", input: { reason: "region b gave up" } } },
        },
      },
    },
  });
  const outer = jr2Setup({ actors: { inner } }).createMachine({
    id: "outer",
    initial: "trying",
    states: {
      trying: {
        invoke: {
          id: "inner",
          src: "inner",
          onError: { guard: ({ event }) => isFailure(event.error), target: "trying", reenter: true },
        },
      },
    },
  });
  const sandbox = new FakeSandbox();
  sandbox.holdPlacing = true;
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "outer", machine: outer, provide: () => ({}) });
  const { runId } = await host.start("outer");
  await waitFor(() => host.gates(runId).length === 1 && sandbox.waiting === 1);
  host.sendToGate(runId, "hold", { type: "approve" });
  const name = workspaceName(runId, "inner/F-2");
  await waitFor(() => sandbox.calls.filter((c) => c === `place:${name}`).length === 2);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(destroyed(sandbox), [], "the retry holds the name");
});

test("placing: a parent that re-enters the state keeps the Sandbox of its new Workspace (ADR-0064)", async () => {
  // A plain re-entry, with no Failure: the new Workspace has the same actor path, so the same name.
  const outer = jr2Setup({
    actors: { other: workspace(holdOther, { repos: { app: APP } }) },
  }).createMachine({
    id: "again",
    initial: "trying",
    context: { n: 0 },
    states: {
      trying: {
        invoke: { id: "F-2", src: "other" },
        after: {
          30: { guard: ({ context }) => context.n === 0, target: "trying", reenter: true, actions: assign({ n: 1 }) },
        },
      },
    },
  });
  const sandbox = new FakeSandbox();
  sandbox.holdPlacing = true;
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "again", machine: outer, provide: () => ({}) });
  const { runId } = await host.start("again");
  const name = workspaceName(runId, "F-2");
  await waitFor(() => sandbox.calls.filter((c) => c === `place:${name}`).length === 2);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(destroyed(sandbox), [], "the re-entered Workspace holds the name");
});

test("a restart in `failing` replays the Failure: the delete runs again, and the same Failure ends the run (ADR-0073)", async () => {
  const store = await mkStore();
  const sandbox = new FakeSandbox();
  const destroy = sandbox.destroy.bind(sandbox);
  let hang = true;
  sandbox.destroy = (name) => (hang ? new Promise<void>(() => sandbox.calls.push(`destroy:${name}`)) : destroy(name));
  const first = new RunHost({ store, sandbox });
  first.register({ name: "wsf", machine: failingWs, provide: () => ({}) });
  const { runId } = await first.start("wsf");
  await waitFor(() => first.gates(runId).length === 1);
  first.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => destroyed(sandbox).length === 1);
  await first.stop(runId);

  hang = false;
  const second = new RunHost({ store, sandbox });
  second.register({ name: "wsf", machine: failingWs, provide: () => ({}) });
  await second.restore();
  await waitFor(() => second.status(runId) === undefined);
  const final = await second.read(runId);
  assert.equal(final?.status, "failed");
  assert.deepEqual(final?.output, { reason: "the tests did not pass", detail: { failed: 2 } });
  assert.equal(destroyed(sandbox).length, 2, "the restored `failing` deleted it again: a delete is idempotent");
});

test("the walk does not list the wrapper's own `failing` as a state that fails the run; it lists the body's", () => {
  assert.deepEqual(
    partsOf([failingWs]).failures.map((f) => f.state),
    ["failingBody.giving-up"],
  );
});

test("placing: a Sandbox Lost before its node faults the run by name, and is deleted — it never ran", async () => {
  const sandbox = new FakeSandbox();
  sandbox.holdPlacing = true;
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());
  const { runId } = await host.start("ws");
  await waitFor(() => sandbox.waiting === 1);
  sandbox.loseWhilePlacing("PodDeleted: the pod was deleted");
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(final?.status, "error");
  assert.match(final?.fault ?? "", /Lost while it waited for a node: PodDeleted/);
  // ADR-0064: a wait that ends without a node — a faulted run too — deletes its Sandbox; the fault keeps the why.
  assert.deepEqual(lifecycle(sandbox), ["place", "destroy"]);
});

test("attaching: a Sandbox Lost under the attach faults the run at once, naming the operator's reason", async () => {
  const sandbox = new FakeSandbox();
  let attaching!: () => void;
  const entered = new Promise<void>((r) => (attaching = r));
  let ended: unknown;
  sandbox.attach = (_req, opts) => {
    attaching();
    // An attach that would otherwise hang for its whole window — until its signal ends it.
    return new Promise((_, reject) =>
      opts?.signal?.addEventListener("abort", () => {
        ended = opts.signal!.reason;
        reject(opts.signal!.reason);
      }),
    );
  };
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());
  const { runId } = await host.start("ws");
  await entered;
  sandbox.lost = { reason: "Evicted", message: "The node was low on resource: memory." };
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(final?.status, "error");
  assert.match(final?.fault ?? "", /is Lost while it attached: Evicted: The node was low on resource: memory\./);
  assert.equal(sandbox.listening, 0, "the attach's subscription ends with it");
  assert.match(String(ended), /is Lost while it attached/, "the losing attach is ended, not left open (ADR-0042)");
});

test("the lease judges Continuity in `running` alone: a loss before it is the provision's to name", async () => {
  const sandbox = new FakeSandbox();
  sandbox.holdPlacing = true;
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());
  const { runId } = await host.start("ws");
  await waitFor(() => sandbox.waiting === 1);
  assert.equal(sandbox.listening, 0, "placing renews, and listens to nothing");
  sandbox.schedule();
  await waitFor(() => host.gates(runId).length === 1);
  assert.equal(sandbox.listening, 1, "running listens");
});

test("placing: a run that faults elsewhere deletes its Sandbox that never ran — and stops every lease", async () => {
  const sandbox = new FakeSandbox();
  sandbox.holdPlacing = true;
  const host = new RunHost({ store: await mkStore(), sandbox });
  // A sibling's unhandled error faults the run. xstate ends the root WITHOUT stopping its other
  // children, so this is the host's to do (run-host.ts `stopTree`).
  const faulty = setup({
    actors: {
      feature: wrapped,
      boom: fromPromise(async () => {
        await new Promise((r) => setTimeout(r, 40));
        throw new Error("a sibling exploded");
      }),
    },
  }).createMachine({
    id: "faulty",
    type: "parallel",
    states: {
      a: { invoke: { id: "F-1", src: "feature" } },
      b: { invoke: { id: "boom", src: "boom" } },
    },
  });
  host.register({ name: "faulty", machine: faulty, provide: () => ({}) });
  const { runId } = await host.start("faulty");
  await waitFor(() => sandbox.waiting === 1);
  sandbox.waitFor(NODE);
  await waitFor(() => host.status(runId) === undefined);
  assert.match((await host.read(runId))?.fault ?? "", /a sibling exploded/);
  assert.deepEqual((await host.read(runId))?.waiting, [], "a faulted run waits for nothing");
  await waitFor(() => sandbox.calls.some((c) => c.startsWith("destroy:")));
  const settled = renews(sandbox);
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));
  assert.equal(renews(sandbox), settled, "the lease stopped with the run");
});

// --- A nested Workspace's name, and its end when a Machine stops it (ADR-0012) ------------------

/** A body that works until it is stopped: no gate, so two of them in one run hold no one name. */
const parkedBody = jr2Setup({
  types: {} as { input: Workspaced<{}, never> },
  actors: { work: fromPromise(({ signal }) => new Promise((r) => signal.addEventListener("abort", r))) },
}).createMachine({
  id: "parked",
  on: { "workspace.lost": ".lost" },
  initial: "working",
  states: { working: { invoke: { src: "work" } }, lost: { type: "final" } },
});

/**
 * A Pool of two items, `a` and `b`, each worker a Workspace whose body invokes one nested Workspace
 * with the invoke id `review`: the same id in each worker.
 */
function nestedPool(): WorkflowDef {
  const items = ["a", "b"];
  const review = workspace(parkedBody, {});
  const workerBody = jr2Setup({
    types: {} as { input: Workspaced<{}, never> },
    actors: { review },
  }).createMachine({
    id: "worker-body",
    on: { "workspace.lost": ".lost" },
    initial: "reviewing",
    states: { reviewing: { invoke: { id: "review", src: "review" } }, lost: { type: "final" } },
  });
  const machine = pool(workspace(workerBody, {}), {
    id: "nested-pool",
    source: source<{ id: string }>({
      next: fromPromise(async ({ input }: { input: PoolNextInput }) => {
        const id = items.find((i) => !input.active.includes(i) && !input.settled.includes(i));
        return id === undefined ? null : { id };
      }),
    }),
    itemId: (item: { id: string }) => item.id,
    cap: 2,
    itemInput: () => ({}),
  });
  return { name: "nested-pool", machine, provide: () => ({}) };
}

test("a nested Workspace's Sandbox name is its actor path's: two Pool workers' nested Workspaces get two Sandboxes, and a restore keeps both names (ADR-0012)", async () => {
  const store = await mkStore();
  const sandbox = new FakeSandbox();
  const first = new RunHost({ store, sandbox });
  first.register(nestedPool());
  const { runId } = await first.start("nested-pool");
  await waitFor(() => sandbox.calls.filter((c) => c.startsWith("provision:")).length === 4);

  // The workers keep the names they had: their path is their own id.
  const placed = sandbox.calls.filter((c) => c.startsWith("place:")).map((c) => c.slice("place:".length));
  assert.equal(placed.length, 4);
  assert.deepEqual([...sandbox.paths].sort(), ["a", "a/body/review", "b", "b/body/review"]);
  assert.deepEqual(
    [...placed].sort(),
    ["a", "a/body/review", "b", "b/body/review"].map((path) => workspaceName(runId, path)).sort(),
  );
  assert.equal(new Set(placed).size, 4, "each Workspace has a Sandbox of its own");

  await first.stop(runId); // a park: the restored run takes the same Sandboxes
  assert.deepEqual(destroyed(sandbox), []);
  const second = new RunHost({ store, sandbox });
  second.register(nestedPool());
  await second.restore();
  const before = sandbox.calls.length;
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));
  const named = new Set(sandbox.calls.slice(before).map((c) => c.slice(c.indexOf(":") + 1)));
  assert.ok(named.size > 0, "the restored Leases renew");
  for (const name of named) assert.ok(placed.includes(name), `the restored run names ${name}, which it did not place`);

  await second.cancel(runId);
  assert.deepEqual([...destroyed(sandbox)].sort(), [...placed].sort());
});

/** The store's records of the Sandbox deletes of one run that are not done, `<name> sent|unsent`. */
const savedDeleting = (store: Awaited<ReturnType<typeof mkStore>>, runId: string): string[] =>
  store
    .sandboxDeletes()
    .filter((d) => d.runId === runId)
    .map((d) => `${d.name} ${d.sent ? "sent" : "unsent"}`);

test("a Workspace that its parent stops while the run goes on loses its Sandbox; a park does not (ADR-0012)", async () => {
  const store = await mkStore();
  const sandbox = new FakeSandbox();
  const ws = workspace(slotlessBody, {});
  const def = (): WorkflowDef => ({ name: "leaves", machine: liveParent(ws, {}), provide: () => ({}) });
  const first = new RunHost({ store, sandbox });
  first.register(def());
  const { runId } = await first.start("leaves");
  await waitFor(() => first.gates(runId).length === 2);
  const [name] = [...sandbox.provisioned.keys()];

  // A park stops the Workspace too, and deletes nothing: the restored run needs the Sandbox.
  await first.stop(runId);
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));
  assert.deepEqual(destroyed(sandbox), []);
  const second = new RunHost({ store, sandbox });
  second.register(def());
  await second.restore();
  await waitFor(() => second.gates(runId).length === 2);
  assert.deepEqual(destroyed(sandbox), []);

  // The parent leaves the Workspace's state: the stop skips `teardown`, and the host deletes.
  second.sendToGate(runId, "leave", { type: "approve" });
  await waitFor(() => destroyed(sandbox).length === 1);
  assert.deepEqual(destroyed(sandbox), [name]);
  assert.equal(second.status(runId)?.status, "active", "the run goes on");
  const settled = renews(sandbox);
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));
  assert.equal(renews(sandbox), settled, "no Lease renews what was deleted");
  assert.deepEqual(savedDeleting(store, runId), [], "a delete that is done leaves no record");
});

test("a delete that a crash cut short is done again by the restore (ADR-0012)", async () => {
  const store = await mkStore();
  const sandbox = new FakeSandbox();
  const ws = workspace(slotlessBody, {});
  const def = (): WorkflowDef => ({ name: "leaves", machine: liveParent(ws, {}), provide: () => ({}) });
  const first = new RunHost({ store, sandbox });
  first.register(def());
  const { runId } = await first.start("leaves");
  await waitFor(() => first.gates(runId).length === 2);
  const [name] = [...sandbox.provisioned.keys()];
  // The delete never ends: the process dies under it.
  const destroy = sandbox.destroy.bind(sandbox);
  sandbox.destroy = async (n) => {
    sandbox.calls.push(`destroy:${n}`);
    await new Promise(() => {});
  };
  first.sendToGate(runId, "leave", { type: "approve" });
  await waitFor(() => destroyed(sandbox).length === 1);
  // Recorded as sent before it left.
  assert.deepEqual(savedDeleting(store, runId), [`${name} sent`]);
  await first.stop(runId);

  sandbox.destroy = destroy;
  const second = new RunHost({ store, sandbox });
  second.register(def());
  await second.restore();
  await waitFor(() => destroyed(sandbox).length === 2);
  assert.deepEqual(destroyed(sandbox), [name, name]);
  await waitFor(() => savedDeleting(store, runId).length === 0);
});

test("a Workspace that places a name the host is deleting waits for the delete (ADR-0012)", async () => {
  const sandbox = new FakeSandbox();
  const ws = workspace(slotlessBody, {});
  // `leave` stops the Workspace; `again` invokes it once more from the same state: the same name.
  const parent = jr2Setup({ actors: { child: ws }, events: [approveDef] }).createMachine({
    id: "again-parent",
    initial: "running",
    states: {
      running: {
        invoke: [
          { id: "F-1", src: "child" },
          { src: "gate", input: { gate: "leave", accepts: ["approve"] } },
        ],
        on: { approve: "away" },
      },
      away: { invoke: { src: "gate", input: { gate: "again", accepts: ["approve"] } }, on: { approve: "running" } },
    },
  });
  let release = (): void => {};
  sandbox.destroy = async (n) => {
    sandbox.calls.push(`destroy:${n}`);
    await new Promise<void>((r) => (release = r));
    sandbox.calls.push(`destroyed:${n}`);
  };
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "again", machine: parent, provide: () => ({}) });
  const { runId } = await host.start("again");
  await waitFor(() => host.gates(runId).length === 2);
  host.sendToGate(runId, "leave", { type: "approve" });
  await waitFor(() => host.gates(runId).some((g) => g.gate.endsWith("again")));
  await waitFor(() => destroyed(sandbox).length === 1);
  host.sendToGate(runId, "again", { type: "approve" });
  await new Promise((r) => setTimeout(r, 30));
  const places = () => sandbox.calls.filter((c) => c.startsWith("place:")).length;
  assert.equal(places(), 1, "the second place waits for the delete");
  release();
  await waitFor(() => places() === 2);
  const verbs = sandbox.calls.filter((c) => !c.startsWith("renew:")).map((c) => c.split(":")[0]);
  assert.ok(verbs.lastIndexOf("destroyed") < verbs.lastIndexOf("place"), verbs.join(" "));
  await waitFor(() => host.gates(runId).length === 2);
});

/**
 * `leave` stops the Workspace F-1; `again` invokes it once more from the same state, so with the
 * same name. `reach` is where the run ends: a final state when it is `done`.
 */
const leaveAndAgain = (ws: AnyStateMachine) =>
  jr2Setup({ actors: { child: ws }, events: [approveDef] }).createMachine({
    id: "again-parent",
    initial: "running",
    states: {
      running: {
        invoke: [
          { id: "F-1", src: "child" },
          { src: "gate", input: { gate: "leave", accepts: ["approve"] } },
        ],
        on: { approve: "away" },
      },
      away: { invoke: { src: "gate", input: { gate: "again", accepts: ["approve"] } }, on: { approve: "running" } },
    },
  });

/** A delete that the cluster never confirms: the CR is terminating, and its pod still goes away. */
const hangDeletes = (sandbox: FakeSandbox): void => {
  sandbox.destroy = async (n) => {
    sandbox.calls.push(`destroy:${n}`);
    await new Promise<void>(() => {});
  };
};
const placesOf = (sandbox: FakeSandbox): number => sandbox.calls.filter((c) => c.startsWith("place:")).length;

test("a restore while a Workspace waits for the delete of its name: the restored Workspace waits too (ADR-0012)", async () => {
  const store = await mkStore();
  const sandbox = new FakeSandbox();
  const def = (): WorkflowDef => ({
    name: "again",
    machine: leaveAndAgain(workspace(slotlessBody, {})),
    provide: () => ({}),
  });
  hangDeletes(sandbox);
  const first = new RunHost({ store, sandbox });
  first.register(def());
  const { runId } = await first.start("again");
  await waitFor(() => first.gates(runId).length === 2);
  const [name] = [...sandbox.provisioned.keys()];
  first.sendToGate(runId, "leave", { type: "approve" });
  await waitFor(() => first.gates(runId).some((g) => g.gate.endsWith("again")) && destroyed(sandbox).length === 1);
  first.sendToGate(runId, "again", { type: "approve" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(placesOf(sandbox), 1, "the second place waits for the delete");
  assert.deepEqual(savedDeleting(store, runId), [`${name} sent`]);

  await first.stop(runId); // the Orchestrator restarts, with the delete sent and not confirmed
  const second = new RunHost({ store, sandbox });
  second.register(def());
  await second.restore();
  await waitFor(() => destroyed(sandbox).length === 2);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(placesOf(sandbox), 1, "the restored Workspace in `placing` waits for the delete it waited for");
  assert.deepEqual(destroyed(sandbox), [name, name], "the restore sends the delete again: it holds the name");

  // The delete is done: the restored Workspace places the name again, and the record goes.
  sandbox.destroy = async (n) => {
    sandbox.calls.push(`destroy:${n}`);
  };
  const third = new RunHost({ store, sandbox });
  await second.stop(runId);
  third.register(def());
  await third.restore();
  await waitFor(() => placesOf(sandbox) === 2);
  await waitFor(() => savedDeleting(store, runId).length === 0);
  await waitFor(() => third.gates(runId).length === 2);
});

test("a restore redoes the Sandbox delete of a run that ended, and of one that it finds drifted (ADR-0012)", async () => {
  const store = await mkStore();
  const sandbox = new FakeSandbox();
  // The run's Machine reaches its end while its Workspace runs: the stop deletes the Sandbox.
  const ends = jr2Setup({ actors: { child: workspace(slotlessBody, {}) }, events: [approveDef] }).createMachine({
    id: "ends",
    initial: "running",
    states: {
      running: {
        invoke: [
          { id: "F-1", src: "child" },
          { src: "gate", input: { gate: "leave", accepts: ["approve"] } },
        ],
        on: { approve: "over" },
      },
      over: { type: "final" },
    },
  });
  const leaves = liveParent(workspace(slotlessBody, {}), {});
  hangDeletes(sandbox);
  const first = new RunHost({ store, sandbox });
  first.register({ name: "ends", machine: ends, provide: () => ({}) });
  first.register({ name: "leaves", machine: leaves, provide: () => ({}) });
  const done = await first.start("ends");
  const drifts = await first.start("leaves");
  await waitFor(() => first.gates(done.runId).length === 2 && first.gates(drifts.runId).length === 2);
  first.sendToGate(done.runId, "leave", { type: "approve" });
  first.sendToGate(drifts.runId, "leave", { type: "approve" });
  await waitFor(() => destroyed(sandbox).length === 2);
  await waitFor(() => first.status(done.runId) === undefined);
  assert.equal((await first.read(done.runId))?.status, "done");
  await first.stop(drifts.runId);
  // The process dies with both deletes sent and not confirmed.
  assert.equal(savedDeleting(store, done.runId).length, 1);
  assert.equal(savedDeleting(store, drifts.runId).length, 1);

  sandbox.destroy = async (n) => {
    sandbox.calls.push(`destroy:${n}`);
  };
  const second = new RunHost({ store, sandbox });
  second.register({ name: "ends", machine: ends, provide: () => ({}) });
  // `leaves` now names another Machine: its run is drifted, and no tree holds its Workspace again.
  second.register({
    name: "leaves",
    machine: liveParent(workspace(body, { repos: { app: APP } }), {}),
    provide: () => ({}),
  });
  const { drifted } = await second.restore();
  assert.deepEqual(drifted, [drifts.runId]);
  await waitFor(() => destroyed(sandbox).length === 4);
  await waitFor(() => store.sandboxDeletes().length === 0);
});

test("a Workspace stopped in `placing` is deleted by the host: recorded, and a place of the name waits for it (ADR-0064)", async () => {
  const store = await mkStore();
  const sandbox = new FakeSandbox();
  sandbox.holdPlacing = true;
  hangDeletes(sandbox);
  const host = new RunHost({ store, sandbox });
  host.register({ name: "again", machine: leaveAndAgain(workspace(slotlessBody, {})), provide: () => ({}) });
  const { runId } = await host.start("again");
  await waitFor(() => host.gates(runId).length === 1 && sandbox.waiting === 1);
  const [name] = [...sandbox.provisioned.keys()];
  host.sendToGate(runId, "leave", { type: "approve" });
  await waitFor(() => destroyed(sandbox).length === 1);
  assert.deepEqual(savedDeleting(store, runId), [`${name} sent`]);
  host.sendToGate(runId, "again", { type: "approve" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(placesOf(sandbox), 1, "the place of the name waits for the delete");
});
