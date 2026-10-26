// #region imports
import { assign } from "xstate";
import { z } from "zod";
import { agent, chartSchema, jr2Setup, openBody, type OpenBodyOutput } from "@jr2/orchestrator";
// #endregion imports

// #region model
const model = "local/qwen3.6-35b-a3b";
// #endregion model

// #region door
// The run input. The field `chart` is a Chart, so this Machine takes a Chart in its run input,
// and it can keep Charts under names.
const door = z.object({ topic: z.string(), chart: chartSchema });
// #endregion door

type Input = z.infer<typeof door>;
type Context = Input & { result?: OpenBodyOutput };

// #region machine
export const machine = jr2Setup({
  types: {} as { context: Context; input: Input },
  actors: {
    writer: agent({
      model,
      workspace: "none",
      instructions: "You write clear, short text for engineers.",
    }),
    // A Chart can use the Agent `writer`, and `fail` to end the run as a Failure. It cannot add
    // Agents of its own.
    body: openBody({
      lends: { agents: ["writer"], fail: true },
      allows: { models: [], workspace: [] },
      ceilings: { turns: 6, wallClock: "15m", transitions: 200, fanOut: 1, size: 65536 },
    }),
  },
}).createMachine({
  id: "notes",
  input: door,
  context: ({ input }) => ({ ...input }),
  initial: "running",
  states: {
    running: {
      invoke: {
        src: "body",
        // The Chart, and the input that the Chart reads as {{input.topic}}.
        input: ({ context }: { context: Context }) => ({ chart: context.chart, topic: context.topic }),
        onDone: { target: "done", actions: assign({ result: ({ event }) => event.output as OpenBodyOutput }) },
      },
    },
    done: { type: "final" },
  },
  output: ({ context }) => context.result,
});
// #endregion machine
