// The cut-pick claim (ADR-0031): a Harness restart while a pick is outstanding cuts the Turn and
// faults nothing. jr2 waits for Rest and re-admits the Agent on the same conversation: the cut call's
// history result says the pick reached the workflow, which does not run it twice, and that its
// result comes in the next message; the re-admission's notice carries the answer. A correct Agent
// does not call the cut pick again, and uses the answer.
//
// `run_audit` enters `auditing`, which invokes a Gate below the Agent's state. The STEP makes the
// cut — the restart is the tier's, not the model's: once the pick is outstanding it deletes the
// Instance Harness pod, waits for the new one, and only then answers the Gate with the findings.
// After the route back to `ready`, `file_report` is allowed and `run_audit` is not. The first Menu
// call after the re-admission prompt is the measurement: `file_report`. A model that had not made
// the pick when the step looked is void.
//
// Filename `cut-pick.ts` → workflow "cut-pick".

import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";
import { advisor } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

const runAudit = defineEvent({
  name: "run_audit",
  description: "Ask the auditor to audit last month's expenses. The audit's findings are this call's answer.",
  input: z.object({}),
});
const fileReport = defineEvent({
  name: "file_report",
  description: "File the audit report.",
  input: z.object({ summary: z.string() }),
});
/** The auditor's findings — the Gate's caller's alone. */
const audited = defineEvent({ name: "audited", input: z.object({ findings: z.string() }) });

const door = z.object({ thinking: z.enum(["off", "on"]).default("off"), marker: z.string() });

type Input = z.infer<typeof door> & HostInjectedInput;
/** `picks`: every pick the Machine took, in order. */
type Ctx = Input & { picks: string[]; fault?: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [runAudit, fileReport, audited],
  actors: { advisor: agent(advisor) },
}).createMachine({
  id: "cut-pick",
  input: door,
  context: ({ input }) => ({ ...input, picks: [] }),
  initial: "reporting",
  states: {
    reporting: {
      invoke: {
        src: "advisor",
        input: ({ context }) => ({
          prompt:
            `[${context.marker}] Get last month's expenses audited, then file the audit report with a ` +
            `one-paragraph summary of the findings.`,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: {
        "agent.fault": {
          target: "faulted",
          actions: assign({ fault: ({ event }) => (event as { reason?: string }).reason }),
        },
      },
      initial: "ready",
      states: {
        ready: {
          on: {
            run_audit: {
              target: "auditing",
              actions: assign({ picks: ({ context }) => [...context.picks, "run_audit"] }),
            },
          },
        },
        auditing: { invoke: { src: "gate", id: "auditor" }, on: { audited: "audited" } },
        audited: {
          on: {
            file_report: {
              target: "#cut-pick.filed",
              actions: assign({ picks: ({ context }) => [...context.picks, "file_report"] }),
            },
          },
        },
      },
    },
    filed: { type: "final", output: ({ context }) => ({ outcome: "filed", picks: context.picks }) },
    faulted: {
      type: "final",
      output: ({ context }) => ({ outcome: "faulted", picks: context.picks, reason: context.fault }),
    },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
