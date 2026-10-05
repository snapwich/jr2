// The mode-refusal claim (ADR-0029): a pick on the Menu that the workflow's current state does not
// allow is delivered and answered with the CORRECTION RECEIPT — "`<pick>` is not allowed in the
// workflow's current state, whatever its arguments … Allowed now: …" — and a correct Agent's next
// call is an allowed pick, not the same pick again.
//
// The refusal is made to happen, not hoped for: a model obeys a list it read last (ADR-0062), so a
// prompt that argued for a wrong pick would rarely get one. Instead the Machine moves under the
// Agent. `ask_review` takes the Turn into `reviewing`, whose receipt says `revise` and `submit` are
// allowed; a timer then moves it on to `approved`, where only `publish` is — the shape of a Gate
// answered while the Agent composed its next call. The timer is short enough to land before any
// model has composed that call, and long enough to land after the step-boundary read that follows
// the receipt (which would otherwise restate the list and spare the refusal). So the Agent's next
// pick, from the list it just read, is refused, and the call after that is the measurement.
//
// Filename `mode-refusal.ts` → workflow "mode-refusal".

import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
import { advisor } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

/** How long `reviewing` holds before it moves on, in ms — see the header. */
export const REVIEW_WINDOW_MS = 400;

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
  description: "Submit the reviewed release notes for approval.",
  input: z.object({ notes: z.string() }),
});
const publish = defineEvent({
  name: "publish",
  description: "Publish the approved release notes.",
  input: z.object({ notes: z.string() }),
});

const door = z.object({
  thinking: z.enum(["off", "on"]).default("off"),
  marker: z.string(),
});

type Input = z.infer<typeof door> & HostInjectedInput;
/** `picks`: every pick the Machine TOOK, in order — a refused pick never reaches it. */
type Ctx = Input & { picks: string[]; fault?: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [askReview, revise, submit, publish],
  actors: { advisor: agent(advisor) },
}).createMachine({
  id: "mode-refusal",
  input: door,
  context: ({ input }) => ({ ...input, picks: [] }),
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
            `Take them through review and get them published.`,
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
        drafting: {
          on: {
            ask_review: {
              target: "reviewing",
              actions: assign({ picks: ({ context }) => [...context.picks, "ask_review"] }),
            },
          },
        },
        reviewing: {
          after: { [REVIEW_WINDOW_MS]: "approved" },
          on: {
            revise: { target: "drafting", actions: assign({ picks: ({ context }) => [...context.picks, "revise"] }) },
            submit: { target: "approved", actions: assign({ picks: ({ context }) => [...context.picks, "submit"] }) },
          },
        },
        approved: {
          on: {
            publish: {
              target: "#mode-refusal.published",
              actions: assign({ picks: ({ context }) => [...context.picks, "publish"] }),
            },
          },
        },
      },
    },
    published: { type: "final", output: ({ context }) => ({ outcome: "published", picks: context.picks }) },
    faulted: {
      type: "final",
      output: ({ context }) => ({ outcome: "faulted", picks: context.picks, reason: context.fault }),
    },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
