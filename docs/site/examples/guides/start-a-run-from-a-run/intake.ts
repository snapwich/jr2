import { assign } from "xstate";
import { z } from "zod";
import { defineEvent, dispatch, jr2Setup, type DispatchOutput } from "@jr2/orchestrator";

// The run input of the triage Workflow, as this slot claims it. `jr2 up` compares it with the
// input that triage declares.
const triageInput = z.object({ request: z.string() });

// The Gate takes these events. A person, a script or a webhook reports a request.
const report = defineEvent({
  name: "report",
  description: "Report a request. A run of triage starts for it.",
  input: triageInput,
});
const close = defineEvent({
  name: "close",
  description: "Stop the intake. The runs that it started continue.",
  input: z.object({}),
});

type Context = { request?: string; started: string[]; last?: DispatchOutput };

export const machine = jr2Setup({
  types: {} as { context: Context },
  events: [report, close],
  actors: {
    // Each invoke of this slot starts one run of triage. That run is a run of its own.
    triage: dispatch("triage", { input: triageInput }),
  },
}).createMachine({
  id: "intake",
  context: { started: [] },
  initial: "listening",
  states: {
    listening: {
      invoke: { src: "gate" },
      on: {
        report: { target: "starting", actions: assign({ request: ({ event }) => event.request }) },
        close: "closed",
      },
    },
    starting: {
      invoke: {
        src: "triage",
        input: ({ context }) => ({ request: context.request ?? "" }),
        // Each outcome is output: started, refused, unreachable or unknown.
        onDone: {
          target: "listening",
          actions: assign({
            last: ({ event }) => event.output,
            started: ({ context, event }) =>
              event.output.outcome === "started" ? [...context.started, event.output.run] : context.started,
          }),
        },
      },
    },
    closed: { type: "final" },
  },
});
