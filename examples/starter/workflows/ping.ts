// The simplest j2 workflow: no Agent, no Workspace, no data plane at all. A Machine is free to "just
// respond to the request" with a plain actor (CONTEXT.md: a workflow need not spawn a Workspace) —
// this is that case, and the one workflow that runs end-to-end under `j2 dev` before any Sandbox /
// Harness infrastructure exists. Filename `ping.ts` → workflow "ping".
//
// Shape: take the run input, invoke a plain `fromPromise` actor, fold its result into context, finish.
// `j2 run ping --input '{"message":"hi"}'` → the run reaches `done` and `j2 status` shows the reply.
//
// Module contract (ADR-0011): named exports — `machine` plus an `events` manifest declaring the
// events external callers may deliver to this workflow (defineEvent). Ping accepts none.

import { setup, assign, fromPromise } from "xstate";

type Input = { message?: string };
type Ctx = { message: string; reply?: string };

export const events = [];

export const machine = setup({
  types: {} as { context: Ctx; input: Input },
  actors: {
    // A plain actor — no flue client, no Sandbox. Stands in for any non-Agent compute a workflow runs.
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
