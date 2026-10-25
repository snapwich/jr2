// The Effect scenarios (ADR-0067), on the real kit: `jr2Setup`, `RunHost`, the Agent's Actor over a
// mock port, and `command` over a fake Harness exec. Each is a shape an author writes; each test
// states what the Machine and the Agent see. (The in-Turn chain with a Gate is pick.test.ts's.)
//
//   s01  a test gate with no Agent: route on the exit code
//   s04  cross-Turn: the pick's target leaves the Agent's state; the Effect runs after the Turn
//   s05  same Turn with a guard: the pick is held while its Effect runs; a closed guard is answered
//   s09  mixed picks: same Turn, cross-Turn and a pick with no target, in one Agent's state
//   s12  must-finish: the Effect's own state shadows the ancestor's event; elsewhere it is cut (D1)
//   s16  modes with a command: the Menu is fixed; the Allowed picks follow the mode

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import { arg, commandWith, type CommandOutput } from "../src/effect.ts";
import { fromPick } from "../src/pick.ts";
import { RunHost } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { fakeWorkspace, FakeHarnessExec } from "./_effects.ts";
import { coderDefinition, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

const EP = "http://harness.invalid";
const ok = (o: CommandOutput) => o.outcome === "exited" && o.code === 0;
const ev = <const N extends string, I extends z.ZodObject = z.ZodObject<{}>>(
  name: N,
  input?: I,
  audience?: "agent" | "external",
) => defineEvent({ name, input: (input ?? z.object({})) as I, ...(audience ? { audience } : {}) });

async function hosted(machine: Parameters<RunHost["register"]>[0]["machine"]) {
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "s", machine, provide: () => ({}) });
  const { runId } = await host.start("s");
  return { host, runId };
}

test("s01 — a test gate with no Agent: `onDone` routes on the exit code", async () => {
  const build = (fake: FakeHarnessExec) =>
    jr2Setup({
      types: {} as { context: Record<string, never>; output: { green: boolean } },
      events: [],
      actors: { ws: fakeWorkspace(), tests: commandWith(fake.factory, ["pnpm", "test"]) },
    }).createMachine({
      id: "gate",
      context: {},
      invoke: { src: "ws" },
      initial: "testing",
      states: {
        testing: {
          invoke: {
            src: "tests",
            onDone: [{ guard: ({ event }) => ok(event.output), target: "green" }, { target: "red" }],
          },
        },
        green: { type: "final", output: { green: true } },
        red: { type: "final", output: { green: false } },
      },
      output: ({ event }) => event.output as { green: boolean },
    });
  for (const [code, end] of [
    [0, "green"],
    [1, "red"],
  ] as const) {
    const fake = new FakeHarnessExec();
    const { host, runId } = await hosted(build(fake));
    await waitFor(() => fake.starts.length === 1);
    fake.settle({ outcome: "exited", code, tail: "" });
    await waitFor(() => host.status(runId) === undefined);
    assert.equal((await host.read(runId))?.value, end);
  }
});

test("s04 — cross-Turn: the pick ends the Turn; the Effect runs after it; the next Turn is the author's to frame", async () => {
  const fake = new FakeHarnessExec();
  const coder = new MockFlueClient();
  const runTests = ev("run_tests");
  const finish = ev("finish", z.object({ summary: z.string() }));
  type Ctx = { tests?: CommandOutput; summary?: string };
  const machine = jr2Setup({
    types: {} as { context: Ctx },
    events: [runTests, finish],
    actors: {
      ws: fakeWorkspace(),
      coder: agentActorWith(() => coder, coderDefinition),
      tests: commandWith(fake.factory, ["pnpm", "test"]),
    },
  }).createMachine({
    id: "cross",
    context: {},
    invoke: { src: "ws" },
    initial: "working",
    states: {
      working: {
        // The kit carries no answer across a Turn whose pick left the Agent's state (not built: what
        // the result of a cross-Turn pick is, is undecided), so the author frames the next Turn.
        invoke: {
          src: "coder",
          input: ({ context }) => ({
            prompt: context.tests ? `The tests: ${JSON.stringify(context.tests)}` : "Fix the bug.",
            endpoint: EP,
            continue: true,
          }),
        },
        on: {
          run_tests: "run_tests",
          finish: { target: "done", actions: assign({ summary: ({ event }) => event.summary }) },
        },
      },
      run_tests: {
        invoke: {
          src: "tests",
          onDone: { target: "working", actions: assign({ tests: ({ event }) => event.output }) },
        },
      },
      done: { type: "final" },
    },
  });
  const { host } = await hosted(machine);
  await waitFor(() => coder.admits.length === 1);
  const receipt = host.sendToAgent(coder.admits[0]!.instanceId, { type: "run_tests" });
  assert.equal(receipt.turnComplete, true, "the target is a sibling: the Turn is over");
  assert.equal(receipt.outstanding, undefined, "nothing is held across a Turn");
  await waitFor(() => fake.starts.length === 1);
  fake.settle({ outcome: "exited", code: 1, tail: "1 failing" });
  await waitFor(() => coder.admits.length === 2);
  assert.equal(coder.admits[1]!.prompt, 'The tests: {"outcome":"exited","code":1,"tail":"1 failing"}');
  assert.equal(coder.admits[1]!.instanceId, coder.admits[0]!.instanceId, "the same conversation");
});

/** One Agent's state with same-Turn picks (an Effect child, guarded), a cross-Turn pick, and a pick
 * with no target — s05 and s09 in one Machine. */
function mixed(fake: FakeHarnessExec, coder: MockFlueClient) {
  const lint = ev("lint");
  const comment = ev("comment", z.object({ body: z.string() }));
  const deploy = ev("deploy");
  const note = ev("note", z.object({ text: z.string() }));
  const finish = ev("finish");
  type Ctx = { green: boolean; notes: string[] };
  return jr2Setup({
    types: {} as { context: Ctx },
    events: [lint, comment, deploy, note, finish],
    actors: {
      ws: fakeWorkspace(),
      coder: agentActorWith(() => coder, coderDefinition),
      linter: commandWith(fake.factory, ["pnpm", "lint"]),
      poster: commandWith(fake.factory, ["post-comment", arg("body")]),
      deployer: commandWith(fake.factory, ["deploy"]),
    },
  }).createMachine({
    id: "mixed",
    context: { green: false, notes: [] },
    invoke: { src: "ws" },
    initial: "working",
    states: {
      working: {
        invoke: { src: "coder", input: { prompt: "Work.", endpoint: EP, continue: true } },
        initial: "rest",
        states: {
          rest: {},
          lint: {
            invoke: {
              src: "linter",
              onDone: { target: "rest", actions: assign({ green: ({ event }) => ok(event.output) }) },
            },
          },
          comment: { invoke: { src: "poster", input: fromPick(comment), onDone: "rest" } },
        },
        on: {
          lint: ".lint",
          comment: { target: ".comment", guard: ({ context }) => context.green },
          deploy: "deploying",
          note: { actions: assign({ notes: ({ context, event }) => [...context.notes, event.text] }) },
          finish: "done",
        },
      },
      deploying: { invoke: { src: "deployer", onDone: "working" } },
      done: { type: "final" },
    },
  });
}

test("s05 — same Turn with a guard: held while the Effect runs, answered with its output; a closed guard is answered, not run", async () => {
  const fake = new FakeHarnessExec();
  const coder = new MockFlueClient();
  const { host, runId } = await hosted(mixed(fake, coder));
  await waitFor(() => coder.admits.length === 1);
  const iid = coder.admits[0]!.instanceId;

  const closed = host.sendToAgent(iid, { type: "comment", body: "LGTM" });
  assert.equal(closed.moved, false, "the guard is closed: nothing ran");
  assert.equal(fake.starts.length, 0);

  const linting = host.sendToAgent(iid, { type: "lint" });
  assert.equal(linting.outstanding, true);
  await waitFor(() => fake.starts.length === 1);
  fake.settle({ outcome: "exited", code: 0, tail: "clean" });
  const answered = await host.awaitDelivery(iid, linting.deliveryId);
  assert.deepEqual(answered?.answer, {
    kind: "output",
    actor: "linter",
    output: { outcome: "exited", code: 0, tail: "clean" },
  });
  assert.ok(answered?.allowed.includes("comment"), "the Allowed picks read after the route: the guard is open now");

  const commenting = host.sendToAgent(iid, { type: "comment", body: "ship it; really" });
  assert.equal(commenting.outstanding, true);
  await waitFor(() => fake.starts.length === 2);
  assert.deepEqual(fake.starts[1]!.req.argv, ["post-comment", "ship it; really"]);
  fake.settle({ outcome: "exited", code: 0, tail: "" });
  await host.awaitDelivery(iid, commenting.deliveryId);
  assert.deepEqual(host.status(runId)?.value, { working: "rest" });
});

test("s09 — mixed picks: a pick with no target answers at once; a cross-Turn pick ends the Turn", async () => {
  const fake = new FakeHarnessExec();
  const coder = new MockFlueClient();
  const { host, runId } = await hosted(mixed(fake, coder));
  await waitFor(() => coder.admits.length === 1);
  const iid = coder.admits[0]!.instanceId;

  const noted = host.sendToAgent(iid, { type: "note", text: "flaky test in auth" });
  assert.equal(noted.moved, true);
  assert.equal(noted.turnComplete, false);
  assert.equal(noted.outstanding, undefined, "nothing runs: answered on its own POST");
  assert.deepEqual((host.status(runId)?.context as { notes: string[] }).notes, ["flaky test in auth"]);

  const deploying = host.sendToAgent(iid, { type: "deploy" });
  assert.equal(deploying.turnComplete, true);
  await waitFor(() => fake.starts.length === 1);
  fake.settle({ outcome: "exited", code: 0, tail: "deployed" });
  await waitFor(() => coder.admits.length === 2);
  assert.deepEqual(host.status(runId)?.value, { working: "rest" }, "back in the Agent's state: a new Turn");
});

test("s12 — must-finish: its state shadows the ancestor's `cancel` and is not cut; elsewhere `cancel` cuts the Effect (D1)", async () => {
  const cancel = ev("cancel", undefined, "external");
  const start = ev("start", undefined, "external");
  const build = (fake: FakeHarnessExec) =>
    jr2Setup({
      types: {} as { context: { cancelled: boolean } },
      events: [cancel, start],
      actors: {
        ws: fakeWorkspace(),
        build: commandWith(fake.factory, ["pnpm", "build"]),
        publish: commandWith(fake.factory, ["publish"]),
      },
    }).createMachine({
      id: "must",
      context: { cancelled: false },
      invoke: [{ src: "ws" }, { src: "gate", id: "ctl" }],
      initial: "building",
      on: { cancel: ".cancelled" },
      states: {
        building: { invoke: { src: "build", onDone: "publishing" } },
        publishing: {
          invoke: {
            src: "publish",
            onDone: [{ guard: ({ context }) => context.cancelled, target: "cancelled" }, { target: "done" }],
          },
          on: { cancel: { actions: assign({ cancelled: true }) } },
        },
        cancelled: { on: { start: "building" } },
        done: {},
      },
    });

  // Cut: `cancel` while building leaves at once, and the build is killed.
  const cut = new FakeHarnessExec();
  const a = await hosted(build(cut));
  await waitFor(() => cut.starts.length === 1);
  a.host.sendToGate(a.runId, "ctl", { type: "cancel" });
  await waitFor(() => cut.kills.length === 1);
  assert.equal(a.host.status(a.runId)?.value, "cancelled");

  // Not cut: `cancel` while publishing is recorded; the publish finishes, then the route honors it.
  const kept = new FakeHarnessExec();
  const b = await hosted(build(kept));
  await waitFor(() => kept.starts.length === 1);
  kept.settle({ outcome: "exited", code: 0, tail: "" });
  await waitFor(() => kept.starts.length === 2);
  b.host.sendToGate(b.runId, "ctl", { type: "cancel" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(kept.kills, [], "the publish was not cut");
  assert.equal(b.host.status(b.runId)?.value, "publishing");
  kept.settle({ outcome: "exited", code: 0, tail: "published" });
  await waitFor(() => b.host.status(b.runId)?.value === "cancelled");
});

test("s16 — modes with a command: one Menu; the command's pick is held and answered with the mode's picks", async () => {
  const fake = new FakeHarnessExec();
  const coder = new MockFlueClient();
  const runTests = ev("run_tests", z.object({ filter: z.string() }), "agent");
  const askReview = ev("ask_review", undefined, "agent");
  const revise = ev("revise", undefined, "agent");
  const submit = ev("submit", z.object({ summary: z.string() }), "agent");
  const approve = ev("approve", undefined, "external");
  type Ctx = { green: boolean; approved: boolean; summary?: string };
  const machine = jr2Setup({
    types: {} as { context: Ctx },
    events: [runTests, askReview, revise, submit, approve],
    actors: {
      ws: fakeWorkspace(),
      coder: agentActorWith(() => coder, coderDefinition),
      tests: commandWith(fake.factory, ["pnpm", "test", "--", arg("filter")]),
    },
  }).createMachine({
    id: "modes",
    context: { green: false, approved: false },
    invoke: { src: "ws" },
    initial: "ticket",
    states: {
      ticket: {
        invoke: { src: "coder", input: { prompt: "Fix the ticket.", endpoint: EP } },
        initial: "coding",
        states: {
          coding: { on: { run_tests: "testing", ask_review: "reviewing" } },
          testing: {
            invoke: {
              src: "tests",
              input: fromPick(runTests),
              onDone: { target: "coding", actions: assign({ green: ({ event }) => ok(event.output) }) },
            },
          },
          reviewing: {
            initial: "approval",
            states: {
              approval: {
                invoke: { src: "gate", id: "approval" },
                on: { approve: { target: "decided", actions: assign({ approved: true }) } },
              },
              decided: {},
            },
            on: {
              revise: "coding",
              submit: {
                target: "#modes.done",
                guard: ({ context }) => context.approved && context.green,
                actions: assign({ summary: ({ event }) => event.summary }),
              },
            },
          },
        },
      },
      done: { type: "final" },
    },
  });
  const { host } = await hosted(machine);
  await waitFor(() => coder.admits.length === 1);
  const iid = coder.admits[0]!.instanceId;
  const menu = () => host.agentSurface(iid)!.menu.map((m) => m.name);
  const before = menu();
  assert.deepEqual(before, ["ask_review", "revise", "run_tests", "submit"]);

  // A Menu pick another mode handles: the correction receipt, nothing delivered.
  assert.equal(host.sendToAgent(iid, { type: "submit", summary: "early" }).moved, false);

  const testing = host.sendToAgent(iid, { type: "run_tests", filter: "auth" });
  assert.equal(testing.outstanding, true);
  await waitFor(() => fake.starts.length === 1);
  assert.deepEqual(fake.starts[0]!.req.argv, ["pnpm", "test", "--", "auth"]);
  fake.settle({ outcome: "exited", code: 0, tail: "3 passing" });
  const answered = await host.awaitDelivery(iid, testing.deliveryId);
  assert.deepEqual(answered?.allowed, ["ask_review", "run_tests"], "back in `coding`: its picks");
  assert.deepEqual(menu(), before, "the Menu is the same bytes in every mode");
});
