// workspace(body, spec) — ADR-0012. Driven through a REAL RunHost (store + binding + restore)
// against a fake SandboxPort at the seam, so lifecycle, input passthrough, parked-body
// retention, and the restore-reconcile `workspace.lost` path are exercised the way a run
// experiences them. The kind-backed port has its own suite; the cluster itself is e2e-tier.

import { test } from "node:test";
import assert from "node:assert/strict";
import { j2Setup } from "../src/setup.ts";
import { agentActorWith } from "../src/actor.ts";
import { workspace, workspaceName, type SandboxPort, type WorkspaceSpec } from "../src/workspace.ts";
import { RunHost, type WorkflowDef } from "../src/run-host.ts";
import { approveDef, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

class FakeSandbox implements SandboxPort {
  calls: string[] = [];
  provisioned = new Map<string, { runId: string; workflow: string }>();
  /** What `renew()` answers — flip to false to simulate a reaped Sandbox. */
  present = true;
  /** The live pod's identity. Change it to simulate an eviction/node-loss replacement:
   * same CR, same name, same endpoint — different pod, empty `work` volume. */
  identity = "pod-1";
  /** Make the next `renew()` throw — an API error is "unknown", never "lost". */
  failRenew = false;
  /** Fast enough that a test can observe several ticks without sleeping on wall clock. */
  leaseIntervalMs = 5;

  /** The Sandbox Image NAME each provision was asked for (ADR-0037) — resolution is the port's. */
  images: Array<string | undefined> = [];
  /** The pod-composition fields the spec carries beside it (ADR-0005), same passthrough rule. */
  composition: Array<{ user?: string; workGroup?: number }> = [];

  async provision(req: {
    name: string;
    runId: string;
    workflow: string;
    image?: string;
    user?: string;
    workGroup?: number;
  }): Promise<{ endpoint: string; identity?: string }> {
    this.calls.push(`provision:${req.name}`);
    this.images.push(req.image);
    this.composition.push({ user: req.user, workGroup: req.workGroup });
    this.provisioned.set(req.name, { runId: req.runId, workflow: req.workflow });
    return { endpoint: "http://sandbox.test", identity: this.identity };
  }
  async attach(req: {
    name: string;
    spec: WorkspaceSpec;
  }): Promise<{ workdir: string; repos: Record<string, string> }> {
    this.calls.push(`attach:${req.name}`);
    const repos = Object.fromEntries(req.spec.repos.map((r) => [r.name, `/work/${r.name}/${req.spec.branch}`]));
    return { workdir: repos[req.spec.repos[0]!.name]!, repos };
  }
  async renew(name: string): Promise<{ present: false } | { present: true; identity?: string }> {
    this.calls.push(`renew:${name}`);
    if (this.failRenew) throw new Error("the API server is having a day");
    return this.present ? { present: true, identity: this.identity } : { present: false };
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
 * (final `lost`) exactly as ADR-0012's "the wrapper emits, the body decides". j2Setup-authored:
 * the wrapper PROPAGATES this vocabulary onto the exported machine (ADR-0015). */
const body = j2Setup({
  types: {} as {
    context: { handles?: { workdir: string; branch: string } };
    // Body-facing handles only (ADR-0016): endpoint/sandbox never reach workflow code.
    input: { workspace: { workdir: string; repos: Record<string, string>; branch: string } };
  },
  events: [approveDef],
}).createMachine({
  id: "body",
  context: ({ input }) => ({ handles: input.workspace }),
  initial: "working",
  states: {
    working: {
      invoke: { src: "gate", input: { gate: "hold", accepts: ["approve"] } },
      on: { approve: "done", "workspace.lost": "lost" },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ status: "done", workdir: context.handles?.workdir }),
    },
    lost: { type: "final", output: () => ({ status: "lost" }) },
  },
  // xstate v5: a machine's output is its ROOT `output`; final-state outputs ride the done event.
  output: ({ event }) => (event as { output?: unknown }).output,
});

const wrapped = workspace(body, { spec: () => ({ repos: [{ name: "app", baseRef: "main" }], branch: "feat-1" }) });

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

test("lifecycle: provision → attach → body(input+handles) → body final → destroy; output = body output", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());

  const { runId } = await host.start("ws");
  await waitFor(() => host.gates(runId).length === 1); // body parked in its Sandbox

  const name = [...sandbox.provisioned.keys()][0]!;
  assert.deepEqual(sandbox.provisioned.get(name), { runId, workflow: "ws" });
  // Parking IS retention (ADR-0012): the body is holding its gate, the Sandbox must be alive.
  assert.ok(!sandbox.calls.some((c) => c.startsWith("destroy:")));

  host.sendToGate(runId, "hold", { type: "approve" });
  await waitFor(() => host.status(runId) === undefined); // run settled + dropped from registry

  assert.deepEqual(lifecycle(sandbox), ["provision", "attach", "destroy"]);
  assert.ok(renews(sandbox) > 0, "the lease stamped while the body held its gate");
  const final = await host.read(runId);
  assert.equal(final?.status, "done");
  const ctx = final?.context as { output?: { status: string; workdir?: string } };
  assert.deepEqual(ctx.output, { status: "done", workdir: "/work/app/feat-1" });
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
  assert.deepEqual((final?.context as { output?: unknown }).output, { status: "lost" });
  assert.ok(sandbox.calls.filter((c) => c.startsWith("provision:")).length === 1, "never silently re-provisioned");
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

test("a spec deriving undefined fields (missing run input) faults BEFORE any pod exists", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  // The task-with-review shape: the mapping reads input fields this `j2 run --input` never carried.
  const sloppy = workspace(body, {
    spec: ({ input }: { input: { repo?: string; branch?: string } }) => ({
      repos: [{ name: input.repo as string, baseRef: "main" }],
      branch: input.branch as string,
    }),
  });
  host.register({ name: "sloppy", machine: sloppy, provide: () => ({}) });

  const { runId } = await host.start("sloppy", { prompt: "fix it" }); // no repo, no branch
  await waitFor(() => host.status(runId) === undefined);

  const final = await host.read(runId);
  assert.equal(final?.status, "error");
  assert.match(final?.fault ?? "", /workspace spec invalid: branch/);
  assert.match(final?.fault ?? "", /repos\[0\]\.name/);
  assert.match(final?.fault ?? "", /run input/, "the fault points back at `j2 run --input`");
  assert.ok(
    !sandbox.calls.some((c) => c.startsWith("provision:")),
    "faulted before the port — a bad spec never costs a pod",
  );
});

test("spec.image: the NAME reaches the port untouched; a malformed one faults before any pod", async () => {
  // ADR-0037: what the Sandbox is MADE OF is spec vocabulary now, but only as a NAME — resolution
  // to a ref is the port's, so the Machine stays cluster-agnostic and no content-addressed tag ever
  // lands in a snapshot.
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const named = workspace(body, {
    spec: () => ({ repos: [{ name: "app", baseRef: "main" }], branch: "b", image: "rust" }),
  });
  host.register({ name: "named", machine: named, provide: () => ({}) });

  const { runId } = await host.start("named");
  await waitFor(() => host.gates(runId).length === 1);
  assert.deepEqual(sandbox.images, ["rust"]);

  // Shape only — an image that does not EXIST is unknowable here (the map lives in the cluster),
  // so that failure belongs to provision.
  const bad = new FakeSandbox();
  const host2 = new RunHost({ store: await mkStore(), sandbox: bad });
  const empty = workspace(body, {
    spec: () => ({ repos: [{ name: "app", baseRef: "main" }], branch: "b", image: "" as string }),
  });
  host2.register({ name: "empty", machine: empty, provide: () => ({}) });
  const run2 = await host2.start("empty");
  await waitFor(() => host2.status(run2.runId) === undefined);
  assert.match((await host2.read(run2.runId))?.fault ?? "", /workspace spec invalid: image \(got ""\)/);
  assert.deepEqual(bad.calls, [], "a bad spec never costs a pod");

  // baseRef is OPTIONAL (absent → the repo's own default branch, resolved at attach) but
  // present-and-empty is still the derives-from-input bug assertSpec exists to catch.
  const ok = new FakeSandbox();
  const host3 = new RunHost({ store: await mkStore(), sandbox: ok });
  const noRef = workspace(body, { spec: () => ({ repos: [{ name: "app" }], branch: "b" }) });
  host3.register({ name: "noRef", machine: noRef, provide: () => ({}) });
  const run3 = await host3.start("noRef");
  await waitFor(() => host3.gates(run3.runId).length === 1);

  const bad4 = new FakeSandbox();
  const host4 = new RunHost({ store: await mkStore(), sandbox: bad4 });
  const emptyRef = workspace(body, {
    spec: () => ({ repos: [{ name: "app", baseRef: "" as string }], branch: "b" }),
  });
  host4.register({ name: "emptyRef", machine: emptyRef, provide: () => ({}) });
  const run4 = await host4.start("emptyRef");
  await waitFor(() => host4.status(run4.runId) === undefined);
  assert.match((await host4.read(run4.runId))?.fault ?? "", /baseRef \(got ""\)/);
  assert.deepEqual(bad4.calls, [], "a bad spec never costs a pod");
});

test("pod composition rides the spec: `user` and `workGroup` reach the port, malformed ones fault first", async () => {
  // ADR-0005/0037: what the Sandbox is MADE OF is the wrapper's business in the same way its
  // worktrees are — workflow configuration still never enters the spec. A registry REF is as
  // persistable as a dirname: both are stable NAMES, and only a resolved content-addressed tag
  // (which lives on the port's side) would outlive the image it names.
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  const composed = workspace(body, {
    spec: () => ({
      repos: [{ name: "app", baseRef: "main" }],
      branch: "b",
      image: "ghcr.io/acme/toolchain:2024-11",
      user: "sshd",
      workGroup: 4000,
    }),
  });
  host.register({ name: "composed", machine: composed, provide: () => ({}) });
  const { runId } = await host.start("composed");
  await waitFor(() => host.gates(runId).length === 1);
  assert.deepEqual(sandbox.images, ["ghcr.io/acme/toolchain:2024-11"]);
  assert.deepEqual(sandbox.composition, [{ user: "sshd", workGroup: 4000 }]);

  // A gid that is not an integer becomes a pod the API server rejects at admission — which
  // surfaces as "never reached Ready" with nothing pointing back at the run input.
  const bad = new FakeSandbox();
  const host2 = new RunHost({ store: await mkStore(), sandbox: bad });
  const wrong = workspace(body, {
    spec: () => ({ repos: [{ name: "app", baseRef: "main" }], branch: "b", workGroup: 2000.5 }),
  });
  host2.register({ name: "wrong", machine: wrong, provide: () => ({}) });
  const run2 = await host2.start("wrong");
  await waitFor(() => host2.status(run2.runId) === undefined);
  assert.match((await host2.read(run2.runId))?.fault ?? "", /workGroup \(got 2000\.5; want a gid\)/);
  assert.deepEqual(bad.calls, [], "a bad spec never costs a pod");
});

test("a terminal fault leaves the pod inspectable and stamps no lease (idle GC reaps it)", async () => {
  const sandbox = new FakeSandbox();
  sandbox.attach = async () => {
    throw new Error("attach exploded");
  };
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());

  const { runId } = await host.start("ws");
  await waitFor(() => host.status(runId) === undefined);

  assert.equal((await host.read(runId))?.status, "error");
  // Provisioned, then faulted: no destroy (the pod stays inspectable — ADR-0012). Nothing
  // releases anything, because the lease lives in `running` and this run never got there —
  // so the CR is unleased from birth and the operator's idle GC reaps it on schedule.
  assert.ok(sandbox.calls.some((c) => c.startsWith("provision:")));
  assert.ok(!sandbox.calls.some((c) => c.startsWith("destroy:")));
  assert.equal(renews(sandbox), 0);
});

test("the lease stops with the run — no process-global timer outlives the actor", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());

  const { runId } = await host.start("ws");
  await waitFor(() => host.gates(runId).length === 1);
  await waitFor(() => renews(sandbox) > 0);

  await host.stop(runId);
  const settled = renews(sandbox);
  await new Promise((r) => setTimeout(r, sandbox.leaseIntervalMs * 6));

  assert.equal(renews(sandbox), settled, "stopping the run stopped its lease");
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
  assert.deepEqual((final?.context as { output?: unknown }).output, { status: "lost" });
  assert.ok(
    sandbox.calls.some((c) => c.startsWith("destroy:")),
    "tore down through the normal path",
  );
});

test("live replacement: same CR, new pod identity → workspace.lost (the emptyDir went with it)", async () => {
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());

  const { runId } = await host.start("ws");
  await waitFor(() => host.gates(runId).length === 1);

  // Eviction or node loss: the operator recreates the Pod under the same name, so the CR is
  // present and the endpoint still resolves — but `work` is a fresh emptyDir, so every clone,
  // worktree, and unpushed commit is gone. Presence alone cannot see this; identity can.
  sandbox.identity = "pod-2";

  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.deepEqual((final?.context as { output?: unknown }).output, { status: "lost" });
  assert.equal(
    sandbox.calls.filter((c) => c.startsWith("provision:")).length,
    1,
    "never silently re-provisioned into an inconsistent world",
  );
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
  // The named fix must exist: the data-plane switch is a non-empty `repos` (server.ts), and the
  // converging command is `j2 up` (ADR-0019/0031) — not the retired `sandbox` config key.
  assert.match(final?.fault ?? "", /`repos` in j2\.config\.ts/);
  assert.match(final?.fault ?? "", /`j2 up`/);
});

test("ambient resolution (ADR-0016): an Agent inside a workspace finds endpoint + sandbox itself", async () => {
  // The body invokes its Agent with NO endpoint and NO sandbox: both must resolve from the
  // enclosing wrapper via the parent chain — and the registration must record the wrapper's
  // Sandbox (the ADR-0013 token scope) with zero workflow plumbing.
  const endpoints: string[] = [];
  const ambientBody = j2Setup({
    types: {} as { context: Record<string, never>; input: { workspace: { workdir: string } } },
    events: [approveDef],
    actors: {
      coder: agentActorWith(
        (endpoint: string) => {
          endpoints.push(endpoint);
          return new MockFlueClient();
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
        invoke: {
          src: "coder",
          input: { instanceId: "amb-1", prompt: "go", tools: [] },
        },
        on: { approve: "done" },
      },
      done: { type: "final" },
    },
  });
  const wrappedAmbient = workspace(ambientBody, {
    spec: () => ({ repos: [{ name: "app", baseRef: "main" }], branch: "amb" }),
  });

  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "amb", machine: wrappedAmbient, provide: () => ({}) });
  const { runId } = await host.start("amb");

  await waitFor(() => endpoints.length === 1);
  assert.deepEqual(endpoints, ["http://sandbox.test"], "the wrapper's endpoint, never threaded by the workflow");

  const surface = host.agentSurface("amb-1");
  const crName = [...sandbox.provisioned.keys()][0]!;
  assert.equal(surface?.sandbox, crName, "the registration records the ENCLOSING wrapper's Sandbox (ADR-0013)");
  assert.ok(host.status(runId), "run parked on the mock agent, alive");
});
