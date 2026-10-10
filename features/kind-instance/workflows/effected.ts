// The kind tier's SANDBOX EFFECTOR workflow (ADR-0067, ADR-0068): Effects that run in the
// Workspace's Sandbox Effector, with no Agent. The body's final output IS the Effect's output, and
// the wrapper forwards it, so a scenario reads what the Machine routed on.
//
//   upload   a file the body wrote and committed in the Worktree, PUT to the echo with
//            `bearer(secret("echo-token"))`: the Effector opens it beneath the Worktree and sends it
//   takeover the body commits, then waits on its `hold` Gate while the step takes the Effector's
//            port from the Harness container (B2: the Effector is down, a process the Agent could
//            start binds :8082); the step's answer runs the same upload, whose start reaches that
//            process signed and is answered by it unsigned: the Effect settles `unknown`
//
// No credentialed command: `jr2 up` refuses one (ADR-0068) until its child is kept from the
// Effector's mount, and a refusal here would stop the whole tier's `jr2 up`.
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

const door = z.object({
  mode: z.enum(["upload", "takeover"]),
  marker: z.string().regex(/^m-[a-z0-9]+$/),
});
type Door = z.infer<typeof door>;
type BodyInput = Workspaced<HostInjectedInput & Door, "app">;
type BodyContext = BodyInput & { output?: unknown };

const unused = defineEvent({ name: "noop", input: z.object({}) });
const go = defineEvent({ name: "go", input: z.object({}) });
const token = secret("echo-token");
const GIT = ["-c", "user.name=jr2 e2e", "-c", "user.email=e2e@jr2.test"];

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput; output: unknown },
  events: [unused, go],
  actors: {
    // In the Harness container: the Agent's own work, committed.
    commit: command([
      "sh",
      "-c",
      `printf 'report of the run\\n' > report.txt && git add report.txt && git ${GIT.join(" ")} commit -q -m report`,
    ]),
    // In the Sandbox Effector.
    send: upload({
      url: `${ECHO}/upload`,
      auth: bearer(token),
      input: z.object({ marker: z.string() }),
      file: ({ marker }) => ({ path: "report.txt", segments: [marker] }),
      contentType: "text/plain",
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
        onDone: [{ guard: ({ context }) => context.mode === "takeover", target: "holding" }, { target: "uploading" }],
      },
    },
    holding: { invoke: { src: "gate", id: "hold" }, on: { go: "uploading" } },
    uploading: {
      invoke: {
        src: "send",
        input: ({ context }) => ({ marker: context.marker }),
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
