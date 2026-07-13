// `j2 status <runId>` (ADR-0009): print a run's status as JSON on stdout, reading through to the store
// so a completed run still reports its terminal status + final context. A genuinely unknown run → 1.

import { parseArgs } from "node:util";
import { J2Client } from "../client.ts";
import { resolveTarget } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";

export async function status(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { url: { type: "string" } },
  });
  const runId = positionals[0];
  if (!runId) {
    activity(io, "usage: j2 status <runId>");
    return 2;
  }
  const target = resolveTarget(io, { url: values.url as string | undefined });
  const client = new J2Client(target.url, io.fetch, target.token);
  const s = await client.read(runId);
  if (!s) {
    activity(io, `no run "${runId}"`);
    return 1;
  }
  result(io, s);
  return 0;
}
