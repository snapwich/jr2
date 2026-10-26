// The push-follow and push-no-refusal claims (ADR-0029's step-boundary check): a coder works with
// its Working tools, picking nothing, while SOMETHING ELSE moves its Turn to another mode — here a
// Gate the coder's own state also invokes, answered by the step while the coder's command runs (on
// the same state, so the answer moves the mode and never re-enters the state: a Gate on a parent
// whose transition targeted the mode would exit the Agent's state and end the Turn). At the next step
// boundary the Harness finds the Allowed picks changed and restates the Turn part. A correct Agent
// then picks from the new list:
//
//   - push-follow: the first pick the Machine takes after the Gate's answer is a reviewing pick;
//   - push-no-refusal: no Menu call between the Gate's answer and that pick was a stale one — the
//     restatement spared the refusal round trip a stale list costs.
//
// The command is GIVEN and slow (`sleep 20`), so the step can land the Gate's answer while it runs.
// The ledger (`picks`) records every pick the Machine took and the moment of the answer, so the
// step can tell a trial whose Agent picked before the answer (`void`: it never reached the moment
// the claim measures).
//
// Filename `push-follow.ts` → workflow "push-follow".

import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  defineEvent,
  fail,
  jr2Setup,
  workspace,
  type HostInjectedInput,
  type Workspaced,
} from "@jr2/orchestrator";
import { coder } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

/** The ledger's mark for the Gate's answer: not a pick, so it cannot collide with one. */
export const APPROVED = "(approved)";

const askApproval = defineEvent({
  name: "ask_approval",
  description: "Ask the team to approve the work so far.",
  input: z.object({ summary: z.string() }),
});
const runTests = defineEvent({
  name: "run_tests",
  description: "Record that you ran the project's tests, and what they said.",
  input: z.object({ result: z.string() }),
});
const revise = defineEvent({
  name: "revise",
  description: "Go back to coding after the approval.",
  input: z.object({ why: z.string() }),
});
const submit = defineEvent({
  name: "submit",
  description: "Submit the approved work.",
  input: z.object({ summary: z.string() }),
});
/** The team's approval — the Gate's caller's alone. */
const approve = defineEvent({ name: "approve", audience: "external", input: z.object({}) });

const door = z.object({ thinking: z.enum(["off", "on"]).default("off"), marker: z.string() });

type BodyInput = Workspaced<z.infer<typeof door> & HostInjectedInput, "app">;
type BodyContext = BodyInput & { picks: string[]; fault?: string };

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput },
  events: [askApproval, runTests, revise, submit, approve],
  actors: { coder: agent(coder), fail: fail() },
}).createMachine({
  id: "body",
  context: ({ input }) => ({ ...input, picks: [] }),
  initial: "work",
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    work: {
      invoke: [
        {
          src: "coder",
          input: ({ context }) => ({
            prompt:
              `[${context.marker}] Run exactly \`sleep 20 && ls\` in your working directory and read ` +
              `what it lists. Then call the workflow tool that fits.`,
            cwd: context.workspace.repos.app,
            continue: true,
            ...dialFor(context.thinking as ThinkingCell),
          }),
        },
        // The team's desk: open for as long as the coder works.
        { src: "gate", id: "desk" },
      ],
      on: {
        approve: { target: ".reviewing", actions: assign({ picks: ({ context }) => [...context.picks, APPROVED] }) },
        "agent.fault": { target: "faulted", actions: assign({ fault: ({ event }) => event.reason }) },
      },
      initial: "coding",
      states: {
        coding: {
          on: {
            ask_approval: {
              target: "coding",
              actions: assign({ picks: ({ context }) => [...context.picks, "ask_approval"] }),
            },
            run_tests: {
              target: "coding",
              actions: assign({ picks: ({ context }) => [...context.picks, "run_tests"] }),
            },
          },
        },
        reviewing: {
          on: {
            revise: { target: "coding", actions: assign({ picks: ({ context }) => [...context.picks, "revise"] }) },
            submit: {
              target: "#body.submitted",
              actions: assign({ picks: ({ context }) => [...context.picks, "submit"] }),
            },
          },
        },
      },
    },
    submitted: { type: "final", output: ({ context }) => ({ outcome: "submitted", picks: context.picks }) },
    lost: {
      invoke: {
        src: "fail",
        input: ({ context }) => ({ reason: "the Sandbox was lost", detail: { outcome: "lost", picks: context.picks } }),
      },
    },
    faulted: {
      invoke: {
        src: "fail",
        input: ({ context }) => ({
          reason: "the Agent's Turn could not go on",
          detail: { outcome: "faulted", picks: context.picks, reason: context.fault },
        }),
      },
    },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});

export const machine = workspace(body, {
  input: door,
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
  spec: () => ({ branch: "model-push" }),
});
