// `jr2 run <workflow> [--input <json>] [--detach] [--drop-held]` (ADR-0009). BLOCKING + attach-by-default, mirroring
// `flue run`: start the run, then attach to its SSE feed — status deltas + author emits go to stderr
// as they happen; the terminal RunStatus is printed as JSON on stdout and we exit. So `jr2 run ping`
// shows progress to a human while `jr2 run ping | jq` yields just the result.
//
// Diverges from flue: this ATTACHES to the deployed orchestrator (port-forwarded via the current
// kube context — ADR-0019) rather than a per-invocation runtime, because jr2 runs are durable and may
// park indefinitely on an approval gate. `--detach` prints the runId and returns, leaving the run
// going server-side.
//
// A named Chart is a Workflow (ADR-0070): `jr2 run <wrapper>/<name>` starts it as any other run, the
// name riding the path as one encoded segment. A Chart the door refuses (one-shot, in `--input`)
// is a 422 whose report lines this prints, one per rule the Chart fails.
//
// A standing Workflow (ADR-0017): jr2 starts its run, so `jr2 run` of it only resumes a paused
// one, with its held items (none with `--drop-held`). It prints the new run and returns, because a
// standing run never ends by itself. The door refuses it with 409 while the Workflow is not paused.
//
// The exit code (ADR-0073): 0 only for a run that ended `done`. 1 for every other end — `failed`,
// `error`, `cancelled`, `lost`, `drifted` — and for a run that was parked before it settled. 2 is a
// usage error, as for every verb. The status line on stderr says which end it was, and a failed
// run's reason follows it.

import type {
  ChildErrorMarker,
  GateMarker,
  HookRefusedMarker,
  PlacingMarker,
  PoolMarker,
} from "@jr2/orchestrator/internal";
import { JR2Client, JR2HttpError, type RunFeedEvent } from "../client.ts";
import { failureActivity } from "./status.ts";
import { resolveTarget, targetOptions } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";
import { parseCommand, usageLine } from "../command-table.ts";

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseCommand("run", args);

  const workflow = positionals[0];
  if (!workflow) {
    activity(io, usageLine("run"));
    return 2;
  }
  const input = values.input ? (JSON.parse(String(values.input)) as Record<string, unknown>) : {};
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token, target.onBehalfOf);

    let runId: string;
    let resumed = false;
    try {
      ({ runId, resumed = false } = (await client.start(workflow, input, {
        dropHeld: values["drop-held"] === true,
      })) as { runId: string; resumed?: boolean });
    } catch (err) {
      if (!(err instanceof JR2HttpError) || !err.report) throw err;
      activity(io, refusalActivity(workflow, err.report));
      return 1;
    }
    // A standing run never ends by itself (ADR-0017): the resume prints it and returns.
    if (resumed) {
      activity(io, `resumed the standing workflow ${workflow}: run ${runId}`);
      result(io, { runId, resumed: true });
      return 0;
    }
    if (values.detach) {
      result(io, { runId });
      return 0;
    }

    activity(io, `run ${runId} (${workflow}) — attached`);
    for await (const ev of client.events(runId)) {
      activity(io, `  ${attachedLine(ev)}`);
      if (ev.kind === "status" && ev.status.status !== "active") {
        const failed = failureActivity(ev.status);
        if (failed) activity(io, failed);
        result(io, ev.status);
        return ev.status.status === "done" ? 0 : 1;
      }
    }
    // `events()` re-attaches until the run settles (ADR-0022), so reaching here means the run left
    // the live set without settling: stopped, parked for the next boot's restore (ADR-0025). Never
    // a success, and nothing on stdout to be mistaken for a result.
    activity(io, `run ${runId} is parked: stopped before it settled — \`jr2 watch ${runId}\` follows it once restored`);
    return 1;
  } finally {
    target.close?.();
  }
}

/**
 * One event of a run's feed as the line `jr2 run` prints while it is attached, and `jr2 watch`
 * prints (ADR-0009): an Emit, a retry, a wait for capacity, a child's error, a Gate's look, a
 * Hook's refused delivery, a Pool's mark, or where the run stands.
 */
export function attachedLine(ev: RunFeedEvent): string {
  switch (ev.kind) {
    case "emit":
      return `emit ${JSON.stringify(ev.event)}`;
    case "retry":
      return `retry ${ev.child} attempt ${ev.attempt} (${ev.reason})`;
    case "placing":
    case "placed":
      return placingActivity(ev);
    case "child-error":
      return childErrorActivity(ev);
    case "looked":
      return lookedActivity(ev);
    case "hook-refused":
      return hookRefusedActivity(ev);
    case "pool":
      return poolActivity(ev);
    case "status":
      return `→ ${ev.status.status} ${JSON.stringify(ev.status.value)}`;
  }
}

/**
 * The door's refusal of a Chart (ADR-0070) as activity: the Workflow, then each report line, which
 * names the path in the Chart and the rule it fails.
 */
export function refusalActivity(workflow: string, report: readonly string[]): string {
  return [`error: the door refused the Chart for "${workflow}"`, ...report.map((line) => `  ${line}`)].join("\n");
}

/**
 * A wait for capacity as one activity line (ADR-0064): the Workspace, what it waits for, and the
 * scheduler's or the quota's own words — then, once it has a node, how long it waited. The run's
 * root Workspace has no child path, so its line names none.
 */
export function placingActivity(ev: PlacingMarker): string {
  const who = ev.child ? ` ${ev.child}` : "";
  if (ev.kind === "placed") return `placed${who} after ${Math.round(ev.after / 1000)}s`;
  return `placing${who}: waits for ${ev.on === "quota" ? "quota" : "a node"} — ${ev.message}`;
}

/** A Gate's look as one activity line (ADR-0011): the look read its fact, and the run took its event. */
export function lookedActivity(ev: GateMarker): string {
  return `looked: gate ${ev.gate} read its fact, and the run took "${ev.event}"`;
}

/** A Hook's delivery that a Gate did not take, as one activity line (ADR-0011): the run goes on. */
export function hookRefusedActivity(ev: HookRefusedMarker): string {
  return (
    `hook-refused: hook ${ev.hook} delivery ${ev.delivery} at gate ${ev.gate}` +
    `${ev.event !== undefined ? ` ("${ev.event}")` : ""} — ${ev.reason}`
  );
}

/** What a Pool of runs did with one item, as one activity line (ADR-0017). */
export function poolActivity(ev: PoolMarker): string {
  const run = ev.run !== undefined ? ` run ${ev.run}` : "";
  if (ev.mark === "started")
    return `pool ${ev.pool}: started ${ev.key}${run}${ev.existing ? " (the key found it)" : ""}`;
  if (ev.mark === "skipped") return `pool ${ev.pool}: skipped an item — ${ev.reason ?? ""}`;
  if (ev.mark === "carry-refused") return `pool ${ev.pool}: carry-refused ${ev.key} — ${ev.reason ?? ""}`;
  return `pool ${ev.pool}: settled ${ev.key}${run} ${ev.status ?? ""}${ev.reason !== undefined ? ` — ${ev.reason}` : ""}`;
}

/**
 * A child's error below an Agent's state as one activity line (ADR-0024): the pick's answer carries
 * no reply for it, so the Agent is not told, and this line is where the operator reads it.
 */
export function childErrorActivity(ev: ChildErrorMarker): string {
  return `child-error: \`${ev.child}\` failed below ${ev.agent}'s pick \`${ev.pick}\` — ${ev.error}`;
}
