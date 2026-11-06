// An e2e fixture for the Hook's door (ADR-0011, ADR-0078): a review Gate that hears three Hook
// kinds, one for each verifier — `gitlab` (`token`), `discord` (`ed25519`) and `github` (`mac`).
// Each handler matches the delivery against the Gate's meta, the pull request's url, and gives
// `approve` with the party that acted. A `slack` command or click approves it too, and the Gate's
// `reply` gives the text that the person who acted reads (ADR-0011). Filename `forge.ts` →
// workflow "forge".

import { z } from "zod";
import type {} from "@jr2/orchestrator/hooks/discord";
import type {} from "@jr2/orchestrator/hooks/github";
import type {} from "@jr2/orchestrator/hooks/gitlab";
import type {} from "@jr2/orchestrator/hooks/slack";
import { defineEvent, gate, jr2Setup } from "@jr2/orchestrator/internal";

const approve = defineEvent({
  name: "approve",
  description: "The change is approved.",
  input: z.object({ by: z.string() }),
});

const review = gate({
  meta: z.object({ pr: z.string() }),
  delivers: [approve],
  hooks: {
    gitlab: {
      "merge_request.approved": ({ payload, meta }) =>
        payload.object_attributes.url === meta.pr ? { type: "approve", by: payload.user.username } : undefined,
    },
    discord: {
      "application_command.approve": ({ payload, meta }) =>
        payload.data.options?.some((o) => o.name === "pr" && o.value === meta.pr)
          ? { type: "approve", by: payload.member?.user.id ?? payload.user?.id ?? "unknown" }
          : undefined,
    },
    github: {
      "pull_request_review.submitted": ({ payload, meta }) =>
        payload.pull_request.html_url === meta.pr && payload.review.state === "approved"
          ? { type: "approve", by: payload.review.user.login }
          : undefined,
    },
    slack: {
      "slash_command./jr2": ({ payload, meta }) =>
        payload.text === `approve ${meta.pr}` ? { type: "approve", by: payload.user_id } : undefined,
      "block_actions.approve": ({ payload, meta }) =>
        payload.actions[0]?.value === meta.pr ? { type: "approve", by: payload.user.id } : undefined,
    },
  },
  reply: (o, { meta }) =>
    o.state === "delivered" ? `${meta.pr} is approved by ${o.event.by}.` : `${meta.pr}: not taken (${o.reason}).`,
  // A review verdict is a fact that a look could read; this tier reads none, so the Gate waits for
  // a delivery or a person.
  look: "none",
});

type Input = { pr: string };

export const machine = jr2Setup({
  types: {} as { context: Input; input: Input },
  events: [approve],
  actors: { review },
}).createMachine({
  id: "forge",
  input: z.object({ pr: z.string() }),
  context: ({ input }) => ({ pr: input.pr }),
  initial: "inReview",
  states: {
    inReview: {
      invoke: { src: "review", input: ({ context }) => ({ meta: { pr: context.pr } }) },
      on: { approve: "merged" },
    },
    merged: { type: "final" },
  },
});
