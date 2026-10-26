import { assign } from "xstate";
import { z } from "zod";
import { defineEvent, fail, jr2Setup } from "@jr2/orchestrator";

// The two answers that the Gate takes. A person, a script or a CI job sends one of them.
const approve = defineEvent({
  name: "approve",
  description: "Release this version.",
  input: z.object({}),
});
const reject = defineEvent({
  name: "reject",
  description: "Do not release this version. Say why.",
  input: z.object({ reason: z.string().min(1) }),
});

type Context = { version: string; reason?: string };

export const machine = jr2Setup({
  types: {} as { input: { version: string }; context: Context },
  events: [approve, reject],
  actors: { fail: fail() },
}).createMachine({
  id: "release",
  // jr2 checks each run input against this schema before the run starts.
  input: z.object({ version: z.string() }),
  context: ({ input }) => ({ version: input.version }),
  initial: "review",
  states: {
    review: {
      // The Gate is open while the run is in this state. Its id is the state key, "review".
      // It takes the events of this state: approve and reject.
      invoke: { src: "gate", input: ({ context }) => ({ meta: { version: context.version } }) },
      on: {
        approve: "released",
        reject: { target: "rejected", actions: assign({ reason: ({ event }) => event.reason }) },
      },
    },
    released: { type: "final" },
    // A person stopped the release, and the run ends here. Not a final state: the run ends
    // `failed`, with the person's reason.
    rejected: { invoke: { src: "fail", input: ({ context }) => ({ reason: context.reason! }) } },
  },
});
