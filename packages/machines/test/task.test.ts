// Mechanics assertions for `task` (ADR-0054), driven through a REAL RunHost against the kit's
// public seams only — a mock AgentRunPort behind the Machine's own `coder` slot and a fake
// SandboxPort — so the door, the walk's view of the Open parts, the pinned conversation's identity
// across a Gate round trip, and the two settlements are exercised the way a run experiences them,
// socket-free. No cluster, no Harness, no wire.
//
// This is the DEFAULT-GATE half of the Machine's cover. It does not stand in for the `@kind`
// scenario (ADR-0054's first Consequence): the only proof a shipped Machine works in jr2 is the
// stock Harness driving it in a real Sandbox, and that tier is where the Turn loop actually runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnyStateMachine } from "xstate";
import {
  agentActorWith,
  asMachine,
  customize,
  isAgent,
  inputSchemaOf,
  partsOf,
  requireBoundAgent,
  RunHost,
  SqliteSnapshotStore,
  type AgentAdmission,
  type AgentAdmitOptions,
  type AgentDefinition,
  type AgentRunInput,
  type AgentRunPort,
  type ProvisionedRepo,
  type SandboxPort,
  type WorkflowDef,
  type WorkspaceSpec,
} from "@jr2/orchestrator";
import { task } from "../src/task.ts";

const REPO = "https://github.com/acme/app.git";
const MODEL = "anthropic/claude-sonnet-4-6";
const PROMPT = "Add a --json flag to the status command";

/** The consumer line, once (ADR-0054): both Open parts bound, exactly as a `workflows/` file
 * would write it. Everything below runs against the Machine this produces, because an unbound
 * `task` is a Machine no run may start — which is the point of it being Open. */
const bound = customize(task, { repos: { target: { url: REPO } }, agents: { coder: { model: MODEL } } });

/** A hand-driven AgentRunPort: records admissions, holds every settlement open until the test
 * ends the turn (a delivered pick) or fails it by hand (the fault path), resolves aborts. */
class MockPort implements AgentRunPort {
  admits: AgentRunInput[] = [];
  /** The definition each admission carried (ADR-0049) — the Machine's, not the persisted input's. */
  definitions: AgentDefinition[] = [];
  private seq = 0;
  private readonly settles = new Map<string, (err: unknown) => void>();

  admit(input: AgentRunInput, opts: AgentAdmitOptions): Promise<AgentAdmission> {
    this.admits.push(input);
    this.definitions.push(opts.definition);
    const n = ++this.seq;
    return Promise.resolve({ streamUrl: `http://mock/${input.instanceId}`, offset: `o-${n}`, submissionId: `s-${n}` });
  }
  settle(admission: AgentAdmission): Promise<void> {
    return new Promise((_resolve, reject) => this.settles.set(admission.submissionId, reject));
  }
  abort(): Promise<void> {
    return Promise.resolve();
  }
  /** Settle the nth (0-based) admission FAILED — an infra fault after the turn's own retries, which
   * the actor absorbs into the one terminal `agent.fault` (ADR-0016/0027). */
  fail(nth: number, reason: string): void {
    const reject = this.settles.get(`s-${nth + 1}`);
    assert.ok(reject, `admission ${nth} was never settled-followed`);
    reject(new Error(reason));
  }
}

/** The Sandbox seam, faked: deterministic endpoint, worktree paths derived from the slots. */
class FakeSandbox implements SandboxPort {
  destroyed: string[] = [];
  /** The Repo Slots each provision resolved (ADR-0051) — proof the consumer's binding arrived. */
  provisioned: ProvisionedRepo[][] = [];
  /** Every spec the wrapper attached with — the branch the Machine chose. */
  specs: WorkspaceSpec[] = [];
  readonly leaseIntervalMs = 60_000;
  async provision(req: { repos: ProvisionedRepo[] }): Promise<{ endpoint: string }> {
    this.provisioned.push(req.repos);
    return { endpoint: "http://sandbox.test" };
  }
  async attach(req: {
    name: string;
    spec: WorkspaceSpec;
    repos: Array<{ slot: string }>;
  }): Promise<{ repos: Record<string, string> }> {
    this.specs.push(req.spec);
    const repos = Object.fromEntries(req.repos.map((r) => [r.slot, `/work/${r.slot}/${req.spec.branch}`]));
    return { repos };
  }
  async renew(): Promise<{ present: true }> {
    return { present: true };
  }
  async destroy(name: string): Promise<void> {
    this.destroyed.push(name);
  }
}

/**
 * The unit-test seam (ADR-0049): replace the `coder` SLOT with the same Agent over a mock port.
 * The definition is read back off the slot the bound Machine carries, so these tests run the
 * instructions and the model the package + the `customize` line actually produced — and they break
 * if either stops being what the Machine says it is.
 *
 * `provide()` through the wrapper reaches the body because `body` is a named slot (ADR-0049), and
 * the parts the wrapper carries — the door, the Repo Slots, the vocabulary — ride `machine.config`,
 * which `provide()` passes through unchanged (ADR-0011). So this is the SAME Machine, with one
 * slot's transport swapped.
 */
function wire(machine: AnyStateMachine, port: MockPort, endpoints: string[]): AnyStateMachine {
  const substitute = (target: AnyStateMachine, actors: Record<string, unknown>): AnyStateMachine =>
    target.provide(actors as Parameters<AnyStateMachine["provide"]>[0]);
  const body = asMachine((machine.implementations.actors as Record<string, unknown>).body);
  assert.ok(body, "task is a workspace() wrapper over a named `body` slot");
  const logic = (body.implementations.actors as Record<string, unknown>).coder;
  assert.ok(isAgent(logic), "the body carries a `coder` Agent slot");
  // Through the same fence the actor uses (ADR-0054): a mock port cannot rescue an Open model, and
  // the refusal here would name the missing `customize` line rather than fail as a wire 400.
  const definition = requireBoundAgent("coder", logic.definition);
  return substitute(machine, {
    actors: {
      body: substitute(body, {
        actors: {
          coder: agentActorWith((endpoint) => {
            endpoints.push(endpoint);
            return port;
          }, definition),
        },
      }),
    },
  });
}

async function mkStore(): Promise<SqliteSnapshotStore> {
  const store = new SqliteSnapshotStore(":memory:");
  await store.init();
  return store;
}

async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: predicate never became true");
}

/** One run of the bound Machine over both fakes, started and waiting on its first Turn. */
async function startRun(input: Record<string, unknown>, machine: AnyStateMachine = bound) {
  const port = new MockPort();
  const endpoints: string[] = [];
  const sandbox = new FakeSandbox();
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "task", machine: wire(machine, port, endpoints), provide: () => ({}) } satisfies WorkflowDef);
  const { runId, instanceId } = await host.start("task", input);
  await waitFor(() => port.admits.length === 1);
  return { port, endpoints, sandbox, host, runId, instanceId };
}

// --- The door (ADR-0033) -------------------------------------------------------------------------

test("the door demands a prompt and nothing else (ADR-0054)", () => {
  const door = inputSchemaOf(task);
  assert.ok(door, "task declares its run input on the workspace() that is its root");
  assert.equal(door.safeParse({}).success, false, "a run with no prompt is refused at the door");
  assert.equal(door.safeParse({ prompt: PROMPT }).success, true, "a prompt alone is a complete run request");
  // The branch and the two Dials are the escape hatches, never required (ADR-0018/0054).
  assert.equal(door.safeParse({ prompt: PROMPT, branch: "wip", model: "x/y", thinkingLevel: "high" }).success, true);
  assert.equal(door.safeParse({ prompt: PROMPT, thinkingLevel: "ludicrous" }).success, false);
});

// --- The Open parts, and the one line that binds them (ADR-0054) ---------------------------------

test("as shipped, the walk reports both parts Open; the consumer's customize closes both", () => {
  const shipped = partsOf([task]);
  assert.deepEqual(
    shipped.openSlots,
    [{ slot: undefined, path: [] }],
    "a package cannot know the repository — nor name the slots: the map is Open whole (ADR-0051)",
  );
  assert.deepEqual(
    shipped.openAgents.map((o) => o.slot),
    ["coder"],
    "a package cannot pay for the model",
  );
  // The path is the `customize()` route from the registered root: empty, because the root IS the
  // workspace() and jr2's wrappers are transparent — so the fix line names no `actors` nesting.
  assert.deepEqual(shipped.openSlots[0]!.path, []);
  assert.deepEqual(shipped.openAgents[0]!.path, []);
  // The Agent is still CARRIED while Open — the converge has to see it to refuse it by name.
  assert.deepEqual(
    shipped.agents.map((a) => a.name),
    ["coder"],
  );

  const consumed = partsOf([bound]);
  assert.deepEqual(consumed.openSlots, [], "the Repo Slots are named and bound");
  assert.deepEqual(consumed.openAgents, [], "the model is bound");
  assert.deepEqual(
    consumed.repos.map((r) => r.url),
    [REPO],
  );
  assert.equal(consumed.agents[0]!.definition.model, MODEL);
  // Binding leaves identity alone: the package wrote the instructions, the consumer wrote the model.
  assert.match(String(consumed.agents[0]!.definition.instructions), /`finish` exactly once/);
});

// --- The loop (ADR-0054) -------------------------------------------------------------------------

test("working → finish parks at the review Gate, with the branch and worktree a human needs", async () => {
  const { port, endpoints, sandbox, host, runId, instanceId } = await startRun({ prompt: PROMPT });

  // The first Turn: framed with the task and the geography, on the Workspace's own Harness
  // (ambient resolution — the coder writes, so its Turn lands in the pod, ADR-0031).
  const first = port.admits[0]!;
  assert.equal(first.agentName, "coder");
  assert.deepEqual(endpoints, ["http://sandbox.test"]);
  assert.deepEqual(first.tools, ["finish"], "the Menu derives from this state's agent transitions");
  assert.match(first.prompt ?? "", new RegExp(PROMPT));
  assert.match(first.prompt ?? "", /Work in \/work\/target\/jr2\/task-/);
  assert.equal(port.definitions[0]!.model, MODEL, "the admission carries the Machine's bound definition");

  // The default branch is the run's own id (ADR-0054), so two concurrent runs never collide.
  assert.deepEqual(
    sandbox.specs.map((s) => s.branch),
    [`jr2/task-${instanceId}`],
  );
  assert.deepEqual(sandbox.provisioned[0], [{ slot: "target", url: REPO, perRun: false }]);

  host.sendToAgent(first.instanceId, { type: "finish", summary: "added the flag; tests green" });
  await waitFor(() => host.gates(runId).length === 1);

  const gate = host.gates(runId)[0]!;
  assert.match(gate.gate, /review$/, "the Gate id derives from the state key — fan-out-safe");
  assert.deepEqual(gate.accepts.map((d) => d.name).sort(), ["approve", "request_changes"]);
  assert.deepEqual(gate.meta, {
    summary: "added the flag; tests green",
    branch: `jr2/task-${instanceId}`,
    worktree: `/work/target/jr2/task-${instanceId}`,
  });
  assert.equal(sandbox.destroyed.length, 0, "parking IS retention: the Sandbox is alive to exec into");
});

test("more than one slot: the first the consumer wrote is the one the coder edits, the rest are framed as reading material", async () => {
  // The map is the consumer's whole (ADR-0051): `task` names no slot, so a consumer who wants the
  // coder to read a second checkout writes a second key. The kit hands the body the slots in the
  // order they were written and reads nothing into it; "the first is the one the coder edits" is
  // THIS Machine's convention, and the body tells the coder where the rest are. No second
  // Machine, no second file.
  const LIB = "https://github.com/acme/lib.git";
  const twoRepo = customize(task, {
    repos: { target: { url: REPO }, reference: { url: LIB, ref: "v3" } },
    agents: { coder: { model: MODEL } },
  });
  const { port, sandbox } = await startRun({ prompt: PROMPT, branch: "wip" }, twoRepo);
  assert.deepEqual(sandbox.provisioned[0], [
    { slot: "target", url: REPO, perRun: false },
    { slot: "reference", url: LIB, ref: "v3", perRun: false },
  ]);
  const prompt = port.admits[0]!.prompt ?? "";
  assert.match(prompt, /Work in \/work\/target\/wip, on branch wip/);
  assert.match(prompt, /Also checked out beside it, for you to read:\n- reference: \/work\/reference\/wip/);
  assert.doesNotMatch(prompt, /- target:/, "the coder's own worktree is not listed twice");
  // The convention is ORDER, not a name: swap the keys and the coder edits the other checkout.
  const swapped = customize(task, {
    repos: { reference: { url: LIB, ref: "v3" }, target: { url: REPO } },
    agents: { coder: { model: MODEL } },
  });
  const flipped = (await startRun({ prompt: PROMPT, branch: "wip" }, swapped)).port.admits[0]!.prompt ?? "";
  assert.match(flipped, /Work in \/work\/reference\/wip, on branch wip/);
  assert.match(flipped, /for you to read:\n- target: \/work\/target\/wip/);
  // One slot: nothing beside it, so nothing is said about it.
  const one = await startRun({ prompt: PROMPT, branch: "wip" });
  assert.doesNotMatch(one.port.admits[0]!.prompt ?? "", /Also checked out/);
});

test("request_changes continues the SAME conversation, and approve ends the run and the Sandbox", async () => {
  const { port, sandbox, host, runId } = await startRun({ prompt: PROMPT, branch: "feat/json-flag" });
  const conversation = port.admits[0]!.instanceId;
  assert.equal(conversation, `${runId}/coder/coder/g0`, "the pin derives one run-scoped id");
  assert.equal(port.admits[0]!.continuation, true, "a pinned conversation opts out of the ADR-0035 reroll");

  host.sendToAgent(conversation, { type: "finish", summary: "done" });
  await waitFor(() => host.gates(runId).length === 1);
  host.sendToGate(runId, host.gates(runId)[0]!.gate, { type: "request_changes", notes: "rename the flag to --format" });
  await waitFor(() => port.admits.length === 2);

  // One human steering one Agent wants the Agent to remember what it did (ADR-0054): same
  // conversation, so the next Turn is the notes alone — the task is already in its context.
  const second = port.admits[1]!;
  assert.equal(second.instanceId, conversation, "the same conversation, across the Gate round trip");
  assert.match(second.prompt ?? "", /rename the flag to --format/);
  assert.doesNotMatch(second.prompt ?? "", new RegExp(PROMPT), "the coder is not re-briefed on what it already knows");

  host.sendToAgent(conversation, { type: "finish", summary: "renamed" });
  await waitFor(() => host.gates(runId).length === 1);
  host.sendToGate(runId, host.gates(runId)[0]!.gate, { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);

  assert.equal(sandbox.destroyed.length, 1, "reaching a final state is what tears the Workspace down");
  const final = await host.read(runId);
  assert.equal(final?.status, "done");
  const ctx = final?.context as { output?: unknown };
  assert.deepEqual(ctx.output, { outcome: "approved", branch: "feat/json-flag" });
});

test("a terminal agent.fault parks at the same Gate, and the NEXT Turn is a fresh conversation", async () => {
  const { port, host, runId } = await startRun({ prompt: PROMPT, branch: "wip" });
  assert.equal(port.admits[0]!.instanceId, `${runId}/coder/coder/g0`);

  // jr2 has already retried, nudged and rerolled (ADR-0016/0027/0035); this is the one terminal
  // telemetry, and the Machine routes it to the human rather than swallowing it.
  port.fail(0, "submission settled failed: provider unavailable");
  await waitFor(() => host.gates(runId).length === 1);
  const gate = host.gates(runId)[0]!;
  assert.deepEqual(gate.meta, {
    reason: "submission settled failed: provider unavailable",
    branch: "wip",
    worktree: "/work/target/wip",
  });

  host.sendToGate(runId, gate.gate, { type: "request_changes", notes: "try again, smaller steps" });
  await waitFor(() => port.admits.length === 2);

  // The conversation the pin named is GONE — ADR-0035 rerolls a runaway and then faults, so
  // continuing it would address a dead one. The generation is what makes the next Turn fresh…
  const second = port.admits[1]!;
  assert.equal(second.instanceId, `${runId}/coder/coder/g1`);
  // …and a fresh conversation holds nothing, so this Turn is framed from scratch: the task, the
  // geography, and the human's notes.
  assert.match(second.prompt ?? "", new RegExp(PROMPT));
  assert.match(second.prompt ?? "", /Work in \/work\/target\/wip/);
  assert.match(second.prompt ?? "", /try again, smaller steps/);
});

test("the door's Dials reach the Turn, and never touch the Agent's identity (ADR-0018)", async () => {
  const { port } = await startRun({ prompt: PROMPT, model: "openai/gpt-5", thinkingLevel: "xhigh" });
  const first = port.admits[0]!;
  assert.equal(first.model, "openai/gpt-5", "the per-run override rides the Turn");
  assert.equal(first.thinkingLevel, "xhigh");
  // The DEFINITION is untouched: `jr2 up` preflights the bound model, and the door overrides it for
  // this one run's Turns only (ADR-0054's escape hatch).
  assert.equal(port.definitions[0]!.model, MODEL);
});

test("a lost Workspace settles the run as lost rather than resuming into an empty pod (ADR-0021)", async () => {
  const port = new MockPort();
  const sandbox = new FakeSandbox();
  // Continuity broken: the CR is gone, so the lease's first renewal reports it and the body decides.
  sandbox.renew = async () => ({ present: false }) as never;
  const host = new RunHost({ store: await mkStore(), sandbox });
  host.register({ name: "task", machine: wire(bound, port, []), provide: () => ({}) } satisfies WorkflowDef);

  const { runId } = await host.start("task", { prompt: PROMPT, branch: "wip" });
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(final?.status, "done");
  assert.deepEqual((final?.context as { output?: unknown }).output, { outcome: "lost" });
});
