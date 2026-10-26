// The cause of a Turn's end (ADR-0024, `cause.ts`), on shapes the verifiers found: a timer re-armed
// by another event, two timers of one id, a child Machine done at start, a pick of an earlier
// Submission of the same Turn, a reroll, a nudge, two runs in one host, a dispatch, and a restored
// run. Socket-free, through the real `jr2Setup` walk and the real `RunHost`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assign,
  cancel,
  createMachine,
  fromCallback,
  fromPromise,
  raise,
  sendParent,
  sendTo,
  spawnChild,
} from "xstate";
import { z } from "zod";
import { agentActorWith } from "../src/actor.ts";
import { dispatch } from "../src/dispatch-effect.ts";
import { RunHost } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { coderDefinition, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";
import { endpoint, ev, reviewerDefinition, rig as typedRig, tick } from "./_cause-rig.ts";

/** The rig over Machines built loosely: these shapes mix xstate actions and jr2 slots freely. */
const rig = (slots: Parameters<typeof typedRig>[0], machineOf: (agents: any) => unknown) =>
  typedRig(slots, machineOf as never);

// --- timers armed by another event, and two timers of one id ---
// `outside` is a callback invoked on the root: `poke(e)` relays `e` from it to the run's Machine
// at any time, with no cause (it is not below the Agent's state and takes no caused relay).

let poke: (e: any) => void = () => {
  throw new Error("no outside yet");
};
const outside = fromCallback(({ sendBack }: any) => {
  poke = sendBack;
});

const go = ev("go");
const bump = ev("bump");
const leave = ev("leave");
const start = ev("start");
const self = ({ self }: any) => self;

// --- 2a: an `after` armed by the pick, re-armed by an uncaused re-entry ------------------------------
test("2a an `after` the pick armed, re-armed by an outside event's re-entry, then fires and leaves: none", async () => {
  const r = await rig({ coder: coderDefinition }, ({ coder }) =>
    jr2Setup({ events: [go, bump], actors: { coder, outside } }).createMachine({
      on: { "agent.fault": {} },
      id: "t",
      invoke: { src: "outside" },
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
          initial: "rest",
          states: {
            rest: { on: { go: "working" } },
            working: { after: { 80: "#t.next" }, on: { bump: { target: "working", reenter: true } } },
          },
        },
        next: {},
      },
    } as never),
  );
  r.host.sendToAgent(r.iid("coder"), { type: "go" });
  await tick(20);
  poke({ type: "bump" });
  await waitFor(() => r.of("coder").aborts.length === 1);
  assert.deepEqual(r.causes("coder"), ["none"]);
  await r.host.close();
});

test("2a-r an `after` an outside event armed, re-armed by the pick's re-entry, then fires and leaves: pick", async () => {
  const r = await rig({ coder: coderDefinition }, ({ coder }) =>
    jr2Setup({ events: [go, bump], actors: { coder, outside } }).createMachine({
      on: { "agent.fault": {} },
      id: "t",
      invoke: { src: "outside" },
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
          on: { go: { target: ".working", reenter: true } },
          initial: "rest",
          states: { rest: { on: { bump: "working" } }, working: { after: { 80: "#t.next" } } },
        },
        next: {},
      },
    } as never),
  );
  poke({ type: "bump" });
  await tick(20);
  let receipt: any;
  try {
    receipt = r.host.sendToAgent(r.iid("coder"), { type: "go" });
  } catch (e) {
    receipt = { threw: String(e) };
  }
  await waitFor(() => r.of("coder").aborts.length === 1);
  assert.deepEqual(r.causes("coder"), ["pick"]);
  await r.host.close();
});

// --- 2b: xstate.cancel, then re-arm --------------------------------------------------------------
for (const order of ["pick-then-outside", "outside-then-pick"] as const) {
  test(`2b cancel then re-arm the same id: ${order}: the last arming's cause`, async () => {
    const armLeave = (delay: number) => sendTo(self, { type: "leave" }, { delay, id: "x" });
    const r = await rig({ coder: coderDefinition }, ({ coder }) =>
      jr2Setup({ events: [go, bump, leave], actors: { coder, outside } }).createMachine({
        on: { "agent.fault": {} },
        id: "t",
        invoke: { src: "outside" },
        initial: "w",
        states: {
          w: {
            invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
            on: {
              go: { actions: order === "pick-then-outside" ? armLeave(80) : [cancel("x"), armLeave(80)] },
              bump: { actions: order === "pick-then-outside" ? [cancel("x"), armLeave(80)] : armLeave(80) },
              leave: "#t.next",
            },
          },
          next: {},
        },
      } as never),
    );
    if (order === "pick-then-outside") {
      r.host.sendToAgent(r.iid("coder"), { type: "go" });
      await tick(20);
      poke({ type: "bump" });
    } else {
      poke({ type: "bump" });
      await tick(20);
      r.host.sendToAgent(r.iid("coder"), { type: "go" });
    }
    await waitFor(() => r.of("coder").aborts.length === 1);
    assert.deepEqual(r.causes("coder"), order === "pick-then-outside" ? ["none"] : ["pick"]);
    await r.host.close();
  });
}

// --- 2c: one id armed by two events with no cancel (xstate keeps BOTH timers; both fire) --------
// The first to fire leaves. The rule: its cause is the cause of the event that armed IT.
for (const shared of [true, false]) {
  for (const first of ["pick", "outside"] as const) {
    test(`2c same id, no cancel, ${shared ? "one event object" : "two event objects"}: the ${first}'s timer fires first and leaves: ${first === "pick" ? "pick" : "none"}`, async () => {
      const LEAVE = { type: "leave" };
      const obj = () => (shared ? LEAVE : { type: "leave" });
      // The first arming fires first: 80 ms; the second, armed 20 ms later, fires at 20 + 120.
      const pickDelay = first === "pick" ? 80 : 120;
      const outsideDelay = first === "pick" ? 120 : 80;
      const r = await rig({ coder: coderDefinition }, ({ coder }) =>
        jr2Setup({ events: [go, bump, leave], actors: { coder, outside } }).createMachine({
          on: { "agent.fault": {} },
          id: "t",
          invoke: { src: "outside" },
          initial: "w",
          states: {
            w: {
              invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
              on: {
                go: { actions: sendTo(self, obj(), { delay: pickDelay, id: "x" }) },
                bump: { actions: sendTo(self, obj(), { delay: outsideDelay, id: "x" }) },
                leave: "#t.next",
              },
            },
            next: {},
          },
        } as never),
      );
      if (first === "pick") {
        r.host.sendToAgent(r.iid("coder"), { type: "go" });
        await tick(20);
        poke({ type: "bump" });
      } else {
        poke({ type: "bump" });
        await tick(20);
        r.host.sendToAgent(r.iid("coder"), { type: "go" });
      }
      await waitFor(() => r.of("coder").aborts.length === 1);
      assert.deepEqual(r.causes("coder"), first === "pick" ? ["pick"] : ["none"]);
      await r.host.close();
    });
  }
}

// --- 2g: a caused relay to a child that forwards it to a grandchild that answers later ---------
for (const where of ["below", "root"] as const) {
  test(`2g pick -> child Machine (${where}) -> grandchild callback, which answers 30 ms later; the child sends the leave up: ${where === "below" ? "pick" : "none"}`, async () => {
    const poke2 = ev("poke2");
    const back = ev("back");
    const grand = fromCallback(({ sendBack, receive }: any) => {
      receive((e: any) => {
        if (e.type === "poke2") setTimeout(() => sendBack({ type: "back" }), 30);
      });
    });
    const child = jr2Setup({ events: [poke2, back], actors: { grand } }).createMachine({
      id: "child",
      invoke: { src: "grand", id: "grand" },
      on: { poke2: { actions: sendTo("grand", { type: "poke2" }) }, back: { actions: sendParent({ type: "leave" }) } },
    });
    const r = await rig({ coder: coderDefinition }, ({ coder }) =>
      jr2Setup({ events: [go, leave], actors: { coder, child } }).createMachine({
        on: { "agent.fault": {} },
        id: "t",
        initial: "w",
        ...(where === "root" ? { invoke: { src: "child", id: "child" } } : {}),
        states: {
          w: {
            invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
            initial: "rest",
            on: { leave: "#t.next" },
            states:
              where === "below"
                ? {
                    rest: { on: { go: "working" } },
                    working: {
                      invoke: { src: "child", id: "child" },
                      entry: sendTo("child", { type: "poke2" }),
                    },
                  }
                : { rest: { on: { go: { actions: sendTo("child", { type: "poke2" }) } } } },
          },
          next: {},
        },
      } as never),
    );
    const receipt = r.host.sendToAgent(r.iid("coder"), { type: "go" });
    await waitFor(() => r.of("coder").aborts.length === 1);
    assert.deepEqual(r.causes("coder"), where === "below" ? ["pick"] : ["none"]);
    await r.host.close();
  });
}

// --- 2h: an invoked promise that resolves later ------------------------------------------------
for (const where of ["below", "other-region"] as const) {
  test(`2h the pick's route invokes a promise (${where}) that resolves 30 ms later and leaves: ${where === "below" ? "pick" : "none"}`, async () => {
    const later = fromPromise(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 30)));
    const machine =
      where === "below"
        ? ({ coder }: any) =>
            jr2Setup({ events: [go], actors: { coder, later } }).createMachine({
              on: { "agent.fault": {} },
              id: "t",
              initial: "w",
              states: {
                w: {
                  invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
                  initial: "rest",
                  states: { rest: { on: { go: "working" } }, working: { invoke: { src: "later", onDone: "#t.next" } } },
                },
                next: {},
              },
            } as never)
        : ({ coder }: any) =>
            jr2Setup({ events: [go, start], actors: { coder, later } }).createMachine({
              id: "t",
              type: "parallel",
              on: { "agent.fault": {}, go: { actions: raise({ type: "start" }) } },
              states: {
                A: {
                  initial: "w",
                  states: {
                    w: { invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } } },
                    out: {},
                  },
                },
                B: {
                  initial: "idle",
                  states: {
                    idle: { on: { start: "running" } },
                    running: { invoke: { src: "later", onDone: { target: "#t.A.out" } } },
                    after: {},
                  },
                },
              },
            } as never);
    const r = await rig({ coder: coderDefinition }, machine);
    r.host.sendToAgent(r.iid("coder"), { type: "go" });
    await waitFor(() => r.of("coder").aborts.length === 1);
    assert.deepEqual(r.causes("coder"), where === "below" ? ["pick"] : ["none"]);
    await r.host.close();
  });
}

// --- 2i: a parallel region's caused timer exits the Agent's state in the other region ----------
test("2i the pick arms a timer in region B; 40 ms later it leaves the Agent's state in region A: pick", async () => {
  const r = await rig({ coder: coderDefinition }, ({ coder }) =>
    jr2Setup({ events: [go, start], actors: { coder } }).createMachine({
      id: "t",
      type: "parallel",
      on: { "agent.fault": {}, go: { actions: raise({ type: "start" }) } },
      states: {
        A: {
          initial: "w",
          states: { w: { invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } } }, out: {} },
        },
        B: {
          initial: "idle",
          states: { idle: { on: { start: "armed" } }, armed: { after: { 40: { target: "#t.A.out" } } } },
        },
      },
    } as never),
  );
  const receipt = r.host.sendToAgent(r.iid("coder"), { type: "go" });
  await waitFor(() => r.of("coder").aborts.length === 1);
  assert.deepEqual(r.causes("coder"), ["pick"]);
  await r.host.close();
});

test("2i-b the same, but an outside event arms region B's timer: none", async () => {
  const r = await rig({ coder: coderDefinition }, ({ coder }) =>
    jr2Setup({ events: [bump], actors: { coder, outside } }).createMachine({
      on: { "agent.fault": {} },
      id: "t",
      type: "parallel",
      invoke: { src: "outside" },
      states: {
        A: {
          initial: "w",
          states: { w: { invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } } }, out: {} },
        },
        B: {
          initial: "idle",
          states: { idle: { on: { bump: "armed" } }, armed: { after: { 40: { target: "#t.A.out" } } } },
        },
      },
    } as never),
  );
  poke({ type: "bump" });
  await waitFor(() => r.of("coder").aborts.length === 1);
  assert.deepEqual(r.causes("coder"), ["none"]);
  await r.host.close();
});

// --- a pick of an earlier Submission of the same Turn, and a child Machine done by its own timer ---
// it was? And: inline work and the same work as a child Machine, outside the Agent's state.

test("O-1 Submission 1 picks `go`, whose route arms a timer that leaves; it completes, and the nudge runs Submission 2; the timer leaves: the Turn's own pick, so `pick` naming Submission 2", async () => {
  const r = await rig({ coder: coderDefinition }, ({ coder }) =>
    jr2Setup({ events: [go, leave], actors: { coder } }).createMachine({
      on: { "agent.fault": {} },
      id: "t",
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
          on: { leave: "#t.next" },
          initial: "rest",
          states: { rest: { on: { go: "working" } }, working: { after: { 80: "#t.next" } } },
        },
        next: {},
      },
    } as never),
  );
  const c = r.of("coder");
  const receipt = r.host.sendToAgent(r.iid("coder"), { type: "go" });
  c.complete(); // Submission 1's run returns with the Turn open
  await waitFor(() => c.admits.length === 2); // the nudge: Submission 2
  await waitFor(() => c.aborts.length === 1);
  // The Turn's own pick ended the Turn: Submission 1's route armed the timer, and Submission 2 is the
  // same Turn's, admitted by the nudge. So the sweep says `pick` and names Submission 2, which the
  // Harness then settles `ended` (ADR-0024).
  assert.deepEqual(
    c.aborts.map((a) => a.cause ?? "none"),
    ["pick"],
  );
  assert.deepEqual(c.abortSubmissions, ["sub-2"]);
  await r.host.close();
});

test("O-2 region B: the pick starts a child Machine whose own `after` reaches its final state; onDone leaves the Agent's state in region A: `pick`", async () => {
  const work = jr2Setup({ events: [] }).createMachine({
    id: "work",
    initial: "w",
    states: { w: { after: { 30: "d" } }, d: { type: "final" } },
  });
  const r = await rig({ coder: coderDefinition }, ({ coder }) =>
    jr2Setup({ events: [go, start], actors: { coder, work } }).createMachine({
      id: "t",
      type: "parallel",
      on: { "agent.fault": {}, go: { actions: raise({ type: "start" }) } },
      states: {
        A: {
          initial: "w",
          states: { w: { invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } } }, out: {} },
        },
        B: {
          initial: "idle",
          states: { idle: { on: { start: "running" } }, running: { invoke: { src: "work", onDone: "#t.A.out" } } },
        },
      },
    } as never),
  );
  r.host.sendToAgent(r.iid("coder"), { type: "go" });
  await waitFor(() => r.of("coder").aborts.length === 1);
  assert.deepEqual(r.causes("coder"), ["pick"]);
  await r.host.close();
});

// --- children that answer the route at once, outside the Agent's state ---
// outside the Agent's state: a callback that sends at start vs. a child Machine that is done at start.
const out = ev("out");

for (const kind of ["callback-sends-at-start", "machine-done-at-start", "machine-done-on-caused-timer"] as const) {
  test(`A ${kind}, invoked in region B by the pick's route, leaves the Agent's state in region A: rule 3 says pick`, async () => {
    const cb = fromCallback(({ sendBack }: any) => sendBack({ type: "out" }));
    const instant = jr2Setup({ events: [] }).createMachine({
      id: "instant",
      initial: "d",
      states: { d: { type: "final" } },
    });
    const timed = jr2Setup({ events: [] }).createMachine({
      id: "timed",
      initial: "w",
      states: { w: { after: { 20: "d" } }, d: { type: "final" } },
    });
    const B =
      kind === "callback-sends-at-start"
        ? { idle: { on: { start: "running" } }, running: { invoke: { src: "cb" }, on: { out: "#t.A.out" } } }
        : {
            idle: { on: { start: "running" } },
            running: { invoke: { src: kind === "machine-done-at-start" ? "instant" : "timed", onDone: "#t.A.out" } },
          };
    const r = await rig({ coder: coderDefinition }, ({ coder }) =>
      jr2Setup({
        events: kind === "callback-sends-at-start" ? [go, start, out] : [go, start],
        actors: { coder, cb, instant, timed },
      }).createMachine({
        id: "t",
        type: "parallel",
        on: { "agent.fault": {}, go: { actions: raise({ type: "start" }) } },
        states: {
          A: {
            initial: "w",
            states: { w: { invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } } }, out: {} },
          },
          B: { initial: "idle", states: B },
        },
      } as never),
    );
    r.host.sendToAgent(r.iid("coder"), { type: "go" });
    await waitFor(() => r.of("coder").aborts.length === 1);
    assert.deepEqual(r.causes("coder"), ["pick"]);
    await r.host.close();
  });
}

// --- the Submission the sweep names, two runs in one host, a dispatch, a restore ---
// d/e/f: interleaved runs, a dispatch, a restored run.

const finish = ev("finish");

// --- item 3: after a runaway reroll ------------------------------------------------------------
test("3a a Turn rerolled after a runaway (fresh conversation iid-r1); its own pick then leaves: cause pick, and the sweep names the rerolled Submission", async () => {
  const r = await rig({ coder: coderDefinition }, ({ coder }) =>
    jr2Setup({ events: [leave], actors: { coder } }).createMachine({
      on: { "agent.fault": {} },
      id: "t",
      initial: "w",
      states: {
        w: { invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } }, on: { leave: "#t.next" } },
        next: {},
      },
    } as never),
  );
  const c = r.of("coder");
  c.faultSettled("runaway", "repeated an identical tool call 3 times");
  await waitFor(() => c.admits.length === 2);
  const rerolled = c.admits[1]!.instanceId;
  r.host.sendToAgent(rerolled, { type: "leave" });
  await waitFor(() => c.aborts.length >= 1);
  const last = c.aborts.at(-1)!;
  assert.equal(last.instanceId, rerolled);
  assert.equal(last.cause, "pick");
  assert.equal(c.abortSubmissions.at(-1), "sub-2", "the rerolled conversation's running Submission");
  await r.host.close();
});

// --- item 3: after a nudge ---------------------------------------------------------------------
test("3b the first Submission completes with the Turn open; the nudge admits a second; its pick leaves: the sweep names the second", async () => {
  const r = await rig({ coder: coderDefinition }, ({ coder }) =>
    jr2Setup({ events: [leave], actors: { coder } }).createMachine({
      on: { "agent.fault": {} },
      id: "t",
      initial: "w",
      states: {
        w: { invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } }, on: { leave: "#t.next" } },
        next: {},
      },
    } as never),
  );
  const c = r.of("coder");
  c.complete();
  await waitFor(() => c.admits.length === 2);
  r.host.sendToAgent(r.iid("coder"), { type: "leave" });
  await waitFor(() => c.aborts.length === 1);
  assert.equal(c.aborts[0]!.cause, "pick");
  assert.equal(c.abortSubmissions[0], "sub-2");
  await r.host.close();
});

// --- item 2d: two runs in one host, interleaved -------------------------------------------------
test("2d two runs of one workflow in one host: A's pick-armed timer and B's outside exit fire in one tick: A pick, B none", async () => {
  let pokes: Array<(e: any) => void> = [];
  const outside = fromCallback(({ sendBack }: any) => {
    pokes.push(sendBack);
  });
  const bump = ev("bump");
  const clients: any[] = [];
  const agents = (made?: () => any) => ({
    coder: agentActorWith(() => made?.() ?? new MockFlueClient(), coderDefinition),
  });
  const machineOf = ({ coder }: any) =>
    jr2Setup({ events: [go, bump], actors: { coder, outside } }).createMachine({
      on: { "agent.fault": {} },
      id: "t",
      invoke: { src: "outside" },
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
          on: { bump: "#t.next" },
          initial: "rest",
          states: { rest: { on: { go: "working" } }, working: { after: { 40: "#t.next" } } },
        },
        next: {},
      },
    } as never);
  const host = new RunHost({ store: await mkStore() });
  host.register({
    name: "two",
    machine: machineOf(agents()) as never,
    provide: (): never => {
      const c = new MockFlueClient();
      clients.push(c);
      return { actors: machineOf(agents(() => c)).implementations.actors } as never;
    },
  });
  await host.start("two");
  await host.start("two");
  await waitFor(() => clients.length === 2 && clients.every((c) => c.admits.length === 1));
  const [a, b] = clients;
  host.sendToAgent(a.admits[0].instanceId, { type: "go" });
  // B's outside exit lands in the same tick as A's timer, about 40 ms on.
  setTimeout(() => pokes[1]!({ type: "bump" }), 40);
  await waitFor(() => a.aborts.length === 1 && b.aborts.length === 1);
  assert.deepEqual(
    a.aborts.map((x: any) => x.cause ?? "none"),
    ["pick"],
  );
  assert.deepEqual(
    b.aborts.map((x: any) => x.cause ?? "none"),
    ["none"],
  );
  await host.close();
});

// --- item 2e: a dispatch, whose run ends by its own Agent's pick, answers the caller's pick ------
test("2e the caller's pick dispatches a run below its state (wait); the callee's Agent picks finish; the caller leaves on the answer: pick for both Agents", async () => {
  const intakeDoor = z.object({ ticket: z.string() });
  const clients: Record<string, any[]> = { coder: [], reviewer: [] };
  const agentsOf = (made?: (slot: string) => any) => ({
    coder: agentActorWith(() => made?.("coder") ?? new MockFlueClient(), coderDefinition),
    reviewer: agentActorWith(() => made?.("reviewer") ?? new MockFlueClient(), reviewerDefinition),
  });
  const callee = ({ reviewer }: any) =>
    jr2Setup({ events: [finish], actors: { reviewer } }).createMachine({
      on: { "agent.fault": {} },
      id: "callee",
      input: intakeDoor,
      initial: "w",
      states: {
        w: {
          invoke: { src: "reviewer", input: { prompt: "Triage.", endpoint, sandbox: "ws-2" } },
          on: { finish: "done" },
        },
        done: { type: "final" },
      },
      output: () => ({ verdict: "ok" }),
    } as never);
  const caller = ({ coder }: any) =>
    jr2Setup({
      events: [go],
      actors: { coder, start: dispatch("callee", { input: intakeDoor, wait: true }) as never },
    }).createMachine({
      on: { "agent.fault": {} },
      id: "t",
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
          initial: "rest",
          states: {
            rest: { on: { go: "calling" } },
            calling: { invoke: { src: "start", input: () => ({ ticket: "T-1" }), onDone: "#t.next" } },
          },
        },
        next: {},
      },
    } as never);
  const host = new RunHost({ store: await mkStore() });
  const provide = (slot: string, of: (a: any) => any) => () => {
    const c = new MockFlueClient();
    clients[slot]!.push(c);
    return { actors: of(agentsOf(() => c)).implementations.actors };
  };
  host.register({ name: "caller", machine: caller(agentsOf()) as never, provide: provide("coder", caller) as never });
  host.register({
    name: "callee",
    machine: callee(agentsOf()) as never,
    provide: provide("reviewer", callee) as never,
  });
  await host.start("caller");
  await waitFor(() => clients.coder![0]?.admits.length === 1);
  const coder = clients.coder![0];
  const receipt = host.sendToAgent(coder.admits[0].instanceId, { type: "go" });
  await waitFor(() => clients.reviewer![0]?.admits.length === 1);
  const reviewer = clients.reviewer![0];
  host.sendToAgent(reviewer.admits[0].instanceId, { type: "finish" });
  await waitFor(() => coder.aborts.length === 1 && reviewer.aborts.length === 1);
  assert.deepEqual(
    reviewer.aborts.map((x: any) => x.cause ?? "none"),
    ["pick"],
    "the callee's Agent's own pick ended its run",
  );
  assert.deepEqual(
    coder.aborts.map((x: any) => x.cause ?? "none"),
    ["pick"],
    "the dispatch below the caller's state answered the caller's pick",
  );
  await host.close();
});

// --- item 2f + 3: a restored run -----------------------------------------------------------------
async function restoreRig(machineOf: (agents: any) => any) {
  const store = await mkStore();
  const clients: any[] = [];
  const agents = (made?: () => any) => ({
    coder: agentActorWith(() => made?.() ?? new MockFlueClient(), coderDefinition),
  });
  const def = () => ({
    name: "rs",
    machine: machineOf(agents()),
    provide: () => {
      const c = new MockFlueClient();
      clients.push(c);
      return { actors: machineOf(agents(() => c)).implementations.actors };
    },
  });
  const host1 = new RunHost({ store });
  host1.register(def());
  const { runId } = await host1.start("rs");
  await waitFor(() => clients[0]?.admits.length === 1);
  return { store, clients, def, host1, runId };
}

test("2f a timer the pick armed, then the Orchestrator restarts; the re-armed timer leaves: the stated limit (none)", async () => {
  const r = await restoreRig(({ coder }: any) =>
    jr2Setup({ events: [go], actors: { coder } }).createMachine({
      on: { "agent.fault": {} },
      id: "t",
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
          initial: "rest",
          states: { rest: { on: { go: "working" } }, working: { after: { 300: "#t.next" } } },
        },
        next: {},
      },
    } as never),
  );
  r.host1.sendToAgent(r.clients[0].admits[0].instanceId, { type: "go" });
  await tick(30);
  await r.host1.stop(r.runId);
  await r.host1.close();
  const host2 = new RunHost({ store: r.store });
  host2.register(r.def());
  const restored = await host2.restore();
  await waitFor(() => r.clients.length === 2 && r.clients[1].aborts.length === 1);
  assert.deepEqual(r.clients[0].aborts, [], "the host's own stop sends no sweep");
  assert.deepEqual(
    r.clients[1].aborts.map((x: any) => x.cause ?? "none"),
    ["none"],
    "the limit: a restored timer has no cause",
  );
  await host2.close();
});

test("2f-b a pick outstanding on a Gate below, then the Orchestrator restarts; the Gate answers and leaves: pick, naming the first admission", async () => {
  const approve = ev("approve");
  const review = ev("review");
  const r = await restoreRig(({ coder }: any) =>
    jr2Setup({ events: [review, approve], actors: { coder } }).createMachine({
      on: { "agent.fault": {} },
      id: "t",
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
          initial: "rest",
          states: {
            rest: { on: { review: "asking" } },
            asking: { invoke: { src: "gate", id: "op" }, on: { approve: "#t.next" } },
          },
        },
        next: {},
      },
    } as never),
  );
  const outer = r.host1.sendToAgent(r.clients[0].admits[0].instanceId, { type: "review" });
  assert.equal(outer.outstanding, true);
  await tick(30);
  await r.host1.stop(r.runId);
  await r.host1.close();
  const host2 = new RunHost({ store: r.store });
  host2.register(r.def());
  await host2.restore();
  await waitFor(() => host2.gates(r.runId).length === 1);
  host2.sendToGate(r.runId, host2.gates(r.runId)[0]!.gate, { type: "approve" });
  await waitFor(() => r.clients.length === 2 && r.clients[1].aborts.length === 1);
  assert.deepEqual(
    r.clients[1].aborts.map((x: any) => x.cause ?? "none"),
    ["pick"],
  );
  assert.equal(r.clients[1].abortSubmissions[0], "sub-1", "the first host's admission, ledgered and restored");
  await host2.close();
});

test("3c a Turn rerolled after a runaway, then the Orchestrator restarts; the rerolled conversation's pick leaves: the sweep names the rerolled Submission", async () => {
  const r = await restoreRig(({ coder }: any) =>
    jr2Setup({ events: [leave], actors: { coder } }).createMachine({
      on: { "agent.fault": {} },
      id: "t",
      initial: "w",
      states: {
        w: { invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } }, on: { leave: "#t.next" } },
        next: {},
      },
    } as never),
  );
  const first = r.clients[0];
  first.faultSettled("runaway", "repeated an identical tool call 3 times");
  await waitFor(() => first.admits.length === 2);
  const rerolled = first.admits[1]!.instanceId;
  await tick(20);
  await r.host1.stop(r.runId);
  await r.host1.close();
  const host2 = new RunHost({ store: r.store });
  host2.register(r.def() as never);
  await host2.restore();
  await waitFor(() => r.clients.length === 2);
  host2.sendToAgent(rerolled, { type: "leave" });
  await waitFor(() => r.clients[1].aborts.length === 1);
  assert.equal(r.clients[1].aborts[0].instanceId, rerolled);
  assert.equal(r.clients[1].aborts[0].cause, "pick");
  assert.deepEqual(
    r.clients[1].abortSubmissions,
    ["sub-2"],
    "the first host's rerolled admission, ledgered and restored",
  );
  await host2.close();
});

// --- an errored callback, and a spawned child ---

for (const throws of [true, false]) {
  test(`E1 a root helper callback arms its own timer at start; the pick's route pokes it${throws ? ", and its receive throws (caught above)" : ""}; its own timer then sends leave: none`, async () => {
    const helper = fromCallback(({ sendBack, receive }: any) => {
      setTimeout(() => sendBack({ type: "leave" }), 80);
      receive((e: any) => {
        if (throws && e.type === "poke") throw new Error("boom");
      });
    });
    const r = await rig({ coder: coderDefinition }, ({ coder }) =>
      jr2Setup({ events: [go, leave], actors: { coder, helper } }).createMachine({
        on: { "agent.fault": {} },
        id: "t",
        invoke: { src: "helper", id: "h", onError: { actions: () => {} } },
        initial: "w",
        states: {
          w: {
            invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
            on: { go: { actions: sendTo("h", { type: "poke" }) }, leave: "#t.next" },
          },
          next: {},
        },
      } as never),
    );
    r.host.sendToAgent(r.iid("coder"), { type: "go" });
    await tick(100);
    await waitFor(() => r.of("coder").aborts.length === 1);
    assert.deepEqual(r.causes("coder"), ["none"], "the helper's own later timer is no pick's");
    await r.host.close();
  });
}

test("E4 an outside event makes the root helper throw; the pick's route then pokes the errored helper; the helper's own later send leaves: none", async () => {
  let pokeOutside: (e: any) => void = () => {};
  const out = fromCallback(({ sendBack }: any) => {
    pokeOutside = sendBack;
  });
  const helper = fromCallback(({ sendBack, receive }: any) => {
    setTimeout(() => sendBack({ type: "leave" }), 80);
    receive((e: any) => {
      if (e.type === "boom") throw new Error("boom");
    });
  });
  const r = await rig({ coder: coderDefinition }, ({ coder }) =>
    jr2Setup({ events: [go, bump, leave], actors: { coder, helper, out } }).createMachine({
      id: "t",
      invoke: [{ src: "helper", id: "h", onError: { actions: () => {} } }, { src: "out" }],
      on: { "agent.fault": {}, bump: { actions: sendTo("h", { type: "boom" }) } },
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
          on: { go: { actions: sendTo("h", { type: "poke" }) }, leave: "#t.next" },
        },
        next: {},
      },
    } as never),
  );
  pokeOutside({ type: "bump" });
  await tick(5);
  r.host.sendToAgent(r.iid("coder"), { type: "go" });
  await tick(100);
  await waitFor(() => r.of("coder").aborts.length === 1);
  assert.deepEqual(r.causes("coder"), ["none"]);
  await r.host.close();
});

for (const [kind, expected] of [
  ["machine-after", ["pick"]],
  ["callback-setTimeout", ["none"]],
] as const) {
  test(`S1 the pick's route spawns a ${kind} child that sends leave 30 ms later: ${expected[0]} (rules 3 and 4)`, async () => {
    const kidMachine = createMachine({
      id: "kid",
      initial: "a",
      states: { a: { after: { 30: { target: "b", actions: sendParent({ type: "leave" }) } } }, b: {} },
    });
    const kidCallback = fromCallback(({ sendBack }: any) => {
      setTimeout(() => sendBack({ type: "leave" }), 30);
    });
    const r = await rig({ coder: coderDefinition }, ({ coder }) =>
      jr2Setup({
        events: [go, leave],
        actors: { coder, kid: kind === "machine-after" ? kidMachine : kidCallback },
      }).createMachine({
        on: { "agent.fault": {} },
        id: "t",
        initial: "w",
        states: {
          w: {
            invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
            on: { go: { actions: spawnChild("kid", { id: "k" }) }, leave: "#t.next" },
          },
          next: {},
        },
      } as never),
    );
    r.host.sendToAgent(r.iid("coder"), { type: "go" });
    await tick(50);
    await waitFor(() => r.of("coder").aborts.length === 1);
    assert.deepEqual(r.causes("coder"), [...expected]);
    await r.host.close();
  });
}

test("N3 sub-1's route arms a timer that leaves; sub-1 completes; the timer fires while the nudge's admission is in flight: the sweep names sub-1, which the Harness no longer runs (the stated limit: aborted)", async () => {
  const r = await rig({ coder: coderDefinition }, ({ coder }) =>
    jr2Setup({ events: [go, leave], actors: { coder } }).createMachine({
      on: { "agent.fault": {} },
      id: "t",
      initial: "w",
      states: {
        w: {
          invoke: { src: "coder", input: { prompt: "Fix.", endpoint, sandbox: "ws-1" } },
          on: { leave: "#t.next" },
          initial: "rest",
          states: { rest: { on: { go: "working" } }, working: { after: { 60: "#t.next" } } },
        },
        next: {},
      },
    } as never),
  );
  const c = r.of("coder");
  r.host.sendToAgent(r.iid("coder"), { type: "go" });
  c.holdAdmits = true;
  c.complete();
  await waitFor(() => c.admits.length === 2);
  await tick(80);
  await waitFor(() => c.aborts.length === 1);
  assert.deepEqual(
    c.aborts.map((a) => a.cause ?? "none"),
    ["pick"],
  );
  assert.deepEqual(c.abortSubmissions, ["sub-1"], "the nudge's admission is not ledgered until its answer arrives");
  c.releaseAdmits();
  await r.host.close();
});
