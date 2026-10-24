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
// `checkModel` is the provider preflight's call (ADR-0019): `jr2 up` runs `provider-preflight.ts` in this
// image, beside a Custodian, so the check resolves and calls a model the way a Turn does.
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
  type SimpleStreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { PreflightVerdict } from "./preflight-line.ts";
import type { CatalogReachSpec, ProviderSpec, HarnessSpec, ResolvedDefinition, ThinkingLevel } from "./spec.ts";

/** The wire protocols a custom provider may name. One entry today: the OpenAI-compatible path is
 * what `harness.provider` documents (vLLM/Ollama); an unlisted `api` throws at boot, never a
 * provider that silently cannot stream. `jr2 up` refuses against `CUSTOM_PROVIDER_APIS` in
 * `@jr2/orchestrator`, which a test holds equal to these keys. */
export const CUSTOM_APIS: Record<string, () => ProviderStreams> = {
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

/** The provider retries of each request (ADR-0016, ADR-0064): a 429, a 503 or an overload is
 * retried twice, with backoff, and a server's `retry-after` is honored up to 60 s. pi-ai runs them,
 * but only when the Harness states a number: it reads `maxRetries ?? 0`. 2 is the summarizer's
 * number too (`compaction.ts`), and the SDKs' own default. A Turn (`turn.ts`) and the provider
 * preflight (`checkModel`) use it. */
export const PROVIDER_RETRIES = 2;

/** The one tool the provider preflight offers (ADR-0019). It takes nothing, so any call of it is
 * a valid call. */
const CHECK_TOOL: Tool = {
  name: "ping",
  description: "Reply with a ping.",
  parameters: { type: "object", properties: {} } as unknown as Tool["parameters"],
};

/**
 * How each api is told to call `ping` (ADR-0019). pi-ai's provider-neutral `toolChoice` says only
 * `auto` or `none`, but every one of its adapters hands the value to its api's own option as it is,
 * so the check passes the api's own form; `catalog-gateway.test.ts` pins each one in the payload the
 * adapter builds. An api not here is not forced: `openai-codex-responses` signs in with OAuth alone,
 * so no test can see its payload. The check forces only with thinking off: Anthropic, and Claude on
 * Bedrock, refuse a forced tool while the model thinks.
 */
export const FORCED_TOOL: Readonly<Record<string, unknown>> = {
  "anthropic-messages": { type: "tool", name: "ping" },
  "bedrock-converse-stream": { type: "tool", name: "ping" },
  "openai-completions": { type: "function", function: { name: "ping" } },
  "mistral-conversations": { type: "function", function: { name: "ping" } },
  "pi-messages": { type: "function", function: { name: "ping" } },
  "openai-responses": { type: "function", name: "ping" },
  "azure-openai-responses": { type: "function", name: "ping" },
  "google-generative-ai": "any",
  "google-vertex": "any",
};

/** The apis whose pi-ai adapter refuses a `fetch` that is not `globalThis.fetch` ("Custom fetch is not supported"
 * from Google's and Vertex's, pi-ai 1.4): the check passes them none. A test runs the check against
 * a local server for each forced api and the custom one, so a pi bump that refuses another shows. */
const FETCHLESS_APIS: ReadonlySet<string> = new Set(["google-generative-ai", "google-vertex"]);

/** How long a call of the check waits for its first event — text, thinking, a tool call or the end
 * — its retries included (each waits at most `CHECK_MAX_RETRY_DELAY_MS`). 120 s, because an Ollama
 * endpoint loads the model on the first request and a llama.cpp on a CPU reads the prompt before it
 * writes: both are slow to start and then stream. */
export const CHECK_FIRST_EVENT_MS = 120_000;
/** How long a call of the check waits between two events once the stream runs. 60 s: an endpoint
 * that stops for a minute in the middle of an answer is one that a Turn cannot use either. The
 * total is not bounded: a slow model that streams passes. */
export const CHECK_EVENT_GAP_MS = 60_000;

/**
 * The provider preflight's check of one model (ADR-0019): resolve `specifier` as a Turn does — the
 * catalog gateway included (ADR-0059) — and ask for a call of the `ping` tool. pi reads the key
 * from the env, which holds a Stand-in, so the Custodian beside this process makes the call a real
 * one.
 *
 * What the check's request shares with a Turn's: the model, its api, its endpoint and key, the
 * level a definition with no `thinkingLevel` runs at (`off`: no `reasoning` is sent), the
 * completion limit (pi-ai's, as `unlimitedPayload` leaves it), no forced tool, and the retries.
 * What it does not share: it has no system prompt, one tool, no session id, and a one-line
 * prompt. So an endpoint whose context is too small for a Turn's prompt can pass the check.
 *
 * The first call decides:
 * - An error is a `fault`, or `busy` when the provider still refuses the load after the Turn's
 *   retries (`checkBusy`, ADR-0064): it answered and took the key. A 503 alone is a `fault`.
 * - A tool call is `ok`.
 * - Text from the custom provider: a Turn there gets a nudge, so the same call goes once more; a
 *   tool call then is `ok`, an error decides as above, and text again is a `fault` (that is how a
 *   vLLM with no tool parser answers).
 * - Text from a catalog model is a `warn`. When the model has `off` (thinking off), is not moved to
 *   a gateway, and its api has a forced form (`FORCED_TOOL`), a second call forces the tool, and
 *   only the words of the warning change: with a tool call, that the model answered in text when
 *   the tool was not forced; with text or an error, that it gave no tool call either way. A
 *   gateway may be a server that answers a forced tool by guided decoding alone.
 *
 * Beside a Turn's request, the check's options carry a `fetch` wrapper and an `onResponse` (a
 * Bedrock SDK middleware that a Turn does not have): they only read each try's status.
 *
 * A call waits `CHECK_FIRST_EVENT_MS` for its first event, then `CHECK_EVENT_GAP_MS` for each gap
 * between events. A call that runs out is a `fault` ("no answer"), unless the last status that any
 * try of it got was a 429 or a 529 (a later 200 or 503 clears it): then it is `busy`. Google's and
 * Vertex's tries are not seen, so for them only the final error counts. A second call that runs
 * out keeps the first verdict.
 */
export async function checkModel(
  models: Models,
  specifier: string,
  options: {
    /** The two bounds of each call. Default `CHECK_FIRST_EVENT_MS`, `CHECK_EVENT_GAP_MS`. */
    firstEventMs?: number;
    gapMs?: number;
    /** Whether a text answer may get a second, forced call. Default: not for a provider that
     * `harness.catalog` moves. A test sets it to reach that call through a local fake gateway. */
    mayForce?: boolean;
    /** The model's whole budget (`provider-preflight.ts`): its abort ends every call. */
    signal?: AbortSignal;
  } = {},
): Promise<PreflightVerdict> {
  const firstEventMs = options.firstEventMs ?? CHECK_FIRST_EVENT_MS;
  const gapMs = options.gapMs ?? CHECK_EVENT_GAP_MS;
  let model: Model<Api>;
  try {
    model = resolveModel(models, specifier);
  } catch (err) {
    return { kind: "fault", reason: err instanceof Error ? err.message : String(err) };
  }
  const custom = customSpecs.get(models)?.id === model.provider;
  const moved = catalogReach.get(models)?.[model.provider] !== undefined;
  const onPayload = unlimitedPayload(model);

  /** One call, streamed, with its two bounds. `stalled` names a bound that ran out; `limited` is
   * a limit the provider answered with on the way (a 429 or a 529, within pi's retries). */
  const call = async (toolChoice: unknown) => {
    const abort = new AbortController();
    // The model's whole budget (`provider-preflight.ts`) ends this call too.
    const stop = () => abort.abort();
    options.signal?.addEventListener("abort", stop, { once: true });
    // A call made when the model's budget is already spent is over at once.
    if (options.signal?.aborted) abort.abort();
    let stalled: string | undefined;
    let limited: number | undefined;
    const note = (status: number) => {
      limited = status === 429 || status === 529 ? status : undefined;
    };
    const seen = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await fetch(input, init);
      note(response.status);
      return response;
    };
    const arm = (ms: number, what: string) =>
      setTimeout(() => {
        stalled = what;
        abort.abort();
      }, ms);
    let timer = arm(firstEventMs, `no answer in ${firstEventMs / 1000} s`);
    const stream = models.streamSimple(
      model,
      {
        // A Turn's user message is a list of parts (`turn.ts`); the check's is one text part.
        messages: [{ role: "user", content: [{ type: "text", text: "Call the ping tool." }], timestamp: Date.now() }],
        tools: [CHECK_TOOL],
      },
      {
        maxRetries: PROVIDER_RETRIES,
        maxRetryDelayMs: CHECK_MAX_RETRY_DELAY_MS,
        ...(toolChoice !== undefined ? { toolChoice: toolChoice as SimpleStreamOptions["toolChoice"] } : {}),
        ...(onPayload ? { onPayload } : {}),
        // Each try's status, as each api tells it: pi-ai sends a fresh request on each retry. Through
        // the check's `fetch` wrapper for the apis whose adapter takes one; through `onResponse` for
        // Bedrock, whose retries are the AWS SDK's own (pi-ai's `maxRetries` does not reach them) and
        // whose SDK middleware tells each try. Google's and Vertex's adapters refuse a `fetch` that is
        // not `globalThis.fetch`, so they get none and only their final error counts. The busy rule:
        // the last status that any try got was a 429 or a 529, and then the call ran out; a later
        // 200 or 503 clears it.
        ...(FETCHLESS_APIS.has(model.api) ? {} : { fetch: seen }),
        onResponse: (response: { status: number }) => note(response.status),
        signal: abort.signal,
      },
    );
    try {
      for await (const event of stream) {
        // `start` comes before any byte of the answer; the bounds wait for the answer itself.
        if (event.type === "start") continue;
        clearTimeout(timer);
        timer = arm(gapMs, `no event for ${gapMs / 1000} s in the middle of the answer`);
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
    }
    if (options.signal?.aborted) stalled ??= "the model's time ran out";
    return { answer: await stream.result(), stalled, limited };
  };
  const tooled = (a: AssistantMessage) => a.content.some((part) => part.type === "toolCall");
  /** The verdict of a call that did not answer with a tool call or text. */
  const failed = (c: Awaited<ReturnType<typeof call>>): PreflightVerdict => {
    if (c.stalled) {
      return c.limited
        ? { kind: "busy", reason: `${PROVIDER_LIMIT} (${specifier}): HTTP ${c.limited}, then ${c.stalled}` }
        : { kind: "fault", reason: c.stalled };
    }
    const busy = checkBusy(c.answer);
    if (busy) return { kind: "busy", reason: busy };
    return {
      kind: "fault",
      reason: `${model.api} call to ${model.baseUrl} failed: ${c.answer.errorMessage ?? c.answer.stopReason}`,
    };
  };
  const errs = (c: Awaited<ReturnType<typeof call>>) =>
    c.stalled !== undefined || c.answer.stopReason === "error" || c.answer.stopReason === "aborted";

  const first = await call(undefined);
  if (errs(first)) return failed(first);
  if (tooled(first.answer)) return { kind: "ok" };
  const why = `the answer carried no tool call (stop reason "${first.answer.stopReason}")`;
  if (custom) {
    const again = await call(undefined);
    if (errs(again)) return failed(again);
    if (tooled(again.answer)) return { kind: "ok" };
    return { kind: "fault", reason: `${why}, twice` };
  }
  const levels = getSupportedThinkingLevels(model);
  const forced = levels.includes("off") && (options.mayForce ?? !moved) ? FORCED_TOOL[model.api] : undefined;
  if (forced === undefined) return { kind: "warn", reason: `${why}; the tool was not forced (${model.api})` };
  // Text where a Turn wants a call: a forced call tells a model that can call the tool from one
  // that cannot. The verdict stays a warning: the Turn's own request worked.
  const second = await call(forced);
  if (!errs(second) && tooled(second.answer)) {
    return {
      kind: "warn",
      reason: `the model answered in text when the tool was not forced, and called it when forced (${model.api})`,
    };
  }
  // The model's budget ran out before the forced call answered: it says nothing either way.
  if (options.signal?.aborted) {
    return {
      kind: "warn",
      reason: `${why}; the model's time ran out before a forced call could answer (${model.api})`,
    };
  }
  return { kind: "warn", reason: `${why}, and no tool call when the tool was forced either (${model.api})` };
}

/** The longest `retry-after` the check waits out (pi-ai's `maxRetryDelayMs`). A provider that asks
 * for longer is busy now: pi then ends the call with the provider's 429 text, which `providerLimit`
 * reads, and the call does not reach its own bound (`CHECK_FIRST_EVENT_MS`). */
export const CHECK_MAX_RETRY_DELAY_MS = 20_000;

/** What the check calls busy (ADR-0019): a limit the provider names — a 429, a 529, an overload, a
 * rate limit, ResourceExhausted, or a `retry-after` longer than the check waits. A 503 alone is not:
 * a gateway with no backend, or a server that is still loading its model, answers 503, and a Turn
 * there fails. */
const CHECK_BUSY = /\b429\b|\b529\b|overloaded|rate.?limit|too many requests|ResourceExhausted|retry delay/i;

/** The check's busy verdict, or undefined: `providerLimit` (ADR-0064, after the retries), narrowed
 * to `CHECK_BUSY`. Exported for its test. */
export function checkBusy(answer: AssistantMessage): string | undefined {
  const limit = providerLimit(answer);
  return limit && CHECK_BUSY.test(answer.errorMessage ?? "") ? limit : undefined;
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

/** A request's payload hook, as pi-ai takes it (`onPayload`). */
type PayloadHook = (payload: unknown, model: Model<Api>) => unknown;

/**
 * The payload hook for a model with no completion limit at all (ADR-0018): neither `maxTokens` nor
 * `contextWindow` set, which only a custom-provider model can be (`customModel`), on an api of
 * `CUSTOM_APIS` (today `openai-completions`, whose fields it removes). pi-ai 1.4 sends a
 * limit on every request — `clampMaxTokensToContext` gives at least 1 when the context window is
 * unknown — so such a model's Turns asked for `max_completion_tokens: 1`. This hook removes the
 * limit from the payload, so the endpoint's own applies, as `HarnessProvider.maxTokens` says ("no
 * limit is sent"). With a context window and no `maxTokens`, pi sends none itself. `next` is a hook
 * the caller already has, run first. Undefined when there is nothing to do.
 */
export function unlimitedPayload(model: Model<Api>, next?: PayloadHook): PayloadHook | undefined {
  // Only the apis a custom provider can name (`CUSTOM_APIS`): the payload fields are theirs.
  if (!Object.hasOwn(CUSTOM_APIS, model.api) || model.maxTokens > 0 || model.contextWindow > 0) return next;
  return async (payload, m) => {
    const sent = ((await next?.(payload, m)) ?? payload) as Record<string, unknown>;
    if (typeof sent !== "object" || sent === null) return sent;
    const { max_tokens: _a, max_completion_tokens: _b, ...rest } = sent;
    return rest;
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
