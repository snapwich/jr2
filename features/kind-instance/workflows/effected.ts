// The kind tier's SANDBOX EFFECTOR workflow (ADR-0067, ADR-0068): Effects that run in the
// Workspace's Sandbox Effector, with no Agent. The body's final output IS the Effect's output, and
// the wrapper forwards it, so a scenario reads what the Machine routed on.
//
//   file-body an `http` whose body is a file the body wrote and committed in the Worktree
//             (`body: file(...)`, ADR-0067), PUT to the echo with `bearer(secret("echo-token"))`: the
//             Sandbox Effector opens it beneath the Worktree and sends it. The body first waits on its
//             `hold` Gate, so the step reads the pod while it is live
//   env       a credentialed command that prints its secret from env and from `.path`, then the
//             files of the commit it runs against: the output names the secret and holds no form of it
//   dirty     the body leaves an edit uncommitted, then the same command: the answer is `dirty`, and
//             the command saw the commit, not the edit
//   key       a credentialed command whose argv runs a committed script — the Agent's code — that
//             reads the Effector's key from a child of its child: Landlock confines the child, so it
//             ends with a permission error and the answer carries no key (ADR-0068)
//   takeover  the body commits, then waits on its `hold` Gate while the step takes the Effector's
//             port from the Harness container (ADR-0068: the Effector is down, a process the Agent could
//             start binds :8082); the step's answer runs the same file-body http, whose start reaches that
//             process signed and is answered by it unsigned: the Effect settles `unknown`
//   stop      a credentialed command that sleeps, beside a `cut` Gate: the step's answer exits the
//             state, the Orchestrator sends the Effector a signed DELETE, and the Effector ends the
//             command's process group (ADR-0067). The body then waits on its `after` Gate, so the
//             step reads the Effector container while the pod is live
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
  fail,
  file,
  http,
  jr2Setup,
  secret,
  workspace,
  type HostInjectedInput,
  type Workspaced,
} from "@jr2/orchestrator";
/** The seed Repo (`steps/seed.ts`), bound as every kind workflow binds it. */
const SEED = { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" };

const ECHO = "http://echo.jr2-e2e-seed.svc";

const door = z.object({
  mode: z.enum(["file-body", "env", "dirty", "key", "takeover", "stop"]),
  marker: z.string().regex(/^m-[a-z0-9]+$/),
});
type Door = z.infer<typeof door>;
type BodyInput = Workspaced<HostInjectedInput & Door, "app">;
type BodyContext = BodyInput & { output?: unknown };

const unused = defineEvent({ name: "noop", input: z.object({}) });
const go = defineEvent({ name: "go", input: z.object({}) });
const token = secret("echo-token");
const sendInput = z.object({ marker: z.string() });
const GIT = ["-c", "'user.name=jr2 e2e'", "-c", "user.email=e2e@jr2.test"];

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput; output: unknown },
  events: [unused, go],
  actors: {
    fail: fail(),
    // In the Harness container: the Agent's own work, committed.
    commit: command([
      "sh",
      "-c",
      `printf 'report of the run\\n' > report.txt && printf 'sh -c "cat /run/jr2/effector/key"\\n' > leak.sh && ` +
        `git add report.txt leak.sh && git ${GIT.join(" ")} commit -q -m report`,
    ]),
    // In the Harness container: an edit left uncommitted.
    edit: command(["sh", "-c", "printf 'edited, not committed\\n' > report.txt"]),
    // In the Sandbox Effector: its body is a Worktree file, which places it there (ADR-0067).
    send: http({
      method: "PUT",
      url: `${ECHO}/file-body`,
      auth: bearer(token),
      input: sendInput,
      body: file<typeof sendInput>("report.txt", { segments: ({ marker }) => [marker], contentType: "text/plain" }),
    }),
    reveal: command(["sh", "-c", 'echo "env=$TOKEN"; echo "file=$(cat "$TOKEN_FILE")"; cat report.txt'], {
      env: { TOKEN: token, TOKEN_FILE: token.path },
    }),
    // The author's argv runs the Agent's committed script.
    leak: command(["sh", "leak.sh"], { env: { TOKEN: token } }),
    // A credentialed command that runs until its state exits: `sleep 7213` is what the step looks
    // for among the Effector container's processes.
    linger: command(["sleep", "7213"], { env: { TOKEN: token } }),
  },
}).createMachine({
  id: "effected",
  context: ({ input }) => input,
  initial: "committing",
  on: { "workspace.lost": { target: ".lost" }, noop: ".settled" },
  states: {
    committing: {
      invoke: {
        src: "commit",
        onDone: [
          { guard: ({ context }) => context.mode === "env", target: "revealing" },
          { guard: ({ context }) => context.mode === "dirty", target: "editing" },
          { guard: ({ context }) => context.mode === "key", target: "leaking" },
          { guard: ({ context }) => context.mode === "stop", target: "lingering" },
          { target: "holding" },
        ],
      },
    },
    editing: { invoke: { src: "edit", onDone: "revealing" } },
    revealing: {
      invoke: {
        src: "reveal",
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    leaking: {
      invoke: {
        src: "leak",
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    // The Gate's answer exits the state while the command runs: its stop (ADR-0067).
    lingering: {
      invoke: [
        { src: "linger", onDone: "after" },
        { src: "gate", id: "cut" },
      ],
      on: { go: "after" },
    },
    after: { invoke: { src: "gate", id: "after" }, on: { go: "settled" } },
    holding: { invoke: { src: "gate", id: "hold" }, on: { go: "sending" } },
    sending: {
      invoke: {
        src: "send",
        input: ({ context }) => ({ marker: context.marker }),
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    settled: { type: "final" },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
  },
  output: ({ context }: { context: BodyContext }) => context.output ?? { outcome: "none" },
});

export const machine = workspace(body, {
  input: door,
  repos: { app: SEED },
  spec: ({ input }) => ({ branch: `effected-${input.marker}` }),
});
