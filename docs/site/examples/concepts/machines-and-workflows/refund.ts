import { z } from "zod";
import { assign, emit } from "xstate";
import { defineEvent, fail, jr2Setup } from "@jr2/orchestrator";

// The Vocabulary: the events that this Machine takes.
const approve = defineEvent({
  name: "approve",
  description: "Pay the refund.",
  input: z.object({}),
});
const reject = defineEvent({
  name: "reject",
  description: "Do not pay the refund, and say why.",
  input: z.object({ reason: z.string().min(1) }),
});

// The door: the input that starts a run. jr2 refuses a start that does not match it.
const runInput = z.object({
  order: z.string(),
  amount: z.number().positive(),
});
type RunInput = z.infer<typeof runInput>;

export const machine = jr2Setup({
  types: {} as {
    input: RunInput;
    context: RunInput & { reason?: string };
    emitted: { type: "decided"; approved: boolean };
  },
  events: [approve, reject],
  actors: { fail: fail() },
}).createMachine({
  id: "refund",
  input: runInput,
  context: ({ input }) => ({ order: input.order, amount: input.amount }),
  initial: "review",
  states: {
    // A Gate: the run waits here until jr2 send, the Console or a webhook sends approve or reject.
    review: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({ meta: { order: context.order, amount: context.amount } }),
      },
      on: {
        // An Emit tells the people who watch the run what happened. Nothing in the Machine reads it.
        approve: { target: "approved", actions: emit({ type: "decided", approved: true }) },
        reject: {
          target: "rejected",
          actions: [assign({ reason: ({ event }) => event.reason }), emit({ type: "decided", approved: false })],
        },
      },
    },
    approved: { type: "final" },
    // A person stopped the refund, and the run ends here. Not a final state: the run ends `failed`,
    // with the person's reason.
    rejected: { invoke: { src: "fail", input: ({ context }) => ({ reason: context.reason! }) } },
  },
});
