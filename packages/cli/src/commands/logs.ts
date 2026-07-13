// `j2 logs <runId> [-f]` (ADR-0009): re-attach to a run's feed. The orchestrator replays the current
// status on attach, so even without -f you see where the run IS right now (status → stdout as JSON;
// author emits → stderr). `-f`/`--follow` keeps streaming status deltas until the run settles; without
// it, we print the replayed status and stop. A run that already settled streams its final status once.

import { parseArgs } from "node:util";
import { J2Client } from "../client.ts";
import { resolveTarget } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";

export async function logs(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { follow: { type: "boolean", short: "f" }, url: { type: "string" } },
  });
  const runId = positionals[0];
  if (!runId) {
    activity(io, "usage: j2 logs <runId> [-f]");
    return 2;
  }
  const target = resolveTarget(io, { url: values.url as string | undefined });
  const client = new J2Client(target.url, io.fetch, target.token);

  for await (const ev of client.events(runId)) {
    if (ev.kind === "emit") {
      activity(io, `emit ${JSON.stringify(ev.event)}`);
      continue;
    }
    result(io, ev.status);
    if (!values.follow) break;
    if (ev.status.status !== "active") break;
  }
  return 0;
}
