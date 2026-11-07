// The project context under the default bound (ADR-0062): `projectContext` is left out, so it is
// "worktree", and the reader's context files stop at its Worktree's root. See `_contexted.ts`.

import { workspace } from "@jr2/orchestrator";
import { body } from "./_contexted.ts";

export const machine = workspace(body, {
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
});
