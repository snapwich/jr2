// The kind tier's GPG workflow (ADR-0068, B12): one Workspace whose Sandbox Effector holds a
// credentialed command AND a GPG-signing push, started together, with no Agent. The Effector's one
// lock keeps the two from being live at once — a command's child is never alive beside the push's
// gpg-agent — and both complete. The body's final output carries both outcomes, and the wrapper
// forwards it, so a scenario reads them off `jr2 status`.
//
// Its one Repo Slot binds the seed's GPG push remote (`steps/seed.ts`), whose `git.credentials`
// entry names the deploy key that clones and pushes and the GPG key the Effector signs with
// (`jr2.config.ts`). The Effector runs in the tier's effector image (`images/effector`: git, ssh
// and gnupg). `echo-token` is the tier's one Effect secret; the command names it by value.

import { z } from "zod";
import { assign } from "xstate";
import {
  command,
  defineEvent,
  jr2Setup,
  push,
  secret,
  workspace,
  type HostInjectedInput,
  type Workspaced,
} from "@jr2/orchestrator";

/** The seed's GPG push remote (`steps/seed.ts`). */
const REMOTE = { url: "ssh://git@seed.jr2-e2e-seed.svc/srv/gpg.git", ref: "main" };

const door = z.object({ mode: z.literal("both"), marker: z.string().regex(/^m-[a-z0-9]+$/) });
type Door = z.infer<typeof door>;
type BodyInput = Workspaced<HostInjectedInput & Door, "app">;
type BodyContext = BodyInput & { command?: unknown; push?: unknown };

const unused = defineEvent({ name: "noop", input: z.object({}) });
const AUTHOR = ["-c", "'user.name=jr2 e2e'", "-c", "user.email=e2e@jr2.test"].join(" ");

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput; output: unknown },
  events: [unused],
  actors: {
    // In the Harness container: the Agent's own work, committed.
    commit: command([
      "sh",
      "-c",
      `printf 'gpg work\\n' > work.txt && git add work.txt && git ${AUTHOR} commit -q -m 'the gpg work'`,
    ]),
    // In the Sandbox Effector: a credentialed command that takes a moment, so the two overlap in
    // time unless the lock keeps them apart.
    deploy: command(["sh", "-c", 'sleep 3; echo "deployed with $TOKEN"'], { env: { TOKEN: secret("echo-token") } }),
    // In the Sandbox Effector: signed with the entry's GPG key.
    publish: push({ sign: true }),
  },
}).createMachine({
  id: "gpgsigned",
  context: ({ input }) => input,
  initial: "committing",
  on: { noop: ".settled" },
  states: {
    committing: { invoke: { src: "commit", onDone: "both" } },
    both: {
      type: "parallel",
      onDone: "settled",
      states: {
        deploying: {
          initial: "running",
          states: {
            running: {
              invoke: {
                src: "deploy",
                onDone: { target: "done", actions: assign({ command: ({ event }) => event.output }) },
              },
            },
            done: { type: "final" },
          },
        },
        publishing: {
          initial: "running",
          states: {
            running: {
              invoke: {
                src: "publish",
                onDone: { target: "done", actions: assign({ push: ({ event }) => event.output }) },
              },
            },
            done: { type: "final" },
          },
        },
      },
    },
    settled: { type: "final" },
  },
  output: ({ context }: { context: BodyContext }) => ({
    command: context.command ?? null,
    push: context.push ?? null,
  }),
});

export const machine = workspace(body, {
  input: door,
  repos: { app: REMOTE },
  spec: ({ input }) => ({ branch: `gpgsigned-${input.marker}` }),
  effector: { image: import.meta.resolve("../images/effector") },
});
