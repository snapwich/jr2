// The `gate` actor (ADR-0011): a pending external input on a run, as an addressable resource.
// The symmetric twin of `agentRun` for every NON-agent caller — humans (`j2 send`, a UI),
// webhook translators, CI. "Human" is policy, not mechanism, so the actor is not named for one
// caller.
//
// A state that needs outside input invokes `gate` with `{ gate, accepts, meta? }`. On start the
// actor resolves the accepted names against ITS OWN workflow's vocabulary (per-workflow scoping)
// and registers into the host's table; `GET /runs/:id` then lists the gate (accepts + schemas +
// meta — what a CLI, an inbox UI, or a webhook translator discovers), and
// `POST /runs/:id/gates/:gate/events` validates against the named schema and delivers through
// the closure below — the event lands on the state that invoked the gate, at any nesting depth.
// Leaving the state stops the actor, which destroys the gate: parking IS retention (ADR-0012),
// and a gone state is a gone surface.

import { fromCallback } from "xstate";
import { gateAddress, resolveAccepts, runBindingOf, type DeliveredEvent } from "./registration.ts";

export type GateInput = {
  /** The gate's id, workflow-derived (e.g. the feature id). Run-scoped by the host — two runs'
   * `"F-12"` gates cannot collide; two LIVE gates with one id in the same run are an authored
   * bug and fail loudly at invoke. */
  gate: string;
  /** Names from this workflow's `events` manifest; an unlisted name is an invoke-time error. */
  accepts: readonly string[];
  /** Serializable context for callers: what a UI renders, what a webhook matches on (prUrl…). */
  meta?: Record<string, unknown>;
};

/** The gate actor. Sends nothing of its own; every event it delivers is a caller's, validated. */
export const gate = fromCallback<DeliveredEvent, GateInput>(({ input, system, sendBack }) => {
  const binding = runBindingOf(system);
  const defs = resolveAccepts(binding, input.accepts);
  const dispose = binding.table.register({
    address: gateAddress(binding.runId, input.gate),
    runId: binding.runId,
    kind: "gate",
    id: input.gate,
    defs,
    meta: input.meta,
    deliver: (event) => sendBack(event),
  });
  return dispose;
});
