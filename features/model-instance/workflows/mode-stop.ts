// The mode-stop claim (ADR-0016's ask-again rule): a model that stops while its Turn is still open
// is asked again once a pick is allowed — the nudge's text, on the same conversation, with a fresh
// Turn part stating the Allowed picks last. A correct Agent then picks one of them.
//
// The stop is the setup, and it must happen reliably. `ask_review` takes the Turn into `reviewing`,
// whose picks (`revise`, `submit`) are closed while the reviewer reads, so its answer allows
// nothing and a model that follows the Briefing ("If nothing is allowed, stop") and the prompt
// ("wait for the reviewer's answer") stops. A timer then opens them, and the wake asks the stopped
// model (ADR-0016). The timer has NO target: it only assigns the review read, and the picks' guards
// read it. A timer that moved the workflow to another state inside the Agent's state would hold
// Rest (ADR-0024): `ask_review` would be outstanding until it fired and its answer would carry the
// Allowed picks on the same call, so no model would stop. A model still working when the timer fires
// hears the change at a step boundary instead and is never asked, so its trial says nothing about
// the rule (`void`). The tier reads the printed conversation (ADR-0023): the ask prints as its own
// prompt, and the first Menu call after it is the measurement. The step reads the modes from this
// file.
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
/** `read`: the reviewer has read the notes, so `reviewing`'s picks are open (see the header). */
type Ctx = Input & { read: boolean; fault?: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [askReview, revise, submit],
  actors: { advisor: agent(advisor) },
}).createMachine({
  id: "mode-stop",
  input: door,
  context: ({ input }) => ({ ...input, read: false }),
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
        reviewing: {
          entry: assign({ read: false }),
          // The reviewer reads: nothing to pick, long enough that a model stops first. No target:
          // the picks open where they are, and Rest is not held.
          after: { 30_000: { actions: assign({ read: true }) } },
          on: {
            revise: { guard: ({ context }) => context.read, target: "drafting" },
            submit: { guard: ({ context }) => context.read, target: "#mode-stop.submitted" },
          },
        },
      },
    },
    submitted: { type: "final", output: { outcome: "submitted" } },
    faulted: { type: "final", output: ({ context }) => ({ outcome: "faulted", reason: context.fault }) },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
