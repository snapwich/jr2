// The @model tier's instance config (ADR-0066): the @kind instance's shape (ADR-0010) with the
// last fake removed. Bring-up is the product's own path — one shared vanilla kind cluster, then
// `jr2 up` per scenario into a FRESH namespace; the workflows bind the seed Repo the suite serves
// in-cluster, and the fence admits that host alone (ADR-0051).
//
// The provider is REAL — a custom `harness.provider` (the home-lab vLLM) or a pi catalog provider
// (`anthropic`), as the profile says. Everything about it comes from `model-endpoint.json`, which the fixture
// materializes from the selected `features/model-endpoints/<name>.json` before the converge
// (`workflows/_profile.ts` says why a file and not env). The one deployment-varying value that
// stays on env is the key (`JR2_MODEL_API_KEY`), never a file of this checkout. It is a literal
// Held secret (ADR-0059): `jr2 up` writes it into the held Secret of each pod that names it, which
// only that pod's Custodian mounts, and into the provider check pod's Secret, which `jr2 up`
// deletes after the check (ADR-0019). The Harness container holds only its Stand-in.
//
// NO IMAGE IS NAMED HERE (ADR-0038): this checkout's `jr2 up` builds and loads every image it
// deploys, including `images/default` below — the same Sandbox Image the @kind tier runs.

import { defineConfig } from "@jr2/orchestrator";
import { profile } from "./workflows/_profile.ts";

export default defineConfig({
  name: "jr2-e2e-model",
  git: {
    credentials: [
      { match: "seed.jr2-e2e-seed.svc/" },
      // The seed's push remote over ssh (ADR-0067), as the @kind instance names it: the
      // `continue-after-signed-push` claim's Binding. Its scenario writes both Secrets from the
      // seed's keys before `jr2 up`; any other scenario's `jr2 up` generates a deploy key nothing
      // authorizes, and that namespace's cache of `push.git` fails its probe and serves anyway.
      {
        match: "seed.jr2-e2e-seed.svc/srv/",
        sshKey: "jr2-e2e-push-key",
        sign: { sshKey: "jr2-e2e-sign-key", name: "jr2 e2e signer", email: "signer@jr2.test" },
      },
    ],
  },
  // The @kind Size (ADR-0060): small enough for several trials in flight on one node, and the
  // ceiling the `noticed` claim's memory kill is measured against (ADR-0061).
  sandbox: { resources: { limits: { memory: "1Gi", cpu: "500m" } } },
  // The key is a Held secret either way (ADR-0059). A catalog provider (`profile.key`) reads a known
  // model key, so the key goes in `secrets` under that name, exactly as a user's instance holds it;
  // a custom provider's key is its `apiKey`.
  ...(profile.key === undefined ? {} : { secrets: [{ name: profile.key, value: process.env.JR2_MODEL_API_KEY }] }),
  harness: {
    ...(profile.key !== undefined
      ? {}
      : {
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
        }),
    ...(profile.caBundle === undefined ? {} : { caBundle: profile.caBundle }),
  },
});
