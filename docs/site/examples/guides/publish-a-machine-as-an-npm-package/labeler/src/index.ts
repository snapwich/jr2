import { assign } from "xstate";
import { z } from "zod";
import { agent, defineEvent, jr2Setup, open } from "@jr2/orchestrator";

// The Agent's one pick.
const label = defineEvent({
  name: "label",
  description: "Give the issue one label. Call this once, then stop.",
  audience: "agent",
  input: z.object({
    kind: z
      .enum(["bug", "feature", "question"])
      .describe(
        "bug: something does not work. feature: a request. question: the author asks for help or for information.",
      ),
    reason: z.string().describe("Why, in one sentence."),
  }),
});

const door = z.object({
  title: z.string().describe("The title of the issue."),
  body: z.string().describe("The text of the issue."),
});

type Input = z.infer<typeof door>;
export type LabelerOutput = { kind: "bug" | "feature" | "question"; reason: string } | { kind: "none"; reason: string };

/**
 * A Machine that gives an issue one label.
 *
 * Open part: `agents.labeler.model`. Bind it with `customize()` where you register the Machine.
 *
 * Run input: `{ title, body }`, the title and the text of the issue.
 *
 * Output: `{ kind, reason }`. `kind` is `bug`, `feature` or `question`, or `none` when the Turn of
 * the Agent fails.
 */
export const labeler = jr2Setup({
  types: {} as { input: Input; context: Input & { result?: LabelerOutput }; output: LabelerOutput },
  events: [label],
  actors: {
    labeler: agent({
      // Open: the Instance that registers this Machine binds the model with customize().
      model: open,
      workspace: "none",
      instructions: "You read one issue and give it one label. Call label once.",
    }),
  },
}).createMachine({
  id: "labeler",
  input: door,
  context: ({ input }) => input,
  initial: "labeling",
  states: {
    labeling: {
      invoke: {
        src: "labeler",
        input: ({ context }) => ({ prompt: `Title: ${context.title}\n\n${context.body}` }),
      },
      on: {
        label: {
          target: "done",
          actions: assign({ result: ({ event }) => ({ kind: event.kind, reason: event.reason }) }),
        },
        // jr2 sends this when the Agent's Turn fails for good.
        "agent.fault": {
          target: "done",
          actions: assign({ result: ({ event }) => ({ kind: "none" as const, reason: event.reason }) }),
        },
      },
    },
    done: { type: "final" },
  },
  output: ({ context }) => context.result!,
});
