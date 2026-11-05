import { defineConfig, secret } from "@jr2/orchestrator";
import { stripe } from "./hooks/stripe.ts";

export default defineConfig({
  // The signing secret of the Stripe endpoint. jr2 up places it in the Instance Effector.
  secrets: [{ name: "STRIPE_HOOK", value: process.env.STRIPE_HOOK }],
  hooks: {
    // POST /hooks/billing. The Hook may answer the Gates of dunning alone.
    billing: stripe({ secret: secret("STRIPE_HOOK"), may: { answer: ["dunning"] } }),
  },
});
