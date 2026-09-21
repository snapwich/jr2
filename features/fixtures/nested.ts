// An e2e fixture for composition (ADR-0049), with NO cluster: ONE Machine, imported once and
// customized twice, invoked as two children of a third — the ADR's `deep`/`quick`. Filename
// `nested.ts` → workflow "nested".
//
// What it proves that a unit test cannot: the retuned definitions travel the whole path. They ride
// the Machine, are read off the LIVE actor's logic at invoke time, and land on the wire as the
// `definition` of each admission — two personas under one slot key, in one run, told apart by
// nothing but which Machine invoked them. A flat Instance roster could not have held them.
//
// The two children run in PARALLEL and park: an admitted Turn against this tier's stub Harness
// never settles (the stub is inert), so both admissions exist at once and the scenario reads them
// off the stub. Nothing here needs driving — the point is what was admitted, not what came back.

import { agent, customize, jr2Setup, type AgentTurnInput, type AgentTurnPlacement } from "@jr2/orchestrator";

/** The Machine a package would export: one Agent slot, one state, everything else carried. The
 * stub never runs a model, but a slot IS its definition, so the stock one is stated. */
const research = jr2Setup({
  types: {} as { context: { endpoint: string }; input: { endpoint: string } },
  events: [],
  actors: { coder: agent({ model: "stub/base", instructions: "You are the coder." }) },
}).createMachine({
  id: "research",
  context: ({ input }) => ({ endpoint: input.endpoint }),
  initial: "working",
  states: {
    working: {
      invoke: {
        src: "coder",
        // The endpoint arrives in run input and is threaded down: this tier is workspace-less, so
        // there is no enclosing `workspace()` for the Agent to resolve one from (ADR-0016). It is
        // MECHANISM, not a Turn's input — `AgentTurnPlacement`, the seat this tier sits in
        // (ADR-0057) — and a real run states none of it.
        input: ({ context }): AgentTurnInput & AgentTurnPlacement => ({
          prompt: "Do the work.",
          endpoint: context.endpoint,
        }),
      },
    },
  },
});

// Two retunes of that ONE object, differing only in the model — the composer's act, one level's
// reach, xstate's own `provide` underneath. Neither touches `research`, which is why both can
// exist in the same run.
const deep = customize(research, { agents: { coder: { model: "stub/deep" } } });
const quick = customize(research, { agents: { coder: { model: "stub/quick" } } });

export const machine = jr2Setup({
  types: {} as { context: { endpoint: string }; input: { endpoint: string } },
  events: [],
  actors: { deep, quick },
}).createMachine({
  id: "nested",
  context: ({ input }) => ({ endpoint: input.endpoint }),
  // Parallel, so both conversations are live at once: each child is its own Machine instance, so
  // the id jr2 mints carries its own actor path (`<runId>/deep/coder…`, `<runId>/quick/coder…` —
  // ADR-0016/0057) and the two `coder`s never collide on one address.
  type: "parallel",
  states: {
    deep: { invoke: { id: "deep", src: "deep", input: ({ context }) => ({ endpoint: context.endpoint }) } },
    quick: { invoke: { id: "quick", src: "quick", input: ({ context }) => ({ endpoint: context.endpoint }) } },
  },
});
