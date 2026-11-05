// An e2e fixture (ADR-0017): the `alerts` push Source with `cap: 4`, over a callee (`quick`) that
// ends by itself. A burst of deliveries is held and claimed four at a time. Filename `burst.ts` →
// workflow "burst".

import { z } from "zod";
import { carry, dispatch, pool, source } from "@jr2/orchestrator";
import type {} from "./_alerts.ts";

const alert = z.object({ issue: z.string() });

export const machine = pool(dispatch("quick", { input: alert, wait: true }), {
  id: "burst",
  standing: true,
  source: source({
    item: alert,
    hooks: { alerts: { "issue.created": ({ payload }) => carry({ issue: payload.data.issue.id }) } },
  }),
  itemId: (a) => `alert-${a.issue}`,
  cap: 4,
});
