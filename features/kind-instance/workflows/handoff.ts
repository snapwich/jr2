// The kind tier's TWO-TURN workflow (ADR-0024): one conversation, two states, and a park that
// deliberately keeps the Sandbox. Where `sandboxed.ts` proves the wrapper's contract with the
// cluster, this one proves what happens to the AGENT when a state stops waiting for it.
//
// Three properties, none of which `sandboxed` can show:
//   - the coder's turn ENDS when `coding` is left — the pod's Harness records that submission as
//     `aborted`, which is the only place a turn's end is observable from outside;
//   - the next turn on the SAME instance id (what `session: "continue"` derives) is admitted
//     AFTER that abort, so it is not swallowed by it — the Harness queues per conversation in
//     admission order (ADR-0027);
//   - `parked` is not final, so the Workspace survives the whole thing. That is the dangerous
//     shape: an orphaned Agent would still be live in a worktree the Machine believes is idle.
//
// The instance id is the RUN's instanceId (as in `sandboxed.ts`), so the same steps drive it.

import { z } from "zod";
import { agent, defineEvent, jr2Setup, workspace } from "@jr2/orchestrator";
import { coder } from "./_agents.ts";

const finish = defineEvent({ name: "finish", input: z.object({ summary: z.string() }) });
const ship = defineEvent({ name: "ship", input: z.object({ summary: z.string() }) });

type Ws = { repos: Record<"app", string>; branch: string };
type BodyInput = { instanceId: string; workspace: Ws };

const body = jr2Setup({
  types: {} as { context: BodyInput; input: BodyInput },
  events: [finish, ship],
  // The Agent rides the Machine (ADR-0049): the slot key is its name on the Harness wire.
  actors: { coder: agent(coder) },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  initial: "coding",
  states: {
    coding: {
      invoke: {
        src: "coder",
        // Plain prompts throughout: the pod's stock Harness parks on its scripted model until a
        // scenario releases it (ADR-0038), so the Machine waits exactly as it would on an Agent
        // that is still thinking.
        input: ({ context }) => ({
          instanceId: context.instanceId,
          tools: [finish.name],
          prompt: "implement the thing",
        }),
      },
      on: { finish: { target: "shipping" } },
    },
    shipping: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          instanceId: context.instanceId, // the SAME conversation — the continue case
          tools: [ship.name],
          prompt: "now ship it",
        }),
      },
      on: { ship: { target: "parked" } },
    },
    // Non-final on purpose: the run stays live and the Sandbox stays up, so a scenario can ask the
    // Harness what became of the turns it was asked for.
    parked: {},
  },
});

// The one Repo Slot, `app`, BOUND to the seed repository the suite serves in-cluster (ADR-0051):
// the url is the identity, so this literal is what the walk warms and what the cache clones.
export const machine = workspace(body, {
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
  spec: () => ({ branch: "feat-e2e" }),
});
