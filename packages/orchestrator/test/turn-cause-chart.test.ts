// The cause of a Turn's end (ADR-0024, `cause.ts`) inside a Chart (ADR-0070): a Chart's Agents end
// their Turns by their own picks, a lent delay that leaves is no pick's, and a lent delay that the
// pick armed is. Socket-free, through the real Chart compile and the real `RunHost`.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assign, type AnyActorRef, type AnyStateMachine } from "xstate";
import { z } from "zod";
import { agentActorWith } from "../src/actor.ts";
import type { AgentDefinition } from "../src/agent.ts";
import { chartSchema, type ChartText } from "../src/chart.ts";
import { arg, commandWith } from "../src/effect.ts";
import { agent } from "../src/harness-client.ts";
import { openBodyWith, type Ceilings } from "../src/open-body.ts";
import { RunHost, type WorkflowDef } from "../src/run-host.ts";
import { jr2Setup } from "../src/setup.ts";
import { fakeWorkspace, FakeHarnessExec } from "./_effects.ts";
import { mkStore, MockFlueClient, waitFor } from "./_fixtures.ts";

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
  opts: { ceilings?: Partial<Ceilings>; lendGuard?: boolean; lendCoder?: boolean; id?: string } = {},
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
    on: { "agent.fault": {} },
    id: opts.id ?? "charted",
    input: z.object({ endpoint: z.string(), task: z.string(), chart: chartSchema }),
    context: ({ input }) => ({ ...input }),
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
        },
      },
      done: { type: "final" },
      refused: { type: "final" },
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

const causes = (c: MockFlueClient) => c.aborts.map((a) => a.cause ?? "none");

test("C1 a Chart's review loop: every Turn ends by its own pick: every sweep says pick, and names the running Submission", async () => {
  const { ports, def } = rig();
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const runId = await started(host);
  await waitFor(() => ports.coder.admits.length === 1);
  host.sendToAgent(ports.coder.admits[0]!.instanceId, { type: "submit" });
  await waitFor(() => ports.minted.admits.length === 1);
  host.sendToAgent(ports.minted.admits[0]!.instanceId, { type: "revise", notes: "rename it" });
  await waitFor(() => ports.coder.admits.length === 2);
  host.sendToAgent(ports.coder.admits[1]!.instanceId, { type: "submit" });
  await waitFor(() => ports.minted.admits.length === 2);
  host.sendToAgent(ports.minted.admits[1]!.instanceId, { type: "approve" });
  await waitFor(() => host.status(runId) === undefined);
  assert.deepEqual(causes(ports.coder), ["pick", "pick"]);
  assert.deepEqual(causes(ports.minted), ["pick", "pick"], "the last pick reaches the Chart's final state");
  assert.deepEqual(ports.coder.abortSubmissions, ["sub-1", "sub-2"]);
  assert.deepEqual(ports.minted.abortSubmissions, ["sub-1", "sub-2"]);
});

test("C2 a Chart state's lent delay leaves the Agent's state while the Agent runs: none", async () => {
  const TIMED: ChartText = {
    events: { submit: { input: { ...EMPTY } } },
    initial: "draft",
    states: {
      draft: {
        invoke: { src: "coder", input: { prompt: "do {{input.task}}" } },
        after: { cooldown: "late" },
        on: { submit: "shipped" },
      },
      late: { type: "final" },
      shipped: { type: "final" },
    },
  } as never;
  const { ports, def } = rig();
  const host = newHost({ store: await mkStore() });
  host.register(def());
  const runId = await started(host, TIMED);
  await waitFor(() => ports.coder.admits.length === 1);
  await waitFor(() => ports.coder.aborts.length === 1);
  assert.deepEqual(causes(ports.coder), ["none"]);
});

test("C3 a Chart whose pick re-enters the Agent's state through a lent delay armed by the pick: pick", async () => {
  const TIMED: ChartText = {
    events: { submit: { input: { ...EMPTY } } },
    initial: "draft",
    states: {
      draft: { invoke: { src: "coder", input: { prompt: "do {{input.task}}" } }, on: { submit: "wait" } },
      wait: { after: { cooldown: "shipped" } },
      shipped: { type: "final" },
    },
  } as never;
  const { ports, def } = rig();
  const host = newHost({ store: await mkStore() });
  host.register(def());
  await started(host, TIMED);
  await waitFor(() => ports.coder.admits.length === 1);
  host.sendToAgent(ports.coder.admits[0]!.instanceId, { type: "submit" });
  await waitFor(() => ports.coder.aborts.length === 1);
  assert.deepEqual(causes(ports.coder), ["pick"]);
});
