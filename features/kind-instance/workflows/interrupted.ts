// The kind tier's ABORT workflow (ADR-0024): the state that asked for a Turn exits for a cause that
// is not the Agent's pick, while the model is still writing its answer. `coding` invokes the coder
// and the `interrupt` Gate. The scripted model holds the Turn's request (ADR-0038) and is never
// released; the scenario answers the Gate with `halt` once the request is held, so an outside event
// leaves the state, at the moment the scenario chooses. The Harness then hears of the exit only
// through the Orchestrator's abort: no pick answered, so the Harness's own end of a Turn (a pick's
// answer that ended it, ADR-0024) cannot be the cause. `handoff` shows the other cause — the Agent's
// own pick.
//
// `parked` is not final, so the Sandbox survives and a scenario can read the Harness's settlement.
// One Agent, one conversation (`continue`, ADR-0057): the steps read it at
// `/agents/coder/<runId>/body/coder`, as `handoff`'s do.

import { z } from "zod";
import { agent, defineEvent, jr2Setup, sentBy, workspace } from "@jr2/orchestrator";
import { coder } from "./_agents.ts";

const finish = defineEvent({ name: "finish", input: z.object({ summary: z.string() }) });
const halt = defineEvent({ name: "halt", input: z.object({}) });

type Ws = { repos: Record<"app", string>; branch: string };
type BodyInput = { workspace: Ws };

const body = jr2Setup({
  types: {} as { context: BodyInput; input: BodyInput },
  events: [finish, halt],
  actors: { coder: agent(coder) },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  initial: "coding",
  states: {
    coding: {
      invoke: [
        { src: "coder", input: () => ({ prompt: "implement the thing", continue: true }) },
        { src: "gate", id: "interrupt" },
      ],
      on: {
        // The Agent may pick `finish`; the scenario never lets it. The Gate's `halt` leaves first,
        // and only the Gate's: the Agent's `halt` is declined (ADR-0015).
        finish: { target: "parked", guard: sentBy("coder") },
        halt: { target: "parked", guard: sentBy("interrupt") },
      },
    },
    parked: {},
  },
});

export const machine = workspace(body, {
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
  spec: () => ({ branch: "feat-e2e-interrupted" }),
});
