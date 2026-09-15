// The simplest j2 workflow: no Agent, no Workspace, no data plane at all. A Machine is free to "just
// respond to the request" with a plain actor (CONTEXT.md: a workflow need not spawn a Workspace) —
// this is that case, and the one workflow that runs end-to-end on a fresh instance before any Sandbox /
// Harness infrastructure exists. Filename `ping.ts` → workflow "ping".
//
// Shape: take the run input, invoke a plain `fromPromise` actor, fold its result into context, finish.
// `j2 run ping --input '{"message":"hi"}'` → the run reaches `done` and `j2 status` shows the reply.
//
// Module contract (ADR-0011/0015): one named export — `machine`. A workflow that accepts
// external events authors with `j2Setup({ events: [...] })`; ping accepts none, so plain
// xstate `setup()` is all it needs.
//
// The next step is a Machine the kit already ships (ADR-0054). `@j2/machines` exports `task` — one
// prompt, one Workspace, one human says done — and a Workflow is only the name an Instance
// registers a Machine under, so the whole of `workflows/task.ts` is:
//
//   import { customize } from "@j2/orchestrator";
//   import { task } from "@j2/machines";
//
//   export const machine = customize(task, {
//     repos: { target: { url: "https://github.com/you/repo.git" } },
//     agents: { coder: { model: "anthropic/claude-sonnet-4-6" } },
//   });
//
// A packaged Machine leaves the parts it cannot honestly fill OPEN: it does not know your
// repository and cannot pay for your model. `j2 up` refuses an Open part nobody bound and prints
// the `customize` line that binds it, so forgetting one stops the converge instead of spending
// money on a model you never chose. Add `@j2/machines` to this folder's dependencies when you
// write that file. `ping` stays Agent-free on purpose: it is the workflow that runs before any
// model provider, Harness, or Sandbox exists.

import { setup, assign, fromPromise } from "xstate";

type Input = { message?: string };
type Ctx = { message: string; reply?: string };

export const machine = setup({
  types: {} as { context: Ctx; input: Input },
  actors: {
    // A plain actor — no Harness, no Sandbox. Stands in for any non-Agent compute a workflow runs.
    respond: fromPromise<string, { message: string }>(async ({ input }) => `pong: ${input.message}`),
  },
}).createMachine({
  id: "ping",
  context: ({ input }) => ({ message: input.message ?? "ping" }),
  initial: "responding",
  states: {
    responding: {
      invoke: {
        src: "respond",
        input: ({ context }) => ({ message: context.message }),
        onDone: { target: "done", actions: assign({ reply: ({ event }) => event.output }) },
      },
    },
    done: { type: "final" },
  },
});
