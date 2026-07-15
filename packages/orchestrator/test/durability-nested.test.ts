// GAP(5): nested durability. Bodies own their durable agent handles (`context.offsets` lives in
// the CHILD machine, not the run root), so two host behaviors carry restore at depth:
//   1. persistence rides the actor system's INSPECTION stream — a grandchild `agent.offset`
//      assigned into the body's context never notifies root subscribers, but must hit the store;
//   2. `reattachAgentRuns` walks the snapshot TREE, each machine level's `context.offsets`
//      scoping the agentRun child-input rewrites below it (drop `prompt`, set `attachOffset`).
// Both the invoke'd-child and spawnChild'd-child shapes are proven end-to-end through a real
// RunHost pair sharing one store — the exact orchestrator-restart sequence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, setup, spawnChild } from "xstate";
import { agentRunActorWith } from "../src/actor.ts";
import type { AgentRunInput, AgentRunPort, AgentToolCall } from "../src/actor.ts";
import { reattachAgentRuns } from "../src/durability.ts";
import { RunHost, type WorkflowDef } from "../src/run-host.ts";
import { mkStore, waitFor } from "./_fixtures.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";

type Log = { admissions: AgentRunInput[]; pushers: Array<(call: AgentToolCall) => void> };

/** An agentRun bound to a port that records every admission and exposes its stream by hand. */
function recordingAgentRun(log: Log) {
  const port: AgentRunPort = {
    admit(input, onToolCall) {
      log.admissions.push(input);
      log.pushers.push(onToolCall);
      return new Promise<void>(() => {}); // stays live until abandoned
    },
    cancel: () => Promise.resolve(),
  };
  return agentRunActorWith(() => port);
}

/** The body: its own context folds its agent's offsets (the GAP(5) shape — handles live HERE). */
function innerMachine(log: Log) {
  return setup({
    types: {} as {
      context: { iid: string; offsets: Record<string, string> };
      input: { iid: string };
      events: { type: "agent.offset"; instanceId: string; offset: string } | { type: "agent.fault" };
    },
    actors: { agentRun: recordingAgentRun(log) },
  }).createMachine({
    id: "inner",
    context: ({ input }) => ({ iid: input.iid, offsets: {} }),
    initial: "coding",
    states: {
      coding: {
        invoke: {
          id: "agentRun",
          src: "agentRun",
          input: ({ context }) => ({
            agentName: "coder",
            instanceId: context.iid,
            endpoint: "http://harness.invalid",
            prompt: "go",
            tools: [],
          }),
        },
      },
    },
    on: {
      "agent.offset": {
        actions: assign({
          offsets: ({ context, event }) => ({ ...context.offsets, [event.instanceId]: event.offset }),
        }),
      },
    },
  });
}

/** Read the body's persisted offsets out of the stored blob (whatever the child id is). */
async function storedOffsets(store: SnapshotStore, runId: string, childId: string) {
  const stored = await store.load(runId);
  const blob = stored?.snapshot as {
    snapshot?: { children?: Record<string, { snapshot?: { context?: { offsets?: Record<string, string> } } }> };
  } | null;
  return blob?.snapshot?.children?.[childId]?.snapshot?.context?.offsets;
}

test("invoke'd body: grandchild offset persists and restore re-attaches it", async () => {
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
  const log: Log = { admissions: [], pushers: [] };
  const def = defFor(log);

  const first = new RunHost({ store });
  first.register(def);
  const { runId, instanceId } = await first.start("nested");
  await waitFor(() => log.admissions.length === 1);
  assert.equal(log.admissions[0]!.prompt, "go");

  log.pushers[0]!({ name: "tool", offset: "5_2" });
  let seen: Record<string, string> | undefined;
  await waitFor(() => {
    void storedOffsets(store, runId, "body").then((o) => (seen = o));
    return seen?.[`${instanceId}/task`] === "5_2";
  });

  await first.stop(runId);

  const second = new RunHost({ store });
  second.register(def);
  const { reattached } = await second.restore();
  assert.deepEqual(reattached, [runId]);
  await waitFor(() => log.admissions.length === 2);
  assert.equal(log.admissions[1]!.instanceId, `${instanceId}/task`);
  assert.equal(log.admissions[1]!.attachOffset, "5_2", "re-attached from the body's persisted offset");
  assert.equal(log.admissions[1]!.prompt, undefined, "never re-prompted");
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
  const log: Log = { admissions: [], pushers: [] };
  const def = defFor(log);

  const first = new RunHost({ store });
  first.register(def);
  const { runId, instanceId } = await first.start("spawned");
  await waitFor(() => log.admissions.length === 1);

  log.pushers[0]!({ name: "tool", offset: "9_1" });
  let seen: Record<string, string> | undefined;
  await waitFor(() => {
    void storedOffsets(store, runId, "feature-1").then((o) => (seen = o));
    return seen?.[`${instanceId}/task`] === "9_1";
  });

  await first.stop(runId);

  const second = new RunHost({ store });
  second.register(def);
  const { reattached } = await second.restore();
  assert.deepEqual(reattached, [runId]);
  await waitFor(() => log.admissions.length === 2);
  assert.equal(log.admissions[1]!.attachOffset, "9_1");
  assert.equal(log.admissions[1]!.prompt, undefined);
});

test("reattachAgentRuns: nearest enclosing offsets win; offset-less inputs keep their prompt", () => {
  const agent = (iid: string) => ({
    instanceId: iid,
    endpoint: "http://h",
    prompt: "go",
    tools: [],
  });
  const tree = {
    context: { offsets: { "a/1": "outer", "b/1": "outer-b" } },
    children: {
      topAgent: { snapshot: { input: agent("a/1") } },
      body: {
        snapshot: {
          context: { offsets: { "a/1": "inner" } }, // shadows the outer map for its own subtree
          children: {
            deepAgent: { snapshot: { input: agent("a/1") } },
            freshAgent: { snapshot: { input: agent("never-ran") } },
            byOuterScope: { snapshot: { input: agent("b/1") } }, // inherited through the merge
          },
        },
      },
    },
  };
  const out = reattachAgentRuns(tree) as typeof tree & {
    children: Record<string, { snapshot: { input: { prompt?: string; attachOffset?: string } } }>;
  };
  const top = out.children.topAgent!.snapshot.input as { attachOffset?: string; prompt?: string };
  assert.equal(top.attachOffset, "outer");
  assert.equal(top.prompt, undefined);
  const body = (
    out.children.body!.snapshot as {
      children: Record<string, { snapshot: { input: { attachOffset?: string; prompt?: string } } }>;
    }
  ).children;
  assert.equal(body.deepAgent!.snapshot.input.attachOffset, "inner");
  assert.equal(body.byOuterScope!.snapshot.input.attachOffset, "outer-b");
  // Never admitted (no offset anywhere): keep the prompt — restore re-admits the first turn.
  assert.equal(body.freshAgent!.snapshot.input.attachOffset, undefined);
  assert.equal(body.freshAgent!.snapshot.input.prompt, "go");
});
