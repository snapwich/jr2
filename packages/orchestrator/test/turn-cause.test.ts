// What took the Machine out of an Agent's state (ADR-0024, `cause.ts`): the Turn's sweep says
// `cause: "pick"` exactly when the transition that stopped the Agent's invocation came from this
// Agent's own pick — the pick in its own send, or the route of its outstanding pick's work, with the
// events that route sends at once. Anything else that ends the Turn sends a sweep with no cause: a
// timer, an outside event, another Agent's pick, a CANCEL, a fault. Socket-free, through the real
// `jr2Setup` walk and the real `RunHost`; each case reads the sweeps the Agent's client got.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assign,
  enqueueActions,
  fromCallback,
  fromPromise,
  raise,
  sendParent,
  sendTo,
  spawnChild,
  type AnyActorLogic,
  type AnyStateMachine,
} from "xstate";
import { agentActorWith } from "../src/actor.ts";
import { OutstandingError } from "../src/registration.ts";
import { fail } from "../src/fail.ts";
import { jr2Setup } from "../src/setup.ts";
import { coderDefinition, waitFor } from "./_fixtures.ts";
import { endpoint, ev, reviewerDefinition, rig, tick, type Agents } from "./_cause-rig.ts";

const boom = () => {
  throw new Error("boom");
};
const never = fromPromise(() => new Promise<never>(() => {}));

/** One Agent `coder`, in `w`, with `states` below it; `extra` adds states beside `w`. */
function oneAgent(
  events: ReturnType<typeof ev>[],
  actors: Record<string, AnyActorLogic>,
  w: Record<string, unknown>,
  extra: Record<string, unknown> = { next: {}, done: { type: "final" } },
) {
  return ({ coder }: Agents) =>
    jr2Setup({ events, actors: { coder: coder!, ...actors } }).createMachine({
      on: { "agent.fault": {} },
      id: "t",
      initial: "w",
      states: {
        w: { invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1", continue: true } }, ...w },
        ...extra,
      },
    } as never) as unknown as AnyStateMachine;
}

test("the pick in its own send leaves the Agent's state: `pick`", async () => {
  const go = ev("go");
  const r = await rig({ coder: coderDefinition }, oneAgent([go], {}, { on: { go: "#t.next" } }));
  assert.equal(r.host.sendToAgent(r.iid("coder"), { type: "go" }).turnComplete, true);
  await tick(10);
  assert.deepEqual(r.causes("coder"), ["pick"]);
  await r.host.close();
});

test("the route of an outstanding pick's work reaches a final state: `pick`", async () => {
  const go = ev("go");
  const work = fromPromise(async () => ({ built: true }));
  const r = await rig(
    { coder: coderDefinition },
    oneAgent(
      [go],
      { work },
      {
        initial: "rest",
        states: { rest: { on: { go: "running" } }, running: { invoke: { src: "work", onDone: "#t.done" } } },
      },
    ),
  );
  assert.equal(r.host.sendToAgent(r.iid("coder"), { type: "go" }).outstanding, true);
  await waitFor(() => r.of("coder").aborts.length === 1);
  assert.deepEqual(r.causes("coder"), ["pick"]);
  await r.host.close();
});

test("a timer on the Agent's state leaves while the pick waits on a timer or a child below: no cause", async () => {
  for (const below of ["timer", "child"] as const) {
    const go = ev("go");
    const r = await rig(
      { coder: coderDefinition },
      oneAgent(
        [go],
        { never },
        {
          after: { 40: "#t.next" },
          initial: "rest",
          states: {
            rest: { on: { go: "waiting" } },
            waiting: below === "timer" ? { after: { 5000: "rest" } } : { invoke: { src: "never" } },
          },
        },
      ),
    );
    assert.equal(r.host.sendToAgent(r.iid("coder"), { type: "go" }).outstanding, true);
    await waitFor(() => r.of("coder").aborts.length === 1);
    assert.deepEqual(r.causes("coder"), ["none"], below);
    await r.host.close();
  }
});

test("a route that re-enters the Agent's state stops the invocation: `pick`; the next Turn, ended by a timer: no cause", async () => {
  const go = ev("go");
  const work = fromPromise(async () => ({ built: true }));
  const r = await rig(
    { coder: coderDefinition },
    oneAgent(
      [go],
      { work },
      {
        after: { 60: "#t.done" },
        initial: "rest",
        states: {
          rest: { on: { go: "running" } },
          running: { invoke: { src: "work", onDone: { target: "#t.w", reenter: true } } },
        },
      },
    ),
  );
  assert.equal(r.host.sendToAgent(r.iid("coder"), { type: "go" }).outstanding, true);
  await waitFor(() => r.of("coder").aborts.length === 2);
  assert.deepEqual(r.causes("coder"), ["pick", "none"]);
  await r.host.close();
});

test("a route in a child Machine sends its parent the event that leaves: `pick`", async () => {
  const go = ev("go");
  const leave = ev("leave");
  const work = fromPromise(async () => ({ built: true }));
  const r = await rig({ coder: coderDefinition }, ({ coder }) => {
    const body = jr2Setup({ events: [go], actors: { coder: coder!, work } }).createMachine({
      on: { "agent.fault": {} },
      id: "body",
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
          initial: "rest",
          states: {
            rest: { on: { go: "running" } },
            running: { invoke: { src: "work", onDone: { target: "rest", actions: sendParent({ type: "leave" }) } } },
          },
        },
      },
    });
    return jr2Setup({ events: [leave], actors: { body } }).createMachine({
      id: "root",
      initial: "b",
      states: { b: { invoke: { src: "body", id: "body" }, on: { leave: "after" } }, after: {} },
    }) as AnyStateMachine;
  });
  assert.equal(r.host.sendToAgent(r.iid("coder"), { type: "go" }).outstanding, true);
  await waitFor(() => r.of("coder").aborts.length === 1);
  assert.deepEqual(r.causes("coder"), ["pick"]);
  await r.host.close();
});

test("the pick leaves, then an event its route sent at once throws: the exit was the pick's (`pick`)", async () => {
  for (const how of ["sendTo-self", "raise"] as const) {
    const go = ev("go");
    const explode = ev("explode");
    const r = await rig(
      { coder: coderDefinition },
      oneAgent(
        [go, explode],
        {},
        {
          on: {
            go: {
              target: "#t.next",
              actions: how === "raise" ? raise({ type: "explode" }) : sendTo(({ self }) => self, { type: "explode" }),
            },
          },
        },
        { next: { on: { explode: { actions: boom } } } },
      ),
    );
    r.host.sendToAgent(r.iid("coder"), { type: "go" });
    await tick(10);
    assert.deepEqual(r.causes("coder"), ["pick"], how);
    await r.host.close();
  }
});

test("a fault in the pick's own transition, or in a reply's route at the root, is no exit of the pick's: no cause", async () => {
  const go = ev("go");
  const own = await rig(
    { coder: coderDefinition },
    oneAgent([go], {}, { on: { go: { target: "#t.next", actions: boom } } }),
  );
  own.host.sendToAgent(own.iid("coder"), { type: "go" });
  await tick(10);
  assert.deepEqual(own.causes("coder"), ["none"], "the pick's own transition");
  await own.host.close();

  const work = fromPromise(async () => ({ built: true }));
  const routed = await rig(
    { coder: coderDefinition },
    oneAgent(
      [go],
      { work },
      {
        initial: "rest",
        states: {
          rest: { on: { go: "running" } },
          running: { invoke: { src: "work", onDone: { target: "#t.next", actions: boom } } },
        },
      },
    ),
  );
  assert.equal(routed.host.sendToAgent(routed.iid("coder"), { type: "go" }).outstanding, true);
  await waitFor(() => routed.of("coder").aborts.length === 1);
  assert.deepEqual(routed.causes("coder"), ["none"], "a reply's route");
  await routed.host.close();
});

test("a CANCEL while a pick is outstanding: no cause", async () => {
  const go = ev("go");
  const r = await rig(
    { coder: coderDefinition },
    oneAgent(
      [go],
      { never },
      { initial: "rest", states: { rest: { on: { go: "running" } }, running: { invoke: { src: "never" } } } },
    ),
  );
  assert.equal(r.host.sendToAgent(r.iid("coder"), { type: "go" }).outstanding, true);
  await r.host.cancel(r.runId);
  assert.deepEqual(r.causes("coder"), ["none"]);
  await r.host.close();
});

test("the work's route goes back to Rest, and a sibling of the Agent's state leaves a microtask later: no cause", async () => {
  const go = ev("go");
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = () => resolve()));
  const work = fromPromise(() => released);
  const sibling = fromPromise(() => released.then(() => undefined));
  const r = await rig(
    { coder: coderDefinition },
    ({ coder }) =>
      jr2Setup({ events: [go], actors: { coder: coder!, work, sibling } }).createMachine({
        on: { "agent.fault": {} },
        id: "t",
        initial: "w",
        states: {
          w: {
            invoke: [
              { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
              { src: "sibling", id: "sib", onDone: "#t.next" },
            ],
            initial: "rest",
            states: { rest: { on: { go: "running" } }, running: { invoke: { src: "work", onDone: "rest" } } },
          },
          next: {},
        },
      } as never) as unknown as AnyStateMachine,
  );
  assert.equal(r.host.sendToAgent(r.iid("coder"), { type: "go" }).outstanding, true);
  release();
  await waitFor(() => r.of("coder").aborts.length === 1);
  assert.deepEqual(r.causes("coder"), ["none"]);
  await r.host.close();
});

test("a child's error in another region, caught there, then the work's route leaves: `pick`; the work's own error routed out: `pick`; an error nobody catches: no cause", async () => {
  type Case = "sibling-caught" | "work-rejects-caught-leave" | "work-rejects-uncaught" | "sibling-uncaught";
  const expected: Record<Case, string[]> = {
    "sibling-caught": ["pick"],
    "work-rejects-caught-leave": ["pick"],
    "work-rejects-uncaught": ["none"],
    "sibling-uncaught": ["none"],
  };
  for (const c of Object.keys(expected) as Case[]) {
    const go = ev("go");
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = () => resolve()));
    const work = fromPromise(() =>
      released.then(() => {
        if (c.startsWith("work-rejects")) throw new Error("work failed");
        return { built: true };
      }),
    );
    const failing = fromPromise(async () => {
      await tick(20);
      throw new Error("sibling failed");
    });
    const r = await rig(
      { coder: coderDefinition },
      ({ coder }) =>
        jr2Setup({ events: [go], actors: { coder: coder!, work, failing } }).createMachine({
          on: { "agent.fault": {} },
          id: "t",
          type: "parallel",
          states: {
            ra: {
              initial: "w",
              states: {
                w: {
                  invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
                  initial: "rest",
                  states: {
                    rest: { on: { go: "running" } },
                    running: {
                      invoke: {
                        src: "work",
                        onDone: "#t.ra.out",
                        ...(c === "work-rejects-caught-leave" ? { onError: "#t.ra.out" } : {}),
                      },
                    },
                  },
                },
                out: {},
              },
            },
            rb: {
              initial: "s",
              states: {
                s: { invoke: { src: "failing", ...(c === "sibling-uncaught" ? {} : { onError: "caught" }) } },
                caught: {},
              },
            },
          },
        } as never) as unknown as AnyStateMachine,
    );
    assert.equal(r.host.sendToAgent(r.iid("coder"), { type: "go" }).outstanding, true);
    await tick(50);
    release();
    await waitFor(() => r.of("coder").aborts.length === 1);
    assert.deepEqual(r.causes("coder"), expected[c], c);
    await r.host.close();
  }
});

test("two Agents' picks in parallel regions: each sweep's cause is its own pick's, and an answer at Rest sends none", async () => {
  for (const bLeaves of [false, true]) {
    const pickA = ev("pick_a");
    const pickB = ev("pick_b");
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = () => resolve()));
    const workA = fromPromise(() => released);
    const workB = fromPromise(() => released);
    const r = await rig(
      { coderA: coderDefinition, coderB: reviewerDefinition },
      ({ coderA, coderB }) =>
        jr2Setup({ events: [pickA, pickB], actors: { coderA: coderA!, coderB: coderB!, workA, workB } }).createMachine({
          on: { "agent.fault": {} },
          id: "pair",
          type: "parallel",
          states: {
            ra: {
              initial: "agent",
              states: {
                agent: {
                  invoke: { src: "coderA", input: { prompt: "A", endpoint, continue: true } },
                  initial: "rest",
                  states: {
                    rest: { on: { pick_a: "running" } },
                    running: { invoke: { src: "workA", onDone: "rest" } },
                  },
                },
              },
            },
            rb: {
              initial: "agent",
              states: {
                agent: {
                  invoke: { src: "coderB", input: { prompt: "B", endpoint, continue: true } },
                  initial: "rest",
                  states: {
                    rest: { on: { pick_b: "running" } },
                    running: { invoke: { src: "workB", onDone: bLeaves ? "#pair.rb.after" : "rest" } },
                  },
                },
                after: {},
              },
            },
          },
        }) as AnyStateMachine,
    );
    await waitFor(() => r.of("coderB").admits.length === 1);
    const a = r.host.sendToAgent(r.iid("coderA"), { type: "pick_a" });
    const b = r.host.sendToAgent(r.iid("coderB"), { type: "pick_b" });
    const polled = Promise.all([
      r.host.awaitDelivery(r.iid("coderA"), a.deliveryId, 2_000),
      r.host.awaitDelivery(r.iid("coderB"), b.deliveryId, 2_000),
    ]);
    release();
    const [answerA, answerB] = await polled;
    await tick(20);
    assert.deepEqual(
      { turnComplete: answerA?.turnComplete, allowed: answerA?.allowed },
      { turnComplete: false, allowed: ["pick_a"] },
    );
    assert.deepEqual(
      { turnComplete: answerB?.turnComplete, allowed: answerB?.allowed },
      bLeaves ? { turnComplete: true, allowed: [] } : { turnComplete: false, allowed: ["pick_b"] },
    );
    assert.deepEqual(r.causes("coderA"), []);
    assert.deepEqual(r.causes("coderB"), bLeaves ? ["pick"] : []);
    await r.host.close();
  }
});

test("a route back to Rest that sends itself an event back into work, queued: the pick stays out, and nothing is swept", async () => {
  const go = ev("go");
  const again = ev("again");
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = () => resolve()));
  let runs = 0;
  const work = fromPromise(() => (++runs === 1 ? released : new Promise(() => {})));
  const sib = fromCallback(({ sendBack, receive }) => {
    receive((e) => {
      if (e.type === "ping") sendBack({ type: "pong" });
    });
  });
  const r = await rig(
    { coder: coderDefinition },
    ({ coder }) =>
      jr2Setup({ events: [go, again], actors: { coder: coder!, work, sib } }).createMachine({
        on: { "agent.fault": {} },
        id: "t",
        initial: "w",
        states: {
          w: {
            invoke: [
              { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1", continue: true } },
              { src: "sib", id: "sib" },
            ],
            initial: "rest",
            states: {
              rest: { on: { go: "running", again: "running" } },
              running: {
                invoke: {
                  src: "work",
                  onDone: {
                    target: "rest",
                    actions: [sendTo(({ self }) => self, { type: "again" }), sendTo("sib", { type: "ping" })],
                  },
                },
              },
            },
          },
        },
      }) as AnyStateMachine,
  );
  const going = r.host.sendToAgent(r.iid("coder"), { type: "go" });
  assert.equal(going.outstanding, true);
  const polled = r.host.awaitDelivery(r.iid("coder"), going.deliveryId, 300);
  release();
  assert.equal((await polled)?.outstanding, true);
  assert.equal(JSON.stringify(r.host.status(r.runId)?.value), JSON.stringify({ w: "running" }));
  assert.throws(() => r.host.sendToAgent(r.iid("coder"), { type: "go" }), OutstandingError);
  assert.deepEqual(r.causes("coder"), []);
  await r.host.close();
});

test("a Machine above the Agent's Machine faults and is caught: the Agent's Machine runs on, and its later route that stops the Agent sends a sweep with no cause — the run took the Agent's state away first, even when the pick's route caused the fault", async () => {
  // `leave`: the pick's work leaves the state after the fault. `send`: an outside event does.
  // `caused`: the pick's route sends the event that makes the Machine above throw, and an outside
  // event leaves the state later. The fault is not the pick's, so no route makes the sweep `pick`.
  for (const route of ["leave", "send", "caused"] as const) {
    const go = ev("go");
    const poke = ev("poke");
    const bad = ev("bad");
    const finish = ev("finish");
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = () => resolve()));
    const work = fromPromise(() => released.then(() => ({ built: true })));
    const r = await rig({ coder: coderDefinition }, ({ coder }) => {
      const m = jr2Setup({ events: [go, poke, finish], actors: { coder: coder!, work } }).createMachine({
        on: { "agent.fault": {} },
        id: "m",
        initial: "w",
        states: {
          w: {
            invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
            on: { finish: "#m.out", poke: { actions: sendParent({ type: "bad" }) } },
            initial: "rest",
            states: { rest: { on: { go: "running" } }, running: { invoke: { src: "work", onDone: "#m.out" } } },
          },
          out: {},
        },
      });
      const a = jr2Setup({ events: [bad], actors: { m } }).createMachine({
        id: "a",
        initial: "x",
        states: {
          x: {
            invoke: { src: "m", id: "m" },
            on: { bad: { actions: boom } },
            ...(route === "caused" ? {} : { after: { 20: { actions: boom } } }),
          },
        },
      });
      return jr2Setup({ events: [], actors: { a } }).createMachine({
        id: "p",
        initial: "b",
        states: { b: { invoke: { src: "a", id: "a", onError: "failed" } }, failed: {} },
      }) as AnyStateMachine;
    });
    if (route === "leave") {
      assert.equal(r.host.sendToAgent(r.iid("coder"), { type: "go" }).outstanding, true);
      await tick(60);
      release();
    } else {
      if (route === "caused") r.host.sendToAgent(r.iid("coder"), { type: "poke" });
      await tick(60);
      r.host.sendToAgent(r.iid("coder"), { type: "finish" });
    }
    await waitFor(() => r.of("coder").aborts.length === 1);
    assert.deepEqual(r.causes("coder"), ["none"], route);
    await r.host.close();
  }
});

test("a nested Agent's Machine faults below the outer Agent's pick, and the outer Machine routes the error out: the outer sweep is `pick`; the nested Agent, orphaned, gets none", async () => {
  const go = ev("go");
  const dig = ev("dig");
  const r = await rig({ coder: coderDefinition, reviewer: reviewerDefinition }, ({ coder, reviewer }) => {
    const c = jr2Setup({ events: [dig], actors: { reviewer: reviewer!, never } }).createMachine({
      on: { "agent.fault": {} },
      id: "c",
      initial: "y",
      states: {
        y: {
          invoke: { src: "reviewer", input: { prompt: "Review.", endpoint, sandbox: "ws-1" } },
          initial: "rest",
          after: { 40: { actions: boom } },
          states: { rest: { on: { dig: "digging" } }, digging: { invoke: { src: "never" } } },
        },
      },
    });
    return jr2Setup({ events: [go], actors: { coder: coder!, c } }).createMachine({
      on: { "agent.fault": {} },
      id: "m",
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
          initial: "rest",
          states: { rest: { on: { go: "running" } }, running: { invoke: { src: "c", id: "c", onError: "#m.out" } } },
        },
        out: {},
      },
    }) as AnyStateMachine;
  });
  assert.equal(r.host.sendToAgent(r.iid("coder"), { type: "go" }).outstanding, true);
  await waitFor(() => r.of("reviewer").admits.length === 1);
  assert.equal(r.host.sendToAgent(r.iid("reviewer"), { type: "dig" }).outstanding, true);
  await waitFor(() => r.of("coder").aborts.length === 1);
  await tick(20);
  assert.deepEqual(r.causes("coder"), ["pick"]);
  // Older than this: the nested Agent's own Machine ended in a fault, and xstate does not stop that
  // Machine's children. So its actor is never stopped, no sweep is sent, its surface stays live, and
  // nothing settles its Submission.
  assert.deepEqual(r.causes("reviewer"), []);
  assert.notEqual(r.host.agentSurface(r.iid("reviewer")), undefined, "the orphan's surface is still live");
  const late = r.host.sendToAgent(r.iid("reviewer"), { type: "dig" });
  assert.equal(late.turnComplete, false, "a pick finds no end of the Turn, so its Harness does not wait for a sweep");
  await r.host.close();
});

test("a constant event object that the pick's route sent at once, sent again later by a timer, is no pick's: no cause", async () => {
  for (const fresh of [false, true]) {
    const ping = ev("ping");
    const poke = ev("poke");
    const leave = ev("leave");
    const arm = ev("arm");
    // One object for every send of the literal, or a new one each time.
    const sendLeave = fresh ? sendParent(() => ({ type: "leave" })) : sendParent({ type: "leave" });
    const r = await rig({ coder: coderDefinition }, ({ coder }) => {
      const helper = jr2Setup({ events: [poke] }).createMachine({
        id: "helper",
        initial: "idle",
        states: {
          idle: {
            on: { poke: { actions: sendLeave } },
            after: { 40: { actions: [sendParent({ type: "arm" }), sendLeave] } },
          },
        },
      });
      return jr2Setup({ events: [ping, leave, arm], actors: { coder: coder!, helper } }).createMachine({
        on: { "agent.fault": {} },
        id: "t",
        context: { armed: false },
        invoke: { src: "helper", id: "helper" },
        initial: "w",
        states: {
          w: {
            invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
            on: {
              ping: { actions: sendTo("helper", { type: "poke" }) },
              arm: { actions: assign({ armed: true }) },
              leave: { guard: ({ context }: { context: { armed: boolean } }) => context.armed, target: "#t.next" },
            },
          },
          next: {},
        },
      } as never) as unknown as AnyStateMachine;
    });
    r.host.sendToAgent(r.iid("coder"), { type: "ping" });
    await waitFor(() => r.of("coder").aborts.length === 1);
    assert.deepEqual(r.causes("coder"), ["none"], fresh ? "a new object" : "one object");
    await r.host.close();
  }
});

test("an answer from below the Agent's state that leaves it — a Gate's answer, a nested Agent's pick — is the outer pick's: `pick` for both Agents", async () => {
  const review = ev("review");
  const approve = ev("approve");
  const gated = await rig(
    { coder: coderDefinition },
    ({ coder }) =>
      jr2Setup({ events: [review, approve], actors: { coder: coder! } }).createMachine({
        on: { "agent.fault": {} },
        id: "t",
        initial: "w",
        states: {
          w: {
            invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
            initial: "rest",
            states: {
              rest: { on: { review: "asking" } },
              asking: { invoke: { src: "gate", id: "operator" }, on: { approve: "#t.next" } },
            },
          },
          next: {},
        },
      } as never) as unknown as AnyStateMachine,
  );
  assert.equal(gated.host.sendToAgent(gated.iid("coder"), { type: "review" }).outstanding, true);
  await waitFor(() => gated.host.gates(gated.runId).length === 1);
  gated.host.sendToGate(gated.runId, gated.host.gates(gated.runId)[0]!.gate, { type: "approve" });
  await waitFor(() => gated.of("coder").aborts.length === 1);
  assert.deepEqual(gated.causes("coder"), ["pick"], "a Gate's answer");
  await gated.host.close();

  const nested = await rig(
    { coder: coderDefinition, reviewer: reviewerDefinition },
    ({ coder, reviewer }) =>
      jr2Setup({ events: [review, approve], actors: { coder: coder!, reviewer: reviewer! } }).createMachine({
        on: { "agent.fault": {} },
        id: "t",
        initial: "w",
        states: {
          w: {
            invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
            initial: "rest",
            states: {
              rest: { on: { review: "reviewing" } },
              reviewing: {
                invoke: { src: "reviewer", input: { prompt: "Review.", endpoint, sandbox: "ws-1" } },
                on: { approve: "#t.next" },
              },
            },
          },
          next: {},
        },
      } as never) as unknown as AnyStateMachine,
  );
  assert.equal(nested.host.sendToAgent(nested.iid("coder"), { type: "review" }).outstanding, true);
  await waitFor(() => nested.of("reviewer").admits.length === 1);
  nested.host.sendToAgent(nested.iid("reviewer"), { type: "approve" });
  await waitFor(() => nested.of("coder").aborts.length === 1 && nested.of("reviewer").aborts.length === 1);
  assert.deepEqual(nested.causes("reviewer"), ["pick"], "the nested Agent's own pick");
  assert.deepEqual(nested.causes("coder"), ["pick"], "the outer pick's answer");
  await nested.host.close();
});

test("an Agent invoked on a Machine's root whose pick reaches the top-level final state: `pick`, for a child Machine and for the run's own Machine", async () => {
  const finish = ev("finish");
  const body = (coder: ReturnType<typeof agentActorWith>) =>
    jr2Setup({ events: [finish], actors: { coder } }).createMachine({
      on: { "agent.fault": {} },
      id: "body",
      invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
      initial: "a",
      states: { a: { on: { finish: "done" } }, done: { type: "final" } },
    });
  const child = await rig(
    { coder: coderDefinition },
    ({ coder }) =>
      jr2Setup({ events: [], actors: { body: body(coder!) } }).createMachine({
        id: "root",
        initial: "b",
        states: { b: { invoke: { src: "body", id: "body", onDone: "after" } }, after: {} },
      } as never) as unknown as AnyStateMachine,
  );
  child.host.sendToAgent(child.iid("coder"), { type: "finish" });
  await waitFor(() => child.of("coder").aborts.length === 1);
  assert.deepEqual(child.causes("coder"), ["pick"], "a child Machine");
  await child.host.close();

  const own = await rig({ coder: coderDefinition }, ({ coder }) => body(coder!) as unknown as AnyStateMachine);
  own.host.sendToAgent(own.iid("coder"), { type: "finish" });
  await waitFor(() => own.of("coder").aborts.length === 1);
  assert.deepEqual(own.causes("coder"), ["pick"], "the run's own Machine");
  await own.host.close();
});

test("a timer that the pick's route armed is the work's own progress: an `after` below, the same timer in a child Machine, a delayed send of the pick's transition — `pick` for each", async () => {
  const go = ev("go");
  const leave = ev("leave");
  const inline = await rig(
    { coder: coderDefinition },
    oneAgent(
      [go],
      {},
      { initial: "rest", states: { rest: { on: { go: "working" } }, working: { after: { 30: "#t.next" } } } },
    ),
  );
  // A timer that leaves the Agent's state holds no Rest (ADR-0024): the pick is answered at once.
  inline.host.sendToAgent(inline.iid("coder"), { type: "go" });
  await waitFor(() => inline.of("coder").aborts.length === 1);
  assert.deepEqual(inline.causes("coder"), ["pick"], "an `after` in the state the pick entered");
  await inline.host.close();

  const work = jr2Setup({ events: [] }).createMachine({
    id: "work",
    initial: "w",
    states: { w: { after: { 30: "d" } }, d: { type: "final" } },
  });
  const machine = await rig(
    { coder: coderDefinition },
    oneAgent(
      [go],
      { work },
      {
        initial: "rest",
        states: { rest: { on: { go: "working" } }, working: { invoke: { src: "work", onDone: "#t.next" } } },
      },
    ),
  );
  assert.equal(machine.host.sendToAgent(machine.iid("coder"), { type: "go" }).outstanding, true);
  await waitFor(() => machine.of("coder").aborts.length === 1);
  assert.deepEqual(machine.causes("coder"), ["pick"], "the same timer in a child Machine");
  await machine.host.close();

  const delayed = await rig(
    { coder: coderDefinition },
    oneAgent(
      [go, leave],
      {},
      {
        on: { go: { actions: sendTo(({ self }) => self, { type: "leave" }, { delay: 30 }) }, leave: "#t.next" },
      },
    ),
  );
  delayed.host.sendToAgent(delayed.iid("coder"), { type: "go" });
  await waitFor(() => delayed.of("coder").aborts.length === 1);
  assert.deepEqual(delayed.causes("coder"), ["pick"], "a delayed `sendTo(self)` of the pick's transition");
  await delayed.host.close();
});

test("the pick's transition sends at once through `enqueueActions`: `pick`; a child the pick spawned answers at once: `pick`; later: no cause", async () => {
  const go = ev("go");
  const leave = ev("leave");
  const queued = await rig(
    { coder: coderDefinition },
    oneAgent(
      [go, leave],
      {},
      {
        on: {
          go: { actions: enqueueActions(({ enqueue, self }) => enqueue.sendTo(self, { type: "leave" })) },
          leave: "#t.next",
        },
      },
    ),
  );
  queued.host.sendToAgent(queued.iid("coder"), { type: "go" });
  await waitFor(() => queued.of("coder").aborts.length === 1);
  assert.deepEqual(queued.causes("coder"), ["pick"], "enqueueActions");
  await queued.host.close();

  // A spawned child is not the work below the Agent's state (Rest counts invoked children only): its
  // answer is the pick's only while it is the route's own send.
  for (const [when, expected] of [
    ["at once", ["pick"]],
    ["later", ["none"]],
  ] as const) {
    const cb = fromCallback(({ sendBack }) => {
      if (when === "at once") sendBack({ type: "leave" });
      else setTimeout(() => sendBack({ type: "leave" }), 20);
    });
    const r = await rig(
      { coder: coderDefinition },
      oneAgent([go, leave], { cb }, { on: { go: { actions: spawnChild("cb") }, leave: "#t.next" } }),
    );
    r.host.sendToAgent(r.iid("coder"), { type: "go" });
    await waitFor(() => r.of("coder").aborts.length === 1);
    assert.deepEqual(r.causes("coder"), expected, `a spawned child answers ${when}`);
    await r.host.close();
  }
});

test("a pick that routes to a state that invokes `fail` ends the Turn: `pick` — beside the Agent's state, below it with a parent that catches the Failure, and below it with no catch; a throw below it: no cause (ADR-0024, ADR-0073)", async () => {
  // A Failure is the end that the pick chose, so it is no fault: the sweep is `pick`, and the
  // Harness settles the Submission `ended`. When a parent catches it, xstate does not stop the
  // Agent of the Machine that the Failure ended, so the host stops it. A plain throw at the same
  // place stays a fault: `none`.
  type Case = "beside" | "below-caught" | "below-uncaught" | "throw-below-uncaught";
  const expected: Record<Case, string[]> = {
    beside: ["pick"],
    "below-caught": ["pick"],
    "below-uncaught": ["pick"],
    "throw-below-uncaught": ["none"],
  };
  for (const c of Object.keys(expected) as Case[]) {
    const go = ev("go");
    const thrower = fromPromise(async () => {
      throw new Error("boom");
    });
    const r = await rig({ coder: coderDefinition }, ({ coder }) => {
      const m = jr2Setup({ events: [go], actors: { coder: coder!, fail: fail(), thrower } }).createMachine({
        on: { "agent.fault": {} },
        id: "m",
        initial: "w",
        states: {
          w: {
            invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
            initial: "rest",
            states: {
              rest: { on: { go: c === "beside" ? "#m.failing" : "failing" } },
              ...(c === "beside"
                ? {}
                : {
                    failing: {
                      invoke:
                        c === "throw-below-uncaught"
                          ? { src: "thrower" }
                          : { src: "fail", input: { reason: "no fix fits" } },
                    },
                  }),
            },
          },
          failing: { invoke: { src: "fail", input: { reason: "no fix fits" } } },
        },
      });
      return jr2Setup({ events: [], actors: { m } }).createMachine({
        id: "p",
        initial: "b",
        states: {
          b: { invoke: { src: "m", id: "m", ...(c.endsWith("uncaught") ? {} : { onError: "out" }) } },
          out: {},
        },
      }) as AnyStateMachine;
    });
    // Beside: the pick leaves the Agent's state at once. Below: the pick's work is outstanding until
    // the Failure goes up.
    const sent = r.host.sendToAgent(r.iid("coder"), { type: "go" });
    assert.equal(c === "beside" ? sent.turnComplete : sent.outstanding, true, c);
    await waitFor(() => r.of("coder").aborts.length === 1);
    assert.deepEqual(r.causes("coder"), expected[c], c);
    await r.host.close();
  }
});
