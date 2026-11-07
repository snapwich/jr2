// The project context under `projectContext: "workspace"` (ADR-0062): the reader's context files
// go up to `/work`, so the slot's and the Workspace's files reach it too. See `_contexted.ts`.

import { workspace } from "@jr2/orchestrator";
import { body } from "./_contexted.ts";

export const machine = workspace(body, {
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/app.git", ref: "main" } },
  projectContext: "workspace",
});
