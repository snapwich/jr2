// A fixture instance workflow for the bootstrap suite. A `workflows/<name>.ts` file exports its
// assembled Machine by name (`export const machine` — ADR-0011/0015; the vocabulary rides the
// machine via j2Setup). It is fully self-contained: it overrides `agentRun` with a noop stand-in
// (a real workflow uses the pre-registered one; the host injects nothing). Filename `echo.ts` →
// workflow name "echo". Minimal: invoke the agent, finish on `done`.

import { fromCallback } from "xstate";
import { z } from "zod";
import { defineEvent } from "@j2/agent-protocol";
import { j2Setup } from "../../../../src/setup.ts";
import type { AgentRunInput, AgentRunReceiveEvent } from "../../../../src/actor.ts";

const done = defineEvent({ name: "done", input: z.object({ summary: z.string().optional() }) });

type Ctx = { instanceId: string };

export const machine = j2Setup({
  types: {} as { context: Ctx; input: { instanceId: string } },
  events: [done],
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
          endpoint: "http://harness.invalid", // the noop actor above never dials it
          prompt: "echo",
          tools: [done.name],
        }),
      },
      on: { done: "done" },
    },
    done: { type: "final" },
  },
});
