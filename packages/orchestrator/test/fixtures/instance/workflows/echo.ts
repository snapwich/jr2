// A fixture instance workflow for the bootstrap suite. A `workflows/<name>.ts` file exports its
// assembled Machine by name (`export const machine` — ADR-0011), with an `agentRun` slot the
// instance host fills (here the dev stub). Filename `echo.ts` → workflow name "echo". Minimal:
// invoke the agent, finish on `done`. No `events` export: this fixture accepts no workflow events.

import { setup, fromCallback } from "xstate";
import { DEFAULT_CODER_MENU } from "@j2/agent-protocol";
import type { ControlEvent } from "@j2/agent-protocol";
import type { AgentRunInput, AgentRunReceiveEvent } from "../../../../src/actor.ts";

type Ctx = { instanceId: string };

export const machine = setup({
  types: {} as { context: Ctx; input: { instanceId: string }; events: ControlEvent },
  actors: { agentRun: fromCallback<AgentRunReceiveEvent, AgentRunInput>(() => {}) },
}).createMachine({
  id: "echo",
  context: ({ input }) => ({ instanceId: input.instanceId }),
  initial: "active",
  states: {
    active: {
      invoke: {
        id: "agentRun",
        src: "agentRun",
        input: ({ context }): AgentRunInput => ({
          agentName: "coder",
          instanceId: context.instanceId,
          prompt: "echo",
          menu: DEFAULT_CODER_MENU,
        }),
      },
      on: { "agent.done": "done" },
    },
    done: { type: "final" },
  },
});
