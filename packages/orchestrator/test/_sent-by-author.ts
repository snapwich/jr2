// Two Machines as an author writes them with `sentBy` (ADR-0015), type-checked by this package's
// `tsc` with no cast: `sentBy` alone on a writing, `sentBy` inside `and([...])` beside the author's
// own named guard, and `event.sender` read in an action.

import { z } from "zod";
import { and, assign } from "xstate";
import { defineEvent } from "@jr2/agent-protocol";
import { agent } from "../src/harness-client.ts";
import { sentBy } from "../src/party.ts";
import { jr2Setup } from "../src/setup.ts";

const approve = defineEvent({
  name: "approve",
  description: "Approve the work.",
  input: z.object({ note: z.string().optional() }),
});
const cancel = defineEvent({ name: "cancel", description: "Stop this work.", input: z.object({}) });
const coder = agent({ model: "test/model", instructions: "You are the coder." });

/** A Gate above, the same name below: the Gate's writing on `release`, the Agent's on its mode
 * `draft`. The deeper writing declines other senders, so the reviewer's `approve` runs `release`'s. */
export const release = jr2Setup({
  types: {} as { context: { note?: string; by?: string } },
  events: [approve],
  actors: { coder },
  guards: { ready: ({ context }) => context.note === undefined },
}).createMachine({
  id: "release",
  context: {},
  initial: "release",
  states: {
    release: {
      invoke: { src: "gate", id: "review" },
      on: {
        approve: {
          target: "shipped",
          actions: assign({ note: ({ event }) => event.note, by: ({ event }) => event.sender?.id }),
        },
      },
      initial: "work",
      states: {
        work: {
          invoke: { src: "coder", input: { prompt: "Do the work, then approve." } },
          initial: "draft",
          states: {
            draft: { on: { approve: { target: "#release.selfApproved", guard: and([sentBy("coder"), "ready"]) } } },
          },
        },
      },
    },
    shipped: { type: "final" },
    selfApproved: { type: "final" },
  },
});

/** The root-writing shape: the root's `cancel` is both parties'; the Agent's mode writes its own,
 * declining others, so the reviewer's `cancel` runs the root's. */
export const rooted = jr2Setup({ events: [cancel, approve], actors: { coder } }).createMachine({
  id: "rooted",
  on: { cancel: ".cancelled" },
  initial: "release",
  states: {
    release: {
      invoke: { src: "gate", id: "review" },
      on: { approve: "shipped" },
      initial: "work",
      states: {
        work: {
          invoke: { src: "coder", input: { prompt: "Do the work." } },
          initial: "draft",
          states: { draft: { on: { cancel: { target: "#rooted.discarded", guard: sentBy("coder") } } } },
        },
      },
    },
    shipped: { type: "final" },
    cancelled: { type: "final" },
    discarded: { type: "final" },
  },
});
