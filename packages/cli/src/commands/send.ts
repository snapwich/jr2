// `jr2 send` (ADR-0009/0011/0013): the two down-channels a human has into a live run.
//
//   jr2 send <runId|abbrev> --event CANCEL                           run control (the only verb left)
//   jr2 send <runId|abbrev> --gate <gate> --event <name> [--input '<json>'] deliver to an open Gate
//
// Run control used to carry APPROVE and STEER too. Those rode the `deferred` (held tool result)
// and `poll` (steer inbox) semantics, which ADR-0013 reserves but does not build — so they are
// gone rather than left pretending. Workflow-defined events reach a run through its GATES
// (`POST /runs/:id/gates/:gate/events` — ADR-0011): the gate names the pending decision, the
// event name must be in its derived accepts, and the input is validated against the event's
// schema host-side. Discover a run's open gates (names + accepts + meta) with `jr2 status <runId>`.
//
// The run id resolves BEFORE either branch: both are writes, and a write must never be
// prefix-sensitive (ADR-0009). It also gives a bad id a real error — `host.stop()` returns silently
// for an unknown run, so an unresolved CANCEL used to report success.

import { parseArgs } from "node:util";
import { JR2Client } from "../client.ts";
import { resolveTarget, TARGET_ARGS, targetOptions } from "../instance.ts";
import { activity, type Io } from "../output.ts";
import { resolveRunId } from "../run-id.ts";

const USAGE =
  "usage: jr2 send <runId|abbrev> --event CANCEL | jr2 send <runId|abbrev> --gate <gate> --event <name> [--input '<json>']";

export async function send(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: {
      event: { type: "string" },
      gate: { type: "string" },
      input: { type: "string" },
      ...TARGET_ARGS,
    },
  });
  const given = positionals[0];
  const gate = values.gate as string | undefined;
  const event = values.event as string | undefined;
  if (!given || !event) {
    activity(io, USAGE);
    return 2;
  }
  const target = await resolveTarget(io, targetOptions(values));
  try {
    const client = new JR2Client(target.url, io.fetch, target.token);
    const ref = await resolveRunId(client, given);
    if (!ref.ok) {
      activity(io, ref.message);
      return ref.code;
    }
    const runId = ref.runId;

    // Gate delivery: the event name is the workflow's own vocabulary — case-preserved, never
    // normalized here (the host validates it against the gate's accepts).
    if (gate) {
      let input: Record<string, unknown> = {};
      if (values.input !== undefined) {
        try {
          input = JSON.parse(values.input as string) as Record<string, unknown>;
        } catch {
          activity(io, `jr2 send: --input is not valid JSON`);
          return 2;
        }
      }
      await client.sendToGate(runId, gate, { type: event, ...input });
      activity(io, `delivered ${event} to gate "${gate}" on ${runId}`);
      return 0;
    }

    const control = event.toUpperCase();
    if (control !== "CANCEL") {
      activity(io, `jr2 send: unknown event "${event}" (run control accepts: CANCEL; workflow events need --gate)`);
      return 2;
    }
    await client.send(runId, { type: control });
    activity(io, `sent ${control} to ${runId}`);
    return 0;
  } finally {
    target.close?.();
  }
}
