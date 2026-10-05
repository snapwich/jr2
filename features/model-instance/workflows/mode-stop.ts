// The mode-stop claim (ADR-0016's ask-again rule): a model that stops while its Turn is still open
// and picks are still allowed is asked again — here by the nudge, which the Agent actor admits on
// the same conversation after the Submission settles, with a fresh Turn part stating the Allowed
// picks last. A correct Agent then picks.
//
// The stop is the setup. `ask_review` takes the Turn into `reviewing` and leaves it open (its
// receipt says so, and lists `revise` and `submit`); the prompt says to wait for the reviewer after
// asking, which a model may do — and then nothing else will ever answer it, because no reviewer
// exists: only the nudge can move the run. A trial whose model picks straight through never
// stopped, so it says nothing about the rule (`void`). The tier reads the printed conversation
// (ADR-0023): the nudge prints as its own prompt, and the first Menu call after it is the
// measurement.
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
        drafting: { on: { ask_review: "reviewing" } },
        reviewing: { on: { revise: "drafting", submit: "#mode-stop.submitted" } },
      },
    },
    submitted: { type: "final", output: { outcome: "submitted" } },
    faulted: { type: "final", output: ({ context }) => ({ outcome: "faulted", reason: context.fault }) },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
