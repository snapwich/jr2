// The Menu-only claim (ADR-0031/0062): a `workspace: "none"` Agent's Turn lands on the Instance
// Harness with no Working tools, and the Briefing's standing part says so. The prompt holds every
// fact the answer needs, so a correct Agent's FIRST call is its pick — not a `read`, not a `bash`,
// not a tool it invented (ADR-0029 saw one). The tier reads the first call off the Instance
// Harness's printed conversation (ADR-0023), found by the marker the prompt repeats.
//
// Filename `advised.ts` → workflow "advised".

import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
import { advisor } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

const answer = defineEvent({
  name: "answer",
  description: "Your advice to the team.",
  input: z.object({ advice: z.string() }),
});

const door = z.object({
  thinking: z.enum(["off", "on"]).default("off"),
  marker: z.string(),
});

type Input = z.infer<typeof door> & HostInjectedInput;
type Ctx = Input & { advice?: string; fault?: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [answer],
  actors: { advisor: agent(advisor) },
}).createMachine({
  id: "advised",
  input: door,
  context: ({ input }) => input,
  initial: "advising",
  states: {
    advising: {
      invoke: {
        src: "advisor",
        input: ({ context }) => ({
          prompt:
            `[${context.marker}] The team's build has failed three times today with the same error: ` +
            `"ENOSPC: no space left on device" on the CI runner, in the step that installs dependencies. ` +
            `The runner is shared, its disk is 40 GB, and nobody has cleaned it in months. What should ` +
            `the team do next? Answer with \`answer\`.`,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: {
        answer: { target: "answered", actions: assign({ advice: ({ event }) => event.advice }) },
        "agent.fault": {
          target: "faulted",
          actions: assign({ fault: ({ event }) => (event as { reason?: string }).reason }),
        },
      },
    },
    answered: { type: "final", output: ({ context }) => ({ outcome: "answered", advice: context.advice }) },
    faulted: { type: "final", output: ({ context }) => ({ outcome: "faulted", reason: context.fault }) },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
