// Mechanics assertions for the triaged-task workflow (the ADR-0031 validation vehicle), driven
// through a REAL RunHost against the kit's public seams only — a mock AgentRunPort behind the
// Machine's own Agent slots and a fake SandboxPort — so placement (the triager's Turns land on the
// Instance Harness, everyone else's on the enclosing Workspace), the pinned conversation's
// identity, and the two routes are exercised the way a run experiences them, socket-free.
// The Instance Harness deployment itself is `j2 up`'s (deploy-tier); nothing here needs a cluster.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentActorWith,
  RunHost,
  SqliteSnapshotStore,
  vocabularyOf,
  workspace,
  type AgentAdmission,
  type AgentRunInput,
  type AgentRunPort,
  type RepoName,
  type RunFeedEvent,
  type AgentDefinition,
  type SandboxPort,
  type WorkflowDef,
  type WorkspaceSpec,
} from "@j2/orchestrator";
import { body, machine } from "../workflows/triaged-task.ts";
import { coder, reviewer, triager } from "../workflows/_agents.ts";

/** The unit-test seam (ADR-0049): replace a SLOT with the same Agent over a mock port. Placement
 * then resolves off the definition the slot carries — so these tests break if `_agents.ts` ever
 * stops declaring the triager `workspace: "none"`, which is exactly the coupling they want. */
const slot = (definition: AgentDefinition, endpoints: string[], port: AgentRunPort) =>
  agentActorWith((endpoint: string) => (endpoints.push(endpoint), port), definition);

const INSTANCE_HARNESS = "http://j2-instance-harness.coding.svc:8080";

/** A hand-driven AgentRunPort: records admits, never settles, resolves aborts immediately. */
class MockPort implements AgentRunPort {
  admits: AgentRunInput[] = [];
  private seq = 0;
  admit(input: AgentRunInput): Promise<AgentAdmission> {
    this.admits.push(input);
    const n = ++this.seq;
    return Promise.resolve({ streamUrl: `http://mock/${input.instanceId}`, offset: `o-${n}`, submissionId: `s-${n}` });
  }
  settle(): Promise<void> {
    return new Promise(() => {}); // stays live until the state stops waiting
  }
  abort(): Promise<void> {
    return Promise.resolve();
  }
}

/** The Sandbox seam, faked: deterministic endpoint, worktree paths derived from the spec. */
class FakeSandbox implements SandboxPort {
  destroyed: string[] = [];
  readonly leaseIntervalMs = 60_000;
  async provision(): Promise<{ endpoint: string }> {
    return { endpoint: "http://sandbox.test" };
  }
  async attach(req: {
    name: string;
    spec: WorkspaceSpec;
  }): Promise<{ workdir: string; repos: Record<string, string> }> {
    const repos = Object.fromEntries(req.spec.repos.map((r) => [r.name, `/work/${r.name}/${req.spec.branch}`]));
    return { workdir: repos[req.spec.repos[0]!.name]!, repos };
  }
  async renew(): Promise<{ present: true }> {
    return { present: true };
  }
  async destroy(name: string): Promise<void> {
    this.destroyed.push(name);
  }
}

async function mkStore(): Promise<SqliteSnapshotStore> {
  const store = new SqliteSnapshotStore(":memory:");
  await store.init();
  return store;
}

async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: predicate never became true");
}

// `repo` is the instance catalog's own name (ADR-0050): the door is `z.enum(repoNames(config))`,
// so anything else is refused at the door as well as by the compiler.
const RUN_INPUT = { prompt: "Make the thing", repo: "obsidian-tasks.nvim" as const, branch: "task/t-1" };

test("each Machine declares its OWN events; nothing is re-declared upward (ADR-0011, ADR-0049)", () => {
  // The top machine handles the two triage routes and no more — the body's six resolve against
  // the body, which is the Machine its gates and Menus are invoked from.
  assert.deepEqual([...(vocabularyOf(machine)?.keys() ?? [])].sort(), ["answer", "code"]);
  assert.deepEqual([...(vocabularyOf(body)?.keys() ?? [])].sort(), [
    "approve",
    "request_changes",
    "request_review",
    "review",
    "review_verdict",
    "ship",
  ]);
});

test('"answer" finishes the run on the Instance Harness alone — no Workspace ever (ADR-0031)', async () => {
  const port = new MockPort();
  const endpoints: string[] = [];
  const host = new RunHost({ store: await mkStore(), instanceHarness: INSTANCE_HARNESS });
  // No `sandbox` on the host, deliberately: the answer route must never need one.
  host.register({
    name: "triaged-task",
    machine,
    provide: () => ({ actors: { triager: slot(triager, endpoints, port) } }),
  } satisfies WorkflowDef);

  const { runId } = await host.start("triaged-task", RUN_INPUT);
  const feed: RunFeedEvent[] = [];
  host.subscribe(runId, (e) => feed.push(e));
  await waitFor(() => port.admits.length === 1);

  // The triage Turn: the pinned conversation's deterministic iid, the Instance Harness (the
  // definition says "none"; no workspace() encloses anything here), and the two-route menu.
  const triage = port.admits[0]!;
  assert.equal(triage.agentName, "triager");
  assert.equal(triage.instanceId, `${runId}/triage/triager`);
  assert.deepEqual([...triage.tools].sort(), ["answer", "code"]);
  assert.deepEqual(endpoints, [INSTANCE_HARNESS]);

  host.sendToAgent(triage.instanceId, { type: "answer", answer: "It already does that; see README §2." });
  await waitFor(() => host.status(runId) === undefined);

  const final = await host.read(runId);
  assert.equal(final?.status, "done");
  const ctx = final?.context as { outcome?: string; answer?: string };
  assert.equal(ctx.outcome, "answered");
  assert.equal(ctx.answer, "It already does that; see README §2.");
  // The route rode the feed as the author's Emit — and the admission marker named the hosting
  // Harness (ADR-0023's material for the run narrative).
  assert.ok(feed.some((e) => e.kind === "emit" && e.event.type === "triage.decided" && e.event.route === "answer"));
  assert.ok(feed.some((e) => e.kind === "admission" && e.agent === "triager" && e.endpoint === INSTANCE_HARNESS));
});

test('"code" emits the route BEFORE the workspace — which this cluster-less host then refuses loudly', async () => {
  const port = new MockPort();
  const host = new RunHost({ store: await mkStore(), instanceHarness: INSTANCE_HARNESS });
  host.register({
    name: "triaged-task",
    machine,
    provide: () => ({ actors: { triager: slot(triager, [], port) } }),
  } satisfies WorkflowDef);

  const { runId } = await host.start("triaged-task", RUN_INPUT);
  const feed: RunFeedEvent[] = [];
  host.subscribe(runId, (e) => feed.push(e));
  await waitFor(() => port.admits.length === 1);

  host.sendToAgent(port.admits[0]!.instanceId, { type: "code", reason: "needs a new flag" });
  await waitFor(() => host.status(runId) === undefined);

  // The Emit landed on the feed (with the triager's reason) before the body could start — on a
  // deployed host it is therefore in the feed-so-far a Workspace attach replays as its preamble.
  const decided = feed.find((e) => e.kind === "emit" && e.event.type === "triage.decided");
  assert.ok(decided?.kind === "emit");
  assert.equal(decided.event.route, "code");
  assert.equal(decided.event.reason, "needs a new flag");
  // Entering the workspace() on a host with no Sandbox backend faults the run pointedly — the
  // code route is exactly where the cluster becomes necessary, and only there.
  const final = await host.read(runId);
  assert.equal(final?.status, "error");
  assert.match(final?.fault ?? "", /no Sandbox backend/);
});

test("inside the body: the assess Turn CONTINUES the triage conversation on the Instance Harness", async () => {
  // The body under a real workspace() over the fake Sandbox port. `provide()` cannot reach an
  // inline-invoked machine's slots, so the mock is provided on the exported body. The vocabulary
  // rides through `.provide()` untouched — it is keyed on the machine's config, which xstate
  // passes into the clone (ADR-0011: parts resolve through the live actor's logic).
  const port = new MockPort();
  const endpoints: string[] = [];
  const provided = body.provide({
    actors: {
      coder: slot(coder, endpoints, port),
      reviewer: slot(reviewer, endpoints, port),
      triager: slot(triager, endpoints, port),
    },
  });
  const wrapped = workspace(provided, {
    spec: ({ input }: { input: { repo: RepoName; branch: string } }) => ({
      repos: [{ name: input.repo, baseRef: "main" }],
      branch: input.branch,
    }),
  });

  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox, instanceHarness: INSTANCE_HARNESS });
  host.register({ name: "triaged-body", machine: wrapped, provide: () => ({}) });

  const { runId } = await host.start("triaged-body", { ...RUN_INPUT, reason: "needs a new flag", reviewRounds: 3 });
  await waitFor(() => port.admits.length === 1);

  // Turn 1 — the coder, on the Workspace's own Harness (ambient resolution, `workspace` default).
  const coding = port.admits[0]!;
  assert.equal(coding.agentName, "coder");
  assert.equal(endpoints[0], "http://sandbox.test");
  host.sendToAgent(coding.instanceId, { type: "request_review", summary: "flag added, tests green" });
  await waitFor(() => port.admits.length === 2);

  // Turn 2 — assess: the SAME triager conversation (the pin derives the exact iid the top
  // machine's triage state mints for this run), on the Instance Harness even though a
  // workspace() encloses the invocation (definition-wins, ADR-0031).
  const assess = port.admits[1]!;
  assert.equal(assess.agentName, "triager");
  assert.equal(assess.instanceId, `${runId}/triage/triager`);
  assert.equal(endpoints[1], INSTANCE_HARNESS);
  assert.deepEqual([...assess.tools].sort(), ["review", "ship"]);
  assert.match(assess.prompt ?? "", /flag added, tests green/);

  // Route to a review round; the verdict sends it back to the coder (round cap arithmetic as
  // task-with-review), and the NEXT assess continues the same conversation again.
  host.sendToAgent(assess.instanceId, { type: "review" });
  await waitFor(() => port.admits.length === 3);
  const reviewing = port.admits[2]!;
  assert.equal(reviewing.agentName, "reviewer");
  assert.equal(endpoints[2], "http://sandbox.test", "the reviewer reads in the Workspace");
  host.sendToAgent(reviewing.instanceId, { type: "review_verdict", verdict: "changes_requested", notes: "rename it" });
  await waitFor(() => port.admits.length === 4);
  assert.equal(port.admits[3]!.agentName, "coder");
  assert.match(port.admits[3]!.prompt ?? "", /rename it/);
  host.sendToAgent(port.admits[3]!.instanceId, { type: "request_review", summary: "renamed" });
  await waitFor(() => port.admits.length === 5);
  assert.equal(port.admits[4]!.instanceId, `${runId}/triage/triager`, "one conversation, every round");
  assert.equal(endpoints[4], INSTANCE_HARNESS);

  // Ship: straight to the ONE humanReview gate, which is where the human accepts the work.
  host.sendToAgent(port.admits[4]!.instanceId, { type: "ship" });
  await waitFor(() => host.gates(runId).length === 1);
  const gate = host.gates(runId)[0]!;
  // The gate id derives from the actor path (wrapper invoke id + state key) — run-scoped and
  // fan-out-safe by construction; callers discover it, as `j2 status` would.
  assert.match(gate.gate, /humanReview$/);
  assert.equal((gate.meta as { reason?: string }).reason, "shipped");

  host.sendToGate(runId, gate.gate, { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);
  assert.equal(sandbox.destroyed.length, 1, "final tears the Workspace down");
  const final = await host.read(runId);
  assert.equal(final?.status, "done");
  const ctx = final?.context as { output?: { outcome?: string; branch?: string } };
  assert.deepEqual(ctx.output, { outcome: "approved", branch: "task/t-1" });
});
