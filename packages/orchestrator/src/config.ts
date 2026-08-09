// Workflow author configuration: the repos a j2 deployment orchestrates, and what the instance's
// Harness may reach. What a Sandbox is MADE of is not here — it is `images/<name>/Dockerfile`
// (ADR-0037), and every image ref is resolved by `j2 up` (ADR-0038). The `images` block is gone
// with no replacement key and no env hatch, deliberately: an override seat for the Harness ref is
// the eject hatch ADR-0027 refuses.
//
// `defineConfig` is an identity passthrough — it exists solely so a `j2.config.ts` gets full
// type inference and checking against `J2Config` at authoring time, exactly like the config
// helpers in vite/tsup/etc. No runtime behavior beyond returning its argument.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type RepoConfig = {
  name: string;
  url: string;
  ref?: string;
};

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

/** Token limits for one model — flue registration options, keyed per model because limits are
 * properties of the MODEL, not the endpoint (agents pick models per definition, ADR-0018). */
export type HarnessProviderModel = {
  /** The model's context window, in tokens (vLLM: `max_model_len`). */
  contextWindow?: number;
  /** The model's max output tokens per completion. */
  maxTokens?: number;
};

/** A custom model provider (ADR-0018) — what the stock Harness registers via flue's
 * `registerProvider(id, { api, baseUrl, … })`. The vLLM/Ollama path: an OpenAI-compatible
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
 * `agents/` definitions. Moved out of `sandbox` deliberately — `sandbox` is pod transport (it
 * still CARRIES this env to the Harness container), but model concerns are Harness semantics.
 *
 * It declares what this instance can REACH — endpoints, credentials, trust — and never WHICH
 * model to use (ADR-0018). The instance-wide `model` default was removed: Agents are
 * instance-scoped and every workflow may name any of them, so the variation that matters is
 * per-definition and per-invocation, which one global default serves not at all. */
export type HarnessConfig = {
  /** Custom model provider, preflighted from inside the cluster by `j2 up` (ADR-0019). */
  provider?: HarnessProvider;
  /** Env vars for the Harness container (Agent creds, e.g. ANTHROPIC_API_KEY). Values read from
   * `process.env`/`.env` are materialized into the instance-owned Secret by `j2 up`. */
  env?: HarnessEnvVar[];
  /** Whole-Secret/ConfigMap env for the Harness container — `envFrom` refs to Secrets YOU manage
   * (Sealed Secrets etc.); `j2 up` preflights that each referenced Secret exists (ADR-0019). */
  envFrom?: HarnessEnvFromSource[];
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
  /** Repos the boot reconcile clones into the in-cluster source volume (`repos/<name>/default`,
   * ADR-0004/0019). A repo pods should see must be fetchable from the cluster. A NON-EMPTY list
   * is also the data-plane switch (ADR-0012/0031): a Workspace needs repos, so with them the
   * instance gets the kubectl Sandbox backend, and without them it is workspace-less
   * (`workspace()` invocations fault pointedly). */
  repos?: RepoConfig[];
  /** Agent-runtime config for the stock Harness (see `HarnessConfig`). */
  harness?: HarnessConfig;
  /** Image registry prefix (deployment-varying — resolve from env). Absent → images are
   * `kind load`-ed; present → pushed. A non-kind cluster without one fails loudly (ADR-0019). */
  registry?: string;
  /** Operator-layer overrides — kit development territory (ADR-0019). */
  operator?: {
    /** `false` = `j2 up` skips the operator layer (run the controller loop yourself). */
    manage?: boolean;
  };
};

/** Identity passthrough that pins a config object's type to `J2Config` for inference. */
export function defineConfig(c: J2Config): J2Config {
  return c;
}

/**
 * Load an instance's `j2.config.ts` (default export). Absent file → undefined (an instance
 * can boot configless); a file that fails to IMPORT throws — a broken config must be loud,
 * never silently treated as "no config".
 */
export async function loadConfig(dir: string): Promise<J2Config | undefined> {
  const file = join(dir, "j2.config.ts");
  if (!existsSync(file)) return undefined;
  const mod = (await import(pathToFileURL(file).href)) as { default?: J2Config };
  if (!mod.default) throw new Error(`${file} has no default export (use \`export default defineConfig({…})\`)`);
  return mod.default;
}
