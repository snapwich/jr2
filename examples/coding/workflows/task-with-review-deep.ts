// The SAME workflow, retuned: `task-with-review`'s Machine, imported and handed to `customize()`
// with a frontier model behind both Agents (ADR-0049). Filename → workflow
// "task-with-review-deep", so `j2 run task-with-review-deep` addresses it and the Console lists it
// beside the original.
//
// This file is the whole composition surface. A Machine carries everything it depends on — its
// door, its vocabulary, its Agents, and what its Sandbox is made of — so importing it is
// importing all of that, and `customize()` is the one way to change any of it from outside. There
// is no config block to edit, no roster to point somewhere else, and nothing here restates the
// workflow's shape: the states, the round cap, the Gate and the run input are the original's,
// unchanged and untouched.
//
// What moves is the DEFINITIONS (ADR-0018's identity, retuned by the composer — not a Turn's
// dials): each override is layered over the stock definition, so `{ model }` alone keeps the
// instructions `_agents.ts` wrote and only the model changes. The original object is untouched:
// both workflows register, and a run of each carries the Agents it was given.
//
// The Machine's SHAPE is identical, deliberately (ADR-0030): a retune changes what an Agent does,
// never what the graph is, so the two workflows share a fingerprint and neither drifts the other's
// parked runs.
//
// The models here are Anthropic's, which is this instance's documented second provider
// (`j2.config.ts`): `j2 up` probes only the custom provider's own models, so registering this
// workflow costs a vLLM-only converge nothing — but a RUN of it needs the `anthropic` Secret in
// `harness.envFrom`. Point the two `model` fields at whatever your cluster can reach.

import { customize } from "@j2/orchestrator";
import { machine as taskWithReview } from "./task-with-review.ts";

const frontier = "anthropic/claude-sonnet-4-6";

export const machine = customize(taskWithReview, {
  agents: {
    // The slot keys are the body's, reached straight through the `workspace()` wrapper: j2's own
    // wrappers are transparent, so a composer never writes `body` and never has to know that this
    // workflow's root is one (ADR-0049). A key no Machine here carries is a compile error.
    coder: { model: frontier, thinkingLevel: "high" },
    reviewer: { model: frontier },
  },
});
