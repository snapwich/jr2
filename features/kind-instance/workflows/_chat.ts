// The @kind tier's chat kind (ADR-0011, ADR-0068): Slack's own protocol — its `mac` verifier, its
// reader and its events, from `@jr2/hooks/slack` — under another id, with one change: its follow-up
// host. Slack's is `https://hooks.slack.com/`, which no kind cluster can serve. This kind's is
// `https://follow/`, a Service in the scenario's own namespace that a step points at a server on
// the host (`steps/kind.steps.ts`). So the click's follow-up leaves the real Instance Effector, to a
// host that `jr2 up` wrote into the Effector's fence from this kind's `posts`, with no secret.
//
// Not a Workflow: a file whose name starts with `_` is not one. It sits in `workflows/` because the
// instance's bundle holds only that folder and the config.

import { defineHookKind, type Delivery } from "@jr2/hooks";
import { slack } from "@jr2/hooks/slack";

/** The follow-up host: a short name, which the Effector's resolver completes in its namespace. */
export const FOLLOW = "https://follow/";

export const chat = defineHookKind({
  api: 1,
  id: "chat",
  events: slack.events,
  verify: slack.verify,
  read: slack.read,
  // Slack's envelope: the answer to a click is an empty 200, and the text goes to the click's
  // `response_url` as the answer's `then`.
  answer: (text: string, d: Delivery) => {
    const url = (d.payload as { readonly response_url?: unknown }).response_url;
    if (!d.key.startsWith("block_actions.") || typeof url !== "string" || !url.startsWith(FOLLOW)) {
      return { body: { response_type: "ephemeral", text } };
    }
    return {
      body: null,
      then: { post: url as `https://${string}`, json: { response_type: "ephemeral", replace_original: false, text } },
    };
  },
  maxText: 4000,
  posts: [FOLLOW],
});

declare module "@jr2/hooks" {
  interface HookKinds {
    chat: typeof chat;
  }
}
