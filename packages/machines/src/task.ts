// `task` — the kit's first shipped Machine (ADR-0054): one prompt, one Workspace, one human says
// done. It is the smallest shape that is still worth packaging — a coder in a Sandbox, a Gate a
// human answers, and a loop between them that ends when the human ends it.
//
// Both of the parts a package cannot honestly fill are left OPEN (CONTEXT.md, ADR-0051/0054): the
// Repo Slot `target` has no url, because the package cannot know the repository, and the Agent
// `coder` has no model, because the package cannot pay for one. A consumer binds both on the line
// that registers this Machine as a Workflow:
//
//   export const machine = customize(task, {
//     repos: { target: { url: "https://github.com/you/repo.git" } },
//     agents: { coder: { model: "anthropic/claude-sonnet-4-6" } },
//   });
//
// `j2 up` walks the registered Machines and refuses either part unbound, printing exactly that
// line (parts.ts, `customizeLine`); the Agent actor refuses to admit a Turn under an Open model as
// the second fence. So the failure mode of forgetting is a converge that stops, never a run that
// silently spends money on a model nobody chose.
//
// The Machine does NOT push (ADR-0005/0053): the Agent holds no credential, and the push url is
// the caller's own spelling with the caller's own credential. The `review` Gate IS the inspection
// window — while the run is parked the Sandbox is alive (parking is retention, ADR-0012), so a
// human execs in, reads the branch, pushes it if the work should outlive the run, and only then
// answers. Unpushed commits go with the pod, as ADR-0012 always said.

import { assign } from "xstate";
import { z } from "zod";
import {
  agent,
  defineEvent,
  j2Setup,
  open,
  workspace,
  type HostInjectedInput,
  type ThinkingLevel,
  type Workspaced,
} from "@j2/orchestrator";

// ---------------------------------------------------------------------------------------------
// The door (ADR-0033): what a caller sends to start a run, declared on the `workspace()` that is
// this Machine's root. One source of truth — the types below derive from it, the Console generates
// its start form from it, and it types the spec mapper.
//
// No `repo` field, deliberately (ADR-0054): a packaged door cannot enumerate the Instance's
// repositories, and "a Workflow is a name" reads best when the name means "a prompt against THIS
// repository". Two repositories are two `workflows/` files over two `customize` calls.

/** Mirrors `ThinkingLevel` as a value, since the door needs a zod enum and the type is a type.
 * `satisfies` is what keeps the two from drifting: a level added to the type fails here. */
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ThinkingLevel[];

const door = z.object({
  prompt: z.string().describe("What to do, in prose. The coder's first turn is this, framed with the worktree."),
  branch: z
    .string()
    .optional()
    .describe("The branch to cut and commit on. Default: j2/task-<run id>, so concurrent runs never collide."),
  // The two Dials (ADR-0018) as a PER-RUN escape hatch, not a default (ADR-0054): the bound
  // definition is what `j2 up` preflights, and a door value overrides it for this one run's Turns.
  // Identity — instructions, workspace access — is deliberately absent: an invocation that rewrote
  // those would make the Agent's name a lie.
  model: z.string().optional().describe('Override the coder\'s model for this run only, as "<provider>/<modelId>".'),
  thinkingLevel: z
    .enum(THINKING_LEVELS)
    .optional()
    .describe("Override the coder's reasoning effort for this run only."),
});

/** What a caller sends. */
export type TaskInput = z.infer<typeof door>;

/** What a run of `task` settles as — approved by the human, or lost with its Workspace. */
export type TaskOutput = { outcome: "approved"; branch: string } | { outcome: "lost" };

// ---------------------------------------------------------------------------------------------
// Vocabulary (ADR-0011/0015), scoped to this Machine alone: the agent event becomes the coder
// state's Menu, the two external ones become the Gate's accepted set.

const finish = defineEvent({
  name: "finish",
  description: "End the turn: the work is committed on the branch and ready for a human to read.",
  audience: "agent",
  input: z.object({ summary: z.string().describe("What you did, in a few sentences.") }),
});

const approve = defineEvent({
  name: "approve",
  description: "Accept the work. The run finishes and the Workspace — and anything unpushed in it — is torn down.",
  audience: "external",
  input: z.object({}),
});

const requestChanges = defineEvent({
  name: "request_changes",
  description: "Send the work back to the coder with notes. The coder continues the same conversation.",
  audience: "external",
  input: z.object({ notes: z.string().describe("What to change, in prose.") }),
});

// ---------------------------------------------------------------------------------------------
// The body. It receives the door PLUS the handles `workspace()` injects — `Workspaced<…, "target">`,
// keyed by the one Repo Slot the wrapper declares (ADR-0051) — and, because the wrapper is this
// Machine's ROOT, the field the host injects beside the door (`instanceId`, ADR-0033).

type BodyInput = Workspaced<TaskInput & HostInjectedInput, "target">;

type BodyContext = BodyInput & {
  /**
   * Which conversation the coder's Turns ride. `request_changes` continues the SAME conversation —
   * one human steering one Agent wants the Agent to remember what it did (ADR-0054) — but a
   * terminal `agent.fault` means j2 already rerolled that conversation and gave up on it
   * (ADR-0035), so there is nothing left to continue. Bumping the generation folds into the
   * conversation's disambiguator, and the next Turn starts a fresh conversation instead of
   * addressing a dead one.
   */
  generation: number;
  /** Turns COMPLETED on the current conversation. Zero means the next Turn is its first, so the
   * prompt has to carry the whole task and the worktree framing again — which is exactly what a
   * post-fault Turn needs and a continued one does not. */
  turns: number;
  /** The coder's own account of the last finished Turn — the Gate's `summary`. */
  summary?: string;
  /** Why the run is parked without a summary: the reason the fault carried — the Gate's `reason`. */
  reason?: string;
  /** The human's last notes, which are the next Turn's prompt. */
  notes?: string;
};

/** The conversation pin (ADR-0016): a workflow-chosen name, so every `working` Turn of a run
 * derives one deterministic instance id and the coder's context survives the round trip through
 * the Gate. The name is the slot key, because that is what the conversation is about. */
const CONVERSATION = "coder";

export const body = j2Setup({
  types: {} as { context: BodyContext; input: BodyInput; output: TaskOutput },
  events: [finish, approve, requestChanges],
  // The Agent rides the Machine (ADR-0049): the slot key is its name on the Harness wire, in the
  // minted iid, and in the `customize` line that binds its model.
  actors: {
    coder: agent({
      // OPEN (ADR-0054). Not a default — a stock model would have this package pick a vendor and
      // spend a user's money on a choice they never read. The consumer binds it with `customize`.
      model: open,
      description: "Works one task through to committed work in its own Workspace.",
      // Explicit, though it is also the default (ADR-0028): this Agent writes, and the ADR-0031
      // placement scan reads this field off the declaration to decide where its Turns run.
      workspace: "write",
      instructions: `You are a software engineer working alone on one task, in a container of your own.

- Work only inside the worktree the conversation names. Nothing you write outside it survives.
- Commit your work on the named branch. You cannot push, and you do not need to: a human reads the
  branch in this container before the run ends.
- Read before you write, and prefer the smallest change that does the task.
- You MUST end your turn by calling \`finish\` exactly once, with a summary of what you did. An
  uncalled tool parks the whole workflow waiting for you.`,
    }),
  },
}).createMachine({
  id: "task",
  context: ({ input }) => ({ ...input, generation: 0, turns: 0 }),
  initial: "working",

  // Our Sandbox is gone — reaped, or replaced after an eviction (ADR-0021). The pod-local clone and
  // every unpushed commit went with it, so settle as lost rather than pretend we can resume.
  on: { "workspace.lost": { target: ".lost" } },

  states: {
    working: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          prompt: coderPrompt(context),
          // One conversation per generation (see `BodyContext.generation`). `scope` is the
          // disambiguator the pin already has for exactly this: it rides the derived iid, so a
          // post-fault Turn addresses a new conversation instead of a dead one.
          conversation: CONVERSATION,
          scope: `g${context.generation}`,
          // This run's Dials, if the caller set them (ADR-0018/0054) — passed straight through,
          // layered over the bound definition when the Submission starts.
          ...(context.model !== undefined ? { model: context.model } : {}),
          ...(context.thinkingLevel !== undefined ? { thinkingLevel: context.thinkingLevel } : {}),
        }),
      },
      on: {
        finish: {
          target: "review",
          actions: assign({
            summary: ({ event }) => event.summary,
            reason: undefined,
            notes: undefined,
            turns: ({ context }) => context.turns + 1,
          }),
        },
        // ADR-0016's ONE terminal telemetry, ROUTED: j2 has already retried, nudged and rerolled
        // (ADR-0027/0035), so this is the end of that conversation, not of the run. Park at the
        // same Gate — the Workspace is still alive and the work so far is still on the branch —
        // and start the next Turn on a fresh conversation.
        "agent.fault": {
          target: "review",
          actions: assign({
            reason: ({ event }) => event.reason,
            summary: undefined,
            generation: ({ context }) => context.generation + 1,
            turns: 0,
          }),
        },
      },
    },

    // The one park, and the whole point of the Machine: a human reads the branch and decides. The
    // Gate id derives from the actor path (leaf = this state's key), so it stays fan-out-safe if
    // this Machine is ever composed under a Pool; its accepted set derives from this state's
    // external transitions; `meta` is what `j2 status`, the Console's drawer, and a webhook
    // translator read (ADR-0011/0015).
    review: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          meta: {
            ...(context.summary !== undefined ? { summary: context.summary } : {}),
            ...(context.reason !== undefined ? { reason: context.reason } : {}),
            // The branch the attach actually made and the directory it made it in — what an
            // `exec` needs, and what a push would name.
            branch: context.workspace.branch,
            workdir: context.workspace.workdir,
          },
        }),
      },
      on: {
        approve: { target: "done" },
        // No round cap (ADR-0054): the human is the cap. They see every Turn's result before the
        // next one starts, so a count j2 chose would only ever interrupt them.
        request_changes: {
          target: "working",
          actions: assign({ notes: ({ event }) => event.notes, summary: undefined, reason: undefined }),
        },
      },
    },

    // Reaching a final state is what tears the Workspace down (ADR-0012): approve means done with
    // the pod, and anything still unpushed in it goes too.
    done: {
      type: "final",
      output: ({ context }): TaskOutput => ({ outcome: "approved", branch: context.workspace.branch }),
    },
    lost: { type: "final", output: { outcome: "lost" } satisfies TaskOutput },
  },

  // The body's output is whichever final state settled it — the wrapper forwards it verbatim, so
  // `j2 status` on a finished run says which of the two things happened.
  output: ({ event }) => (event as { output?: TaskOutput }).output as TaskOutput,
});

// ---------------------------------------------------------------------------------------------
// The wrapper is this Machine's ROOT, so its `input` is the run's door (ADR-0033) and both mappers
// are typed by it — nothing here restates a shape.

export const task = workspace(body, {
  input: door,
  // The one Repo Slot, OPEN (ADR-0051/0054): the package names the slot, the consumer names the
  // Repo. `target` is the body's `workdir` because it is the only slot; a second repository is a
  // second slot on a Machine of the consumer's own.
  repos: { target: open },
  spec: ({ input }) => ({ branch: branchOf(input) }),
});

/**
 * The branch this run works on: the door's, or `j2/task-<run id>` (ADR-0054).
 *
 * The id is the run's seed Instance ID, which `RunHost.start` injects beside the door on the ROOT
 * machine's input ({@link HostInjectedInput}) and `j2 status` reports. It is not door material —
 * no caller sends it and it is never served as JSON Schema (ADR-0033) — so the schema does not
 * carry it and reading it takes a cast that says why.
 *
 * A `task` composed UNDER another Machine is fed by its parent rather than by the host, so the
 * field is absent there and there is no per-run id to name a branch after. Refuse, loudly and
 * before any pod exists: the alternative is a constant branch name, which two concurrent workers
 * would both cut and neither would own.
 */
function branchOf(input: TaskInput): string {
  if (input.branch) return input.branch;
  const { instanceId } = input as TaskInput & Partial<HostInjectedInput>;
  if (!instanceId) {
    throw new Error(
      "task: no `branch` on the door and no run id to derive one from — `j2/task-<run id>` needs the " +
        "id the host injects beside the door of the ROOT machine (ADR-0033), and this run of `task` " +
        "was started by a parent Machine instead. Pass `branch` in the run input.",
    );
  }
  return `j2/task-${instanceId}`;
}

/**
 * The turn's framing. The FIRST Turn of a conversation carries the whole task and the geography,
 * because the conversation holds nothing yet; every Turn after it carries the human's notes alone,
 * because the coder remembers the rest (ADR-0054's continued conversation). A post-fault Turn is a
 * first Turn again — that is what `turns` counts.
 */
function coderPrompt(context: BodyContext): string {
  const notes = context.notes ? `\n\nThe human reviewed your work and asks for changes:\n${context.notes}` : "";
  if (context.turns > 0) return notes.trimStart() || "Continue.";
  return (
    `${context.prompt}${notes}\n\n` +
    `Work in ${context.workspace.workdir}, on branch ${context.workspace.branch}. ` +
    `Commit what you do there, then call finish.`
  );
}
