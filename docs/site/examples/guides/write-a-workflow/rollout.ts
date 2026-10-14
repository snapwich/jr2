import { assign, emit } from "xstate";
import { z } from "zod";
import { defineEvent, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";

// The door: the input that starts a run. jr2 checks each start against this schema.
const runInput = z.object({
  service: z.string().min(1).describe("The service to roll out."),
  version: z.string().min(1).describe("The version to roll out."),
  // A field with a default is optional for the caller. The run starts with the default.
  canaryPercent: z.number().int().min(1).max(50).default(10).describe("The percent of hosts in the canary."),
});
type RunInput = z.infer<typeof runInput>;

// jr2 adds instanceId to the input of the root Machine of a run. No caller sends it.
type Input = RunInput & HostInjectedInput;
type Context = Input & { reason?: string };

// The Vocabulary: the events that this Machine takes. Here, a person sends them to the Gate.
const promote = defineEvent({
  name: "promote",
  description: "The canary is healthy. Roll out the version to all hosts.",
  input: z.object({}),
});
const rollBack = defineEvent({
  name: "roll_back",
  description: "Stop the rollout. Say why.",
  input: z.object({ reason: z.string() }),
});

// jr2 reads only this export. The file name, rollout.ts, gives the Workflow its name: rollout.
export const machine = jr2Setup({
  types: {} as {
    input: Input;
    context: Context;
    emitted: { type: "decided"; promoted: boolean };
  },
  events: [promote, rollBack],
}).createMachine({
  id: "rollout",
  input: runInput,
  context: ({ input }) => ({ ...input }),
  initial: "canary",
  states: {
    // A Gate. The run waits here until a person sends promote or roll_back.
    canary: {
      invoke: {
        src: "gate",
        input: ({ context }) => ({
          meta: {
            service: context.service,
            version: context.version,
            canaryPercent: context.canaryPercent,
            instanceId: context.instanceId,
          },
        }),
      },
      on: {
        promote: { target: "promoted", actions: emit({ type: "decided", promoted: true }) },
        roll_back: {
          target: "rolledBack",
          actions: [assign({ reason: ({ event }) => event.reason }), emit({ type: "decided", promoted: false })],
        },
      },
    },
    promoted: { type: "final" },
    rolledBack: { type: "final" },
  },
});
