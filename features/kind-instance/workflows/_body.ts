// The body the tier's one-turn workflows share (`sandboxed`, `perrun`): deliberately thin — what
// the tier proves is the WRAPPER's contract with the cluster (provision → attach → run → destroy)
// plus its durability claims (re-attach on restore; `workspace.lost` when the Sandbox was reaped
// while the orchestrator was down), and the body's only job is to make each outcome readable.
//
// The agent's instance id is the RUN's instanceId — the same iid `jr2 status` reports — so the
// mechanics-tier steps (which play the agent over `/mcp/<iid>`) drive every wrapper of it unchanged.
//
// The final states carry DISTINCT outputs, and the wrapper's root `output` forwards whichever
// settled the body: that is what lets a scenario assert which path was taken (finished vs lost)
// rather than infer it from the run merely being done.
//
// `_`-prefixed, so workflow discovery skips it: this module is imported, never registered.

import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, jr2Setup, type HostInjectedInput, type Workspaced } from "@jr2/orchestrator";
import { coder } from "./_agents.ts";

const finish = defineEvent({ name: "finish", input: z.object({ summary: z.string() }) });

/** What a ROOT-placed wrapper hands the body: the host's injection beside the door (the run's
 * `instanceId`), plus the handles keyed by the one Repo Slot every kind workflow declares, `app`. */
type BodyInput = Workspaced<HostInjectedInput, "app">;
/** Plus the one thing the body records without acting on it — see the `agent.fault` handler. */
type BodyContext = BodyInput & { fault?: string };

export const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput },
  events: [finish],
  // The Agent rides the Machine (ADR-0049): the slot key is its name on the Harness wire.
  actors: { coder: agent(coder) },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  initial: "coding",
  // The wrapper emits, the body decides (ADR-0012). Our Sandbox is gone: the pod-local clone and
  // any unpushed commits went with it, so settle as `lost` rather than pretend we can resume.
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    coding: {
      invoke: {
        src: "coder",
        // No endpoint, no sandbox: both resolve AMBIENTLY from the enclosing workspace()
        // (ADR-0016) — and the registration records that Sandbox as its ADR-0013 token scope,
        // so only this pod's Adapter can deliver into this turn. Unforgettable by construction.
        input: ({ context }) => ({
          instanceId: context.instanceId,
          tools: [finish.name],
          // A plain prompt. The pod runs the STOCK Harness (ADR-0038), so what parks the Machine
          // here is the scripted MODEL: it holds the turn's provider request until the scenario
          // releases it with a tool call — exactly what an Agent that is still thinking looks like.
          prompt: "implement the thing",
        }),
      },
      on: {
        finish: { target: "finished" },
        // ADR-0016's ONE terminal telemetry, ROUTED — because an ignored event is an invisible one.
        // A body with no `agent.fault` policy does not keep waiting for its Agent; it stops waiting
        // silently, `active` in `coding` forever, with the reason nowhere any observer can read
        // (`jr2 status` reports a child's state value, never its context). That is what made a lost
        // first turn look like a mysteriously slow one, and it cost this tier its parallel default.
        // Settling instead names the failure in the one place every scenario already reads.
        "agent.fault": {
          target: "faulted",
          actions: assign({ fault: ({ event }) => (event as { reason?: string }).reason }),
        },
      },
    },
    finished: { type: "final", output: { outcome: "finished" } },
    lost: { type: "final", output: { outcome: "lost" } },
    /** Carries the reason, not just the word: this is the only place a fault the Orchestrator
     * absorbed and gave up on becomes readable from outside the cluster. */
    faulted: { type: "final", output: ({ context }) => ({ outcome: "faulted", reason: context.fault }) },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
