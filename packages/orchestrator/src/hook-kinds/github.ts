// `@jr2/orchestrator/hooks/github`: jr2's GitHub kind. It imports `@jr2/orchestrator/hooks` and nothing more of jr2, as a
// kind from another package does.

import { z } from "zod";
import { defineHookKind, json, type HookRequest } from "./index.ts";

const user = z.looseObject({ login: z.string() });

/**
 * The schema of each event key. Each names only the fields that handlers read; a loose object keeps
 * the rest. A value that GitHub can extend (a review's `state`) is a string, not an enum, so a new
 * value fails no parse.
 */
export const githubEvents = {
  "pull_request_review.submitted": z.looseObject({
    review: z.looseObject({
      /** Lowercase in a webhook: `approved`, `changes_requested`, `commented`. */
      state: z.string(),
      body: z.string().nullable(),
      user,
      commit_id: z.string(),
    }),
    pull_request: z.looseObject({ html_url: z.string() }),
  }),
  "issue_comment.created": z.looseObject({
    comment: z.looseObject({ body: z.string(), user, author_association: z.string() }),
    issue: z.looseObject({
      /** Only when the issue is a pull request. */
      pull_request: z.looseObject({ html_url: z.string() }).optional(),
    }),
  }),
  "check_suite.completed": z.looseObject({
    check_suite: z.looseObject({
      head_sha: z.string(),
      /** `success`, `failure`, `neutral`, `cancelled`, `timed_out`, …; `null` while it runs. */
      conclusion: z.string().nullable(),
    }),
  }),
};

const header = (req: HookRequest, name: string): string => {
  const v = req.headers[name];
  if (v === undefined || v === "") throw new Error(`no ${name} header`);
  return v;
};

/**
 * A GitHub repository, organization or App webhook, with the content type `application/json`. (A
 * webhook with the content type `application/x-www-form-urlencoded` gets 400.)
 * - verifier: `mac`, HMAC-SHA256 of the raw body, `X-Hub-Signature-256: sha256=<hex>`.
 * - handshake: the `ping` event (sent when the webhook is made) gets an empty 200.
 * - event key: `<X-GitHub-Event>.<action>`, or `<X-GitHub-Event>` when the body has no action.
 * - delivery id: `X-GitHub-Delivery`. `onBehalfOf`: `sender.login`.
 * - answer: the outcome (the default). No person reads it.
 */
export const github = defineHookKind({
  api: 1,
  id: "github",
  events: githubEvents,
  verify: {
    mac: {
      alg: "sha256",
      signed: (req) => {
        const sig = req.headers["x-hub-signature-256"];
        if (!sig?.startsWith("sha256=")) return { unsigned: "no X-Hub-Signature-256 header" };
        return { bytes: [req.body], signature: { hex: sig.slice("sha256=".length) } };
      },
    },
  },
  read: (req) => {
    const event = header(req, "x-github-event");
    if (event === "ping") return { handshake: { body: null } };
    const p = json(req) as { readonly action?: unknown; readonly sender?: { readonly login?: unknown } } | null;
    const action = typeof p?.action === "string" && p.action !== "" ? p.action : undefined;
    const by = p?.sender?.login;
    return {
      key: action ? `${event}.${action}` : event,
      id: header(req, "x-github-delivery"),
      payload: p,
      ...(typeof by === "string" && by !== "" ? { onBehalfOf: by } : {}),
    };
  },
});

declare module "./index.ts" {
  interface HookKinds {
    github: typeof github;
  }
}
