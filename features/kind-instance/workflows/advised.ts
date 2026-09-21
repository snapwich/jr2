// The kind tier's MENU-ONLY workflow (ADR-0031): no `workspace()` at all — one state, one Agent
// whose definition declares `workspace: "none"`. What it proves is the convention: because a
// registered Machine carries such a definition, `jr2 up` converged an Instance Harness, and the
// Turn is admitted THERE, with no Sandbox provisioned for the run. The pod runs the stock Harness
// under `JR2_MENU_ONLY`, so the placement is enforced by the pod itself, not merely chosen.
//
// The Turn says `continue`, so its conversation is addressable from outside: jr2 mints the
// structural id `<runId>/<machine actor path>/<agent>` (ADR-0057), and the kind steps read the
// Instance Harness's history under exactly that.

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
        // from its namespace. No Menu either: it derives from the `advise` below (ADR-0015), and
        // no `cwd`: a Menu-only Agent has no Working tools to root (ADR-0028/0057).
        input: () => ({
          prompt: "what should the team do next?",
          continue: true,
        }),
      },
      on: { advise: { target: "advised" } },
    },
    advised: { type: "final", output: { outcome: "advised" } },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
