// S4: N coders from a planner's list, a pool() inside a workspace() body, each coder in its
// own Worktree of ONE clone, then a local merge and one push.
import { z } from "zod";
import { assign, fromPromise } from "xstate";
import {
  agent,
  arg,
  command,
  defineEvent,
  fail,
  jr2Setup,
  pool,
  push,
  source,
  workspace,
  worktree,
  type CommandOutput,
  type PoolNextInput,
  type Workspaced,
} from "@jr2/orchestrator";

const Task = z.object({ id: z.string(), title: z.string() });
type Task = z.infer<typeof Task>;

// --- The worker: one Worktree, one coder. Its input is its task plus the handles, which the Pool
// forwards with `itemInput`: a worker gets no run input.

const done = defineEvent({ name: "done", description: "Your task is committed.", input: z.object({}) });

type WorkerInput = Workspaced<Task, "app">;
// One segment: the name holds the planner's id, so a bad id is a refused cut for this one item.
const taskTree = (context: WorkerInput) => `${context.workspace.repos.app}/task-${context.id}` as const;

const worker = jr2Setup({
  types: {} as { input: WorkerInput; context: WorkerInput; output: { id: string } },
  events: [done],
  actors: {
    coder: agent({ model: "fake/model-x", instructions: "You do one task. You commit on your branch." }),
    cut: worktree(),
    fail: fail(),
  },
}).createMachine({
  id: "worker",
  context: ({ input }) => input,
  // A worker hears no `workspace.lost`: only the body does (`workspace.ts`), and it stops the Pool.
  on: { "agent.fault": ".failed" },
  initial: "cutting",
  states: {
    // A planner wrote the id, so a bad one reaches `path`: `refused`, and this one item fails.
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: taskTree(context), branch: `task/${context.id}` }),
        onDone: [{ guard: ({ event }) => event.output.outcome === "ready", target: "coding" }, { target: "notCut" }],
      },
    },
    coding: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({ prompt: context.title, cwd: taskTree(context) }),
      },
      on: { done: "finished" },
    },
    finished: { type: "final", output: ({ context }) => ({ id: context.id }) },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    failed: { invoke: { src: "fail", input: { reason: "the Agent's Turn could not go on" } } },
  },
  output: ({ event }) => (event as { output?: { id: string } }).output as { id: string },
});

// --- The Pool: its Source reads the plan from the Pool's input, and keeps no state of its own.

type PlanInput = Workspaced<{ tasks: Task[] }, "app">;

const planSource = source<Task, PlanInput>({
  next: fromPromise(async ({ input }: { input: PoolNextInput<PlanInput> }) => {
    const { active, settled, input: plan } = input;
    return plan.tasks.find((t) => !active.includes(t.id) && !settled.includes(t.id)) ?? null;
  }),
});

const coders = pool(worker, {
  id: "coders",
  source: planSource,
  itemId: (task: Task) => task.id,
  cap: 3,
  itemInput: (task: Task, { input }: { input: PlanInput }) => ({ ...task, workspace: input.workspace }),
  // The body decides: a merge of what worked is better than no merge.
  failures: "report",
});

// --- The body: plan, fan out, merge, push.

const plan = defineEvent({
  name: "plan",
  description: "Your plan: one task for each coder.",
  input: z.object({ tasks: z.array(Task) }),
});

const runInput = z.object({ goal: z.string(), branch: z.string() });
type BodyInput = Workspaced<z.infer<typeof runInput>, "app">;
type Context = BodyInput & { tasks: Task[]; merged: string[]; left: string[]; failed?: unknown };

const mainTree = (context: BodyInput) => `${context.workspace.repos.app}/merge` as const;
const clean = (output: CommandOutput): boolean => output.outcome === "exited" && output.code === 0;

const body = jr2Setup({
  types: {} as { input: BodyInput; context: Context },
  events: [plan],
  actors: {
    planner: agent({ model: "fake/model-x", workspace: "none", instructions: "You split work." }),
    coders,
    cut: worktree(),
    // `branch` is a local branch of the same clone: a Worktree's commits are here already.
    merge: command(["git", "merge", "--no-edit", arg("branch")]),
    publish: push(),
    fail: fail(),
  },
}).createMachine({
  id: "concurrent",
  context: ({ input }) => ({ ...input, tasks: [], merged: [], left: [] }),
  on: { "workspace.lost": ".lost", "agent.fault": ".failed" },
  initial: "planning",
  states: {
    planning: {
      invoke: { src: "planner", input: ({ context }) => ({ prompt: `Split this work: ${context.goal}` }) },
      on: { plan: { target: "cutting", actions: assign({ tasks: ({ event }) => event.tasks }) } },
    },
    // The target first: a `run` here and a `run/a` in a worker are one conflict in git's refs, and it
    // is refused now, before any coder works, in the first worker's cut and not after a Pool.
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({ path: mainTree(context), branch: context.branch }),
        onDone: [{ guard: ({ event }) => event.output.outcome === "ready", target: "working" }, { target: "notCut" }],
      },
    },
    working: {
      invoke: {
        src: "coders",
        input: ({ context }) => ({ tasks: context.tasks, workspace: context.workspace }),
        onDone: {
          target: "merging",
          actions: assign({
            // `items` is `Record<string, unknown>`: the keys are what a body can read with no cast.
            left: ({ event }) => Object.keys(event.output.items),
            failed: ({ event }) => event.output.failures,
          }),
        },
      },
    },
    // One branch at a time: `arg()` is one argument, so N branches are N invokes.
    merging: {
      always: { guard: ({ context }) => context.left.length === 0, target: "publishing" },
      invoke: {
        src: "merge",
        input: ({ context }) => ({ branch: `task/${context.left[0]!}`, worktree: mainTree(context) }),
        onDone: [
          {
            guard: ({ event }) => clean(event.output),
            target: "merging",
            reenter: true,
            actions: assign({
              merged: ({ context }) => [...context.merged, context.left[0]!],
              left: ({ context }) => context.left.slice(1),
            }),
          },
          { target: "conflict" },
        ],
      },
    },
    publishing: {
      invoke: {
        src: "publish",
        input: ({ context }) => ({ worktree: mainTree(context) }),
        onDone: [{ guard: ({ event }) => event.output.outcome === "pushed", target: "done" }, { target: "notPushed" }],
      },
    },
    done: { type: "final" },
    conflict: { invoke: { src: "fail", input: { reason: "a task did not merge" } } },
    notCut: { invoke: { src: "fail", input: { reason: "a Worktree was not cut" } } },
    notPushed: { invoke: { src: "fail", input: { reason: "the merge was not pushed" } } },
    failed: { invoke: { src: "fail", input: { reason: "the planner's Turn could not go on" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } },
  },
});

export const machine = workspace(body, {
  input: runInput,
  effector: { image: import.meta.resolve("../images/effector") },
  repos: { app: { url: "ssh://git@seed.jr2-e2e-seed.svc/srv/push.git", ref: "main" } },
});
