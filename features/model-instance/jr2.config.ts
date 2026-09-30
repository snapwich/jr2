// The @model tier's instance config (ADR-0066): the @kind instance's shape (ADR-0010) with the
// last fake removed. Bring-up is the product's own path — one shared vanilla kind cluster, then
// `jr2 up` per scenario into a FRESH namespace; the workflows bind the seed Repo the suite serves
// in-cluster, and the fence admits that host alone (ADR-0051).
//
// The provider is REAL. Everything about it comes from `model-endpoint.json`, which the fixture
// materializes from the selected `features/model-endpoints/<name>.json` before the converge
// (`workflows/_profile.ts` says why a file and not env). The one deployment-varying value that
// stays on env is the key: a Held secret (ADR-0059) the Custodian alone receives, never a file.
//
// NO IMAGE IS NAMED HERE (ADR-0038): this checkout's `jr2 up` builds and loads every image it
// deploys, including `images/default` below — the same Sandbox Image the @kind tier runs.

import { defineConfig } from "@jr2/orchestrator";
import { profile } from "./workflows/_profile.ts";

export default defineConfig({
  name: "jr2-e2e-model",
  git: { credentials: [{ match: "seed.jr2-e2e-seed.svc/" }] },
  // The @kind Size (ADR-0060): small enough for several trials in flight on one node, and the
  // ceiling the `noticed` claim's memory kill is measured against (ADR-0061).
  sandbox: { resources: { limits: { memory: "1Gi", cpu: "500m" } } },
  harness: {
    provider: {
      id: profile.id,
      api: profile.api,
      baseUrl: profile.baseUrl,
      apiKey: process.env.JR2_MODEL_API_KEY,
      models: {
        [profile.model]: {
          ...(profile.contextWindow === undefined ? {} : { contextWindow: profile.contextWindow }),
          ...(profile.maxTokens === undefined ? {} : { maxTokens: profile.maxTokens }),
        },
      },
    },
    ...(profile.caBundle === undefined ? {} : { caBundle: profile.caBundle }),
  },
});
