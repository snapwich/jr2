import { assign } from "xstate";
import { z } from "zod";
import {
  agent,
  command,
  defineEvent,
  jr2Setup,
  push,
  workspace,
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

// #region events
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
// #endregion events

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
type Output = { outcome: "pushed"; branch: string; commit: string } | { outcome: "lost" };

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
      model: "anthropic/claude-haiku-5-5",
      description: "Fixes one bug in its own Workspace, and commits the fix.",
      workspace: "write",
      instructions: `You are a software engineer. You fix one bug, in a container of your own.

- Work only in the worktree that your turn names. Your tools are rooted there.
- Commit your fix on the branch. You cannot push. jr2 pushes the branch after a human approves it.
- Make the smallest change that fixes the bug.
- End your turn with exactly one call to \`finish\`.`,
    }),
    // #region effects
    // A program in the Harness container of the Sandbox, in the Worktree of `target`. Node expands the glob itself.
    tests: command(["node", "--test", "docs/site/tutorial/greet/test/*.test.js"], { timeout: "5m" }),
    // Push the tip of the coder's branch to the Repo of `target`, with the token of `git.credentials`.
    publish: push(),
    // #endregion effects
  },
}).createMachine({
  id: "fix",
  context: ({ input }) => ({ ...input, fresh: true }),
  initial: "working",
  // The Sandbox is gone, and every commit that was not pushed went with it.
  on: { "workspace.lost": { target: ".lost" } },
  states: {
    // #region working
    working: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          prompt: promptOf(context),
          cwd: context.workspace.repos.target,
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
    // #endregion working
    // #region testing
    testing: {
      invoke: {
        src: "tests",
        onDone: [
          { guard: testsPassed, target: "review" },
          {
            target: "working",
            actions: assign({ feedback: ({ event }) => testFeedback(event.output) }),
          },
        ],
      },
    },
    // #endregion testing
    // #region review
    // The run waits here for you. Its Gate id is body.review: the Workspace runs this Machine as body.
    review: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          meta: {
            ...(context.summary !== undefined ? { summary: context.summary } : {}),
            ...(context.reason !== undefined ? { reason: context.reason } : {}),
            branch: context.workspace.branch,
            worktree: context.workspace.repos.target,
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
    // #endregion review
    // #region pushing
    pushing: {
      invoke: {
        src: "publish",
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
    // #endregion pushing
    done: {
      type: "final",
      output: ({ context }): Output => ({
        outcome: "pushed",
        branch: context.workspace.branch,
        commit: context.commit ?? "",
      }),
    },
    lost: { type: "final", output: { outcome: "lost" } satisfies Output },
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
    `Work in ${context.workspace.repos.target}, on the branch ${context.workspace.branch}. ` +
    "Commit your fix there, then call finish."
  );
}

// What the coder reads when the tests fail: the end of the output of `node --test`.
function testFeedback(output: CommandOutput): string {
  const text = output.outcome === "unknown" ? output.reason : output.tail;
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

// #region workspace
export const machine = workspace(body, {
  input: door,
  repos: { target: { url: "https://github.com/<you>/jr2.git", ref: "v<version>" } },
  // One branch for each run, from its seed Instance ID. Its type is not on the input of `spec`.
  spec: ({ input }) => ({ branch: `jr2/fix-${input.instanceId}` }),
});
// #endregion workspace
