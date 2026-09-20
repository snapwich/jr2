// The kind tier's MENU-ONLY workflow (ADR-0031): no `workspace()` at all — one state, one Agent
// whose definition declares `workspace: "none"`. What it proves is the convention: because a
// registered Machine carries such a definition, `jr2 up` converged an Instance Harness, and the
// Turn is admitted THERE, with no Sandbox provisioned for the run. The pod runs the stock Harness
// under `JR2_MENU_ONLY`, so the placement is enforced by the pod itself, not merely chosen.
//
// The instance id is the RUN's (the host's injection, ADR-0016) — what `jr2 status` reports and
// what the kind steps read the Instance Harness's history under.

import { z } from "zod";
import { agent, defineEvent, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
import { advisor } from "./_agents.ts";

const advise = defineEvent({ name: "advise", input: z.object({ summary: z.string() }) });

export const machine = jr2Setup({
  types: {} as { context: HostInjectedInput; input: HostInjectedInput },
  events: [advise],
  // The Agent rides the Machine (ADR-0049): the slot key is its name on the Harness wire.
  actors: { advisor: agent(advisor) },
}).createMachine({
  id: "advised",
  context: ({ input }) => input,
  initial: "advising",
  states: {
    advising: {
      invoke: {
        src: "advisor",
        // No endpoint, no sandbox, and no enclosing workspace(): the DEFINITION places the Turn
        // (ADR-0031) — on the Instance Harness, whose address a deployed Orchestrator derives
        // from its namespace.
        input: ({ context }) => ({
          instanceId: context.instanceId,
          tools: [advise.name],
          prompt: "what should the team do next?",
        }),
      },
      on: { advise: { target: "advised" } },
    },
    advised: { type: "final", output: { outcome: "advised" } },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
