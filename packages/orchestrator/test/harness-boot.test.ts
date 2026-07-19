// The stock Harness image's boot assembly (ADR-0018): `assemble(spec)` turns the mounted
// agents.json (definitions + harness config) into the generated flue modules the boot build bakes.
// Pure data in → files out, so the whole codegen is testable without flue, docker, or a pod.
// The boot half (flue build + exec server) is subprocess glue, exercised by the @kind tier.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble } from "../harness/boot.mjs";

const coder = { name: "coder", definition: { instructions: "be the coder", model: "anthropic/claude-x" } };

test("assemble: one shim per agent; only the NAME is frozen — the body reads the spec at runtime", () => {
  const files = assemble({
    agents: [coder, { name: "reviewer", definition: { instructions: "review" } }],
    harness: { model: "vllm/q" },
  });
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes("src/agents/coder.ts"));
  assert.ok(paths.includes("src/agents/reviewer.ts"));

  const shim = files.find((f) => f.path === "src/agents/coder.ts")!.content;
  assert.match(shim, /J2_AGENTS_JSON/, "definition data is read from the mounted spec at runtime");
  assert.ok(!shim.includes("be the coder"), "instructions are NOT inlined — edits reach pods without a rebuild");
  assert.match(shim, /"coder"/, "the shim knows its own name");
  assert.match(shim, /connectMcpServer/, "the Adapter leash is in the generated code (ADR-0013)");
  assert.match(
    shim,
    /\/mcp\/\$\{encodeURIComponent\(id\)\}/,
    "the iid travels URL-encoded — minted ids are hierarchical, the Adapter route is one segment",
  );
  assert.match(shim, /local\(\)/, "sandbox geography is mechanism, not user content");
});

test("assemble: an agent with no model and no harness.model default fails loudly", () => {
  assert.throws(() => assemble({ agents: [{ name: "a", definition: { instructions: "i" } }] }), /agent "a".*model/s);
});

test("assemble: a configured provider generates src/app.ts registering it; none → no app.ts", () => {
  const withProvider = assemble({
    agents: [coder],
    harness: { provider: { id: "vllm", api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1" } },
  });
  const app = withProvider.find((f) => f.path === "src/app.ts");
  assert.ok(app, "src/app.ts is generated");
  assert.match(app.content, /registerProvider\("vllm"/);
  assert.match(app.content, /J2_PROVIDER_API_KEY/, "the key comes from env (the Secret), never the spec");

  const without = assemble({ agents: [coder] });
  assert.ok(!without.some((f) => f.path === "src/app.ts"));
});

test("assemble: provider token limits pass through to registerProvider; absent → not emitted", () => {
  const withLimits = assemble({
    agents: [coder],
    harness: {
      provider: {
        id: "vllm",
        api: "openai-completions",
        baseUrl: "http://10.0.0.5:8000/v1",
        contextWindow: 131072,
        maxTokens: 32768,
        models: { "Qwen/Qwen3-32B": { contextWindow: 40960 } },
      },
    },
  });
  const app = withLimits.find((f) => f.path === "src/app.ts")!;
  assert.match(app.content, /contextWindow: 131072/);
  assert.match(app.content, /maxTokens: 32768/);
  assert.match(app.content, /"Qwen\/Qwen3-32B":\{"contextWindow":40960\}/, "per-model limits ride the registration");

  const without = assemble({
    agents: [coder],
    harness: { provider: { id: "vllm", api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1" } },
  });
  const bare = without.find((f) => f.path === "src/app.ts")!;
  assert.ok(!bare.content.includes("contextWindow"), "no limits in the spec → none in the registration");
  assert.ok(!bare.content.includes("models"), "no models map either");
});

test("assemble: refuses an empty agent set (a Sandbox with no Agents is a misconfigured instance)", () => {
  assert.throws(() => assemble({ agents: [] }), /no Agent definitions/);
});
