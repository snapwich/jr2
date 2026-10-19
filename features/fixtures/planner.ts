// An e2e fixture for ADR-0070's Machine door: a Chart wrapper whose planner Agent writes the Chart.
// The planner's pick `run_chart` carries a Chart (`chartSchemaFor` the Open body's declaration, so the
// grammar narrowed to what the body lends is the pick's tool parameters), and the state it enters
// invokes the Open body with it through `fromPick`.
//
// The body runs in a state BELOW the planner's, so the pick is outstanding while the Chart runs and
// is answered at Rest (ADR-0024). A Chart the door refuses settles the body with
// `{ outcome: "refused", report }` (D-A): `onDone` routes back to `ready`, and the pick's answer is
// that output, so the planner reads the report and can pick again with a corrected Chart. A Chart
// that runs to its end routes to `done`.
//
// The planner and the lent coder admit against the stub Harness; the endpoint is run input, passed
// to the body, which places the Chart's Turns with it (see charted.ts).
//
// Filename `planner.ts` → workflow "planner".

import { assign } from "xstate";
import { z } from "zod";
import {
  agent,
  chartSchemaFor,
  defineEvent,
  fromPick,
  jr2Setup,
  openBody,
  type AgentTurnInput,
  type AgentTurnPlacement,
  type OpenBodyDeclaration,
  type OpenBodyOutput,
} from "@jr2/orchestrator";

const declaration: OpenBodyDeclaration = {
  lends: { agents: ["coder"], guards: ["underLimit"] },
  allows: { models: ["stub/model"], workspace: ["none", "write"] },
  ceilings: { turns: 6, wallClock: "10m", transitions: 500, fanOut: 2, size: 65536 },
};

const runChart = defineEvent({
  name: "run_chart",
  description: "Run this Chart. Its outcome is this call's answer.",
  input: z.object({ chart: chartSchemaFor(declaration) }),
});

type Input = { endpoint: string; task: string };
type Ctx = Input & { output?: OpenBodyOutput };

/** The Agents' content is inert here: the stub runs no model. */
const planner = agent({
  model: "stub/model",
  workspace: "none",
  instructions: "You write the work as a Chart, then end your turn by calling one of your tools.",
});
const coder = agent({
  model: "stub/model",
  instructions: "You are the coder. Do the work, then end your turn by calling one of your tools.",
});

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [runChart],
  actors: {
    planner,
    coder,
    body: openBody(declaration),
  },
  guards: { underLimit: ({ context }) => Number((context as { round?: unknown }).round ?? 0) < 3 },
}).createMachine({
  id: "planner",
  input: z.object({ endpoint: z.string(), task: z.string() }),
  context: ({ input }) => ({ ...input }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        src: "planner",
        input: ({ context }): AgentTurnInput & AgentTurnPlacement => ({
          endpoint: context.endpoint,
          prompt: `Write a Chart for this task and pick run_chart with it: ${context.task}`,
          continue: true,
        }),
      },
      initial: "ready",
      states: {
        ready: { on: { run_chart: "running" } },
        running: {
          invoke: {
            id: "body",
            src: "body",
            input: fromPick(runChart, ({ context }: { context: Ctx }) => ({
              endpoint: context.endpoint,
              task: context.task,
            })),
            onDone: [
              {
                guard: ({ event }) => (event.output as OpenBodyOutput | undefined)?.outcome === "done",
                target: "#planner.done",
                actions: assign({ output: ({ event }) => event.output }),
              },
              // Refused, or a ceiling: back to Rest, where the pick is answered with the output.
              { target: "ready", actions: assign({ output: ({ event }) => event.output }) },
            ],
          },
        },
      },
    },
    done: { type: "final" },
  },
  output: ({ context }) => context.output,
});
