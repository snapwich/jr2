import { assign } from "xstate";
import { z } from "zod";
import {
  agent,
  command,
  defineEvent,
  fail,
  isReady,
  jr2Setup,
  push,
  workspace,
  worktree,
  type CommandOutput,
  type HostInjectedInput,
  type PushOutput,
  type Workspaced,
} from "@jr2/orchestrator";

// The run input: what you give `jr2 run fix --input`. It has the `prompt` of the run input of `task`.
const door = z.object({
  prompt: z.string().describe("What to do, in prose. The coder's first Turn is this prompt."),
});
type Door = z.infer<typeof door>;

// The coder's one pick. It is a tool on the coder's Menu.
const finish = defineEvent({
  name: "finish",
  description: "End the turn: the fix is committed on the branch and ready for the tests.",
  input: z.object({ summary: z.string().describe("What you did, in a few sentences.") }),
});
// Your two replies at the `review` Gate.
const approve = defineEvent({
  name: "approve",
  description: "Accept the work. jr2 pushes the branch to the fork.",
  input: z.object({}),
});
const requestChanges = defineEvent({
  name: "request_changes",
  description: "Send the work back to the coder with notes. The coder continues the same conversation.",
  input: z.object({ notes: z.string().describe("What to change, in prose.") }),
});

// The body gets the run input, the seed Instance ID of the run, and the Workspace handles of its one Repo Slot.
type BodyInput = Workspaced<Door & HostInjectedInput, "target">;
type Context = BodyInput & {
  // The next Turn is the first of its conversation: it must carry the whole task.
  fresh: boolean;
  // The text of the next Turn after the first: the failed tests, or your notes.
  feedback?: string;
  // The coder's summary of its last Turn, for the Gate.
  summary?: string;
  // Why the run is at the Gate with no summary: a Turn that failed, or a push that did not happen.
  reason?: string;
  // The commit on the fork, after the push.
  commit?: string;
};
// The output of a run that ends `done`. A lost Sandbox fails the run, with no output of this type.
type Output = { outcome: "pushed"; branch: string; commit: string };

// The Worktree of the coder. The Machine names the folder, and each Effect that works there names it.
function fixTree(context: BodyInput) {
  return `${context.workspace.repos.target}/fix` as const;
}
// One branch for each run, from its seed Instance ID.
function branchOf(context: BodyInput): string {
  return `jr2/fix-${context.instanceId}`;
}

// Two guards. A guard with a name shows that name on its arrow in the Console's graph.
function testsPassed({ event }: { event: { output: CommandOutput } }): boolean {
  return event.output.outcome === "exited" && event.output.code === 0;
}
function pushed({ event }: { event: { output: PushOutput } }): boolean {
  return event.output.outcome === "pushed";
}

const body = jr2Setup({
  types: {} as { context: Context; input: BodyInput; output: Output },
  events: [finish, approve, requestChanges],
  actors: {
    coder: agent({
      model: "local/qwen3.6-35b-a3b",
      description: "Fixes one bug in its own Workspace, and commits the fix.",
      workspace: "write",
      instructions: `You are a software engineer. You fix one bug, in a container of your own.

- Work only in the worktree that your turn names. Your tools are rooted there.
- Commit your fix on the branch. You cannot push. jr2 pushes the branch after a human approves it.
- Make the smallest change that fixes the bug.
- End your turn with exactly one call to \`finish\`.`,
    }),
    // Cut a Worktree of `target`: the Workspace only clones.
    cut: worktree(),
    // A program in the Harness container of the Sandbox, in the Worktree that its input names. Node expands the glob itself.
    tests: command(["node", "--test", "docs/site/tutorial/greet/test/*.test.js"], { timeout: "5m" }),
    // Push the tip of the coder's branch to the Repo of `target`, with the token of `git.credentials`.
    publish: push(),
    // Fail the run: the end for work that did not succeed. A final state means `done`.
    fail: fail(),
  },
}).createMachine({
  id: "fix",
  context: ({ input }) => ({ ...input, fresh: true }),
  initial: "cutting",
  // The Sandbox is gone, and every commit that was not pushed went with it.
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    // The Workspace only clones. The Machine cuts the Worktree that the Agent works in.
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: fixTree(context), branch: branchOf(context) }),
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "working" }, { target: "notCut" }],
      },
    },
    working: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          prompt: promptOf(context),
          cwd: fixTree(context),
          // Each Turn continues the coder's one conversation, so the coder remembers its work.
          continue: true,
        }),
      },
      on: {
        finish: {
          target: "testing",
          actions: assign({
            summary: ({ event }) => event.summary,
            feedback: undefined,
            reason: undefined,
            fresh: false,
          }),
        },
        // jr2 could not get a pick from the coder. A human decides at the Gate.
        "agent.fault": {
          target: "review",
          actions: assign({ reason: ({ event }) => event.reason, summary: undefined, fresh: true }),
        },
      },
    },
    testing: {
      invoke: {
        src: "tests",
        input: ({ context }) => ({ worktree: fixTree(context) }),
        onDone: [
          { guard: testsPassed, target: "review" },
          {
            target: "working",
            actions: assign({ feedback: ({ event }) => testFeedback(event.output) }),
          },
        ],
      },
    },
    // The run waits here for you. Its Gate id is body.review: the Workspace runs this Machine as body.
    review: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          meta: {
            ...(context.summary !== undefined ? { summary: context.summary } : {}),
            ...(context.reason !== undefined ? { reason: context.reason } : {}),
            branch: branchOf(context),
            worktree: fixTree(context),
          },
        }),
      },
      on: {
        approve: { target: "pushing" },
        request_changes: {
          target: "working",
          actions: assign({
            feedback: ({ event }) => `A human reviewed your work and asks for changes:\n${event.notes}`,
            summary: undefined,
          }),
        },
      },
    },
    pushing: {
      invoke: {
        src: "publish",
        input: ({ context }) => ({ worktree: fixTree(context) }),
        onDone: [
          {
            guard: pushed,
            target: "done",
            actions: assign({ commit: ({ event }) => publishedOf(event.output) }),
          },
          // Nothing was pushed, or jr2 cannot tell. The Sandbox stays, and the run waits at the Gate again.
          { target: "review", actions: assign({ reason: ({ event }) => pushFailure(event.output) }) },
        ],
      },
    },
    done: {
      type: "final",
      output: ({ context }): Output => ({
        outcome: "pushed",
        branch: branchOf(context),
        commit: context.commit ?? "",
      }),
    },
    // Not final states: the run ends `failed`, and jr2 deletes the Sandbox.
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost, with every commit that was not pushed" } } },
  },
  // The output of the run. xstate reads only this root `output` as the output of the Machine. It
  // gets the output of the final state that ended the run as `event.output`.
  output: ({ event }) => event.output as Output,
});

// The text of each Turn. The first Turn of a conversation carries the task. Each later Turn carries only what is new.
function promptOf(context: Context): string {
  const feedback = context.feedback ?? "";
  if (!context.fresh) return feedback || "Continue.";
  const reason = context.reason ? `\n\nThe last attempt ended: ${context.reason}` : "";
  return (
    `${context.prompt}${reason}${feedback ? `\n\n${feedback}` : ""}\n\n` +
    `Work in ${fixTree(context)}, on the branch ${branchOf(context)}. ` +
    "Commit your fix there, then call finish."
  );
}

// What the coder reads when the tests fail: the end of the output of `node --test`.
function testFeedback(output: CommandOutput): string {
  const text = "tail" in output ? output.tail : output.reason;
  return (
    `The tests do not pass (${output.outcome}). The end of their output:\n${text}\n\n` +
    "Fix the code, commit, then call finish."
  );
}

// The commit that the fork has now.
function publishedOf(output: PushOutput): string {
  return output.outcome === "pushed" ? output.published : "";
}

// Why the push did not happen, in the words of jr2 and git.
function pushFailure(output: PushOutput): string {
  return output.outcome === "pushed" ? "" : `The push did not happen (${output.outcome}): ${output.reason}`;
}

export const machine = workspace(body, {
  input: door,
  repos: { target: { url: "https://github.com/<you>/jr2.git", ref: "v<version>" } },
});
