// Two workspace-ful Agents in one Sandbox, its one Harness and its `/work` (ADR-0076): `coder`
// works, then `reviewer` decides. Both Turns CONTINUE, so each registers at its bare base iid
// `<runId>/body/<agent>` (ADR-0057). No Repo Slot: the two Agents share `/work` (ADR-0051).
// ADR-0076's acceptance case: code the coder plants in `/work`, run by the reviewer's own programs,
// cannot act as the reviewer. The `workspace()` grants `PROBE_KEY`, so the same programs show that a
// granted held secret works and the model key stays out of their reach.

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

const door = z.object({ mode: z.enum(["review"]), marker: z.string().regex(/^m-[a-z0-9]+$/) });
// `never`: no Repo Slot, so the handles are `{ repos: {} }`.
type BodyInput = Workspaced<HostInjectedInput & z.infer<typeof door>, never>;
type BodyContext = BodyInput & { verdict?: string };

const built = defineEvent({ name: "built", input: z.object({ summary: z.string() }) });
const approve = defineEvent({ name: "approve", input: z.object({ summary: z.string() }) });
const reject = defineEvent({ name: "reject", input: z.object({ summary: z.string() }) });

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput; output: unknown },
  events: [built, approve, reject],
  actors: {
    // Two Agents, both workspace-ful (default `workspace: "write"`), so both run in the Sandbox's one
    // Harness. The slot key is each one's name on the Harness wire.
    coder: agent(coder),
    reviewer: agent(coder),
    fail: fail(),
  },
}).createMachine({
  id: "sibling",
  context: ({ input }) => input,
  initial: "building",
  on: { "workspace.lost": ".lost", "agent.fault": ".faulted" },
  states: {
    building: {
      invoke: { src: "coder", input: { prompt: "make a change", continue: true } },
      on: { built: "reviewing" },
    },
    // The reviewer decides. The scenario never releases this Turn, so a run that reaches `approved`
    // was moved by something other than the reviewer.
    reviewing: {
      // A CONTINUED Turn, at the bare base iid `<runId>/body/reviewer`: the target the planted code
      // posts to.
      invoke: { src: "reviewer", input: { prompt: "review the change: approve or reject", continue: true } },
      on: {
        approve: { target: "approved", actions: assign({ verdict: () => "approved" }) },
        reject: { target: "rejected", actions: assign({ verdict: () => "rejected" }) },
      },
    },
    approved: { type: "final" },
    rejected: { type: "final" },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
    faulted: { invoke: { src: "fail", input: { reason: "an Agent's Turn could not go on" } } },
  },
  output: ({ context }: { context: BodyContext }) => ({ verdict: context.verdict }),
});

// No `repos`: the Workspace clones nothing, and its two Agents share `/work`. `PROBE_KEY` is the one
// held secret its Agents' programs hold a Stand-in for (ADR-0076).
export const machine = workspace(body, { input: door, secrets: ["PROBE_KEY"] });
