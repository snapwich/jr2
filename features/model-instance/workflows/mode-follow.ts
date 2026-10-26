// The mode-follow claim (ADR-0015/0029): one Menu-only Turn walks two modes, and a correct Agent
// obeys the NEWEST "Allowed now" it read, not the Briefing's. The Agent's state has two child
// states. In `drafting` the Turn may pick `ask_review` or `add_note`; `ask_review` moves to
// `reviewing`, where it may pick `revise` or `submit`. The Briefing's Turn part states the
// drafting list; `ask_review`'s receipt states the reviewing one. The Menu — all four — never
// changes. What the tier reads is the first Menu call AFTER `ask_review`, off the Instance
// Harness's printed conversation (ADR-0023): a stale Agent calls a drafting pick again.
//
// The prompt asks for a review and a submission and names no tool: a prompt that named the next
// pick would measure the prompt.
//
// Filename `mode-follow.ts` → workflow "mode-follow".

import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, fail, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
import { advisor } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

const askReview = defineEvent({
  name: "ask_review",
  description: "Ask a reviewer to read the release notes.",
  input: z.object({ notes: z.string() }),
});
const addNote = defineEvent({
  name: "add_note",
  description: "Add one line to the release notes before review.",
  input: z.object({ line: z.string() }),
});
const revise = defineEvent({
  name: "revise",
  description: "Take the release notes back to drafting.",
  input: z.object({ why: z.string() }),
});
const submit = defineEvent({
  name: "submit",
  description: "Submit the reviewed release notes for publication.",
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
  events: [askReview, addNote, revise, submit],
  actors: { advisor: agent(advisor), fail: fail() },
}).createMachine({
  id: "mode-follow",
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
            `They are complete. Get them reviewed, then submit them for publication.`,
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
        drafting: { on: { ask_review: "reviewing", add_note: "drafting" } },
        reviewing: { on: { revise: "drafting", submit: "#mode-follow.submitted" } },
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
