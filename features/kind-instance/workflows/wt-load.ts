// The Worktree load on a host with cores to spare: 4 cpu, so that the coders run as concurrently as
// the host allows. A 4-vCPU CI runner can never place this Size; the step runs `wt-load-ci` there.
import { workspace } from "@jr2/orchestrator";
import { body, door } from "./_wt-load.ts";

export const machine = workspace(body, {
  input: door,
  resources: { limits: { memory: "6Gi", cpu: "4" } },
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/large.git", ref: "main" } },
});
