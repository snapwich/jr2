// A fixture instance workflow for the bootstrap suite. A `workflows/<name>.ts` file exports its
// assembled Machine + events manifest by name (ADR-0011). It is fully self-contained: it declares
// its own `agentRun` actor (a noop stand-in here — a real workflow imports `agentRun` from
// `@j2/orchestrator`; the host injects nothing). Filename `echo.ts` → workflow name "echo".
// Minimal: invoke the agent, finish on `done`.

import { setup, fromCallback } from "xstate";
import { z } from "zod";
import { defineEvent, type EventFrom } from "@j2/agent-protocol";
import type { AgentRunInput, AgentRunReceiveEvent } from "../../../../src/actor.ts";

const done = defineEvent({ name: "done", input: z.object({ summary: z.string().optional() }) });

export const events = [done];

type Ctx = { instanceId: string };

export const machine = setup({
  types: {} as { context: Ctx; input: { instanceId: string }; events: EventFrom<typeof done> },
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
