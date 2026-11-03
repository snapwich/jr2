// The Worktree load on a 4-vCPU CI runner (the step picks it when CI is set): the tier's own Sandbox
// cpu, which is what a runner has left beside the other scenario's pods (the justfile's `e2e-kind`
// has the arithmetic). The coders are the same, so the load runs, and it runs slower than `wt-load`.
import { workspace } from "@jr2/orchestrator";
import { body, door } from "./_wt-load.ts";

export const machine = workspace(body, {
  input: door,
  resources: { limits: { memory: "2Gi", cpu: "500m" } },
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/large.git", ref: "main" } },
});
