// The chart-refusal claim (ADR-0070): a planner told why its Chart was refused picks again with a
// Chart the door admits. The refusal text is jr2's (the door's report), so it is what the claim
// measures; the prompt below is fixed data.
//
// A Chart wrapper. Its `workspace: "none"` planner has one pick, `run_chart { chart }`, and the state it
// enters invokes the Open body with that Chart. The body lends ONE Agent slot, `summarizer`
// (Menu-only), and allows a Chart's own Agents the profile's model with no Workspace. The prompt
// asks for a Chart that first runs "the linter" and then the summarizer, and names no slot: the
// first Chart is expected to name `linter`, which nothing lends. The door refuses it, and the body
// settles with `{ outcome: "refused", report }` (D-A), which is the pick's answer: the report names
// `linter` and what is lent. The next `run_chart` is the measurement: does the door admit it?
//
// The body runs below the planner's state, so the pick is outstanding while a Chart runs (ADR-0024).
// A refusal settles the body at its start, so a body still running after a moment was admitted:
// the wrapper then leaves the planner's state, which stops the Chart and its Agents. A Chart the
// model writes may never end, and the claim measures its admission, not what it does after.
//
// `outcomes` keeps each Chart's verdict in order, as the step reads it off `jr2 status`: `refused`,
// `admitted`, or `errored` (admitted, and then its body failed or an Agent faulted). A trial whose
// first Chart never met a refusal at the door is void (`features/lib/model-chart.ts`).
//
// Filename `chart-refusal.ts` → workflow "chart-refusal".

import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  chartSchemaFor,
  defineEvent,
  fail,
  fromPick,
  jr2Setup,
  openBody,
  type HostInjectedInput,
  type OpenBodyDeclaration,
  type OpenBodyOutput,
} from "@jr2/orchestrator";
import { advisor } from "./_agents.ts";
import { dialFor, MODEL, type ThinkingCell } from "./_profile.ts";

/** The Open body: it lends `summarizer` alone, and allows no model, so the Chart mints no Agent of
 * its own: "the linter" can only be named as a lent Agent, which is the refusal the claim measures. */
const declaration: OpenBodyDeclaration = {
  lends: { agents: ["summarizer"] },
  allows: { models: [], workspace: [] },
  ceilings: { turns: 4, wallClock: "5m", transitions: 200, fanOut: 2, size: 65536 },
};

// The pick's tool parameters are the grammar narrowed to this body (ADR-0070): the lent name is an
// enum, and with no allowed model `agents` can mint nothing. A `src` stays a free string, so
// `linter` is the door's to refuse.
const runChart = defineEvent({
  name: "run_chart",
  description: "Run this Chart. Its outcome is this call's answer.",
  input: z.object({ chart: chartSchemaFor(declaration) }),
});

/** The change the Chart's steps work on: its `input.change`. */
const CHANGE =
  "src/billing.js: `total()` now rounds each line to the cent before it sums the lines, where it " +
  "summed first and rounded once.";

/** How many refused Charts the planner may send before the trial ends. */
const MAX_REFUSALS = 3;

/** How long a body runs before the wrapper reads it as admitted. A refusal settles at its start. */
const ADMITTED_AFTER_MS = 2000;

const door = z.object({ thinking: z.enum(["off", "on"]).default("off"), marker: z.string() });

type Input = z.infer<typeof door> & HostInjectedInput;
/** `outcomes`: each Chart's verdict, in order — `refused`, `admitted` or `errored`. */
type Ctx = Input & { outcomes: string[]; report?: string[]; fault?: string };

const refused = ({ event }: { event: unknown }): boolean =>
  (event as { output?: OpenBodyOutput }).output?.outcome === "refused";

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [runChart],
  actors: {
    fail: fail(),
    planner: agent(advisor),
    summarizer: agent(advisor),
    body: openBody(declaration),
  },
}).createMachine({
  id: "chart-refusal",
  input: door,
  context: ({ input }) => ({ ...input, outcomes: [] }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        src: "planner",
        input: ({ context }) => ({
          prompt:
            `[${context.marker}] Write a Chart for this job and pick \`run_chart\` with it. The job has two ` +
            `steps: first the linter checks the change, then the summarizer writes a one-paragraph ` +
            `summary of it for the release notes. The Chart's input holds the change as \`change\`.`,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: {
        "agent.fault": {
          target: "faulted",
          actions: assign({ fault: ({ event }) => (event as { reason?: string }).reason }),
        },
      },
      initial: "ready",
      states: {
        ready: { on: { run_chart: "running" } },
        running: {
          invoke: {
            id: "body",
            src: "body",
            input: fromPick(runChart, () => ({ change: CHANGE })),
            onDone: [
              {
                guard: ({ context, event }) => refused({ event }) && context.outcomes.length + 1 >= MAX_REFUSALS,
                target: "#chart-refusal.refused",
                actions: assign({ outcomes: ({ context }) => [...context.outcomes, "refused"] }),
              },
              {
                guard: refused,
                target: "ready",
                actions: assign({
                  outcomes: ({ context }) => [...context.outcomes, "refused"],
                  report: ({ event }) => (event.output as { report?: string[] }).report,
                }),
              },
              // A Chart that admitted and ended at once (it invoked no Agent).
              {
                target: "#chart-refusal.admitted",
                actions: assign({ outcomes: ({ context }) => [...context.outcomes, "admitted"] }),
              },
            ],
            // The door admitted the Chart, and its body then failed (a defect, never a refusal,
            // D-A): still an admission, which is what the claim measures.
            onError: {
              target: "#chart-refusal.admitted",
              actions: assign({ outcomes: ({ context }) => [...context.outcomes, "errored"] }),
            },
          },
          // An Agent faulted after the door admitted the Chart: an Agent of the Chart, whose fault the
          // body sends here when the Chart does not route it (ADR-0074), or the planner, whose pick is
          // held. A refusal settles the body at its start, so this state means an admission.
          on: {
            "agent.fault": {
              target: "#chart-refusal.admitted",
              actions: assign({ outcomes: ({ context }) => [...context.outcomes, "errored"] }),
            },
          },
          after: {
            [ADMITTED_AFTER_MS]: {
              target: "#chart-refusal.admitted",
              actions: assign({ outcomes: ({ context }) => [...context.outcomes, "admitted"] }),
            },
          },
        },
      },
    },
    admitted: { type: "final", output: ({ context }) => ({ outcome: "admitted", outcomes: context.outcomes }) },
    refused: {
      type: "final",
      output: ({ context }) => ({ outcome: "refused", outcomes: context.outcomes, report: context.report }),
    },
    faulted: {
      invoke: {
        src: "fail",
        input: ({ context }) => ({
          reason: "the Agent's Turn could not go on",
          detail: { outcome: "faulted", outcomes: context.outcomes, reason: context.fault },
        }),
      },
    },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
