// `jr2 runs` (ADR-0009): list the live runs as JSON on stdout. (Settled runs leave the live registry;
// read a specific one through to the store with `jr2 status <runId>`.)
//
// A run with a Workspace in `placing` (ADR-0064) carries `placing`: the child paths of those
// Workspaces, in `RunWaiting.child`'s form. It is the at-a-glance marker for a run that waits for
// capacity — why it waits is `jr2 status <runId>`'s `waiting`. A run with none has no `placing` key.

import { parseArgs } from "node:util";
import type { RunChild } from "@jr2/orchestrator";
import { JR2Client, type RunStatus } from "../client.ts";
import { resolveTarget, TARGET_ARGS, targetOptions } from "../instance.ts";
import { result, type Io } from "../output.ts";

export async function runs(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, allowPositionals: true, strict: false, options: { ...TARGET_ARGS } });
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token);
    result(io, (await client.list()).map(markPlacing));
    return 0;
  } finally {
    target.close?.();
  }
}

/** The run, with `placing` after its id when any Workspace in it is in `placing`. */
export function markPlacing(run: RunStatus): RunStatus & { placing?: string[] } {
  const placing = [...(run.value === "placing" ? [""] : []), ...placingIn(run.children ?? [], [])];
  if (!placing.length) return run;
  const { runId, ...rest } = run;
  return { runId, placing, ...rest };
}

/** The paths of every child in `placing`, at any depth — read off the state values alone, which
 * are public (a Workspace's value is the flat state key). */
function placingIn(children: RunChild[], path: string[]): string[] {
  return children.flatMap((child) => {
    const here = [...path, child.id];
    return [...(child.value === "placing" ? [here.join("/")] : []), ...placingIn(child.children, here)];
  });
}
