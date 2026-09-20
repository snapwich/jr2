// `jr2 logs <runId|abbrev> [-f]` (ADR-0009): re-attach to a run's feed. The orchestrator replays the current
// status on attach, so even without -f you see where the run IS right now (status → stdout as JSON;
// author emits → stderr). `-f`/`--follow` keeps streaming status deltas until the run settles; without
// it, we print the replayed status and stop. A run that already settled streams its final status once.

import { parseArgs } from "node:util";
import { JR2Client } from "../client.ts";
import { resolveTarget, TARGET_ARGS, targetOptions } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";
import { resolveRunId } from "../run-id.ts";

export async function logs(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { follow: { type: "boolean", short: "f" }, ...TARGET_ARGS },
  });
  const given = positionals[0];
  if (!given) {
    activity(io, "usage: jr2 logs <runId|abbrev> [-f]");
    return 2;
  }
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token);
    const ref = await resolveRunId(client, given);
    if (!ref.ok) {
      activity(io, ref.message);
      return ref.code;
    }

    for await (const ev of client.events(ref.runId)) {
      if (ev.kind === "emit") {
        activity(io, `emit ${JSON.stringify(ev.event)}`);
        continue;
      }
      if (ev.kind === "retry") {
        activity(io, `retry ${ev.child} attempt ${ev.attempt} (${ev.reason})`);
        continue;
      }
      result(io, ev.status);
      if (!values.follow) break;
      if (ev.status.status !== "active") break;
    }
    return 0;
  } finally {
    target.close?.();
  }
}
