import { z } from "zod";
import { carry, dispatch, pool, skip, source } from "@jr2/orchestrator";
import type {} from "../hooks/sentry.ts";

// The door of the triage Workflow: each alert is one run of it.
const triageDoor = z.object({ issue: z.string(), title: z.string() });

// A push Source: each Hook delivery carries an alert, and the Pool holds it until a slot is free.
const alerts = source({
  item: z.object({ issue: z.string(), title: z.string(), level: z.string() }),
  hooks: {
    sentry: {
      "issue.created": ({ payload }) => {
        const issue = payload.data.issue;
        if (issue.level !== "error" && issue.level !== "fatal") return skip(`level is ${issue.level}`);
        return carry({ issue: issue.id, title: issue.title, level: issue.level });
      },
    },
  },
});

// A standing Pool of runs: one triage run for each alert, at most 8 live at once.
export const machine = pool(dispatch("triage", { input: triageDoor, wait: true }), {
  id: "alerts",
  standing: true,
  source: alerts,
  itemId: (alert) => `sentry-${alert.issue}`,
  cap: 8,
  itemInput: (alert) => ({ issue: alert.issue, title: alert.title }),
});
