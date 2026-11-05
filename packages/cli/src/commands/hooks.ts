// `jr2 hooks <name>` (ADR-0011): a Hook's log, as `GET /hooks/:name` gives it — each delivery of
// the last week, newest first, and what the door did with it: a handshake, the outcome of a
// delivery, a repeat, a payload that the parse refused, a request that the kind could not read, or
// a follow-up post that failed.
// The route takes the Instance token alone, so on a kube context the CLI reads it, as for every
// run-verb; with `--url` it needs `JR2_TOKEN` to be the Instance token.

import { JR2Client } from "../client.ts";
import { commandNamed, parseCommand, renderCommand } from "../command-table.ts";
import { resolveTarget, targetOptions } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";

export async function hooks(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseCommand("hooks", args);
  const [name] = positionals;
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (!name || positionals.length > 1 || (limit !== undefined && !(Number.isInteger(limit) && limit >= 1))) {
    activity(io, renderCommand(commandNamed("hooks")));
    return 2;
  }
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token, target.onBehalfOf);
    const log = await client.hookLog(name, limit);
    if (!log.declared) activity(io, `note: the current Assembly's config declares no Hook "${name}"`);
    result(io, log);
    return 0;
  } finally {
    target.close?.();
  }
}
