import { z } from "zod";
import { webhook } from "@jr2/orchestrator/hooks/webhook";

// An alert service that jr2 ships no kind for. The service signs the raw body with a shared secret
// (sha256, hex) in the header sentry-hook-signature. The event key is the resource and its action,
// such as issue.created. The module is in `hooks/`, not in `workflows/`, because it is not a Workflow.
export const sentry = webhook({
  id: "sentry",
  events: {
    "issue.created": z.looseObject({
      data: z.looseObject({
        issue: z.looseObject({ id: z.string(), title: z.string(), level: z.string() }),
      }),
    }),
  },
  verify: { mac: { header: "sentry-hook-signature" } },
  key: { name: { header: "sentry-hook-resource" }, action: { json: "action" } },
  delivery: { header: "request-id" },
});

declare module "@jr2/orchestrator/hooks" {
  interface HookKinds {
    sentry: typeof sentry;
  }
}
