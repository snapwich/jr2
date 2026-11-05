import { z } from "zod";
import { defineEvent, fail, gate, jr2Setup } from "@jr2/orchestrator";
import type {} from "../hooks/stripe.ts";

const paid = defineEvent({
  name: "paid",
  description: "The customer paid the invoice.",
  input: z.object({}),
});

// #region payment
// The Gate hears the stripe kind. A payment of another invoice is not for this Gate.
const payment = gate({
  meta: z.object({ invoice: z.string() }),
  delivers: [paid],
  hooks: {
    stripe: {
      "invoice.paid": ({ payload, meta }) => (payload.data.object.id === meta.invoice ? { type: "paid" } : undefined),
    },
  },
});
// #endregion payment

export const machine = jr2Setup({
  types: {} as { input: { invoice: string }; context: { invoice: string } },
  events: [paid],
  actors: { payment, fail: fail() },
}).createMachine({
  id: "dunning",
  input: z.object({ invoice: z.string() }),
  context: ({ input }) => ({ invoice: input.invoice }),
  initial: "waiting",
  states: {
    waiting: {
      invoke: { src: "payment", input: ({ context }) => ({ meta: { invoice: context.invoice } }) },
      on: { paid: "paid" },
      // After seven days with no payment, the run stops waiting. A lost delivery cannot stop the
      // run for longer than that.
      after: { 604800000: "unpaid" },
    },
    paid: { type: "final" },
    // Not a final state: the run ends `failed`, with the reason.
    unpaid: { invoke: { src: "fail", input: () => ({ reason: "the invoice is not paid after seven days" }) } },
  },
});
