// A PACKAGED Machine with an Open secret (ADR-0054), as a package would ship it: an `http` Effect whose
// Bearer is `secret(open)` — the package cannot know which secret its composer spends — inside a
// `workspace()`, so the run has an Agent's container that must hold no form of it. The body waits on
// its `hold` Gate first, so a step can read that container while the pod is live, then calls the
// echo; its final output IS the Effect's. `opensecret.ts` is the composer's file that binds it.

import { z } from "zod";
import { assign } from "xstate";
import {
  bearer,
  defineEvent,
  fail,
  http,
  jr2Setup,
  open,
  secret,
  workspace,
  type HostInjectedInput,
  type Workspaced,
  isReady,
  worktree,
} from "@jr2/orchestrator";

const ECHO = "http://echo.jr2-e2e-seed.svc";
const SEED = { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" };

const door = z.object({ mode: z.enum(["bearer"]), marker: z.string().regex(/^m-[a-z0-9]+$/) });
type Door = z.infer<typeof door>;
type BodyInput = Workspaced<HostInjectedInput & Door, "app">;
type BodyContext = BodyInput & { output?: unknown };

const unused = defineEvent({ name: "noop", input: z.object({}) });
const go = defineEvent({ name: "go", input: z.object({}) });
const marked = z.object({ marker: z.string() });

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput; output: unknown },
  events: [unused, go],
  actors: {
    cut: worktree(),
    fail: fail(),
    notify: http({
      method: "POST",
      url: `${ECHO}/echo`,
      auth: bearer(secret(open)),
      input: marked,
      request: ({ marker }) => ({ path: [marker], text: "hello from a packaged Machine" }),
    }),
  },
}).createMachine({
  id: "notifier",
  context: ({ input }) => input,
  initial: "cutting",
  on: { "workspace.lost": { target: ".lost" }, noop: ".settled" },
  states: {
    cutting: {
      invoke: {
        src: "cut",
        input: ({ context }) => ({
          path: `/work/app/opensecret-${context.marker}`,
          branch: `opensecret-${context.marker}`,
        }),
        onDone: [{ guard: ({ event }) => isReady(event.output), target: "holding" }, { target: "notCut" }],
      },
    },
    notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
    holding: { invoke: { src: "gate", id: "hold" }, on: { go: "notifying" } },
    notifying: {
      invoke: {
        src: "notify",
        input: ({ context }) => ({ marker: context.marker }),
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    settled: { type: "final" },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
  },
  output: ({ context }: { context: BodyContext }) => context.output ?? { outcome: "none" },
});

export const notifier = workspace(body, {
  input: door,
  repos: { app: SEED },
});
