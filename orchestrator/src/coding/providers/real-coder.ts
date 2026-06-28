// REAL coder/reviewer agent provider — fills the `coder` (and, where the control
// plane supports its menu, `reviewer`) slot with the FROZEN duplex Actor
// (`agentRunActor`, ADR-0002) driving a real Agent on a real Harness.
//
// The slot takes a SEMANTIC `AgentTurnInput`; `agentRunActor` takes the infra
// `AgentRunInput` (control plane, harness base, agent name). This adapter is a
// thin xstate machine that:
//   • invokes the UNCHANGED `agentRunActor`, mapping turn input → run input,
//   • forwards the Actor's up-events to the Workspace (`sendParent`),
//   • forwards the Workspace's down-events (APPROVE/DENY/STEER/CANCEL) to the Actor.
// So `actor.ts` / `control-plane.ts` stay frozen — this only composes them.

import { setup, sendTo, sendParent } from "xstate";
import { agentRunActor, type AgentRunInput } from "../../actor.ts";
import type { ControlPlane } from "../../control-plane.ts";
import type { AgentTurnInput, AgentRole } from "../slots.ts";

export interface RealAgentInfra {
  controlPlane: ControlPlane;
  harnessBase: string;
  /** Resolve the flue Agent name for a role (e.g. coder → "coder"). */
  agentNameFor: (role: AgentRole) => string;
}

export function makeRealAgent(infra: RealAgentInfra) {
  return setup({
    types: { context: {} as AgentTurnInput, input: {} as AgentTurnInput },
    actors: { run: agentRunActor },
  }).createMachine({
    id: "realAgent",
    context: ({ input }) => input,
    invoke: {
      id: "run",
      src: "run",
      input: ({ context }): AgentRunInput => ({
        controlPlane: infra.controlPlane,
        harnessBase: infra.harnessBase,
        agentName: infra.agentNameFor(context.role),
        instanceId: context.instanceId,
        prompt: context.prompt,
      }),
    },
    on: {
      // Down-channel: route solicited/interrupt events to the real Actor.
      APPROVE: { actions: sendTo("run", ({ event }) => event) },
      DENY: { actions: sendTo("run", ({ event }) => event) },
      STEER: { actions: sendTo("run", ({ event }) => event) },
      CANCEL: { actions: sendTo("run", ({ event }) => event) },
      // Up-channel: forward everything else (agent.* + actor.*) to the Workspace.
      "*": { actions: sendParent(({ event }) => event) },
    },
  });
}
