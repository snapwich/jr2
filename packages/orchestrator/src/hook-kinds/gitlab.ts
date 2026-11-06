// `@jr2/orchestrator/hooks/gitlab`: jr2's GitLab kind. The `token` verifier: the door compares the digest of the
// header and removes the header before `read` runs, so this code never sees the token.

import { z } from "zod";
import { at, defineHookKind, json } from "./index.ts";

const user = z.looseObject({ username: z.string() });

/** The schema of each event key: the fields that handlers read, in loose objects. */
export const gitlabEvents = {
  "merge_request.approved": z.looseObject({
    user,
    object_attributes: z.looseObject({ url: z.string(), last_commit: z.looseObject({ id: z.string() }) }),
  }),
  "note.MergeRequest": z.looseObject({
    user,
    object_attributes: z.looseObject({ note: z.string() }),
    merge_request: z.looseObject({ url: z.string() }),
  }),
  "pipeline.success": z.looseObject({
    object_attributes: z.looseObject({ sha: z.string(), status: z.string() }),
  }),
  "pipeline.failed": z.looseObject({
    object_attributes: z.looseObject({ sha: z.string(), status: z.string() }),
  }),
};

const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * A GitLab project or group webhook.
 * - verifier: `token`, the secret token in `X-Gitlab-Token`.
 * - handshake: none. A "Test" delivery from GitLab's settings is an ordinary delivery.
 * - event key: `<object_kind>.<the second part>`, or `<object_kind>` when it has no second part.
 *   The second part is `object_attributes.noteable_type` for a `note`, and else
 *   `object_attributes.action`, then `object_attributes.status`: `merge_request.approved`,
 *   `note.MergeRequest`, `pipeline.success`.
 * - delivery id: `Idempotency-Key` (the same on a retry), else `X-Gitlab-Event-UUID`. (From
 *   GitLab's docs; not checked against a real delivery.)
 * - `onBehalfOf`: `user.username`.
 * - answer: the outcome (the default). No person reads it.
 */
export const gitlab = defineHookKind({
  api: 1,
  id: "gitlab",
  events: gitlabEvents,
  verify: { token: { header: "x-gitlab-token" } },
  read: (req) => {
    const p = json(req);
    const kind = text(at(p, "object_kind"));
    if (kind === undefined) throw new Error("the body has no object_kind");
    const second =
      kind === "note"
        ? text(at(p, "object_attributes.noteable_type"))
        : (text(at(p, "object_attributes.action")) ?? text(at(p, "object_attributes.status")));
    const id = text(req.headers["idempotency-key"]) ?? text(req.headers["x-gitlab-event-uuid"]);
    if (id === undefined) throw new Error("no Idempotency-Key or X-Gitlab-Event-UUID header");
    const by = text(at(p, "user.username"));
    return {
      key: second ? `${kind}.${second}` : kind,
      id,
      payload: p,
      ...(by ? { onBehalfOf: by } : {}),
    };
  },
});

declare module "./index.ts" {
  interface HookKinds {
    gitlab: typeof gitlab;
  }
}
