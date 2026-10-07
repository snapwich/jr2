// The answered claim (ADR-0067, ADR-0024): a pick that runs a `command` Effect is answered with the
// command's output, and a correct Agent acts on that output.
//
// `run_tests` enters a state that runs the tests as a command in the coder's own Sandbox — they fail,
// and the output says which test and why. The pick is outstanding while they run; its answer is the
// command's output, with `ship` and `report_failure` both allowed after it. The prompt says to ship
// if the tests pass and to report the failure if they do not. The first pick the Machine takes after
// `run_tests` is the measurement: `report_failure`. An Agent that reads only that the tests ran ships.
//
// Filename `answered.ts` → workflow "answered".

import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  command,
  defineEvent,
  jr2Setup,
  workspace,
  type HostInjectedInput,
  type Workspaced,
} from "@jr2/orchestrator";
import { coder } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

const runTests = defineEvent({
  name: "run_tests",
  description: "Run the project's test suite. Its result is this call's answer.",
  input: z.object({}),
});
const ship = defineEvent({ name: "ship", description: "Ship the change.", input: z.object({ notes: z.string() }) });
const reportFailure = defineEvent({
  name: "report_failure",
  description: "Report that the change is not ready, and why.",
  input: z.object({ summary: z.string() }),
});

const door = z.object({ thinking: z.enum(["off", "on"]).default("off"), marker: z.string() });

type BodyInput = Workspaced<z.infer<typeof door> & HostInjectedInput, "app">;
type BodyContext = BodyInput & { picks: string[]; fault?: string };

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput },
  events: [runTests, ship, reportFailure],
  actors: {
    coder: agent(coder),
    tests: command(["node", "-e", "console.log('auth.test.ts: expected 200, got 500'); process.exit(1)"]),
  },
}).createMachine({
  id: "body",
  context: ({ input }) => ({ ...input, picks: [] }),
  initial: "work",
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    work: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          prompt:
            `[${context.marker}] The auth fix is in. Run the tests. If they pass, ship the change; if they ` +
            `fail, report the failure.`,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: { "agent.fault": { target: "faulted", actions: assign({ fault: ({ event }) => event.reason }) } },
      initial: "ready",
      states: {
        ready: {
          on: {
            run_tests: {
              target: "testing",
              actions: assign({ picks: ({ context }) => [...context.picks, "run_tests"] }),
            },
            ship: { target: "#body.shipped", actions: assign({ picks: ({ context }) => [...context.picks, "ship"] }) },
            report_failure: {
              target: "#body.reported",
              actions: assign({ picks: ({ context }) => [...context.picks, "report_failure"] }),
            },
          },
        },
        testing: { invoke: { src: "tests", onDone: "ready" } },
      },
    },
    shipped: { type: "final", output: ({ context }) => ({ outcome: "shipped", picks: context.picks }) },
    reported: { type: "final", output: ({ context }) => ({ outcome: "reported", picks: context.picks }) },
    lost: { type: "final", output: ({ context }) => ({ outcome: "lost", picks: context.picks }) },
    faulted: {
      type: "final",
      output: ({ context }) => ({ outcome: "faulted", picks: context.picks, reason: context.fault }),
    },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});

export const machine = workspace(body, {
  input: door,
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
  spec: () => ({ branch: "model-answered" }),
});
