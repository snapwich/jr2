#!/usr/bin/env node
// The instance image's entrypoint (ADR-0019): boot the orchestrator described by env + cwd and
// serve until SIGINT/SIGTERM. A zero-build `.ts` shebang like the `j2` bin; the e2e tier spawns
// this exact process as its per-scenario fixture (ADR-0010). Logic lives in `serverMain` — this
// file owns only what a process owns: env, cwd, stdout, signals, exit.

import { serverMain } from "../src/server.ts";

const inst = await serverMain({
  dir: process.cwd(),
  env: process.env,
  announce: (line) => console.log(line),
});

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await inst.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
