// Instance config (ADR-0009). Its presence at the folder root is what marks this directory as a j2
// instance — the `j2` CLI walks up from cwd to find it. `defineConfig` is an identity passthrough
// that pins the shape to `J2Config` for authoring-time inference.
//
// `repos` is the one irreducible entry: the orchestrator materializes a read-only `default/` checkout
// per repo as the source-of-truth volume every Workspace worktrees against. An entry is a url string —
// named after the repository, minus `.git` — or `{ name, url, ref }` when the name must differ (ADR-0004).
// This starter has none yet (its workflows don't touch a Workspace), so the list is empty.
//
// Workspaces (ADR-0012) are opt-in by adding repos — a Workspace needs them (ADR-0031): the orchestrator
// then reconciles `repos/` at boot and drives Sandbox CRs via kubectl in its own namespace (ADR-0019).
//
// The `declare module` block below is what makes those names TYPED (ADR-0050). A Repo is the one
// thing a Machine names by string and cannot carry — Agents and Sandbox Images ride the Machine
// itself (ADR-0049) — so the catalog is declared here and registered back to the kit. A
// `workspace()` spec's `repos[].name` is then this catalog's names, and a typo is a compile error
// that `j2 up` refuses on before it builds anything. Keep it beside the export: it is one line of
// bookkeeping, and without it every repo name silently falls back to `string`.

import { defineConfig } from "@j2/orchestrator";

const config = defineConfig({
  repos: [],
});

declare module "@j2/orchestrator" {
  interface Register {
    config: typeof config;
  }
}

export default config;
