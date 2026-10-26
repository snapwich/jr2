// The Open body (ADR-0070): the slot a Chart binds, and the actor that runs the Chart. In-process and
// socket-free: the Agents run over MockFlueClient ports (the `agentActorWith` seam), the lent Effect
// over a fake Harness exec, and persistence goes through the real SqliteSnapshotStore and a second
// RunHost, as a restart does.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assign, createActor, fromPromise, SimulatedClock, type AnyActorRef, type AnyStateMachine } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { agentActorWith } from "../src/actor.ts";
import type { AgentDefinition } from "../src/agent.ts";
import { CHART_BRIEFING, chartSchema, ChartRefusal, admitChart, type ChartText } from "../src/chart.ts";
import { customize } from "../src/customize.ts";
import { arg, commandWith } from "../src/effect.ts";
import { isFailure } from "../src/fail.ts";
import { agent } from "../src/harness-client.ts";
import {
  boundChartsOf,
  boundMachineOf,
  compileChart,
  lentOf,
  openBodiesOf,
  openBodyWith,
  admitWrapperChart,
  COMPILE_MEMO_SIZE,
  compiledCount,
  jsonOver,
  WALL_CLOCK_EVENT,
  type Ceilings,
  type OpenBodyLogic,
} from "../src/open-body.ts";
import { chartWrapperOf } from "../src/charts.ts";
import { attachWrapperBody } from "../src/parts.ts";
import { fromPick } from "../src/pick.ts";
import { bindRun, RegistrationTable } from "../src/registration.ts";
import { observe, RunHost, type WorkflowDef } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import type { SnapshotStore } from "../src/snapshot-store.ts";
import { invokingMachine, vocabularyOf } from "../src/vocabulary.ts";
import { fakeWorkspace, FakeHarnessExec } from "./_effects.ts";
import { mkStore, MockFlueClient, tick, waitFor } from "./_fixtures.ts";

const ENDPOINT = "http://harness.invalid";

// Every host a test makes: its live runs are stopped after the test, so no Chart's wall-clock
// timer (xstate's own delayed event) keeps the process alive.
const hosts: RunHost[] = [];
function newHost(opts: ConstructorParameters<typeof RunHost>[0]): RunHost {
  const host = new RunHost(opts);
  hosts.push(host);
  return host;
}
afterEach(async () => {
  for (const host of hosts.splice(0)) for (const run of host.list()) await host.stop(run.runId);
});

/** The fixture Chart the other seams reuse (C1), read as data. */
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/charts/review-loop.chart.json", import.meta.url), "utf8"),
) as ChartText;

const EMPTY = { type: "object", properties: {}, additionalProperties: false } as const;

/** The review loop: the coder picks `submit`, the reviewer `approve` or `revise`. An Agent's
 * invoke never settles on its own (a Turn ends when its state exits), so each Turn ends on a pick. */
const LOOP: ChartText = fixture;

/** One Turn of the lent coder, and done. */
const SIMPLE: ChartText = {
  events: { submit: { input: { ...EMPTY } } },
  initial: "draft",
  states: {
    draft: {
      invoke: { src: "coder", input: { prompt: "do {{input.task}}" } },
      on: { submit: "shipped" },
    },
    shipped: { type: "final" },
  },
};

const coderDefinition: AgentDefinition = { model: "stub/model", instructions: "you are the test coder" };

const CEILINGS: Ceilings = { turns: 20, wallClock: "2h", transitions: 5000, fanOut: 4, size: 65536 };

/** The ports a rig's Agents run over, swapped per host as a restart swaps the process. */
type Ports = { coder: MockFlueClient; minted: MockFlueClient; exec: FakeHarnessExec };

/**
 * A Chart wrapper (ADR-0070): it lends an Agent (`coder`), a `command` Effect (`tests`, over a fake
 * Harness exec), a guard (`underLimit`) and a delay (`cooldown`), and allows the Chart's own Agents
 * one model. Its door takes the Chart (`chart: chartSchema`), so a run can be one-shot.
 */
function chartedMachine(
  ports: Ports,
  opts: {
    ceilings?: Partial<Ceilings>;
    lendGuard?: boolean;
    lendCoder?: boolean;
    id?: string;
    /** Lend the Part that fails the run (ADR-0073). */
    lendFail?: boolean;
    /** Catch a Failure of the body in the wrapper, with an `onError` guarded by `isFailure`. */
    catchFailure?: boolean;
    /** Catch any error of the body in the wrapper, with an `onError` that keeps its message. */
    catchError?: boolean;
    /** Make the wrapper's `agent.fault` route a guard that is false, so that no transition takes it. */
    dropFault?: boolean;
  } = {},
): AnyStateMachine {
  const lendGuard = opts.lendGuard ?? true;
  const lendCoder = opts.lendCoder ?? true;
  return jr2Setup({
    types: {} as {
      context: { chart: unknown; endpoint: string; task: string; result?: unknown };
      input: { chart: unknown; endpoint: string; task: string };
    },
    events: [],
    actors: {
      coder: agent(coderDefinition),
      ws: fakeWorkspace(),
      tests: commandWith(ports.exec.factory, ["pnpm", "test", arg("filter")]),
      body: openBodyWith(
        {
          lends: {
            agents: lendCoder ? ["coder"] : [],
            effects: ["tests"],
            ...(lendGuard ? { guards: ["underLimit", "keepGoing"] } : {}),
            delays: ["cooldown"],
            ...(opts.lendFail ? { fail: true } : {}),
          },
          allows: { models: ["stub/model"], workspace: ["none", "write"] },
          ceilings: { ...CEILINGS, ...opts.ceilings },
        },
        { mintAgent: (_slot, def) => agentActorWith(() => ports.minted, def) },
      ),
    },
    // The guards read the CHART's context: a lent guard runs in the Machine the Chart compiles to.
    guards: (lendGuard
      ? {
          underLimit: ({ context }: { context: { round?: number } }) => (context.round ?? 0) < 3,
          keepGoing: () => true,
        }
      : {}) as never,
    delays: { cooldown: 10 },
  }).createMachine({
    id: opts.id ?? "charted",
    input: z.object({ endpoint: z.string(), task: z.string(), chart: chartSchema }),
    context: ({ input }) => ({ ...input }),
    // The route for each Agent fault, the Chart's Agents too: the body sends it a Chart's unrouted one (ADR-0074).
    on: {
      "agent.fault": {
        target: ".faulted",
        ...(opts.dropFault ? { guard: () => false } : {}),
        actions: assign({ result: ({ event }) => event.reason }),
      },
    },
    // A stand-in Workspace: the lent `command` runs in its Harness (ADR-0067).
    invoke: { src: "ws" },
    initial: "run",
    states: {
      run: {
        invoke: {
          id: "body",
          src: "body",
          input: ({ context }: { context: { chart: unknown; endpoint: string; task: string } }) => ({
            chart: context.chart,
            endpoint: context.endpoint,
            task: context.task,
          }),
          // D-A: a refusal is the body's OUTPUT, routed on `outcome`.
          onDone: [
            {
              guard: ({ event }) => (event.output as { outcome: string }).outcome === "refused",
              target: "refused",
              actions: assign({ result: ({ event }) => event.output }),
            },
            { target: "done", actions: assign({ result: ({ event }) => event.output }) },
          ],
          ...(opts.catchFailure
            ? {
                onError: {
                  guard: ({ event }: { event: { error: unknown } }) => isFailure(event.error),
                  target: "caught",
                  actions: assign({ result: ({ event }) => (isFailure(event.error) ? event.error.reason : undefined) }),
                },
              }
            : {}),
          ...(opts.catchError
            ? {
                onError: {
                  target: "errored",
                  actions: assign({ result: ({ event }) => (event.error as Error).message }),
                },
              }
            : {}),
        },
      },
      done: { type: "final" },
      refused: { type: "final" },
      caught: { type: "final" },
      errored: { type: "final" },
      faulted: { type: "final" },
    },
  }) as unknown as AnyStateMachine;
}

function rig(opts: Parameters<typeof chartedMachine>[1] = {}) {
  const ports: Ports = { coder: new MockFlueClient(), minted: new MockFlueClient(), exec: new FakeHarnessExec() };
  const machine = chartedMachine(ports, opts);
  const def = (): WorkflowDef => ({
    name: "charted",
    machine,
    // The run's coder over the test port (ADR-0049's seam): the Chart borrows THIS one.
    provide: () => ({ actors: { coder: agentActorWith(() => ports.coder, coderDefinition) } }),
  });
  return { ports, machine, def };
}

/** The live root actor of a run (a test reads the tree the way the Console's feed does). */
const actorOf = (host: RunHost, runId: string): AnyActorRef =>
  (host as unknown as { runs: Map<string, { actor: AnyActorRef }> }).runs.get(runId)!.actor;

const bodyOf = (root: AnyActorRef): AnyActorRef =>
  (root.getSnapshot() as { children: Record<string, AnyActorRef> }).children.body!;

async function started(host: RunHost, chart: unknown = LOOP, task = "add a flag") {
  const { runId } = await host.start("charted", { endpoint: ENDPOINT, task, chart });
  return runId;
}

test("a one-shot Chart runs to done under its wrapper, with its output resolved (ADR-0070)", async () => {
  const { ports, def } = rig();
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const runId = await started(host);

  await waitFor(() => ports.coder.admits.length === 1);
  assert.equal(
    ports.coder.admits[0]!.prompt,
    "Implement this task: add a flag\nReview notes so far: ",
    "the lent coder's prompt is the Chart's value, its references resolved against the input and the context",
  );
  const status = host.status(runId)!;
  assert.equal(status.bound, true, "the run binds a Chart");
  assert.deepEqual(
    status.children.map((c) => [c.src, c.value]),
    [["body", "draft"]],
    "the body's state value is the Chart's",
  );

  host.sendToAgent(ports.coder.admits[0]!.instanceId, { type: "submit" });
  await waitFor(() => ports.minted.admits.length === 1);
  const review = ports.minted.admits[0]!;
  host.sendToAgent(review.instanceId, { type: "revise", notes: "rename it" });
  await waitFor(() => ports.coder.admits.length === 2);
  assert.match(ports.coder.admits[1]!.prompt!, /Review notes so far: rename it$/, "set wrote the event's notes");

  host.sendToAgent(ports.coder.admits[1]!.instanceId, { type: "submit" });
  await waitFor(() => ports.minted.admits.length === 2);
  host.sendToAgent(ports.minted.admits[1]!.instanceId, { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(final?.status, "done");
  assert.deepEqual((final?.context as { result: unknown }).result, { outcome: "done", output: { rounds: 1 } });
});

// --- A Chart fails the run (ADR-0073) ------------------------------------------------------------

/** A Chart that fails the run with the task as the reason, or catches its own Failure with
 * `jr2.failure` and ends done. */
const failingChart = (catchIt: boolean): ChartText => ({
  initial: "stop",
  states: {
    stop: {
      invoke: {
        src: "fail",
        input: { reason: "{{input.task}}", detail: { step: "stop" } },
        ...(catchIt ? { onError: { guard: "jr2.failure", target: "recovered" } } : {}),
      },
    },
    recovered: { type: "final" },
  },
  output: { recovered: true },
});

test("a Chart under a body that lends `fail` ends the run `failed`, with the Failure as its output", async () => {
  const { def } = rig({ lendFail: true });
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const runId = await started(host, failingChart(false), "no plan fits");
  await waitFor(() => host.status(runId) === undefined);
  const final = (await host.read(runId))!;
  assert.equal(final.status, "failed");
  assert.equal(final.fault, undefined, "a Failure is no fault");
  assert.deepEqual(final.output, { reason: "no plan fits", detail: { step: "stop" } });
});

test("a Chart's own onError catches its Failure with `jr2.failure`, and the run ends done", async () => {
  const { def } = rig({ lendFail: true });
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const runId = await started(host, failingChart(true));
  await waitFor(() => host.status(runId) === undefined);
  const final = (await host.read(runId))!;
  assert.equal(final.status, "done");
  assert.deepEqual((final.context as { result: unknown }).result, { outcome: "done", output: { recovered: true } });
});

test("the wrapper catches a Chart's Failure on its Open body state, with isFailure", async () => {
  const { def } = rig({ lendFail: true, catchFailure: true });
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const runId = await started(host, failingChart(false), "the tests failed");
  await waitFor(() => host.status(runId) === undefined);
  const final = (await host.read(runId))!;
  assert.equal(final.status, "done");
  assert.deepEqual(final.value, "caught");
  assert.equal((final.context as { result: unknown }).result, "the tests failed");
});

// --- An agent.fault that the Chart does not route (ADR-0070, ADR-0074) ---------------------------

/** One Turn of the lent coder, with no `agent.fault` route: in a Chart the route is optional. */
const UNROUTED: ChartText = {
  id: "unrouted",
  events: { submit: { input: { ...EMPTY } } },
  initial: "draft",
  states: {
    draft: { invoke: { src: "coder", input: { prompt: "do {{input.task}}" } }, on: { submit: "shipped" } },
    shipped: { type: "final" },
  },
};

test("the trial compile admits a Chart state with no agent.fault route: jr2Setup's refusal is not for a Chart", () => {
  const { machine } = rig();
  assert.doesNotThrow(() => admitWrapperChart(machine, UNROUTED));
});

test("an agent.fault that the Chart does not route goes to the wrapper, unchanged, and the wrapper's route takes it", async () => {
  const { ports, def } = rig({ catchError: true });
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const runId = await started(host, UNROUTED);
  await waitFor(() => ports.coder.settled.length === 1);
  ports.coder.fault("the harness went away");
  await waitFor(() => host.status(runId) === undefined);
  const final = (await host.read(runId))!;
  assert.equal(final.status, "done", "the wrapper routed the fault");
  assert.equal(final.value, "faulted", "the wrapper's agent.fault route, never its onError");
  assert.equal((final.context as { result: unknown }).result, "the harness went away");
});

test("an agent.fault that neither the Chart nor its wrapper takes ends the run `error`, never `failed`", async () => {
  const { ports, def } = rig({ dropFault: true });
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const runId = await started(host, UNROUTED);
  await waitFor(() => ports.coder.settled.length === 1);
  ports.coder.fault("the harness went away");
  await waitFor(() => host.status(runId) === undefined);
  const final = (await host.read(runId))!;
  assert.equal(final.status, "error", "nobody chose this end: a fault, not a Failure");
  assert.match(final.fault ?? "", /machine "charted" got "agent\.fault" in state .*\(the harness went away\)/);
});

test("an agent.fault whose Chart route has a false guard is not routed: it goes to the wrapper", async () => {
  const guarded: ChartText = {
    ...UNROUTED,
    states: {
      ...UNROUTED.states,
      draft: {
        ...UNROUTED.states.draft!,
        on: { submit: "shipped", "agent.fault": { target: "shipped", guard: { not: "keepGoing" } } },
      },
    },
  };
  const { ports, def } = rig({ catchError: true });
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const runId = await started(host, guarded);
  await waitFor(() => ports.coder.settled.length === 1);
  ports.coder.fault("the harness went away");
  await waitFor(() => host.status(runId) === undefined);
  const final = (await host.read(runId))!;
  assert.equal(final.value, "faulted");
  assert.equal((final.context as { result: unknown }).result, "the harness went away");
});

test("an agent.fault that the Chart routes is the Chart's: the body stays live and goes on", async () => {
  const routed: ChartText = {
    ...UNROUTED,
    states: {
      ...UNROUTED.states,
      draft: { ...UNROUTED.states.draft!, on: { submit: "shipped", "agent.fault": "shipped" } },
    },
  };
  const { ports, def } = rig({ catchError: true });
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const runId = await started(host, routed);
  await waitFor(() => ports.coder.settled.length === 1);
  ports.coder.fault("the harness went away");
  await waitFor(() => host.status(runId) === undefined);
  const final = (await host.read(runId))!;
  assert.equal(final.status, "done");
  assert.equal(final.value, "done", "the Chart's own route ended it, so the wrapper never saw the fault");
});

test("the wrapper's route for a Chart's agent.fault stops the body's other children: a sibling Turn does not go on", async () => {
  // Two regions, each with its own pick, so that the sentBy refusal does not apply. The wrapper's route
  // leaves the Open body's state, and that exit stops the body with every Turn below it.
  const both: ChartText = {
    id: "both",
    events: { submit: { input: { ...EMPTY } }, looked: { input: { ...EMPTY } } },
    agents: { reviewer: { model: "stub/model", instructions: "You review.", workspace: "none" } },
    initial: "fan",
    states: {
      fan: {
        type: "parallel",
        states: {
          r1: { invoke: { src: "coder", input: { prompt: "one" } }, on: { submit: "#both.end" } },
          r2: { invoke: { src: "reviewer", input: { prompt: "two" } }, on: { looked: "#both.end" } },
        },
      },
      end: { type: "final" },
    },
  };
  const { ports, def } = rig({ catchError: true });
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const runId = await started(host, both);
  await waitFor(() => ports.coder.settled.length === 1 && ports.minted.settled.length === 1);
  ports.coder.fault("the harness went away");
  await waitFor(() => host.status(runId) === undefined);
  const final = (await host.read(runId))!;
  assert.equal(final.value, "faulted");
  await tick();
  await tick();
  assert.equal(ports.minted.aborts.length, 1, "the sibling Turn was stopped");
});

test("a Chart Agent's fault that the body forwards answers a held pick as the fault of an Agent of the Machine does", async () => {
  // The planner's pick `go` is held while `busy` runs. A route back to the planner's Rest answers the
  // pick with the fault, whether the Agent ran in a Chart or in the Machine: the body relays the event
  // from itself, as `sendBack` relays it from an Agent, and the run host reads that source.
  const go = defineEvent({ name: "go", input: z.object({}) });
  const plannerDef = { model: "stub/model", instructions: "plan" };
  const chart: ChartText = {
    events: { submit: { input: { ...EMPTY } } },
    initial: "draft",
    states: {
      draft: { invoke: { src: "coder", input: { prompt: "do it" } }, on: { submit: "shipped" } },
      shipped: { type: "final" },
    },
  };
  const answerOf = async (kind: "chart" | "machine") => {
    const planner = new MockFlueClient();
    const coder = new MockFlueClient();
    const busy =
      kind === "chart"
        ? { id: "body", src: "body", input: { chart, endpoint: ENDPOINT }, onDone: "#held.done" }
        : { id: "nested", src: "coder", input: { prompt: "do it", endpoint: ENDPOINT } };
    const machine = jr2Setup({
      events: [go],
      actors: {
        planner: agentActorWith(() => planner, plannerDef),
        coder: agentActorWith(() => coder, coderDefinition),
        body: openBodyWith({
          lends: { agents: ["coder"] },
          allows: { models: [], workspace: [] },
          ceilings: CEILINGS,
        }),
      },
    }).createMachine({
      id: "held",
      initial: "plan",
      states: {
        plan: {
          invoke: { src: "planner", input: { prompt: "plan", endpoint: ENDPOINT } },
          on: { "agent.fault": "#held.done" },
          initial: "ready",
          states: { ready: { on: { go: "busy" } }, busy: { invoke: busy, on: { "agent.fault": "ready" } } },
        },
        done: { type: "final" },
      },
    } as never) as unknown as AnyStateMachine;
    const host = newHost({ store: await mkStore() });
    host.register({ name: "held", machine, provide: () => ({}) });
    await host.start("held");
    await waitFor(() => planner.admits.length === 1);
    const iid = planner.admits[0]!.instanceId;
    const going = host.sendToAgent(iid, { type: "go" });
    const answered = host.awaitDelivery(iid, going.deliveryId);
    await waitFor(() => coder.admits.length === 1);
    coder.fault("the harness went away");
    const { answer, turnComplete } = (await answered) as {
      answer?: { event?: string; payload?: { reason?: string } };
      turnComplete?: boolean;
    };
    return {
      event: answer?.event,
      reason: answer?.payload?.reason,
      turnComplete,
      plannerAborts: planner.aborts.length,
    };
  };
  const machine = await answerOf("machine");
  assert.deepEqual(machine, {
    event: "agent.fault",
    reason: "the harness went away",
    turnComplete: false,
    plannerAborts: 0,
  });
  assert.deepEqual(await answerOf("chart"), machine);
});

test("an agent.fault route whose guard reads a context path the run does not hold is a route: the step refuses", async () => {
  // The guard throws when it resolves its params, so the Open body cannot know that the route is not taken. It counts
  // the guard as a route, and the step's refusal settles the body `refused`; the event does not go to the wrapper.
  const unresolved: ChartText = {
    ...UNROUTED,
    states: {
      ...UNROUTED.states,
      draft: {
        ...UNROUTED.states.draft!,
        on: {
          // `notes` is written on `submit`, so the door's dataflow sees the write; the fault comes first.
          submit: { target: "shipped", actions: [{ type: "set", path: "notes", from: "n" }] },
          "agent.fault": { target: "shipped", guard: { type: "underLimit", params: { n: "{{context.notes}}" } } },
        },
      },
    },
  };
  const { ports, def } = rig({ catchError: true });
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const runId = await started(host, unresolved);
  await waitFor(() => ports.coder.settled.length === 1);
  ports.coder.fault("the harness went away");
  await waitFor(() => host.status(runId) === undefined);
  const final = (await host.read(runId))!;
  assert.equal(final.status, "done", "the wrapper routed the refusal; the run did not fault");
  assert.notEqual(final.value, "faulted", "a refusal, not a fault the wrapper routed");
  const result = (final.context as { result: { outcome: string; report: string[] } }).result;
  assert.equal(result.outcome, "refused");
  assert.match(result.report[0]!, /^\(run time\): Chart reference "context\.notes" resolves to nothing/);
});

test("the Chart's minted Agent registers its Menu from the Chart's events, and its definition rides the Turn", async () => {
  const { ports, def } = rig();
  const host = newHost({ store: await mkStore() });
  host.register(def());
  await started(host);
  await waitFor(() => ports.coder.admits.length === 1);
  const coderSurface = host.agentSurface(ports.coder.admits[0]!.instanceId)!;
  assert.deepEqual(
    coderSurface.menu.map((e) => e.name),
    ["submit"],
    "the lent coder's Menu is the Chart's events its states take",
  );

  host.sendToAgent(ports.coder.admits[0]!.instanceId, { type: "submit" });
  await waitFor(() => ports.minted.admits.length === 1);
  const iid = ports.minted.admits[0]!.instanceId;
  const surface = host.agentSurface(iid)!;
  assert.deepEqual(
    surface.menu.map((e) => e.name),
    ["approve", "revise"],
    "the registration table holds the Chart's events as the minted Agent's Menu",
  );
  assert.deepEqual(surface.allowed, ["approve", "revise"]);
  const revise = surface.menu.find((e) => e.name === "revise")!;
  assert.deepEqual((revise.input as { required?: string[] }).required, ["notes"], "its payload is the event's schema");
  assert.equal(ports.minted.admits[0]!.agentName, "reviewer", "the slot key is the Agent's name");
  assert.deepEqual(ports.minted.definitions[0], {
    model: "stub/model",
    instructions: fixture.agents!.reviewer!.instructions,
    workspace: "none",
  });

  // A pick delivered to the minted Agent routes the Chart.
  const moved = host.sendToAgent(iid, { type: "approve" });
  assert.equal(moved.moved, true);
});

test("a pick the Chart's event schema refuses is refused at delivery, as under any Machine", async () => {
  const { ports, def } = rig();
  const host = newHost({ store: await mkStore() });
  host.register(def());
  await started(host);
  await waitFor(() => ports.coder.admits.length === 1);
  host.sendToAgent(ports.coder.admits[0]!.instanceId, { type: "submit" });
  await waitFor(() => ports.minted.admits.length === 1);
  assert.throws(() => host.sendToAgent(ports.minted.admits[0]!.instanceId, { type: "revise" }), /notes/);
});

test("a `{{` inside data is never resolved: the task lands in the prompt as written", async () => {
  const { ports, def } = rig();
  const host = newHost({ store: await mkStore() });
  host.register(def());
  await started(host, LOOP, "print {{context.notes}} and {{input.task}}");
  await waitFor(() => ports.coder.admits.length === 1);
  assert.equal(
    ports.coder.admits[0]!.prompt,
    "Implement this task: print {{context.notes}} and {{input.task}}\nReview notes so far: ",
  );
});

test("the door: a one-shot Chart is admitted before the run exists, and a refusal is a ChartRefusal", async () => {
  const { def } = rig();
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const bad = {
    ...LOOP,
    states: { ...LOOP.states, draft: { ...LOOP.states.draft, invoke: { src: "linter", input: { prompt: "x" } } } },
  };
  await assert.rejects(
    () => host.start("charted", { endpoint: ENDPOINT, task: "t", chart: bad }),
    (err: unknown) =>
      err instanceof ChartRefusal &&
      err.report.some((line) => line.startsWith("states.draft.invoke.src") && line.includes("linter")),
  );
  assert.deepEqual(host.list(), [], "no run was started");
});

/** A wrapper whose body's Chart is no door field: the refusal happens in the body, at invoke. */
function innerChartMachine(ports: Ports, chart: unknown): AnyStateMachine {
  return jr2Setup({
    types: {} as { context: { result?: unknown } },
    events: [],
    actors: {
      coder: agent(coderDefinition),
      body: openBodyWith(
        {
          lends: { agents: ["coder"] },
          allows: { models: ["stub/model"], workspace: ["none"] },
          ceilings: CEILINGS,
        },
        { mintAgent: (_slot, d) => agentActorWith(() => ports.minted, d) },
      ),
    },
  }).createMachine({
    on: { "agent.fault": {} },
    id: "inner",
    context: {},
    initial: "run",
    states: {
      run: {
        invoke: {
          src: "body",
          input: { chart, endpoint: ENDPOINT, task: "t" },
          onDone: [
            {
              guard: ({ event }) => (event.output as { outcome: string }).outcome === "refused",
              target: "refused",
              actions: assign({ result: ({ event }) => event.output }),
            },
            { target: "done", actions: assign({ result: ({ event }) => event.output }) },
          ],
          onError: "faulted",
        },
      },
      done: { type: "final" },
      refused: { type: "final" },
      faulted: { type: "final" },
    },
    // What its body settled with, for a Machine that invokes this wrapper.
    output: ({ context }) => context.result,
  }) as unknown as AnyStateMachine;
}

test("D-A: a Chart refused in the body settles it with `refused` as its OUTPUT, and the wrapper's onDone routes it", async () => {
  const ports: Ports = { coder: new MockFlueClient(), minted: new MockFlueClient(), exec: new FakeHarnessExec() };
  const chart = { initial: "a", states: { a: { invoke: { src: "linter", input: { prompt: "x" } } } } };
  const host = newHost({ store: await mkStore() });
  host.register({ name: "inner", machine: innerChartMachine(ports, chart), provide: () => ({}) });
  const { runId } = await host.start("inner");
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.deepEqual(final?.value, "refused", "onDone, not onError");
  const result = (final?.context as { result: { outcome: string; report: string[] } }).result;
  assert.equal(result.outcome, "refused");
  assert.match(result.report[0]!, /^states\.a\.invoke\.src: "linter" is not a lent actor/);
  assert.match(result.report[0]!, /lent: coder \(Agent\)/);
});

// --- The planner path (ADR-0070, D-A): a pick carries the Chart -----------------------------------

const runChart = defineEvent({
  name: "run_chart",
  description: "Run this Chart under the body.",
  input: z.object({ chart: chartSchema }),
});

function plannerMachine(ports: Ports & { planner: MockFlueClient }): AnyStateMachine {
  return jr2Setup({
    types: {} as { context: { endpoint: string; task: string; result?: unknown } },
    events: [runChart],
    actors: {
      planner: agent({ model: "stub/model", instructions: "plan", workspace: "none" }),
      coder: agent(coderDefinition),
      body: openBodyWith(
        {
          lends: { agents: ["coder"], guards: ["underLimit"] },
          allows: { models: ["stub/model"], workspace: ["none", "write"] },
          ceilings: CEILINGS,
        },
        { mintAgent: (_slot, d) => agentActorWith(() => ports.minted, d) },
      ),
    },
    guards: { underLimit: ({ context }: { context: { round?: number } }) => (context.round ?? 0) < 3 } as never,
  }).createMachine({
    on: { "agent.fault": {} },
    id: "planned",
    context: { endpoint: ENDPOINT, task: "add a flag" },
    initial: "planning",
    states: {
      planning: {
        invoke: { src: "planner", input: { prompt: "plan it", endpoint: ENDPOINT, continue: true } },
        on: { run_chart: ".running" },
        initial: "idle",
        states: {
          idle: {},
          running: {
            invoke: {
              src: "body",
              input: fromPick(runChart, ({ context }: { context: { endpoint: string; task: string } }) => ({
                endpoint: context.endpoint,
                task: context.task,
              })),
              onDone: [
                // The refusal goes back to the planner: its pick's answer is the body's output.
                { guard: ({ event }) => (event.output as { outcome: string }).outcome === "refused", target: "idle" },
                { target: "#planned.done", actions: assign({ result: ({ event }) => event.output }) },
              ],
            },
          },
        },
      },
      done: { type: "final" },
    },
  }) as unknown as AnyStateMachine;
}

test("the planner: a pick carrying a refused Chart is answered with the report, and a corrected one runs", async () => {
  const ports = {
    coder: new MockFlueClient(),
    minted: new MockFlueClient(),
    exec: new FakeHarnessExec(),
    planner: new MockFlueClient(),
  };
  const host = newHost({ store: await mkStore() });
  host.register({
    name: "planned",
    machine: plannerMachine(ports),
    provide: () => ({
      actors: {
        planner: agentActorWith(() => ports.planner, { model: "stub/model", instructions: "plan", workspace: "none" }),
        coder: agentActorWith(() => ports.coder, coderDefinition),
      },
    }),
  });
  const { runId } = await host.start("planned");
  await waitFor(() => ports.planner.admits.length === 1);
  const iid = ports.planner.admits[0]!.instanceId;

  // The surface marks the pick whose parameter is a Chart with jr2's briefing on how one runs, so
  // the Harness says it on the Turns that may make that pick and nowhere else (ADR-0070).
  const surface = host.agentSurface(iid)!;
  assert.equal(surface.menu.find((m) => m.name === "run_chart")?.briefing, CHART_BRIEFING);
  assert.equal(
    host.agentSurface(ports.planner.admits[0]!.instanceId)!.menu.every((m) => m.name === "run_chart" || !m.briefing),
    true,
  );

  const bad = {
    ...LOOP,
    states: {
      ...LOOP.states,
      draft: { invoke: { src: "linter", input: { prompt: "lint" } }, on: { submit: "review" } },
    },
  };
  const first = host.sendToAgent(iid, { type: "run_chart", chart: bad });
  const answered = first.answered ? first : await host.awaitDelivery(iid, first.deliveryId!);
  const answer = answered?.answer as { kind: string; output?: { outcome: string; report: string[] } };
  assert.equal(answer?.kind, "output", "the body's output is the link the planner reads");
  assert.equal(answer.output?.outcome, "refused");
  assert.ok(
    answer.output!.report.some((line) => line.includes('"linter" is not a lent actor') && line.includes("coder")),
    "the report names the src and the lent set",
  );
  await waitFor(() => JSON.stringify(host.status(runId)?.value) === JSON.stringify({ planning: "idle" }));

  host.sendToAgent(iid, { type: "run_chart", chart: LOOP });
  await waitFor(() => ports.coder.admits.length === 1);
  assert.equal(host.status(runId)?.bound, true);
  host.sendToAgent(ports.coder.admits[0]!.instanceId, { type: "submit" });
  await waitFor(() => ports.minted.admits.length === 1);
  host.sendToAgent(ports.minted.admits[0]!.instanceId, { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.deepEqual((final?.context as { result: unknown }).result, { outcome: "done", output: { rounds: 0 } });
});

// --- Ceilings -------------------------------------------------------------------------------------

async function ceilingOf(
  host: RunHost,
  runId: string,
): Promise<{ outcome: string; ceiling?: string; detail?: string }> {
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  return (final?.context as { result: { outcome: string; ceiling?: string; detail?: string } }).result;
}

test("ceiling: Turns — a Chart that loops its Agent is settled when it starts one Turn too many", async () => {
  const { ports, def } = rig({ ceilings: { turns: 2 } });
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const looping: ChartText = {
    events: { again: { input: { ...EMPTY } } },
    initial: "work",
    states: {
      work: {
        invoke: { src: "coder", input: { prompt: "go" } },
        on: { again: { target: "work", reenter: true } },
      },
    },
  };
  const runId = await started(host, looping);
  await waitFor(() => ports.coder.admits.length === 1);
  host.sendToAgent(ports.coder.admits[0]!.instanceId, { type: "again" });
  await waitFor(() => ports.coder.admits.length === 2);
  host.sendToAgent(ports.coder.admits[1]!.instanceId, { type: "again" });
  const result = await ceilingOf(host, runId);
  assert.equal(result.outcome, "ceiling");
  assert.equal(result.ceiling, "turns");
  await tick();
  assert.equal(ports.coder.admits.length, 2, "the third Turn is never admitted");
});

test("ceiling: transitions — a guarded `always` ping-pong ends at the microstep budget", async () => {
  const { def } = rig({ ceilings: { transitions: 50 } });
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const pingPong: ChartText = {
    initial: "ping",
    states: {
      ping: { always: { target: "pong", guard: "keepGoing" } },
      pong: { always: { target: "ping", guard: "keepGoing" } },
    },
  };
  const runId = await started(host, pingPong);
  const result = await ceilingOf(host, runId);
  assert.equal(result.outcome, "ceiling");
  assert.equal(result.ceiling, "transitions");
});

test("ceiling: transitions is one microstep budget for the run, across events (ADR-0070)", async () => {
  const { def } = rig({ ceilings: { transitions: 30 } });
  const host = newHost({ store: await mkStore() });
  host.register(def());
  // Each timer event takes three microsteps: x -> y on the event, then two guarded `always` hops.
  const hops: ChartText = {
    initial: "x",
    states: {
      x: { after: { "0": "y" } },
      y: { always: { target: "z", guard: "keepGoing" } },
      z: { always: { target: "x", guard: "keepGoing" } },
    },
  };
  const runId = await started(host, hops);
  const result = await ceilingOf(host, runId);
  assert.equal(result.outcome, "ceiling");
  assert.equal(result.ceiling, "transitions");
  const took = Number(/took (\d+) microsteps/.exec(String(result.detail))?.[1]);
  assert.ok(took >= 30 && took <= 33, `about 30 microsteps in all, never 30 per event (detail: ${result.detail})`);
});

test("ceiling: size — a context that doubles its JSON on each transition is settled before a save fails", async () => {
  const { def } = rig();
  const host = newHost({ store: await mkStore() });
  host.register(def());
  // Two copies of one list are one structure in memory, and twice its JSON.
  const double = { type: "set", path: "a", from: ["{{context.a}}", "{{context.a}}"] };
  const timed: ChartText = {
    context: { a: ["x"] },
    initial: "x",
    states: {
      x: { entry: [double], after: { "0": "y" } },
      y: { entry: [double], after: { "0": "x" } },
    },
  };
  const runId = await started(host, timed);
  const result = await ceilingOf(host, runId);
  assert.equal(result.outcome, "ceiling");
  assert.equal(result.ceiling, "size");
  assert.match(String(result.detail), /context is more than \d+ bytes of JSON/);
  assert.equal((await host.read(runId))?.status, "done", "the run settled and its snapshot saved");

  // In one macrostep too: a guarded `always` loop doubles it thousands of times in memory, and the
  // body still settles on a ceiling, never a fault of the run.
  const host2 = newHost({ store: await mkStore() });
  host2.register(def());
  const looped: ChartText = {
    context: { a: ["x"] },
    initial: "x",
    states: {
      x: { always: { target: "y", guard: "keepGoing", actions: [double] } },
      y: { always: { target: "x", guard: "keepGoing", actions: [double] } },
    },
  };
  const run2 = await started(host2, looped);
  const result2 = await ceilingOf(host2, run2);
  assert.equal(result2.outcome, "ceiling");
});

test("jsonOver counts a shared reference each time, and stops at the cap", () => {
  let v: unknown = ["x"];
  for (let i = 0; i < 200; i++) v = [v, v];
  assert.equal(jsonOver(v, 1024), true, "2^200 copies are measured in at most the cap");
  assert.equal(jsonOver({ a: "x".repeat(10) }, 1024), false);
  assert.equal(jsonOver({ a: "x".repeat(2000) }, 1024), true);
});

test("ceiling: fan-out — a parallel state of five invokes is more than four children at once", async () => {
  const { ports, def } = rig({ ceilings: { fanOut: 4 } });
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const region = (n: number) => ({
    invoke: { id: `c${n}`, src: "coder", input: { prompt: `part ${n}` } },
  });
  const wide: ChartText = {
    initial: "fan",
    states: {
      fan: { type: "parallel", states: { r1: region(1), r2: region(2), r3: region(3), r4: region(4), r5: region(5) } },
    },
  };
  const runId = await started(host, wide);
  const result = await ceilingOf(host, runId);
  assert.equal(result.outcome, "ceiling");
  assert.equal(result.ceiling, "fanOut");
  await tick();
  assert.equal(ports.coder.admits.length, 0, "the children were stopped before any Turn was admitted");
});

test("ceiling: wall clock — xstate's own delayed event ends a parked Chart (a fake clock)", async () => {
  const { machine } = rig({ ceilings: { wallClock: "10m" } });
  const parked: ChartText = { initial: "wait", states: { wait: {} } };
  const clock = new SimulatedClock();
  const actor = createActor(machine, { clock, input: { endpoint: ENDPOINT, task: "t", chart: parked } });
  actor.start();
  assert.deepEqual(actor.getSnapshot().value, "run");
  clock.increment(9 * 60_000);
  assert.deepEqual(actor.getSnapshot().value, "run", "not yet");
  clock.increment(60_000);
  assert.equal(actor.getSnapshot().status, "done");
  const result = (actor.getSnapshot().context as { result: { outcome: string; ceiling: string } }).result;
  assert.equal(result.outcome, "ceiling");
  assert.equal(result.ceiling, "wallClock");
  assert.equal(WALL_CLOCK_EVENT, "jr2.openBody.wallClock");
});

// --- Persistence and restore (ADR-0007, D-B) -------------------------------------------------------

async function savedAt(store: SnapshotStore, runId: string, pred: (blob: { snapshot: unknown }) => boolean) {
  let ok = false;
  await waitFor(() => {
    void store.load(runId).then((row) => {
      ok = row?.snapshot ? pred(row.snapshot as { snapshot: unknown }) : false;
    });
    return ok;
  });
}

/** Park a run at the Chart's `review`, with the minted reviewer admitted, and stop the host. */
async function parkedAtReview(store: SnapshotStore, def: WorkflowDef, ports: Ports) {
  const host = newHost({ store });
  host.register(def);
  const runId = await started(host);
  await waitFor(() => ports.coder.admits.length === 1);
  host.sendToAgent(ports.coder.admits[0]!.instanceId, { type: "submit" });
  await waitFor(() => ports.minted.admits.length === 1);
  const iid = ports.minted.admits[0]!.instanceId;
  await savedAt(store, runId, (blob) => {
    const agents = (blob as { agents?: Record<string, unknown> }).agents ?? {};
    return agents[iid] !== undefined && JSON.stringify(blob.snapshot).includes('"value":"review"');
  });
  await host.stop(runId);
  return { runId, iid };
}

test("persistence: a Chart saved mid-run resumes in its state in a new host, and its Agent re-attaches", async () => {
  const store = await mkStore();
  const { ports, def } = rig();
  const { runId, iid } = await parkedAtReview(store, def(), ports);
  const row = await store.load(runId);
  const charts = boundChartsOf((row!.snapshot as { snapshot: unknown }).snapshot);
  assert.equal(charts.length, 1, "the body's snapshot keeps the Chart's text (D-B)");
  assert.deepEqual(charts[0]!.path, ["body"]);
  assert.equal(charts[0]!.src, "body");
  assert.equal(
    charts[0]!.chartHash,
    admitChart(LOOP, openBodyDecl(def().machine), lentOf(bodyLogic(def().machine))!).hash,
  );

  // A new process: new ports, the same Machine.
  const admitted = ports.minted.admits.length;
  ports.minted = new MockFlueClient();
  ports.coder = new MockFlueClient();
  const second = newHost({ store });
  second.register(def());
  assert.deepEqual((await second.restore()).reattached, [runId]);
  await tick();
  assert.deepEqual(
    second.status(runId)!.children.map((c) => c.value),
    ["review"],
    "the Chart resumes in its state",
  );
  assert.equal(ports.minted.admits.length, 0, "no fresh admit: the reviewer re-attaches");
  assert.equal(ports.minted.settled.length, 1, "it follows the persisted admission");
  assert.ok(admitted > 0);
  assert.ok(second.agentSurface(iid), "the restored Agent registered its surface again");
  assert.deepEqual(
    second.agentSurface(iid)!.menu.map((e) => e.name),
    ["approve", "revise"],
    "with the Chart's Menu",
  );
  second.sendToAgent(iid, { type: "approve" });
  await waitFor(() => second.status(runId) === undefined);
  assert.equal((await second.read(runId))?.status, "done");
});

function bodyLogic(machine: AnyStateMachine): OpenBodyLogic {
  return openBodiesOf(machine)[0]!.logic;
}
function openBodyDecl(machine: AnyStateMachine) {
  return bodyLogic(machine).openBody;
}

test("restore: a lent slot the wrapper dropped makes the run drifted, naming the body and the slot", async () => {
  const store = await mkStore();
  const { ports, def } = rig();
  const { runId } = await parkedAtReview(store, def(), ports);

  // The wrapper no longer lends the guard the Chart's `revise` uses, and no longer has it.
  const dropped = rig({ lendGuard: false });
  const second = newHost({ store });
  second.register(dropped.def());
  assert.deepEqual((await second.restore()).drifted, [runId]);
  const read = await second.read(runId);
  assert.equal(read?.status, "drifted");
  assert.match(read!.reason!, /^chart "body" under body "body": /);
  assert.match(read!.reason!, /underLimit/);
  // Its doc cannot draw the Chart, and says so: the body keeps the slot's own subgraph.
  const doc = await second.runMachine(runId);
  assert.equal(doc?.chartsNotDrawn?.length, 1, JSON.stringify(doc?.chartsNotDrawn));
  assert.equal(doc!.chartsNotDrawn![0]!.src, "body");
  assert.match(doc!.chartsNotDrawn![0]!.reason, /underLimit/);
  assert.equal(read?.bound, true);
  assert.deepEqual(read?.chartHashes?.length, 1, "the status names the hash of the Chart it binds");
});

test("restore: a Chart text edited on the volume is drift (its hash no longer matches)", async () => {
  const store = await mkStore();
  const { ports, def } = rig();
  const { runId } = await parkedAtReview(store, def(), ports);
  const row = await store.load(runId);
  const blob = row!.snapshot as { snapshot: { children: Record<string, { snapshot: { chart: ChartText } }> } };
  blob.snapshot.children.body!.snapshot.chart = {
    ...blob.snapshot.children.body!.snapshot.chart,
    output: { tampered: true },
  };
  await store.save(runId, blob, "live");

  const second = newHost({ store });
  second.register(def());
  assert.deepEqual((await second.restore()).drifted, [runId]);
  assert.match(
    (await second.read(runId))!.reason!,
    /chart "body" under body "body": its hash .* does not match its text/,
  );
});

// --- The run's Machine, and the scope its Agents resolve in --------------------------------------

test("runMachine: the run's doc draws the Chart's states under the body, live and stored", async () => {
  const { ports, def } = rig();
  const store = await mkStore();
  const host = newHost({ store });
  host.register(def());
  const runId = await started(host);
  await waitFor(() => ports.coder.admits.length === 1);

  const stateKeys = (doc: Awaited<ReturnType<RunHost["runMachine"]>>) => {
    const run = doc!.root.states.find((s) => s.key === "run")!;
    const body = run.children.find((c) => c.src === "body")!;
    return { body, keys: body.machine!.root.states.map((s) => s.key) };
  };
  const liveDoc = await host.runMachine(runId);
  assert.equal(liveDoc?.chartsNotDrawn, undefined, "every bound Chart is drawn");
  const live = stateKeys(liveDoc);
  assert.deepEqual(live.keys, ["draft", "review", "shipped"]);
  assert.match(String(host.status(runId)?.chartHashes), /^[0-9a-f]{12}$/, "the status names the bound Chart's hash");
  assert.deepEqual(observe(host.status(runId)!).chartHashes, host.status(runId)?.chartHashes);
  assert.equal(live.body.label, "body");
  assert.deepEqual(
    live.body.machine!.events.map((e) => e.name),
    ["submit", "approve", "revise"],
    "the Chart's own events",
  );
  assert.equal(host.machine("charted")!.root.states[0]!.children.length, 0, "the wrapper's doc has no Chart");

  await savedAt(store, runId, (blob) => JSON.stringify(blob.snapshot).includes('"chartHash"'));
  await host.stop(runId);
  const second = newHost({ store, reconcile: () => false });
  second.register(def());
  assert.deepEqual(
    stateKeys(await second.runMachine(runId)).keys,
    ["draft", "review", "shipped"],
    "recompiled from the blob",
  );
  assert.equal(await second.runMachine("nope"), undefined);
});

test("invokingMachine consults boundMachineOf: an Agent a Chart's state invokes resolves the compiled Machine", async () => {
  const { ports, def } = rig();
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const runId = await started(host);
  await waitFor(() => ports.coder.admits.length === 1);
  const body = bodyOf(actorOf(host, runId));
  const bound = boundMachineOf(body)!;
  assert.ok(bound, "the body's actor has a bound Machine");
  const coder = Object.values((body.getSnapshot() as { children: Record<string, AnyActorRef> }).children)[0]!;
  assert.equal(invokingMachine(coder), bound);
  assert.deepEqual([...vocabularyOf(bound)!.keys()].sort(), ["approve", "revise", "submit"]);
  assert.equal(boundMachineOf(actorOf(host, runId)), undefined, "no other actor has one");
});

test("D-C: `{ chart: { name } }` resolves among the Charts of the run's own wrapper", async () => {
  const ports: Ports = { coder: new MockFlueClient(), minted: new MockFlueClient(), exec: new FakeHarnessExec() };
  const host = newHost({ store: await mkStore() });
  const byName = innerChartMachine(ports, { name: "loop" });
  const provide = () => ({ actors: { coder: agentActorWith(() => ports.coder, coderDefinition) } });
  host.register({ name: "inner", machine: byName, provide });
  const missing = await host.start("inner");
  await waitFor(() => host.status(missing.runId) === undefined);
  const result = ((await host.read(missing.runId))?.context as { result: { report: string[] } }).result;
  assert.match(result.report[0]!, /no Chart named "loop"/);

  host.registerChart({
    name: "inner/loop",
    machine: byName,
    provide,
    chart: { wrapper: "inner", name: "loop", text: SIMPLE, hash: "x", origin: "runtime" },
  });
  const { runId } = await host.start("inner");
  await waitFor(() => host.status(runId)?.bound === true);
  assert.deepEqual(host.status(runId)!.children[0]!.value, "draft");
});

test("customize: a wrapper's retuned lent Agent is the one its Open body lends, and the import keeps its own", async () => {
  const { machine } = rig();
  const retuned = customize(
    machine as never,
    { agents: { coder: { model: "other/model" } } } as never,
  ) as AnyStateMachine;
  const lent = lentOf(bodyLogic(retuned))!;
  assert.equal(lent.actors.coder, (retuned.implementations.actors as Record<string, unknown>).coder);
  assert.equal((lent.actors.coder as unknown as { definition: AgentDefinition }).definition.model, "other/model");
  assert.equal(
    (lentOf(bodyLogic(machine))!.actors.coder as unknown as { definition: AgentDefinition }).definition.model,
    "stub/model",
    "the import's stamp is untouched",
  );
  // The Chart still resolves the lent coder, and the compiled Machine borrows the retuned one.
  const decl = openBodyDecl(retuned);
  const admitted = admitChart(LOOP, decl, lent);
  const compiled = compileChart(admitted, lent, decl, {
    mintAgent: (_s, d) => agentActorWith(() => new MockFlueClient(), d),
  });
  assert.equal((compiled.implementations.actors as Record<string, unknown>).coder, lent.actors.coder);
});

test("the lent Effect: a Chart's invoke fills its input slots, and its output routes the Chart", async () => {
  const { ports, def } = rig();
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const testing: ChartText = {
    initial: "check",
    states: {
      check: { invoke: { src: "tests", input: { filter: "{{input.task}}" }, onDone: { target: "ok" } } },
      ok: { type: "final", output: { ran: "{{context.ran}}" } },
    },
    context: { ran: "yes" },
  };
  const runId = await started(host, testing);
  await waitFor(() => ports.exec.starts.length === 1);
  assert.deepEqual(ports.exec.starts[0]!.req.argv, ["pnpm", "test", "add a flag"], "the slot is the input's task");
  ports.exec.settle({ outcome: "exited", code: 0, tail: "ok" });
  const result = await ceilingOf(host, runId);
  assert.deepEqual(result, { outcome: "done", output: { ran: "yes" } });
});

test("the lent Effect: an input that resolves to no string is THAT invoke's error, which the Chart's onError takes", async () => {
  const { ports, def } = rig();
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const listed: ChartText = {
    context: { items: ["a", "b"] },
    initial: "check",
    states: {
      check: {
        invoke: { src: "tests", input: { filter: "{{context.items}}" }, onDone: "ran", onError: "refused" },
      },
      ran: { type: "final", output: { ran: true } },
      refused: { type: "final", output: { error: "{{context.items.0}}" } },
    },
  };
  const runId = await started(host, listed);
  const result = await ceilingOf(host, runId);
  assert.deepEqual(result, { outcome: "done", output: { error: "a" } }, "onError, and the Chart ran on");
  assert.equal(ports.exec.starts.length, 0, "the Effect never ran");
});

test("`jr2.failure` is false for a defect: a plain error takes the next branch, or with none it ends the run `error`", async () => {
  // The Effect's input resolves to no string: the invoke's error is a plain Error, no Failure.
  const defect = (branches: unknown): ChartText => ({
    context: { items: ["a", "b"] },
    initial: "check",
    states: {
      check: { invoke: { src: "tests", input: { filter: "{{context.items}}" }, onError: branches as never } },
      caught: { type: "final", output: { caught: true } },
      defect: { type: "final", output: { defect: true } },
    },
  });
  const { def } = rig();
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const branched = await started(host, defect([{ guard: "jr2.failure", target: "caught" }, { target: "defect" }]));
  assert.deepEqual(await ceilingOf(host, branched), { outcome: "done", output: { defect: true } });

  const only = await started(host, defect({ guard: "jr2.failure", target: "caught" }));
  await waitFor(() => host.status(only) === undefined);
  const final = (await host.read(only))!;
  assert.equal(final.status, "error", "a defect no route takes is a fault, not a Failure");
  assert.equal(final.output, undefined);
});

test("D-C: a Chart wrapper invoked by another Machine resolves no name", async () => {
  const ports: Ports = { coder: new MockFlueClient(), minted: new MockFlueClient(), exec: new FakeHarnessExec() };
  const inner = innerChartMachine(ports, { name: "loop" });
  const outer = jr2Setup({
    types: {} as { context: { result?: unknown } },
    events: [],
    actors: { inner },
  }).createMachine({
    id: "outer",
    context: {},
    initial: "run",
    states: {
      run: {
        invoke: { src: "inner", onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) } },
      },
      done: { type: "final" },
    },
  }) as unknown as AnyStateMachine;
  const host = newHost({ store: await mkStore() });
  host.register({ name: "outer", machine: outer, provide: () => ({}) });
  host.registerChart({
    name: "outer/loop",
    machine: outer,
    provide: () => ({}),
    chart: { wrapper: "outer", name: "loop", text: SIMPLE, hash: "x", origin: "runtime" },
  });
  const { runId } = await host.start("outer");
  await waitFor(() => host.status(runId) === undefined);
  const result = ((await host.read(runId))?.context as { result: { outcome: string; report: string[] } }).result;
  assert.equal(result.outcome, "refused", "the name is refused although the run's Workflow holds it");
  assert.match(
    result.report[0]!,
    /^chart\.name: "loop" — a Chart is named only under the Chart wrapper that is the run's own Workflow/,
  );
});

/** A Chart that invokes no Agent, compiled and run hostless, to its output. */
async function runToOutput(text: ChartText, lent: Parameters<typeof compileChart>[1], events: object[] = []) {
  const decl = {
    lends: { machines: Object.keys(lent.actors) },
    allows: { models: ["stub/model"], workspace: ["none" as const] },
    ceilings: CEILINGS,
  };
  const machine = compileChart(admitChart(text, decl, lent), lent, decl);
  const actor = createActor(machine, { input: {} }).start();
  for (const e of events) actor.send(e as never);
  await waitFor(() => actor.getSnapshot().status !== "active");
  return actor.getSnapshot().output as { outcome: string; output: unknown };
}

test("a `set` from one optional field writes it when it is there, and keeps the path when it is not", async () => {
  const text: ChartText = {
    context: { why: "none given" },
    events: { go: { input: { type: "object", properties: { why: { type: "string" } } } } },
    initial: "a",
    states: {
      a: { on: { go: { target: "b", actions: [{ type: "set", path: "why", from: "{{event.why}}" }] } } },
      b: { type: "final", output: "{{context.why}}" },
    },
  };
  const none = { actors: {}, guards: {}, actions: {}, delays: {} };
  assert.deepEqual(await runToOutput(text, none, [{ type: "go" }]), { outcome: "done", output: "none given" });
  assert.deepEqual(await runToOutput(text, none, [{ type: "go", why: "flaky" }]), { outcome: "done", output: "flaky" });
});

test("an invoke's error reaches a Chart as a line jr2 writes, never the error's message (ADR-0067)", async () => {
  const text: ChartText = {
    initial: "a",
    states: {
      a: {
        invoke: {
          src: "sub",
          onError: { target: "b", actions: [{ type: "set", path: "e", from: "{{event.error}}" }] },
        },
      },
      b: { type: "final", output: "{{context.e}}" },
    },
  };
  const lent = {
    actors: { sub: fromPromise(async () => Promise.reject(new Error("the host said no"))) as never },
    guards: {},
    actions: {},
    delays: {},
  };
  const out = await runToOutput(text, lent);
  assert.equal(out.outcome, "done");
  assert.equal(typeof out.output, "string");
  assert.doesNotMatch(out.output as string, /the host said no/, "the error's message never reaches a Chart's data");
  assert.match(out.output as string, /^the invoke ".+" failed/);
});

test("a whole-placeholder prompt that resolves to an object reaches the Turn as text", async () => {
  const mock = new MockFlueClient();
  const lent = {
    actors: { coder: agentActorWith(() => mock, coderDefinition) as never },
    guards: {},
    actions: {},
    delays: {},
  };
  const decl = {
    lends: { agents: ["coder"] },
    allows: { models: ["stub/model"], workspace: ["none" as const] },
    ceilings: CEILINGS,
  };
  const text: ChartText = {
    context: { ticket: { title: "Fix it" } },
    events: { submit: { input: { ...EMPTY } } },
    initial: "a",
    states: {
      a: {
        invoke: { src: "coder", input: { prompt: "{{context.ticket}}" } },
        on: { submit: "b" },
      },
      b: { type: "final" },
    },
  };
  const machine = compileChart(admitChart(text, decl, lent), lent, decl);
  let bound = false;
  const actor = createActor(machine, {
    input: { endpoint: ENDPOINT },
    inspect: (e) => {
      if (!bound && e.type === "@xstate.actor") {
        bound = true;
        bindRun((e.actorRef as AnyActorRef).system, { runId: "r", workflow: "wf", table: new RegistrationTable() });
      }
    },
  }).start();
  await waitFor(() => mock.admits.length === 1);
  assert.equal(mock.admits[0]!.prompt, '{"title":"Fix it"}');
  actor.stop();
});

// --- What the verifier's lens "body" found ------------------------------------------------------

/** One Turn of the lent coder, and done. */
const ONE_TURN: ChartText = {
  events: { submit: { input: { ...EMPTY } } },
  initial: "draft",
  states: {
    draft: { invoke: { src: "coder", input: { prompt: "one" } }, on: { submit: "x" } },
    x: { type: "final" },
  },
};

/**
 * A Chart wrapper whose body lends the `coder` Agent, a guard `keepGoing` (always true), and the
 * child Machines `machines` names; its door is `{ endpoint, chart }`, sent on to the body.
 */
function lendingMachine(
  ports: { coder: MockFlueClient },
  opts: { machines?: Record<string, AnyStateMachine>; ceilings?: Partial<Ceilings>; id?: string } = {},
): AnyStateMachine {
  const machines = opts.machines ?? {};
  return jr2Setup({
    types: {} as { context: { chart: unknown; endpoint: string; result?: unknown } },
    events: [],
    actors: {
      coder: agentActorWith(() => ports.coder, coderDefinition),
      ...machines,
      body: openBodyWith(
        {
          lends: { agents: ["coder"], machines: Object.keys(machines), guards: ["keepGoing"], gate: true },
          allows: { models: ["stub/model"], workspace: ["none", "write"] },
          ceilings: { ...CEILINGS, ...opts.ceilings },
        },
        { mintAgent: (_slot, def) => agentActorWith(() => ports.coder, def) },
      ),
    } as never,
    guards: { keepGoing: () => true } as never,
  }).createMachine({
    on: { "agent.fault": {} },
    id: opts.id ?? "lending",
    input: z.object({ endpoint: z.string(), chart: chartSchema }),
    context: ({ input }: { input: { chart: unknown; endpoint: string } }) => ({ ...input }),
    initial: "run",
    states: {
      run: {
        invoke: {
          src: "body",
          input: ({ context }: { context: { chart: unknown; endpoint: string } }) => ({
            chart: context.chart,
            endpoint: context.endpoint,
          }),
          onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) },
        },
      },
      done: { type: "final" },
    },
  } as never) as unknown as AnyStateMachine;
}

test("the transitions ceiling: an aborted macrostep's Agent never starts, so no Turn runs after the ceiling", async () => {
  const coder = new MockFlueClient();
  const host = newHost({ store: await mkStore() });
  host.register({
    name: "lending",
    machine: lendingMachine({ coder }, { ceilings: { transitions: 50, turns: 1000 } }),
    provide: () => ({}),
  });
  // The loop starts on an event, so the aborted macrostep is a transition of a running body.
  const looping: ChartText = {
    events: { go: { input: { ...EMPTY }, audience: "external" } },
    initial: "idle",
    states: {
      idle: { invoke: { src: "gate" }, on: { go: "a" } },
      a: {
        invoke: { src: "coder", input: { prompt: "go" } },
        always: { target: "b", guard: "keepGoing" },
      },
      b: { always: { target: "a", guard: "keepGoing" } },
    },
  };
  const { runId } = await host.start("lending", { endpoint: ENDPOINT, chart: looping });
  await waitFor(() => host.gates(runId).length === 1);
  host.sendToGate(runId, host.gates(runId)[0]!.gate, { type: "go" });
  const result = await ceilingOf(host, runId);
  assert.equal(result.outcome, "ceiling");
  assert.equal(result.ceiling, "transitions");
  await tick();
  await tick();
  assert.equal(coder.admits.length, 0, "no lent Turn started outside the Chart's state");
});

test("the Turns ceiling counts a lent Machine's Agent Turns too (ADR-0070: the counter is the Open body's)", async () => {
  const coder = new MockFlueClient();
  const sub = jr2Setup({
    events: [],
    actors: { worker: agentActorWith(() => coder, coderDefinition) },
    delays: { soon: 5 },
  }).createMachine({
    on: { "agent.fault": {} },
    id: "sub",
    initial: "work",
    states: {
      work: { invoke: { src: "worker", input: { prompt: "w", endpoint: ENDPOINT } }, after: { soon: "over" } },
      over: { type: "final" },
    },
  }) as unknown as AnyStateMachine;
  const host = newHost({ store: await mkStore() });
  host.register({
    name: "lending",
    machine: lendingMachine({ coder }, { machines: { sub }, ceilings: { turns: 2, transitions: 100 } }),
    provide: () => ({}),
  });
  const again: ChartText = {
    initial: "a",
    states: { a: { invoke: { src: "sub", onDone: { target: "a", reenter: true } } } },
  };
  const { runId } = await host.start("lending", { endpoint: ENDPOINT, chart: again });
  const result = await ceilingOf(host, runId);
  assert.equal(result.outcome, "ceiling");
  assert.equal(result.ceiling, "turns");
  await tick();
  assert.equal(coder.admits.length, 2, "the third Turn below the lent Machine is never admitted");
});

test("fan-out counts live children: a child that is done while its state is active is not live", async () => {
  const coder = new MockFlueClient();
  const quick = jr2Setup({ events: [] }).createMachine({
    id: "quick",
    initial: "a",
    states: { a: { type: "final" } },
  }) as unknown as AnyStateMachine;
  const host = newHost({ store: await mkStore() });
  host.register({
    name: "lending",
    machine: lendingMachine({ coder }, { machines: { quick }, ceilings: { fanOut: 4 } }),
    provide: () => ({}),
  });
  const region = (n: number) => ({ initial: "x", states: { x: { invoke: { id: `q${n}`, src: "quick" } } } });
  const wide: ChartText = {
    events: { go: { input: { ...EMPTY }, audience: "external" } },
    initial: "fan",
    states: {
      fan: {
        type: "parallel",
        states: {
          r1: region(1),
          r2: region(2),
          r3: region(3),
          r4: region(4),
          r5: {
            initial: "wait",
            states: {
              wait: { invoke: { src: "gate" }, on: { go: "more" } },
              more: { invoke: { id: "q5", src: "quick" } },
            },
          },
        },
      },
    },
  };
  const { runId } = await host.start("lending", { endpoint: ENDPOINT, chart: wide });
  await waitFor(() => host.gates(runId).length === 1);
  host.sendToGate(runId, host.gates(runId)[0]!.gate, { type: "go" });
  await tick();
  assert.ok(host.status(runId), "the run is still live: one child of five runs, which no ceiling counts as five");
  assert.deepEqual(host.status(runId)!.children.length, 1);
});

test("a Chart's Gate id is below the body's actor path, so it cannot take its wrapper's Gate's name", async () => {
  const coder = new MockFlueClient();
  const host = newHost({ store: await mkStore() });
  host.register({ name: "lending", machine: lendingMachine({ coder }), provide: () => ({}) });
  const gated: ChartText = {
    events: { go: { input: { ...EMPTY }, audience: "external" } },
    initial: "wait",
    states: {
      wait: { invoke: { src: "gate", input: { gate: "approve-push", meta: { why: "push" } } }, on: { go: "over" } },
      over: { type: "final" },
    },
  };
  const { runId } = await host.start("lending", { endpoint: ENDPOINT, chart: gated });
  await waitFor(() => host.gates(runId).length === 1);
  const body = Object.values(
    (actorOf(host, runId).getSnapshot() as { children: Record<string, AnyActorRef> }).children,
  )[0]!;
  assert.equal(host.gates(runId)[0]!.gate, `${body.id}.approve-push`);
});

test("the door compiles the Chart: what jr2Setup refuses is refused before the run exists (ADR-0070)", async () => {
  const coder = new MockFlueClient();
  const host = newHost({ store: await mkStore() });
  host.register({ name: "lending", machine: lendingMachine({ coder }), provide: () => ({}) });
  const parallelBelowAgent: ChartText = {
    events: { done: { input: { ...EMPTY } } },
    initial: "a",
    states: {
      a: {
        type: "parallel",
        invoke: { src: "coder", input: { prompt: "go" } },
        on: { done: "b" },
        states: { x: {}, y: {} },
      },
      b: { type: "final" },
    },
  };
  await assert.rejects(
    () => host.start("lending", { endpoint: ENDPOINT, chart: parallelBelowAgent }),
    (err: unknown) => err instanceof ChartRefusal && err.report.some((l) => l.includes("parallel")),
  );
  assert.deepEqual(host.list(), [], "no run was started");
});

test("the one-shot door leaves `input.*` to the body: a key the wrapper's invoke adds is the Chart's input", async () => {
  const coder = new MockFlueClient();
  const machine = jr2Setup({
    types: {} as { context: { chart: unknown; result?: unknown }; input: { chart: unknown } },
    events: [],
    actors: {
      coder: agentActorWith(() => coder, coderDefinition),
      body: openBodyWith({
        lends: { agents: ["coder"] },
        allows: { models: ["stub/model"], workspace: ["none"] },
        ceilings: CEILINGS,
      }),
    },
  }).createMachine({
    on: { "agent.fault": {} },
    id: "adds",
    input: z.object({ chart: chartSchema }),
    context: ({ input }) => ({ ...input }),
    initial: "run",
    states: {
      run: {
        invoke: {
          src: "body",
          // The wrapper adds `endpoint` from its own config: no door field holds it.
          input: ({ context }: { context: { chart: unknown } }) => ({ chart: context.chart, endpoint: ENDPOINT }),
          onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) },
        },
      },
      done: { type: "final" },
    },
  }) as unknown as AnyStateMachine;
  const host = newHost({ store: await mkStore() });
  host.register({ name: "adds", machine, provide: () => ({}) });
  const { runId } = await host.start("adds", { chart: ONE_TURN });
  await waitFor(() => coder.admits.length === 1);
  assert.equal(host.status(runId)!.children[0]!.value, "draft");
});

test("a reference that resolves to nothing at run time settles the body `refused`, never an error", async () => {
  const coder = new MockFlueClient();
  const host = newHost({ store: await mkStore() });
  host.register({ name: "lending", machine: lendingMachine({ coder }), provide: () => ({}) });
  // `notes` is written in `b`, and read first in `a`: the door's dataflow sees the write.
  const early: ChartText = {
    events: { go: { input: { ...EMPTY }, audience: "external" } },
    initial: "a",
    states: {
      a: { entry: [{ type: "set", path: "copy", from: "notes: {{context.notes}}" }], on: { go: "b" } },
      b: { entry: [{ type: "set", path: "notes", from: "n" }], type: "final", output: { copy: "{{context.copy}}" } },
    },
  };
  const { runId } = await host.start("lending", { endpoint: ENDPOINT, chart: early });
  const result = (await ceilingOf(host, runId)) as unknown as { outcome: string; report: string[] };
  assert.equal(result.outcome, "refused");
  assert.match(result.report[0]!, /^\(run time\): Chart reference "context\.notes" resolves to nothing/);
  assert.equal((await host.read(runId))?.status, "done", "the wrapper routed it; the run did not fault");
});

test("a key the body is sent as undefined is not in the Chart's input: a Chart that reads it is refused", async () => {
  const ports: Ports = { coder: new MockFlueClient(), minted: new MockFlueClient(), exec: new FakeHarnessExec() };
  const chart: ChartText = {
    initial: "a",
    states: { a: { type: "final", output: { task: "{{input.task}}" } } },
  };
  const machine = jr2Setup({
    types: {} as { context: { result?: unknown } },
    events: [],
    actors: {
      body: openBodyWith({ lends: {}, allows: { models: ["stub/model"], workspace: ["none"] }, ceilings: CEILINGS }),
    },
  }).createMachine({
    on: { "agent.fault": {} },
    id: "optional",
    context: {},
    initial: "run",
    states: {
      run: {
        invoke: {
          src: "body",
          input: { chart, task: undefined },
          onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) },
        },
      },
      done: { type: "final" },
    },
  }) as unknown as AnyStateMachine;
  void ports;
  const host = newHost({ store: await mkStore() });
  host.register({ name: "optional", machine, provide: () => ({}) });
  const { runId } = await host.start("optional");
  const result = (await ceilingOf(host, runId)) as unknown as { outcome: string; report: string[] };
  assert.equal(result.outcome, "refused");
  assert.ok(result.report.some((l) => l.includes("input.task")));
});

test("a Chart wrapper that is a transparent wrapper's body is the run's Chart wrapper (ADR-0049, ADR-0070)", async () => {
  const coder = new MockFlueClient();
  const inner = jr2Setup({
    types: {} as { context: { chart?: unknown; name?: string; endpoint: string; result?: unknown } },
    events: [],
    actors: {
      coder: agentActorWith(() => coder, coderDefinition),
      body: openBodyWith({
        lends: { agents: ["coder"] },
        allows: { models: ["stub/model"], workspace: ["none"] },
        ceilings: CEILINGS,
      }),
    },
  }).createMachine({
    on: { "agent.fault": {} },
    id: "inner",
    context: ({ input }: { input: { chart?: unknown; name?: string; endpoint: string } }) => ({ ...input }),
    initial: "run",
    states: {
      run: {
        invoke: {
          src: "body",
          // The Chart's text from the door, or a named Chart of the run's wrapper (D-C).
          input: ({ context }: { context: { chart?: unknown; name?: string; endpoint: string } }) => ({
            chart: context.chart ?? { name: context.name },
            endpoint: context.endpoint,
          }),
          onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) },
        },
      },
      done: { type: "final" },
    },
    output: ({ context }: { context: { result?: unknown } }) => context.result,
  } as never) as unknown as AnyStateMachine;
  // What `workspace()` is to its body, without a Sandbox: a wrapper stamped transparent to `inner`.
  const outer = jr2Setup({
    types: {} as { context: { chart?: unknown; name?: string; endpoint: string } },
    events: [],
    actors: { inner },
  }).createMachine({
    id: "ws",
    input: z.object({ endpoint: z.string(), chart: chartSchema.optional(), name: z.string().optional() }),
    context: ({ input }: { input: { chart?: unknown; name?: string; endpoint: string } }) => ({ ...input }),
    initial: "run",
    states: {
      run: {
        invoke: {
          src: "inner",
          input: ({ context }: { context: { chart?: unknown; name?: string; endpoint: string } }) => ({ ...context }),
          onDone: "done",
        },
      },
      done: { type: "final" },
    },
  } as never) as unknown as AnyStateMachine;
  attachWrapperBody(outer, "inner");

  assert.ok(chartWrapperOf(outer), "charts.ts sees the Chart wrapper through the transparent one");
  const host = newHost({ store: await mkStore() });
  host.register({ name: "ws", machine: outer, provide: () => ({}) });
  assert.deepEqual(host.workflowList(), [
    { name: "ws", origin: "machine", wrapper: { body: "body", oneShot: true, charts: [] } },
  ]);
  const bad = { initial: "a", states: { a: { invoke: { src: "linter", input: { prompt: "x" } } } } };
  await assert.rejects(
    () => host.start("ws", { endpoint: ENDPOINT, chart: bad }),
    (err: unknown) => err instanceof ChartRefusal,
    "the one-shot door refuses before the run exists",
  );
  assert.throws(() => admitWrapperChart(outer, bad), ChartRefusal);

  // D-C: a name resolves for a body whose wrapper is the run's Workflow, seen through `ws`.
  host.registerChart({
    name: "ws/loop",
    machine: outer,
    provide: () => ({}),
    chart: { wrapper: "ws", name: "loop", text: ONE_TURN, hash: "x", origin: "runtime" },
  });
  await host.start("ws", { endpoint: ENDPOINT, name: "loop" });
  await waitFor(() => coder.admits.length === 1);
  assert.equal(coder.admits[0]!.prompt, "one", "the named Chart ran: its name resolved through `ws`");
});

test("the compile memo keys on the lent kinds and keeps a bounded number of Machines", async () => {
  const { machine, def } = rig();
  const decl = openBodyDecl(machine);
  const lent = lentOf(bodyLogic(machine))!;
  const host = newHost({ store: await mkStore() });
  host.register(def());
  for (let i = 0; i < COMPILE_MEMO_SIZE + 5; i++) {
    admitWrapperChart(machine, { ...SIMPLE, id: `c${i}` });
    const { runId } = await host.start("charted", { endpoint: ENDPOINT, task: "t", chart: { ...SIMPLE, id: `c${i}` } });
    await host.stop(runId);
  }
  assert.ok(compiledCount(decl) <= COMPILE_MEMO_SIZE, `at most ${COMPILE_MEMO_SIZE} kept`);
  void lent;
});

test("restore: a lent Agent slot the wrapper no longer lends makes the run drifted, naming it", async () => {
  const store = await mkStore();
  const { ports, def } = rig();
  const { runId } = await parkedAtReview(store, def(), ports);
  const dropped = rig({ lendCoder: false });
  const second = newHost({ store });
  second.register(dropped.def());
  assert.deepEqual((await second.restore()).drifted, [runId]);
  assert.match((await second.read(runId))!.reason!, /^chart "body" under body "body": .*coder/);
});

test("customize: a Chart run under a retuned wrapper borrows the retuned Agent, read off the live parent", async () => {
  const { machine, ports } = rig();
  const retuned = customize(
    machine as never,
    { agents: { coder: { model: "other/model" } } } as never,
  ) as AnyStateMachine;
  const definition = (retuned.implementations.actors as unknown as Record<string, { definition: AgentDefinition }>)
    .coder!.definition;
  const host = newHost({ store: await mkStore() });
  // The run's coder speaks to the test port with the retuned slot's own definition.
  host.register({
    name: "charted",
    machine: retuned,
    provide: () => ({ actors: { coder: agentActorWith(() => ports.coder, definition) } }),
  });
  await started(host, SIMPLE);
  await waitFor(() => ports.coder.admits.length === 1);
  assert.equal(ports.coder.definitions[0]!.model, "other/model");
});

test("restore: a parked Chart's wall clock is armed again in a new host, and still ends it", async () => {
  const store = await mkStore();
  const { def } = rig({ ceilings: { wallClock: "1s" } });
  const host = newHost({ store });
  host.register(def());
  const parked: ChartText = { initial: "wait", states: { wait: {} } };
  const runId = await started(host, parked);
  await savedAt(store, runId, (blob) => JSON.stringify(blob).includes(WALL_CLOCK_EVENT));
  await host.stop(runId);
  const second = newHost({ store });
  second.register(def());
  assert.deepEqual((await second.restore()).reattached, [runId]);
  for (let i = 0; i < 60 && second.status(runId) !== undefined; i++) await new Promise((r) => setTimeout(r, 50));
  const result = await ceilingOf(second, runId);
  assert.equal(result.outcome, "ceiling");
  assert.equal(result.ceiling, "wallClock");
});

test("close(): a live Chart's wall-clock timer stays armed but no longer holds the process", async () => {
  const { def } = rig();
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const runId = await started(host, { initial: "wait", states: { wait: {} } });
  const timers = (host as unknown as { timers: Set<NodeJS.Timeout> }).timers;
  assert.ok(timers.size >= 1, "the wall clock is armed on the host's clock");
  assert.ok([...timers].every((t) => t.hasRef()));
  await host.close();
  assert.ok(
    [...timers].every((t) => !t.hasRef()),
    "every timer is unref'd",
  );
  assert.ok(host.status(runId), "the run is untouched");
});
