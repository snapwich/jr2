// The kind tier's instance config, copied into `features/.tmp/kind/` by `just e2e-kind-up`.
//
// Why a FIXED instance folder (the rest of the suite mkdtemps one per scenario): kind resolves
// hostPath against the NODE, so the instance's `repos/` reaches Sandbox pods only through
// `nodes[].extraMounts` — baked when the cluster is created and unchangeable after (ADR-0009).
// One cluster therefore serves exactly one repos path, so the kind tier shares one instance and
// isolates scenarios by run (each scenario boots its own `j2 dev` and gets its own Sandboxes).
//
// `repos[].url` is the seed repo the recipe git-inits beside it: the reconcile clones it into
// `repos/app/default`, which is the read-only volume every worktree is `--shared` against.

import { defineConfig } from "@j2/orchestrator";

export default defineConfig({
  repos: [{ name: "app", url: new URL("./src/app", import.meta.url).pathname }],
  // Both images are load-bearing (ADR-0013): the Harness runs the Agent, the Adapter is the only
  // way that Agent can reach its Machine. Without the second, the pod is mute.
  sandbox: { image: "j2-harness-dev:local", adapterImage: "j2-adapter:local" },
});
