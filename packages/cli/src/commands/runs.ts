// `jr2 runs` (ADR-0009): list runs as JSON on stdout, newest start first: the live runs by default,
// the history with `--status ended|all|<list>`, one Workflow with `--workflow`, and the runs that
// started in a time with `--since` (`2h`, `7d`, or an ISO-8601 time). An ended run is listed while
// its row is kept (`runs.retain`, ADR-0065); a `drifted` run is listed with its reason (ADR-0030).
// Each item is the Orchestrator's summary, and the verb reads every page of `GET /runs`.
//
// A run with a Workspace in `placing` (ADR-0064) carries `placing`: the child paths of those
// Workspaces, in `RunWaiting.child`'s form. It is the at-a-glance marker for a run that waits for
// capacity — why it waits is `jr2 status <runId>`'s `waiting`. A run with none has no `placing` key.
// A dispatched run (ADR-0071) carries `dispatchedBy`, as the Orchestrator sends it: the run that
// started it, the caller's slot and the chain's depth, so the chain reads off the listing.
//
// The Workflows that a run can start are `jr2 workflows`, not this verb.

import { JR2Client } from "../client.ts";
import { resolveTarget, targetOptions } from "../instance.ts";
import { result, type Io } from "../output.ts";
import { parseCommand } from "../command-table.ts";

export async function runs(args: string[], io: Io): Promise<number> {
  const { values } = parseCommand("runs", args);
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token, target.onBehalfOf);
    const listed = await client.allRuns({
      ...(typeof values.status === "string" ? { status: values.status } : {}),
      ...(typeof values.workflow === "string" ? { workflow: values.workflow } : {}),
      ...(typeof values.since === "string" ? { since: values.since } : {}),
    });
    result(io, listed);
    return 0;
  } finally {
    target.close?.();
  }
}
