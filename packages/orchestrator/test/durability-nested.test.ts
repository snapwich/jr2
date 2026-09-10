// Nested durability (ADR-0016): agent invocations live in CHILD machines (a body two levels
// below the run root), but their durable handles live in the HOST ledger — one flat iid→admission
// map per run — so restore at depth needs exactly two host behaviors:
//   1. the admission is ledgered through the run binding the moment flue admits, from any
//      nesting depth (the binding rides the actor SYSTEM, shared by the whole tree);
//   2. `reattachAgentRuns` walks the snapshot TREE and rewrites every Agent child input
//      whose iid has a ledgered admission (drop `prompt`, set `attach`) — no per-level scoping.
// Both the invoke'd-child and spawnChild'd-child shapes are proven end-to-end through a real
// RunHost pair sharing one store — the exact orchestrator-restart sequence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, spawnChild } from "xstate";
import { agentActorWith } from "../src/actor.ts";
import type { AgentAdmission, AgentRunInput, AgentRunPort } from "../src/actor.ts";
import { reattachAgentRuns } from "../src/durability.ts";
import { RunHost, type WorkflowDef } from "../src/run-host.ts";
import { mkStore, waitFor } from "./_fixtures.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";

type Log = { admissions: AgentRunInput[]; settled: AgentAdmission[]; aborted: string[] };

/** An Agent slot over a port that records admits + settles and parks forever (never settles). */
function recordingAgent(log: Log) {
  let seq = 0;
  const port: AgentRunPort = {
    abort(_agentName, instanceId) {
      log.aborted.push(instanceId);
      return Promise.resolve();
    },
    admit(input) {
      log.admissions.push(input);
      return Promise.resolve({
        streamUrl: `http://h/agents/${input.agentName}/${input.instanceId}`,
        offset: `adm-${++seq}`,
        submissionId: `sub-${seq}`,
      });
    },
    settle(admission) {
      log.settled.push(admission);
      return new Promise<void>(() => {}); // stays live until abandoned
    },
  };
  return agentActorWith(() => port, { model: "test/model", instructions: "i" });
}

/** The body: the agent invocation lives HERE, two levels below the run root. */
function innerMachine(log: Log) {
  return setup({
    types: {} as { context: { iid: string }; input: { iid: string } },
    actors: { coder: recordingAgent(log) },
  }).createMachine({
    id: "inner",
    context: ({ input }) => ({ iid: input.iid }),
    initial: "coding",
    states: {
      coding: {
        // A plain `setup()` machine, deliberately: its input is already finalized (this suite is
        // about the ledger at depth, not the menu walk), so it names the Agent itself.
        invoke: {
          id: "coder",
          src: "coder",
          input: ({ context }: { context: { iid: string } }) => ({
            agentName: "coder",
            instanceId: context.iid,
            endpoint: "http://harness.invalid",
            prompt: "go",
            tools: [],
          }),
        },
      },
    },
  });
}

/** Read the run's persisted admission ledger off the stored blob. */
async function storedLedger(store: SnapshotStore, runId: string) {
  const stored = await store.load(runId);
  return (stored?.snapshot as { agents?: Record<string, AgentAdmission> } | null)?.agents;
}

test("invoke'd body: a grandchild admission is ledgered and restore re-attaches it", async () => {
  const defFor = (log: Log): WorkflowDef => {
    const inner = innerMachine(log);
    const outer = setup({ actors: { body: inner } }).createMachine({
      id: "outer",
      context: ({ input }) => ({ iid: (input as { instanceId: string }).instanceId }),
      initial: "running",
      states: {
        running: {
          invoke: { id: "body", src: "body", input: ({ context }) => ({ iid: `${context.iid}/task` }) },
        },
      },
    });
    return { name: "nested", machine: outer, provide: () => ({}) };
  };

  const store = await mkStore();
  const log: Log = { admissions: [], settled: [], aborted: [] };
  const def = defFor(log);

  const first = new RunHost({ store });
  first.register(def);
  const { runId, instanceId } = await first.start("nested");
  await waitFor(() => log.admissions.length === 1);
  assert.equal(log.admissions[0]!.prompt, "go");

  // The grandchild's admission lands in the run's FLAT host ledger (iids are globally unique).
  let ledger: Record<string, AgentAdmission> | undefined;
  await waitFor(() => {
    void storedLedger(store, runId).then((l) => (ledger = l));
    return ledger?.[`${instanceId}/task`] !== undefined;
  });
  const admission = ledger![`${instanceId}/task`]!;

  await first.stop(runId);

  const second = new RunHost({ store });
  second.register(def);
  const { reattached } = await second.restore();
  assert.deepEqual(reattached, [runId]);
  await waitFor(() => log.settled.length === 2);
  assert.equal(log.admissions.length, 1, "never re-prompted");
  assert.deepEqual(log.settled[1], admission, "re-attached from the persisted admission, at depth");
  // The host stopping a run is the ONE ending that must not end the turn (ADR-0024's exception):
  // an abort here would have killed the very submission this restore re-attached to.
  assert.deepEqual(log.aborted, [], "a host-initiated stop never aborts the durable run");
});

test("spawnChild'd body: the spawned machine restores and its agent re-attaches", async () => {
  const defFor = (log: Log): WorkflowDef => {
    const inner = innerMachine(log);
    const outer = setup({ actors: { body: inner } }).createMachine({
      id: "outerSpawn",
      context: ({ input }) => ({ iid: (input as { instanceId: string }).instanceId }),
      entry: spawnChild("body", {
        id: "feature-1",
        input: ({ context }) => ({ iid: `${(context as { iid: string }).iid}/task` }),
      }),
      initial: "running",
      states: { running: {} },
    });
    return { name: "spawned", machine: outer, provide: () => ({}) };
  };

  const store = await mkStore();
  const log: Log = { admissions: [], settled: [], aborted: [] };
  const def = defFor(log);

  const first = new RunHost({ store });
  first.register(def);
  const { runId, instanceId } = await first.start("spawned");
  await waitFor(() => log.admissions.length === 1);

  let ledger: Record<string, AgentAdmission> | undefined;
  await waitFor(() => {
    void storedLedger(store, runId).then((l) => (ledger = l));
    return ledger?.[`${instanceId}/task`] !== undefined;
  });

  await first.stop(runId);

  const second = new RunHost({ store });
  second.register(def);
  const { reattached } = await second.restore();
  assert.deepEqual(reattached, [runId]);
  await waitFor(() => log.settled.length === 2);
  assert.equal(log.admissions.length, 1, "never re-prompted");
  assert.deepEqual(log.settled[1], ledger![`${instanceId}/task`]);
});

test("reattachAgentRuns: ledgered iids re-attach at any depth; unledgered inputs keep their prompt", () => {
  const agent = (iid: string) => ({
    agentName: "coder",
    instanceId: iid,
    prompt: "go",
    tools: [],
  });
  const adm = (offset: string): AgentAdmission => ({ streamUrl: "http://h/s", offset, submissionId: `sub-${offset}` });
  const tree = {
    context: {},
    children: {
      topAgent: { snapshot: { input: agent("a/1") } },
      body: {
        snapshot: {
          context: {},
          children: {
            deepAgent: { snapshot: { input: agent("b/1") } },
            freshAgent: { snapshot: { input: agent("never-ran") } },
          },
        },
      },
    },
  };
  const out = reattachAgentRuns(tree, { "a/1": adm("A"), "b/1": adm("B") }) as {
    children: Record<string, { snapshot: { input: { prompt?: string; attach?: AgentAdmission }; children?: never } }>;
  };
  const top = out.children.topAgent!.snapshot.input;
  assert.deepEqual(top.attach, adm("A"));
  assert.equal(top.prompt, undefined);
  const body = (
    out.children.body!.snapshot as unknown as {
      children: Record<string, { snapshot: { input: { attach?: AgentAdmission; prompt?: string } } }>;
    }
  ).children;
  assert.deepEqual(body.deepAgent!.snapshot.input.attach, adm("B"), "the flat map reaches any depth");
  // Never admitted (nothing ledgered): keep the prompt — restore re-admits the first turn.
  assert.equal(body.freshAgent!.snapshot.input.attach, undefined);
  assert.equal(body.freshAgent!.snapshot.input.prompt, "go");
});
