// S2: `task` under a `pool()`, one Workspace for each item (ADR-0017), as the `pool()` TSDoc writes it.
import { fromPromise } from "xstate";
import { customize, pool, source, type PoolNextInput } from "@jr2/orchestrator";
import { task } from "@jr2/machines";

type Issue = { id: string; title: string };
const backlog: Issue[] = [{ id: "ISSUE-1", title: "Fix the greeting." }];

const issues = source<Issue>({
  // `settled` means that the backlog need not lose its items.
  next: fromPromise(async ({ input }: { input: PoolNextInput }) => {
    return backlog.find((i) => !input.active.includes(i.id) && !input.settled.includes(i.id)) ?? null;
  }),
});

const fixer = customize(task, {
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
  agents: { coder: { model: "fake/model-x" } },
});

export const machine = pool(fixer, {
  id: "issues",
  source: issues,
  itemId: (issue: Issue) => issue.id,
  cap: 2,
  itemInput: (issue: Issue) => ({ prompt: issue.title, branch: `fix/${issue.id}` }),
});
