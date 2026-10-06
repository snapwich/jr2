// The refused-outstanding claim (ADR-0024): while a pick is outstanding every other pick is
// refused, and the refusal says the first is still running — "Wait for its answer, then pick
// again." A correct Agent, once the answer comes, picks again from the Allowed picks it carries.
//
// `book_room` enters `booking`, a child Machine below the Agent's state that takes a few seconds,
// then routes back to `ready`, where `send_invite` is allowed. The prompt asks for both, now. A
// model that emits both calls in one message has the second refused before it leaves (the
// Harness's claim, in message order); the refused pick never reaches the Machine. The measurement
// is the call after the refused one, once `book_room`'s answer came: `send_invite`, taken. A model
// that called them one after the other was never refused, and the trial is void — the setup is a
// parallel call, which a model makes or does not.
//
// Filename `refused-outstanding.ts` → workflow "refused-outstanding".

import { z } from "zod";
import { assign, createMachine } from "xstate";
import { agent, defineEvent, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
import { advisor } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

const bookRoom = defineEvent({
  name: "book_room",
  description: "Book the meeting room. The booking's result is this call's answer.",
  input: z.object({ room: z.string() }),
});
const sendInvite = defineEvent({
  name: "send_invite",
  description: "Send the meeting invitation for a booked room.",
  input: z.object({ room: z.string(), attendees: z.array(z.string()) }),
});

const booking = createMachine({
  initial: "asking",
  states: { asking: { after: { 4000: "booked" } }, booked: { type: "final" } },
  output: () => ({ booked: true, room: "Juniper", from: "14:00", to: "15:00" }),
});

const door = z.object({ thinking: z.enum(["off", "on"]).default("off"), marker: z.string() });

type Input = z.infer<typeof door> & HostInjectedInput;
/** `picks`: every pick the Machine took, in order — a refused pick never reaches it. */
type Ctx = Input & { picks: string[]; fault?: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [bookRoom, sendInvite],
  actors: { advisor: agent(advisor), booking },
}).createMachine({
  id: "refused-outstanding",
  input: door,
  context: ({ input }) => ({ ...input, picks: [] }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        src: "advisor",
        input: ({ context }) => ({
          prompt:
            `[${context.marker}] Set up tomorrow's design review with Ana, Bo and Chen: book the Juniper ` +
            `room with \`book_room\` and send the invitation with \`send_invite\`. Do both now.`,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: {
        "agent.fault": {
          target: "faulted",
          actions: assign({ fault: ({ event }) => (event as { reason?: string }).reason }),
        },
      },
      initial: "ready",
      states: {
        ready: {
          on: {
            book_room: {
              target: "booking",
              actions: assign({ picks: ({ context }) => [...context.picks, "book_room"] }),
            },
          },
        },
        booking: { invoke: { src: "booking", onDone: "booked" } },
        booked: {
          on: {
            send_invite: {
              target: "#refused-outstanding.invited",
              actions: assign({ picks: ({ context }) => [...context.picks, "send_invite"] }),
            },
          },
        },
      },
    },
    invited: { type: "final", output: ({ context }) => ({ outcome: "invited", picks: context.picks }) },
    faulted: {
      type: "final",
      output: ({ context }) => ({ outcome: "faulted", picks: context.picks, reason: context.fault }),
    },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
