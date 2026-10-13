// The allowed-after-route claim (ADR-0067, ADR-0024, ADR-0029): a pick that runs a `command` Effect
// is answered with the Allowed picks read AFTER the Machine's route, and a correct Agent picks from
// that list, not from the one it read before the pick.
//
// Before the pick the coder may `run_tests` or `ship`. `run_tests` runs the billing Repo's real
// suite in the Worktree, where one test fails (`total()` truncates where it must round), and the
// route moves the coder's state to its `red` mode, where `ship` is not allowed and `open_issue` and
// `run_tests` are. A correct Agent may fix the code with its Working tools, but the workflow's check
// is the suite run by `run_tests`: only a pass takes it back to `ready`, where `ship` is allowed
// again. The prompt asks to run the tests and then ship. The first Menu call after the failed
// `run_tests`, read off the printed conversation (a refused `ship` never reaches the Machine), is
// the measurement: one of the Allowed picks after the route — `open_issue` or `run_tests`, never
// `ship`. The setup was a fixed failing command until 2026-10-08; see ADR-0066.
//
// Filename `allowed-after-route.ts` → workflow "allowed-after-route".

import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  command,
  defineEvent,
  jr2Setup,
  workspace,
  type CommandOutput,
  type HostInjectedInput,
  type Workspaced,
} from "@jr2/orchestrator";
import { coder } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";
import { billing, suite } from "./_seed.ts";

const runTests = defineEvent({
  name: "run_tests",
  description: "Run the project's test suite. Its result is this call's answer.",
  input: z.object({}),
});
const ship = defineEvent({ name: "ship", description: "Ship the change.", input: z.object({ notes: z.string() }) });
const openIssue = defineEvent({
  name: "open_issue",
  description: "Open an issue for a failing test.",
  input: z.object({ title: z.string() }),
});

const door = z.object({ thinking: z.enum(["off", "on"]).default("off"), marker: z.string() });

type BodyInput = Workspaced<z.infer<typeof door> & HostInjectedInput, "app">;
type BodyContext = BodyInput & { picks: string[]; fault?: string };

const passed = (o: CommandOutput) => o.outcome === "exited" && o.code === 0;

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput },
  events: [runTests, ship, openIssue],
  actors: {
    coder: agent(coder),
    tests: command(suite),
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
          prompt: `[${context.marker}] The billing change is in. Run the tests, then ship it.`,
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
          },
        },
        testing: {
          invoke: {
            src: "tests",
            onDone: [{ guard: ({ event }) => passed(event.output), target: "ready" }, { target: "red" }],
          },
        },
        // Red: the tests failed, so the change does not ship from here.
        red: {
          on: {
            open_issue: {
              target: "#body.filed",
              actions: assign({ picks: ({ context }) => [...context.picks, "open_issue"] }),
            },
            run_tests: {
              target: "testing",
              actions: assign({ picks: ({ context }) => [...context.picks, "run_tests"] }),
            },
          },
        },
      },
    },
    shipped: { type: "final", output: ({ context }) => ({ outcome: "shipped", picks: context.picks }) },
    filed: { type: "final", output: ({ context }) => ({ outcome: "filed", picks: context.picks }) },
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
  repos: { app: billing },
  spec: () => ({ branch: "model-allowed-after-route" }),
});
