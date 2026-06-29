// `j2 send <runId> --event <E> [--message <m>]` (ADR-0009): the general down-channel seam — feed one
// control event into a live run. `--event` is one of APPROVE | CANCEL | STEER (the orchestrator's
// `POST /runs/:id/events` vocabulary); STEER carries a `--message`. `j2 approve` is sugar over this.

import { parseArgs } from "node:util";
import { J2Client } from "../client.ts";
import { resolveBaseUrl } from "../instance.ts";
import { activity, type Io } from "../output.ts";

export async function send(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { event: { type: "string" }, message: { type: "string" }, url: { type: "string" } },
  });
  const runId = positionals[0];
  const event = values.event as string | undefined;
  if (!runId || !event) {
    activity(io, "usage: j2 send <runId> --event <APPROVE|CANCEL|STEER> [--message <m>]");
    return 2;
  }
  const client = new J2Client(resolveBaseUrl(io, { url: values.url as string | undefined }), io.fetch);
  await client.send(runId, { type: event.toUpperCase(), message: values.message as string | undefined });
  activity(io, `sent ${event.toUpperCase()} to ${runId}`);
  return 0;
}
