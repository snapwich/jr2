// `jr2 run <workflow> [--input <json>] [--detach]` (ADR-0009). BLOCKING + attach-by-default, mirroring
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

import { parseArgs } from "node:util";
import type { ChildErrorMarker, PlacingMarker } from "@jr2/orchestrator";
import { JR2Client, JR2HttpError } from "../client.ts";
import { resolveTarget, TARGET_ARGS, targetOptions } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: {
      input: { type: "string" },
      detach: { type: "boolean" },
      ...TARGET_ARGS,
    },
  });

  const workflow = positionals[0];
  if (!workflow) {
    activity(io, "usage: jr2 run <workflow | wrapper/chart> [--input <json>] [--detach]");
    return 2;
  }
  const input = values.input ? (JSON.parse(String(values.input)) as Record<string, unknown>) : {};
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token);

    let runId: string;
    try {
      ({ runId } = await client.start(workflow, input));
    } catch (err) {
      if (!(err instanceof JR2HttpError) || !err.report) throw err;
      activity(io, refusalActivity(workflow, err.report));
      return 1;
    }
    if (values.detach) {
      result(io, { runId });
      return 0;
    }

    activity(io, `run ${runId} (${workflow}) — attached`);
    for await (const ev of client.events(runId)) {
      if (ev.kind === "emit") {
        activity(io, `  emit ${JSON.stringify(ev.event)}`);
        continue;
      }
      if (ev.kind === "retry") {
        activity(io, `  retry ${ev.child} attempt ${ev.attempt} (${ev.reason})`);
        continue;
      }
      if (ev.kind === "placing" || ev.kind === "placed") {
        activity(io, `  ${placingActivity(ev)}`);
        continue;
      }
      if (ev.kind === "child-error") {
        activity(io, `  ${childErrorActivity(ev)}`);
        continue;
      }
      activity(io, `  → ${ev.status.status} ${JSON.stringify(ev.status.value)}`);
      if (ev.status.status !== "active") {
        result(io, ev.status);
        return ev.status.status === "error" ? 1 : 0;
      }
    }
    // `events()` re-attaches until the run settles (ADR-0022), so reaching here means the run left
    // the live set without settling: stopped, parked for the next boot's restore (ADR-0025). Never
    // a success, and nothing on stdout to be mistaken for a result.
    activity(
      io,
      `run ${runId} is parked: stopped before it settled — \`jr2 logs -f ${runId}\` follows it once restored`,
    );
    return 1;
  } finally {
    target.close?.();
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

/**
 * A child's error below an Agent's state as one activity line (ADR-0024): the pick's answer carries
 * no reply for it, so the Agent is not told, and this line is where the operator reads it.
 */
export function childErrorActivity(ev: ChildErrorMarker): string {
  return `child-error: \`${ev.child}\` failed below ${ev.agent}'s pick \`${ev.pick}\` — ${ev.error}`;
}
