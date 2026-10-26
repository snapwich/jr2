// The mode-stop claim (ADR-0016's ask-again rule): a model that stops while its Turn is still open
// is asked again once a pick is allowed — the nudge's text, on the same conversation, with a fresh
// Turn part stating the Allowed picks last. A correct Agent then picks one of them.
//
// The stop is the setup, and it must happen reliably. `ask_review` takes the Turn into `reviewing`,
// where a reviewer (a child Machine) reads the notes and answers. The pick is outstanding while the
// reviewer reads, and its answer is the reviewer's output (ADR-0024), so the model reads the answer
// that the prompt tells it to wait for. `reviewing`'s picks (`revise`, `submit`) are still closed
// when that answer comes, so the answer allows nothing, and a model that follows the Briefing ("If
// nothing is allowed, stop") stops. A timer then opens them, and the wake asks the stopped model
// (ADR-0016). The timer has NO target: it only assigns `open`, and the picks' guards read it. A
// timer that moved the workflow to another state inside the Agent's state would hold Rest
// (ADR-0024): `ask_review` would be outstanding until it fired and its answer would carry the
// Allowed picks on the same call, so no model would stop. The reviewer holds Rest only while it
// reads, which ends long before the timer fires. A model still working when the timer fires hears
// the change at a step boundary instead and is never asked, so its trial says nothing about the rule
// (`void`). The tier reads the printed conversation (ADR-0023): the ask prints as its own prompt,
// and the first Menu call after it is the measurement. The step reads the modes from this file: the
// states that the reviewer's hold adds (`reading`, `answered`) are below `reviewing`, so they are no
// mode.
//
// Filename `mode-stop.ts` → workflow "mode-stop".

import { z } from "zod";
import { assign, createMachine } from "xstate";
import { agent, defineEvent, fail, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
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

/** The reviewer: it reads the notes for a moment, then answers. Its output is `ask_review`'s answer. */
const reviewer = createMachine({
  initial: "reading",
  states: { reading: { after: { 2000: "done" } }, done: { type: "final" } },
  output: () => ({ verdict: "approved", comments: "Clear and accurate." }),
});

const door = z.object({
  thinking: z.enum(["off", "on"]).default("off"),
  marker: z.string(),
});

type Input = z.infer<typeof door> & HostInjectedInput;
/** `open`: `reviewing`'s timer has fired, so its picks are open (see the header). */
type Ctx = Input & { open: boolean; fault?: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [askReview, revise, submit],
  actors: { advisor: agent(advisor), reviewer, fail: fail() },
}).createMachine({
  id: "mode-stop",
  input: door,
  context: ({ input }) => ({ ...input, open: false }),
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
          entry: assign({ open: false }),
          // Nothing to pick, long enough that a model reads the reviewer's answer and stops first. No
          // target: the picks open where they are, and Rest is not held.
          after: { 30_000: { actions: assign({ open: true }) } },
          on: {
            revise: { guard: ({ context }) => context.open, target: "drafting" },
            submit: { guard: ({ context }) => context.open, target: "#mode-stop.submitted" },
          },
          // The reviewer reads: `ask_review` is outstanding until it answers (ADR-0024).
          initial: "reading",
          states: {
            reading: { invoke: { src: "reviewer", onDone: "answered" } },
            answered: {},
          },
        },
      },
    },
    submitted: { type: "final", output: { outcome: "submitted" } },
    faulted: {
      invoke: {
        src: "fail",
        input: ({ context }) => ({
          reason: "the Agent's Turn could not go on",
          detail: { outcome: "faulted", reason: context.fault },
        }),
      },
    },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
