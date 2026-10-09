// The kind tier's HTTP workflow (ADR-0068): an `http` Effect in the Instance Effector, with no Agent
// and no Workspace. The echo server the suite serves in-cluster (`steps/seed.ts`) answers with every
// header and the url it received, each in the encodings the Effector scrubs — so what comes back is
// the B3 proof: the Bearer it built, base64(user:password), the url with the secret in its path, and
// a header it filled from the secret, each named `[secret:echo-token]` and never the value. The
// body's final output IS the Effect's.
//
//   bearer   POST /echo/<marker> with `Authorization: Bearer <echo-token>` and a text body
//   inpath   GET /bot<echo-token>/send/<marker> with `basic("bot", echo-token)` and
//            `x-api-key: Key <echo-token>`
//   slow     POST /slow/<marker>/20 — the echo holds it 20 s, so an Orchestrator restart or an
//            Effector rollout lands while it runs; the echo counts each request by its marker
//
// The marker is the run's (`m-…`, from the door), so a step can ask the echo how many requests
// carried it: one send, whatever restarted.

import { z } from "zod";
import { assign } from "xstate";
import {
  basic,
  bearer,
  defineEvent,
  http,
  jr2Setup,
  secret,
  text,
  type HostInjectedInput,
  type HttpOutput,
} from "@jr2/orchestrator";

/** The echo server's in-cluster address (`steps/seed.ts`). Plain HTTP: the Effector holds no
 * Custodian, and a pod-local echo needs no TLS to prove what comes back. */
const ECHO = "http://echo.jr2-e2e-seed.svc";

const door = z.object({ mode: z.enum(["bearer", "inpath", "slow"]), marker: z.string().regex(/^m-[a-z0-9]+$/) });
type Door = z.infer<typeof door>;
type Context = HostInjectedInput & Door & { output?: HttpOutput };

const unused = defineEvent({ name: "noop", input: z.object({}) });
const token = secret("echo-token");
const marked = z.object({ marker: z.string() });

export const machine = jr2Setup({
  types: {} as { context: Context; input: HostInjectedInput & Door; output: HttpOutput | { outcome: "none" } },
  events: [unused],
  actors: {
    bearer: http({
      method: "POST",
      url: `${ECHO}/echo`,
      auth: bearer(token),
      input: marked,
      request: ({ marker }) => ({ path: [marker], text: "hello from the Effector" }),
    }),
    inpath: http({
      method: "GET",
      url: text`${ECHO}/bot${token}/send`,
      headers: { "x-api-key": text`Key ${token}` },
      auth: basic("bot", token),
      input: marked,
      request: ({ marker }) => ({ path: [marker] }),
    }),
    slow: http({
      method: "POST",
      url: `${ECHO}/slow`,
      auth: bearer(token),
      timeout: "2m",
      input: marked,
      request: ({ marker }) => ({ path: [marker, "20"] }),
    }),
  },
}).createMachine({
  id: "called",
  input: door,
  context: ({ input }) => input,
  initial: "choosing",
  on: { noop: ".settled" },
  states: {
    choosing: {
      always: [
        { guard: ({ context }) => context.mode === "bearer", target: "bearer" },
        { guard: ({ context }) => context.mode === "inpath", target: "inpath" },
        { target: "slow" },
      ],
    },
    bearer: {
      invoke: {
        src: "bearer",
        input: ({ context }) => ({ marker: context.marker }),
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    inpath: {
      invoke: {
        src: "inpath",
        input: ({ context }) => ({ marker: context.marker }),
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    slow: {
      invoke: {
        src: "slow",
        input: ({ context }) => ({ marker: context.marker }),
        onDone: { target: "settled", actions: assign({ output: ({ event }) => event.output }) },
      },
    },
    settled: { type: "final" },
  },
  output: ({ context }) => context.output ?? { outcome: "none" },
});
