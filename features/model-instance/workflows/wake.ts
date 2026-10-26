// The wake claim (ADR-0016's ask-again rule, ADR-0062's standing Briefing): a Menu-only Turn starts
// with NOTHING allowed — its picks wait on a release board, a Gate on the state above. The standing
// Briefing tells a model with nothing allowed to stop, and the workflow to prompt it again when
// something is. The prompt says nothing of either. A correct Agent stops; the step answers the board
// once the Turn's Submission has settled; jr2 then wakes the model once, with the nudge's text and a
// Turn part that states the Allowed picks last; and the first Menu call after the wake is one of
// them.
//
// A model that did not stop — still working, or calling picks that are refused — never reached the
// moment the claim measures (`void`). The prompt is fixed data: it is not tuned to make a model
// stop or pick.
//
// Filename `wake.ts` → workflow "wake".

import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, fail, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
import { advisor } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

const release = defineEvent({
  name: "release",
  description: "Release v2.3 now.",
  input: z.object({ reason: z.string() }),
});
const hold = defineEvent({
  name: "hold",
  description: "Hold v2.3 and say why.",
  input: z.object({ reason: z.string() }),
});
/** The release board's answer — the Gate's caller's alone. */
const cleared = defineEvent({ name: "cleared", audience: "external", input: z.object({}) });

const door = z.object({
  thinking: z.enum(["off", "on"]).default("off"),
  marker: z.string(),
});

type Input = z.infer<typeof door> & HostInjectedInput;
type Ctx = Input & { cleared: boolean; fault?: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [release, hold, cleared],
  actors: { advisor: agent(advisor), fail: fail() },
}).createMachine({
  id: "wake",
  input: door,
  context: ({ input }) => ({ ...input, cleared: false }),
  initial: "board",
  states: {
    board: {
      // The release board: open for the whole Turn. Its answer changes context, not state — the
      // Agent's picks below are guarded on it, so their Allowed picks go from none to both.
      invoke: { src: "gate", id: "board" },
      on: { cleared: { actions: assign({ cleared: true }) } },
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            src: "advisor",
            input: ({ context }) => ({
              prompt:
                `[${context.marker}] v2.3 is waiting on the release board. Its changes:\n\n` +
                `- The cache moves from disk to memory.\n` +
                `- The config loader rejects unknown keys.\n` +
                `- The HTTP client retries idempotent requests twice.\n\n` +
                `Release or hold v2.3.`,
              continue: true,
              ...dialFor(context.thinking as ThinkingCell),
            }),
          },
          on: {
            release: { guard: ({ context }) => context.cleared, target: "#wake.released" },
            hold: { guard: ({ context }) => context.cleared, target: "#wake.held" },
            "agent.fault": {
              target: "#wake.faulted",
              actions: assign({ fault: ({ event }) => (event as { reason?: string }).reason }),
            },
          },
        },
      },
    },
    released: { type: "final", output: { outcome: "released" } },
    held: { type: "final", output: { outcome: "held" } },
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
