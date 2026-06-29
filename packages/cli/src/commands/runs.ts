// `j2 runs` (ADR-0009): list the live runs as JSON on stdout. (Settled runs leave the live registry;
// read a specific one through to the store with `j2 status <runId>`.)

import { parseArgs } from "node:util";
import { J2Client } from "../client.ts";
import { resolveBaseUrl } from "../instance.ts";
import { result, type Io } from "../output.ts";

export async function runs(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, allowPositionals: true, strict: false, options: { url: { type: "string" } } });
  const client = new J2Client(resolveBaseUrl(io, { url: values.url as string | undefined }), io.fetch);
  result(io, await client.list());
  return 0;
}
