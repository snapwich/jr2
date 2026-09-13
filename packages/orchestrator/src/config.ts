// Instance configuration (ADR-0050): the deployment facts a Machine cannot carry — the instance's
// identity and reach, what its Harness may reach, and how the cluster authenticates to Repos. What
// a Sandbox is MADE of and which Repos it attaches are not here — they are `workspace()` options
// (ADR-0037/0049/0051), and every image ref is resolved by `j2 up` (ADR-0038). There is no `images`
// block and no Repo catalog, deliberately: neither typed anything a Machine could not carry itself,
// and an override seat for the Harness ref is the eject hatch ADR-0027 refuses.
//
// `defineConfig` is an identity passthrough — it exists solely so a `j2.config.ts` gets full
// type inference and checking against `J2Config` at authoring time, exactly like the config
// helpers in vite/tsup/etc. No runtime behavior beyond returning its argument.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { repoIdentity } from "./repo-identity.ts";

// ------------------------------------------------------------------------------------------------
// `git.credentials` (ADR-0051): how the cluster authenticates to a Repo, and the fence.
//
// A Repo is identified by its url and nothing in this file names one (CONTEXT.md "Repo"). What
// the config declares is CREDENTIALS, matched by prefix on the identity — the Argo and Flux shape.
// The Orchestrator resolves the entry when it creates a Repo CR and writes a `secretRef`; the
// cache agent reads only that. The list is also the fence: a per-run url (run input, a ticket
// field) that matches no entry is refused at attach, so nothing can spend this cluster's
// credential against an arbitrary host. A bound url is code the Instance typechecked and deployed
// — admitted without a match, cloned anonymously.

/** One credentials entry. An entry may carry neither `token` nor `sshKey`: it then admits its
 * prefix through the fence and the clone is anonymous. */
export type GitCredential = {
  /** A prefix on the identity (`github.com/ourorg/`), or `*` for everything. */
  match: string;
  /** Env var name holding an HTTPS token; `j2 up` materializes its value into the Instance Secret. */
  token?: string;
  /** A Secret (Flux key names: `identity`, `identity.pub`, `known_hosts`) holding a deploy key. */
  sshKey?: string;
};

export type GitConfig = {
  /** Matched by prefix on the Repo identity; the longest `match` wins, ties → first in the list. */
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
 * https/http spend a token (a Secret the Orchestrator derives from the env var), ssh spends the
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
  return `j2-git-${createHash("sha256").update(match).digest("hex").slice(0, 8)}`;
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

/** An env var on the Harness container, in the CR's (corev1.EnvVar) shape — `value` or a
 * `valueFrom` secret/configmap reference, passed through to the operator verbatim. */
export type HarnessEnvVar = {
  name: string;
  value?: string;
  valueFrom?: Record<string, unknown>;
};

/** A whole-Secret/ConfigMap env injection (corev1.EnvFromSource) for the Harness container —
 * e.g. `{ secretRef: { name: "anthropic" } }` to hand a real Harness its model API key. */
export type HarnessEnvFromSource = {
  secretRef?: { name: string };
  configMapRef?: { name: string };
};

/** This kit's version — npm version == published image tag, one release train (ADR-0019). */
export const KIT_VERSION = (
  JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    version: string;
  }
).version;

/** Token limits for one model — the Harness's provider-registration options, keyed per model because limits are
 * properties of the MODEL, not the endpoint (agents pick models per definition, ADR-0018). */
export type HarnessProviderModel = {
  /** The model's context window, in tokens (vLLM: `max_model_len`). */
  contextWindow?: number;
  /** The model's max output tokens per completion. */
  maxTokens?: number;
};

/** A custom model provider (ADR-0018) — what the stock Harness registers with pi's
 * `registerProvider(id, { api, baseUrl, … })` (ADR-0027). The vLLM/Ollama path: an OpenAI-compatible
 * endpoint under an instance-chosen provider id. */
export type HarnessProvider = {
  /** The provider id model specifiers use (`<id>/<model>`), e.g. `vllm`. */
  id: string;
  /** The wire protocol, e.g. `openai-completions` (most OpenAI-compatible endpoints). */
  api: string;
  /** The endpoint — reachable FROM PODS (`localhost` never is; a LAN address works on kind).
   * Deployment-varying → resolve from env (`.env`), never hardcode (ADR-0019). */
  baseUrl: string;
  /** API key, when the endpoint wants one. May read `process.env` — `j2 up` materializes config
   * env values into the instance's Secret; the literal never lands in a manifest (ADR-0019).
   * Genuinely optional: an unauthenticated endpoint needs none (the Harness sends the wire
   * library's placeholder, which vLLM/Ollama ignore). */
  apiKey?: string;
  /** Endpoint-wide default token limits, for any model this provider serves. Flue resolves
   * per-model → provider-level → catalog → 0, and a CUSTOM provider id has no catalog entry —
   * unset limits resolve to 0, which leaves auto-compaction no context budget to reason about
   * (the wire request itself is fine: a 0 `maxTokens` is omitted, never sent). */
  contextWindow?: number;
  maxTokens?: number;
  /** Per-model limits, keyed by the model id AFTER the provider prefix — the map entry for
   * `vllm/Qwen/Qwen3-32B` is `"Qwen/Qwen3-32B"`. Committable model properties, not
   * deployment-varying: whichever model an Agent definition names resolves its own entry. */
  models?: Record<string, HarnessProviderModel>;
};

/** The agent-runtime section (ADR-0018): what the stock Harness image consumes alongside the
 * Agent definition each Turn hands it (ADR-0049). Moved out of `sandbox` deliberately — `sandbox`
 * is pod transport (it still CARRIES this env to the Harness container), but model concerns are
 * Harness semantics.
 *
 * It declares what this instance can REACH — endpoints, credentials, trust — and never WHICH
 * model to use (ADR-0018). This config holds no instance-wide `model` default and no Agent
 * roster: an Agent is an actor slot on ONE Machine, whose definition rides the Turn (ADR-0049).
 * One definition value may still be carried by several Machines, so the variation that matters is
 * per-definition and per-invocation, which one global default serves not at all. */
export type HarnessConfig = {
  /** Custom model provider, preflighted from inside the cluster by `j2 up` (ADR-0019). */
  provider?: HarnessProvider;
  /** Env vars for the Harness container (Agent creds, e.g. ANTHROPIC_API_KEY). Values read from
   * `process.env`/`.env` are materialized into the instance-owned Secret by `j2 up`. */
  env?: readonly HarnessEnvVar[];
  /** Whole-Secret/ConfigMap env for the Harness container — `envFrom` refs to Secrets YOU manage
   * (Sealed Secrets etc.); `j2 up` preflights that each referenced Secret exists (ADR-0019). */
  envFrom?: readonly HarnessEnvFromSource[];
  /** Path to a PEM CA bundle, RELATIVE to the instance folder — commit the file (CA certs are
   * public; e.g. an internal CA in front of a LAN vLLM). Only `j2 up` reads it (host-side): it
   * materializes the `j2-ca` ConfigMap and runs the provider preflight with the same trust. The
   * bundle lands on the Harness container and NOWHERE else — never the Adapter, whose Orchestrator
   * credential has no business behind the same trust store (the `harness.env` asymmetry,
   * ADR-0013/0020). */
  caBundle?: string;
};

export type J2Config = {
  /** The instance's identity (ADR-0019): its kube namespace defaults to this (`-n` overrides),
   * and `j2 up` labels every object it owns with it. Default: the instance folder's name. */
  name?: string;
  /** How the cluster authenticates to Repos, and the fence a per-run url must pass (ADR-0051).
   * NOT a list of Repos: a Machine names those itself, through its `workspace()`'s Repo Slots, and
   * whether the instance has a data plane at all is read off the registered Machines. */
  git?: GitConfig;
  /** Agent-runtime config for the stock Harness (see `HarnessConfig`). */
  harness?: HarnessConfig;
  /** Image registry prefix (deployment-varying — resolve from env). Absent → images are
   * `kind load`-ed; present → pushed. A non-kind cluster without one fails loudly (ADR-0019). */
  registry?: string;
  /** Where this cluster pulls the PUBLISHED Kit images from (deployment-varying — resolve from
   * env). Absent → the canonical home, `ghcr.io/snapwich/j2-harness:<kitversion>` and friends;
   * present → the same tags re-homed to a self-hosted mirror, `<kitRegistry>/j2-harness:<ver>`,
   * for a self-hosted, air-gapped, or mirror-only cluster (ADR-0044). Seeding that mirror is a
   * deliberate, instance-less act (`j2 kit push`), never a side effect of `j2 up`.
   *
   * Separate from `registry` on purpose: `registry` addresses images THIS converge builds,
   * `kitRegistry` addresses artifacts the kit already published. One key for both would make every
   * private-registry user mirror three images they could have pulled from the home. */
  kitRegistry?: string;
  /** What `j2 up` builds its images FOR — docker platform strings, e.g. `["linux/arm64"]`
   * (deployment-varying — resolve from env). Absent → derived from the cluster's schedulable nodes
   * and intersected with the platforms the kit releases for, which is the answer for every ordinary
   * cluster (ADR-0045). Present → ABSOLUTE: derivation is skipped and this is the build set (still
   * intersected, so an unpublished platform is a named error, never a silent build).
   *
   * The escape hatch for the two cases derivation cannot see: a pool that autoscales from zero (no
   * nodes to read yet), and a polluted set (an amd64 GPU pool beside arm64 workers, where the
   * derived pair would cost a needless qemu cross-build). Not additive or subtractive. */
  platforms?: readonly string[];
  /** Operator-layer overrides — kit development territory (ADR-0019). */
  operator?: {
    /** `false` = `j2 up` skips the operator layer (run the controller loop yourself). */
    manage?: boolean;
  };
};

/** Identity passthrough that pins a config object's type to `J2Config` for inference. */
export function defineConfig<T extends J2Config>(c: T): T {
  return c;
}

/**
 * Load an instance's `j2.config.ts` (default export). Absent file → undefined (an instance
 * can boot configless); a file that fails to IMPORT throws — a broken config must be loud,
 * never silently treated as "no config". The one shape check lives here, on the path the host
 * CLI and the in-cluster Orchestrator share: `git.credentials` is checked at runtime, because an
 * instance is zero-build and nothing typechecks this file before Node strips its types and
 * imports it.
 */
export async function loadConfig(dir: string): Promise<J2Config | undefined> {
  const file = join(dir, "j2.config.ts");
  if (!existsSync(file)) return undefined;
  const mod = (await import(pathToFileURL(file).href)) as { default?: J2Config };
  if (!mod.default) throw new Error(`${file} has no default export (use \`export default defineConfig({…})\`)`);
  if (mod.default.git !== undefined) checkGit(mod.default.git, file);
  return mod.default;
}

const NonEmpty = z.string().min(1);
const Credential = z.object({ match: NonEmpty, token: NonEmpty.optional(), sshKey: NonEmpty.optional() }).strict();

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

const GIT_HINT = "an entry is { match, token?, sshKey? } (ADR-0051)";
