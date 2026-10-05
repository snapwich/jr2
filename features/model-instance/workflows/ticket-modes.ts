// The run, with modes (ADR-0066, ADR-0015): the `ticket` task carried by ONE coder Turn that walks
// three modes of its state — `coding`, `testing`, `reviewing` — and ends with `submit`. The Menu is
// every mode's picks, fixed for the conversation; each pick's receipt says what the next mode
// allows, and the Briefing's standing part says that the newest "Allowed now" holds (ADR-0062).
//
//   working (invokes coder)
//     coding     run_tests -> testing
//     testing    tests_passed -> reviewing, tests_failed -> coding
//     reviewing  revise -> coding, submit (names a commit) -> out of `working`
//
// The coder runs the tests itself with bash — `testing` is the mode in which it reports them —
// and reviews its own diff in `reviewing`. A guard refuses a `submit` that names no commit
// (ADR-0029). `submit` parks at the `shipping` Gate, the inspection window (ADR-0012/0054): the
// step reads the branch and runs the test IN the pod, as `ticket`'s does, then ships. The ledger
// (`picks`) holds every pick the Machine took, and `entries` how often the coder's state was
// entered — one Turn, so once, whatever the model did inside it.
//
// Filename `ticket-modes.ts` → workflow "ticket-modes".

import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, jr2Setup, workspace, type HostInjectedInput, type Workspaced } from "@jr2/orchestrator";
import { coder } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

const TICKET =
  "The test in `test.js` fails: `greet(name)` in `greet.js` must return `hello, <name>` " +
  "(lower-case, a comma and a space), and `greet()` with no name must return `hello, world`. " +
  "Make `node --test` pass without changing the test.";

const runTests = defineEvent({
  name: "run_tests",
  description: "Your change is in place; move on to running the project's tests.",
  input: z.object({ change: z.string() }),
});
const testsPassed = defineEvent({
  name: "tests_passed",
  description: "You ran `node --test` and it passed. Quote its summary line.",
  input: z.object({ output: z.string() }),
});
const testsFailed = defineEvent({
  name: "tests_failed",
  description: "You ran `node --test` and it failed. Say what failed.",
  input: z.object({ output: z.string() }),
});
const revise = defineEvent({
  name: "revise",
  description: "Your own review found a problem; go back to coding.",
  input: z.object({ why: z.string() }),
});
const submit = defineEvent({
  name: "submit",
  description: "The work is committed on the branch. Name the commit (its sha) and summarize it.",
  input: z.object({ commit: z.string(), summary: z.string() }),
});
const ship = defineEvent({ name: "ship", audience: "external", input: z.object({}) });

const door = z.object({ thinking: z.enum(["off", "on"]).default("off") });

type BodyInput = Workspaced<z.infer<typeof door> & HostInjectedInput, "app">;
type BodyContext = BodyInput & { picks: string[]; entries: number; commit?: string; fault?: string };

const SHA = /^[0-9a-f]{7,40}$/;

export type TicketModesOutput = {
  outcome: "shipped" | "lost" | "faulted";
  picks: string[];
  entries: number;
  commit?: string;
  reason?: string;
};

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput; output: TicketModesOutput },
  events: [runTests, testsPassed, testsFailed, revise, submit, ship],
  actors: { coder: agent(coder) },
}).createMachine({
  id: "body",
  context: ({ input }) => ({ ...input, picks: [], entries: 0 }),
  initial: "working",
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    working: {
      entry: assign({ entries: ({ context }) => context.entries + 1 }),
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          prompt:
            `Ticket: ${TICKET}\n\nWork in your working directory, which is a checkout of the repository on ` +
            `branch \`${context.workspace.branch}\`. Make the change, run the tests, review your own diff, ` +
            `commit on that branch, and submit the commit's sha.`,
          cwd: context.workspace.repos.app,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: {
        "agent.fault": { target: "faulted", actions: assign({ fault: ({ event }) => event.reason }) },
      },
      initial: "coding",
      states: {
        coding: {
          on: {
            run_tests: {
              target: "testing",
              actions: assign({ picks: ({ context }) => [...context.picks, "run_tests"] }),
            },
          },
        },
        testing: {
          on: {
            tests_passed: {
              target: "reviewing",
              actions: assign({ picks: ({ context }) => [...context.picks, "tests_passed"] }),
            },
            tests_failed: {
              target: "coding",
              actions: assign({ picks: ({ context }) => [...context.picks, "tests_failed"] }),
            },
          },
        },
        reviewing: {
          on: {
            revise: { target: "coding", actions: assign({ picks: ({ context }) => [...context.picks, "revise"] }) },
            // Guarded on the payload (ADR-0029): offered, then judged on delivery.
            submit: {
              guard: ({ event }) => SHA.test(event.commit.trim()),
              target: "#body.shipping",
              actions: [
                assign({ picks: ({ context }) => [...context.picks, "submit"] }),
                assign({ commit: ({ event }) => event.commit.trim() }),
              ],
            },
          },
        },
      },
    },
    shipping: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          meta: {
            branch: context.workspace.branch,
            worktree: context.workspace.repos.app,
            commit: context.commit,
            picks: context.picks,
            entries: context.entries,
          },
        }),
      },
      on: { ship: { target: "shipped" } },
    },
    shipped: {
      type: "final",
      output: ({ context }): TicketModesOutput => ({
        outcome: "shipped",
        picks: context.picks,
        entries: context.entries,
        commit: context.commit,
      }),
    },
    lost: {
      type: "final",
      output: ({ context }): TicketModesOutput => ({ outcome: "lost", picks: context.picks, entries: context.entries }),
    },
    faulted: {
      type: "final",
      output: ({ context }): TicketModesOutput => ({
        outcome: "faulted",
        picks: context.picks,
        entries: context.entries,
        reason: context.fault,
      }),
    },
  },
  output: ({ event }) => (event as { output?: TicketModesOutput }).output as TicketModesOutput,
});

export const machine = workspace(body, {
  input: door,
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
  // Nothing is pushed, so a fixed branch collides with nothing (each run's pod cuts its own).
  spec: () => ({ branch: "model-ticket-modes" }),
});
