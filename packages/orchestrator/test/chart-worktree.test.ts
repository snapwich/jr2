// A planner's Chart that makes a Worktree and works in it, through the real door and a real RunHost,
// the kit `jr2.ready` guard and the real cut Effect on a fake Harness. What the door refuses, also.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { assign, type AnyStateMachine } from "xstate";
import { defineEvent } from "@jr2/agent-protocol";
import { z } from "zod";
import { agentActorWith } from "../src/actor.ts";
import type { AgentDefinition } from "../src/agent.ts";
import { CHART_BRIEFING, chartSchema, ChartRefusal, type ChartText } from "../src/chart.ts";
import { admitUnder, chartWrapperOf } from "../src/charts.ts";
import { commandWith } from "../src/effect.ts";
import { isFailure } from "../src/fail.ts";
import { agent, command } from "../src/harness-client.ts";
import { openBodyWith, type Ceilings } from "../src/open-body.ts";
import { fromPick } from "../src/pick.ts";
import { RunHost, type WorkflowDef } from "../src/run-host.ts";
import { push } from "../src/sandbox-effect.ts";
import { jr2Setup } from "../src/setup.ts";
import { worktreeWith } from "../src/worktree.ts";
import { fakeWorkspace, FakeHarnessExec, handles } from "./_effects.ts";
import { mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";
import { workspace, type SandboxPort } from "../src/workspace.ts";

const coderDefinition: AgentDefinition = { model: "stub/model", instructions: "you are the test coder" };
const plannerDefinition: AgentDefinition = { model: "stub/model", instructions: "you are the test planner" };
const CEILINGS: Ceilings = { turns: 20, wallClock: "2h", transitions: 5000, fanOut: 4, size: 65536 };

const hosts: RunHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) for (const run of host.list()) await host.stop(run.runId);
});

const readyAnswer = {
  outcome: "ready",
  slot: "app",
  path: "/work/app/run",
  branch: "fix-login",
  head: "a".repeat(40),
  found: "none",
};

function rig(
  cutOptions: { expect?: "new" | "existing" } = { expect: "new" },
  { force = true, alsoNew = false }: { force?: boolean; alsoNew?: boolean } = {},
) {
  const coderPort = new MockFlueClient();
  const harness = new FakeHarnessExec();
  const machine = jr2Setup({
    types: {} as {
      context: { chart: unknown; endpoint: string; result?: unknown };
      input: { chart: unknown; endpoint: string };
    },
    events: [],
    actors: {
      coder: agent(coderDefinition),
      ws: fakeWorkspace({ ...handles({ app: "/work/app" }), bases: { app: "main" } }),
      cut: worktreeWith(harness.factory, cutOptions),
      fresh: worktreeWith(harness.factory, { expect: "new" }),
      publish: push({ force }),
      tests: commandWith(harness.factory, ["npm", "test"]),
      plain: command(["npm", "test"]),
      body: openBodyWith({
        lends: { agents: ["coder"], effects: ["cut", ...(alsoNew ? ["fresh"] : []), "publish", "tests"], fail: true },
        allows: { models: ["stub/model"], workspace: ["write"] },
        ceilings: CEILINGS,
      }),
    },
  }).createMachine({
    id: "charted",
    input: z.object({ endpoint: z.string(), chart: chartSchema }),
    context: ({ input }) => ({ ...input }),
    on: { "agent.fault": { target: ".done" } },
    invoke: { src: "ws" },
    initial: "run",
    states: {
      run: {
        invoke: {
          id: "body",
          src: "body",
          input: ({ context }: { context: { chart: unknown; endpoint: string } }) => ({
            chart: context.chart,
            endpoint: context.endpoint,
          }),
          onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) },
          onError: {
            guard: ({ event }: { event: { error: unknown } }) => isFailure(event.error),
            target: "done",
            actions: assign({ result: ({ event }) => (isFailure(event.error) ? event.error.reason : undefined) }),
          },
        },
      },
      done: { type: "final" },
    },
  }) as unknown as AnyStateMachine;
  const def = (): WorkflowDef => ({
    name: "charted",
    machine,
    provide: () => ({ actors: { coder: agentActorWith(() => coderPort, coderDefinition) } }),
  });
  return { coderPort, harness, def };
}

const EMPTY = { type: "object", properties: {}, additionalProperties: false } as const;
const onDone = [{ guard: "jr2.ready", target: "working" }, { target: "blocked" }];

/** The planner's Chart: a literal Worktree, no flat input key. Cut, route on `jr2.ready`, work, push. */
const PLAN: ChartText = {
  events: { committed: { input: { ...EMPTY } } },
  initial: "cutting",
  states: {
    cutting: {
      invoke: { src: "cut", input: { path: "/work/app/run", branch: "fix-login" }, onDone },
    },
    working: {
      invoke: { src: "coder", input: { prompt: "Fix the login.", cwd: "/work/app/run" } },
      on: { committed: "done" },
    },
    done: { type: "final", output: { ok: "yes" } },
    blocked: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
  },
} as unknown as ChartText;

test("the Chart cuts a literal path, the Turn is framed in it, and the Chart ends", async () => {
  const { coderPort, harness, def } = rig();
  const host = new RunHost({ store: await mkStore() });
  hosts.push(host);
  host.register(def());
  const { runId } = await host.start("charted", { endpoint: "http://h.invalid", chart: PLAN });
  await waitFor(() => harness.starts.length === 1);
  const req = JSON.parse(harness.starts[0]!.req.argv.at(-1)!) as Record<string, unknown>;
  assert.equal(req.expect, "new", "the Machine's `expect`: no Chart states it");
  assert.equal(req.branch, "fix-login");
  assert.equal(req.base, "main");
  harness.settle({ outcome: "exited", code: 0, tail: JSON.stringify(readyAnswer) });
  await waitFor(() => coderPort.admits.length === 1);
  assert.equal(coderPort.admits[0]!.cwd, "/work/app/run");
  host.sendToAgent(coderPort.admits[0]!.instanceId, { type: "committed" });
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.deepEqual((final?.context as { result: unknown }).result, { outcome: "done", output: { ok: "yes" } });
});

test("`refused` routes on `jr2.ready`: no Turn starts, and the Chart's fail ends it", async () => {
  const { coderPort, harness, def } = rig();
  const host = new RunHost({ store: await mkStore() });
  hosts.push(host);
  host.register(def());
  const { runId } = await host.start("charted", { endpoint: "http://h.invalid", chart: PLAN });
  await waitFor(() => harness.starts.length === 1);
  harness.settle({
    outcome: "exited",
    code: 0,
    tail: JSON.stringify({ outcome: "refused", reason: "fix-login exists, and this cut makes only a new branch" }),
  });
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(coderPort.admits.length, 0);
  assert.equal((final?.context as { result: unknown }).result, "the Worktree was not cut");
});

async function door(chart: unknown, def = rig().def()): Promise<string> {
  const host = new RunHost({ store: await mkStore() });
  hosts.push(host);
  host.register(def);
  try {
    await host.start("charted", { endpoint: "http://h.invalid", chart: chart as ChartText });
    return "admitted";
  } catch (err) {
    assert.ok(err instanceof ChartRefusal, String(err));
    return err.message;
  }
}

const withCut = (invoke: unknown): ChartText =>
  ({ ...PLAN, states: { ...PLAN.states, cutting: { invoke } } }) as unknown as ChartText;
const one = (invoke: unknown) => ({
  initial: "s",
  states: { s: { invoke: { ...(invoke as object), onDone: "done" } }, done: { type: "final" } },
});

test("the door on a cut: inputShapeOf, and exact words", async () => {
  assert.equal(
    await door(withCut({ src: "cut", input: { path: "/work/app/x", branch: "a/b", from: "v3" }, onDone })),
    "admitted",
  );
  assert.equal(await door(withCut({ src: "cut", input: { path: "/work/app/x", detach: "abc" }, onDone })), "admitted");
  assert.match(
    await door(withCut({ src: "cut", input: { path: "/work/app/x", branch: "a", detach: "abc" }, onDone })),
    /takes path, exactly one of branch, detach, and optionally from; give one of branch, detach/,
  );
  assert.match(
    await door(withCut({ src: "cut", input: { path: "/work/app/x" }, onDone })),
    /give one of branch, detach/,
  );
  assert.match(await door(withCut({ src: "cut", input: { branch: "a" }, onDone })), /missing: path/);
  assert.match(
    await door(withCut({ src: "cut", input: { path: "/work/app/x", branch: "a", expect: "existing" }, onDone })),
    /not its input: expect/,
  );
  assert.match(
    await door(withCut({ src: "cut", input: { path: "/work/app/x", detach: "a", from: "b" }, onDone })),
    /takes no `from`/,
  );
  assert.match(
    await door(withCut({ src: "cut", input: { path: "/work/app/a/b", branch: "a" }, onDone })),
    /not a Worktree path/,
  );
  assert.match(
    await door(withCut({ src: "cut", input: { path: "/work/app/.x", branch: "a" }, onDone })),
    /not a Worktree path/,
  );
});

test("the door refuses to lend a cut that does not state `expect`", async () => {
  const message = await door(PLAN, rig({}).def());
  assert.match(message, /does not state `expect`, so a Chart cannot use it/);
  assert.match(message, /lent: coder \(Agent\)/, "the planner reads what it can use instead");
  const unstated = await door(PLAN, rig({}, { alsoNew: true }).def());
  assert.match(
    unstated,
    /does not state `expect`, so a Chart cannot use it; use a lent cut with `expect: "new"`: fresh/,
  );
});

test("the door refuses an `existing` cut beside a lent force push, and says what to use", async () => {
  const existing = { expect: "existing" } as const;
  const alone = await door(PLAN, rig(existing).def());
  assert.match(alone, /states `expect: "existing"` beside the lent force push "publish"/);
  assert.match(alone, /lends no cut with `expect: "new"`, so a Chart cannot cut here/);
  assert.match(alone, /lent: coder \(Agent\)/, "the planner reads what it can use instead");
  const noPush: unknown = {
    initial: "cutting",
    states: {
      cutting: { invoke: { src: "cut", input: { path: "/work/app/run", branch: "b" }, onDone: "done" } },
      done: { type: "final" },
    },
  };
  assert.match(await door(noPush, rig(existing).def()), /beside the lent force push/, "a later Chart can push the row");
  assert.match(await door(PLAN, rig(existing, { alsoNew: true }).def()), /use a lent cut with `expect: "new"`: fresh/);
});

test("the door admits the twins: an `existing` cut beside a push with no force, a `new` cut beside a force push", async () => {
  assert.equal(await door(PLAN, rig({ expect: "existing" }, { force: false }).def()), "admitted");
  assert.equal(await door(PLAN, rig({ expect: "new" }).def()), "admitted");
  const onlyFresh = withCut({ src: "fresh", input: { path: "/work/app/run", branch: "fix-login" }, onDone });
  assert.equal(await door(onlyFresh, rig({ expect: "new" }, { alsoNew: true }).def()), "admitted");
});

test("the door: a Chart cannot fill a remote branch, nor a push's other keys", async () => {
  assert.match(
    await door(one({ src: "publish", input: { worktree: "/work/app/x", to: "main" } })),
    /not its input: to/,
    "a lent force push, to: main",
  );
  assert.match(
    await door(one({ src: "publish", input: { worktree: "/work/app/x", branch: "main" } })),
    /not its input: branch/,
  );
  assert.equal(await door(one({ src: "publish", input: { worktree: "/work/docs/x" } })), "admitted", "no row at start");
});

test("the door: a no-arg lent command: no regression, and the input it takes", async () => {
  assert.equal(await door(one({ src: "tests" })), "admitted", "no input, as a Chart writes it today");
  assert.equal(await door(one({ src: "tests", input: {} })), "admitted");
  assert.equal(await door(one({ src: "tests", input: { worktree: "/work/app/default" } })), "admitted");
  assert.match(await door(one({ src: "tests", input: { cwd: "/work/app/x" } })), /not its input: cwd/);
});

test("the door: a pick with a param into a lent Effect: admitted, no probe refusal", async () => {
  const WITH = {
    type: "object",
    properties: { note: { type: "string" } },
    required: ["note"],
    additionalProperties: false,
  } as const;
  // The param is stored, so that ADR-0067's "a pick param reaches something" rule holds: the question
  // here is only the probe of a Worktree input that reads a reference.
  const keep = { target: "pushing", actions: [{ type: "set", path: "note", from: "{{event.note}}" }] };
  const chart = (input: unknown, pickInput: unknown, cwd = "/work/app/x", extra: object = {}) => ({
    ...extra,
    events: { committed: { input: pickInput } },
    initial: "w",
    states: {
      w: {
        invoke: { src: "coder", input: { prompt: "p", cwd } },
        on: { committed: pickInput === WITH || (pickInput as { required?: unknown }).required ? keep : "pushing" },
      },
      pushing: { invoke: { src: "publish", input, onDone: "done" } },
      done: { type: "final" },
    },
  });
  assert.equal(await door(chart({ worktree: "/work/app/x" }, { ...EMPTY })), "admitted");
  assert.equal(await door(chart({ worktree: "/work/app/x" }, { ...WITH })), "admitted", "a literal path");
  assert.equal(
    await door(
      chart({ worktree: "{{context.tree}}" }, { ...WITH }, "{{context.tree}}", { context: { tree: "/work/app/x" } }),
    ),
    "admitted",
    "the path in context",
  );
  assert.equal(
    await door({ ...chart({ worktree: "{{input.app}}/x" }, { ...WITH }, "{{input.app}}/x") }),
    "admitted",
    "a reference to a flat input key",
  );
});

test("a Chart cannot read a cut's fields, so it cannot pin a detached cut to a commit that a cut read", async () => {
  const two = (first: unknown, second: unknown) => ({
    context: { c: "" },
    initial: "s",
    states: { s: { invoke: first }, r: { invoke: second }, done: { type: "final" } },
  });
  const message = await door(
    two(
      {
        src: "cut",
        input: { path: "/work/app/x", branch: "b" },
        onDone: { target: "r", actions: [{ type: "set", path: "c", from: "{{event.output.head}}" }] },
      },
      { src: "cut", input: { path: "/work/app/review", detach: "{{context.c}}" }, onDone: "done" },
    ),
  );
  assert.match(message, /supplies event.output, whole/);
});

test("the Chart briefing teaches a cut, the guard and the two keys", () => {
  assert.match(CHART_BRIEFING, /jr2\.ready/);
  assert.match(CHART_BRIEFING, /\/work\/<slot>\/<name>/);
  assert.match(CHART_BRIEFING, /`cwd`/);
  assert.match(CHART_BRIEFING, /`worktree`/);
  assert.match(CHART_BRIEFING, /its input has no `expect`/);
  assert.match(CHART_BRIEFING, /`\/work\/<slot>` is not a Worktree/);
});

test("a door that sees the Workspace's Repo Slots: the keys are required, and a literal slot is checked", async () => {
  const coderPort = new MockFlueClient();
  const harness = new FakeHarnessExec();
  const bodyMachine = jr2Setup({
    types: {} as { context: { chart: unknown; endpoint: string }; input: { chart: unknown; endpoint: string } },
    events: [],
    actors: {
      coder: agent(coderDefinition),
      tests: commandWith(harness.factory, ["npm", "test"]),
      body: openBodyWith({
        lends: { agents: ["coder"], effects: ["tests"], fail: true },
        allows: { models: ["stub/model"], workspace: ["write", "none"] },
        ceilings: CEILINGS,
      }),
    },
  }).createMachine({
    id: "charted",
    context: ({ input }) => ({ ...input }),
    on: { "agent.fault": ".done", "workspace.lost": ".done" },
    initial: "run",
    states: {
      run: {
        invoke: {
          id: "body",
          src: "body",
          input: ({ context }: { context: { chart: unknown; endpoint: string } }) => ({
            chart: context.chart,
            endpoint: context.endpoint,
          }),
          onDone: "done",
        },
      },
      done: { type: "final" },
    },
  }) as unknown as AnyStateMachine;
  const machine = workspace(
    bodyMachine as never,
    {
      input: z.object({ endpoint: z.string(), chart: chartSchema }),
      repos: { app: "https://example.test/app.git" },
    } as never,
  ) as unknown as AnyStateMachine;
  const def: WorkflowDef = {
    name: "charted",
    machine,
    provide: () => ({ actors: { coder: agentActorWith(() => coderPort, coderDefinition) } }),
  };
  assert.match(await door(one({ src: "tests" }), def), /missing: worktree|takes .*worktree/);
  assert.match(
    await door(one({ src: "tests", input: { worktree: "/work/ap/x" } }), def),
    /no Repo Slot of this Workspace/,
  );
  assert.match(
    await door({ initial: "s", states: { s: { invoke: { src: "coder", input: { prompt: "p" } } } } }, def),
    /a Turn there says where/,
  );
  const turn = (cwd: string, workspace?: string) => ({
    ...(workspace ? { agents: { own: { model: "stub/model", instructions: "i", workspace } } } : {}),
    events: { committed: { input: { ...EMPTY } } },
    initial: "s",
    states: {
      s: { invoke: { src: workspace ? "own" : "coder", input: { prompt: "p", cwd } }, on: { committed: "done" } },
      done: { type: "final" },
    },
  });
  for (const cwd of ["/work/app", "/work/app/", "/work//app", "/work/app/.", "/work/app/x/.."]) {
    assert.match(await door(turn(cwd), def), /is a Repo Slot's folder, not a Worktree/, cwd);
  }
  assert.match(
    await door(turn("/work/app"), def),
    /"\/work\/app\/<name>", or "\/work\/app\/default" to read, or "\/work"/,
  );
  for (const cwd of ["/work/app/x", "/work/app/default", "/work", "{{context.tree}}"]) {
    assert.doesNotMatch(await door(turn(cwd), def), /Repo Slot's folder/, cwd);
  }
  assert.equal(await door(turn("/work/app", "none"), def), "admitted", "this minted Agent reads no /work");
  assert.match(await door(turn("/work/app", "write"), def), /is a Repo Slot's folder/, "a minted Agent that reads it");
  const wrapper = chartWrapperOf(machine)!;
  assert.throws(() => admitUnder(wrapper, turn("/work/app")), /Repo Slot's folder/, "a named Chart's door");
  assert.ok(admitUnder(wrapper, turn("/work/app/x")), "a named Chart's twin");
});

const runChart = defineEvent({
  name: "run_chart",
  description: "Run this Chart.",
  input: z.object({ chart: chartSchema }),
});

/** A Sandbox port that places at once and attaches each Repo Slot. */
class OneSlotSandbox implements SandboxPort {
  leaseIntervalMs = 60_000;
  async place() {}
  async provision(name: string) {
    return { endpoint: `http://${name}.test` };
  }
  async attach(req: { repos: Array<{ slot: string }> }) {
    return { repos: Object.fromEntries(req.repos.map((r) => [r.slot, `/work/${r.slot}`])) };
  }
  async renew() {}
  async releaseHold() {}
  continuity(_name: string, listener: (seen: { present: true }) => void) {
    queueMicrotask(() => listener({ present: true }));
    return () => {};
  }
  harnessRestarts() {
    return () => {};
  }
  async memoryFault() {
    return undefined;
  }
  async destroy() {}
}

/** A Turn in `cwd` that the coder ends with `committed`. */
const turnIn = (cwd: string, extra: object = {}, invoke: object = {}) => ({
  ...extra,
  events: { committed: { input: { ...EMPTY } } },
  initial: "s",
  states: {
    s: { invoke: { src: "coder", input: { prompt: "p", cwd }, ...invoke }, on: { committed: "done" } },
    done: { type: "final" },
  },
});

/** A planner under a real `workspace()`: its pick carries the Chart, the wrapper sends it to the Open
 * body, and the body's output is the run's. */
function plannerRig(coderAccess?: "none") {
  const plannerPort = new MockFlueClient();
  const coderPort = new MockFlueClient();
  const coder = coderAccess ? { ...coderDefinition, workspace: coderAccess } : coderDefinition;
  const bodyMachine = jr2Setup({
    types: {} as { context: { result?: unknown }; input: Record<string, unknown> },
    events: [runChart],
    actors: {
      planner: agentActorWith(() => plannerPort, plannerDefinition),
      coder: agentActorWith(() => coderPort, coder),
      body: openBodyWith(
        {
          lends: { agents: ["coder"] },
          allows: { models: ["stub/model"], workspace: ["write"] },
          ceilings: CEILINGS,
        },
        { mintAgent: (_slot, definition) => agentActorWith(() => coderPort, definition) },
      ),
    },
  }).createMachine({
    id: "planned",
    context: ({ input }: { input: Record<string, unknown> }) => ({ ...input }),
    output: ({ context }: { context: { result?: unknown } }) => context.result,
    on: { "agent.fault": ".done", "workspace.lost": ".done" },
    initial: "planning",
    states: {
      planning: {
        invoke: { src: "planner", input: { prompt: "plan it", cwd: "/work", continue: true } },
        on: { run_chart: ".running" },
        initial: "idle",
        states: {
          idle: {},
          running: {
            invoke: {
              src: "body",
              input: fromPick(runChart, () => ({})),
              onDone: {
                target: "#planned.done",
                actions: assign({ result: ({ event }) => event.output }),
              },
            },
          },
        },
      },
      done: { type: "final" },
    },
  } as never) as unknown as AnyStateMachine;
  const machine = workspace(
    bodyMachine as never,
    { repos: { app: "https://example.test/app.git" } } as never,
  ) as unknown as AnyStateMachine;
  const def: WorkflowDef = { name: "planned", machine, provide: () => ({}) };
  return { plannerPort, coderPort, def };
}

async function pick(chart: unknown, coderAccess?: "none") {
  const { plannerPort, coderPort, def } = plannerRig(coderAccess);
  const host = new RunHost({
    store: await mkStore(),
    sandbox: new OneSlotSandbox(),
    instanceHarness: "http://instance-harness.test",
  });
  hosts.push(host);
  host.register(def);
  const { runId } = await host.start("planned");
  await waitFor(() => plannerPort.admits.length === 1);
  const sent = host.sendToAgent(plannerPort.admits[0]!.instanceId, { type: "run_chart", chart });
  return { host, runId, coderPort, sent };
}

test("a pick's Chart meets the door of the running Workspace: a slot's folder is refused, and the planner reads why", async () => {
  const { host, runId, coderPort } = await pick(turnIn("/work/app"));
  await waitFor(() => host.status(runId) === undefined);
  const { outcome, report } = (await host.read(runId))?.output as { outcome: string; report: string[] };
  assert.equal(outcome, "refused");
  assert.match(report.join("\n"), /"\/work\/app" is a Repo Slot's folder, not a Worktree/);
  assert.equal(coderPort.admits.length, 0);
});

test("a pick's Chart with a Worktree: the twin starts its Turn there", async () => {
  const { coderPort } = await pick(turnIn("/work/app/x"));
  await waitFor(() => coderPort.admits.length === 1);
  assert.equal(coderPort.admits[0]!.cwd, "/work/app/x");
});

test("a reference that resolves to a slot's folder is that invoke's error: no Turn, and `onError` reads why", async () => {
  const caught = {
    onError: { target: "stopped", actions: [{ type: "set", path: "why", from: "{{event.error}}" }] },
  };
  const chart = turnIn("{{context.tree}}", { context: { tree: "/work/app/", why: "" } }, caught) as {
    states: Record<string, unknown>;
  };
  chart.states.stopped = { type: "final", output: { why: "{{context.why}}" } };
  const { host, runId, coderPort } = await pick(chart);
  await waitFor(() => host.status(runId) === undefined);
  assert.equal(coderPort.admits.length, 0);
  assert.deepEqual((await host.read(runId))?.output, {
    outcome: "done",
    output: {
      why: `the Agent "coder": "/work/app/" is a Repo Slot's folder, not a Worktree; \`cwd\` is a Worktree that a cut made, "/work/app/<name>", or "/work/app/default" to read, or "/work"`,
    },
  });
});

test('a reference that resolves to a slot\'s folder is no fault for a `workspace: "none"` Agent: it reads no /work', async () => {
  const { coderPort } = await pick(turnIn("{{context.tree}}", { context: { tree: "/work/app/" } }), "none");
  await waitFor(() => coderPort.admits.length === 1);
  assert.equal(coderPort.admits[0]!.cwd, "/work/app/");
});

test("a minted Agent's reference that resolves to a slot's folder is refused at the start too", async () => {
  const caught = {
    onError: { target: "stopped", actions: [{ type: "set", path: "why", from: "{{event.error}}" }] },
  };
  const chart = turnIn(
    "{{context.tree}}",
    {
      context: { tree: "/work/app/", why: "" },
      agents: { own: { model: "stub/model", instructions: "you are the minted coder" } },
    },
    { src: "own", ...caught },
  ) as { states: Record<string, unknown> };
  chart.states.stopped = { type: "final", output: { why: "{{context.why}}" } };
  const { host, runId, coderPort } = await pick(chart);
  await waitFor(() => host.status(runId) === undefined);
  assert.equal(coderPort.admits.length, 0);
  const { output } = (await host.read(runId))?.output as { output: { why: string } };
  assert.match(output.why, /^the Agent "own": "\/work\/app\/" is a Repo Slot's folder, not a Worktree/);
});

test("a reference that resolves to a Worktree: the twin starts its Turn there", async () => {
  const { coderPort } = await pick(turnIn("{{context.tree}}", { context: { tree: "/work/app/x" } }));
  await waitFor(() => coderPort.admits.length === 1);
  assert.equal(coderPort.admits[0]!.cwd, "/work/app/x");
});

test("a door field's Chart: `{{input.app}}` is a slot's folder at the Turn's start, with no `onError`, and the run fails with why", async () => {
  const coderPort = new MockFlueClient();
  const bodyMachine = jr2Setup({
    types: {} as {
      context: { chart: unknown; workspace: { repos: { app: string } } };
      input: { chart: unknown; workspace: { repos: { app: string } } };
    },
    events: [],
    actors: {
      coder: agentActorWith(() => coderPort, coderDefinition),
      body: openBodyWith({
        lends: { agents: ["coder"] },
        allows: { models: ["stub/model"], workspace: ["write"] },
        ceilings: CEILINGS,
      }),
    },
  }).createMachine({
    id: "fielded",
    context: ({ input }) => ({ ...input }),
    on: { "agent.fault": ".done", "workspace.lost": ".done" },
    initial: "run",
    states: {
      run: {
        invoke: {
          src: "body",
          input: ({ context }: { context: { chart: unknown; workspace: { repos: { app: string } } } }) => ({
            chart: context.chart,
            app: context.workspace.repos.app,
          }),
          onDone: "done",
        },
      },
      done: { type: "final" },
    },
  }) as unknown as AnyStateMachine;
  const machine = workspace(
    bodyMachine as never,
    { input: z.object({ chart: chartSchema }), repos: { app: "https://example.test/app.git" } } as never,
  ) as unknown as AnyStateMachine;
  const host = new RunHost({ store: await mkStore(), sandbox: new OneSlotSandbox() });
  hosts.push(host);
  host.register({ name: "fielded", machine, provide: () => ({}) });
  const { runId } = await host.start("fielded", { chart: turnIn("{{input.app}}") as unknown as ChartText });
  await waitFor(() => host.status(runId) === undefined);
  const final = await host.read(runId);
  assert.equal(coderPort.admits.length, 0);
  assert.equal(final?.status, "error");
  assert.match(String(final?.fault), /"\/work\/app" is a Repo Slot's folder, not a Worktree/);
});
