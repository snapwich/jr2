// `jr2 steer` (ADR-0002): a Caller's Steering message to one Agent of a live run.
//
//   jr2 steer <runId|abbrev> <agent> "<text>"   send the message
//   jr2 steer <runId|abbrev>                     list the run's Agent slots
//
// The address is the Agent SLOT, as the run's list names it (`<machine path>/<agent>`), never an
// Instance ID: jr2 computes those, and a fresh Turn gets a new one. An open Turn of the slot hears
// the message at its next step boundary; otherwise the slot's next Turn in the same Machine
// instance hears it. The run id resolves first, as for every write (ADR-0009).

import { JR2Client } from "../client.ts";
import { resolveTarget, targetOptions } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";
import { resolveRunId } from "../run-id.ts";
import { commandNamed, parseCommand, renderCommand } from "../command-table.ts";

export async function steer(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseCommand("steer", args);
  const [given, agent, text] = positionals;
  if (!given || (agent !== undefined && text === undefined) || positionals.length > 3) {
    activity(io, renderCommand(commandNamed("steer")));
    return 2;
  }
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token, target.onBehalfOf);
    const ref = await resolveRunId(client, given);
    if (!ref.ok) {
      activity(io, ref.message);
      return ref.code;
    }
    if (agent === undefined || text === undefined) {
      result(io, await client.agents(ref.runId));
      return 0;
    }
    const sent = await client.steer(ref.runId, agent, text);
    activity(
      io,
      sent.open
        ? `sent a Steering message to ${sent.agent} on ${ref.runId}: its open Turn hears it at its next step boundary, or its next Turn hears it if this Turn ends first`
        : `sent a Steering message to ${sent.agent} on ${ref.runId}: its next Turn hears it`,
    );
    return 0;
  } finally {
    target.close?.();
  }
}
