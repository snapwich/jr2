// `@jr2/hooks/discord`: jr2's Discord kind, for an application's Interactions Endpoint URL.

import { z } from "zod";
import { at, defineHookKind, json } from "@jr2/hooks";

const user = z.looseObject({ id: z.string() });

/** The schema of each event key. A command's name is part of its key, so `.*` covers them all. */
export const discordEvents = {
  "application_command.*": z.looseObject({
    channel_id: z.string(),
    /** In a guild. */
    member: z.looseObject({ user }).optional(),
    /** In a direct message. */
    user: user.optional(),
    data: z.looseObject({
      name: z.string(),
      options: z
        .array(z.looseObject({ name: z.string(), value: z.union([z.string(), z.number(), z.boolean()]).optional() }))
        .optional(),
    }),
  }),
  message_component: z.looseObject({
    member: z.looseObject({ user }).optional(),
    user: user.optional(),
    data: z.looseObject({ custom_id: z.string() }),
    message: z.looseObject({ id: z.string() }),
  }),
};

const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The interaction types that this kind reads (Discord's numbers). */
const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;

/**
 * - verifier: `ed25519` over `<X-Signature-Timestamp><raw body>`, `X-Signature-Ed25519` in hex,
 *   checked against the application's PUBLIC key in the Orchestrator. The signature covers the
 *   timestamp, so the kind gives it as `at`. Discord states no window; the door's 300 s window
 *   applies to each signed `at`, so it applies here too.
 * - handshake: `PING` (type 1) gets `{ type: 1 }` (PONG).
 * - event keys: `application_command.<data.name>` (type 2), `message_component` (type 3). Another
 *   type (an autocomplete, a modal) gets the key `interaction.<type>`, which has no schema, so it
 *   reaches nothing.
 * - delivery id: the interaction's `id`. `onBehalfOf`: `member.user.id`, or `user.id` in a direct
 *   message. (Discord's docs do not say that Discord sends an interaction again.)
 * - who reads the answer: a person, always.
 * - answer: `{ type: 4, data: { content, flags: 64 } }`, an ephemeral message. Discord shows
 *   markdown, not HTML, so the text needs no escape. Text limit: 2000 characters.
 */
export const discord = defineHookKind({
  api: 1,
  id: "discord",
  events: discordEvents,
  verify: {
    ed25519: {
      signed: (req) => {
        const ts = req.headers["x-signature-timestamp"];
        const sig = req.headers["x-signature-ed25519"];
        if (ts === undefined || !/^\d+$/.test(ts) || sig === undefined) {
          return { unsigned: "no Discord signature or timestamp" };
        }
        return { bytes: [ts, req.body], signature: { hex: sig }, at: Number(ts) };
      },
    },
  },
  read: (req) => {
    const p = json(req);
    const type = at(p, "type");
    if (type === PING) return { handshake: { body: { type: 1 } } };
    const id = text(at(p, "id"));
    if (id === undefined) throw new Error("the interaction has no id");
    const by = text(at(p, "member.user.id")) ?? text(at(p, "user.id"));
    const key =
      type === APPLICATION_COMMAND
        ? `application_command.${text(at(p, "data.name")) ?? ""}`
        : type === MESSAGE_COMPONENT
          ? "message_component"
          : `interaction.${String(type)}`;
    return { key, id, payload: p, ...(by ? { onBehalfOf: by } : {}), readBy: "person" };
  },
  answer: (t) => ({ body: { type: 4, data: { content: t, flags: 64 } } }),
  maxText: 2000,
});

declare module "@jr2/hooks" {
  interface HookKinds {
    discord: typeof discord;
  }
}
