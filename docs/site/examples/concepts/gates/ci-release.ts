import { assign } from "xstate";
import { z } from "zod";
import { defineEvent, jr2Setup } from "@jr2/orchestrator";

// The events that a CI job sends to the `checks` Gate.
const ciPassed = defineEvent({
  name: "ci_passed",
  description: "The CI job for this version passed.",
  input: z.object({ url: z.string().describe("The URL of the CI job.") }),
});
const ciFailed = defineEvent({
  name: "ci_failed",
  description: "The CI job for this version failed.",
  input: z.object({ url: z.string().describe("The URL of the CI job.") }),
});

// The events that a person sends to the `review` Gate.
const approve = defineEvent({
  name: "approve",
  description: "Release this version.",
  input: z.object({}),
});
const reject = defineEvent({
  name: "reject",
  description: "Do not release this version.",
  input: z.object({ reason: z.string().describe("Why, in one sentence.") }),
});

const door = z.object({ version: z.string().describe("The version to release, such as 1.4.0.") });

type Input = z.infer<typeof door>;
type Ctx = Input & { ci?: string; reason?: string };
type Output =
  | { outcome: "released"; version: string }
  | { outcome: "failed"; ci: string }
  | { outcome: "rejected"; reason: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input; output: Output },
  events: [ciPassed, ciFailed, approve, reject],
}).createMachine({
  id: "ci-release",
  input: door,
  context: ({ input }) => ({ version: input.version }),
  initial: "checks",
  states: {
    // A CI job answers this Gate. The Gate's id is "checks", the key of its state.
    checks: {
      invoke: { src: "gate", input: ({ context }) => ({ meta: { version: context.version } }) },
      on: {
        ci_passed: { target: "review", actions: assign({ ci: ({ event }) => event.url }) },
        ci_failed: { target: "failed", actions: assign({ ci: ({ event }) => event.url }) },
      },
    },
    // A person answers this Gate, from the CLI or the Console. The meta tells them what to check.
    review: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({ meta: { version: context.version, ci: context.ci } }),
      },
      on: {
        approve: "released",
        reject: { target: "rejected", actions: assign({ reason: ({ event }) => event.reason }) },
      },
    },
    released: { type: "final", output: ({ context }): Output => ({ outcome: "released", version: context.version }) },
    failed: { type: "final", output: ({ context }): Output => ({ outcome: "failed", ci: context.ci ?? "" }) },
    rejected: {
      type: "final",
      output: ({ context }): Output => ({ outcome: "rejected", reason: context.reason ?? "" }),
    },
  },
});
