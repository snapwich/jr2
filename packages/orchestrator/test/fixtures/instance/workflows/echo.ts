// A fixture instance workflow for the bootstrap suite. A `workflows/<name>.ts` file exports its
// assembled Machine by name (`export const machine` — ADR-0011/0015; the vocabulary rides the
// machine via jr2Setup). It is fully self-contained: the host injects nothing. Filename `echo.ts` →
// workflow name "echo". Minimal: invoke the agent, finish on `done`.
//
// The `coder` slot holds a NOOP rather than `agent(def)` (ADR-0049): this suite starts a real run
// off a discovered folder, and a real Agent slot would dial a Harness that does not exist. An
// unbranded logic is not an Agent slot, so the menu walk leaves its input alone and the invoke
// states the finalized shape itself — the same path a plain `setup()` machine takes.

import { fromCallback } from "xstate";
import { z } from "zod";
import { defineEvent } from "@jr2/agent-protocol";
import { jr2Setup } from "../../../../src/setup.ts";
import type { AgentRunInput, AgentRunReceiveEvent } from "../../../../src/actor.ts";

const done = defineEvent({ name: "done", input: z.object({ summary: z.string().optional() }) });

type Ctx = { instanceId: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: { instanceId: string } },
  events: [done],
  actors: { coder: fromCallback<AgentRunReceiveEvent, AgentRunInput>(() => {}) },
}).createMachine({
  id: "echo",
  context: ({ input }) => ({ instanceId: input.instanceId }),
  initial: "active",
  states: {
    active: {
      invoke: {
        id: "coder",
        src: "coder",
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
