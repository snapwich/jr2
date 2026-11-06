// An e2e fixture (ADR-0017): a standing Pool of runs over a READ Source. The read is the truth: it
// gets the open labeled issues from a fake issue API that the scenario serves, whose url the step
// writes to `issues-api.url` in the instance folder (the Orchestrator's cwd). A Discord command
// `/recheck` makes the Pool read again; another command is skipped. One `ticket` run per issue, at
// most 2 live. The read is a promise: this tier has no Instance Effector, so an `http` read is the
// `@kind` tier's. Filename `issues.ts` → workflow "issues".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromPromise } from "xstate";
import { z } from "zod";
import type {} from "@jr2/orchestrator/hooks/discord";
import { dispatch, pool, reread, skip, source } from "@jr2/orchestrator";

type Issue = { number: number; title: string };

export const machine = pool(
  dispatch("ticket", { input: z.object({ number: z.number(), title: z.string() }), wait: true }),
  {
    id: "issues",
    standing: true,
    source: source<Issue>({
      read: fromPromise(async (): Promise<Issue[]> => {
        const url = readFileSync(join(process.cwd(), "issues-api.url"), "utf8").trim();
        const res = await fetch(`${url}/issues?labels=jr2&state=open`);
        if (res.status !== 200) return [];
        return (await res.json()) as Issue[];
      }),
      hooks: {
        discord: {
          "application_command.recheck": () => reread(),
          "application_command.approve": ({ payload }) => skip(`/${payload.data.name} is not for the issues Pool`),
        },
      },
      // The text that the person who used the command reads (ADR-0011).
      reply: (v) =>
        v.verdict === "reread"
          ? "jr2 reads the open issues again."
          : v.verdict === "skipped"
            ? `skipped: ${v.reason}.`
            : undefined,
    }),
    itemId: (i: Issue) => `issue-${i.number}`,
    cap: 2,
    itemInput: (i: Issue) => ({ number: i.number, title: i.title }),
  },
);
