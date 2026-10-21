// An e2e fixture for the Console's start-run form (ADR-0033): the one fixture that DECLARES its
// run input — `createMachine({ input: z.object(...) })` — so `GET /workflows/intake` serves a real
// JSON Schema and the Console renders a typed field ("subject *", a text input), never the
// no-schema raw-JSON textarea. Like `loop`, it parks in `working` until someone acts, so the run the
// browser starts stays visible in the rail as a live run. Filename `intake.ts` → workflow "intake".
//
// It is also the callee of the `dispatcher` fixture (ADR-0071), which is why it can end: its
// `finish` Gate takes a note, and the run's output is the subject it was started with and that note.
// A `dispatch` with `wait` settles with that output, so a step can tell the callee's output from
// anything the caller made up.

import { assign } from "xstate";
import { z } from "zod";
import { defineEvent, jr2Setup } from "@jr2/orchestrator";

const finish = defineEvent({ name: "finish", input: z.object({ note: z.string() }) });

type Input = { subject: string };
type Ctx = { subject: string; note?: string };

export const machine = jr2Setup({
  types: {} as { context: Ctx; input: Input; output: { subject: string; note?: string } },
  events: [finish],
}).createMachine({
  id: "intake",
  input: z.object({ subject: z.string() }),
  context: ({ input }) => ({ subject: input.subject }),
  initial: "working",
  states: {
    working: {
      invoke: { src: "gate", input: { gate: "finish", accepts: [finish.name] } },
      on: { finish: { target: "done", actions: assign({ note: ({ event }) => event.note }) } },
    },
    done: { type: "final" },
  },
  output: ({ context }) => ({ subject: context.subject, note: context.note }),
});
