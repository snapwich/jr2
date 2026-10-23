// pi honours `harness.catalog` (ADR-0059), over a real socket — the canary for the LiteLLM path:
// pi at the exact pin, the catalog's own `anthropic/…` model, moved by `resolveModel` onto a local
// fake that serves the Anthropic Messages API as SSE. The request must arrive THERE, with `x-api-key`
// equal to what the env holds — in a pod that is the Stand-in, which the Custodian swaps on the way
// out (its own suite proves that half). A pi bump that stopped handing the provider the model it is
// given, or that read a base URL from somewhere else, fails here and not in a user's cluster.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { MODEL_KEYS } from "@jr2/orchestrator/internal";
import { preflightLine, type PreflightVerdict } from "../src/preflight-line.ts";
import { FORCED_TOOL, modelsFor, probeModel, PROVIDER_RETRIES, resolveModel } from "../src/provider.ts";
import { startAnthropicGateway, type GatewayAnswer } from "./support/anthropic-gateway.ts";
import { startFakeProvider } from "./support/rig.ts";

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

/** The env that can send a request elsewhere, or change the AWS SDK's tries or endpoint: cleared
 * for the tests that run the Bedrock adapter, and put back after. */
const LEAKY_ENV = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NODE_USE_ENV_PROXY",
  "AWS_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_MAX_ATTEMPTS",
  "AWS_RETRY_MODE",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "AWS_USE_FIPS_ENDPOINT",
  "AWS_USE_DUALSTACK_ENDPOINT",
];

// The provider preflight's probe (ADR-0019): the call `provider-preflight.ts` makes in its pod, through the
// same resolution and the same env key a Turn uses.

/** A catalog model with `off`, so a forced call is allowed; and one without (ADR-0018). */
const PROBE_MODEL = "anthropic/claude-haiku-5-5";
const NO_OFF_MODEL = "anthropic/claude-sonnet-5-5";

/** pi's catalog reads a provider's key from `process.env`, as in a pod: set it for one probe. */
async function withKey<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env.ANTHROPIC_API_KEY;
  if (value === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = value;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
}

/** One probe against a fresh fake gateway that answers `answer`; the verdict and what it saw.
 * `mayForce` stands for a provider that the catalog does NOT move: the fake is a gateway, and the
 * probe never forces a gateway's model. */
async function probeAt(
  answer: GatewayAnswer | GatewayAnswer[],
  opts: { model?: string; key?: string | null; mayForce?: boolean; firstEventMs?: number } = {},
) {
  const gateway = await startAnthropicGateway(answer);
  try {
    const models = modelsFor({ catalog: { anthropic: { baseUrl: gateway.url } } }, process.env);
    const verdict = await withKey(opts.key === null ? undefined : (opts.key ?? "x"), () =>
      probeModel(models, opts.model ?? PROBE_MODEL, {
        ...(opts.mayForce !== undefined ? { mayForce: opts.mayForce } : {}),
        ...(opts.firstEventMs !== undefined ? { firstEventMs: opts.firstEventMs } : {}),
      }),
    );
    return { verdict, seen: gateway.seen };
  } finally {
    await gateway.close();
  }
}

const reason = (v: PreflightVerdict) => (v.kind === "ok" ? "" : v.reason);

test("probeModel: the first call is the Turn's own request — no forced tool, thinking off, the probe's budget, the env's key", async () => {
  const { verdict, seen } = await probeAt("tool", { key: "jr2-held-ANTHROPIC_API_KEY" });
  assert.deepEqual(verdict, { kind: "ok" });
  assert.equal(seen.length, 1, "a tool call: one call, and no second");
  const { headers, body } = seen[0]!;
  assert.equal(headers["x-api-key"], "jr2-held-ANTHROPIC_API_KEY", "the env's Stand-in, which the Custodian swaps");
  assert.equal(body.model, "claude-haiku-5-5");
  assert.ok((body.tools as Array<{ name: string }>).some((t) => t.name === "ping"));
  assert.equal("tool_choice" in body, false, "what a Turn sends");
  assert.deepEqual(body.thinking, { type: "disabled" });
  // The Turn's own completion limit and level: no `maxTokens` and no `reasoning` from the check.
  const model = resolveModel(modelsFor({ catalog: { anthropic: { baseUrl: "https://x" } } }, {}), PROBE_MODEL);
  assert.equal(body.max_tokens, model.maxTokens);
  assert.equal("output_config" in body, false, "no effort sent: a default Turn runs at off");
});

test("probeModel: behind a gateway that refuses the Turn's request (a vLLM with no auto tool choice), the check fails — a forced call would have passed", async () => {
  const refused = {
    status: 400,
    body: {
      type: "error",
      error: { type: "invalid_request_error", message: '"auto" tool choice requires --enable-auto-tool-choice' },
    },
  };
  const { verdict, seen } = await probeAt([refused, "tool"]);
  assert.equal(verdict.kind, "fault");
  assert.match(reason(verdict), /enable-auto-tool-choice/);
  assert.equal(seen.length, 1, "no forced call after an error");
});

test("probeModel: text, then a forced call — a tool call when forced warns that the model answered in text when not forced", async () => {
  const { verdict, seen } = await probeAt(["text", "tool"], { mayForce: true });
  assert.equal(verdict.kind, "warn");
  assert.match(reason(verdict), /answered in text when the tool was not forced, and called it when forced/);
  assert.equal(seen.length, 2);
  assert.equal("tool_choice" in seen[0]!.body, false);
  assert.deepEqual(seen[1]!.body.tool_choice, FORCED_TOOL["anthropic-messages"]);
});

test("probeModel: text, then a forced call that answers text or an error — a warning that it carried no tool call", async () => {
  for (const second of [
    "text",
    { status: 400, body: { type: "error", error: { type: "x", message: "no" } } },
  ] as const) {
    const { verdict, seen } = await probeAt(["text", second], { mayForce: true });
    assert.equal(verdict.kind, "warn", JSON.stringify(second));
    assert.match(
      reason(verdict),
      /no tool call \(stop reason "stop"\), and no tool call when the tool was forced either/,
    );
    assert.equal(seen.length, 2);
  }
});

test("probeModel: a gateway's model, and a model with no off, are never forced — their text is a warning", async () => {
  const gateway = await probeAt("text");
  assert.equal(gateway.verdict.kind, "warn");
  assert.match(reason(gateway.verdict), /the tool was not forced \(anthropic-messages\)/);
  assert.equal(gateway.seen.length, 1);
  const noOff = await probeAt("text", { model: NO_OFF_MODEL, mayForce: true });
  assert.match(reason(noOff.verdict), /the tool was not forced \(anthropic-messages\)/);
  assert.equal(noOff.seen.length, 1);
  assert.equal("tool_choice" in noOff.seen[0]!.body, false);
});

test("probeModel: a refused key is a fault that names the api, the endpoint and the provider's words", async () => {
  const { verdict, seen } = await probeAt(
    { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } },
    { mayForce: true },
  );
  assert.equal(verdict.kind, "fault");
  assert.match(reason(verdict), /^anthropic-messages call to http:\/\/127\.0\.0\.1:\d+ failed: .*invalid x-api-key/);
  assert.equal(seen.length, 1);
});

test("probeModel: busy is a named limit after the Turn's retries, and a 503 alone is a fault (ADR-0064)", async () => {
  const overloaded = await probeAt({
    status: 529,
    headers: { "retry-after": "0" },
    body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  });
  assert.equal(overloaded.verdict.kind, "busy", JSON.stringify(overloaded.verdict));
  assert.match(reason(overloaded.verdict), /^provider limit/);
  assert.equal(overloaded.seen.length, 1 + PROVIDER_RETRIES, "the Turn's retries, then the verdict");
  const started = Date.now();
  const later = await probeAt({
    status: 429,
    headers: { "retry-after": "600" },
    body: { type: "error", error: { type: "rate_limit_error", message: "rate limited" } },
  });
  assert.equal(later.verdict.kind, "busy");
  assert.match(reason(later.verdict), /429/);
  assert.ok(Date.now() - started < 5000, "no wait of 600 s: pi gives up past PROBE_MAX_RETRY_DELAY_MS");
  const unavailable = await probeAt({
    status: 503,
    headers: { "retry-after": "0" },
    body: { type: "error", error: { type: "api_error", message: "no healthy upstream" } },
  });
  assert.equal(unavailable.verdict.kind, "fault", "a gateway with no backend fails a Turn too");
});

test("probeModel: each call has its own bound — a first call that never answers says so; a forced call that runs out keeps the first verdict", async () => {
  const silent = await probeAt("hang", { firstEventMs: 300 });
  assert.deepEqual(silent.verdict, { kind: "fault", reason: "no answer in 0.3 s" });
  const late = await probeAt(["text", "hang"], { firstEventMs: 300, mayForce: true });
  assert.equal(late.verdict.kind, "warn");
  assert.match(reason(late.verdict), /no tool call when the tool was forced either/);
});

test("probeModel: a model nothing serves is a fault, before any call", async () => {
  const verdict = await probeModel(modelsFor({}, {}), "ghost/m");
  assert.equal(verdict.kind, "fault");
  assert.match(reason(verdict), /resolves to nothing/);
});

test("probeModel: a provider with no key in the env is a fault, and no call leaves", async () => {
  const { verdict, seen } = await probeAt("tool", { key: null });
  assert.equal(verdict.kind, "fault");
  assert.match(reason(verdict), /not configured: anthropic/);
  assert.equal(seen.length, 0);
});

test("preflightLine: one line per model, the reason on that line", () => {
  assert.equal(preflightLine("a/b", { kind: "ok" }), "jr2.preflight model=a/b ok");
  assert.equal(
    preflightLine("a/b", { kind: "fault", reason: "two\nlines" }),
    "jr2.preflight model=a/b fault=two lines",
  );
});

test("probeModel: the custom provider is called as a Turn calls it — no forced tool — and text is asked again, a fault only twice", async () => {
  const tool = { toolCall: { id: "c1", name: "ping", args: "{}" } };
  const provider = await startFakeProvider([tool, { text: "pong" }, tool, { text: "pong" }, { text: "pong" }]);
  try {
    const models = modelsFor(
      { provider: { id: "vllm", api: "openai-completions", baseUrl: `${provider.url}/v1` } },
      { JR2_PROVIDER_API_KEY: "jr2-held-JR2_PROVIDER_API_KEY" },
    );
    assert.deepEqual(await probeModel(models, "vllm/Qwen/Qwen3-32B"), { kind: "ok" });
    const call = provider.calls[0] as unknown as Record<string, unknown>;
    assert.equal(call.model, "Qwen/Qwen3-32B");
    assert.equal("tool_choice" in call, false, "auto, as a Turn: a forced tool would pass a vLLM no Turn can use");
    assert.equal(provider.calls[0]!.headers?.authorization, "Bearer jr2-held-JR2_PROVIDER_API_KEY");
    // A Turn gets a nudge after text: the check asks once more, the same call.
    assert.deepEqual(await probeModel(models, "vllm/Qwen/Qwen3-32B"), { kind: "ok" }, "text, then a tool call");
    const twice = await probeModel(models, "vllm/Qwen/Qwen3-32B");
    assert.deepEqual(twice, { kind: "fault", reason: 'the answer carried no tool call (stop reason "stop"), twice' });
    assert.equal(provider.calls.length, 5);
    assert.ok(provider.calls.every((c) => !("tool_choice" in (c as unknown as Record<string, unknown>))));
  } finally {
    await provider.close();
  }
});

test("probeModel: a slow first answer passes — the bounds are the first event and the gap, not the total", async () => {
  // An endpoint that waits before its first byte, as an Ollama load does, then streams.
  const slow = await probeAt({ delayMs: 400, then: "tool" }, { firstEventMs: 2000 });
  assert.deepEqual(slow.verdict, { kind: "ok" });
  const slower = await probeAt({ delayMs: 400, then: "tool" }, { firstEventMs: 100 });
  assert.deepEqual(slower.verdict, { kind: "fault", reason: "no answer in 0.1 s" });
});

test("probeModel: a custom model with no limit at all sends none, as its Turns do (unlimitedPayload)", async () => {
  const provider = await startFakeProvider([{ toolCall: { id: "c1", name: "ping", args: "{}" } }]);
  try {
    const models = modelsFor(
      { provider: { id: "local", api: "openai-completions", baseUrl: `${provider.url}/v1` } },
      {},
    );
    assert.deepEqual(await probeModel(models, "local/m"), { kind: "ok" });
    const body = provider.calls[0] as unknown as Record<string, unknown>;
    assert.equal(body.max_completion_tokens ?? body.max_tokens, undefined);
  } finally {
    await provider.close();
  }
});

test("probeModel: an openai-responses provider that refuses the Turn's request fails, whatever its error's form, with one call", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (b: Buffer) => (raw += b));
    req.on("end", () => {
      seen.push(JSON.parse(raw || "{}") as Record<string, unknown>);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "tools are not supported", type: "invalid_request_error" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "x";
  try {
    const models = modelsFor({ catalog: { openai: { baseUrl: url } } }, process.env);
    const model = models
      .getModels("openai")
      .find((m) => m.api === "openai-responses" && getSupportedThinkingLevels(m).includes("off"))!;
    const verdict = await probeModel(models, `openai/${model.id}`, { mayForce: true });
    assert.equal(verdict.kind, "fault");
    assert.match(reason(verdict), /tools are not supported/);
    assert.equal(seen.length, 1);
    assert.equal("tool_choice" in seen[0]!, false);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("FORCED_TOOL: each api's adapter puts the probe's form in the payload it sends", async () => {
  // Where each api's request carries the choice, as pi-ai 1.4 builds it. A pi bump that drops the
  // value on the way fails here, api by api.
  const expected: Record<string, string> = {
    "anthropic-messages": '"tool_choice":{"type":"tool","name":"ping"}',
    "bedrock-converse-stream": '"toolChoice":{"tool":{"name":"ping"}}',
    "openai-completions": '"tool_choice":{"type":"function","function":{"name":"ping"}}',
    "mistral-conversations": '"toolChoice":{"type":"function","function":{"name":"ping"}}',
    "pi-messages": '"toolChoice":{"type":"function","function":{"name":"ping"}}',
    "openai-responses": '"tool_choice":{"type":"function","name":"ping"}',
    "azure-openai-responses": '"tool_choice":{"type":"function","name":"ping"}',
    "google-generative-ai": '"functionCallingConfig":{"mode":"ANY"}',
    "google-vertex": '"functionCallingConfig":{"mode":"ANY"}',
  };
  assert.deepEqual(Object.keys(FORCED_TOOL).sort(), Object.keys(expected).sort());
  const models = modelsFor({}, {});
  for (const [api, form] of Object.entries(expected)) {
    const model = models
      .getModels()
      .find(
        (m) => m.api === api && getSupportedThinkingLevels(m).includes("off") && m.provider !== "cloudflare-ai-gateway",
      );
    assert.ok(model, `a catalog model with off for ${api}`);
    let payload: unknown;
    await models.completeSimple(
      model,
      {
        messages: [{ role: "user", content: "Call the ping tool.", timestamp: Date.now() }],
        tools: [{ name: "ping", description: "p", parameters: { type: "object", properties: {} } as never }],
      },
      {
        apiKey: "x",
        env: { AZURE_OPENAI_BASE_URL: "https://x.openai.azure.com" },
        maxRetries: 0,
        toolChoice: FORCED_TOOL[api] as never,
        onPayload: (p) => {
          payload = p;
          throw new Error("seen");
        },
      },
    );
    assert.ok(
      JSON.stringify(payload).includes(form),
      `${api} (${model.provider}/${model.id}): ${JSON.stringify(payload)}`,
    );
  }
});

test("probeModel: a 429 on a try and then no answer is busy — the fetch sees each try that pi-ai retries", async () => {
  const limited = {
    status: 429,
    headers: { "retry-after": "0" },
    body: { type: "error", error: { type: "rate_limit_error", message: "rate limited" } },
  };
  const { verdict, seen } = await probeAt([limited, "hang"], { firstEventMs: 500 });
  assert.equal(verdict.kind, "busy", JSON.stringify(verdict));
  assert.match(reason(verdict), /HTTP 429, then no answer in 0\.5 s/);
  assert.equal(seen.length, 2, "the 429, then the retry that never answered");
});

test("probeModel: the model's own budget ends every call of it", async () => {
  const budget = new AbortController();
  setTimeout(() => budget.abort(), 200);
  const gateway = await startAnthropicGateway("hang");
  try {
    const models = modelsFor({ catalog: { anthropic: { baseUrl: gateway.url } } }, process.env);
    const verdict = await withKey("x", () => probeModel(models, PROBE_MODEL, { signal: budget.signal }));
    assert.deepEqual(verdict, { kind: "fault", reason: "the model's time ran out" });
  } finally {
    await gateway.close();
  }
});

test("provider-preflight.ts: a config the Harness cannot run is each model's fault, in words, after its start line", async () => {
  const run = promisify(execFile);
  const script = fileURLToPath(new URL("../src/provider-preflight.ts", import.meta.url));
  const env = {
    ...process.env,
    JR2_HARNESS_JSON: JSON.stringify({
      provider: { id: "local", api: "ollama-native", baseUrl: "http://127.0.0.1:9" },
    }),
  };
  const failed = await run(process.execPath, [script, "local/a", "local/b"], { env }).catch(
    (err: { code?: number; stdout?: string }) => err,
  );
  assert.equal((failed as { code?: number }).code, 1);
  const lines = ((failed as { stdout?: string }).stdout ?? "").trim().split("\n");
  assert.deepEqual(
    lines.map((l) => l.split(" ").slice(0, 3).join(" ")),
    [
      "jr2.preflight model=local/a start",
      "jr2.preflight model=local/a fault=the",
      "jr2.preflight model=local/b start",
      "jr2.preflight model=local/b fault=the",
    ],
  );
  assert.match(
    lines[1]!,
    /the Harness cannot run this config: provider "local" names api "ollama-native" — this Harness speaks: openai-completions/,
  );
});

test("probeModel: a 429 on an early try, then a 200 whose answer stops after its first line, is a fault — the last try decides", async () => {
  const limited = {
    status: 429,
    headers: { "retry-after": "0" },
    body: { type: "error", error: { type: "rate_limit_error", message: "rate limited" } },
  };
  // The retry is answered 200, and the answer stops after its first line.
  const { verdict } = await probeAt([limited, "stall"], { firstEventMs: 300 });
  assert.deepEqual(verdict, { kind: "fault", reason: "no answer in 0.3 s" });
});

test("probeModel: the request of each forced api, and of the custom api, arrives — no adapter refuses the check's options", async () => {
  // One local server for every api: it records what arrives and answers 400. The check's verdict
  // is a fault each time; what this holds is that the request left (pi-ai 1.4's Google adapters
  // refuse a caller's `fetch`, which made every Gemini model a fault before it sent anything).
  const arrived: string[] = [];
  const server = createServer((req, res) => {
    arrived.push(req.url ?? "");
    req.resume();
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "no", type: "invalid_request_error", code: 400 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // No fetch may leave this machine: a fetch to a host that is not the local server is refused.
  // Bedrock's SDK does not use fetch; its endpoint is the local server (harness.catalog), and the
  // env that could send it elsewhere or change its tries (a proxy, a profile) is cleared.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(url)) return Promise.reject(new Error(`blocked: ${href}`));
    return realFetch(input, init);
  }) as typeof fetch;
  const saved = { ...process.env };
  for (const name of Object.keys(MODEL_KEYS)) process.env[name] = "x";
  // Bedrock's SDK speaks HTTP/2 unless told otherwise; the local server is HTTP/1.
  Object.assign(process.env, {
    AWS_ACCESS_KEY_ID: "AKIAX",
    AWS_SECRET_ACCESS_KEY: "x",
    AWS_REGION: "us-east-1",
    AWS_BEDROCK_FORCE_HTTP1: "1",
  });
  for (const name of LEAKY_ENV) delete process.env[name];
  try {
    const plain = modelsFor({}, {});
    for (const api of [...Object.keys(FORCED_TOOL), "openai-completions (custom)"]) {
      const custom = api.endsWith("(custom)");
      const model = custom
        ? undefined
        : plain
            .getModels()
            .find(
              (m) =>
                m.api === api &&
                getSupportedThinkingLevels(m).includes("off") &&
                m.provider !== "cloudflare-ai-gateway",
            );
      const spec = custom
        ? { provider: { id: "local", api: "openai-completions", baseUrl: `${url}/v1` } }
        : { catalog: { [model!.provider]: { baseUrl: api === "openai-responses" ? `${url}/v1` : url } } };
      const before = arrived.length;
      const models = modelsFor(spec, process.env);
      const verdict = await probeModel(models, custom ? "local/m" : `${model!.provider}/${model!.id}`, {
        firstEventMs: 3000,
        gapMs: 3000,
      });
      assert.ok(arrived.length > before, `${api}: no request arrived (${JSON.stringify(verdict)})`);
      assert.ok(
        !/Custom fetch is not supported|blocked:/.test(JSON.stringify(verdict)),
        `${api}: ${JSON.stringify(verdict)}`,
      );
    }
  } finally {
    globalThis.fetch = realFetch;
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("probeModel: Bedrock's tries are seen through onResponse — a throttled try, then no answer, is busy", async () => {
  let n = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (++n > 1) return; // The retry is never answered.
    res.writeHead(429, { "content-type": "application/json", "x-amzn-errortype": "ThrottlingException" });
    res.end(JSON.stringify({ message: "Too many requests" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const saved = { ...process.env };
  Object.assign(process.env, {
    AWS_ACCESS_KEY_ID: "AKIAX",
    AWS_SECRET_ACCESS_KEY: "x",
    AWS_REGION: "us-east-1",
    AWS_BEDROCK_FORCE_HTTP1: "1",
  });
  for (const name of LEAKY_ENV) delete process.env[name];
  try {
    const plain = modelsFor({}, {});
    const model = plain.getModels("amazon-bedrock").find((m) => m.api === "bedrock-converse-stream")!;
    const models = modelsFor({ catalog: { "amazon-bedrock": { baseUrl: url } } }, process.env);
    const verdict = await probeModel(models, `amazon-bedrock/${model.id}`, { firstEventMs: 3000 });
    assert.equal(verdict.kind, "busy", JSON.stringify(verdict));
    assert.ok(n >= 2, "the throttled try, then the retry");
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("probeModel: when the model's time runs out during the forced call, the warning does not claim what the forced call said", async () => {
  const gateway = await startAnthropicGateway([{ delayMs: 50, then: "text" }, "hang"]);
  try {
    const models = modelsFor({ catalog: { anthropic: { baseUrl: gateway.url } } }, process.env);
    const verdict = await withKey("x", () =>
      probeModel(models, PROBE_MODEL, { mayForce: true, signal: AbortSignal.timeout(400) }),
    );
    assert.equal(verdict.kind, "warn");
    assert.match(reason(verdict), /the model's time ran out before a forced call could answer/);
    assert.doesNotMatch(reason(verdict), /forced either/);
  } finally {
    await gateway.close();
  }
});
