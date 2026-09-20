// `jr2 runs` (ADR-0009): list the live runs as JSON on stdout. (Settled runs leave the live registry;
// read a specific one through to the store with `jr2 status <runId>`.)

import { parseArgs } from "node:util";
import { JR2Client } from "../client.ts";
import { resolveTarget, TARGET_ARGS, targetOptions } from "../instance.ts";
import { result, type Io } from "../output.ts";

export async function runs(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, allowPositionals: true, strict: false, options: { ...TARGET_ARGS } });
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token);
    result(io, await client.list());
    return 0;
  } finally {
    target.close?.();
  }
}
