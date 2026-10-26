import { assign } from "xstate";
import { z } from "zod";
import { defineEvent, fail, jr2Setup } from "@jr2/orchestrator";

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
  input: z.object({ reason: z.string().min(1).describe("Why, in one sentence.") }),
});

const door = z.object({ version: z.string().describe("The version to release, such as 1.4.0.") });

type Input = z.infer<typeof door>;
type Ctx = Input & { ci?: string; reason?: string };
// The output of a run that ends `done`. A run whose CI job failed, or that a person rejected, has no
// output of this type: it ends `failed`, and its output is the reason and the detail of the Failure.
type Output = { version: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input; output: Output },
  events: [ciPassed, ciFailed, approve, reject],
  actors: { fail: fail() },
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
    released: { type: "final", output: ({ context }): Output => ({ version: context.version }) },
    // Not a final state: the run ends `failed`, and `jr2 run` exits 1.
    failed: {
      invoke: { src: "fail", input: ({ context }) => ({ reason: "the CI job failed", detail: { ci: context.ci } }) },
    },
    // A person stopped the release. The run ends `failed` too, with the person's reason.
    rejected: { invoke: { src: "fail", input: ({ context }) => ({ reason: context.reason! }) } },
  },
  // The output of the run. xstate reads only this root `output` as the output of the Machine. It
  // gets the output of the final state that ended the run as `event.output`.
  output: ({ event }) => event.output as Output,
});
