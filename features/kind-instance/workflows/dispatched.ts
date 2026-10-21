// The kind tier's DISPATCH workflow (ADR-0071): a `dispatch` Effect with a target, so it runs in
// the Instance Effector, which holds the target's token as an Effect secret and calls the door of
// the Orchestrator the url names. The url names THIS Instance's own Orchestrator Service, so the
// foreign path — the wire start, the `jr2-dispatched-by` key, the poll of `GET /runs/<id>` — runs
// with no second cluster. Its callee is `called` in mode `slow`, whose http Effect the echo holds
// 20 s and counts by the run's marker: a second start of the callee would be a second request.
//
// The namespace is per scenario, so the url is read at load, in both places that load this file:
// the host's `jr2 up` (the Effector's plan, `effector.json`'s target) from `JR2_E2E_NAMESPACE`,
// which the World sets per scenario, and the Orchestrator's pod from `JR2_NAMESPACE`, the
// Deployment's fieldRef. The file's bytes are the same in every scenario, so the Assembly's hash is.
//
// The token is `self-token` (`../jr2.config.ts`): a literal from env that the scenario makes equal
// to the Instance token by writing the `jr2-instance` Secret before `jr2 up`, which then keeps it.

import { z } from "zod";
import { assign } from "xstate";
import {
  defineEvent,
  dispatch,
  jr2Setup,
  secret,
  type DispatchOutput,
  type HostInjectedInput,
} from "@jr2/orchestrator";

const namespace = process.env.JR2_NAMESPACE ?? process.env.JR2_E2E_NAMESPACE;
if (!namespace) {
  throw new Error(
    "workflows/dispatched.ts: no namespace — the Orchestrator's pod sets JR2_NAMESPACE, and the @kind World sets " +
      "JR2_E2E_NAMESPACE for the host's `jr2 up`",
  );
}

/** `called`'s door, as this slot claims it. */
const calledDoor = z.object({ mode: z.enum(["bearer", "inpath", "slow"]), marker: z.string() });

const door = z.object({ mode: z.enum(["slow"]), marker: z.string().regex(/^m-[a-z0-9]+$/) });
type Door = z.infer<typeof door>;
type Context = Door & { output?: DispatchOutput };

const unused = defineEvent({ name: "noop", input: z.object({}) });

export const machine = jr2Setup({
  types: {} as { context: Context; input: HostInjectedInput & Door; output: DispatchOutput | { outcome: "none" } },
  events: [unused],
  actors: {
    call: dispatch("called", {
      input: calledDoor,
      wait: true,
      // The callee's slow call is 20 s, and an Orchestrator restart lands inside it.
      timeout: "4m",
      target: { url: `http://jr2-orchestrator.${namespace}.svc:4000`, token: secret("self-token") },
    }),
  },
}).createMachine({
  id: "dispatched",
  input: door,
  context: ({ input }) => ({ mode: input.mode, marker: input.marker }),
  initial: "calling",
  on: { noop: ".settled" },
  states: {
    calling: {
      invoke: {
        src: "call",
        input: ({ context }) => ({ mode: context.mode, marker: context.marker }),
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    settled: { type: "final" },
  },
  output: ({ context }) => context.output ?? { outcome: "none" },
});
