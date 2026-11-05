import { assign } from "xstate";
import { z } from "zod";
import { defineEvent, jr2Setup } from "@jr2/orchestrator";

// The two answers of the person on call.
const take = defineEvent({
  name: "take",
  description: "I take this alert.",
  input: z.object({ who: z.string().min(1) }),
});
const dismiss = defineEvent({
  name: "dismiss",
  description: "This alert needs no work. Say why.",
  input: z.object({ reason: z.string().min(1) }),
});

type Context = { issue: string; title: string; who?: string };

// One run for each alert. The run waits until a person takes the alert or dismisses it.
export const machine = jr2Setup({
  types: {} as { input: { issue: string; title: string }; context: Context },
  events: [take, dismiss],
}).createMachine({
  id: "triage",
  // The door: the alerts Pool sends this input for each alert.
  input: z.object({ issue: z.string(), title: z.string() }),
  context: ({ input }) => ({ issue: input.issue, title: input.title }),
  initial: "waiting",
  states: {
    waiting: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({ meta: { issue: context.issue, title: context.title } }),
      },
      on: {
        take: { target: "taken", actions: assign({ who: ({ event }) => event.who }) },
        dismiss: "dismissed",
      },
    },
    taken: { type: "final" },
    dismissed: { type: "final" },
  },
});
