// The model registry (ADR-0018/0027): pi-ai's built-in catalog plus the instance's custom
// provider (`harness.provider` — the vLLM/Ollama path). `modelsFor` assembles the registry once
// at boot; `resolveModel` is the per-Submission read of a `<provider>/<modelId>` specifier;
// `mapThinkingLevel` is the loud gate between j2's effort scale and pi's.
//
// ONE validation seat hangs off `resolveModel`: `admissionFault`, at admission, on the RESOLVED
// definition. Since ADR-0049 there is only one moment a model reaches this process — the Turn
// carries its Agent's definition and the invocation's dials together — so the retired boot-time
// sweep of a mounted roster has nothing left to sweep.

import {
  createProvider,
  type Api,
  type Model,
  type Models,
  type MutableModels,
  type ProviderAuth,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ProviderSpec, HarnessSpec, ResolvedDefinition, ThinkingLevel } from "./spec.ts";

/** The wire protocols a custom provider may name. One entry today: the OpenAI-compatible path is
 * what `harness.provider` documents (vLLM/Ollama); an unlisted `api` throws at boot, never a
 * provider that silently cannot stream. */
const CUSTOM_APIS: Record<string, () => ProviderStreams> = {
  "openai-completions": openAICompletionsApi,
};

/** A custom endpoint serves model ids j2 cannot enumerate (Agent definitions name them, and
 * `provider.models` lists only the ids with limits) — so `resolveModel` synthesizes unlisted ids
 * on demand, off the spec remembered here per registry. */
const customSpecs = new WeakMap<Models, ProviderSpec>();

/**
 * The registry an instance's model specifiers resolve against: pi-ai's built-in catalog
 * (`anthropic/…` etc., keys from ambient env), plus `harness.provider` when the spec carries one.
 */
export function modelsFor(harness: HarnessSpec | undefined, env: Record<string, string | undefined>): MutableModels {
  const models = builtinModels();
  const spec = harness?.provider;
  if (spec) {
    const api = CUSTOM_APIS[spec.api];
    if (!api) {
      throw new Error(
        `provider "${spec.id}" names api "${spec.api}" — this Harness speaks: ${Object.keys(CUSTOM_APIS).join(", ")} (ADR-0018)`,
      );
    }
    models.setProvider(
      createProvider({
        id: spec.id,
        baseUrl: spec.baseUrl,
        auth: keylessAuth(env),
        models: Object.keys(spec.models ?? {}).map((id) => customModel(spec, id)),
        api: api(),
      }),
    );
    customSpecs.set(models, spec);
  }
  return models;
}

/**
 * The pi Model for a `<provider>/<modelId>` specifier — split at the FIRST slash, so custom model
 * ids keep theirs (`vllm/Qwen/Qwen3-32B` → id `Qwen/Qwen3-32B`). Catalog first; an id the custom
 * provider did not list synthesizes with provider-level limits; anything else throws.
 */
export function resolveModel(models: Models, specifier: string): Model<Api> {
  const slash = specifier.indexOf("/");
  if (slash <= 0 || slash === specifier.length - 1) {
    throw new Error(`model "${specifier}" is not a <provider>/<modelId> specifier (ADR-0018)`);
  }
  const provider = specifier.slice(0, slash);
  const id = specifier.slice(slash + 1);
  const model = models.getModel(provider, id);
  if (model) return model;
  const custom = customSpecs.get(models);
  if (custom && custom.id === provider) return customModel(custom, id);
  throw new Error(
    `model "${specifier}" resolves to nothing — not in pi's catalog, and no custom provider "${provider}" is configured (ADR-0018)`,
  );
}

/**
 * Why this admission cannot run, or undefined when it can — the `checkAdmission` seam `app.ts`
 * 400s with (ADR-0049: the definition rides the Turn, so this is the only moment either half of
 * it is checkable here). Both are checked the way the turn would use them, so an unresolvable
 * model or an off-scale effort fails the invoke instead of the Submission.
 */
export function admissionFault(models: Models, resolved: ResolvedDefinition): string | undefined {
  try {
    resolveModel(models, resolved.model);
    if (resolved.thinkingLevel) mapThinkingLevel(resolved.thinkingLevel);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return undefined;
}

/**
 * j2's effort scale onto pi's. A strict subset today (pi adds `max`), so every value passes
 * through unmapped — the throw guards the runtime JSON, where a definition can carry anything.
 */
export function mapThinkingLevel(level: ThinkingLevel): PiThinkingLevel {
  const mapped = PI_LEVELS[level];
  if (!mapped) {
    throw new Error(
      `thinkingLevel "${level}" has no pi equivalent — j2's scale is ${Object.keys(PI_LEVELS).join("|")}`,
    );
  }
  return mapped;
}

const PI_LEVELS: Record<ThinkingLevel, PiThinkingLevel> = {
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

/** pi refuses a keyless HTTP provider outright (`Provider is not configured`), so resolution
 * always answers: the Secret-fed key when `j2 up` materialized one, else a placeholder the
 * keyless endpoints (vLLM/Ollama) ignore — j2's `apiKey` stays genuinely optional (ADR-0018). */
function keylessAuth(env: Record<string, string | undefined>): ProviderAuth {
  return {
    apiKey: {
      name: "J2_PROVIDER_API_KEY",
      resolve: async () => ({ auth: { apiKey: env.J2_PROVIDER_API_KEY || "unused" } }),
    },
  };
}

/** One custom-provider Model. Limits resolve per-model → provider-level → 0 (the order
 * `HarnessProvider` documents); `reasoning: true` because the spec carries no reasoning flag and
 * `false` would silently swallow a definition's `thinkingLevel` before the endpoint ever saw it
 * (an `off` default still sends nothing). */
function customModel(spec: ProviderSpec, id: string): Model<Api> {
  const limits = spec.models?.[id];
  return {
    id,
    name: id,
    api: spec.api,
    provider: spec.id,
    baseUrl: spec.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: limits?.contextWindow ?? spec.contextWindow ?? 0,
    maxTokens: limits?.maxTokens ?? spec.maxTokens ?? 0,
  };
}
