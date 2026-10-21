// An e2e fixture for the `dispatch` Effect (ADR-0071), in the mechanics tier: a run that starts a
// run of `intake` in this Orchestrator's own process — no target, so no wire and no token — and
// copies what the Effect settled with into its output. Filename `dispatcher.ts` → workflow
// "dispatcher". Its callee is the `intake` fixture, which must be in the same Assembly: the publish
// door refuses a dispatch whose name no Workflow there has.
//
//   intake   start `intake` and settle `started` once the run host has accepted it
//   wait     the same start, with `wait`: settle when that run ends, with its status and output
//   bad      start `intake` with a body its door refuses: the refusal is the Effect's output
//
// `hold` parks the run on its `go` Gate before it dispatches, so a step can publish a new Assembly
// between the start and the dispatch: a dispatch resolves against the CURRENT Assembly, not the
// one its caller holds (ADR-0069, ADR-0071).
//
// One slot per callee and form: `wait` is static, so the waiting start is a slot of its own.

import { assign, type AnyStateMachine } from "xstate";
import { z } from "zod";
import { defineEvent, dispatch, jr2Setup, type DispatchOutput, type HostInjectedInput } from "@jr2/orchestrator";

/** What the slot claims about `intake`'s door — the same field, so `jr2 up` and the publish door
 * compare it and find it compatible. */
const intakeDoor = z.object({ subject: z.string() });

const door = z.object({
  target: z.enum(["intake", "wait", "bad"]),
  subject: z.string().optional(),
  hold: z.boolean().optional(),
});
type Door = z.infer<typeof door>;
type Context = Door & { result?: DispatchOutput };

const go = defineEvent({ name: "go", input: z.object({}) });

// Annotated: the Effect logic's inferred type names xstate's actor system, which xstate does not
// export, so this package's declaration emit cannot spell it (TS2742). The loader reads the value.
export const machine: AnyStateMachine = jr2Setup({
  types: {} as {
    context: Context;
    input: HostInjectedInput & Door;
    output: DispatchOutput | { outcome: "none" };
  },
  events: [go],
  actors: {
    intake: dispatch("intake", { input: intakeDoor }),
    wait: dispatch("intake", { input: intakeDoor, wait: true }),
    // No `input` schema: the slot makes no claim about the door, so nothing compares the body
    // before the door does — and the door refuses it.
    bad: dispatch("intake"),
  },
}).createMachine({
  id: "dispatcher",
  input: door,
  context: ({ input }) => ({ target: input.target, subject: input.subject, hold: input.hold }),
  initial: "starting",
  states: {
    starting: {
      always: [{ guard: ({ context }) => context.hold === true, target: "holding" }, { target: "choosing" }],
    },
    holding: {
      invoke: { src: "gate", input: { gate: "go", accepts: [go.name] } },
      on: { go: "choosing" },
    },
    choosing: {
      always: [
        { guard: ({ context }) => context.target === "intake", target: "intake" },
        { guard: ({ context }) => context.target === "wait", target: "wait" },
        { target: "bad" },
      ],
    },
    intake: {
      invoke: {
        src: "intake",
        input: ({ context }) => ({ subject: context.subject ?? "from the dispatcher" }),
        onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) },
      },
    },
    wait: {
      invoke: {
        src: "wait",
        input: ({ context }) => ({ subject: context.subject ?? "from the dispatcher" }),
        onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) },
      },
    },
    bad: {
      invoke: {
        src: "bad",
        // A number where the door wants a string: the door's 400, as output.
        input: () => ({ subject: 5 }),
        onDone: { target: "done", actions: assign({ result: ({ event }) => event.output }) },
      },
    },
    done: { type: "final" },
  },
  output: ({ context }) => context.result ?? { outcome: "none" },
});
