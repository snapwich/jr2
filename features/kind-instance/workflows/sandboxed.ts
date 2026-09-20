// The kind tier's workflow (ADR-0012): a REAL workspace() — a real Sandbox, the node's Repo cache
// mounted read-only, a real worktree, and a real Harness endpoint the body's agent is admitted
// against. The body (`_body.ts`) is deliberately thin: what the tier proves is the WRAPPER's
// contract with the cluster (provision → attach → run → destroy) plus its two durability claims
// (re-attach on restore; `workspace.lost` when the Sandbox was reaped while the orchestrator was
// down).

import { workspace } from "@jr2/orchestrator";
import { body } from "./_body.ts";

// The one Repo Slot, `app`, BOUND to the seed repository the suite serves in-cluster (ADR-0051):
// the url is the identity, so this literal is what the walk warms and what the cache clones.
export const machine = workspace(body, {
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
  spec: () => ({ branch: "feat-e2e" }),
});
