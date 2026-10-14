import { z } from "zod";
import { agent, bearer, defineEvent, fromPick, http, jr2Setup, secret } from "@jr2/orchestrator";

const postComment = defineEvent({
  name: "post_comment",
  description: "Post one comment on the ticket.",
  input: z.object({ body: z.string() }),
});

// The host is fixed here. No input can change it.
const comment = http({
  method: "POST",
  url: "https://jira.example.com/rest/api/2/issue",
  auth: bearer(secret("jira")),
  input: z.object({ ticket: z.string(), body: z.string() }),
  request: ({ ticket, body }) => ({ path: [ticket, "comment"], json: { body } }),
});

export const machine = jr2Setup({
  types: {} as { context: { ticket: string }; input: { ticket: string } },
  events: [postComment],
  actors: {
    triager: agent({
      model: "anthropic/claude-sonnet-5-5",
      instructions: "You triage tickets.",
      workspace: "none",
    }),
    comment,
  },
}).createMachine({
  id: "comment",
  input: z.object({ ticket: z.string() }),
  context: ({ input }) => input,
  initial: "triaging",
  states: {
    triaging: {
      invoke: {
        src: "triager",
        input: ({ context }) => ({ prompt: `Write one comment for ticket ${context.ticket}.` }),
      },
      initial: "ready",
      states: {
        ready: { on: { post_comment: "posting" } },
        posting: {
          invoke: {
            src: "comment",
            // The Agent gives `body`. The Machine gives `ticket`.
            input: fromPick(postComment, ({ context }) => ({ ticket: context.ticket })),
            onDone: "#done",
          },
        },
      },
    },
    done: { id: "done", type: "final" },
  },
});
