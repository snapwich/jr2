// `jr2 gates` (ADR-0011): the Gate inbox as JSON on stdout. Each open Gate of every live run that
// this Caller may answer, oldest first, from `GET /gates`: its run, the run's Workflow, the Gate's
// id and path, the events it accepts and those it takes now, its `meta`, when it opened, and the
// Hook kinds that it hears. Never a run's context (ADR-0014). `--workflow` keeps one Workflow's
// runs. A Caller whose `answer` scope names single Gates sees only those Gates (ADR-0078).
// `jr2 send <runId> --gate <gate> --event <name>` answers one.

import { JR2Client } from "../client.ts";
import { parseCommand } from "../command-table.ts";
import { resolveTarget, targetOptions } from "../instance.ts";
import { result, type Io } from "../output.ts";

export async function gates(args: string[], io: Io): Promise<number> {
  const { values } = parseCommand("gates", args);
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token, target.onBehalfOf);
    result(io, await client.gates(typeof values.workflow === "string" ? values.workflow : undefined));
    return 0;
  } finally {
    target.close?.();
  }
}
