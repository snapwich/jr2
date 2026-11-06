// workflows/review.ts: a run that waits for a review of one pull request on GitHub. A review on
// GitHub answers the Gate, through a Hook of the `github` kind. The look reads the reviews of the
// pull request, so a review that came before the Gate opened, or while the Orchestrator was down,
// also answers it.

// #region imports
import { z } from "zod";
import type {} from "@jr2/orchestrator/hooks/github";
import { bearer, defineEvent, gate, http, jr2Setup, secret, type HttpOutput } from "@jr2/orchestrator";
// #endregion imports

const approve = defineEvent({
  name: "approve",
  description: "A reviewer approved the commit.",
  input: z.object({ by: z.string() }),
});
const changes = defineEvent({
  name: "changes",
  description: "A reviewer asked for changes.",
  input: z.object({ by: z.string(), notes: z.string() }),
});

type Meta = { owner: string; repo: string; pr: number; url: string; sha: string };

// The reviews of the pull request, from the GitHub API. The look reads them again, so the call is
// marked idempotent.
const reviews = http({
  method: "GET",
  url: "https://api.github.com",
  auth: bearer(secret("github-token")),
  headers: { accept: "application/vnd.github+json" },
  idempotent: true,
  input: z.object({ owner: z.string(), repo: z.string(), pr: z.number() }),
  request: ({ owner, repo, pr }) => ({ path: ["repos", owner, repo, "pulls", String(pr), "reviews"] }),
});

/** The last verdict on the commit, from the API's answer. */
function verdictOf(output: HttpOutput, meta: Meta) {
  if (output.outcome !== "response" || output.status !== 200 || output.body === undefined) return undefined;
  const list = JSON.parse(output.body) as Array<{
    state: string;
    commit_id: string;
    body: string | null;
    user: { login: string };
  }>;
  const last = list.filter((r) => r.commit_id === meta.sha && r.state !== "COMMENTED").at(-1);
  if (last?.state === "APPROVED") return { type: "approve" as const, by: last.user.login };
  if (last?.state === "CHANGES_REQUESTED")
    return { type: "changes" as const, by: last.user.login, notes: last.body ?? "" };
  return undefined;
}

// #region review
const review = gate({
  meta: z.object({ owner: z.string(), repo: z.string(), pr: z.number(), url: z.string(), sha: z.string() }),
  delivers: [approve, changes],
  hooks: {
    github: {
      "pull_request_review.submitted": ({ payload, meta }) => {
        // A review of another pull request, or of an older commit, is not for this Gate.
        if (payload.pull_request.html_url !== meta.url || payload.review.commit_id !== meta.sha) return undefined;
        if (payload.review.state === "approved") return { type: "approve", by: payload.review.user.login };
        if (payload.review.state === "changes_requested") {
          return { type: "changes", by: payload.review.user.login, notes: payload.review.body ?? "" };
        }
        return undefined;
      },
    },
  },
  look: {
    read: reviews,
    input: (meta) => ({ owner: meta.owner, repo: meta.repo, pr: meta.pr }),
    every: "10m",
    until: verdictOf,
  },
});
// #endregion review

type Input = Meta;

export const machine = jr2Setup({
  types: {} as { context: Input & { notes?: string }; input: Input },
  events: [approve, changes],
  actors: { review },
}).createMachine({
  id: "review",
  input: z.object({ owner: z.string(), repo: z.string(), pr: z.number(), url: z.string(), sha: z.string() }),
  context: ({ input }) => input,
  initial: "inReview",
  states: {
    inReview: {
      invoke: {
        src: "review",
        input: ({ context }) => ({
          meta: { owner: context.owner, repo: context.repo, pr: context.pr, url: context.url, sha: context.sha },
        }),
      },
      on: { approve: "approved", changes: "changesAsked" },
    },
    approved: { type: "final" },
    changesAsked: { type: "final" },
  },
});
