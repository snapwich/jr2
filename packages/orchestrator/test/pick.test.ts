// `fromPick`, `paramsOf` and `answer` (ADR-0067): what an author writes between a pick and the work
// it starts. The params flow by name; `fill` adds only what the Machine supplies; `answer` shapes
// what the Agent reads, from the typed `chain` of every reply since the pick. Through the real
// `jr2Setup` walk and the real `RunHost`, with a fake Harness exec and a mock Agent port.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, raise, type AnyStateMachine } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import { arg, commandWith, type CommandOutput } from "../src/effect.ts";
import { answer, fromPick, isAnswer, isPickMapper, paramsOf, seatsOfAnswer } from "../src/pick.ts";
import { RunHost } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { loadWarningsOf } from "../src/vocabulary.ts";
import { fakeWorkspace, FakeHarnessExec } from "./_effects.ts";
import { coderDefinition, mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

const lint = defineEvent({ name: "lint", input: z.object({ path: z.string() }) });
const finish = defineEvent({ name: "finish", input: z.object({}) });
const deploy = defineEvent({ name: "deploy_preview", input: z.object({}) });
const skip = defineEvent({ name: "skip", audience: "external", input: z.object({ why: z.string() }) });

test("paramsOf reads the pick's params off the entering event — never its type or its sender", () => {
  const event = { type: "lint", path: "src", sender: { party: "agent", id: "coder" } };
  assert.deepEqual(paramsOf(event, lint), { path: "src" });
  assert.throws(
    () => paramsOf({ type: "finish" }, lint),
    /entered by "finish", but its input reads the params of pick "lint"/,
  );
});

test("fromPick: the params flow by name, `fill` adds what the Machine supplies; the mapper carries its pick", () => {
  const mapper = fromPick(lint, ({ context }: { context: { repo: string } }) => ({ repo: context.repo }));
  const input = mapper({
    context: { repo: "app" },
    event: { type: "lint", path: "src" } as never,
    self: undefined as never,
  });
  assert.deepEqual(input, { path: "src", repo: "app" });
  assert.ok(isPickMapper(mapper));
  assert.equal(mapper.pick, lint);
  assert.equal(typeof mapper.fill, "function");
});

type Ctx = { build?: CommandOutput };

/** s13 in miniature: one pick runs the build; a red build asks a human, a green one deploys; `rest`'s
 * entry `answer` gives the Agent the whole chain. */
function chainMachine(fake: FakeHarnessExec, coder: ReturnType<typeof agentActorWith>) {
  const ok = (o: CommandOutput) => o.outcome === "exited" && o.code === 0;
  return jr2Setup({
    types: {} as { context: Ctx },
    events: [deploy, finish, skip, lint],
    actors: {
      ws: fakeWorkspace(),
      coder,
      build: commandWith(fake.factory, ["pnpm", "build"]),
      deployer: commandWith(fake.factory, ["deploy-preview"]),
      linter: commandWith(fake.factory, ["pnpm", "lint", arg("path")]),
    },
  }).createMachine({
    id: "chain",
    context: {},
    invoke: { src: "ws" },
    initial: "working",
    states: {
      working: {
        invoke: { src: "coder", input: { prompt: "Make the change.", endpoint: "http://harness.invalid" } },
        initial: "rest",
        states: {
          rest: { entry: answer(({ chain }) => chain) },
          building: {
            invoke: {
              src: "build",
              onDone: [
                { guard: ({ event }) => ok(event.output), target: "deploying" },
                { target: "asking", actions: assign({ build: ({ event }) => event.output }) },
              ],
            },
          },
          asking: { invoke: { src: "gate", id: "review", input: {} }, on: { skip: "rest" } },
          deploying: { invoke: { src: "deployer", onDone: "rest" } },
          linting: { invoke: { src: "linter", input: fromPick(lint), onDone: "rest" } },
        },
        on: { deploy_preview: ".building", lint: ".linting", finish: "done" },
      },
      done: { type: "final" },
    },
  });
}

async function chainRig() {
  const fake = new FakeHarnessExec();
  const coder = new MockFlueClient();
  const host = new RunHost({ store: await mkStore() });
  host.register({
    name: "chain",
    machine: chainMachine(
      fake,
      agentActorWith(() => coder, coderDefinition),
    ),
    provide: () => ({}),
  });
  const { runId } = await host.start("chain");
  await waitFor(() => coder.admits.length === 1);
  return { fake, host, runId, iid: coder.admits[0]!.instanceId };
}

test("`answer` on rest's entry: the Agent reads the chain — the build's output, then the Gate's event — oldest first", async () => {
  const { fake, host, runId, iid } = await chainRig();
  const picked = host.sendToAgent(iid, { type: "deploy_preview" });
  assert.equal(picked.outstanding, true);
  await waitFor(() => fake.starts.length === 1);
  fake.settle({ outcome: "exited", code: 2, tail: "type error" });
  await waitFor(() => host.gates(runId).length === 1);
  host.sendToGate(runId, "review", { type: "skip", why: "known flake" });
  const answered = await host.awaitDelivery(iid, picked.deliveryId);
  assert.deepEqual(answered?.answer, {
    kind: "answer",
    value: [
      { kind: "output", src: "build", output: { outcome: "exited", code: 2, tail: "type error" } },
      { kind: "event", event: { type: "skip", why: "known flake", sender: { party: "gate", id: "review" } } },
    ],
  });
  assert.ok(answered?.allowed.includes("finish"), "the Allowed picks after the route");
});

test("the green path: build then deploy — two outputs in the chain; no `answer` that ran before the pick leaks into it", async () => {
  const { fake, host, iid } = await chainRig();
  const picked = host.sendToAgent(iid, { type: "deploy_preview" });
  await waitFor(() => fake.starts.length === 1);
  fake.settle({ outcome: "exited", code: 0, tail: "built" });
  await waitFor(() => fake.starts.length === 2);
  fake.settle({ outcome: "exited", code: 0, tail: "https://p.example/1" });
  const answered = await host.awaitDelivery(iid, picked.deliveryId);
  assert.deepEqual(answered?.answer, {
    kind: "answer",
    value: [
      { kind: "output", src: "build", output: { outcome: "exited", code: 0, tail: "built" } },
      { kind: "output", src: "deployer", output: { outcome: "exited", code: 0, tail: "https://p.example/1" } },
    ],
  });
});

test("fromPick: the Agent's param reaches the command as one argument", async () => {
  const { fake, host, iid } = await chainRig();
  const picked = host.sendToAgent(iid, { type: "lint", path: "src; rm -rf /" });
  await waitFor(() => fake.starts.length === 1);
  assert.deepEqual(fake.starts[0]!.req.argv, ["pnpm", "lint", "src; rm -rf /"]);
  fake.settle({ outcome: "exited", code: 0, tail: "" });
  const answered = await host.awaitDelivery(iid, picked.deliveryId);
  assert.equal(answered?.answer?.kind, "answer", "rest's entry answers every pick that comes back through it");
});

// The chain's types (ADR-0067): a link's output is typed by its slot, an event link by the Machine's
// events. Order and length are not typed. `tsc` is the assertion; the test only names the bindings.
test("the chain is typed by slot and by kind", () => {
  const fake = new FakeHarnessExec();
  jr2Setup({
    types: {} as { context: Ctx },
    events: [deploy, skip, finish],
    actors: {
      coder: agentActorWith(() => new MockFlueClient(), coderDefinition),
      build: commandWith(fake.factory, ["b"]),
    },
  }).createMachine({
    id: "typed",
    context: {},
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", endpoint: "http://h.invalid" } },
        initial: "rest",
        states: {
          rest: {
            entry: answer(({ chain }) =>
              chain.map((link) => {
                if (link.kind === "output") {
                  if (link.src === "build") {
                    const outcome: CommandOutput["outcome"] = link.output.outcome;
                    // @ts-expect-error — a command's output has no `body`
                    void link.output.body;
                    return outcome;
                  }
                  // @ts-expect-error — no slot named `deploy`
                  return link.src === "deploy";
                }
                // @ts-expect-error — `skip` carries `why`, not `reason`
                return link.event.type === "skip" ? link.event.reason : link.event.type;
              }),
            ),
          },
          building: { invoke: { src: "build", onDone: "asking" } },
          asking: { invoke: { src: "gate", input: {} }, on: { skip: "rest" } },
        },
        on: { deploy_preview: ".building", finish: "#typed.done" },
      },
      done: { type: "final" },
    },
  });
  assert.ok(true);
});

// The fromPick sum's type (ADR-0067): the params plus what `fill` returns are checked against the
// Effect's input. A missing or mistyped key does not compile; `fill` can supply the missing key.
// `tsc` is the assertion, so the Machine is never built: the load walk would refuse `misnamed` too
// (its `pth` reaches nothing), which is the load check's test, not this one.
test("the fromPick sum is checked against the Effect's input type: a missing or mistyped key does not compile", () => {
  const fake = new FakeHarnessExec();
  const misnamed = defineEvent({ name: "misnamed", input: z.object({ pth: z.string() }) });
  const mistyped = defineEvent({ name: "mistyped", input: z.object({ path: z.number() }) });
  const bare = defineEvent({ name: "bare", input: z.object({}) });
  const typed = () =>
    jr2Setup({
      types: {} as { context: { dir: string } },
      events: [lint, misnamed, mistyped, bare],
      actors: { ws: fakeWorkspace(), linter: commandWith(fake.factory, ["pnpm", "lint", arg("path")]) },
    }).createMachine({
      id: "sum",
      context: { dir: "src" },
      invoke: { src: "ws" },
      initial: "waiting",
      states: {
        waiting: { on: { lint: "byName", misnamed: "missing", mistyped: "wrongType", bare: "filled" } },
        byName: { invoke: { src: "linter", input: fromPick(lint) } },
        missing: {
          // @ts-expect-error — the pick has no `path`, and `fill` adds none
          invoke: { src: "linter", input: fromPick(misnamed) },
        },
        wrongType: {
          // @ts-expect-error — `path` is a number; the command reads a string
          invoke: { src: "linter", input: fromPick(mistyped) },
        },
        filled: { invoke: { src: "linter", input: fromPick(bare, ({ context }) => ({ path: context.dir })) } },
        badFill: {
          // @ts-expect-error — `fill` returns `path` as a number
          invoke: { src: "linter", input: fromPick(bare, () => ({ path: 1 })) },
        },
      },
    });
  assert.equal(typeof typed, "function");
});

// An `answer` shapes the pick of the Agent whose state it is written below, never another Agent's
// (ADR-0067, ADR-0024). Two Agents in parallel root regions: A's pick is outstanding; an `answer`
// in B's region runs. It sets nothing for A, and A reads its own command's output.
test("an `answer` below one Agent's state never shapes another Agent's outstanding pick", async () => {
  const fake = new FakeHarnessExec();
  const a = new MockFlueClient();
  const b = new MockFlueClient();
  const build = defineEvent({ name: "build", input: z.object({}) });
  const host = new RunHost({ store: await mkStore() });
  host.register({
    name: "two",
    machine: jr2Setup({
      events: [build],
      actors: {
        ws: fakeWorkspace(),
        coderA: agentActorWith(() => a, coderDefinition),
        coderB: agentActorWith(() => b, coderDefinition),
        builder: commandWith(fake.factory, ["pnpm", "build"]),
      },
    }).createMachine({
      id: "two",
      invoke: { src: "ws" },
      type: "parallel",
      states: {
        ra: {
          invoke: { src: "coderA", input: { prompt: "A", endpoint: "http://harness.invalid" } },
          initial: "rest",
          states: { rest: {}, building: { invoke: { src: "builder", onDone: "rest" } } },
          on: { build: ".building" },
        },
        rb: {
          invoke: { src: "coderB", input: { prompt: "B", endpoint: "http://harness.invalid" } },
          initial: "waiting",
          states: { waiting: { after: { 50: "rest" } }, rest: { entry: answer(() => "B's answer") } },
        },
      },
    }),
    provide: () => ({}),
  });
  await host.start("two");
  await waitFor(() => a.admits.length === 1 && b.admits.length === 1);
  const iid = a.admits[0]!.instanceId;
  const picked = host.sendToAgent(iid, { type: "build" });
  assert.equal(picked.outstanding, true);
  await waitFor(() => fake.starts.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  fake.settle({ outcome: "exited", code: 0, tail: "built" });
  const answered = await host.awaitDelivery(iid, picked.deliveryId);
  assert.equal(answered?.answer?.kind, "output", "A reads its own command's output, not B's answer");
});

// An `answer` written below no Agent's state may shape any Agent's pick (ADR-0067, ADR-0024): its
// seat is `null`. A root `after` runs one while the pick is outstanding; the Agent reads it, not the
// command's output.
test("an `answer` written below no Agent's state shapes the outstanding pick", async () => {
  const fake = new FakeHarnessExec();
  const a = new MockFlueClient();
  const build = defineEvent({ name: "build", input: z.object({}) });
  const machine = jr2Setup({
    events: [build],
    actors: {
      ws: fakeWorkspace(),
      coder: agentActorWith(() => a, coderDefinition),
      builder: commandWith(fake.factory, ["pnpm", "build"]),
    },
  }).createMachine({
    id: "rooted",
    invoke: { src: "ws" },
    after: { 150: { actions: answer(() => "from root") } },
    initial: "working",
    states: {
      working: {
        invoke: { src: "coder", input: { prompt: "A", endpoint: "http://harness.invalid" } },
        initial: "rest",
        states: { rest: {}, building: { invoke: { src: "builder", onDone: "rest" } } },
        on: { build: ".building" },
      },
    },
  });
  const fromRoot = machine.root.after[0]!.actions[0];
  assert.ok(isAnswer(fromRoot));
  assert.deepEqual([...seatsOfAnswer(machine, fromRoot)], [null], "the walk seats it at no Agent's state");
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "rooted", machine, provide: () => ({}) });
  await host.start("rooted");
  await waitFor(() => a.admits.length === 1);
  const iid = a.admits[0]!.instanceId;
  const picked = host.sendToAgent(iid, { type: "build" });
  assert.equal(picked.outstanding, true);
  await waitFor(() => fake.starts.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 250));
  fake.settle({ outcome: "exited", code: 0, tail: "built" });
  const answered = await host.awaitDelivery(iid, picked.deliveryId);
  assert.deepEqual(answered?.answer, { kind: "answer", value: "from root" });
});

// An `answer` the walk did not find written in the Machine is read as written below no Agent's
// state: its seat is `null`.
test("an `answer` the walk did not find is seated at no Agent's state", () => {
  const machine = jr2Setup({ events: [], actors: { ws: fakeWorkspace() } }).createMachine({
    id: "bare",
    invoke: { src: "ws" },
  });
  assert.deepEqual(
    [
      ...seatsOfAnswer(
        machine,
        answer(() => "x"),
      ),
    ],
    [null],
  );
});

// --- An `answer` below no Agent's state, with two Agents' picks outstanding (ADR-0067, ADR-0024) ----
// Two Agents in parallel regions of the root, each with a pick outstanding. On a TRANSITION below no
// Agent's state, `answer` shapes the pick of the Agent whose event took it: the sender of a pick, or
// the Agent whose pick started the child whose done event it is — the run records which Agent
// started each child. The other Agent's pick keeps its default answer. On an ENTRY or EXIT below no
// Agent's state it sets nothing, and the load walk warns, naming the Agent states it could be moved
// under.

const buildA = defineEvent({ name: "build_a", input: z.object({}) });
const buildB = defineEvent({ name: "build_b", input: z.object({}) });

/** Two Agents, each in a region of the root: a pick (`build_a`, `build_b`) starts its region's own command, which
 * has no `onDone` — settled, it is Rest. `extra` adds to the root's own config. */
function twoAgents(fake: FakeHarnessExec, a: MockFlueClient, b: MockFlueClient, extra: Record<string, unknown> = {}) {
  const region = (coder: string, cmd: string, id: string, pick: string) => ({
    invoke: { src: coder, input: { prompt: coder, endpoint: "http://harness.invalid" } },
    initial: "rest",
    states: { rest: {}, building: { invoke: { src: cmd, id } } },
    on: { [pick]: ".building" },
  });
  return jr2Setup({
    events: [buildA, buildB],
    actors: {
      ws: fakeWorkspace(),
      coderA: agentActorWith(() => a, coderDefinition),
      coderB: agentActorWith(() => b, coderDefinition),
      builderA: commandWith(fake.factory, ["make", "a"]),
      builderB: commandWith(fake.factory, ["make", "b"]),
    },
  }).createMachine({
    id: "two",
    invoke: { src: "ws" },
    type: "parallel",
    ...extra,
    states: {
      ra: region("coderA", "builderA", "buildA", "build_a"),
      rb: region("coderB", "builderB", "buildB", "build_b"),
      ...((extra.states as Record<string, unknown> | undefined) ?? {}),
    },
  } as never) as unknown as AnyStateMachine;
}

/** Starts the run, and has both Agents pick `build`: two picks outstanding, two commands running. */
async function bothOutstanding(machine: unknown, fake: FakeHarnessExec, a: MockFlueClient, b: MockFlueClient) {
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "two", machine: machine as never, provide: () => ({}) });
  const { runId } = await host.start("two");
  await waitFor(() => a.admits.length === 1 && b.admits.length === 1);
  const ia = a.admits[0]!.instanceId;
  const ib = b.admits[0]!.instanceId;
  const pa = host.sendToAgent(ia, { type: "build_a" });
  await waitFor(() => fake.starts.length === 1);
  const pb = host.sendToAgent(ib, { type: "build_b" });
  await waitFor(() => fake.starts.length === 2);
  assert.equal(pa.outstanding, true);
  assert.equal(pb.outstanding, true);
  return { host, runId, ia, ib, pa, pb, execA: fake.starts[0]!.id, execB: fake.starts[1]!.id };
}

test("a transition below no Agent's state on a child's done event shapes the pick that started that child, and only it", async () => {
  const fake = new FakeHarnessExec();
  const a = new MockFlueClient();
  const b = new MockFlueClient();
  const fromRoot = answer(({ event }) => `the root saw ${event.type}`);
  const machine = twoAgents(fake, a, b, { on: { "xstate.done.actor.buildA": { actions: fromRoot } } });
  assert.deepEqual([...seatsOfAnswer(machine, fromRoot)], [null], "a transition on the root: below no Agent's state");
  const { host, ia, ib, pa, pb, execA, execB } = await bothOutstanding(machine, fake, a, b);
  fake.settle({ outcome: "exited", code: 0, tail: "a built" }, execA);
  const answeredA = await host.awaitDelivery(ia, pa.deliveryId);
  assert.deepEqual(answeredA?.answer, { kind: "answer", value: "the root saw xstate.done.actor.buildA" });
  fake.settle({ outcome: "exited", code: 0, tail: "b built" }, execB);
  const answeredB = await host.awaitDelivery(ib, pb.deliveryId);
  assert.equal(answeredB?.answer?.kind, "output", "B's pick keeps its default answer: its own command's output");
});

test("a transition below no Agent's state on a pick shapes the sender's pick, while the other Agent's is outstanding", async () => {
  const fake = new FakeHarnessExec();
  const a = new MockFlueClient();
  const b = new MockFlueClient();
  const ship = defineEvent({ name: "ship", input: z.object({}) });
  const machine = jr2Setup({
    events: [buildB, ship, defineEvent({ name: "start_a", input: z.object({}) })],
    actors: {
      ws: fakeWorkspace(),
      coderA: agentActorWith(() => a, coderDefinition),
      coderB: agentActorWith(() => b, coderDefinition),
      builderA: commandWith(fake.factory, ["make", "a"]),
      builderB: commandWith(fake.factory, ["make", "b"]),
    },
  }).createMachine({
    id: "two",
    invoke: { src: "ws" },
    type: "parallel",
    // A's `ship`, written on the root: its transition is below no Agent's state; the event it raises
    // enters A's work, in the same send, and leaves A's state as it is.
    on: {
      ship: {
        actions: [
          answer(({ event }) => `shipped by ${(event as { sender?: { id: string } }).sender?.id}`),
          raise({ type: "start_a" }),
        ],
      },
    },
    states: {
      ra: {
        invoke: { src: "coderA", input: { prompt: "A", endpoint: "http://harness.invalid" } },
        initial: "rest",
        states: { rest: {}, building: { invoke: { src: "builderA", id: "buildA" } } },
        on: { start_a: ".building" },
      },
      rb: {
        invoke: { src: "coderB", input: { prompt: "B", endpoint: "http://harness.invalid" } },
        initial: "rest",
        states: { rest: {}, building: { invoke: { src: "builderB", id: "buildB" } } },
        on: { build_b: ".building" },
      },
    },
  });
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "two", machine, provide: () => ({}) });
  await host.start("two");
  await waitFor(() => a.admits.length === 1 && b.admits.length === 1);
  const ia = a.admits[0]!.instanceId;
  const ib = b.admits[0]!.instanceId;
  const pb = host.sendToAgent(ib, { type: "build_b" });
  await waitFor(() => fake.starts.length === 1);
  const pa = host.sendToAgent(ia, { type: "ship" });
  await waitFor(() => fake.starts.length === 2);
  assert.equal(pb.outstanding, true);
  assert.equal(pa.outstanding, true);
  fake.settle({ outcome: "exited", code: 0, tail: "b built" }, fake.starts[0]!.id);
  const answeredB = await host.awaitDelivery(ib, pb.deliveryId);
  assert.equal(answeredB?.answer?.kind, "output", "B's pick keeps its default answer");
  fake.settle({ outcome: "exited", code: 0, tail: "a built" }, fake.starts[1]!.id);
  const answeredA = await host.awaitDelivery(ia, pa.deliveryId);
  assert.deepEqual(answeredA?.answer, { kind: "answer", value: "shipped by coderA" });
});

test("an entry below no Agent's state sets nothing, even with one pick outstanding, and the load walk warns naming the Agent states", async () => {
  const fake = new FakeHarnessExec();
  const a = new MockFlueClient();
  const b = new MockFlueClient();
  const onEntry = answer(() => "from an entry below no Agent's state");
  // A third region, with no Agent: its `ticked` state is entered by a timer while A's pick is
  // outstanding, and answers on entry. The root itself answers on entry too.
  const machine = twoAgents(fake, a, b, {
    entry: onEntry,
    states: { rc: { initial: "idle", states: { idle: { after: { 150: "ticked" } }, ticked: { entry: onEntry } } } },
  });
  assert.deepEqual([...seatsOfAnswer(machine, onEntry)], [], "an entry or exit below no Agent's state seats nowhere");
  const warnings = loadWarningsOf(machine);
  const forRoot = warnings.find((w) => w.includes('the entry of "two"'));
  assert.ok(forRoot, `the root's entry is warned: ${warnings.join(" | ")}`);
  assert.match(forRoot, /"two\.ra" or "two\.rb"/, "naming the Agent states it could be moved under");
  assert.ok(
    warnings.some((w) => w.includes('the entry of "two.rc.ticked"')),
    `the region's entry is warned: ${warnings.join(" | ")}`,
  );
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "two", machine, provide: () => ({}) });
  await host.start("two");
  await waitFor(() => a.admits.length === 1);
  const ia = a.admits[0]!.instanceId;
  const pa = host.sendToAgent(ia, { type: "build_a" });
  assert.equal(pa.outstanding, true);
  await waitFor(() => fake.starts.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 250));
  fake.settle({ outcome: "exited", code: 0, tail: "a built" }, fake.starts[0]!.id);
  const answeredA = await host.awaitDelivery(ia, pa.deliveryId);
  assert.equal(answeredA?.answer?.kind, "output", "A reads its command's output: the entry set nothing");
});

test("one `answer` written below two Agents' states shapes the pick of the Agent whose child's done event took the transition", async () => {
  const fake = new FakeHarnessExec();
  const a = new MockFlueClient();
  const b = new MockFlueClient();
  const both = answer(({ event }) => `built: ${event.type}`);
  const region = (coder: string, cmd: string, id: string, pick: string) => ({
    invoke: { src: coder, input: { prompt: coder, endpoint: "http://harness.invalid" } },
    initial: "rest",
    states: { rest: {}, building: { invoke: { src: cmd, id } } },
    on: { [pick]: ".building", [`xstate.done.actor.${id}`]: { actions: both } },
  });
  const machine = jr2Setup({
    events: [buildA, buildB],
    actors: {
      ws: fakeWorkspace(),
      coderA: agentActorWith(() => a, coderDefinition),
      coderB: agentActorWith(() => b, coderDefinition),
      builderA: commandWith(fake.factory, ["make", "a"]),
      builderB: commandWith(fake.factory, ["make", "b"]),
    },
  }).createMachine({
    id: "two",
    invoke: { src: "ws" },
    type: "parallel",
    states: {
      ra: region("coderA", "builderA", "buildA", "build_a"),
      rb: region("coderB", "builderB", "buildB", "build_b"),
    },
  } as never) as unknown as AnyStateMachine;
  assert.equal(seatsOfAnswer(machine, both).size, 2, "one action object, below two Agents' states");
  const { host, ia, ib, pa, pb, execA, execB } = await bothOutstanding(machine, fake, a, b);
  fake.settle({ outcome: "exited", code: 0, tail: "b built" }, execB);
  const answeredB = await host.awaitDelivery(ib, pb.deliveryId);
  assert.deepEqual(answeredB?.answer, { kind: "answer", value: "built: xstate.done.actor.buildB" });
  fake.settle({ outcome: "exited", code: 0, tail: "a built" }, execA);
  const answeredA = await host.awaitDelivery(ia, pa.deliveryId);
  assert.deepEqual(answeredA?.answer, { kind: "answer", value: "built: xstate.done.actor.buildA" });
});

test("one `answer` written on an entry below no Agent's state and on a transition below none sets nothing as the entry", async () => {
  const fake = new FakeHarnessExec();
  const a = new MockFlueClient();
  const b = new MockFlueClient();
  const shared = answer(({ event }) => `shared ran on ${event.type}`);
  // A third region, with no Agent: A's child's done event enters its `ticked`, whose entry is
  // `shared`; the same object is also on a root transition that B's child's done event takes.
  const machine = twoAgents(fake, a, b, {
    on: { "xstate.done.actor.buildB": { actions: shared } },
    states: {
      rc: {
        initial: "idle",
        states: { idle: {}, ticked: { entry: shared } },
        on: { "xstate.done.actor.buildA": ".ticked" },
      },
    },
  });
  assert.deepEqual([...seatsOfAnswer(machine, shared)], [null], "its transition is below no Agent's state");
  assert.ok(
    loadWarningsOf(machine).some((w) => w.includes('the entry of "two.rc.ticked"')),
    "the entry is warned, as one written there alone",
  );
  const { host, ia, ib, pa, pb, execA, execB } = await bothOutstanding(machine, fake, a, b);
  fake.settle({ outcome: "exited", code: 0, tail: "a built" }, execA);
  const answeredA = await host.awaitDelivery(ia, pa.deliveryId);
  assert.equal(answeredA?.answer?.kind, "output", "A reads its command's output: the entry set nothing");
  fake.settle({ outcome: "exited", code: 0, tail: "b built" }, execB);
  const answeredB = await host.awaitDelivery(ib, pb.deliveryId);
  assert.deepEqual(
    answeredB?.answer,
    { kind: "answer", value: "shared ran on xstate.done.actor.buildB" },
    "as the transition, the same object shapes the pick whose child's done event took it",
  );
});

test("a child that a pick's later work started is that pick's: its done event below no Agent's state shapes that pick only", async () => {
  const fake = new FakeHarnessExec();
  const a = new MockFlueClient();
  const b = new MockFlueClient();
  const fromRoot = answer(({ event }) => `the root saw ${event.type}`);
  const machine = jr2Setup({
    events: [buildA, buildB],
    actors: {
      ws: fakeWorkspace(),
      coderA: agentActorWith(() => a, coderDefinition),
      coderB: agentActorWith(() => b, coderDefinition),
      builderA: commandWith(fake.factory, ["make", "a"]),
      testerA: commandWith(fake.factory, ["make", "test"]),
      builderB: commandWith(fake.factory, ["make", "b"]),
    },
  }).createMachine({
    id: "two",
    invoke: { src: "ws" },
    type: "parallel",
    // Below no Agent's state, on the done event of the child that A's build started.
    on: { "xstate.done.actor.testA": { actions: fromRoot } },
    states: {
      ra: {
        invoke: { src: "coderA", input: { prompt: "A", endpoint: "http://harness.invalid" } },
        initial: "rest",
        states: {
          rest: {},
          building: { invoke: { src: "builderA", id: "buildA", onDone: "testing" } },
          testing: { invoke: { src: "testerA", id: "testA" } },
        },
        on: { build_a: ".building" },
      },
      rb: {
        invoke: { src: "coderB", input: { prompt: "B", endpoint: "http://harness.invalid" } },
        initial: "rest",
        states: { rest: {}, building: { invoke: { src: "builderB", id: "buildB" } } },
        on: { build_b: ".building" },
      },
    },
  } as never) as unknown as AnyStateMachine;
  const { host, ia, ib, pa, pb, execA, execB } = await bothOutstanding(machine, fake, a, b);
  fake.settle({ outcome: "exited", code: 0, tail: "a built" }, execA);
  await waitFor(() => fake.starts.length === 3);
  fake.settle({ outcome: "exited", code: 0, tail: "a tested" }, fake.starts[2]!.id);
  const answeredA = await host.awaitDelivery(ia, pa.deliveryId);
  assert.deepEqual(answeredA?.answer, { kind: "answer", value: "the root saw xstate.done.actor.testA" });
  fake.settle({ outcome: "exited", code: 0, tail: "b built" }, execB);
  const answeredB = await host.awaitDelivery(ib, pb.deliveryId);
  assert.equal(answeredB?.answer?.kind, "output", "B's pick keeps its default answer");
});

// --- Each place an `answer` is written runs by its own place's rule (ADR-0067, ADR-0024) -------------
// One action object written in two places is two seats, never their sum: run from Agent A's state it
// shapes only A's pick, whatever the other place is, and an event that names no Agent (A's own timer)
// never reaches B's pick from there. And the Agent that started a child is recorded with the run, not
// with a hold: its done event names that Agent whether its pick is outstanding, answered, or was
// answered on its own POST.

/** Two Agents in regions of the root: B's `build_b` starts its command (no `onDone`: settled, it is
 * Rest); A's region has a timer (`ra.rest` after 150 ms) and the config `ra` adds. */
function twoWithATimer(
  fake: FakeHarnessExec,
  a: MockFlueClient,
  b: MockFlueClient,
  parts: { ra?: Record<string, unknown>; rb?: Record<string, unknown>; root?: Record<string, unknown> },
) {
  return jr2Setup({
    events: [buildB],
    actors: {
      ws: fakeWorkspace(),
      coderA: agentActorWith(() => a, coderDefinition),
      coderB: agentActorWith(() => b, coderDefinition),
      builderB: commandWith(fake.factory, ["make", "b"]),
    },
  }).createMachine({
    id: "two",
    invoke: { src: "ws" },
    type: "parallel",
    ...parts.root,
    states: {
      ra: {
        invoke: { src: "coderA", input: { prompt: "A", endpoint: "http://harness.invalid" } },
        initial: "rest",
        states: { rest: {}, tick: {} },
        ...parts.ra,
      },
      rb: {
        invoke: { src: "coderB", input: { prompt: "B", endpoint: "http://harness.invalid" } },
        initial: "rest",
        states: { rest: {}, building: { invoke: { src: "builderB", id: "buildB" } } },
        on: { build_b: ".building" },
        ...parts.rb,
      },
    },
  } as never) as unknown as AnyStateMachine;
}

/** B picks `build_b`; A never picks. After A's timer has fired, B's command settles: B's answer. */
async function bAloneAfterATimer(
  machine: AnyStateMachine,
  fake: FakeHarnessExec,
  a: MockFlueClient,
  b: MockFlueClient,
) {
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "two", machine, provide: () => ({}) });
  const { runId } = await host.start("two");
  await waitFor(() => a.admits.length === 1 && b.admits.length === 1);
  const ib = b.admits[0]!.instanceId;
  const pb = host.sendToAgent(ib, { type: "build_b" });
  assert.equal(pb.outstanding, true);
  await waitFor(() => fake.starts.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  fake.settle({ outcome: "exited", code: 0, tail: "b built" }, fake.starts[0]!.id);
  const answered = await host.awaitDelivery(ib, pb.deliveryId);
  // The long timers would hold the test process open.
  await host.stop(runId);
  return answered;
}

test("one `answer` written in A's state and in B's: run from A's timer, it leaves B's outstanding pick as it is", async () => {
  const fake = new FakeHarnessExec();
  const a = new MockFlueClient();
  const b = new MockFlueClient();
  const x = answer(({ event }) => `x ran on ${event.type}`);
  const machine = twoWithATimer(fake, a, b, {
    ra: { states: { rest: { after: { 150: { actions: x } } }, tick: {} } },
    rb: { after: { 999_999: { actions: x } } },
  });
  assert.equal(seatsOfAnswer(machine, x).size, 2, "one action object, below two Agents' states");
  const answeredB = await bAloneAfterATimer(machine, fake, a, b);
  assert.equal(answeredB?.answer?.kind, "output", `B's pick keeps its default: ${JSON.stringify(answeredB?.answer)}`);
});

test("one `answer` written in A's state and on a root transition: run from A's timer, it leaves B's outstanding pick as it is", async () => {
  const fake = new FakeHarnessExec();
  const a = new MockFlueClient();
  const b = new MockFlueClient();
  const x = answer(({ event }) => `x ran on ${event.type}`);
  const machine = twoWithATimer(fake, a, b, {
    ra: { states: { rest: { after: { 150: { actions: x } } }, tick: {} } },
    root: { after: { 999_999: { actions: x } } },
  });
  assert.equal(seatsOfAnswer(machine, x).size, 2, "seated at A's state and at no Agent's state");
  const answeredB = await bAloneAfterATimer(machine, fake, a, b);
  assert.equal(answeredB?.answer?.kind, "output", `B's pick keeps its default: ${JSON.stringify(answeredB?.answer)}`);
});

test("one `answer` on an entry in A's state and an exit in B's: entered by A's timer, it leaves B's outstanding pick as it is", async () => {
  const fake = new FakeHarnessExec();
  const a = new MockFlueClient();
  const b = new MockFlueClient();
  const both = answer(({ event }) => `from ${event.type}`);
  const machine = twoWithATimer(fake, a, b, {
    ra: { states: { rest: { after: { 150: "tick" } }, tick: { entry: both } } },
    rb: {
      states: { rest: {}, building: { invoke: { src: "builderB", id: "buildB" }, exit: both } },
    },
  });
  assert.equal(seatsOfAnswer(machine, both).size, 2, "one action object, below two Agents' states");
  const answeredB = await bAloneAfterATimer(machine, fake, a, b);
  assert.equal(answeredB?.answer?.kind, "output", `B's pick keeps its default: ${JSON.stringify(answeredB?.answer)}`);
});

/** A's `ship` starts work in a third region, which has no Agent (`rc`, its command `workC`); the
 * root's transition on that work's done event answers. B's `build_b` starts B's own command. With
 * `aWaits`, A's `ship` also enters A's own work, so A's pick is outstanding until that settles. */
function aStartsRegionWork(fake: FakeHarnessExec, a: MockFlueClient, b: MockFlueClient, aWaits: boolean) {
  const ship = defineEvent({ name: "ship", input: z.object({}) });
  return jr2Setup({
    events: [buildB, ship, defineEvent({ name: "start_c", input: z.object({}) })],
    actors: {
      ws: fakeWorkspace(),
      coderA: agentActorWith(() => a, coderDefinition),
      coderB: agentActorWith(() => b, coderDefinition),
      builderA: commandWith(fake.factory, ["make", "a"]),
      builderB: commandWith(fake.factory, ["make", "b"]),
      workerC: commandWith(fake.factory, ["make", "c"]),
    },
  }).createMachine({
    id: "two",
    invoke: { src: "ws" },
    type: "parallel",
    on: {
      ...(aWaits ? {} : { ship: { actions: raise({ type: "start_c" }) } }),
      "xstate.done.actor.workC": { actions: answer(({ event }) => `the root saw ${event.type}`) },
    },
    states: {
      ra: {
        invoke: { src: "coderA", input: { prompt: "A", endpoint: "http://harness.invalid" } },
        initial: "rest",
        states: aWaits ? { rest: {}, building: { invoke: { src: "builderA", id: "buildA" } } } : { rest: {} },
        ...(aWaits ? { on: { ship: { target: ".building", actions: raise({ type: "start_c" }) } } } : {}),
      },
      rb: {
        invoke: { src: "coderB", input: { prompt: "B", endpoint: "http://harness.invalid" } },
        initial: "rest",
        states: { rest: {}, building: { invoke: { src: "builderB", id: "buildB" } } },
        on: { build_b: ".building" },
      },
      rc: {
        initial: "idle",
        states: { idle: {}, work: { invoke: { src: "workerC", id: "workC" } } },
        on: { start_c: ".work" },
      },
    },
  } as never) as unknown as AnyStateMachine;
}

test("a child an answered-at-once pick started is that Agent's: its done event below no Agent's state leaves B's pick as it is", async () => {
  const fake = new FakeHarnessExec();
  const a = new MockFlueClient();
  const b = new MockFlueClient();
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "two", machine: aStartsRegionWork(fake, a, b, false), provide: () => ({}) });
  await host.start("two");
  await waitFor(() => a.admits.length === 1 && b.admits.length === 1);
  const ia = a.admits[0]!.instanceId;
  const ib = b.admits[0]!.instanceId;
  const pb = host.sendToAgent(ib, { type: "build_b" });
  await waitFor(() => fake.starts.length === 1);
  const pa = host.sendToAgent(ia, { type: "ship" });
  assert.equal(pa.outstanding, undefined, "A's pick is answered on its own POST: A's state is at Rest");
  await waitFor(() => fake.starts.length === 2);
  fake.settle({ outcome: "exited", code: 0, tail: "c worked" }, fake.starts[1]!.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  fake.settle({ outcome: "exited", code: 0, tail: "b built" }, fake.starts[0]!.id);
  const answeredB = await host.awaitDelivery(ib, pb.deliveryId);
  assert.equal(answeredB?.answer?.kind, "output", `B's pick keeps its default: ${JSON.stringify(answeredB?.answer)}`);
});

test("a child an outstanding pick started that outlives the pick's answer is still that Agent's: B's pick is left as it is", async () => {
  const fake = new FakeHarnessExec();
  const a = new MockFlueClient();
  const b = new MockFlueClient();
  const host = new RunHost({ store: await mkStore() });
  host.register({ name: "two", machine: aStartsRegionWork(fake, a, b, true), provide: () => ({}) });
  await host.start("two");
  await waitFor(() => a.admits.length === 1 && b.admits.length === 1);
  const ia = a.admits[0]!.instanceId;
  const ib = b.admits[0]!.instanceId;
  const pb = host.sendToAgent(ib, { type: "build_b" });
  await waitFor(() => fake.starts.length === 1);
  const pa = host.sendToAgent(ia, { type: "ship" });
  assert.equal(pa.outstanding, true);
  await waitFor(() => fake.starts.length === 3);
  const execA = fake.starts.find((s) => s.req.argv[1] === "a")!.id;
  const execC = fake.starts.find((s) => s.req.argv[1] === "c")!.id;
  fake.settle({ outcome: "exited", code: 0, tail: "a built" }, execA);
  const answeredA = await host.awaitDelivery(ia, pa.deliveryId);
  assert.equal(answeredA?.answer?.kind, "output", "A's pick is answered by its own command, before C's work ends");
  fake.settle({ outcome: "exited", code: 0, tail: "c worked" }, execC);
  await new Promise((resolve) => setTimeout(resolve, 20));
  fake.settle({ outcome: "exited", code: 0, tail: "b built" }, fake.starts[0]!.id);
  const answeredB = await host.awaitDelivery(ib, pb.deliveryId);
  assert.equal(answeredB?.answer?.kind, "output", `B's pick keeps its default: ${JSON.stringify(answeredB?.answer)}`);
});
