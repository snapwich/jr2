import { assign } from "xstate";
import { z } from "zod";
import { agent, answer, defineEvent, jr2Setup } from "@jr2/orchestrator";

// The writer's picks. Each one is a tool on the writer's Menu.
const ask = defineEvent({
  name: "ask",
  description: "Ask the editor one question. The editor's reply is the answer to this call.",
  input: z.object({ question: z.string().describe("One question for the editor.") }),
});
const done = defineEvent({
  name: "done",
  description: "Call this once, with the finished release notes. Then stop.",
  input: z.object({ notes: z.string().describe("The release notes, in Markdown.") }),
});

// The editor's reply. The editor sends it to a Gate, so it is not on the writer's Menu.
const reply = defineEvent({
  name: "reply",
  description: "Answer the writer's question.",
  input: z.object({ text: z.string().describe("The answer, in prose.") }),
});

const door = z.object({ changes: z.string().describe("The changes in this release, one on each line.") });

type Input = z.infer<typeof door>;
type Ctx = Input & { question?: string; replies: number; notes?: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input; output: { notes: string } },
  events: [ask, done, reply],
  actors: {
    writer: agent({
      model: "local/qwen3.6-35b-a3b",
      instructions: "You write short release notes. Ask the editor at least one question before you finish.",
      workspace: "none",
    }),
  },
}).createMachine({
  id: "notes",
  input: door,
  context: ({ input }) => ({ changes: input.changes, replies: 0 }),
  initial: "writing",
  states: {
    // The writer's state. Its Turn lasts until `done` leaves it.
    writing: {
      invoke: {
        src: "writer",
        input: ({ context }) => ({ prompt: `Write the release notes for these changes:\n${context.changes}` }),
      },
      on: {
        // The guard keeps `done` out of the Allowed picks until the editor has replied once.
        done: {
          guard: ({ context }) => context.replies > 0,
          target: "published",
          actions: assign({ notes: ({ event }) => event.notes }),
        },
      },
      initial: "drafting",
      states: {
        // A mode: it invokes nothing, so the writer is at Rest here and can pick `ask`.
        drafting: {
          on: { ask: { target: "asking", actions: assign({ question: ({ event }) => event.question }) } },
        },
        // While this Gate is open, the `ask` pick is outstanding and the writer can pick nothing.
        asking: {
          invoke: { src: "gate", input: ({ context }) => ({ meta: { question: context.question } }) },
          on: {
            reply: {
              target: "drafting",
              actions: [
                assign({ replies: ({ context }) => context.replies + 1 }),
                // The writer reads this text as the answer to its `ask`.
                answer(({ event }) => `The editor replied: ${event.text}`),
              ],
            },
          },
        },
      },
    },
    published: { type: "final" },
  },
  // The output of the run: the root `output`, not an `output` on the final state.
  output: ({ context }) => ({ notes: context.notes ?? "" }),
});
