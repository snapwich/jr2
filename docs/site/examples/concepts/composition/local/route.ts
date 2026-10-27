import { z } from "zod";
import { agent, customize, defineEvent, fail, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
import { task } from "@jr2/machines";

const model = "local/qwen3.6-35b-a3b";

// Bind the two Open parts of `task`: the Repo that the coder works in, and the coder's model.
const coding = customize(task, {
  repos: { target: { url: "https://github.com/you/app.git" } },
  agents: { coder: { model } },
});

// Two changed copies of one Machine. `coding` does not change.
const deep = customize(coding, { agents: { coder: { thinkingLevel: "high" } } });
const quick = customize(coding, { agents: { coder: { thinkingLevel: "low" } } });

const door = z.object({ prompt: z.string().describe("What to do, in prose.") });

const route = defineEvent({
  name: "route",
  description: "Say how much care the task needs.",
  audience: "agent",
  input: z.object({
    size: z.enum(["small", "large"]).describe("small: a change to one file. large: any other change."),
  }),
});

type Input = HostInjectedInput & z.infer<typeof door>;

export const machine = jr2Setup({
  types: {} as { input: Input; context: Input },
  events: [route],
  actors: {
    triager: agent({
      model,
      workspace: "none",
      thinkingLevel: "off",
      instructions: "Read the task. Call route once: small for a change to one file, large for any other change.",
    }),
    // Each composed Machine is a slot, like an Agent.
    deep,
    quick,
    fail: fail(),
  },
}).createMachine({
  id: "route",
  input: door,
  context: ({ input }) => input,
  on: { "agent.fault": ".failed" },
  initial: "triaging",
  states: {
    triaging: {
      invoke: { src: "triager", input: ({ context }) => ({ prompt: context.prompt }) },
      on: {
        route: [{ guard: ({ event }) => event.size === "large", target: "deep" }, { target: "quick" }],
      },
    },
    // A composed `task` gets its input from this Machine, so it needs a branch.
    deep: {
      invoke: {
        src: "deep",
        input: ({ context }) => ({ prompt: context.prompt, branch: `jr2/route-${context.instanceId}` }),
        onDone: "done",
      },
    },
    quick: {
      invoke: {
        src: "quick",
        input: ({ context }) => ({ prompt: context.prompt, branch: `jr2/route-${context.instanceId}` }),
        onDone: "done",
      },
    },
    done: { type: "final" },
    failed: { invoke: { src: "fail", input: { reason: "the Agent's Turn could not go on" } } },
  },
});
