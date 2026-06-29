// `j2 dev [--port <p>] [--hostname <h>]` (ADR-0009): boot THIS instance's orchestrator in-process and
// serve it until Ctrl-C. "Local control plane, real data plane" — `startInstance` discovers
// `workflows/`, restores in-flight runs, and serves the hono surface; the data plane (real Sandboxes)
// is the orchestrator's concern, stubbed until that slice lands.
//
// The one CLI-specific job: advertise the live address by writing `.j2/dev.json` = { url, pid } so the
// run-control verbs can attach, and remove it on a clean exit. No hot-reload in v1 (a follow-up).
//
// This command is intentionally not part of the testable `Io` surface for its lifecycle bits: it owns
// process signals and blocks forever, so it is exercised end-to-end rather than in unit tests.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { startInstance } from "@j2/orchestrator";
import { resolveRoot } from "../instance.ts";
import { activity, type Io } from "../output.ts";

export async function dev(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { port: { type: "string" }, hostname: { type: "string" } },
  });

  const root = resolveRoot(io.cwd);
  const inst = await startInstance({
    dir: root,
    port: values.port ? Number(values.port) : undefined,
    hostname: values.hostname as string | undefined,
  });

  const devPath = join(root, ".j2", "dev.json");
  await mkdir(join(root, ".j2"), { recursive: true });
  await writeFile(devPath, `${JSON.stringify({ url: inst.url, pid: process.pid }, null, 2)}\n`);

  activity(io, `j2 dev — serving ${root}`);
  activity(io, `  url:       ${inst.url}`);
  activity(io, `  workflows: ${inst.workflows.join(", ") || "(none)"}`);
  activity(io, "  press Ctrl-C to stop");

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    activity(io, "stopping…");
    await inst.close();
    await rm(devPath, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise<void>(() => {}); // serve until a signal triggers shutdown
  return 0; // unreachable
}
