// `jr2 watch <runId|abbrev> [--json]` (ADR-0009): attach to a run's feed and follow it to its end.
// The orchestrator replays the current status on attach, so a parked run shows where it is, and an
// ended run prints its last status once. It prints the lines that `jr2 run` prints while it is
// attached, in the same form: the header `run <id> (<workflow>) — attached`, then each
// `attachedLine` with the same indent, and after a failed run's last status its reason
// (`failureActivity`). They go on stdout: a report verb. Its exit code is the watch's, not the
// run's: 0 when it followed the feed to its end, a failed or a parked run too. `jr2 run` exits with
// the run's result. `--json` prints each status as one JSON line on stdout and the other
// lines as activity on stderr. A run that is parked before it settles ends the watch, as it ends
// `jr2 run`'s attach.
import { JR2Client } from "../client.ts";
import { resolveTarget, targetOptions } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";
import { resolveRunId } from "../run-id.ts";
import { attachedLine } from "./run.ts";
import { failureActivity } from "./status.ts";
import { parseCommand, usageLine } from "../command-table.ts";

export async function watch(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseCommand("watch", args);
  const given = positionals[0];
  if (!given || positionals.length > 1) {
    activity(io, usageLine("watch"));
    return 2;
  }
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token, target.onBehalfOf);
    const ref = await resolveRunId(client, given);
    if (!ref.ok) {
      activity(io, ref.message);
      return ref.code;
    }
    let headed = false;
    for await (const ev of client.events(ref.runId)) {
      if (values.json !== true && !headed) {
        headed = true;
        const workflow = ev.kind === "status" ? ev.status.workflow : "?";
        io.stdout(`run ${ref.runId} (${workflow}) — attached\n`);
      }
      if (values.json !== true) io.stdout(`  ${attachedLine(ev)}\n`);
      else if (ev.kind === "status") result(io, ev.status);
      else activity(io, attachedLine(ev));
      if (ev.kind === "status" && ev.status.status !== "active") {
        // A failed run's reason, as `jr2 run` prints it after the last status.
        const failed = failureActivity(ev.status);
        if (failed && values.json !== true) io.stdout(`${failed}\n`);
        else if (failed) activity(io, failed);
        return 0;
      }
    }
    activity(io, `run ${ref.runId} is parked: stopped before it settled`);
    return 0;
  } finally {
    target.close?.();
  }
}
