// The model registry (ADR-0018/0027): a custom provider registers with keyless-tolerant auth and
// limits pass-through; specifiers split at the FIRST slash; unlisted custom ids synthesize;
// jr2's thinkingLevel scale passes through to pi unmapped, and anything else throws — loudly,
// never a silently downgraded model or effort.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  admissionFault,
  modelsFor,
  resolveModel,
  mapThinkingLevel,
  providerLimit,
  PROVIDER_LIMIT,
} from "../src/provider.ts";
import { resolveDefinition, type HarnessSpec, type ThinkingLevel } from "../src/spec.ts";

const vllm: HarnessSpec = {
  provider: {
    id: "vllm",
    api: "openai-completions",
    baseUrl: "http://llm.lan:8000/v1",
    contextWindow: 32768,
    maxTokens: 4096,
    models: { "Qwen/Qwen3-32B": { contextWindow: 40960 } },
  },
};

test("modelsFor: the custom provider registers, listed models in its catalog", () => {
  const models = modelsFor(vllm, {});
  assert.ok(models.getProvider("vllm"));
  const listed = models.getModel("vllm", "Qwen/Qwen3-32B");
  assert.equal(listed?.baseUrl, "http://llm.lan:8000/v1");
  assert.equal(listed?.api, "openai-completions");
});

test("modelsFor: an api this Harness does not speak fails at boot", () => {
  const spec: HarnessSpec = { provider: { id: "p", api: "grpc", baseUrl: "http://x" } };
  assert.throws(() => modelsFor(spec, {}), /names api "grpc"/);
});

test("modelsFor: no harness section still resolves pi's built-in catalog", () => {
  const models = modelsFor(undefined, {});
  const builtin = models.getModels("anthropic")[0];
  assert.ok(builtin, "pi's built-in anthropic catalog is empty?");
  assert.equal(resolveModel(models, `anthropic/${builtin.id}`), builtin);
});

test("resolveModel: splits at the FIRST slash — custom model ids keep theirs", () => {
  const model = resolveModel(modelsFor(vllm, {}), "vllm/Qwen/Qwen3-32B");
  assert.equal(model.provider, "vllm");
  assert.equal(model.id, "Qwen/Qwen3-32B");
});

test("resolveModel: limits pass through per-model → provider-level → 0", () => {
  const models = modelsFor(vllm, {});
  const listed = resolveModel(models, "vllm/Qwen/Qwen3-32B");
  assert.equal(listed.contextWindow, 40960); // per-model wins
  assert.equal(listed.maxTokens, 4096); // provider-level fills the gap
  const unlisted = resolveModel(models, "vllm/unlisted-model");
  assert.equal(unlisted.contextWindow, 32768);
  assert.equal(unlisted.maxTokens, 4096);
  const bare = modelsFor({ provider: { id: "v", api: "openai-completions", baseUrl: "http://x" } }, {});
  const limitless = resolveModel(bare, "v/m");
  assert.equal(limitless.contextWindow, 0);
  assert.equal(limitless.maxTokens, 0);
});

test("resolveModel: an id the custom provider did not list synthesizes against its endpoint", () => {
  const model = resolveModel(modelsFor(vllm, {}), "vllm/unlisted-model");
  assert.equal(model.baseUrl, "http://llm.lan:8000/v1");
  assert.equal(model.api, "openai-completions");
});

test("resolveModel: a malformed specifier throws", () => {
  const models = modelsFor(vllm, {});
  for (const bad of ["no-slash", "/id", "vllm/"]) {
    assert.throws(() => resolveModel(models, bad), /is not a <provider>\/<modelId> specifier/);
  }
});

test("resolveModel: an unknown provider throws — never a silent fallback", () => {
  assert.throws(() => resolveModel(modelsFor(vllm, {}), "ghost/m"), /resolves to nothing/);
});

test("keyless fallback: no JR2_PROVIDER_API_KEY resolves the placeholder, never unconfigured", async () => {
  const auth = await modelsFor(vllm, {}).getAuth("vllm");
  assert.equal(auth?.auth.apiKey, "unused");
});

test("keyless fallback: the env's JR2_PROVIDER_API_KEY — a Stand-in, which the Custodian swaps (ADR-0059) — wins", async () => {
  const auth = await modelsFor(vllm, { JR2_PROVIDER_API_KEY: "jr2-held-JR2_PROVIDER_API_KEY" }).getAuth("vllm");
  assert.equal(auth?.auth.apiKey, "jr2-held-JR2_PROVIDER_API_KEY");
});

test("mapThinkingLevel: every jr2 level passes through to pi unmapped", () => {
  const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
  for (const level of levels) assert.equal(mapThinkingLevel(level), level);
});

test("mapThinkingLevel: a level outside jr2's scale throws — map loudly, never silently", () => {
  // pi's "max" and arbitrary JSON both sit outside jr2's scale; the type says so, the throw
  // guards the runtime spec.
  assert.throws(() => mapThinkingLevel("max" as ThinkingLevel), /has no pi equivalent/);
  assert.throws(() => mapThinkingLevel("bogus" as ThinkingLevel), /has no pi equivalent/);
});

test("admissionFault: the resolved definition is checked the way the turn would use it", () => {
  const models = modelsFor(vllm, {});
  const resolved = (model: string, thinkingLevel?: ThinkingLevel) =>
    resolveDefinition({ model, instructions: "i", ...(thinkingLevel ? { thinkingLevel } : {}) });
  // Listed, unlisted-but-this-provider's, and pi's own catalog all resolve.
  assert.equal(admissionFault(models, resolved("vllm/Qwen/Qwen3-32B")), undefined);
  assert.equal(admissionFault(models, resolved("vllm/never-listed", "high")), undefined);
  // A provider nothing serves is caught at ADMISSION now — the definition rides the Turn
  // (ADR-0049), so there is no earlier moment, and the invoke fails instead of the Submission.
  assert.match(admissionFault(models, resolved("ghost/x")) ?? "", /no custom provider "ghost"/);
  assert.match(admissionFault(models, resolved("bare")) ?? "", /not a <provider>\/<modelId>/);
  assert.match(admissionFault(models, resolved("vllm/m", "max" as ThinkingLevel)) ?? "", /has no pi equivalent/);
});

test("admissionFault: a Turn's dial is checked in the same place as the definition's model", () => {
  const models = modelsFor(vllm, {});
  const definition = { model: "vllm/Qwen/Qwen3-32B", instructions: "i" };
  assert.equal(admissionFault(models, resolveDefinition(definition, { model: "vllm/other" })), undefined);
  // The dial WON the resolution, so it is the dial that is checked (ADR-0018).
  assert.match(admissionFault(models, resolveDefinition(definition, { model: "ghost/x" })) ?? "", /ghost/);
});

test("catalog: a moved provider's models keep every catalog fact and change only baseUrl (ADR-0059)", () => {
  const gateway = "https://litellm.corp.example";
  const models = modelsFor({ catalog: { anthropic: { baseUrl: gateway } } }, {});
  const builtin = models.getModels("anthropic")[0]!;
  const moved = resolveModel(models, `anthropic/${builtin.id}`);
  assert.equal(moved.baseUrl, gateway);
  assert.deepEqual({ ...moved, baseUrl: builtin.baseUrl }, builtin, "limits, cost and thinking map ride along");
  assert.equal(
    models.getModel("anthropic", builtin.id)?.baseUrl,
    "https://api.anthropic.com",
    "the catalog itself is untouched",
  );
  // Another provider stays where the catalog says.
  const openai = models.getModels("openai")[0]!;
  assert.equal(resolveModel(models, `openai/${openai.id}`).baseUrl, openai.baseUrl);
});

test("catalog: an id pi's catalog does not have, or the custom provider's own, is refused at boot", () => {
  assert.throws(
    () => modelsFor({ catalog: { anthropik: { baseUrl: "https://x.example" } } }, {}),
    /not a provider in pi's catalog/,
  );
  assert.throws(
    () => modelsFor({ ...vllm, catalog: { vllm: { baseUrl: "https://x.example" } } }, {}),
    /also the custom provider's id/,
  );
});

/** A Turn's final message as pi resolves it after a provider error. */
function failed(
  errorMessage: string | undefined,
  stopReason: AssistantMessage["stopReason"] = "error",
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "vllm",
    model: "Qwen/Qwen3-32B",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: 0,
  };
}

test("providerLimit: a refusal of the load after pi's retries is named, with the fixed prefix (ADR-0064)", () => {
  for (const error of [
    "429 Too Many Requests",
    "Rate limit reached for requests",
    "503 Service Unavailable",
    "529 overloaded_error: Overloaded",
    "ResourceExhausted: try later",
  ]) {
    const reason = providerLimit(failed(error));
    assert.ok(reason?.startsWith(`${PROVIDER_LIMIT} (vllm/Qwen/Qwen3-32B): ${error}`), `${error} → ${reason}`);
  }
  assert.equal(PROVIDER_LIMIT, "provider limit");
});

test("providerLimit: quota exhaustion is not a provider limit — pi does not retry it (ADR-0064)", () => {
  for (const error of [
    "429 You exceeded your current quota: insufficient_quota",
    "429 Monthly usage limit reached",
    "429 quota exceeded for this billing period",
  ]) {
    assert.equal(providerLimit(failed(error)), undefined, error);
  }
});

test("providerLimit: a retryable error that is not load keeps its own words", () => {
  // pi retries these too, but a 500, a timeout or a refused connection can be a bug or a wrong
  // `baseUrl` — naming them provider pressure would hide exactly what the prefix is for.
  for (const error of ["500 Internal Server Error", "Connection error.", "fetch failed", "Request timed out."]) {
    assert.equal(providerLimit(failed(error)), undefined, error);
  }
  assert.equal(providerLimit(failed("400 invalid request")), undefined, "not retryable");
  assert.equal(providerLimit(failed(undefined)), undefined, "no words to read");
  assert.equal(providerLimit(failed("429 Too Many Requests", "aborted")), undefined, "an abort is the sweep's");
});
