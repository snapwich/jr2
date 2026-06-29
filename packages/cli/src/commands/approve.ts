// `j2 approve <runId> [--reject] [--decision <d>]` (ADR-0009): answer a run parked on a
// `request_approval` gate — sugar over the `APPROVE` down-channel event. `--reject` answers "rejected";
// `--decision` passes an explicit decision string (default "approved").

import { parseArgs } from "node:util";
import { J2Client } from "../client.ts";
import { resolveBaseUrl } from "../instance.ts";
import { activity, type Io } from "../output.ts";

export async function approve(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { reject: { type: "boolean" }, decision: { type: "string" }, url: { type: "string" } },
  });
  const runId = positionals[0];
  if (!runId) {
    activity(io, "usage: j2 approve <runId> [--reject] [--decision <d>]");
    return 2;
  }
  const client = new J2Client(resolveBaseUrl(io, { url: values.url as string | undefined }), io.fetch);
  await client.send(runId, {
    type: "APPROVE",
    reject: values.reject as boolean | undefined,
    decision: values.decision as string | undefined,
  });
  activity(io, `${values.reject ? "rejected" : "approved"} ${runId}`);
  return 0;
}
