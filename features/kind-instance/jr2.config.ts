// The @kind tier's instance config (ADR-0010): bring-up is the product's own path — one shared
// vanilla kind cluster, then `jr2 up` per scenario into a FRESH namespace (`-n` at the CLI;
// namespace-as-identity makes the scenario the isolation unit, ADR-0019).
//
// No Repo is named here (ADR-0051): the tier's workflows bind their one slot to the seed
// repository the e2e suite serves in-cluster over HTTP (`seed.jr2-e2e-seed.svc`), and this file
// declares only the credentials FENCE — an entry admitting that host by prefix, with no token and
// no key, so a per-run url naming it clones anonymously and any other host is refused at attach.
//
// NO IMAGE IS NAMED HERE (ADR-0038). The `jr2` binary under test runs from this checkout, so its
// converge builds the Harness, operator, this instance, and `images/default` from source at
// content-addressed tags and `kind load`s them itself; the Custodian's pinned Envoy a node pulls. Naming a `:local` tag here is exactly the
// invisible-stale-image bug that decision deletes.
//
// The substitution this tier needs is at the PROVIDER, not the image: the pod runs the STOCK
// Harness and the only fake left is the model behind this endpoint (`features/steps/fake-provider.ts`).
// It is a provider that wants a key, over HTTPS — so the tier runs every turn through the Custodian
// (ADR-0059): `apiKey` is a held secret, bound to this endpoint's host, and the Harness container
// holds only its Stand-in.

import { defineConfig, secret } from "@jr2/orchestrator";
import { github } from "@jr2/hooks/github";
import { gitlab } from "@jr2/hooks/gitlab";
import { chat } from "./workflows/_chat.ts";

export default defineConfig({
  name: "jr2-e2e-kind",
  git: {
    credentials: [
      { match: "seed.jr2-e2e-seed.svc/" },
      // The seed's push remote (ADR-0067, ADR-0051): `push.git` over ssh, the `pushed` workflow's
      // Binding. The deploy key clones and pushes (no `push` field); `sign` names the key the
      // Sandbox Effector signs with. A scenario that runs `pushed` writes both Secrets from the
      // seed's keys before `jr2 up` (`steps/kind.steps.ts`); any other scenario's `jr2 up`
      // generates a deploy key nothing authorizes, so that namespace's cache of `push.git` fails
      // its probe and serves anyway (ADR-0048), as `unsynced`'s does.
      {
        match: "seed.jr2-e2e-seed.svc/srv/",
        sshKey: "jr2-e2e-push-key",
        sign: { sshKey: "jr2-e2e-sign-key", name: "jr2 e2e signer", email: "signer@jr2.test" },
      },
      // The seed's GPG push remote (ADR-0068): `gpg.git`, the `gpgsigned` workflow's Binding.
      // The same deploy key; a GPG key the Sandbox Effector signs with, which the scenario writes
      // from a key it makes on the host before `jr2 up`.
      {
        match: "seed.jr2-e2e-seed.svc/srv/gpg",
        sshKey: "jr2-e2e-push-key",
        sign: { gpgKey: "jr2-e2e-gpg-key", name: "jr2 e2e signer", email: "signer@jr2.test" },
      },
    ],
  },
  // The tier's one Effect secret (ADR-0068): the `called` and `asked` workflows' http Effects name
  // it, so it is placed in the Instance Effector, and the `effected` workflow's file-body http and
  // credentialed command name it, so it is placed in that Workspace's Sandbox Effector — no
  // `workspace()` lists it and no provider reads it, so no Custodian holds it. Per scenario, from env like the provider key; in-cluster it reads undefined, which is
  // safe: the Orchestrator never sees an Effect secret.
  //
  // `self-token` is the `dispatched` workflow's (ADR-0071): the target token its dispatch names,
  // so it is placed in the Instance Effector beside `echo-token`. A literal from env, per scenario:
  // the dispatch scenario writes the same value as the Instance token into the `jr2-instance`
  // Secret before `jr2 up`, which keeps it; in every other scenario it unlocks nothing. Not a
  // `valueFrom` on `jr2-instance`: that Secret does not exist yet when a first converge resolves
  // what its Effects name, so the converge would be refused.
  //
  // `PROBE_KEY` is a Held secret (ADR-0059, ADR-0076): the `sibling` workflow's `workspace()` grants
  // it, so its Agents' confined programs hold its Stand-in in env, and the Custodian puts the value
  // in `x-probe-key` toward the scripted model's host alone. Its own header, because two secrets
  // bound to one host share no header.
  //
  // `GH_HOOK` and `CHAT_SIGNING` are the two Hooks' secrets (ADR-0068, ADR-0078): each Hook has a
  // `mac` verifier, so `jr2 up` places its secret in the Instance Effector alone, which checks each
  // signature. Per scenario, from env; a step signs each delivery with the same value. `GL_HOOK` is
  // the `lab` Hook's, whose verifier is `token`: `jr2 up` gives the Orchestrator only its sha-256,
  // in `jr2-hook-digests`, and a step sends the value in the header.
  secrets: [
    { name: "echo-token", value: process.env.JR2_ECHO_TOKEN },
    { name: "GH_HOOK", value: process.env.JR2_GH_HOOK },
    { name: "CHAT_SIGNING", value: process.env.JR2_CHAT_SIGNING },
    { name: "GL_HOOK", value: process.env.JR2_GL_HOOK },
    { name: "self-token", value: process.env.JR2_SELF_TOKEN },
    {
      name: "PROBE_KEY",
      value: process.env.JR2_PROBE_KEY,
      hosts: [process.env.JR2_FAKE_PROVIDER_URL ?? ""],
      headers: ["x-probe-key"],
    },
  ],
  // The Size of every Sandbox this tier provisions (ADR-0060): below the kit default, because jr2
  // reserves the whole Size and the tier runs several scenarios at once on ONE kind node — at 2Gi
  // and one cpu each, beside every scenario's kit-sized control pods, a 4-core runner leaves
  // Sandboxes Pending. The Harness still gets 960Mi and 450m after the Custodian's share. The Size
  // alone is not enough there: the control pods ask 900m a scenario before any Sandbox, so the
  // runner also runs fewer workers (`just e2e-kind 2`; the recipe has the arithmetic).
  // One named Caller token (ADR-0078): `jr2 up` makes its value in a Secret of its own and gives the
  // Orchestrator only the digest. The Callers Rule reads it, sends it and rotates it.
  callers: { tokens: { ci: { may: { read: "all" } } } },
  // Three Hooks (ADR-0078). Two have a `mac` verifier, which the Instance Effector checks
  // (ADR-0068): `forge` (GitHub) and `chat`, Slack's protocol with a follow-up host the tier can
  // serve (`workflows/_chat.ts`). `jr2 up` writes `chat`'s `posts` host into the Effector's fence.
  // `lab` (GitLab) has a `token` verifier, which the Orchestrator checks against the digest.
  hooks: {
    forge: github({ secret: secret("GH_HOOK") }),
    chat: chat({ secret: secret("CHAT_SIGNING") }),
    lab: gitlab({ secret: secret("GL_HOOK") }),
  },
  sandbox: { resources: { limits: { memory: "1Gi", cpu: "500m" } } },
  harness: {
    provider: {
      id: "fake",
      api: "openai-completions",
      // Deployment-varying, so it rides env (ADR-0019): the World starts the scripted endpoint on
      // an ephemeral port per scenario and publishes a POD-reachable address (the kind bridge
      // gateway — localhost never works from a pod).
      baseUrl: process.env.JR2_FAKE_PROVIDER_URL ?? "",
      // Per scenario, from env like the endpoint. In-cluster this reads undefined, which is safe:
      // the Orchestrator composes pods from what `jr2 up` resolved, never from this field.
      apiKey: process.env.JR2_FAKE_PROVIDER_KEY,
      // Committed, not deployment-varying: a CUSTOM provider id has no catalog entry, so unset
      // limits resolve to 0 and Compaction is left with no context budget to reason about
      // (ADR-0036). These are properties of the model, and this model is ours.
      models: { "model-x": { contextWindow: 200_000, maxTokens: 4096 } },
    },
    // The tier's provider CA (`features/steps/world.ts` issues it on first need, gitignored). The
    // Custodian verifies the provider with it, and the Harness trusts it beside the jr2 CA.
    caBundle: "../.tmp/fake-provider-ca.crt",
  },
});
