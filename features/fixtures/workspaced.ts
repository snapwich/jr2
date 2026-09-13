// A minimal workspace() workflow (ADR-0012): the body is trivial — what this fixture exercises
// black-box is the WRAPPER's contract with the instance. On an instance without a data plane (a
// host-booted process outside any cluster — ADR-0031/0051) a run of this must fault pointedly,
// never hang or zombie. The kind e2e tier runs this same shape for real.

import { setup } from "xstate";
import { workspace } from "@j2/orchestrator";

const body = setup({}).createMachine({
  id: "body",
  initial: "done",
  states: { done: { type: "final" } },
});

export const machine = workspace(body, {
  repos: { app: "https://example.test/app.git" },
  spec: () => ({ branch: "feat-e2e" }),
});
