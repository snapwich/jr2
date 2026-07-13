// `j2 send <runId> --event CANCEL` (ADR-0009/0013): the run-control seam.
//
// It used to carry APPROVE and STEER too. Those rode the `deferred` (held tool result) and `poll`
// (steer inbox) semantics, which ADR-0013 reserves but does not build — so they are gone rather
// than left pretending. Workflow-defined events do not belong here anyway: they reach a run
// through its GATES (`POST /runs/:id/gates/:gate/events` — ADR-0011), which is the resource a
// human, a UI inbox card, or a webhook translator addresses.

import { parseArgs } from "node:util";
import { J2Client } from "../client.ts";
import { resolveTarget } from "../instance.ts";
import { activity, type Io } from "../output.ts";

export async function send(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { event: { type: "string" }, url: { type: "string" } },
  });
  const runId = positionals[0];
  const event = (values.event as string | undefined)?.toUpperCase();
  if (!runId || !event) {
    activity(io, "usage: j2 send <runId> --event CANCEL");
    return 2;
  }
  if (event !== "CANCEL") {
    activity(io, `j2 send: unknown event "${event}" (accepts: CANCEL)`);
    return 2;
  }
  const target = resolveTarget(io, { url: values.url as string | undefined });
  const client = new J2Client(target.url, io.fetch, target.token);
  await client.send(runId, { type: event });
  activity(io, `sent ${event} to ${runId}`);
  return 0;
}
