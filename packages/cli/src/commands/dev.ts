// `j2 dev [--port <p>] [--hostname <h>]` (ADR-0009): boot THIS instance's orchestrator in-process and
// serve it until Ctrl-C. "Local control plane, real data plane" — `startInstance` discovers
// `workflows/`, restores in-flight runs, and serves the hono surface; the data plane (real Sandboxes)
// is the orchestrator's concern, stubbed until that slice lands.
//
// Two CLI-specific jobs on top of `startInstance`:
//   1. advertise the live address by writing `.j2/dev.json` = { url, pid } so the run-control verbs
//      can attach, and remove it on a clean exit;
//   2. hot-reload: watch `<root>/workflows` and re-register on change. This lives HERE, not in the
//      engine — a deployed orchestrator ships workflows baked into its image and has no source tree
//      to watch, so file-watching is a dev-only affordance (see `RunningInstance.reload`).
//
// This command is intentionally not part of the testable `Io` surface for its lifecycle bits: it owns
// process signals and blocks forever, so it is exercised end-to-end rather than in unit tests.

import { watch } from "node:fs";
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

  // Hot-reload: debounce a burst of fs events (an editor save fires several) into one `reload()`.
  const wfDir = join(root, "workflows");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reload = async (): Promise<void> => {
    try {
      const { added, removed, updated, workflows } = await inst.reload();
      const delta = [...added.map((n) => `+${n}`), ...removed.map((n) => `-${n}`), ...updated.map((n) => `~${n}`)];
      activity(io, `reloaded ${delta.join(" ") || "(no change)"} — workflows: ${workflows.join(", ") || "(none)"}`);
    } catch (err) {
      activity(io, `reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  try {
    watch(wfDir, (_event, filename) => {
      if (filename && (!filename.endsWith(".ts") || filename.startsWith("_"))) return;
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), 80);
    });
  } catch {
    // no `workflows/` dir yet → nothing to watch; the instance still serves.
  }

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
