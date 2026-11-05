// An e2e fixture (ADR-0017): a standing Pool of runs over a PUSH Source. An alert service's
// delivery carries an alert; the Pool holds it and claims it under `cap`: one `triage` run per
// alert, keyed `alert-<issue>` in the `triage` Workflow. An alert below `error` is skipped.
// Filename `alerts.ts` → workflow "alerts".

import { z } from "zod";
import { carry, dispatch, pool, skip, source } from "@jr2/orchestrator";
import type {} from "./_alerts.ts";

const triageDoor = z.object({ issue: z.string(), title: z.string() });

export const machine = pool(dispatch("triage", { input: triageDoor, wait: true }), {
  id: "alerts",
  standing: true,
  source: source({
    item: z.object({ issue: z.string(), title: z.string(), level: z.string() }),
    hooks: {
      alerts: {
        "issue.created": ({ payload }) => {
          const i = payload.data.issue;
          if (i.level !== "error" && i.level !== "fatal") return skip(`level is ${i.level}, not error or fatal`);
          return carry({ issue: i.id, title: i.title, level: i.level });
        },
      },
    },
  }),
  itemId: (a) => `alert-${a.issue}`,
  cap: 8,
  itemInput: (a) => ({ issue: a.issue, title: a.title }),
});
