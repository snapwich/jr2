import { assign } from "xstate";
import { z } from "zod";
import { agent, defineEvent, jr2Setup, steer } from "@jr2/orchestrator";

// The writer's pick: the draft is ready for review.
const done = defineEvent({
  name: "done",
  description: "The draft is ready. Give the whole draft.",
  input: z.object({ draft: z.string().min(1) }),
});
// The reviewer's two picks.
const note = defineEvent({
  name: "note",
  description: "Send the draft back to the writer, with what to change.",
  input: z.object({ text: z.string().min(1) }),
});
const approve = defineEvent({
  name: "approve",
  description: "The draft is good.",
  input: z.object({}),
});

type Context = { version: string; draft?: string };

export const machine = jr2Setup({
  types: {} as { input: { version: string }; context: Context },
  events: [done, note, approve],
  actors: {
    writer: agent({
      model: "anthropic/claude-haiku-5-5",
      instructions: "You write short release notes.",
      workspace: "none",
    }),
    // A Caller cannot steer the reviewer. The Machine can.
    reviewer: agent({
      model: "anthropic/claude-haiku-5-5",
      instructions: "You review release notes for clear and correct words.",
      workspace: "none",
      steerable: false,
    }),
  },
}).createMachine({
  id: "notes",
  input: z.object({ version: z.string() }),
  context: ({ input }) => ({ version: input.version }),
  initial: "writing",
  states: {
    writing: {
      invoke: {
        src: "writer",
        // The writer continues its conversation, so it keeps its draft from Turn to Turn.
        input: ({ context }) => ({ prompt: `Write the release notes for ${context.version}.`, continue: true }),
      },
      on: { done: { target: "reviewing", actions: assign({ draft: ({ event }) => event.draft }) } },
    },
    reviewing: {
      invoke: {
        src: "reviewer",
        input: ({ context }) => ({ prompt: `Review these release notes:\n\n${context.draft ?? ""}` }),
      },
      on: {
        // The reviewer's note goes to the writer's next Turn as a Steering message. `from` names the
        // reviewer, so the writer reads it as information from a peer, not as an instruction.
        note: {
          target: "writing",
          actions: steer("writer", ({ event }) => event.text, { from: ({ event }) => event.sender }),
        },
        approve: "published",
      },
    },
    published: { type: "final" },
  },
});
