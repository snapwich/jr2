// The `gate` actor (ADR-0011): a pending external input on a run, as an addressable resource.
// The symmetric twin of `agentRun` for every NON-agent caller — humans (`j2 send`, a UI),
// webhook translators, CI. "Human" is policy, not mechanism, so the actor is not named for one
// caller.
//
// A state that needs outside input invokes `gate` with `{ gate?, accepts?, meta? }`. On start
// the actor resolves the accepted names against ITS OWN workflow's vocabulary (per-workflow
// scoping) and registers into the host's table; `GET /runs/:id` then lists the gate (accepts +
// schemas + meta — what a CLI, an inbox UI, or a webhook translator discovers), and
// `POST /runs/:id/gates/:gate/events` validates against the named schema and delivers through
// the closure below — the event lands on the state that invoked the gate, at any nesting depth.
// Leaving the state stops the actor, which destroys the gate: parking IS retention (ADR-0012),
// and a gone state is a gone surface.

import { fromCallback } from "xstate";
import { actorPath, gateAddress, resolveAccepts, runBindingOf, type DeliveredEvent } from "./registration.ts";

export type GateInput = {
  /**
   * The gate's caller-facing id. LEAVE IT UNSET for the derived default: the actor path below
   * the run root (in a j2Setup machine the leaf is the state key path — `deriveMenus` names the
   * invoke), which is unique wherever concurrently live siblings have distinct actor ids — i.e.
   * wherever fan-out is correct at all. Author an id only to give external callers a meaningful
   * flat name (e.g. the feature id); then run-wide uniqueness is the author's problem, and two
   * LIVE gates with one id fail loudly at invoke. Run-scoped by the host either way — two runs'
   * `"F-12"` gates cannot collide.
   */
  gate?: string;
  /**
   * Accepted event names. In a j2Setup machine LEAVE IT UNSET: the accepted set derives from
   * the invoking state's transitions, audience ∈ {external, any} (ADR-0015) — this field is the
   * escape hatch. An unlisted name is an invoke-time error either way.
   */
  accepts?: readonly string[];
  /** Serializable context for callers: what a UI renders, what a webhook matches on (prUrl…). */
  meta?: Record<string, unknown>;
};

/** The gate actor. Sends nothing of its own; every event it delivers is a caller's, validated.
 * Input admits `undefined` so `invoke: { src: "gate" }` — the fully-derived common case —
 * typechecks without an input mapper. */
export const gate = fromCallback<DeliveredEvent, GateInput | undefined>(({ input: raw, system, sendBack, self }) => {
  const input = raw ?? {};
  const binding = runBindingOf(system);
  // The derived id is deterministic from machine structure, so recomputing it on every (re)start
  // is restore-stable and needs no input-mapper persistence — the mapper is only load-bearing
  // where minting has a random component (mintIid's fresh-session suffix, ADR-0016).
  const path = actorPath(self);
  const id = input.gate ?? path.join(".");
  if (!id) {
    // Only a rootless invocation (createActor(gate) directly) has an empty path.
    throw new Error("gate has no derivable id (no parent actor) — pass `gate` explicitly");
  }
  if (!input.accepts?.length) {
    // Derivation found nothing (or a plain-setup machine passed nothing): a gate accepting no
    // events can never be moved — refuse loudly at invoke rather than park a dead surface.
    throw new Error(
      `gate "${id}" accepts no events — handle at least one external/any event on the ` +
        `invoking state (the accepted set derives from its transitions), or pass \`accepts\` explicitly`,
    );
  }
  const defs = resolveAccepts(binding, input.accepts);
  const dispose = binding.table.register({
    address: gateAddress(binding.runId, id),
    runId: binding.runId,
    kind: "gate",
    id,
    path,
    defs,
    meta: input.meta,
    deliver: (event) => sendBack(event),
  });
  return dispose;
});
