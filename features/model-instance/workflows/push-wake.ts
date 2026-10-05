// The push-wake claim (ADR-0029's step-boundary check, ADR-0016's ask-again rule): a Menu-only
// Turn starts with NOTHING allowed — its picks wait on a release board, a Gate on the state above.
// The Agent writes, with no pick to make. When the board's answer lands while the model is still
// writing, the Harness's read at that step's boundary finds the Allowed picks changed and restates
// the Turn part, which keeps the Submission going; a correct Agent then picks inside the SAME
// Submission, with no nudge.
//
// The step answers the Gate as soon as the Turn's prompt prints. A trial whose model finished
// writing first ended its Submission with nothing allowed — nothing restates an empty list to a
// model that stopped — and is asked again by a nudge once the answer opens a pick (ADR-0016): a
// second Submission, so that trial never reached the moment the claim measures (`void`).
//
// Filename `push-wake.ts` → workflow "push-wake".

import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
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
  actors: { advisor: agent(advisor) },
}).createMachine({
  id: "push-wake",
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
                `[${context.marker}] v2.3 is waiting on the release board. While it waits, write a risk ` +
                `assessment of about 200 words for these changes:\n\n` +
                `- The cache moves from disk to memory.\n` +
                `- The config loader rejects unknown keys.\n` +
                `- The HTTP client retries idempotent requests twice.\n\n` +
                `Release or hold v2.3 once the workflow allows it.`,
              continue: true,
              ...dialFor(context.thinking as ThinkingCell),
            }),
          },
          on: {
            release: { guard: ({ context }) => context.cleared, target: "#push-wake.released" },
            hold: { guard: ({ context }) => context.cleared, target: "#push-wake.held" },
            "agent.fault": {
              target: "#push-wake.faulted",
              actions: assign({ fault: ({ event }) => (event as { reason?: string }).reason }),
            },
          },
        },
      },
    },
    released: { type: "final", output: { outcome: "released" } },
    held: { type: "final", output: { outcome: "held" } },
    faulted: { type: "final", output: ({ context }) => ({ outcome: "faulted", reason: context.fault }) },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
