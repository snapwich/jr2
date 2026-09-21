// The kind tier's TWO-TURN workflow (ADR-0024): one conversation, two states, and a park that
// deliberately keeps the Sandbox. Where `sandboxed.ts` proves the wrapper's contract with the
// cluster, this one proves what happens to the AGENT when a state stops waiting for it.
//
// Three properties, none of which `sandboxed` can show:
//   - the coder's turn ENDS when `coding` is left — the pod's Harness records that submission as
//     `aborted`, which is the only place a turn's end is observable from outside;
//   - the next turn on the SAME instance id (what `continue: true` derives — ADR-0057) is
//     admitted AFTER that abort, so it is not swallowed by it — the Harness queues per
//     conversation in admission order (ADR-0027);
//   - `parked` is not final, so the Workspace survives the whole thing. That is the dangerous
//     shape: an orphaned Agent would still be live in a worktree the Machine believes is idle.
//
// Both states say `continue`, which is exactly the claim: one Agent has ONE conversation per
// Machine instance, whichever state asks for a Turn (ADR-0057). jr2 mints its id structurally —
// `<runId>/<machine actor path>/<agent>`, and this body is the `workspace()` wrapper's `body`
// invoke — so the steps read the pod's Harness at `/agents/coder/<runId>/body/coder`.

import { z } from "zod";
import { agent, defineEvent, jr2Setup, workspace } from "@jr2/orchestrator";
import { coder } from "./_agents.ts";

const finish = defineEvent({ name: "finish", input: z.object({ summary: z.string() }) });
const ship = defineEvent({ name: "ship", input: z.object({ summary: z.string() }) });

type Ws = { repos: Record<"app", string>; branch: string };
type BodyInput = { workspace: Ws };

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
        // that is still thinking. A Turn's input is its Frame, its Dials and whether it
        // continues (ADR-0057) — and nothing else here. No Menu:
        // it derives from this state's `finish` (ADR-0015). No `cwd`: one Repo Slot means there is
        // nothing to privilege, so the actor frames `app`'s Worktree itself.
        input: () => ({
          prompt: "implement the thing",
          continue: true,
        }),
      },
      on: { finish: { target: "shipping" } },
    },
    shipping: {
      invoke: {
        src: "coder",
        input: () => ({
          prompt: "now ship it",
          // The SAME conversation as `coding`'s — two states of one Machine, one Agent, one
          // conversation (ADR-0057). Their Menus differ; the transcript does not.
          continue: true,
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
