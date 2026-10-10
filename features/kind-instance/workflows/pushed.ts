// The kind tier's PUSH workflow (ADR-0067, ADR-0068): a signed push from the Workspace's Sandbox
// Effector to the seed's push remote over ssh, with no Agent. The body's final output carries what
// the Machine routed on, and the wrapper forwards it, so a scenario reads it off `jr2 status`.
//
//   signed    the body commits in the Harness container, leaves an edit and an untracked file, and
//             reads `git status` (`before`); then a signed push; then reads the Worktree again
//             (`after`). The step verifies the published commit on the remote with the signing
//             key as the one allowed signer, and that the sync moved the branch to it while the
//             files, the index and HEAD did not change.
//   diverged  the body commits, pushes signed, then amends the commit it pushed (the history
//             rewrite the paragraph after a signed push warns of) and pushes again: `diverged`,
//             and the remote still holds the first push.
//
// Its one Repo Slot binds the seed's push remote (`steps/seed.ts`), whose `git.credentials` entry
// names the deploy key that clones and pushes and the key the Effector signs with
// (`jr2.config.ts`). The Effector runs in this module's own image (`images/effector`): the tier's
// Sandbox Image has no ssh. The setup commands run in the Harness container as the Agent's user.

import { z } from "zod";
import { assign } from "xstate";
import {
  command,
  defineEvent,
  jr2Setup,
  push,
  workspace,
  type HostInjectedInput,
  type Workspaced,
} from "@jr2/orchestrator";

/** The seed's push remote (`steps/seed.ts`). */
const REMOTE = { url: "ssh://git@seed.jr2-e2e-seed.svc/srv/push.git", ref: "main" };

const door = z.object({ mode: z.enum(["signed", "diverged"]), marker: z.string().regex(/^m-[a-z0-9]+$/) });
type Door = z.infer<typeof door>;
type BodyInput = Workspaced<HostInjectedInput & Door, "app">;
type BodyContext = BodyInput & { first?: unknown; second?: unknown; before?: unknown; after?: unknown };

const unused = defineEvent({ name: "noop", input: z.object({}) });
const AUTHOR = ["-c", "user.name=jr2 e2e", "-c", "user.email=e2e@jr2.test"].join(" ");

/** What the Worktree looks like, read in the Harness container: status, the files, HEAD. */
const LOOK =
  'git status --porcelain; echo "--"; cat work.txt notes.txt; echo "--"; git rev-parse HEAD; git symbolic-ref HEAD';

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput; output: unknown },
  events: [unused],
  actors: {
    // In the Harness container: the Agent's own work, committed.
    commit: command([
      "sh",
      "-c",
      `printf 'signed work\\n' > work.txt && git add work.txt && git ${AUTHOR} commit -q -m 'the work'`,
    ]),
    // In the Harness container: an edit and an untracked file left as they are, then a look.
    edit: command([
      "sh",
      "-c",
      `printf 'not committed\\n' >> work.txt && printf 'untracked\\n' > notes.txt && ${LOOK}`,
    ]),
    look: command(["sh", "-c", LOOK]),
    // In the Harness container: the pushed commit rewritten.
    amend: command(["sh", "-c", `git ${AUTHOR} commit -q --amend -m 'the work, reworded'`]),
    // In the Sandbox Effector.
    publish: push({ sign: true }),
  },
}).createMachine({
  id: "pushed",
  context: ({ input }) => input,
  initial: "committing",
  on: { noop: ".settled" },
  states: {
    committing: {
      invoke: {
        src: "commit",
        onDone: [{ guard: ({ context }) => context.mode === "signed", target: "editing" }, { target: "publishing" }],
      },
    },
    editing: {
      invoke: {
        src: "edit",
        onDone: { target: "publishing", actions: assign({ before: ({ event }) => event.output }) },
      },
    },
    publishing: {
      invoke: {
        src: "publish",
        onDone: [
          {
            guard: ({ context }) => context.mode === "signed",
            target: "looking",
            actions: assign({ first: ({ event }) => event.output }),
          },
          { target: "amending", actions: assign({ first: ({ event }) => event.output }) },
        ],
      },
    },
    looking: {
      invoke: { src: "look", onDone: { target: "settled", actions: assign({ after: ({ event }) => event.output }) } },
    },
    amending: { invoke: { src: "amend", onDone: "republishing" } },
    republishing: {
      invoke: {
        src: "publish",
        onDone: { target: "settled", actions: assign({ second: ({ event }) => event.output }) },
      },
    },
    settled: { type: "final" },
  },
  output: ({ context }: { context: BodyContext }) => ({
    first: context.first ?? null,
    second: context.second ?? null,
    before: context.before ?? null,
    after: context.after ?? null,
  }),
});

export const machine = workspace(body, {
  input: door,
  repos: { app: REMOTE },
  spec: ({ input }) => ({ branch: `pushed-${input.marker}` }),
  effector: { image: import.meta.resolve("../images/effector") },
});
