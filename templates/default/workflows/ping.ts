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
// An Agent is the next step, and it is one more entry in this same `actors` map — a Machine CARRIES
// its Agents as actor slots (ADR-0049):
//
//   actors: { coder: agent({ model: "anthropic/claude-sonnet-4-6", instructions: "…" }) }
//   states: { coding: { invoke: { src: "coder", input: { prompt: "…" } } } }
//
// The slot key IS the Agent's name; there is no `agents/` folder and no roster anywhere, and the
// definition rides each Turn. `j2 up` finds it by walking this Machine — and typechecks the folder
// first, so a slot name that does not exist is a compile error, never a failed run (ADR-0050).
// `ping` stays Agent-free on purpose: it is the workflow that runs before any model provider,
// Harness, or Sandbox exists.

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
