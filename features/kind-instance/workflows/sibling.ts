// The @kind acceptance test for ADR-0076 (per-agent identity in one Sandbox). Two workspace-ful
// Agents share one Sandbox: `coder` works, then `reviewer` decides. The scenario releases the
// coder's pick, leaves the reviewer parked (so the reviewer never picks), and then — from the
// coder's Harness container — posts the reviewer's `approve` to the reviewer's iid through the
// Custodian, with the Stand-in that container holds.
//
// Today that delivery is ACCEPTED: the one Harness container holds the one Sandbox Stand-in, the
// Custodian swaps it for the Sandbox token, and the Orchestrator sees only that the Sandbox
// matches — so the coder approves its own review. The scenario asserts the ADR-0076 behavior
// (refused, and the run does not settle), so it is RED until the build lands and GREEN after:
// each agent slot runs in its own Harness container with its own per-slot credential, and the
// Orchestrator refuses a pick whose credential's slot is not the registration's.
//
// No Repo Slot: the two Agents share `/work`, as a GitHub Actions job's steps do (ADR-0051). The
// point under test is the control channel, not the filesystem — a shared Workspace is the
// motivating case, where the two seats are meant to collaborate but not act as each other.

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
    // Two Agents, both workspace-ful (default `workspace: "write"`), so both share the Sandbox and
    // its token. The slot key is each one's name on the Harness wire.
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
      invoke: { src: "coder", input: { prompt: "make a change" } },
      on: { built: "reviewing" },
    },
    // The reviewer decides. The scenario never releases this Turn, so a run that reaches `approved`
    // was moved by something other than the reviewer.
    reviewing: {
      invoke: { src: "reviewer", input: { prompt: "review the change: approve or reject" } },
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

// No `repos`: the Workspace clones nothing, and its two Agents share `/work`.
export const machine = workspace(body, { input: door });
