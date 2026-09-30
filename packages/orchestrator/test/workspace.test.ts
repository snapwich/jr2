// workspace(body, { repos, spec }) — ADR-0012, ADR-0051. Driven through a REAL RunHost (store +
// binding + restore) against a fake SandboxPort at the seam, so lifecycle, input passthrough,
// parked-body retention, the Repo Slots' three states, and the restore-reconcile `workspace.lost`
// path are exercised the way a run experiences them. The kind-backed port has its own suite; the
// cluster itself is e2e-tier.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, fromPromise, setup } from "xstate";
import { jr2Setup } from "../src/setup.ts";
import { agentActorWith } from "../src/actor.ts";
import { customize } from "../src/customize.ts";
import { open, sandboxPartsOf } from "../src/parts.ts";
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
  type WorkspaceSpec,
} from "../src/workspace.ts";
import { observe, RunHost, type WorkflowDef } from "../src/run-host.ts";
import { approveDef, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

class FakeSandbox implements SandboxPort {
  calls: string[] = [];
  provisioned = new Map<string, { runId: string; workflow: string }>();
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
  /** The pod-composition fields the spec carries beside it (ADR-0005), same passthrough rule. */
  composition: Array<{ user?: string; workGroup?: number }> = [];
  /** The Repo Slots each provision resolved (ADR-0051), in declaration order. */
  repos: ProvisionedRepo[][] = [];
  /** The Size each provision was handed, as the Machine states it (ADR-0060). */
  sizes: Array<{ resources?: unknown; userResources?: unknown }> = [];
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
    this.repos.push(req.repos);
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
  async attach(req: {
    name: string;
    spec: WorkspaceSpec;
    repos: Array<{ slot: string; url: string; ref?: string }>;
  }): Promise<{ repos: Record<string, string> }> {
    this.calls.push(`attach:${req.name}`);
    this.attached.push(req.repos);
    const repos = Object.fromEntries(req.repos.map((r) => [r.slot, `/work/${r.slot}/${req.spec.branch}`]));
    return { repos };
  }
  async renew(name: string): Promise<void> {
    this.calls.push(`renew:${name}`);
    if (this.failRenew) throw new Error("the API server is having a day");
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
    context: { handles?: { repos: Record<string, string>; branch: string }; loss?: string };
    // Body-facing handles only (ADR-0016): endpoint/sandbox never reach workflow code.
    input: { workspace: { repos: Record<string, string>; branch: string } };
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
const wrapped = workspace(body, { repos: { app: { url: APP, ref: "main" } }, spec: () => ({ branch: "feat-1" }) });

function wsDef(): WorkflowDef {
  return { name: "ws", machine: wrapped, provide: () => ({}) };
}

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
  assert.deepEqual(ctx.output, { status: "done", app: "/work/app/feat-1" });
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

test("a branch named `default` faults BEFORE any pod exists — that directory is the clone's (ADR-0004)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const clash = workspace(body, { repos: { app: APP }, spec: () => ({ branch: "default" }) });
  host.register({ name: "clash", machine: clash, provide: () => ({}) });
  const { runId } = await host.start("clash", { prompt: "x" });
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(final?.status, "error");
  assert.match(final?.fault ?? "", /workspace spec invalid: branch "default"/);
  assert.ok(!sandbox.calls.some((c) => c.startsWith("place:")), "faulted before the port");
});

test("a spec deriving undefined fields (missing run input) faults BEFORE any pod exists", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  // The task-with-review shape: the mapping reads input fields this `jr2 run --input` never carried.
  const sloppy = workspace(body, {
    repos: { app: APP },
    spec: ({ input }: { input: { branch?: string } }) => ({ branch: input.branch as string }),
  });
  host.register({ name: "sloppy", machine: sloppy, provide: () => ({}) });

  const { runId } = await host.start("sloppy", { prompt: "fix it" }); // no branch
  await waitFor(() => host.status(runId) === undefined);

  const final = await host.read(runId);
  assert.equal(final?.status, "error");
  assert.match(final?.fault ?? "", /workspace spec invalid: branch/);
  assert.match(final?.fault ?? "", /run input/, "the fault points back at `jr2 run --input`");
  assert.ok(
    !sandbox.calls.some((c) => c.startsWith("place:")),
    "faulted before the port — a bad spec never costs a pod",
  );
});

test("the image is a STATIC option read off the Machine at invoke time, never the spec", async () => {
  // ADR-0049: what the Sandbox is MADE OF moved out of the per-run spec and onto the wrapper,
  // because `jr2 up` must find it by WALKING the Machine and a spec is a function of run input.
  // Resolution to a ref is still the port's, so the Machine stays cluster-agnostic and no
  // content-addressed tag ever lands in a snapshot.
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const named = workspace(body, {
    image: "file:///srv/pkg/image",
    repos: { app: APP },
    spec: () => ({ branch: "b" }),
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

  // And NEVER the spec (ADR-0051: `WorkspaceSpec = { branch, workGroup?, reviewSha? }`): an
  // `image` a spec mapper smuggles in is not a name the port ever sees — the request carries what
  // the wrapper carries, and this wrapper carries none.
  const unnamed = workspace(body, {
    repos: { app: APP },
    spec: () => ({ branch: "b", image: "file:///srv/pkg/image" }) as { branch: string },
  });
  host.register({ name: "unnamed", machine: unnamed, provide: () => ({}) });
  const second = await host.start("unnamed");
  await waitFor(() => host.gates(second.runId).length === 1);
  assert.deepEqual(sandbox.images, ["file:///srv/pkg/image", undefined]);
});

test("pod composition: `user` is a static option too, `workGroup` stays per-run spec", async () => {
  // ADR-0005/0037/0049: the User Container's image rides the same rule as the Sandbox Image's —
  // two origins, one resolution, static so the converge can build it. The work GROUP is not an
  // image and nothing walks it, so it stays where a run's own facts live.
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const composed = workspace(body, {
    image: "ghcr.io/acme/toolchain:2024-11",
    user: "ghcr.io/acme/sshd:1",
    repos: { app: APP },
    spec: () => ({ branch: "b", workGroup: 4000 }),
  });
  host.register({ name: "composed", machine: composed, provide: () => ({}) });
  const { runId } = await host.start("composed");
  await waitFor(() => host.gates(runId).length === 1);
  assert.deepEqual(sandbox.images, ["ghcr.io/acme/toolchain:2024-11"]);
  assert.deepEqual(sandbox.composition, [{ user: "ghcr.io/acme/sshd:1", workGroup: 4000 }]);

  // A gid that is not an integer becomes a pod the API server rejects at admission — which
  // surfaces as "never reached Ready" with nothing pointing back at the run input.
  const bad = new FakeSandbox();
  const host2 = new RunHost({ store: await mkStore(), sandbox: bad });
  const wrong = workspace(body, { repos: { app: APP }, spec: () => ({ branch: "b", workGroup: 2000.5 }) });
  host2.register({ name: "wrong", machine: wrong, provide: () => ({}) });
  const run2 = await host2.start("wrong");
  await waitFor(() => host2.status(run2.runId) === undefined);
  assert.match((await host2.read(run2.runId))?.fault ?? "", /workGroup \(got 2000\.5; want a gid\)/);
  assert.deepEqual(bad.calls, [], "a bad spec never costs a pod");
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
    types: {} as { context: Record<string, never>; input: { workspace: { branch: string } } },
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
    id: "ambient",
    context: {},
    initial: "coding",
    states: {
      coding: {
        invoke: { src: "coder", input: { prompt: "go" } },
        on: { approve: "done" },
      },
      done: { type: "final" },
    },
  });
  const wrappedAmbient = workspace(ambientBody, { repos: { app: APP }, spec: () => ({ branch: "amb" }) });

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
    context: { handles?: { repos: Record<string, string>; branch: string } };
    input: { workspace: { repos: Record<string, string>; branch: string } };
  },
  events: [],
}).createMachine({
  id: "recorder",
  context: ({ input }) => ({ handles: input.workspace }),
  initial: "done",
  states: { done: { type: "final", output: ({ context }) => context.handles } },
  output: ({ event }) => (event as { output?: unknown }).output,
});

test("slots resolve in declaration order; the handles are keyed by slot, in that order, and name no workdir", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const two = workspace(recorder, {
    repos: { docs: { url: "https://example.test/handbook.git", ref: "v3" }, app: APP },
    spec: () => ({ branch: "feat/x" }),
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
  // The kit gives no slot a privileged meaning (ADR-0051): the handles are the map and the branch.
  // What it does promise is the ORDER — a Machine may read a meaning into it (`task` does).
  assert.deepEqual(Object.keys(out.output ?? {}).sort(), ["branch", "repos"]);
  assert.deepEqual(out.output?.repos, { docs: "/work/docs/feat/x", app: "/work/app/feat/x" });
  assert.deepEqual(
    Object.keys(out.output?.repos as object),
    ["docs", "app"],
    "declaration order, not alphabetical — through the persisted snapshot too",
  );
});

test("two bound Repo Slots and a Turn that frames no cwd: the run is refused, naming the slots (ADR-0057)", async () => {
  // The composition trap ADR-0057 accepted with open eyes: a Machine that ran yesterday under one
  // Repo Slot refuses today under two, in a `customize` line its author never sees. `jr2 up`
  // cannot see it either — the invoke's input is a function — so the refusal has to be explicit at
  // the FIRST Turn, and it is asserted here against a real two-slot Machine rather than a
  // hand-registered handle, because it is the WORKSPACE's slot count that decides.
  const client = new MockFlueClient();
  const unframed = jr2Setup({
    types: {} as {
      context: Record<string, never>;
      input: { workspace: { repos: Record<string, string>; branch: string } };
    },
    events: [],
    actors: { coder: agentActorWith(() => client, { model: "test/model", instructions: "i" }) },
  }).createMachine({
    id: "unframed",
    context: {},
    initial: "coding",
    // The Frame is a prompt and nothing else — which is legal under one slot and a refusal here.
    states: { coding: { invoke: { src: "coder", input: { prompt: "go" } } } },
  });

  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({
    name: "twoSlots",
    machine: workspace(unframed, {
      repos: { docs: { url: "https://example.test/handbook.git", ref: "v3" }, app: APP },
      spec: () => ({ branch: "feat-2" }),
    }),
    provide: () => ({}),
  });
  const { runId } = await host.start("twoSlots");
  await waitFor(() => host.status(runId) === undefined);

  const fault = (await host.read(runId))?.fault ?? "";
  assert.equal((await host.read(runId))?.status, "error");
  // The slots in DECLARATION order, which is the order the composer wrote and the only order that
  // helps them pick (ADR-0051) — and the line that ends it.
  assert.match(fault, /agent "coder" works under a Workspace carrying more than one Repo Slot \(docs, app\)/);
  assert.match(fault, /cwd: context\.workspace\.repos\.<slot>/);
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
    spec: () => ({ branch: "b" }),
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
  // pointing at `jr2 run --input` — the same class assertSpec catches for the branch.
  const bad = new FakeSandbox();
  const host2 = new RunHost({ store: await mkStore(), sandbox: bad });
  host2.register({ name: "perRun", machine: perRun, provide: () => ({}) });
  const run2 = await host2.start("perRun", { prompt: "fix it" });
  await waitFor(() => host2.status(run2.runId) === undefined);
  const final = await host2.read(run2.runId);
  assert.equal(final?.status, "error");
  assert.match(final?.fault ?? "", /workspace spec invalid: repos\.target mapper returned url \(got undefined\)/);
  assert.match(final?.fault ?? "", /run input/);
  assert.deepEqual(bad.calls, [], "a bad binding never costs a pod");
});

test("an OPEN slot nobody bound faults before the port, naming the customize line that binds it", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const packaged = workspace(recorder, { repos: { target: open }, spec: () => ({ branch: "b" }) });
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
    machine: workspace(recorder, { repos: open, spec: () => ({ branch: "b" }) }),
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
    spec: () => ({ branch: "b" }),
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

test("workspace() refuses a missing, empty, or malformed `repos` at build time, by slot", () => {
  const spec = () => ({ branch: "b" });
  assert.throws(() => workspace(body, { spec } as never), /`repos` must name at least one Repo Slot/);
  assert.throws(() => workspace(body, { repos: {}, spec } as never), /at least one Repo Slot/);
  assert.throws(() => workspace(body, { repos: { app: "" }, spec }), /Repo Slot "app" is bound to an empty url/);
  assert.throws(
    () => workspace(body, { repos: { app: { url: APP, ref: "" } }, spec }),
    /"app" is bound with an empty ref/,
  );
  assert.throws(() => workspace(body, { repos: { app: 42 as never }, spec }), /"app" is not a binding/);
  // A url that names no Repo — a relative path has no identity to key a cache by.
  assert.throws(
    () => workspace(body, { repos: { app: "../infra" }, spec }),
    /"app" binds "\.\.\/infra", which names no Repo/,
  );
  // A slot key becomes `/work/<slot>`, so it is held to what a path segment can carry.
  assert.throws(
    () => workspace(body, { repos: { "../x": APP }, spec }),
    /Repo Slot key "\.\.\/x" is not a directory name/,
  );
  assert.throws(() => workspace(body, { repos: { "a b": APP }, spec }), /"a b" is not a directory name/);
  // An integer-like key would be read FIRST by `Object.keys` wherever it was declared — and the
  // handles promise declaration order, which a Machine may read — so a key starts with a letter.
  assert.throws(() => workspace(body, { repos: { app: APP, "1": APP }, spec }), /key "1" is not a directory name/);
  assert.throws(() => workspace(body, { repos: { "2024": APP }, spec }), /key "2024" is not a directory name/);
  assert.throws(() => workspace(body, { repos: { "0app": APP }, spec }), /key "0app" is not a directory name/);
});

test("workspace() keeps the Repo Slots in declaration order — the order the handles promise", () => {
  const spec = () => ({ branch: "b" });
  const w = workspace(body, { repos: { app: APP, infra: APP, "v2.x": APP }, spec });
  assert.deepEqual(Object.keys(sandboxPartsOf(w).repos), ["app", "infra", "v2.x"]);
});

test("the Size is a static option: the port gets it as stated, and the User Container's split beside it (ADR-0060)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const sized = workspace(body, {
    user: { image: "ghcr.io/acme/sshd:1", resources: { limits: { memory: "256Mi" } } },
    resources: { limits: { memory: "3Gi", cpu: "2" } },
    repos: { app: APP },
    spec: () => ({ branch: "b" }),
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
    machine: workspace(body, { repos: { app: APP }, spec: () => ({ branch: "b" }) }),
    provide: () => ({}),
  });
  const second = await host2.start("bare");
  await waitFor(() => host2.gates(second.runId).length === 1);
  assert.deepEqual(bare.sizes, [{}]);
});

test("workspace() refuses requests, and any key beside limits.memory/limits.cpu, by field (ADR-0060)", () => {
  const spec = () => ({ branch: "b" });
  assert.throws(
    () =>
      workspace(body, {
        repos: { app: APP },
        spec,
        resources: { limits: { memory: "3Gi" }, requests: { memory: "1Gi" } } as never,
      }),
    /workspace\(\): resources\.requests is not accepted/,
  );
  assert.throws(
    () => workspace(body, { repos: { app: APP }, spec, resources: { limits: { gpu: "1" } } as never }),
    /workspace\(\): resources\.limits\.gpu is not accepted/,
  );
  assert.throws(
    () =>
      workspace(body, {
        repos: { app: APP },
        spec,
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
    other: workspace(holdOther, { repos: { app: APP }, spec: () => ({ branch: "feat-2" }) }),
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
  sandbox.attach = () => {
    attaching();
    return new Promise(() => {}); // an attach that would otherwise hang for its whole window
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
