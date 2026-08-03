// Instance config (ADR-0009). Its presence at the folder root is what marks this directory as a j2
// instance — the `j2` CLI walks up from cwd to find it. `defineConfig` is an identity passthrough
// that pins the shape to `J2Config` for authoring-time inference.
//
// `repos` is the one irreducible entry: the orchestrator materializes a read-only `default/` checkout
// per repo as the source-of-truth volume every Workspace worktrees against. This starter has none yet
// (its workflows don't touch a Workspace), so the list is empty.
//
// Workspaces (ADR-0012) are opt-in by adding `sandbox: { image: "<harness image>" }`: the orchestrator
// then reconciles `repos/` at boot and drives Sandbox CRs via kubectl in its own namespace (ADR-0019).

import { defineConfig } from "@j2/orchestrator";

export default defineConfig({
  repos: [],
});
