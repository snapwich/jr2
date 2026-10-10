// The kind tier's SANDBOX EFFECTOR workflow (ADR-0067, ADR-0068): Effects that run in the
// Workspace's Sandbox Effector, with no Agent. The body's final output IS the Effect's output, and
// the wrapper forwards it, so a scenario reads what the Machine routed on.
//
//   upload   a file the body wrote and committed in the Worktree, PUT to the echo with
//            `bearer(secret("echo-token"))`: the Effector opens it beneath the Worktree and sends it
//   env      a credentialed command that prints its secret from env and from `.path`, then the
//            files of the commit it runs against: the output names the secret and holds no form of it
//   dirty    the body leaves an edit uncommitted, then the same command: the answer is `dirty`, and
//            the command saw the commit, not the edit
//
// The echo is the suite's (`steps/seed.ts`); `echo-token` is the tier's one Effect secret, which
// these Effects place in this Workspace's Sandbox Effector (and the `called` workflow's in the
// Instance Effector). The setup commands run in the Harness container as the Agent's user.

import { z } from "zod";
import { assign } from "xstate";
import {
  bearer,
  command,
  defineEvent,
  jr2Setup,
  secret,
  upload,
  workspace,
  type HostInjectedInput,
  type Workspaced,
} from "@jr2/orchestrator";
/** The seed Repo (`steps/seed.ts`), bound as every kind workflow binds it. */
const SEED = { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" };

const ECHO = "http://echo.jr2-e2e-seed.svc";

const door = z.object({ mode: z.enum(["upload", "env", "dirty"]), marker: z.string().regex(/^m-[a-z0-9]+$/) });
type Door = z.infer<typeof door>;
type BodyInput = Workspaced<HostInjectedInput & Door, "app">;
type BodyContext = BodyInput & { output?: unknown };

const unused = defineEvent({ name: "noop", input: z.object({}) });
const token = secret("echo-token");
const GIT = ["-c", "user.name=jr2 e2e", "-c", "user.email=e2e@jr2.test"];

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput; output: unknown },
  events: [unused],
  actors: {
    // In the Harness container: the Agent's own work, committed.
    commit: command([
      "sh",
      "-c",
      `printf 'report of the run\\n' > report.txt && git add report.txt && git ${GIT.join(" ")} commit -q -m report`,
    ]),
    // In the Harness container: an edit left uncommitted.
    edit: command(["sh", "-c", "printf 'edited, not committed\\n' > report.txt"]),
    // In the Sandbox Effector.
    send: upload({
      url: `${ECHO}/upload`,
      auth: bearer(token),
      input: z.object({ marker: z.string() }),
      file: ({ marker }) => ({ path: "report.txt", segments: [marker] }),
      contentType: "text/plain",
    }),
    reveal: command(["sh", "-c", 'echo "env=$TOKEN"; echo "file=$(cat "$TOKEN_FILE")"; cat report.txt'], {
      env: { TOKEN: token, TOKEN_FILE: token.path },
    }),
  },
}).createMachine({
  id: "effected",
  context: ({ input }) => input,
  initial: "committing",
  on: { noop: ".settled" },
  states: {
    committing: {
      invoke: {
        src: "commit",
        onDone: [
          { guard: ({ context }) => context.mode === "upload", target: "uploading" },
          { guard: ({ context }) => context.mode === "dirty", target: "editing" },
          { target: "revealing" },
        ],
      },
    },
    editing: { invoke: { src: "edit", onDone: "revealing" } },
    uploading: {
      invoke: {
        src: "send",
        input: ({ context }) => ({ marker: context.marker }),
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    revealing: {
      invoke: {
        src: "reveal",
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    settled: { type: "final" },
  },
  output: ({ context }: { context: BodyContext }) => context.output ?? { outcome: "none" },
});

export const machine = workspace(body, {
  input: door,
  repos: { app: SEED },
  spec: ({ input }) => ({ branch: `effected-${input.marker}` }),
});
