// The @kind tier's instance config (ADR-0010): bring-up is the product's own path — one shared
// kind cluster with no image in it (`just e2e-kind-up`), on which `jr2 up` installs the Fence's
// prerequisites (ADR-0084), then `jr2 up` per scenario into a FRESH namespace (`-n` at the CLI;
// namespace-as-identity makes the scenario the isolation unit, ADR-0019).
//
// No Repo is named here (ADR-0051): the tier's workflows bind their one slot to the seed
// repository the e2e suite serves in-cluster over HTTP (`seed.jr2-e2e-seed.svc.cluster.local`),
// and this file declares only the credentials FENCE — an entry admitting that host by prefix, with
// no token and no key, so a per-run url naming it clones anonymously and any other host is refused
// at attach. Each seed name is the Service's full name, because the Custodian resolves a name as
// it is written (ADR-0084).
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
// holds only its Stand-in. The endpoint has a name, `model.<namespace>.svc.cluster.local`: a
// Service of the scenario's namespace with no selector, whose one endpoint is the host, so a turn
// takes the path of a hosted provider, by name, through the Fence (ADR-0084).

import { defineConfig, secret } from "@jr2/orchestrator";
import { github } from "@jr2/orchestrator/hooks/github";
import { gitlab } from "@jr2/orchestrator/hooks/gitlab";
import { chat } from "./workflows/_chat.ts";

export default defineConfig({
  name: "jr2-e2e-kind",
  git: {
    credentials: [
      { match: "seed.jr2-e2e-seed.svc.cluster.local/" },
      // The seed's push remote (ADR-0067, ADR-0051): `push.git` over ssh, the `pushed` workflow's
      // Binding. The deploy key clones and pushes (no `push` field); `sign` names the key the
      // Sandbox Effector signs with. A scenario that runs `pushed` writes both Secrets from the
      // seed's keys before `jr2 up` (`steps/kind.steps.ts`); any other scenario's `jr2 up`
      // generates a deploy key nothing authorizes, so that namespace's cache of `push.git` fails
      // its probe and serves anyway (ADR-0048), as `unsynced`'s does.
      {
        match: "seed.jr2-e2e-seed.svc.cluster.local/srv/",
        sshKey: "jr2-e2e-push-key",
        sign: { sshKey: "jr2-e2e-sign-key", name: "jr2 e2e signer", email: "signer@jr2.test" },
      },
      // The seed's GPG push remote (ADR-0068): `gpg.git`, the `gpgsigned` workflow's Binding.
      // The same deploy key; a GPG key the Sandbox Effector signs with, which the scenario writes
      // from a key it makes on the host before `jr2 up`.
      {
        match: "seed.jr2-e2e-seed.svc.cluster.local/srv/gpg",
        sshKey: "jr2-e2e-push-key",
        sign: { gpgKey: "jr2-e2e-gpg-key", name: "jr2 e2e signer", email: "signer@jr2.test" },
      },
    ],
  },
  // The tier's Effect secrets (ADR-0068). `echo-token`: the `called` and `asked` workflows' http
  // Effects name it, so it is placed in the Instance Effector, and the `effected` workflow's
  // credentialed commands name it, so that Workspace's Sandbox Effector holds its value. The
  // `shared` workflow's file-body http sends it as a bearer, so the Custodian of that Workspace's pod
  // holds it, and its Sandbox Effector holds its Stand-in. `echo-bearer`: the `effected` workflow's
  // file-body http sends it as a bearer, so the Custodian holds it for that Sandbox Effector — a
  // second name, because one file of the Effector cannot hold both the value a command reads and the
  // Stand-in the Custodian swaps. Per scenario, from env like the provider key; in-cluster each
  // reads undefined, which is safe: the Orchestrator never sees an Effect secret.
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
  // in `x-probe-key` toward the scripted model's host alone.
  //
  // `MCP_A_KEY` and `MCP_B_KEY` are the two secrets of the fake MCP server (ADR-0079): the servers
  // `lookup-a` and `lookup-b` of the `mcp` block below name one each. With no `hosts`, each is bound
  // to its server's url host, in `authorization` — one host and one header for both, and for the
  // provider key, so the Custodian chooses each value by the Stand-in a request carries (ADR-0059).
  // The `tooled` workflow's Agent names both servers, so its Sandbox's Custodian holds both. The
  // `advisedtooled` workflow's Menu-only Agent names `lookup-b`, so the Instance Harness's Custodian
  // holds `MCP_B_KEY`. The
  // `mcpcalled` workflow's `mcp` Effect calls `lookup-a`, so `MCP_A_KEY` is an Effect secret of the
  // Instance Effector too.
  //
  // `GH_HOOK` and `CHAT_SIGNING` are the two Hooks' secrets (ADR-0068, ADR-0078): each Hook has a
  // `mac` verifier, so `jr2 up` places its secret in the Instance Effector alone, which checks each
  // signature. Per scenario, from env; a step signs each delivery with the same value. `GL_HOOK` is
  // the `lab` Hook's, whose verifier is `token`: `jr2 up` gives the Orchestrator only its sha-256,
  // in `jr2-hook-digests`, and a step sends the value in the header.
  secrets: [
    { name: "echo-token", value: process.env.JR2_ECHO_TOKEN },
    { name: "echo-bearer", value: process.env.JR2_ECHO_BEARER },
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
    { name: "MCP_A_KEY", value: process.env.JR2_MCP_A_KEY },
    { name: "MCP_B_KEY", value: process.env.JR2_MCP_B_KEY },
  ],
  // The fake remote MCP server (ADR-0079), on the host, as the scripted model is: HTTPS under the
  // tier's CA (`caBundle` below), at a url that rides env like the provider's (`features/steps/
  // fake-mcp.ts`). Two names for one server, each with its own secret, as an Instance with two
  // workspaces of one service declares them. In-cluster the url reads empty, which is safe: the
  // Harness and the Effector read what `jr2 up` resolved.
  mcp: {
    "lookup-a": { url: process.env.JR2_FAKE_MCP_URL ?? "", secret: "MCP_A_KEY" },
    "lookup-b": { url: process.env.JR2_FAKE_MCP_URL ?? "", secret: "MCP_B_KEY" },
  },
  // The Size of every Sandbox this tier provisions (ADR-0060): below the kit default, because jr2
  // reserves the whole Size and the tier runs several scenarios at once on ONE kind node — at 2Gi
  // and one cpu each, beside every scenario's kit-sized control pods, a 4-core runner leaves
  // Sandboxes Pending. The Harness gets the whole Size, because the Custodian is a pod of its own
  // (ADR-0084). The Size alone is not enough there: before any Sandbox, a scenario's control pods
  // ask 850m and its Custodian pod asks 100m and 1,920Mi, so 950m a scenario, and Multus asks 100m
  // on the node. So the runner also runs fewer workers (`just e2e-kind 2`; the recipe has the
  // arithmetic).
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
  // What a Sandbox may reach with no secret (ADR-0084). A host that a secret is bound to (the model,
  // the MCP server) and each SSH Repo that a workflow binds need no entry. Each entry here is a
  // host that a Sandbox calls and that no secret and no binding names:
  //   - the seed's ssh port, for a per-run Repo over ssh (the handoff and LFS push scenarios): its
  //     url is run input, so no binding names it when `jr2 up` derives the list;
  //   - the seed's LFS server, which the Sandbox Effector's push uploads to, with no credential;
  //   - the unbound echo, by its address and port, as an author permits a host with no name: a
  //     Stand-in sent there arrives as it left (ADR-0059). Its url rides env like the provider's;
  //     in-cluster it reads empty, and the entry is left out.
  egress: [
    "seed.jr2-e2e-seed.svc.cluster.local:22",
    "lfs.jr2-e2e-seed.svc.cluster.local:80",
    ...(process.env.JR2_ECHO_URL ? [new URL(process.env.JR2_ECHO_URL).host] : []),
  ],
  harness: {
    provider: {
      id: "fake",
      api: "openai-completions",
      // Deployment-varying, so it rides env (ADR-0019): the World starts the scripted endpoint on
      // an ephemeral port per scenario and publishes the name of the `model` Service of the
      // scenario's namespace, whose one endpoint is this host at the scripted model's port.
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
