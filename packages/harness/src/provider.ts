// The model registry (ADR-0018/0027): pi-ai's built-in catalog plus the instance's custom
// provider (`harness.provider` — the vLLM/Ollama path), with any catalog provider moved to a
// gateway (`harness.catalog`, ADR-0059). `modelsFor` assembles the registry once
// at boot; `resolveModel` is the per-Submission read of a `<provider>/<modelId>` specifier;
// `mapThinkingLevel` is the loud gate between jr2's effort scale and pi's.
//
// ONE validation seat hangs off `resolveModel`: `admissionFault`, at admission, on the RESOLVED
// definition. Since ADR-0049 there is only one moment a model reaches this process — the Turn
// carries its Agent's definition and the invocation's dials together — so the retired boot-time
// sweep of a mounted roster has nothing left to sweep.
//
// `providerLimit` names a Turn's end when the provider still refused the load after the Harness's
// retries (ADR-0064): the fixed prefix `provider limit`, as a memory kill has `memory limit`
// (ADR-0061). `ranAt` names the thinking level a model ran at when it has no level of the name the
// Turn asked for (ADR-0018): the Harness runs the Turn and says so, and never changes it silently.

import {
  clampThinkingLevel,
  createProvider,
  getSupportedThinkingLevels,
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type Model,
  type Models,
  type ModelThinkingLevel,
  type MutableModels,
  type ProviderAuth,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { CatalogReachSpec, ProviderSpec, HarnessSpec, ResolvedDefinition, ThinkingLevel } from "./spec.ts";

/** The wire protocols a custom provider may name. One entry today: the OpenAI-compatible path is
 * what `harness.provider` documents (vLLM/Ollama); an unlisted `api` throws at boot, never a
 * provider that silently cannot stream. */
const CUSTOM_APIS: Record<string, () => ProviderStreams> = {
  "openai-completions": openAICompletionsApi,
};

/** A custom endpoint serves model ids jr2 cannot enumerate (Agent definitions name them, and
 * `provider.models` lists only the ids with limits) — so `resolveModel` synthesizes unlisted ids
 * on demand, off the spec remembered here per registry. */
const customSpecs = new WeakMap<Models, ProviderSpec>();

/** The catalog providers this registry sends somewhere else (ADR-0059), remembered per registry. */
const catalogReach = new WeakMap<Models, Record<string, CatalogReachSpec>>();

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
  // A gateway for a catalog provider (ADR-0059): refused at boot, loud, for an id pi's catalog does
  // not have — a typo would otherwise send every turn to the provider's own host with a Stand-in —
  // and for the custom provider's id, which owns its own `baseUrl`.
  const catalog = harness?.catalog ?? {};
  for (const id of Object.keys(catalog)) {
    if (spec && spec.id === id) {
      throw new Error(
        `catalog."${id}" is also the custom provider's id — a custom provider owns its own baseUrl (ADR-0059)`,
      );
    }
    if (models.getModels(id).length === 0) {
      throw new Error(`catalog."${id}" is not a provider in pi's catalog — nothing would route through it (ADR-0059)`);
    }
  }
  if (Object.keys(catalog).length > 0) catalogReach.set(models, catalog);
  return models;
}

/**
 * The pi Model for a `<provider>/<modelId>` specifier — split at the FIRST slash, so custom model
 * ids keep theirs (`vllm/Qwen/Qwen3-32B` → id `Qwen/Qwen3-32B`). Catalog first; an id the custom
 * provider did not list synthesizes with provider-level limits; anything else throws.
 *
 * A catalog model whose provider `harness.catalog` moves comes back as a COPY with only `baseUrl`
 * replaced (ADR-0059): pi has no env var that moves a catalog provider, and hands the provider the
 * model it is given, so this one place is where the gateway takes effect — while every model fact
 * the catalog holds (limits, cost, thinking levels) rides along unchanged. The id sent upstream is
 * the catalog's, so the gateway must serve that name.
 */
export function resolveModel(models: Models, specifier: string): Model<Api> {
  const slash = specifier.indexOf("/");
  if (slash <= 0 || slash === specifier.length - 1) {
    throw new Error(`model "${specifier}" is not a <provider>/<modelId> specifier (ADR-0018)`);
  }
  const provider = specifier.slice(0, slash);
  const id = specifier.slice(slash + 1);
  const model = models.getModel(provider, id);
  const reach = catalogReach.get(models)?.[provider];
  if (model && reach) return { ...model, baseUrl: reach.baseUrl };
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
 * jr2's effort scale onto pi's. A strict subset today (pi adds `max`), so every value passes
 * through unmapped — the throw guards the runtime JSON, where a definition can carry anything.
 */
export function mapThinkingLevel(level: ThinkingLevel): ModelThinkingLevel {
  const mapped = PI_LEVELS[level];
  if (!mapped) {
    throw new Error(
      `thinkingLevel "${level}" has no pi equivalent — jr2's scale is ${Object.keys(PI_LEVELS).join("|")}`,
    );
  }
  return mapped;
}

/** The fixed prefix of a fault reason for a provider that still refused the load after the
 * Harness's retries (ADR-0064) — so `jr2 status` and the Machine can tell provider pressure from a bug. */
export const PROVIDER_LIMIT = "provider limit";

/** The load signals inside pi's retryable set (pi-ai `RETRYABLE_PROVIDER_ERROR_PATTERN`): a rate
 * limit, 429, 503/529 and overload. pi's set also retries a 500, a timeout and a refused
 * connection, which can be a bug or a wrong `baseUrl`, so those keep their own words. */
const PROVIDER_PRESSURE =
  /overloaded|rate.?limit|too many requests|\b429\b|\b503\b|\b529\b|service.?unavailable|ResourceExhausted/i;

/**
 * The fault reason for a Turn that ended on a provider's refusal after the Harness's retries
 * (`turn.ts`, `PROVIDER_RETRIES`; pi-ai runs them), else undefined. pi decides "retryable" first:
 * quota or billing exhaustion is not retryable, so it is never a provider limit (ADR-0064). A
 * retryable error on a Turn's final message means the retries ran out, so no retry count is read
 * here.
 */
export function providerLimit(answer: AssistantMessage): string | undefined {
  if (!isRetryableAssistantError(answer)) return undefined;
  const error = answer.errorMessage ?? "";
  if (!PROVIDER_PRESSURE.test(error)) return undefined;
  return (
    `${PROVIDER_LIMIT} (${answer.provider}/${answer.model}): ${error} — the provider still refused the load ` +
    "after the Harness's retries; this is provider pressure, not a fault in the Turn"
  );
}

/** The level a model ran at, and where the Harness read it, when the Harness knows (`ranAt`):
 * `clamp` — the Harness clamped the level to one of pi's level names and sent that; `request` — the
 * Harness's own request sent this provider word (the adapter sets `providerThinkingLevel` from the
 * request that it builds); `answer` — the provider's answer named this word. */
export type RanAt = { by: "clamp" | "request" | "answer"; level: string };

/** True when the model has no level of this name. A model can lack one: Claude Sonnet 5.5 has no
 * `off`. The test is on pi's level names, never on what a provider answered. */
export function lacksLevel(model: Model<Api>, asked: ModelThinkingLevel): boolean {
  return !getSupportedThinkingLevels(model).includes(asked);
}

/** The adapters that set `providerThinkingLevel` from the request that they build, not from the
 * answer: Anthropic sends `output_config.effort` (`high` when it gets no effort), and OpenAI
 * responses sends its configuration effort. Of the other adapters, only pi's own messages API sets
 * the word, and it reads it from the answer. */
const REQUEST_SIDE_LEVEL: ReadonlySet<Api> = new Set<Api>(["anthropic-messages", "openai-responses"]);

/**
 * The level a model ran at, for a level it lacks. OpenAI completions (the one adapter jr2 registers
 * itself, `CUSTOM_APIS`) clamps the level and sends the result — but only a level that the Harness
 * gives it: at `off` the Harness gives no level, the adapter clamps nothing, and a model whose map
 * has no `off` gets no reasoning field. Else the `providerThinkingLevel` word: the Harness's own
 * request for the adapters in `REQUEST_SIDE_LEVEL`, the provider's answer for the others. Else
 * undefined — the provider chose the level, and the Harness does not know which.
 */
export function ranAt(model: Model<Api>, asked: ModelThinkingLevel, message: AssistantMessage): RanAt | undefined {
  if (model.api === "openai-completions") {
    return asked === "off" ? undefined : { by: "clamp", level: clampThinkingLevel(model, asked) };
  }
  const word = message.providerThinkingLevel;
  if (!word) return undefined;
  return { by: REQUEST_SIDE_LEVEL.has(model.api) ? "request" : "answer", level: word };
}

const PI_LEVELS: Record<ThinkingLevel, ModelThinkingLevel> = {
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

/** pi refuses a keyless HTTP provider outright (`Provider is not configured`), so resolution
 * always answers: `JR2_PROVIDER_API_KEY` when set — a Stand-in, which the Custodian swaps for the
 * key toward the endpoint's host (ADR-0059) — else a value the keyless endpoints (vLLM/Ollama)
 * ignore. jr2's `apiKey` stays genuinely optional (ADR-0018). */
function keylessAuth(env: Record<string, string | undefined>): ProviderAuth {
  return {
    apiKey: {
      name: "JR2_PROVIDER_API_KEY",
      resolve: async () => ({ auth: { apiKey: env.JR2_PROVIDER_API_KEY || "unused" } }),
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
    // A self-hosted OpenAI-compatible server renders the model's own chat template, which knows
    // `system` and not OpenAI's `developer` — pi would send `developer` for a reasoning model.
    // `supportsStrictMode` keeps `"strict": false` on each tool, as pi 0.82.1 sent it: a vLLM chat
    // template renders the tool object into the prompt, so the field is text the model reads. It is
    // `false` because no jr2 tool sets `constrainedSampling`; a tool that set it would need a new
    // decision here.
    compat: { supportsDeveloperRole: false, supportsStrictMode: true },
  };
}
