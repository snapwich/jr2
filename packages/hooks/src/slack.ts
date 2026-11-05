// `@jr2/hooks/slack`: jr2's Slack kind. One Slack app at one address: its slash commands, its
// interactivity (Block Kit clicks) and its Events API.

import { z } from "zod";
import { defineHookKind, form, json, type Delivery, type HookRequest } from "@jr2/hooks";

/**
 * The schema of each event key. A key with `.*` covers a family: the command or the action id is
 * part of the key, so one schema types `block_actions.approve` and `block_actions.reject`.
 */
export const slackEvents = {
  /** A slash command, decoded from its form body: each field is a string. */
  "slash_command.*": z.looseObject({ text: z.string(), user_id: z.string(), channel_id: z.string() }),
  /** A Block Kit click, decoded from the JSON in its `payload` form field. */
  "block_actions.*": z.looseObject({
    user: z.looseObject({ id: z.string() }),
    channel: z.looseObject({ id: z.string() }).optional(),
    message: z.looseObject({ ts: z.string() }).optional(),
    actions: z.array(z.looseObject({ action_id: z.string(), value: z.string().optional() })),
    /** The kind's `answer` posts the text here. A click with no `response_url` fails the parse. */
    response_url: z.string(),
  }),
  "event_callback.app_mention": z.looseObject({
    event: z.looseObject({ user: z.string(), text: z.string(), channel: z.string(), ts: z.string() }),
  }),
};

const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

const need = (v: string | undefined, what: string): string => {
  if (v === undefined) throw new Error(`no ${what}`);
  return v;
};

/** Slack's three characters that a `text` must escape. */
const escape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const isForm = (req: HookRequest): boolean =>
  (req.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded");

/** The host of a click's `response_url`. */
const RESPONSE_HOST = "https://hooks.slack.com/";

/**
 * - verifier: `mac`, HMAC-SHA256 of `v0:<X-Slack-Request-Timestamp>:<raw body>`,
 *   `X-Slack-Signature: v0=<hex>`. The signature covers the timestamp, so the kind gives it as
 *   `at`, and the door's 300 s window applies (Slack asks for 5 minutes).
 * - handshake: `url_verification` gets `{ challenge }`. The door verifies it first. (Slack's docs
 *   do not say that Slack signs it; check it at the first real setup.)
 * - body: a command is a form; a click is a form with JSON in `payload`; an event is JSON.
 * - event keys: `slash_command./jr2`, `block_actions.<action_id>`, `event_callback.<event.type>`.
 * - delivery id: `event_id` for an event, `trigger_id` for a command or a click. (Slack's docs do
 *   not say that a `trigger_id` is unique for each request; the door's repeat check also uses the
 *   digest of the body.)
 * - `onBehalfOf`: the Slack user id, never a display name.
 * - who reads the answer: a person for a command or a click; Slack for an event (so a 503 stays a
 *   503, and Slack sends the event again).
 * - answer: ephemeral text. The answer to a click can only be an empty 200 (Block Kit), so the text
 *   goes to the click's `response_url` as the answer's `then`.
 * - text limit: 4000 characters, the length that Slack's docs advise for a message's `text`. (Not
 *   checked for the answer to a command or a `response_url` post.)
 */
export const slack = defineHookKind({
  api: 1,
  id: "slack",
  events: slackEvents,
  verify: {
    mac: {
      alg: "sha256",
      signed: (req) => {
        const ts = req.headers["x-slack-request-timestamp"];
        const sig = req.headers["x-slack-signature"];
        if (ts === undefined || !/^\d+$/.test(ts) || !sig?.startsWith("v0=")) {
          return { unsigned: "no Slack signature or timestamp" };
        }
        return { bytes: ["v0:", ts, ":", req.body], signature: { hex: sig.slice("v0=".length) }, at: Number(ts) };
      },
    },
  },
  read: (req) => {
    if (isForm(req)) {
      const f = form(req);
      if (f.payload !== undefined) {
        let p: { readonly type?: unknown; readonly trigger_id?: unknown; readonly user?: { readonly id?: unknown } };
        try {
          p = JSON.parse(f.payload) as typeof p;
        } catch {
          throw new Error("the payload field is not JSON");
        }
        const type = need(text(p?.type), "payload type");
        const action = text(
          (p as { readonly actions?: readonly { readonly action_id?: unknown }[] }).actions?.[0]?.action_id,
        );
        const by = text(p.user?.id);
        return {
          key: action ? `${type}.${action}` : type,
          id: need(text(p.trigger_id), "trigger_id"),
          payload: p,
          ...(by ? { onBehalfOf: by } : {}),
          readBy: "person",
        };
      }
      return {
        key: `slash_command.${need(text(f.command), "command")}`,
        id: need(text(f.trigger_id), "trigger_id"),
        payload: f,
        ...(text(f.user_id) ? { onBehalfOf: f.user_id } : {}),
        readBy: "person",
      };
    }
    const p = json(req) as {
      readonly type?: unknown;
      readonly challenge?: unknown;
      readonly event_id?: unknown;
      readonly event?: { readonly type?: unknown; readonly user?: unknown };
    } | null;
    const type = need(text(p?.type), "type");
    if (type === "url_verification") return { handshake: { body: { challenge: text(p?.challenge) ?? "" } } };
    const event = text(p?.event?.type);
    const by = text(p?.event?.user);
    return {
      key: event ? `${type}.${event}` : type,
      id: need(text(p?.event_id), "event_id"),
      payload: p,
      ...(by ? { onBehalfOf: by } : {}),
    };
  },
  answer: (t: string, d: Delivery) => {
    if (d.key.startsWith("block_actions.")) {
      const url = text((d.payload as { readonly response_url?: unknown }).response_url);
      // The door refuses a `then` outside `posts`; a url of another host gets no post at all.
      if (url === undefined || !url.startsWith(RESPONSE_HOST)) return { body: null };
      return {
        body: null,
        then: {
          post: url as `https://${string}`,
          json: { response_type: "ephemeral", replace_original: false, text: escape(t) },
        },
      };
    }
    return { body: { response_type: "ephemeral", text: escape(t) } };
  },
  maxText: 4000,
  posts: [RESPONSE_HOST],
});

declare module "@jr2/hooks" {
  interface HookKinds {
    slack: typeof slack;
  }
}
