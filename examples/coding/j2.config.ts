// Instance config (ADR-0009). Its presence at the folder root is what marks this directory as a j2
// instance — the `j2` CLI walks up from cwd to find it.
//
// `repos` is empty: the coding workflow's `workspace()` spec names the repos it needs per-run, and
// nothing here is booted against a cluster yet. This config exists so `j2 visualize coding` can boot
// an ephemeral orchestrator and render the Machine.

import { defineConfig } from "@j2/orchestrator";

export default defineConfig({
  repos: [],
});
