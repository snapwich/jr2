import { z } from "zod";
import { defineHookKind, json } from "@jr2/orchestrator/hooks";

// The payload of each event key that a handler hears. Name only the fields that the handlers read:
// a loose object keeps the other fields, so a new field from Stripe breaks nothing.
const invoice = z.looseObject({
  data: z.looseObject({ object: z.looseObject({ id: z.string(), customer: z.string() }) }),
});

export const stripeEvents = {
  "invoice.paid": invoice,
  "invoice.payment_failed": invoice,
};

// #region kind
export const stripe = defineHookKind({
  api: 1,
  id: "stripe",
  events: stripeEvents,
  verify: {
    mac: {
      alg: "sha256",
      // Stripe-Signature: t=<seconds>,v1=<hex>. Stripe signs "<t>.<raw body>". The door checks t
      // against its clock, and the Instance Effector checks the HMAC.
      signed: (req) => {
        const fields = (req.headers["stripe-signature"] ?? "").split(",").map((f) => f.split("="));
        const t = fields.find(([name]) => name === "t")?.[1];
        const v1 = fields.find(([name]) => name === "v1")?.[1];
        if (!t || !/^\d+$/.test(t) || !v1) return { unsigned: "no t and v1 in the Stripe-Signature header" };
        return { bytes: [t, ".", req.body], signature: { hex: v1 }, at: Number(t) };
      },
    },
  },
  // The event's type is the event key, and the event's id is the id of the delivery.
  read: (req) => {
    const event = json(req) as { readonly id?: unknown; readonly type?: unknown } | null;
    if (typeof event?.id !== "string" || typeof event.type !== "string") {
      throw new Error("the body is not a Stripe event");
    }
    return { key: event.type, id: event.id, payload: event };
  },
});
// #endregion kind

// The kind's id and payloads, for the types of the handlers.
declare module "@jr2/orchestrator/hooks" {
  interface HookKinds {
    stripe: typeof stripe;
  }
}
