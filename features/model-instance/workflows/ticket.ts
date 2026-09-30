// The run (ADR-0066): one ticket through three seats to a verified commit. The seed Repo's `main`
// carries a small project whose one test fails — that is the ticket. A Menu-only `planner` reads
// it and picks `plan`; a `coder` in the Sandbox edits the Worktree, runs the test, commits on the
// run's branch and picks `submit` naming the commit — a guard refuses one that names none; a
// `reviewer` in the same Sandbox, read-only (ADR-0028), runs the test itself and picks `approve`
// or `reject` with reasons, and a reject returns to the coder at most twice. Approval parks at
// the `shipping` Gate — the inspection window (ADR-0012/0054): the Sandbox is alive, and the step
// reads the branch and runs the test IN the pod before it sends `ship`. Nothing is pushed: the
// Agent holds no credential and the push is the caller's (ADR-0005/0053), exactly as `task` says.
//
// The body records every pick it admitted in `picks` — the ledger the scenario reads off the
// output — and never the model's text: the diff, the commit message and the Turn count are the
// model's, and the scenario asserts none of them.
//
// Filename `ticket.ts` → workflow "ticket".

import { z } from "zod";
import { assign } from "xstate";
import { agent, defineEvent, jr2Setup, workspace, type HostInjectedInput, type Workspaced } from "@jr2/orchestrator";
import { coder, planner, reviewer } from "./_agents.ts";
import { dialFor, type ThinkingCell } from "./_profile.ts";

/** How many rejections the coder gets before the run gives up. */
const MAX_REJECTS = 2;

const TICKET =
  "The test in `test.js` fails: `greet(name)` in `greet.js` must return `hello, <name>` " +
  "(lower-case, a comma and a space), and `greet()` with no name must return `hello, world`. " +
  "Make `node --test` pass without changing the test.";

const plan = defineEvent({
  name: "plan",
  description: "Your plan for the coder: what to change, and how to verify it.",
  audience: "agent",
  input: z.object({ plan: z.string() }),
});
const submit = defineEvent({
  name: "submit",
  description: "The work is committed on the branch. Name the commit (its sha) and summarize it.",
  audience: "agent",
  input: z.object({ commit: z.string(), summary: z.string() }),
});
const approve = defineEvent({
  name: "approve",
  description: "The branch does what the ticket asks and its tests pass.",
  audience: "agent",
  input: z.object({ notes: z.string() }),
});
const reject = defineEvent({
  name: "reject",
  description: "Send the work back. Say concretely what is wrong.",
  audience: "agent",
  input: z.object({ reasons: z.string() }),
});
const ship = defineEvent({ name: "ship", audience: "external", input: z.object({}) });

const door = z.object({ thinking: z.enum(["off", "on"]).default("off") });

type BodyInput = Workspaced<z.infer<typeof door> & HostInjectedInput, "app">;
type BodyContext = BodyInput & {
  picks: string[];
  plan?: string;
  commit?: string;
  summary?: string;
  reasons?: string;
  rejects: number;
  fault?: string;
};

const SHA = /^[0-9a-f]{7,40}$/;

export type TicketOutput = {
  outcome: "shipped" | "stuck" | "lost" | "faulted";
  picks: string[];
  commit?: string;
  reason?: string;
};

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput; output: TicketOutput },
  events: [plan, submit, approve, reject, ship],
  actors: { planner: agent(planner), coder: agent(coder), reviewer: agent(reviewer) },
}).createMachine({
  id: "body",
  context: ({ input }) => ({ ...input, picks: [], rejects: 0 }),
  initial: "planning",
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    planning: {
      invoke: {
        src: "planner",
        input: ({ context }) => ({
          prompt:
            `Ticket: ${TICKET}\n\nThe repository is a small Node project: \`greet.js\` exports ` +
            `\`greet\`, \`test.js\` tests it with \`node:test\`, and \`package.json\`'s test script is ` +
            `\`node --test\`. Call \`plan\` with a short plan for the coder.`,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: {
        plan: {
          target: "coding",
          actions: assign({
            plan: ({ event }) => event.plan,
            picks: ({ context }) => [...context.picks, "plan"],
          }),
        },
        "agent.fault": { target: "faulted", actions: assign({ fault: ({ event }) => event.reason }) },
      },
    },
    coding: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          prompt: coderPrompt(context),
          cwd: context.workspace.repos.app,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: {
        // Guarded on the payload (ADR-0029): offered, then judged on delivery — a `submit` that
        // names no commit is refused, and the refusal names the Allowed picks.
        submit: {
          guard: ({ event }) => SHA.test(event.commit.trim()),
          target: "reviewing",
          actions: assign({
            commit: ({ event }) => event.commit.trim(),
            summary: ({ event }) => event.summary,
            reasons: undefined,
            picks: ({ context }) => [...context.picks, "submit"],
          }),
        },
        "agent.fault": { target: "faulted", actions: assign({ fault: ({ event }) => event.reason }) },
      },
    },
    reviewing: {
      invoke: {
        src: "reviewer",
        // The coder's Worktree, read-only by tool list (ADR-0028's hint; its detached-worktree
        // guarantee is a creation-time seat and this review is per round).
        input: ({ context }) => ({
          prompt:
            `Review the branch \`${context.workspace.branch}\` against \`main\` in your working ` +
            `directory. The ticket: ${TICKET}\n\nThe coder says (commit ${context.commit}): ` +
            `${context.summary}\n\nRead the diff (\`git diff main...HEAD\`), run \`node --test\`, and ` +
            `call \`approve\` or \`reject\`.`,
          cwd: context.workspace.repos.app,
          continue: true,
          ...dialFor(context.thinking as ThinkingCell),
        }),
      },
      on: {
        approve: {
          target: "shipping",
          actions: assign({ picks: ({ context }) => [...context.picks, "approve"] }),
        },
        reject: [
          {
            guard: ({ context }) => context.rejects < MAX_REJECTS,
            target: "coding",
            actions: assign({
              reasons: ({ event }) => event.reasons,
              rejects: ({ context }) => context.rejects + 1,
              picks: ({ context }) => [...context.picks, "reject"],
            }),
          },
          { target: "stuck", actions: assign({ picks: ({ context }) => [...context.picks, "reject"] }) },
        ],
        "agent.fault": { target: "faulted", actions: assign({ fault: ({ event }) => event.reason }) },
      },
    },
    // The inspection window (ADR-0012): the step verifies the branch in the pod, then ships.
    shipping: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          meta: {
            branch: context.workspace.branch,
            worktree: context.workspace.repos.app,
            commit: context.commit,
            picks: context.picks,
          },
        }),
      },
      on: { ship: { target: "shipped" } },
    },
    shipped: {
      type: "final",
      output: ({ context }): TicketOutput => ({ outcome: "shipped", picks: context.picks, commit: context.commit }),
    },
    stuck: { type: "final", output: ({ context }): TicketOutput => ({ outcome: "stuck", picks: context.picks }) },
    lost: { type: "final", output: ({ context }): TicketOutput => ({ outcome: "lost", picks: context.picks }) },
    faulted: {
      type: "final",
      output: ({ context }): TicketOutput => ({ outcome: "faulted", picks: context.picks, reason: context.fault }),
    },
  },
  output: ({ event }) => (event as { output?: TicketOutput }).output as TicketOutput,
});

/** The coder's Frame: the ticket and the plan on the first round; the reviewer's reasons after a
 * reject, on the same conversation (ADR-0057), so the coder remembers what it did. */
function coderPrompt(context: BodyContext): string {
  if (context.reasons !== undefined) {
    return (
      `The reviewer rejected your commit ${context.commit}: ${context.reasons}\n\nFix it in your ` +
      `working directory, run \`node --test\`, commit on branch \`${context.workspace.branch}\`, and ` +
      `call \`submit\` with the new commit's sha.`
    );
  }
  return (
    `Ticket: ${TICKET}\n\nPlan from the planner: ${context.plan}\n\nWork in your working directory, ` +
    `which is a checkout of the repository on branch \`${context.workspace.branch}\`. Run \`node --test\`, ` +
    `commit on that branch, and call \`submit\` with the commit's sha.`
  );
}

export const machine = workspace(body, {
  input: door,
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
  // Nothing is pushed, so a fixed branch collides with nothing (each run's pod cuts its own).
  spec: () => ({ branch: "model-ticket" }),
});
