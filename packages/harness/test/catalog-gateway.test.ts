// pi honours `harness.catalog` (ADR-0059), over a real socket — the canary for the LiteLLM path:
// pi at the exact pin, the catalog's own `anthropic/…` model, moved by `resolveModel` onto a local
// fake that serves the Anthropic Messages API as SSE. The request must arrive THERE, with `x-api-key`
// equal to what the env holds — in a pod that is the Stand-in, which the Custodian swaps on the way
// out (its own suite proves that half). A pi bump that stopped handing the provider the model it is
// given, or that read a base URL from somewhere else, fails here and not in a user's cluster.

import { test } from "node:test";
import assert from "node:assert/strict";
import { modelsFor, resolveModel } from "../src/provider.ts";
import { startAnthropicGateway } from "./support/anthropic-gateway.ts";

test("a catalog provider moved to a gateway: the Messages call lands there, with the env's key", async () => {
  const gateway = await startAnthropicGateway();
  const seen = gateway.seen;
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "jr2-held-ANTHROPIC_API_KEY";
  try {
    const models = modelsFor({ catalog: { anthropic: { baseUrl: gateway.url } } }, process.env);
    const builtin = models.getModels("anthropic")[0]!;
    const answer = await models.completeSimple(resolveModel(models, `anthropic/${builtin.id}`), {
      messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
    });
    assert.equal(answer.stopReason, "stop", answer.errorMessage ?? "");
    assert.equal(seen.length, 1, "the call went to the gateway");
    // pi-ai 1.4 calls the SDK's beta endpoint, so the path carries `?beta=true` (the Custodian accepts it).
    assert.equal(seen[0]!.url, "/v1/messages?beta=true");
    assert.equal(seen[0]!.headers["x-api-key"], "jr2-held-ANTHROPIC_API_KEY");
    assert.equal(seen[0]!.body.model, builtin.id, "the catalog id is the name the gateway must serve");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
    await gateway.close();
  }
});

test("Claude Sonnet 5.5 through the gateway: no temperature at off or high, and at off the request sends effort high (ADR-0018)", async () => {
  // jr2's default level is `off`, which this model lacks (`thinkingLevelMap.off` is null). pi-ai's
  // adapter then sends its default effort, `high`, and puts that word on the answer. The word comes
  // from the request, not from the provider: the Turn prints that the Harness sent it (`ranAt`,
  // ADR-0023).
  const gateway = await startAnthropicGateway();
  try {
    const models = modelsFor({ catalog: { anthropic: { baseUrl: gateway.url } } }, { ANTHROPIC_API_KEY: "x" });
    const model = resolveModel(models, "anthropic/claude-sonnet-5-5");
    const context = { messages: [{ role: "user" as const, content: "ping", timestamp: Date.now() }] };
    const off = await models.completeSimple(model, context, { apiKey: "x" });
    const high = await models.completeSimple(model, context, { apiKey: "x", reasoning: "high" });
    assert.equal(off.stopReason, "stop", off.errorMessage ?? "");
    assert.equal(high.stopReason, "stop", high.errorMessage ?? "");
    for (const { body } of gateway.seen) assert.equal("temperature" in body, false);
    assert.deepEqual(gateway.seen[0]!.body.output_config, { effort: "high" });
    assert.equal(off.providerThinkingLevel, "high");
  } finally {
    await gateway.close();
  }
});
