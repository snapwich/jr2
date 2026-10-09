// The kind tier's in-Turn HTTP workflow (ADR-0068, ADR-0067): a Menu-only Agent picks `call_echo`,
// the pick enters a child state that runs an `http` Effect in the Instance Effector, and the Turn
// stays open; the default answer — the Effect's output — comes back to the Agent on the same tool
// call. The echo server returns the Bearer the Effector built in every encoding, so the answer the
// MODEL reads is where ADR-0068's scrubbing claim is proved for the Agent: `[secret:echo-token]`, never the value.

import { z } from "zod";
import {
  agent,
  bearer,
  defineEvent,
  fromPick,
  http,
  jr2Setup,
  secret,
  type HostInjectedInput,
} from "@jr2/orchestrator";
import { advisor } from "./_agents.ts";

const callEcho = defineEvent({
  name: "call_echo",
  description: "Call the echo service; its answer comes back to you.",
  input: z.object({}),
});
const advise = defineEvent({ name: "advise", input: z.object({ summary: z.string() }) });

const echo = http({
  method: "POST",
  url: "http://echo.jr2-e2e-seed.svc/echo",
  auth: bearer(secret("echo-token")),
  input: z.object({ marker: z.string() }),
  request: ({ marker }) => ({ path: [marker], text: "asked by the advisor" }),
});

export const machine = jr2Setup({
  types: {} as { context: HostInjectedInput; input: HostInjectedInput },
  events: [callEcho, advise],
  actors: { advisor: agent(advisor), echo },
}).createMachine({
  id: "asked",
  context: ({ input }) => input,
  initial: "advising",
  states: {
    advising: {
      invoke: {
        src: "advisor",
        input: () => ({ prompt: "call the echo service, then advise", continue: true }),
      },
      initial: "rest",
      states: {
        rest: {},
        calling: {
          invoke: { src: "echo", input: fromPick(callEcho, () => ({ marker: "m-asked" })), onDone: "rest" },
        },
      },
      on: { call_echo: ".calling", advise: "advised" },
    },
    advised: { type: "final", output: { outcome: "advised" } },
  },
  output: ({ event }) => (event as { output?: { outcome: string } }).output,
});
