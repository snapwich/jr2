// THE CONSUMER STORY (ADR-0054). Every other file in this folder is a fixture written FOR the
// tier; this one is the tier's proof of a SHIPPED Machine — `@j2/machines`'s `task`, registered
// here the way a user's own `workflows/` file registers it, and nothing else. If the line below
// stops being the line the package's own prose tells a user to write, this file is wrong.
//
// The kit ships Machines and never Workflows (CONTEXT.md): `task` is a Machine, and `task` the
// WORKFLOW is the name this module's filename gives it. Both parts the package left OPEN are
// bound right here, because a package cannot know the repository and cannot pay for the model —
// the seed repository this tier serves in-cluster, and the scripted model behind the fake
// provider. Leave either out and `j2 up` refuses the converge naming this very line, which is the
// whole point of Open.

import { customize } from "@j2/orchestrator";
import { task } from "@j2/machines";

export const machine = customize(task, {
  // The same Repo the tier's other workflows bind (ADR-0051), under the SLOT NAME the package
  // chose: `target`, not `app`. The slot key is the Machine's word, the url is ours.
  repos: { target: { url: "http://seed.j2-e2e-seed.svc/app.git", ref: "main" } },
  // The one model this instance has (`j2.config.ts`'s `fake` provider): a real Agent definition at
  // a real model id, so `j2 up`'s provider preflight probes it like any other.
  agents: { coder: { model: "fake/model-x" } },
});
