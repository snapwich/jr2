import { defineConfig, secret } from "@jr2/orchestrator";
import { sentry } from "./hooks/sentry.ts";

export default defineConfig({
  // The Hook's secret is an entry of the list. jr2 up places SENTRY_HOOK in the Instance Effector.
  secrets: [{ name: "SENTRY_HOOK", value: process.env.SENTRY_HOOK }],
  hooks: {
    // POST /hooks/sentry: the alert service signs each delivery with SENTRY_HOOK. The Hook brings
    // items to the Pool of the alerts Workflow, through its source Gate, and to nothing more.
    sentry: sentry({ secret: secret("SENTRY_HOOK"), may: { answer: ["alerts"] } }),
  },
});
