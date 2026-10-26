// An e2e fixture workflow that catches a Failure (ADR-0073): its child Machine `attempt` invokes
// `fail`, the Failure goes up to the parent's invoke, and an `onError` that `isFailure` guards
// catches it. The run ends `done`, and its output names the reason that it caught. A defect has no
// route, so it would go up and end the run `error`. Filename `recovering.ts` → workflow
// "recovering".

import { assign } from "xstate";
import { fail, isFailure, jr2Setup } from "@jr2/orchestrator";

const attempt = jr2Setup({ actors: { fail: fail() } }).createMachine({
  id: "attempt",
  initial: "stuck",
  states: { stuck: { invoke: { src: "fail", input: { reason: "no plan fits the ticket" } } } },
});

export const machine = jr2Setup({
  types: {} as { context: { caught?: string }; output: { caught?: string } },
  actors: { attempt },
}).createMachine({
  id: "recovering",
  context: {},
  initial: "planning",
  states: {
    planning: {
      invoke: {
        src: "attempt",
        onDone: "planned",
        onError: {
          guard: ({ event }) => isFailure(event.error),
          target: "recovered",
          actions: assign({ caught: ({ event }) => (isFailure(event.error) ? event.error.reason : undefined) }),
        },
      },
    },
    planned: { type: "final" },
    recovered: { type: "final" },
  },
  output: ({ context }) => ({ caught: context.caught }),
});
