// The kind tier's UNSYNCABLE Repo (ADR-0048): `sandboxed`'s body, bound to a url the seed's host
// admits by prefix and serves nothing at. What it proves is degrade-not-die: the boot of every
// scenario's Orchestrator states this Repo and probes it, the probe fails, and the Orchestrator
// serves anyway — every other kind scenario passing IS that claim. `j2 status` names the Repo
// with git's own error, and a run of THIS workflow — the one that needs the cache — faults at
// provision naming the Repo and the error, while nothing else in the instance is held on it (the
// operator gates a Sandbox on the Repos its own CR names, ADR-0051).

import { workspace } from "@j2/orchestrator";
import { body } from "./_body.ts";

export const machine = workspace(body, {
  repos: { app: { url: "http://seed.j2-e2e-seed.svc/missing.git", ref: "main" } },
  spec: () => ({ branch: "feat-e2e" }),
});
