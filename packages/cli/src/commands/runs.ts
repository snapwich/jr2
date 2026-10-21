// `jr2 runs` (ADR-0009): list the live runs as JSON on stdout. (Settled runs leave the live registry;
// read a specific one through to the store with `jr2 status <runId>`.)
//
// A run with a Workspace in `placing` (ADR-0064) carries `placing`: the child paths of those
// Workspaces, in `RunWaiting.child`'s form. It is the at-a-glance marker for a run that waits for
// capacity — why it waits is `jr2 status <runId>`'s `waiting`. A run with none has no `placing` key.
// A dispatched run (ADR-0071) carries `dispatchedBy` after its id, as the Orchestrator sends it: the
// run that started it, the caller's slot and the chain's depth, so the chain reads off the listing.
//
// The verb also lists the Workflows a run can start (ADR-0070), from `GET /workflows`, as activity on
// stderr so the result on stdout stays the live runs: one line per Workflow with its origin
// (`machine`, `chart file`, `chart`), a Chart wrapper's Charts indented under it, and `unrunnable`
// with its reason. `--workflows` prints that listing as the result instead. No verb puts or deletes
// a runtime Chart in this step: `PUT`/`DELETE /workflows/<wrapper>/charts/<name>` is for an MCP or curl.

import { parseArgs } from "node:util";
import type { RunChild } from "@jr2/orchestrator";
import { JR2Client, type RunStatus, type WorkflowListing, type WorkflowOrigin } from "../client.ts";
import { resolveTarget, TARGET_ARGS, targetOptions } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";

export const RUNS_USAGE = `usage: jr2 runs [--workflows]

  the live runs as JSON on stdout; the Workflows a run can start on stderr, each with its origin
  (machine, chart file, chart) and a Chart wrapper's Charts indented under it (ADR-0070)
  --workflows   print the Workflow listing as the JSON result instead

  a runtime Chart has no verb here: PUT or DELETE /workflows/<wrapper>/charts/<name> with the
  Instance token (an MCP or curl), then \`jr2 run <wrapper>/<name>\` starts it`;

export async function runs(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { ...TARGET_ARGS, workflows: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    activity(io, RUNS_USAGE);
    return 0;
  }
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token);
    if (values.workflows) {
      result(io, await client.workflows());
      return 0;
    }
    const live = (await client.list()).map(markListed);
    // A report beside the result: a listing that cannot be read says why, and the runs still print.
    try {
      activity(io, renderWorkflows(await client.workflows()));
    } catch (e) {
      activity(io, `workflows: unknown — ${e instanceof Error ? e.message : String(e)}`);
    }
    result(io, live);
    return 0;
  } finally {
    target.close?.();
  }
}

/** How a listing names an origin (ADR-0070): a runtime Chart is plainly a `chart`. */
const ORIGIN_LABEL: Record<WorkflowOrigin, string> = { machine: "machine", file: "chart file", runtime: "chart" };

/**
 * The Workflow listing as lines: each Workflow with its origin, a Chart wrapper's Open body and
 * whether its door takes a Chart one-shot, its Charts indented under it, and `unrunnable` with the
 * reason. A Chart the listing also gives at the top level (or whose wrapper it does not list) prints
 * once: under its wrapper when the wrapper is listed, else at the top level.
 */
export function renderWorkflows(listing: readonly WorkflowListing[]): string {
  const underWrapper = new Set<string>();
  for (const w of listing) for (const c of w.wrapper?.charts ?? []) underWrapper.add(chartFullName(w.name, c.name));
  const line = (indent: string, name: string, label: string, unrunnable?: string): string =>
    `${indent}${name} (${label})${unrunnable ? ` unrunnable: ${unrunnable}` : ""}`;
  const out = ["workflows:"];
  for (const w of listing) {
    if (w.origin !== "machine" && underWrapper.has(w.name)) continue;
    const wrapper = w.wrapper;
    const label = wrapper
      ? `${ORIGIN_LABEL[w.origin]}, Chart wrapper: body "${wrapper.body}"${wrapper.oneShot ? ", one-shot" : ""}`
      : ORIGIN_LABEL[w.origin];
    out.push(line("  ", w.name, label, w.unrunnable));
    for (const c of wrapper?.charts ?? []) {
      out.push(line("    ", chartFullName(w.name, c.name), ORIGIN_LABEL[c.origin], c.unrunnable));
    }
  }
  if (out.length === 1) out.push("  none registered — `jr2 up` publishes the Assembly");
  return out.join("\n");
}

/** A Chart's Workflow name, `<wrapper>/<name>` (ADR-0070), whether the listing gives it short or whole. */
function chartFullName(wrapper: string, name: string): string {
  return name.includes("/") ? name : `${wrapper}/${name}`;
}

/** The run as `jr2 runs` lists it: `dispatchedBy` after its id when a `dispatch` Effect started it
 * (ADR-0071), and `placing` after that when any Workspace in it is in `placing`. */
export function markListed(run: RunStatus): RunStatus & { placing?: string[] } {
  const placing = [...(run.value === "placing" ? [""] : []), ...placingIn(run.children ?? [], [])];
  if (!placing.length && !run.dispatchedBy) return run;
  const { runId, dispatchedBy, ...rest } = run;
  return { runId, ...(dispatchedBy ? { dispatchedBy } : {}), ...(placing.length ? { placing } : {}), ...rest };
}

/** The paths of every child in `placing`, at any depth — read off the state values alone, which
 * are public (a Workspace's value is the flat state key). */
function placingIn(children: RunChild[], path: string[]): string[] {
  return children.flatMap((child) => {
    const here = [...path, child.id];
    return [...(child.value === "placing" ? [here.join("/")] : []), ...placingIn(child.children, here)];
  });
}
