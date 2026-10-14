import { fromPromise } from "xstate";
import { z } from "zod";
import { customize, defineEvent, pool, source } from "@jr2/orchestrator";
import { task } from "@jr2/machines";

const model = "anthropic/claude-sonnet-5-5";

// One work item: an open issue of the Repo.
type Issue = { number: number; title: string; body: string };

// The open issues with the label `jr2`: the first page only, at most 100. The Repo must be public,
// because the request has no token.
const ISSUES = "https://api.github.com/repos/you/app/issues?labels=jr2&state=open&per_page=100";

// The issues that this Source gave to a worker. A worker has each one now, or it finished it.
// The set is in the memory of the Orchestrator, and a restart empties it.
const claimed = new Set<number>();

// The Source: give the next open issue that no worker has had.
const issues = source<Issue>({
  next: fromPromise<Issue | null, { active: string[] }>(async ({ input }) => {
    const res = await fetch(ISSUES, { headers: { accept: "application/vnd.github+json" } }).catch(() => undefined);
    if (!res?.ok) {
      // While workers run, look again later. With no worker, stop the run with the error.
      if (input.active.length > 0) return null;
      throw new Error(`GET ${ISSUES} failed: ${res ? res.status : "no answer"}`);
    }
    const open = (await res.json()) as Array<{
      number: number;
      title: string;
      body: string | null;
      pull_request?: unknown;
    }>;
    // The issues API also lists pull requests. Skip them, and skip each issue that a worker has now.
    const issue = open.find(
      (i) => i.pull_request === undefined && !claimed.has(i.number) && !input.active.includes(`issue-${i.number}`),
    );
    if (!issue) return null;
    claimed.add(issue.number);
    return { number: issue.number, title: issue.title, body: issue.body ?? "" };
  }),
  // Send this event to the `source` Gate when you add the label to an issue.
  wake: defineEvent({
    name: "issues_changed",
    description: "An issue got the label jr2. Look for work again.",
    audience: "external",
    input: z.object({}),
  }),
  // While workers run and no issue is ready, look again every 5 minutes.
  pollEvery: 300_000,
});

// The worker: `task`, with its two Open parts bound.
const fixer = customize(task, {
  repos: { app: { url: "https://github.com/you/app.git" } },
  agents: { coder: { model } },
});

// The run input of the Pool. A worker does not get it.
const door = z.object({
  workers: z.number().int().min(1).max(4).default(2).describe("How many issues to work on at once."),
});

// The Pool: one `fixer` for each issue, at most `workers` at once.
export const machine = pool(fixer, {
  id: "issues",
  input: door,
  source: issues,
  itemId: (issue: Issue) => `issue-${issue.number}`,
  cap: ({ input }) => input.workers,
  // A `task` inside a Pool needs a branch. Make one from the issue number.
  itemInput: (issue: Issue) => ({
    prompt: `Fix issue #${issue.number} of this Repo: ${issue.title}\n\n${issue.body}`,
    branch: `jr2/issue-${issue.number}`,
  }),
});
