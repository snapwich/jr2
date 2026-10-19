// An e2e fixture for ADR-0070: a Chart wrapper the stub-harness tier runs. Its door takes a Chart
// one-shot (`chart` is `chartSchema`), so it can also hold named Charts: runtime Charts by
// `PUT /workflows/charted/charts/<name>`, and Chart files at `workflows/charted/<name>.chart.json`.
//
// The Open body `body` lends the Agent `coder` and the guard `underLimit`, and allows a Chart's own
// Agents the stub's model with no Workspace or a written one. The ceilings are small, so a Chart
// that never ends reaches `turns` in a few Turns.
//
// The lent coder admits against the e2e tier's stub Harness. A Chart names no url (ADR-0070): the
// url comes from this wrapper's door as `endpoint`, which the wrapper passes the body, and the body
// places every Agent Turn its Chart starts with it. The Chart never reads it. The door also gives
// the Chart its `task`, which a Chart reads as `{{input.task}}`.
//
// The body settles with an output (D-A): `done` with the Chart's output, `refused` with the door's
// report, or `ceiling`. Each routes to a final state of its own, and the output is kept in
// `context.output`, which `jr2 status` shows.
//
// Filename `charted.ts` → workflow "charted".

import { assign } from "xstate";
import { z } from "zod";
import { agent, chartSchema, jr2Setup, openBody, type OpenBodyOutput } from "@jr2/orchestrator";

const door = z.object({ endpoint: z.string(), task: z.string(), chart: chartSchema });

type Input = z.infer<typeof door>;
type Ctx = Input & { output?: OpenBodyOutput };

/** The Agent this wrapper lends a Chart. Its content is inert here: the stub runs no model. */
const coder = agent({
  model: "stub/model",
  instructions: "You are the coder. Do the work, then end your turn by calling one of your tools.",
});

const outcomeIs =
  (outcome: OpenBodyOutput["outcome"]) =>
  ({ event }: { event: unknown }): boolean =>
    (event as { output?: OpenBodyOutput }).output?.outcome === outcome;

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [],
  actors: {
    coder,
    body: openBody({
      lends: { agents: ["coder"], guards: ["underLimit"] },
      allows: { models: ["stub/model"], workspace: ["none", "write"] },
      ceilings: { turns: 6, wallClock: "10m", transitions: 500, fanOut: 2, size: 65536 },
    }),
  },
  // Lent to the Chart, so it reads the CHART's context: its `round`, which a generic `increment`
  // writes.
  guards: { underLimit: ({ context }) => Number((context as { round?: unknown }).round ?? 0) < 3 },
}).createMachine({
  id: "charted",
  input: door,
  context: ({ input }) => ({ ...input }),
  initial: "running",
  states: {
    running: {
      invoke: {
        id: "body",
        src: "body",
        input: ({ context }: { context: Ctx }) => ({
          chart: context.chart,
          endpoint: context.endpoint,
          task: context.task,
        }),
        onDone: [
          { guard: outcomeIs("done"), target: "done", actions: assign({ output: ({ event }) => event.output }) },
          { guard: outcomeIs("refused"), target: "refused", actions: assign({ output: ({ event }) => event.output }) },
          { target: "ceiling", actions: assign({ output: ({ event }) => event.output }) },
        ],
      },
    },
    done: { type: "final" },
    refused: { type: "final" },
    ceiling: { type: "final" },
  },
  output: ({ context }) => context.output,
});
