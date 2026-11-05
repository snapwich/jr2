// The @kind tier's hooked Gate (ADR-0011, ADR-0068): a Gate slot that hears three Hooks of the kind
// instance — two with a `mac` verifier, so the real Instance Effector checks each signature, and
// one with a `token` verifier, which the Orchestrator checks against the digest that `jr2 up`
// mounted — and that looks, with an `http` read in that Effector, for the fact it waits for.
//
//   deliver  the look never gives the event: only a delivery answers the Gate. `forge` (the
//            `github` kind) delivers a review whose body is the run's marker; `chat` (the
//            Slack-shaped kind of `_chat.ts`) delivers a click whose value is the marker, and the
//            Gate's reply is the text of the click's follow-up; `lab` (the `gitlab` kind)
//            delivers an approval whose url is the marker.
//   look     the look reads the echo with the run's marker in its path, and the answer is the
//            event: no delivery comes. The echo counts the read by the marker.
//
// The marker is the run's (`m-…`, from the door), so a delivery answers this run's Gate alone.

import { z } from "zod";
import { assign } from "xstate";
import type {} from "@jr2/hooks/github";
import type {} from "@jr2/hooks/gitlab";
import type {} from "./_chat.ts";
import { defineEvent, gate, http, jr2Setup, type HostInjectedInput } from "@jr2/orchestrator";

/** The echo server's in-cluster address (`steps/seed.ts`). */
const ECHO = "http://echo.jr2-e2e-seed.svc";

const approve = defineEvent({
  name: "approve",
  description: "A reviewer approved, or the look found the fact.",
  input: z.object({ by: z.string() }),
});

const door = z.object({ mode: z.enum(["deliver", "look"]), marker: z.string().regex(/^m-[a-z0-9]+$/) });
type Door = z.infer<typeof door>;
type Meta = Door;

// The look's read: idempotent, so the look may read it again after a restore and every `every`.
const looked = http({
  method: "GET",
  url: `${ECHO}/look`,
  idempotent: true,
  input: z.object({ marker: z.string() }),
  request: ({ marker }) => ({ path: [marker] }),
});

const review = gate({
  meta: door,
  delivers: [approve],
  hooks: {
    github: {
      "pull_request_review.submitted": ({ payload, meta }) =>
        payload.review.body === meta.marker && payload.review.state === "approved"
          ? { type: "approve", by: payload.review.user.login }
          : undefined,
    },
    gitlab: {
      "merge_request.approved": ({ payload, meta }) =>
        payload.object_attributes.url === meta.marker ? { type: "approve", by: payload.user.username } : undefined,
    },
    chat: {
      "block_actions.approve": ({ payload, meta }) =>
        payload.actions.some((a) => a.value === meta.marker) ? { type: "approve", by: payload.user.id } : undefined,
    },
  },
  look: {
    read: looked,
    input: (meta: Meta) => ({ marker: meta.marker }),
    every: "1m",
    // The echo's answer names the path it read, so the answer is this run's own read.
    until: (output, meta: Meta) =>
      meta.mode === "look" &&
      output.outcome === "response" &&
      output.status === 200 &&
      String(output.body ?? "").includes(`/look/${meta.marker}`)
        ? { type: "approve", by: "look" }
        : undefined,
  },
  reply: (outcome) => (outcome.state === "delivered" ? `approved ${outcome.run}` : undefined),
});

export const machine = jr2Setup({
  types: {} as { context: HostInjectedInput & Door & { by?: string }; input: HostInjectedInput & Door },
  events: [approve],
  actors: { review },
}).createMachine({
  id: "hooked",
  input: door,
  context: ({ input }) => input,
  initial: "waiting",
  states: {
    waiting: {
      invoke: { src: "review", input: ({ context }) => ({ meta: { mode: context.mode, marker: context.marker } }) },
      on: { approve: { target: "approved", actions: assign({ by: ({ event }) => event.by }) } },
    },
    approved: { type: "final" },
  },
  output: ({ context }) => ({ by: context.by ?? "" }),
});
