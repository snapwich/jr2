import { assign, fromPromise } from "xstate";
import { z } from "zod";
import { defineEvent, jr2Setup, pool, source } from "@jr2/orchestrator";

type Ticket = { id: string; title: string; needs: string[] };

// A small backlog with dependencies. T-3 can start only when T-1 and T-2 are done.
// T-4 needs a ticket that does not exist, so it never becomes ready.
const backlog: Ticket[] = [
  { id: "T-1", title: "Trim the name.", needs: [] },
  { id: "T-2", title: "Add a --version flag.", needs: [] },
  { id: "T-3", title: "Document the two changes.", needs: ["T-1", "T-2"] },
  { id: "T-4", title: "Remove the old flag.", needs: ["T-9"] },
];

// The ids that the Pool claimed. This set is in memory, so it serves one run.
// A real Work Source asks the issue tracker instead.
const claimed = new Set<string>();

// The Source: give the next ready ticket, or say how many tickets are not ready.
const tickets = source<Ticket>({
  next: fromPromise(async ({ input }: { input: { active: string[] } }) => {
    const done = (id: string) => claimed.has(id) && !input.active.includes(id);
    const waiting = backlog.filter((t) => !claimed.has(t.id));
    const ready = waiting.find((t) => t.needs.every(done));
    if (!ready) return { item: null, open: waiting.length };
    claimed.add(ready.id);
    return { item: ready, open: waiting.length - 1 };
  }),
  // Send this event to the Pool's `source` Gate when the backlog changes.
  wake: defineEvent({
    name: "tickets_changed",
    description: "The backlog changed. Look for ready tickets again.",
    audience: "external",
    input: z.object({}),
  }),
});

const approve = defineEvent({
  name: "approve",
  description: "Accept the ticket.",
  audience: "external",
  input: z.object({}),
});

const reject = defineEvent({
  name: "reject",
  description: "Refuse the ticket.",
  audience: "external",
  input: z.object({ reason: z.string().describe("Why, in one sentence.") }),
});

type Outcome = { id: string; outcome: "approved" } | { id: string; outcome: "rejected"; reason: string };

// The worker: one Machine for each ticket. Here a person decides at a Gate.
// A worker is usually a Machine with an Agent, such as `task`.
const review = jr2Setup({
  types: {} as { input: Ticket; context: Ticket & { outcome?: Outcome }; output: Outcome },
  events: [approve, reject],
}).createMachine({
  id: "review",
  context: ({ input }) => input,
  initial: "review",
  states: {
    review: {
      invoke: { src: "gate", input: ({ context }) => ({ meta: { title: context.title } }) },
      on: {
        approve: {
          target: "decided",
          actions: assign({ outcome: ({ context }) => ({ id: context.id, outcome: "approved" as const }) }),
        },
        reject: {
          target: "decided",
          actions: assign({
            outcome: ({ context, event }) => ({ id: context.id, outcome: "rejected" as const, reason: event.reason }),
          }),
        },
      },
    },
    decided: { type: "final" },
  },
  output: ({ context }) => context.outcome!,
});

// The Pool: one `review` for each ready ticket, two at most at once.
export const machine = pool(review, {
  id: "tickets",
  source: tickets,
  itemId: (ticket: Ticket) => ticket.id,
  cap: 2,
});
