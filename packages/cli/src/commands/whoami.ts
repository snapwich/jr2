// `jr2 whoami` (ADR-0078): the Caller that this credential is, as `GET /whoami` gives it — how jr2
// knows it, its name, the name jr2 shows, what it may do, and the party it says it acts for. A
// person runs it to see what a credential may do before an act fails. On a kube context it is
// `token/instance`, on behalf of the kube user; with `--url` and `JR2_TOKEN` it is that token's
// Caller. The route needs no scope, so a credential that may do nothing still sees why.

import { JR2Client } from "../client.ts";
import { parseCommand } from "../command-table.ts";
import { resolveTarget, targetOptions } from "../instance.ts";
import { result, type Io } from "../output.ts";

export async function whoami(args: string[], io: Io): Promise<number> {
  const { values } = parseCommand("whoami", args);
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token, target.onBehalfOf);
    result(io, await client.whoami());
    return 0;
  } finally {
    target.close?.();
  }
}
