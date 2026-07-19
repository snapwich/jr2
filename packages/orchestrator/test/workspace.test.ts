// workspace(body, spec) — ADR-0012. Driven through a REAL RunHost (store + binding + restore)
// against a fake SandboxPort at the seam, so lifecycle, input passthrough, parked-body
// retention, and the restore-reconcile `workspace.lost` path are exercised the way a run
// experiences them. The kind-backed port has its own suite; the cluster itself is e2e-tier.

import { test } from "node:test";
import assert from "node:assert/strict";
import { j2Setup } from "../src/setup.ts";
import { agentRunActorWith } from "../src/actor.ts";
import { workspace, workspaceName, type SandboxPort, type WorkspaceSpec } from "../src/workspace.ts";
import { RunHost, type WorkflowDef } from "../src/run-host.ts";
import { approveDef, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

class FakeSandbox implements SandboxPort {
  calls: string[] = [];
  provisioned = new Map<string, { runId: string; workflow: string }>();
  /** What `exists()` answers — flip to false to simulate a reaped Sandbox before a restore. */
  present = true;

  async provision(req: { name: string; runId: string; workflow: string }): Promise<{ endpoint: string }> {
    this.calls.push(`provision:${req.name}`);
    this.provisioned.set(req.name, { runId: req.runId, workflow: req.workflow });
    return { endpoint: "http://sandbox.test" };
  }
  async attach(req: {
    name: string;
    spec: WorkspaceSpec;
  }): Promise<{ workdir: string; repos: Record<string, string> }> {
    this.calls.push(`attach:${req.name}`);
    const repos = Object.fromEntries(req.spec.repos.map((r) => [r.name, `/work/${r.name}/${req.spec.branch}`]));
    return { workdir: repos[req.spec.repos[0]!.name]!, repos };
  }
  async exists(name: string): Promise<boolean> {
    this.calls.push(`exists:${name}`);
    return this.present;
  }
  async destroy(name: string): Promise<void> {
    this.calls.push(`destroy:${name}`);
  }
  async release(runId: string): Promise<void> {
    this.calls.push(`release:${runId}`);
  }
}

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

const wrapped = workspace(body, () => ({ repos: [{ name: "app", baseRef: "main" }], branch: "feat-1" }));

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

  assert.deepEqual(
    sandbox.calls.map((c) => c.split(":")[0]),
    ["provision", "attach", "exists", "destroy"], // exists = the fresh-start reconcile probe
  );
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
  const sloppy = workspace(body, ({ input }: { input: { repo?: string; branch?: string } }) => ({
    repos: [{ name: input.repo as string, baseRef: "main" }],
    branch: input.branch as string,
  }));
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

test("a terminal fault releases the run's keepalive leases (idle GC can reap what stays)", async () => {
  const sandbox = new FakeSandbox();
  sandbox.attach = async () => {
    throw new Error("attach exploded");
  };
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register(wsDef());

  const { runId } = await host.start("ws");
  await waitFor(() => host.status(runId) === undefined);

  assert.equal((await host.read(runId))?.status, "error");
  // Provisioned, then faulted: no destroy (the pod stays inspectable — ADR-0012), but the
  // lease is released so the operator's idle GC eventually reaps it.
  assert.ok(sandbox.calls.some((c) => c.startsWith("provision:")));
  assert.ok(!sandbox.calls.some((c) => c.startsWith("destroy:")));
  assert.deepEqual(
    sandbox.calls.filter((c) => c.startsWith("release:")),
    [`release:${runId}`],
  );
});

test("a host without a Sandbox backend faults a workspace() run pointedly", async () => {
  const host = new RunHost({ store: await mkStore() }); // no sandbox option
  host.register(wsDef());
  const { runId } = await host.start("ws");
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(final?.status, "error");
  assert.match(final?.fault ?? "", /no Sandbox backend/);
});

test("ambient resolution (ADR-0016): agentRun inside a workspace finds endpoint + sandbox itself", async () => {
  // The body invokes agentRun with NO endpoint and NO sandbox: both must resolve from the
  // enclosing wrapper via the parent chain — and the registration must record the wrapper's
  // Sandbox (the ADR-0013 token scope) with zero workflow plumbing.
  const endpoints: string[] = [];
  const ambientBody = j2Setup({
    types: {} as { context: Record<string, never>; input: { workspace: { workdir: string } } },
    events: [approveDef],
    actors: {
      agentRun: agentRunActorWith((endpoint) => {
        endpoints.push(endpoint);
        return new MockFlueClient();
      }),
    },
  }).createMachine({
    id: "ambient",
    context: {},
    initial: "coding",
    states: {
      coding: {
        invoke: {
          src: "agentRun",
          input: { agentName: "coder", instanceId: "amb-1", prompt: "go", tools: [] },
        },
        on: { approve: "done" },
      },
      done: { type: "final" },
    },
  });
  const wrappedAmbient = workspace(ambientBody, () => ({ repos: [{ name: "app", baseRef: "main" }], branch: "amb" }));

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
