// The model registry (ADR-0018/0027): a custom provider registers with keyless-tolerant auth and
// limits pass-through; specifiers split at the FIRST slash; unlisted custom ids synthesize;
// jr2's thinkingLevel scale passes through to pi unmapped, and anything else throws — loudly,
// never a silently downgraded model or effort.

import { test } from "node:test";
import assert from "node:assert/strict";
import { admissionFault, modelsFor, resolveModel, mapThinkingLevel } from "../src/provider.ts";
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

test("keyless fallback: a Secret-fed key wins over the placeholder", async () => {
  const auth = await modelsFor(vllm, { JR2_PROVIDER_API_KEY: "sk-real" }).getAuth("vllm");
  assert.equal(auth?.auth.apiKey, "sk-real");
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
