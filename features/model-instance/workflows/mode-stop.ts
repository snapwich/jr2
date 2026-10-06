// The mode-stop claim (ADR-0016's ask-again rule): a model that stops while its Turn is still open
// is asked again once a pick is allowed — the nudge's text, on the same conversation, with a fresh
// Turn part stating the Allowed picks last. A correct Agent then picks one of them.
//
// The stop is the setup, and it must happen reliably. `ask_review` takes the Turn into `waiting`,
// a mode with nothing to pick while the reviewer reads, so a model that follows the Briefing ("If
// nothing is allowed, stop") and the prompt ("wait for the reviewer's answer") stops. A timer then
// moves the Turn into `reviewing` (`revise`, `submit`), and the wake asks the stopped model
// (ADR-0016). A model still working when the timer fires hears the change at a step boundary
// instead and is never asked, so its trial says nothing about the rule (`void`). The tier reads
// the printed conversation (ADR-0023): the ask prints as its own prompt, and the first Menu call
// after it is the measurement. The step reads the modes from this file.
//
// Filename `mode-stop.ts` → workflow "mode-stop".

import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
import { advisor } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

const askReview = defineEvent({
  name: "ask_review",
  description: "Ask a reviewer to read the release notes.",
  input: z.object({ notes: z.string() }),
});
const revise = defineEvent({
  name: "revise",
  description: "Take the release notes back to drafting.",
  input: z.object({ why: z.string() }),
});
const submit = defineEvent({
  name: "submit",
  description: "Submit the release notes for publication.",
  input: z.object({ notes: z.string() }),
});

const door = z.object({
  thinking: z.enum(["off", "on"]).default("off"),
  marker: z.string(),
});

type Input = z.infer<typeof door> & HostInjectedInput;
type Ctx = Input & { fault?: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [askReview, revise, submit],
  actors: { advisor: agent(advisor) },
}).createMachine({
  id: "mode-stop",
  input: door,
  context: ({ input }) => input,
  initial: "notes",
  states: {
    notes: {
      invoke: {
        src: "advisor",
        input: ({ context }) => ({
          prompt:
            `[${context.marker}] The release notes for v2.3 are drafted:\n\n` +
            `- Faster cold start (about 30% on the reference box).\n` +
            `- The config loader reports the file and line of a syntax error.\n` +
            `- Fixed: a crash when the cache directory is read-only.\n\n` +
            `Ask for a review, then wait for the reviewer's answer.`,
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
      initial: "drafting",
      states: {
        drafting: { on: { ask_review: "waiting" } },
        // The reviewer reads: nothing to pick. Long enough that a model stops first.
        waiting: { after: { 30_000: "reviewing" } },
        reviewing: { on: { revise: "drafting", submit: "#mode-stop.submitted" } },
      },
    },
    submitted: { type: "final", output: { outcome: "submitted" } },
    faulted: { type: "final", output: ({ context }) => ({ outcome: "faulted", reason: context.fault }) },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
