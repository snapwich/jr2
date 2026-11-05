// An e2e fixture (ADR-0017, ADR-0078): the Hook kind of an alert service that has no kind of its
// own, made from data with `webhook()`. It is a module of the Instance (`workflows/_alerts.ts`: the
// `_` keeps it from being a Workflow), which `jr2.config.ts` imports for its Hook and the Workflows
// import for their handlers' types. The `token` verifier: the door compares the digest of the
// header, as a forge's shared token. One event key, `issue.created`.

import { z } from "zod";
import { webhook } from "@jr2/hooks/webhook";

export const alerts = webhook({
  id: "alerts",
  events: {
    "issue.created": z.looseObject({
      data: z.looseObject({
        issue: z.looseObject({ id: z.string(), title: z.string(), level: z.string() }),
      }),
    }),
  },
  verify: { token: { header: "x-alerts-token" } },
  key: { name: { header: "x-alerts-resource" }, action: { json: "action" } },
  delivery: { header: "x-alerts-delivery" },
});

declare module "@jr2/hooks" {
  interface HookKinds {
    alerts: typeof alerts;
  }
}
