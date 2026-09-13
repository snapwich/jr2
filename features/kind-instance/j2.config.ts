// The @kind tier's instance config (ADR-0010): bring-up is the product's own path — one shared
// vanilla kind cluster, then `j2 up` per scenario into a FRESH namespace (`-n` at the CLI;
// namespace-as-identity makes the scenario the isolation unit, ADR-0019).
//
// No Repo is named here (ADR-0051): the tier's workflows bind their one slot to the seed
// repository the e2e suite serves in-cluster over HTTP (`seed.j2-e2e-seed.svc`), and this file
// declares only the credentials FENCE — an entry admitting that host by prefix, with no token and
// no key, so a per-run url naming it clones anonymously and any other host is refused at attach.
//
// NO IMAGE IS NAMED HERE (ADR-0038). The `j2` binary under test runs from this checkout, so its
// converge builds the Harness, Adapter, operator, this instance, and `images/default` from source
// at content-addressed tags and `kind load`s them itself. Naming a `:local` tag here is exactly the
// invisible-stale-image bug that decision deletes.
//
// The substitution this tier needs is at the PROVIDER, not the image: the pod runs the STOCK
// Harness and the only fake left is the model behind this endpoint (`features/steps/fake-provider.ts`).

import { defineConfig } from "@j2/orchestrator";

export default defineConfig({
  name: "j2-e2e-kind",
  git: { credentials: [{ match: "seed.j2-e2e-seed.svc/" }] },
  harness: {
    provider: {
      id: "fake",
      api: "openai-completions",
      // Deployment-varying, so it rides env (ADR-0019): the World starts the scripted endpoint on
      // an ephemeral port per scenario and publishes a POD-reachable address (the kind bridge
      // gateway — localhost never works from a pod).
      baseUrl: process.env.J2_FAKE_PROVIDER_URL ?? "",
      // Committed, not deployment-varying: a CUSTOM provider id has no catalog entry, so unset
      // limits resolve to 0 and Compaction is left with no context budget to reason about
      // (ADR-0036). These are properties of the model, and this model is ours.
      models: { "model-x": { contextWindow: 200_000, maxTokens: 4096 } },
    },
  },
});
