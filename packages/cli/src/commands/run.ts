// `j2 run <workflow> [--input <json>] [--detach]` (ADR-0009). BLOCKING + attach-by-default, mirroring
// `flue run`: start the run, then attach to its SSE feed — status deltas + author emits go to stderr
// as they happen; the terminal RunStatus is printed as JSON on stdout and we exit. So `j2 run ping`
// shows progress to a human while `j2 run ping | jq` yields just the result.
//
// Diverges from flue: with no --url this ATTACHES to the already-running orchestrator (via .j2/dev.json)
// rather than a per-invocation runtime, because j2 runs are durable and may park indefinitely on an
// approval gate. `--detach` prints the runId and returns, leaving the run going server-side.

import { parseArgs } from "node:util";
import { J2Client } from "../client.ts";
import { resolveBaseUrl } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";

export async function run(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: {
      input: { type: "string" },
      detach: { type: "boolean" },
      url: { type: "string" },
    },
  });

  const workflow = positionals[0];
  if (!workflow) {
    activity(io, "usage: j2 run <workflow> [--input <json>] [--detach]");
    return 2;
  }
  const input = values.input ? (JSON.parse(String(values.input)) as Record<string, unknown>) : {};
  const client = new J2Client(resolveBaseUrl(io, { url: values.url as string | undefined }), io.fetch);

  const { runId } = await client.start(workflow, input);
  if (values.detach) {
    result(io, { runId });
    return 0;
  }

  activity(io, `run ${runId} (${workflow}) — attached`);
  for await (const ev of client.events(runId)) {
    if (ev.kind === "emit") {
      activity(io, `  emit ${JSON.stringify(ev.event)}`);
      continue;
    }
    activity(io, `  → ${ev.status.status} ${JSON.stringify(ev.status.value)}`);
    if (ev.status.status !== "active") {
      result(io, ev.status);
      return ev.status.status === "error" ? 1 : 0;
    }
  }
  return 0;
}
