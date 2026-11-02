// The first import of `main.ts` (ADR-0076): it runs before any other module of the Harness, and so
// before a provider loads a module lazily. A Harness whose node looks for modules outside jr2's
// folders (`module-paths.ts`) says why, in the log and in the container's termination message, and
// exits 1. A test imports `module-paths.ts`, never this module.

import { writeFileSync } from "node:fs";
import { globalPaths, globalPathsFault } from "./module-paths.ts";

const fault = globalPathsFault(globalPaths());
if (fault !== undefined) {
  console.error(`jr2 harness: ${fault}`);
  try {
    writeFileSync("/dev/termination-log", fault);
  } catch {
    // Not in a pod.
  }
  process.exit(1);
}
