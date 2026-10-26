// A mechanism event must have a route (ADR-0074): the walk refuses a state that invokes an Agent
// with no `agent.fault` route on itself or an ancestor, and a non-final state of a `workspace()`
// body with no `workspace.lost` route; at runtime, a mechanism event that no transition took faults
// the run `error`. The `workspace.lost` runtime half, through a real Workspace and a fake Sandbox
// port, is in workspace.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromCallback, setup, type AnyStateMachine } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { agent } from "../src/harness-client.ts";
import { unroutedMechanismEvent } from "../src/mechanism-routes.ts";
import { partsOf } from "../src/parts.ts";
import { RunHost, type RunStatus, type WorkflowDef } from "../src/run-host.ts";
import { openBody } from "../src/open-body.ts";
import { jr2Setup } from "../src/setup.ts";
import { workspace } from "../src/workspace.ts";
import { mkStore, waitFor } from "./_fixtures.ts";

const coder = agent({ model: "stub/model", instructions: "You code." });
const finish = defineEvent({ name: "finish", input: z.object({}) });
const repos = { app: "https://example.test/app.git" };
const spec = () => ({ branch: "b" });

// --- The walk: agent.fault --------------------------------------------------------------------------

const UNROUTED_FAULT =
  /machine "m": state "m\.outer\.coding" invokes an Agent, and no route for "agent\.fault" is on it or on a state above — jr2 sends agent\.fault when the Agent's Turn cannot go on, and with no route the run faults: route it on that state or on a state above it, as on: \{ "agent\.fault": "<the state that handles it>" \} \(ADR-0074\)$/;

/** A Machine whose Agent's state is `outer.coding`, with `on` at the root, `outer` or `coding`. */
const agentMachine = (at: { root?: object; outer?: object; coding?: object } = {}) => ({
  id: "m",
  ...(at.root ? { on: at.root } : {}),
  initial: "outer",
  states: {
    outer: {
      ...(at.outer ? { on: at.outer } : {}),
      initial: "coding",
      states: {
        coding: {
          invoke: { src: "coder", input: { prompt: "go" } },
          on: { finish: "#m.done", ...(at.coding ?? {}) },
        },
      },
    },
    done: { type: "final" as const },
    faulted: { type: "final" as const },
  },
});

const build = (config: object) => jr2Setup({ events: [finish], actors: { coder } }).createMachine(config as never);

test("jr2Setup's createMachine refuses a state that invokes an Agent with no agent.fault route, and names the fix", () => {
  assert.throws(() => build(agentMachine()), UNROUTED_FAULT);
});

test("one agent.fault route on the state, on a state above it or on the root satisfies the walk", () => {
  build(agentMachine({ coding: { "agent.fault": "#m.faulted" } }));
  build(agentMachine({ outer: { "agent.fault": "#m.faulted" } }));
  build(agentMachine({ root: { "agent.fault": ".faulted" } }));
  // A wildcard takes the event, as it does at runtime.
  build(agentMachine({ root: { "agent.*": ".faulted" } }));
  // A route with actions only counts: it can be a deliberate re-entry. jr2 does not judge it.
  build(agentMachine({ coding: { "agent.fault": { actions: () => {} } } }));
  build(agentMachine({ coding: { "agent.fault": { target: "#m.outer.coding", reenter: true } } }));
});

test("the refusal names every state that invokes an Agent with no route, in document order", () => {
  assert.throws(
    () =>
      build({
        id: "two",
        initial: "a",
        states: {
          a: { invoke: { src: "coder", input: { prompt: "a" } }, on: { finish: "b" } },
          b: { invoke: { src: "coder", input: { prompt: "b" } }, on: { finish: "c" } },
          c: { type: "final" },
        },
      }),
    /machine "two": states "two\.a", "two\.b" invoke an Agent, and no route for "agent\.fault" is on them or on a state above/,
  );
});

test("the load walk refuses the same shape in a Machine built with xstate's setup(), also as an invoked child", () => {
  const plain = setup({ actors: { coder } }).createMachine(agentMachine() as never) as unknown as AnyStateMachine;
  assert.throws(() => partsOf([plain]), UNROUTED_FAULT);
  const parent = setup({ actors: { child: plain } }).createMachine({
    id: "parent",
    initial: "running",
    states: { running: { invoke: { src: "child", onDone: "done" } }, done: { type: "final" } },
  });
  assert.throws(() => partsOf([parent]), UNROUTED_FAULT);
});

test("a state that invokes no Agent needs no agent.fault route", () => {
  jr2Setup({ events: [finish] }).createMachine({
    id: "gated",
    initial: "waiting",
    states: { waiting: { invoke: { src: "gate" }, on: { finish: "done" } }, done: { type: "final" } },
  });
});

/** A Chart wrapper whose `run` state invokes an Open body that lends and allows what `decl` says. */
const wrapper = (lends: { agents?: string[] }, models: string[], on?: object) =>
  jr2Setup({
    events: [],
    actors: {
      coder,
      body: openBody({
        lends,
        allows: { models, workspace: models.length ? ["none"] : [] },
        ceilings: { turns: 4, wallClock: "5m", transitions: 100, fanOut: 1, size: 65536 },
      }),
    },
  }).createMachine({
    id: "w",
    ...(on ? { on } : {}),
    initial: "run",
    states: { run: { invoke: { src: "body", input: {} } }, faulted: { type: "final" } },
  } as never);

const UNROUTED_BODY =
  /machine "w": state "w\.run" invokes an Open body that can run an Agent, and no route for "agent\.fault" is on it or on a state above/;

test("the walk refuses a state that invokes an Open body that lends an Agent or allows a model, with no agent.fault route", () => {
  // The Open body sends a Chart's unrouted agent.fault to the Machine that invoked it.
  assert.throws(() => wrapper({ agents: ["coder"] }, []), UNROUTED_BODY);
  assert.throws(() => wrapper({}, ["stub/model"]), UNROUTED_BODY);
  wrapper({ agents: ["coder"] }, ["stub/model"], { "agent.fault": ".faulted" });
});

test("one refusal line names the Agent states and the Open body states with no route", () => {
  const both = () =>
    jr2Setup({
      events: [finish],
      actors: {
        coder,
        body: openBody({
          lends: { agents: ["coder"] },
          allows: { models: [], workspace: [] },
          ceilings: { turns: 4, wallClock: "5m", transitions: 100, fanOut: 1, size: 65536 },
        }),
      },
    }).createMachine({
      id: "w",
      initial: "code",
      states: {
        code: { invoke: { src: "coder", input: { prompt: "go" } }, on: { finish: "run" } },
        run: { invoke: { src: "body", input: {} } },
      },
    } as never);
  assert.throws(
    both,
    /machine "w": state "w\.code" invokes an Agent, and state "w\.run" invokes an Open body that can run an Agent, and no route for "agent\.fault" is on them or on a state above/,
  );
});

test("an Open body that can run no Agent needs no agent.fault route", () => {
  wrapper({}, []);
});

// --- The walk: workspace.lost -----------------------------------------------------------------------

test("workspace() refuses a body with a non-final state that has no workspace.lost route, and names the fix", () => {
  const body = setup({}).createMachine({
    id: "body",
    initial: "working",
    states: {
      working: { initial: "a", states: { a: { on: { NEXT: "b" } }, b: {} } },
      done: { type: "final" },
    },
  });
  assert.throws(
    () => workspace(body, { repos, spec }),
    /workspace\(\): the body "body" has states "body\.working\.a", "body\.working\.b" that are not final, and no route for "workspace\.lost" is on them or on a state above — jr2 sends workspace\.lost to the body when its Sandbox is gone, and with no route the run faults: route it on the body's root, as on: \{ "workspace\.lost": "<the state that handles it>" \} \(ADR-0074\)$/,
  );
  // A body with no state of its own is its root, and the root is not final.
  assert.throws(
    () => workspace(setup({}).createMachine({ id: "bare" }), { repos, spec }),
    /workspace\(\): the body "bare" has a state "bare" that is not final/,
  );
});

test("one workspace.lost route on the body's root, or above each state that is not final, satisfies workspace()", () => {
  const states = {
    working: { initial: "a", states: { a: { on: { NEXT: "b" } }, b: {} } },
    done: { type: "final" as const },
    lost: { type: "final" as const },
  };
  workspace(setup({}).createMachine({ id: "root", on: { "workspace.lost": ".lost" }, initial: "working", states }), {
    repos,
    spec,
  });
  workspace(
    setup({}).createMachine({
      id: "above",
      initial: "working",
      states: { ...states, working: { ...states.working, on: { "workspace.lost": "lost" } } },
    }),
    { repos, spec },
  );
  // Actions only: a route all the same.
  workspace(setup({}).createMachine({ id: "kept", on: { "workspace.lost": { actions: () => {} } } }), {
    repos,
    spec,
  });
});

test("workspace() refuses a body that can stay in a compound state whose final child has no workspace.lost route", () => {
  // `checking` has no onDone, so at `checking.passed` the body stays in `checking`: the line names it.
  const stays = setup({}).createMachine({
    id: "stays",
    initial: "checking",
    states: {
      checking: {
        initial: "running",
        states: { running: { on: { "workspace.lost": "#stays.lost", PASS: "passed" } }, passed: { type: "final" } },
      },
      lost: { type: "final" },
    },
  });
  assert.throws(
    () => workspace(stays, { repos, spec }),
    /workspace\(\): the body "stays" has a state "stays\.checking" that is not final, and no route for "workspace\.lost"/,
  );
  // With an onDone, the body leaves `checking` at once: a final child there needs no route.
  workspace(
    setup({}).createMachine({
      id: "leaves",
      initial: "checking",
      states: {
        checking: {
          initial: "running",
          onDone: "done",
          states: { running: { on: { "workspace.lost": "#leaves.lost", PASS: "passed" } }, passed: { type: "final" } },
        },
        done: { type: "final" },
        lost: { type: "final" },
      },
    }),
    { repos, spec },
  );
  // A final state of a parallel region is not judged: the other regions stay active.
  workspace(
    setup({}).createMachine({
      id: "regions",
      type: "parallel",
      states: {
        a: { initial: "x", states: { x: { on: { "workspace.lost": {}, GO: "y" } }, y: { type: "final" } } },
        b: { initial: "x", states: { x: { on: { "workspace.lost": {} } } } },
      },
    }),
    { repos, spec },
  );
});

// --- The runtime ------------------------------------------------------------------------------------

/** A Machine whose child sends `agent.fault` at once, and whose route for it is `route`. It invokes no
 * Agent, so the walk does not judge the route: the runtime half alone. */
const faulting = (route: unknown) =>
  jr2Setup({
    events: [],
    actors: {
      faulter: fromCallback(({ sendBack }) => {
        queueMicrotask(() => sendBack({ type: "agent.fault", instanceId: "i-1", reason: "the budget is spent" }));
      }),
    },
  }).createMachine({
    id: "faulting",
    initial: "working",
    states: {
      working: { invoke: { src: "faulter" }, on: { "agent.fault": route as never } },
      faulted: { type: "final" },
    },
  });

async function run(machine: unknown): Promise<{ host: RunHost; runId: string }> {
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "w", machine: machine as never, provide: () => ({}) } satisfies WorkflowDef);
  const { runId } = await host.start("w");
  return { host, runId };
}

async function settled(host: RunHost, runId: string): Promise<RunStatus> {
  await waitFor(() => host.status(runId) === undefined);
  return (await host.read(runId))!;
}

test("an agent.fault whose route's guard is false faults the run `error`, naming the event, the state and the reason", async () => {
  const { host, runId } = await run(faulting({ guard: () => false, target: "faulted" }));
  const final = await settled(host, runId);
  assert.equal(final.status, "error");
  assert.equal(
    final.fault,
    'machine "faulting" got "agent.fault" in state "working", and no transition took it (the budget is spent) — no route for "agent.fault" is on that state or on a state above, or the guard of each route was false: route it with a transition that is always taken (ADR-0074)',
  );
  assert.equal(final.output, undefined, "a fault is not a Failure: no output");
});

test("an agent.fault that a route takes, with a target or with actions only, does not fault the run", async () => {
  const routed = await run(faulting("faulted"));
  assert.equal((await settled(routed.host, routed.runId)).status, "done");

  let taken = 0;
  const kept = await run(faulting({ actions: () => void taken++ }));
  await waitFor(() => taken === 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(kept.host.status(kept.runId)?.status, "active", "the run stays live in its state");
  await kept.host.stop(kept.runId);
});

test("the runtime check reads only an agent.fault or a workspace.lost that took no transition", () => {
  const ref = { id: "x", getSnapshot: () => ({ status: "active", value: "a" }), logic: { id: "m" } };
  const ev = (type: string, transitions: unknown[]) => ({ actorRef: ref, event: { type }, _transitions: transitions });
  assert.equal(unroutedMechanismEvent(ev("finish", [])), undefined, "a pick no state took is xstate's to drop");
  assert.equal(unroutedMechanismEvent(ev("agent.fault", [{}])), undefined);
  assert.match(unroutedMechanismEvent(ev("agent.fault", []))!, /^machine "m" got "agent\.fault" in state "a"/);
  assert.match(
    unroutedMechanismEvent(ev("workspace.lost", []))!,
    /^machine "m" got "workspace\.lost" in state "a", and no transition took it \(no reason given\)/,
  );
  const done = { ...ref, getSnapshot: () => ({ status: "done" }) };
  assert.equal(
    unroutedMechanismEvent({ actorRef: done, event: { type: "agent.fault" }, _transitions: [] }),
    undefined,
    "a Machine that is over takes nothing",
  );
});
