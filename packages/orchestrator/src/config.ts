// Instance configuration (ADR-0050): the deployment facts a Machine cannot carry — the instance's
// identity and reach, what its Harness may reach, and how the cluster authenticates to Repos. What
// a Sandbox is MADE of and which Repos it attaches are not here — they are `workspace()` options
// (ADR-0037/0049/0051), and every image ref is resolved by `jr2 up` (ADR-0038). There is no `images`
// block and nothing that names a Repo, deliberately: neither would type anything a Machine cannot
// carry itself, and an override seat for the Harness ref is the eject hatch ADR-0027 refuses.
//
// `defineConfig` is an identity passthrough — it exists solely so a `jr2.config.ts` is checked
// against `JR2Config` at authoring time and in `jr2 up`'s typecheck gate (ADR-0050), exactly like
// the config helpers in vite/tsup/etc. No runtime behavior beyond returning its argument. It is
// NOT generic: the parameter is `JR2Config` itself, so the literal an author writes gets
// excess-property checking at every depth. A generic `<T extends JR2Config>` would infer `T` as
// the literal's own type and check nothing an extra key could break — a `tokn` on a
// `git.credentials` entry would compile, and that entry would admit its prefix through the fence
// anonymously (ADR-0051). Nothing reads the literal's type back, so the generic buys nothing.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { repoIdentity } from "./repo-identity.ts";
import { assertSize, type Size } from "./size.ts";

// ------------------------------------------------------------------------------------------------
// `git.credentials` (ADR-0051): how the cluster authenticates to a Repo, and the fence.
//
// A Repo is identified by its url and nothing in this file names one (GLOSSARY.md "Repo"). What
// the config declares is CREDENTIALS, matched by prefix on the identity — the Argo and Flux shape.
// The Orchestrator resolves the entry when it creates a Repo CR and writes a `secretRef`; the
// cache agent reads only that. The list is also the fence: a per-run url (run input, a ticket
// field) that matches no entry is refused at attach, so nothing can spend this cluster's
// credential against an arbitrary host. A bound url is code the Instance typechecked and deployed
// — admitted without a match, cloned anonymously.

// One credentials entry. An entry may carry neither `token` nor `sshKey`: it then admits its
// prefix through the fence and the clone is anonymous.
/** One entry of `git.credentials`: the credential that the cluster uses for the Repos whose
 * identity starts with `match`. An entry with neither `token` nor `sshKey` admits its Repos
 * through the fence, and they clone with no credential. */
export type GitCredential = {
  /** The Repos this entry is for: a prefix of a Repo's identity, such as `github.com/ourorg/`, or
   * `*` for every Repo. The identity of a Repo is its host and path with no scheme, user or `.git`.
   * When more than one entry matches, the longest `match` wins; on a tie, the first entry in the
   * list wins. */
  match: string;
  // The cache agent spends the clone Secret; the Orchestrator never holds it (ADR-0068).
  /** For an `https://` url: the name of the env var that holds a token, read from the shell or
   * `.env` when `jr2 up` runs. `jr2 up` writes the value into a Secret (`jr2-git-<hash>`) that only
   * the Repo cache agent reads. The Agent never sees it. */
  token?: string;
  /** For an ssh url: the name of a Secret that you create. It holds a deploy key under the Flux
   * key names `identity`, `identity.pub` and `known_hosts`. */
  sshKey?: string;
  // The credential a `push()` spends (ADR-0051, ADR-0067). A token goes Basic through a credential
  // helper only.
  /** The credential that a `push()` Effect uses, when it is not the clone credential. Write
   * `{ sshKey }` or `{ token }`. Default: the clone credential pushes. An entry with no credential
   * admits a clone and never a push. When the push finds no usable credential, it is refused, for
   * example: `no git.credentials entry matches "<identity>" — a push spends the entry its url
   * matches`, or `git.credentials entry "<match>" holds no credential a push over <scheme> can
   * spend`. */
  push?:
    | {
        /** For an ssh url: the name of a Secret that you create, with the same keys as the
         * entry's `sshKey`. */
        sshKey: string;
      }
    | {
        /** For an `https://` url: the name of the env var that holds the push token, read as for
         * the entry's `token`. */
        token: string;
      };
  // Explicit (ADR-0067): an auth key is never reused as a signing key.
  /** The key that a `push({ sign: true })` signs with, and the committer it signs as:
   * `{ sshKey, name, email }` or `{ gpgKey, name, email }`. `sshKey` names a Secret with
   * `identity`. `gpgKey` names a Secret with `private.asc` and no passphrase. jr2 never signs with
   * the clone or push key, so name the signing key here. The email must belong to the forge account
   * that holds the key, or the forge shows the signature as unverified. A signed push without it is
   * refused: `signed, and git.credentials entry "<match>" holds no sign field`. */
  sign?:
    | {
        /** The name of a Secret that you create, which holds the ssh signing key under `identity`. */
        sshKey: string;
        /** The committer's name on the signed commit. */
        name: string;
        /** The committer's email. It must belong to the forge account that holds the key. */
        email: string;
      }
    | {
        /** The name of a Secret that you create, which holds the GPG signing key under
         * `private.asc`, with no passphrase. */
        gpgKey: string;
        /** The committer's name on the signed commit. */
        name: string;
        /** The committer's email. It must belong to the forge account that holds the key. */
        email: string;
      };
  // The squashed commit is new, and without `sign` no signer names its committer (ADR-0067).
  /** Who commits an unsigned `push({ squash: true })`: `{ name, email }`. The squashed commit is
   * new, so it needs a committer. Its date comes from the Effector's clock, and its author stays
   * the Agent. A signed push is committed by the signer, so it does not read this field. A squashed
   * push with neither field is refused: `squashed without sign, and git.credentials entry "<match>"
   * holds neither sign nor committer`. */
  committer?: {
    /** The committer's name on the squashed commit. */
    name: string;
    /** The committer's email on the squashed commit. */
    email: string;
  };
};

/** How the cluster authenticates to Repos. */
export type GitConfig = {
  /** The credential entries, matched by prefix on the Repo identity. The longest `match` wins; on a
   * tie, the first entry in the list wins.
   *
   * The list is also a fence. A per-run url, which comes from the run input, must match an entry,
   * or the Sandbox refuses it when it attaches the Repo:
   * `Sandbox "<name>" refuses the per-run repo <url> for slot "<slot>": no git.credentials entry matches "<identity>"`.
   * Thus a run cannot spend this cluster's credentials against any host. A url that a Machine
   * binds needs no entry. When no entry matches it, it clones with no credential.
   *
   * Each entry is checked when the config loads:
   * `<file> at git.credentials[<i>]<path>: <problem>`, followed by the shape of an entry. */
  credentials?: readonly GitCredential[];
};

/** The entry for an identity: `*` matches everything at length 0, else a prefix match; the
 * longest `match` wins, and a tie goes to the first in the list. `undefined` when none matches —
 * which the fence reads as "refuse a per-run url". */
export function matchCredential(identity: string, list: readonly GitCredential[]): GitCredential | undefined {
  let best: { entry: GitCredential; length: number } | undefined;
  for (const entry of list) {
    const length = entry.match === "*" ? 0 : identity.startsWith(entry.match) ? entry.match.length : -1;
    if (length < 0) continue;
    if (best === undefined || length > best.length) best = { entry, length };
  }
  return best?.entry;
}

/** The Secret a Repo CR's `secretRef` names for `url` under `entry`, picked by the url's scheme:
 * https/http spend a token (the clone Secret `jr2 up` writes from the env var), ssh spends the
 * named deploy-key Secret. `undefined` when no entry, no applicable field, or a scheme that carries
 * no credential (`git://`, a local path) — the clone is anonymous. */
export function credentialSecretFor(
  url: string,
  entry: GitCredential | undefined,
): { kind: "token"; env: string; secret: string } | { kind: "ssh"; secret: string } | undefined {
  if (entry === undefined) return undefined;
  const { scheme } = repoIdentity(url);
  if ((scheme === "https" || scheme === "http") && entry.token !== undefined)
    return { kind: "token", env: entry.token, secret: gitTokenSecretName(entry.match) };
  if (scheme === "ssh" && entry.sshKey !== undefined) return { kind: "ssh", secret: entry.sshKey };
  return undefined;
}

/** The token Secret's name for one entry — deterministic in `match`, so a redeploy finds its own
 * Secret and two entries never share one. */
export function gitTokenSecretName(match: string): string {
  return `jr2-git-${createHash("sha256").update(match).digest("hex").slice(0, 8)}`;
}

/** Whether `url` clones over ssh — scp-style `git@host:path`, `ssh://`, or `git+ssh://`. A url
 * that does not parse is not an ssh url. */
export function isSshUrl(url: string): boolean {
  try {
    return repoIdentity(url).scheme === "ssh";
  } catch {
    return false;
  }
}

// An env var on the Harness container, in the CR's (corev1.EnvVar) shape — `value` or a
// `valueFrom` secret/configmap reference, passed through to the operator verbatim.
/** One env var of the Harness container, in the Kubernetes `EnvVar` shape. The Agent can read it,
 * so it must not hold a model key: put a model key in `secrets`. */
export type HarnessEnvVar = {
  /** The env var's name. A known model key name, such as `ANTHROPIC_API_KEY`, is refused:
   * `harness.env[<i>] sets <NAME>, a model key the Agent could read and take out of the pod — hold it instead`. */
  name: string;
  /** The value, usually read from `process.env`. `jr2 up` writes it into a Secret of the Instance.
   * Write `value` or `valueFrom`. */
  value?: string;
  /** Or a Kubernetes `valueFrom` reference, such as `{ secretKeyRef: { name, key } }`, given to the
   * pod as it is. A reference to a Secret of the kit is refused:
   * `harness.env[<i>] (<NAME>) reads Secret "<name>", which is the kit's and never the Harness's`. */
  valueFrom?: Record<string, unknown>;
};

// A whole-Secret/ConfigMap env injection (corev1.EnvFromSource) for the Harness container.
/** A Secret or a ConfigMap whose keys all become env vars of the Harness container, in the
 * Kubernetes `EnvFromSource` shape. Write `secretRef` or `configMapRef`. The Agent can read every
 * key, so `jr2 up` refuses one that holds a known model key:
 * `harness.envFrom[<i>] loads <where>, which carries <KEY> — a model key the Agent could read`. */
export type HarnessEnvFromSource = {
  /** Text put before each key's name, as Kubernetes does. Default: none. */
  prefix?: string;
  /** A Secret that you manage, by name: `{ name }`. `jr2 up` checks that it exists. */
  secretRef?: {
    /** The name of the Secret. */
    name: string;
  };
  /** A ConfigMap that you manage, by name: `{ name }`. */
  configMapRef?: {
    /** The name of the ConfigMap. */
    name: string;
  };
};

/** This kit's version — npm version == published image tag, one release train (ADR-0019). */
export const KIT_VERSION = (
  JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    version: string;
  }
).version;

// Token limits for one model — the Harness's provider-registration options, keyed per model
// because limits are properties of the MODEL, not the endpoint (agents pick models per definition,
// ADR-0018).
/** The token limits of one model of a custom provider. */
export type HarnessProviderModel = {
  /** The model's context window, in tokens (vLLM: `max_model_len`). Default: the provider's
   * `contextWindow`. */
  contextWindow?: number;
  /** The most output tokens in one completion. Default: the provider's `maxTokens`. */
  maxTokens?: number;
};

// A custom model provider (ADR-0018) — what the stock Harness registers with pi's
// `registerProvider(id, { api, baseUrl, … })` (ADR-0027). The vLLM/Ollama path: an
// OpenAI-compatible endpoint under an instance-chosen provider id.
/** A custom model provider: an endpoint that is not in the model catalog, such as vLLM or Ollama,
 * under a provider id that you choose. An Agent names one of its models as `<id>/<model>`. */
export type HarnessProvider = {
  /** The provider id that model names start with: `vllm` in `vllm/Qwen/Qwen3-32B`. It must not
   * also be a key of `harness.catalog`:
   * `harness.catalog.<id>: "<id>" is also harness.provider.id — a custom provider owns its own baseUrl`. */
  id: string;
  /** The wire protocol. The only value is `"openai-completions"`, which most OpenAI-compatible
   * endpoints speak, such as vLLM and Ollama. The Harness refuses any other value when it starts:
   * `provider "<id>" names api "<api>" — this Harness speaks: openai-completions`. */
  api: string;
  // Deployment-varying → resolve from env (`.env`), never hardcode (ADR-0019).
  /** The endpoint's URL. The pods must reach it: `localhost` never works, and a LAN address works
   * on kind. It changes between deployments, so read it from `process.env` (`.env`). `jr2 up`
   * checks from inside the cluster that the endpoint answers. */
  baseUrl: string;
  // A held secret (ADR-0059). Genuinely optional: an unauthenticated endpoint needs none (the
  // Harness sends the wire library's placeholder, which vLLM/Ollama ignore).
  /** The API key, when the endpoint needs one. Read it from `process.env`. It is a Held secret,
   * `JR2_PROVIDER_API_KEY`: `jr2 up` gives the value to the Custodian only, bound to the host of
   * `baseUrl`, and the Harness container holds only its Stand-in. Thus `baseUrl` must be
   * `https://` when you set it:
   * `harness.provider.apiKey is set, and harness.provider.baseUrl is not https://`. Default: none,
   * for an endpoint that needs no key. */
  apiKey?: string;
  // Flue resolves per-model → provider-level → catalog → 0, and a CUSTOM provider id has no catalog
  // entry — unset limits resolve to 0, which leaves auto-compaction no context budget to reason
  // about (the wire request itself is fine: a 0 `maxTokens` is omitted, never sent).
  /** The context window, in tokens, of each model of this provider that `models` does not set.
   * Set it here or in `models`: a limit that nothing sets is 0, and then Compaction has no context
   * budget. */
  contextWindow?: number;
  /** The most output tokens in one completion, for each model of this provider that `models` does
   * not set. Default: no limit is sent. */
  maxTokens?: number;
  // Committable model properties, not deployment-varying: whichever model an Agent definition names
  // resolves its own entry.
  /** Token limits for each model, keyed by the model id after the provider prefix: the key for
   * `vllm/Qwen/Qwen3-32B` is `"Qwen/Qwen3-32B"`. A limit set here wins over the provider's. */
  models?: Record<string, HarnessProviderModel>;
};

// Where one of pi's catalog providers sends its calls (ADR-0059) — reach, not a model choice
// (ADR-0018). The catalog keeps every model fact (limits, cost, thinking levels).
/** Where the calls of one catalog provider go: a gateway that serves that provider's own API, such
 * as LiteLLM. Only the endpoint changes. The catalog keeps every fact about the models. */
export type CatalogReach = {
  // Replaces `model.baseUrl` for every model of this provider.
  /** The whole base URL that the provider's API adds its paths to: `https://litellm.corp.example`
   * for `anthropic`, which adds `/v1/messages`; `https://litellm.corp.example/v1` for `openai`. It
   * must be `https://`: `harness.catalog.<id>.baseUrl must be an https:// URL`. It changes between
   * deployments, so read it from `process.env` (`.env`). */
  baseUrl: string;
};

// One secret of the Instance (ADR-0059's entry shape, ADR-0068's list). Its placement is READ,
// never declared, and naming is placement: a pod gets the secrets something in it names. Both is
// both, and `jr2 up` reports it per pod. `hosts`, `headers` and `paths` are the binding, never the
// placement.
/**
 * One secret of the Instance. You do not say where it goes: it goes where something names it.
 *
 * - It is a Held secret in each Harness pod that names it. A pod names it when its `workspace()`
 *   lists it under `secrets`, or when it is the model key of a provider that an Agent there uses. The Harness
 *   container's env var then holds only its Stand-in, `jr2-held-<name>`, and the pod's Custodian
 *   puts the value into requests toward `hosts` only.
 * - It is an Effect secret where an Effect names it with `secret("name")`: a file in that
 *   Effect's Effector.
 *
 * One secret can be both. Its `hosts`, `headers` and `paths` are its binding, never its placement:
 * they say where the value may go, not which pod gets it. `jr2 up` warns about an entry that nothing names:
 * `secrets[<i>] (<NAME>) is named by nothing; goes nowhere`.
 */
export type SecretEntry = {
  /** As a Held secret, the name of the env var that the Harness container sees, which holds the
   * Stand-in. As an Effect secret, the name that `secret("<name>")` names, and the name of the
   * Effector's file. For a Held secret, it must match `[A-Z_][A-Z0-9_]*`:
   * `secrets[<i>].name "<name>" is not an env var name ([A-Z_][A-Z0-9_]*)`. It must not start with
   * `JR2_` and must not be a proxy or trust variable of the kit:
   * `secrets[<i>].name <NAME> is the kit's — JR2_ names and the proxy and trust variables belong to the mechanism`.
   * One name, one entry: `secrets[<i>].name <NAME> is held twice`. */
  name: string;
  // `jr2 up` writes it into the Secret of each placement that names it —
  // `jr2-held-secrets-<pod>` (that pod's Custodian's), `jr2-instance-effector` — and nowhere else.
  /** The value, usually read from `process.env` (`.env`). `jr2 up` writes it only into the Secrets
   * of the containers that hold it. Write exactly one of `value` and `valueFrom`:
   * `secrets[<i>] needs exactly one of value or valueFrom`. A `.env` variable that is not set reads
   * as no value, and an empty one is refused: `secrets[<i>].value is empty — set <NAME> in .env`. */
  value?: string;
  /** Or a key of a Secret that you manage (Sealed Secrets, External Secrets):
   * `{ secretKeyRef: { name, key } }`. `jr2 up` checks that the Secret and the key exist. Each
   * container that holds the secret mounts that one key as a file, and no other container does. */
  valueFrom?: {
    /** The Secret and the key in it that hold the value. */
    secretKeyRef: {
      /** The name of the Secret. */
      name: string;
      /** The key in the Secret that holds the value. */
      key: string;
    };
  };
  // A known model-key name is a key of `MODEL_KEYS` (model-keys.ts), which holds its default host.
  /** Where the value may go as a Held secret. Each entry is `host`, `host:port`, or an `https://`
   * URL, of which only the host and port count. Write exact DNS names or IP addresses, with no
   * wildcards. The port default is 443. A known model key, such as `ANTHROPIC_API_KEY`, may leave
   * it out: it then goes to the one host that its provider calls. Any other Held secret must name
   * its hosts: `secrets[<i>].hosts is absent, and <NAME> has no single default host`. */
  hosts?: readonly string[];
  /** The request headers in which the Custodian puts the value in place of the Stand-in,
   * lowercase. Default: `["authorization", "x-api-key", "x-goog-api-key", "api-key"]`. A header
   * that frames or routes the request is refused:
   * `secrets[<i>].headers[<j>] "<header>" cannot carry a held secret`. */
  headers?: readonly string[];
  // A key minted through the Custodian is a key the Agent can take away.
  /** The path prefixes to which the value may be sent, such as `/v1/messages`. Each starts with
   * `/`. Default: every path. Narrow it for a gateway key that can reach admin routes, such as a
   * LiteLLM key that can make new keys. The Agent could take away a key made that way. */
  paths?: readonly string[];
};

// The agent-runtime section (ADR-0018): what the stock Harness image consumes alongside the Agent
// definition each Turn hands it (ADR-0049). Moved out of `sandbox` deliberately — `sandbox` is pod
// transport (it still CARRIES this env to the Harness container), but model concerns are Harness
// semantics.
//
// It declares what this instance can REACH — endpoints, credentials, trust — and never WHICH
// model to use (ADR-0018). This config holds no instance-wide `model` default and no Agent
// roster: an Agent is an actor slot on ONE Machine, whose definition rides the Turn (ADR-0049).
// One definition value may still be carried by several Machines, so the variation that matters is
// per-definition and per-invocation, which one global default serves not at all.
/** What the Harness can reach: the model endpoints, their credentials, and the CAs it trusts. It
 * never says which model an Agent uses: each Agent's definition names its model. */
export type HarnessConfig = {
  // Preflighted from inside the cluster by `jr2 up` (ADR-0019); its `apiKey` is held (ADR-0059).
  /** A custom model provider, such as a vLLM or Ollama endpoint. See {@link HarnessProvider}.
   * Default: none; the Agents use catalog providers only. */
  provider?: HarnessProvider;
  // A gateway that serves the provider's own API (ADR-0059).
  /** Catalog providers whose calls go to another endpoint, such as a gateway, keyed by the catalog
   * provider id: `anthropic`, `openai`, and so on. See {@link CatalogReach}. A key that is not a
   * catalog provider with a known model key is refused:
   * `harness.catalog.<id>: "<id>" is not a pi catalog provider jr2 knows a key for`. Default:
   * each provider's own endpoint. */
  catalog?: Readonly<Record<string, CatalogReach>>;
  // Values read from `process.env`/`.env` are materialized into the instance-owned Secret by
  // `jr2 up`. A known model key here is refused (ADR-0059).
  /** Env vars for the Harness container. The Agent can read every one of them, so do not put a
   * credential here. A known model key is refused here. Put it in the top-level `secrets` list.
   * See {@link HarnessEnvVar}. */
  env?: readonly HarnessEnvVar[];
  // `jr2 up` preflights that each referenced Secret exists (ADR-0019), and refuses one that
  // carries a known model key (ADR-0059).
  /** Secrets and ConfigMaps that you manage, whose keys all become env vars of the Harness
   * container. See {@link HarnessEnvFromSource}. */
  envFrom?: readonly HarnessEnvFromSource[];
  // Only `jr2 up` reads it (host-side): it materializes the `jr2-ca` ConfigMap and runs the
  // provider preflight with the same trust (ADR-0020, ADR-0059).
  /** A path to a PEM CA bundle, relative to the Instance folder. An example is the CA of an
   * internal endpoint in front of a LAN vLLM. Commit the file: CA certificates are public. `jr2 up`
   * puts it in the `jr2-ca` ConfigMap and uses it when it checks the provider. The Harness
   * container trusts it, and so does the Custodian when it verifies a host that a Held secret is
   * bound to. */
  caBundle?: string;
};

// One pod-spec toleration, verbatim (ADR-0052): `nodeSelector` and `tolerations` are the raw
// Kubernetes shapes, the stance `HarnessEnvVar` takes for `EnvVar`.
/** One toleration of a Sandbox pod, in the Kubernetes `Toleration` shape: a node taint that the
 * pod tolerates. */
export type Toleration = {
  /** The taint key. Leave it out, with `operator: "Exists"`, to tolerate every taint. */
  key?: string;
  /** `"Equal"` matches a taint whose value is `value`; `"Exists"` matches any value. Default:
   * `"Equal"`. */
  operator?: "Exists" | "Equal";
  /** The taint value, for `operator: "Equal"`. */
  value?: string;
  /** The taint effect to tolerate: `"NoSchedule"`, `"PreferNoSchedule"` or `"NoExecute"`. Default:
   * every effect. */
  effect?: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
  /** For `"NoExecute"`: how many seconds the pod stays on the node after the taint is added.
   * Default: the pod stays. */
  tolerationSeconds?: number;
};

// Where an Instance's Sandboxes may land (ADR-0052). Both keys ride the Sandbox pod verbatim, the
// Repo cache agent's DaemonSet takes the same two so a cache is only ever where a Sandbox can reach
// it, and `jr2 up` reads the same predicate off the nodes to report the set. A Machine says nothing
// about placement: a node label is a deployment fact (ADR-0050). These two are the default class;
// a per-Machine `classes` map is the deferred extension.
/** Which nodes are Sandbox nodes: the nodes on which this Instance's Sandboxes may run. Absent, a
 * Sandbox runs wherever an ordinary pod runs: on a node that is not cordoned and has no taint. No
 * jr2 label is ever needed. The Repo cache agent runs on the same nodes, and `jr2 up` reports the
 * set and warns when it is empty. */
export type SandboxPlacement = {
  /** The pod's `nodeSelector`: a Sandbox node must have every one of these labels. Default: none. */
  nodeSelector?: Readonly<Record<string, string>>;
  // No `tolerationSeconds` is added.
  /** The pod's `tolerations`, as you write them. Default: none. jr2 adds no `tolerationSeconds`.
   * Thus a tolerated `NoExecute` taint keeps a Sandbox on its node while its Lease is renewed. */
  tolerations?: readonly Toleration[];
};

// The Instance's Sandbox defaults (ADR-0052, ADR-0060).
/** The Instance's Sandbox defaults: the Sandbox nodes (see {@link SandboxPlacement}), and the Size
 * of a Workspace that states none. The config load refuses a `sandbox` that is not an object:
 * `<file> at sandbox: expected an object — { nodeSelector?, tolerations?, resources? }`. A key that
 * this type does not have fails the typecheck that `jr2 up` runs. */
export type SandboxConfig = SandboxPlacement & {
  // NEVER an override of a Size a Machine states: a Size is a fact of the Machine, and its one
  // override path is `customize(machine, { resources })` (ADR-0060).
  /**
   * The Size of a Workspace that states no Size at all: `{ limits: { memory, cpu } }` and nothing
   * else. The kit default fills a field that it leaves out. It never changes a Size that a Machine
   * states: to change that, use `customize(machine, { resources })`. Default: the kit default,
   * memory `2Gi` and cpu `1`. jr2 reserves the whole Size and enforces the cpu limit. See
   * {@link Size} for the refusals, such as
   * `<file> at sandbox.resources.requests is not accepted`.
   */
  resources?: Size;
};

// The PriorityClasses jr2's pods run under (ADR-0060). Absent, `jr2 up` creates two,
// cluster-scoped, beside the CRDs.
/**
 * The PriorityClasses that jr2's pods run under. Absent, `jr2 up` creates two: `jr2-control`
 * (value 100000, `PreemptLowerPriority`) and `jr2-sandbox` (value 1000, `preemptionPolicy: Never`).
 * Thus an ordinary pod cannot preempt a live Workspace, and a Sandbox that waits for a node evicts
 * no pod. A cluster with its own scheme names its existing classes here, and `jr2 up` then creates
 * none for that key. The config load refuses any other key:
 * `<file> at priorityClasses<path>: <problem> — { control?, sandbox? }, each the name of an existing PriorityClass`.
 */
export type PriorityClasses = {
  /** An existing PriorityClass for the Orchestrator, the operator and the Repo cache agent.
   * Default: `jr2-control`, which `jr2 up` creates. */
  control?: string;
  /** An existing PriorityClass for the Sandboxes and the Instance Harness. Default: `jr2-sandbox`,
   * which `jr2 up` creates. */
  sandbox?: string;
};

/**
 * The shape of `jr2.config.ts`: the deployment facts of an Instance, which a Machine cannot carry.
 * It holds the Instance's name, its secrets, how the cluster authenticates to Repos, what the
 * Harness can reach, where Sandboxes run, and where images go. It names no Repo, no model and no
 * Sandbox Image: a Machine names those itself.
 *
 * Every field is optional, and an Instance can run with no `jr2.config.ts`. Write the file as
 * `export default defineConfig({ … })`. When the config loads, a file with no default export is
 * refused: `` <file> has no default export (use `export default defineConfig({…})`) ``. The load also
 * checks the shape of `git.credentials`, `secrets`, `harness.catalog` and `priorityClasses`. It
 * checks that `sandbox` is an object, and checks its `resources`. Each refusal names the field.
 * `jr2 up` checks the rest.
 *
 * @example
 * ```ts
 * import { defineConfig, type JR2Config } from "@jr2/orchestrator";
 *
 * const harness: JR2Config["harness"] = {
 *   provider: {
 *     id: "vllm",
 *     api: "openai-completions",
 *     baseUrl: process.env.VLLM_URL ?? "",
 *     models: { "Qwen/Qwen3.6-35B-A3B": { contextWindow: 131072, maxTokens: 16384 } },
 *   },
 * };
 *
 * export default defineConfig({ name: "my-instance", harness });
 * ```
 *
 * @see docs/reference/config.md
 * @see docs/get-started/connect-a-model.md
 * @see docs/concepts/secrets-and-trust.md
 * @see docs/reference/decisions/0050-what-code-names-config-declares-what-the-cli-names-discovery-finds.md
 */
export type JR2Config = {
  // The instance's identity (ADR-0019).
  /** The Instance's name. Its Kubernetes namespace is this name (`-n` overrides it), and
   * `jr2 up` labels every object that it owns with it. Default: the name of the Instance folder. */
  name?: string;
  // One list for both sides (ADR-0068). Naming is the placement; `hosts` is a Held secret's
  // binding, never its placement: an entry nothing names goes nowhere.
  /** Every secret of the Instance, in one list. A secret goes where something names it. A Held
   * secret goes where a `workspace()` lists it under `secrets` or an Agent's provider reads it. An
   * Effect secret goes where an Effect names it with `secret("name")`. Its `hosts` is a Held
   * secret's binding, never its placement: an entry that nothing names goes nowhere. A model API
   * key goes here, never in `harness.env`. See {@link SecretEntry}. Each entry is checked when the
   * config loads: `<file> at secrets[<i>]<path>: <problem>`, followed by the shape of an entry. */
  secrets?: readonly SecretEntry[];
  // NOT a list of Repos (ADR-0051): a Machine names those itself, through its `workspace()`'s Repo
  // Slots, and whether the instance has a data plane at all is read off the registered Machines.
  /** How the cluster authenticates to Repos, and the fence that a per-run url must pass. It is not
   * a list of Repos: a Machine names its Repos in the Repo Slots of its `workspace()`. See
   * {@link GitConfig}. */
  git?: GitConfig;
  /** What the Harness can reach: a custom model provider, gateways for catalog providers, env
   * vars, and CAs. See {@link HarnessConfig}. */
  harness?: HarnessConfig;
  // See `SandboxPlacement` (ADR-0052) and `SandboxConfig` (ADR-0060).
  /** Which nodes are Sandbox nodes, and the Size of a Workspace that states none. Default: a
   * Sandbox runs wherever an ordinary pod runs, at the kit's Size. See {@link SandboxConfig}. */
  sandbox?: SandboxConfig;
  // See `PriorityClasses` (ADR-0060).
  /** Existing PriorityClasses to use in place of the two that `jr2 up` creates. See
   * {@link PriorityClasses}. */
  priorityClasses?: PriorityClasses;
  // Deployment-varying — resolve from env (ADR-0019).
  /** The image registry prefix to which `jr2 up` pushes the images that it builds, such as
   * `registry.example.com/team`. It changes between deployments, so read it from `process.env`
   * (`.env`). Default: none; `jr2 up` loads the images into the kind cluster. On a cluster that is
   * not kind, `jr2 up` then refuses:
   * `` context <context> is not a kind cluster and no `registry` is configured ``. */
  registry?: string;
  // Deployment-varying — resolve from env. Seeding that mirror is a deliberate, instance-less act
  // (`jr2 kit push`), never a side effect of `jr2 up` (ADR-0044).
  //
  // Separate from `registry` on purpose: `registry` addresses images THIS converge builds,
  // `kitRegistry` addresses artifacts the kit already published. One key for both would make every
  // private-registry user mirror the Kit images they could have pulled from the home.
  /** The registry from which this cluster pulls the published Kit images: a mirror for a cluster
   * that is self-hosted, air-gapped, or mirror-only. Default: none; the cluster pulls from the
   * canonical home, `ghcr.io/snapwich/jr2-harness:<version>` and the others. Set, the cluster pulls
   * the same tags from `<kitRegistry>/jr2-harness:<version>`. Fill the mirror with
   * `jr2 kit push <registry>`; `jr2 up` never pushes to it. Read it from `process.env` (`.env`). */
  kitRegistry?: string;
  // Deployment-varying — resolve from env (ADR-0045). Present → ABSOLUTE: derivation is skipped
  // (still intersected, so an unpublished platform is a named error, never a silent build).
  //
  // The escape hatch for the two cases derivation cannot see: a pool that autoscales from zero (no
  // nodes to read yet), and a polluted set (an amd64 GPU pool beside arm64 workers, where the
  // derived pair would cost a needless qemu cross-build). Not additive or subtractive.
  /** The platforms for which `jr2 up` builds its images, as docker platform strings, such as
   * `["linux/arm64"]`. Default: the platforms of the cluster's schedulable nodes that the kit
   * releases images for. `jr2 up` reports a node platform that it skips.
   *
   * Set it when the nodes cannot tell. One case is a node group that scales up from zero. Another
   * is a set of nodes that need no image, such as an amd64 GPU group beside arm64 nodes. When you
   * set it, it replaces the default. It adds to nothing and removes from nothing. The kit releases
   * images for `linux/amd64` and `linux/arm64` only, so `jr2 up` refuses any other:
   * `` `platforms` names <platforms> — the kit releases images for linux/amd64, linux/arm64 and nothing else ``. */
  platforms?: readonly string[];
  // Kit development territory (ADR-0019).
  /** Settings of the operator layer, for kit development. */
  operator?: {
    /** `false`: `jr2 up` does not converge the operator, and you run its controller yourself.
     * Default: `true`. */
    manage?: boolean;
  };
};

// Identity passthrough that checks a config object against `JR2Config` where it is written —
// excess keys included, at every depth, which is why the parameter is the type and not a generic
// bound by it.
/**
 * Declare the config of an Instance: the default export of `jr2.config.ts`. It gives back the
 * object that you pass. Its only work is to check that object against {@link JR2Config} where you
 * write it, at every depth, a misspelled key included. `jr2 up` typechecks the file before it
 * converges.
 *
 * @param c - The Instance's config. See {@link JR2Config} for every field.
 * @returns The same object.
 *
 * @example
 * ```ts
 * import { defineConfig } from "@jr2/orchestrator";
 *
 * export default defineConfig({
 *   name: "my-instance",
 *   secrets: [{ name: "ANTHROPIC_API_KEY", value: process.env.ANTHROPIC_API_KEY }],
 *   git: { credentials: [{ match: "github.com/you/", token: "GITHUB_TOKEN" }] },
 * });
 * ```
 *
 * @see docs/reference/config.md
 * @see docs/get-started/create-an-instance.md
 * @see docs/reference/decisions/0050-what-code-names-config-declares-what-the-cli-names-discovery-finds.md
 */
export function defineConfig(c: JR2Config): JR2Config {
  return c;
}

/**
 * Load an instance's `jr2.config.ts` (default export). Absent file → undefined (an instance
 * can boot configless); a file that fails to IMPORT throws — a broken config must be loud,
 * never silently treated as "no config". The shape checks live here, on the path the host CLI
 * and the in-cluster Orchestrator share: `git.credentials`, `secrets` and `harness.catalog` are
 * checked at runtime, because an instance is zero-build and nothing typechecks this file before
 * Node strips its types and imports it. SHAPE only: a secret's
 * `value` reads `.env`, which the in-cluster evaluation does not have, so an absent value is not
 * this function's to refuse — `jr2 up` checks presence and every held-secret rule host-side
 * (`heldSecretsOf`, ADR-0059).
 */
export async function loadConfig(dir: string): Promise<JR2Config | undefined> {
  const file = join(dir, "jr2.config.ts");
  if (!existsSync(file)) return undefined;
  const mod = (await import(pathToFileURL(file).href)) as { default?: JR2Config };
  if (!mod.default) throw new Error(`${file} has no default export (use \`export default defineConfig({…})\`)`);
  if (mod.default.git !== undefined) checkGit(mod.default.git, file);
  if (mod.default.secrets !== undefined) checkSecrets(mod.default.secrets, file);
  if (mod.default.harness !== undefined) checkHarness(mod.default.harness, file);
  if (mod.default.sandbox !== undefined) checkSandbox(mod.default.sandbox, file);
  if (mod.default.priorityClasses !== undefined) checkPriorityClasses(mod.default.priorityClasses, file);
  return mod.default;
}

const NonEmpty = z.string().min(1);
const Credential = z
  .object({
    match: NonEmpty,
    token: NonEmpty.optional(),
    sshKey: NonEmpty.optional(),
    push: z.union([z.object({ sshKey: NonEmpty }).strict(), z.object({ token: NonEmpty }).strict()]).optional(),
    sign: z
      .union([
        z.object({ sshKey: NonEmpty, name: NonEmpty, email: NonEmpty }).strict(),
        z.object({ gpgKey: NonEmpty, name: NonEmpty, email: NonEmpty }).strict(),
      ])
      .optional(),
    committer: z.object({ name: NonEmpty, email: NonEmpty }).strict().optional(),
  })
  .strict();

/** `git.credentials`' SHAPE, checked at load — by index and field, so a bad entry names itself
 * (`git.credentials[1].token`) rather than surfacing as a Secret that never matches. */
function checkGit(git: unknown, where: string): void {
  if (typeof git !== "object" || git === null || Array.isArray(git))
    throw new Error(`${where} at git: expected an object — ${GIT_HINT}`);
  const { credentials } = git as { credentials?: unknown };
  if (credentials === undefined) return;
  if (!Array.isArray(credentials)) throw new Error(`${where} at git.credentials: expected an array — ${GIT_HINT}`);
  for (const [i, entry] of credentials.entries()) {
    const parsed = Credential.safeParse(entry);
    if (parsed.success) continue;
    const issue = parsed.error.issues[0];
    const at = ["", ...(issue?.path ?? [])].map(String).join(".");
    throw new Error(`${where} at git.credentials[${i}]${at}: ${issue?.message ?? "invalid"} — ${GIT_HINT}`);
  }
}

const GIT_HINT =
  "an entry is { match, token?, sshKey?, push?: { sshKey } | { token }, sign?: { sshKey | gpgKey, name, email }, " +
  "committer?: { name, email } } (ADR-0051)";

const OptionalText = z.string().optional();
const SecretShape = z
  .object({
    name: NonEmpty,
    // `.env` values are absent in-cluster, so `undefined` must pass here — presence is `jr2 up`'s.
    value: OptionalText,
    valueFrom: z
      .object({ secretKeyRef: z.object({ name: NonEmpty, key: NonEmpty }).strict() })
      .strict()
      .optional(),
    hosts: z.array(z.string()).optional(),
    headers: z.array(z.string()).optional(),
    paths: z.array(z.string()).optional(),
  })
  .strict();
const CatalogReachShape = z.object({ baseUrl: z.string() }).strict();

/** `secrets`' SHAPE (ADR-0059's entry, ADR-0068's list) — by index and field, the `checkGit` style,
 * so a bad entry names itself (`secrets[1].hosts`). */
function checkSecrets(secrets: unknown, where: string): void {
  if (!Array.isArray(secrets)) throw new Error(`${where} at secrets: expected an array — ${SECRET_HINT}`);
  for (const [i, entry] of secrets.entries()) {
    const parsed = SecretShape.safeParse(entry);
    if (parsed.success) continue;
    const issue = parsed.error.issues[0];
    const at = ["", ...(issue?.path ?? [])].map(String).join(".");
    throw new Error(`${where} at secrets[${i}]${at}: ${issue?.message ?? "invalid"} — ${SECRET_HINT}`);
  }
}

/** `harness.catalog`'s SHAPE (ADR-0059) — by provider id and field, the `checkGit` style. */
function checkHarness(harness: unknown, where: string): void {
  if (typeof harness !== "object" || harness === null || Array.isArray(harness)) {
    throw new Error(`${where} at harness: expected an object`);
  }
  const { catalog } = harness as { catalog?: unknown };
  if (catalog !== undefined) {
    if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) {
      throw new Error(`${where} at harness.catalog: expected an object keyed by catalog provider id — ${CATALOG_HINT}`);
    }
    for (const [id, reach] of Object.entries(catalog)) {
      const parsed = CatalogReachShape.safeParse(reach);
      if (parsed.success) continue;
      const issue = parsed.error.issues[0];
      const at = ["", ...(issue?.path ?? [])].map(String).join(".");
      throw new Error(`${where} at harness.catalog.${id}${at}: ${issue?.message ?? "invalid"} — ${CATALOG_HINT}`);
    }
  }
}

const SECRET_HINT =
  "an entry is { name, value? | valueFrom?: { secretKeyRef: { name, key } }, hosts?, headers?, paths? } (ADR-0059, ADR-0068)";
const CATALOG_HINT = "an entry is <provider id>: { baseUrl } (ADR-0059)";

/** `sandbox.resources`' SHAPE (ADR-0060), checked at load by field — `requests`, or any key beside
 * the two limits, is refused naming itself (`sandbox.resources.requests`). */
function checkSandbox(sandbox: unknown, where: string): void {
  if (typeof sandbox !== "object" || sandbox === null || Array.isArray(sandbox)) {
    throw new Error(`${where} at sandbox: expected an object — { nodeSelector?, tolerations?, resources? }`);
  }
  const { resources } = sandbox as { resources?: unknown };
  if (resources !== undefined) assertSize(`${where} at sandbox.resources`, resources);
}

const PriorityClassesShape = z.object({ control: NonEmpty.optional(), sandbox: NonEmpty.optional() }).strict();

/** `priorityClasses`' SHAPE (ADR-0060): two optional class names, nothing else. */
function checkPriorityClasses(classes: unknown, where: string): void {
  const parsed = PriorityClassesShape.safeParse(classes);
  if (parsed.success) return;
  const issue = parsed.error.issues[0];
  const at = ["", ...(issue?.path ?? [])].map(String).join(".");
  throw new Error(
    `${where} at priorityClasses${at}: ${issue?.message ?? "invalid"} — { control?, sandbox? }, each the name of ` +
      "an existing PriorityClass (ADR-0060)",
  );
}
