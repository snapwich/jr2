// #region imports
import { assign } from "xstate";
import { z } from "zod";
import {
  agent,
  chartSchemaFor,
  defineEvent,
  fromPick,
  jr2Setup,
  openBody,
  type OpenBodyDeclaration,
  type OpenBodyOutput,
} from "@jr2/orchestrator";
// #endregion imports

// #region model
const model = "anthropic/claude-sonnet-5-5";
// #endregion model

// #region body
// What a Chart can use. A Chart names these parts by their slot keys, and nothing else.
const declaration: OpenBodyDeclaration = {
  // The Agent `writer`, and the Gate, so that a Chart can ask a person.
  lends: { agents: ["writer"], gate: true },
  // A Chart can add its own Agents, with this model and with no Sandbox.
  allows: { models: [model], workspace: ["none"] },
  // The limits of one run of a Chart.
  ceilings: { turns: 12, wallClock: "30m", transitions: 500, fanOut: 2, size: 65536 },
};
// #endregion body

// #region pick
// The pick of the planner. Its parameter is a Chart, in the grammar of this Open body.
const runChart = defineEvent({
  name: "run_chart",
  description: "Run this Chart. Its outcome is the answer to this call.",
  input: z.object({ chart: chartSchemaFor(declaration) }),
});
// #endregion pick

type Input = { task: string };
type Context = Input & { result?: OpenBodyOutput };

const outcome = (output: unknown) => (output as OpenBodyOutput).outcome;

// #region machine
export const machine = jr2Setup({
  types: {} as { context: Context; input: Input },
  events: [runChart],
  actors: {
    planner: agent({
      model,
      workspace: "none",
      instructions: "You plan work as a Chart. You write the Chart, and you run it with run_chart.",
    }),
    writer: agent({
      model,
      workspace: "none",
      instructions: "You write clear, short text for engineers.",
    }),
    body: openBody(declaration),
  },
}).createMachine({
  id: "plan",
  input: z.object({ task: z.string() }),
  context: ({ input }) => ({ task: input.task }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        src: "planner",
        input: ({ context }) => ({
          prompt: `Write a Chart for this task, and pick run_chart with it: ${context.task}`,
          continue: true,
        }),
      },
      initial: "ready",
      states: {
        ready: { on: { run_chart: "running" } },
        running: {
          // The Chart of the pick runs here. The task goes into the input of the Chart.
          invoke: {
            src: "body",
            input: fromPick(runChart, ({ context }: { context: Context }) => ({ task: context.task })),
            onDone: [
              {
                guard: ({ event }) => outcome(event.output) === "done",
                target: "#plan.done",
                actions: assign({ result: ({ event }) => event.output as OpenBodyOutput }),
              },
              // A refusal or a ceiling goes back to the planner, as the answer to its pick.
              { target: "ready", actions: assign({ result: ({ event }) => event.output as OpenBodyOutput }) },
            ],
          },
        },
      },
    },
    done: { type: "final" },
  },
  output: ({ context }) => context.result,
});
// #endregion machine
