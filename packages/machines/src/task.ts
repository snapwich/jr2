// `task` — the kit's first shipped Machine (ADR-0054): one prompt, one Workspace, one human says
// done. It is the smallest shape that is still worth packaging — a coder in a Sandbox, a Gate a
// human answers, and a loop between them that ends when the human ends it.
//
// Both of the parts a package cannot honestly fill are left OPEN (CONTEXT.md, ADR-0051/0054): the
// Repo Slots are Open as a MAP, because the package cannot know the repository — nor how many
// checkouts the task wants beside it — and the Agent `coder` has no model, because the package
// cannot pay for one. A consumer binds both on the line that registers this Machine as a
// Workflow, naming every slot. The ORDER is this Machine's convention, not the kit's (ADR-0051:
// the handles keep declaration order and the kit reads nothing into it): the FIRST slot is the
// one the coder works in — its Worktree is the `cwd` every Turn is framed with (ADR-0057), so the
// Working tools are rooted where the prompt says to work — and any others are attached beside it
// for the coder to read (a library the change targets, a handbook):
//
//   export const machine = customize(task, {
//     repos: {
//       target: { url: "https://github.com/you/repo.git" },
//       reference: { url: "https://github.com/you/lib.git" }, // optional: more checkouts to read
//     },
//     agents: { coder: { model: "anthropic/claude-sonnet-4-6" } },
//   });
//
// `jr2 up` walks the registered Machines and refuses either part unbound, printing exactly that
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
  jr2Setup,
  open,
  workspace,
  type HostInjectedInput,
  type ThinkingLevel,
  type Workspaced,
} from "@jr2/orchestrator";

// ---------------------------------------------------------------------------------------------
// The door (ADR-0033): what a caller sends to start a run, declared on the `workspace()` that is
// this Machine's root. One source of truth — the types below derive from it, the Console generates
// its start form from it, and it types the spec mapper.
//
// No `repo` field, deliberately (ADR-0054): a packaged door cannot enumerate the Instance's
// repositories, and "a Workflow is a name" reads best when the name means "a prompt against THIS
// repository". The repositories are the Workflow's `customize` line, not the run's input.

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
    .describe("The branch to cut and commit on. Default: jr2/task-<run id>, so concurrent runs never collide."),
  // The two Dials (ADR-0018) as a PER-RUN escape hatch, not a default (ADR-0054): the bound
  // definition is what `jr2 up` preflights, and a door value overrides it for this one run's Turns.
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
// The body. It receives the door PLUS the handles `workspace()` injects and, because the wrapper is
// this Machine's ROOT, the field the host injects beside the door (`instanceId`, ADR-0033).
//
// `Workspaced<…, string>` — the body names NO slot (ADR-0051): it works in the FIRST checkout the
// handles carry, which is whatever the consumer wrote first (`worktreeOf`), and frames every
// other one. That is what lets the wrapper leave the slot map Open; a body that named
// `repos.target` could not.

type BodyInput = Workspaced<TaskInput & HostInjectedInput, string>;

type BodyContext = BodyInput & {
  /** Turns COMPLETED on the conversation the next Turn will land on. Zero means that Turn is its
   * first, so the prompt has to carry the whole task and the worktree framing again — which is
   * exactly what a post-fault Turn needs and a continued one does not. It counts for the PROMPT
   * alone: the conversation itself is jr2's, and a terminal `agent.fault` burns it in the ledger
   * so the next `continue` is virgin (ADR-0057). Re-briefing that Turn is what stays here, because
   * jr2 cannot write the prompt. */
  turns: number;
  /** The coder's own account of the last finished Turn — the Gate's `summary`. */
  summary?: string;
  /** Why the run is parked without a summary: the reason the fault carried — the Gate's `reason`. */
  reason?: string;
  /** The human's last notes, which are the next Turn's prompt. */
  notes?: string;
};

export const body = jr2Setup({
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

- Edit only inside the worktree your turn names as yours — your tools are already rooted in it.
  Nothing you write outside it survives. Any other checkout the turn names is there for you to read.
- Commit your work on the named branch. You cannot push, and you do not need to: a human reads the
  branch in this container before the run ends.
- Read before you write, and prefer the smallest change that does the task.
- You MUST end your turn by calling \`finish\` exactly once, with a summary of what you did. An
  uncalled tool parks the whole workflow waiting for you.`,
    }),
  },
}).createMachine({
  id: "task",
  context: ({ input }) => ({ ...input, turns: 0 }),
  initial: "working",

  // Our Sandbox is gone — reaped, or replaced after an eviction (ADR-0021). The pod-local clone and
  // every unpushed commit went with it, so settle as lost rather than pretend we can resume.
  on: { "workspace.lost": { target: ".lost" } },

  states: {
    working: {
      invoke: {
        src: "coder",
        input: ({ context }) => ({
          // This Turn's FRAME (ADR-0057): what it is about, and where it works. The `cwd` is
          // stated rather than left to the single-slot default, because "the first slot is the one
          // the coder edits" is this Machine's convention (`worktreeOf`) and a convention is
          // stated — a consumer who binds a second slot must not change where the coder works.
          prompt: coderPrompt(context),
          cwd: worktreeOf(context).path,
          // One human steering one Agent wants the Agent to remember what it did (ADR-0054), so
          // every `working` Turn lands on this Machine instance's one coder conversation. The
          // boolean names nothing: the id is structural (ADR-0057), and a conversation jr2 has
          // faulted is burned — the next `continue` mints a virgin one.
          continue: true,
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
        // ADR-0016's ONE terminal telemetry, ROUTED: jr2 has already retried, nudged and rerolled
        // (ADR-0027/0035), so this is the end of that conversation, not of the run. Park at the
        // same Gate — the Workspace is still alive and the work so far is still on the branch.
        // The dead conversation is jr2's to bury (it bumps the epoch, so the next `continue` is
        // virgin — ADR-0057); what belongs here is the RE-BRIEF, which `turns: 0` asks for.
        "agent.fault": {
          target: "review",
          actions: assign({
            reason: ({ event }) => event.reason,
            summary: undefined,
            turns: 0,
          }),
        },
      },
    },

    // The one park, and the whole point of the Machine: a human reads the branch and decides. The
    // Gate id derives from the actor path (leaf = this state's key), so it stays fan-out-safe if
    // this Machine is ever composed under a Pool; its accepted set derives from this state's
    // external transitions; `meta` is what `jr2 status`, the Console's drawer, and a webhook
    // translator read (ADR-0011/0015).
    review: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          meta: {
            ...(context.summary !== undefined ? { summary: context.summary } : {}),
            ...(context.reason !== undefined ? { reason: context.reason } : {}),
            // The branch the attach actually made and the worktree the coder committed in — what
            // an `exec` needs, and what a push would name.
            branch: context.workspace.branch,
            worktree: worktreeOf(context).path,
          },
        }),
      },
      on: {
        approve: { target: "done" },
        // No round cap (ADR-0054): the human is the cap. They see every Turn's result before the
        // next one starts, so a count jr2 chose would only ever interrupt them.
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
  // `jr2 status` on a finished run says which of the two things happened.
  output: ({ event }) => (event as { output?: TaskOutput }).output as TaskOutput,
});

// ---------------------------------------------------------------------------------------------
// The wrapper is this Machine's ROOT, so its `input` is the run's door (ADR-0033) and both mappers
// are typed by it — nothing here restates a shape.

export const task = workspace(body, {
  input: door,
  // The Repo Slots, OPEN as a map (ADR-0051/0054): the consumer names every slot and every Repo.
  // The package names none, because the body reads none — the first slot the consumer writes is
  // the one the coder edits (this Machine's convention, `worktreeOf`), and the rest are checkouts
  // the coder is told about and may read. A named
  // `target: open` would have said "one repository", which is not what the body knows.
  repos: open,
  spec: ({ input }) => ({ branch: branchOf(input) }),
});

/**
 * The branch this run works on: the door's, or `jr2/task-<run id>` (ADR-0054).
 *
 * The id is the run's seed Instance ID, which `RunHost.start` injects beside the door on the ROOT
 * machine's input ({@link HostInjectedInput}) and `jr2 status` reports. It is not door material —
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
      "task: no `branch` on the door and no run id to derive one from — `jr2/task-<run id>` needs the " +
        "id the host injects beside the door of the ROOT machine (ADR-0033), and this run of `task` " +
        "was started by a parent Machine instead. Pass `branch` in the run input.",
    );
  }
  return `jr2/task-${instanceId}`;
}

/**
 * Half the Turn's Frame (ADR-0057) — what it is about. The FIRST Turn of a conversation carries
 * the whole task and the geography, because the conversation holds nothing yet; every Turn after
 * it carries the human's notes alone, because the coder remembers the rest (ADR-0054's continued
 * conversation). A post-fault Turn is a first Turn again — that is what `turns` counts.
 *
 * The geography is every slot the handles carry (ADR-0051): the first is where the work goes —
 * and it is the Frame's `cwd`, so the Working tools are rooted there and the prose only says what
 * the tools already do — and each other checkout is named by the consumer's own word for it, at
 * the path the attach put it, the only way the coder can learn what is beside it since the package
 * never knew.
 */
function coderPrompt(context: BodyContext): string {
  const notes = context.notes ? `\n\nThe human reviewed your work and asks for changes:\n${context.notes}` : "";
  if (context.turns > 0) return notes.trimStart() || "Continue.";
  const { branch, repos } = context.workspace;
  const worktree = worktreeOf(context);
  const beside = Object.entries(repos)
    .filter(([slot]) => slot !== worktree.slot)
    .map(([slot, path]) => `\n- ${slot}: ${path}`)
    .join("");
  return (
    `${context.prompt}${notes}\n\n` +
    `Work in ${worktree.path}, on branch ${branch} — your tools are rooted there, so a relative ` +
    `path lands inside it. Commit what you do there, then call finish.` +
    (beside ? `\n\nAlso checked out beside it, for you to read:${beside}` : "")
  );
}

/**
 * The checkout the coder edits: the FIRST slot the consumer wrote. This is `task`'s convention,
 * not the kit's — the handles keep the slots in declaration order and give none a meaning
 * (ADR-0051) — so it is decided here, in one place, and stated on the line that registers the
 * Machine. The wrapper refuses a map with no slot, so the first always exists.
 */
function worktreeOf(context: Pick<BodyContext, "workspace">): { slot: string; path: string } {
  const [slot, path] = Object.entries(context.workspace.repos)[0]!;
  return { slot, path };
}
