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

// ADR-0023: the Harness prints its own conversation to stdout, and `kubectl logs` reads it.
const shimOf = (name = "coder") =>
  assemble({ agents: [coder], harness: { model: "vllm/q" } }).find((f) => f.path === `src/agents/${name}.ts`)!.content;

test("shim: subscribes to its own conversation over localhost, labelled [agent] [iid] (ADR-0023)", () => {
  const shim = shimOf();
  assert.match(shim, /^const AGENT = "coder";$/m, "the name is frozen at the boot build — no lookup");
  assert.match(shim, /agents\.observe\(AGENT, id\b/, "observe() is keyed by that name and the per-submission iid");
  assert.match(shim, /127\.0\.0\.1|localhost/, "the shim reads its OWN flue server, in its own container");
  assert.match(shim, /console\.log\(`\[\$\{AGENT\}\] \$\{line\}`\)/, "conversation lines carry the Agent name only");
  assert.ok(
    !/console\.log\(`\[\$\{AGENT\}\] \[\$\{id\}\]/.test(shim),
    "the iid is NOT on every line — `<runId>/<path>/<agent>/<suffix>` swamps the content it labels",
  );
  assert.match(shim, /console\.error\(`\[\$\{AGENT\}\] \[\$\{id\}\]/, "diagnostics keep it: rare, and they need addressing");
});

test("shim: one subscription per Agent, retired like the MCP connection — but not re-opened per submission", () => {
  const shim = shimOf();
  assert.match(
    shim,
    /^let watching/m,
    "module-scope, like `previous` — the initializer re-runs and offers no disposal hook",
  );
  assert.match(shim, /\.close\(\)/, "the retired subscription is closed");
  assert.match(
    shim,
    /watching\?\.id === id/,
    "an unchanged iid REUSES the watch: observe() replays history, so re-subscribing per submission would re-print it",
  );
});

test("shim: an absent conversation is chased — the watch opens BEFORE the conversation exists", () => {
  const shim = shimOf();
  assert.match(shim, /phase !== "absent"/, "absent is the 404 park, and it is terminal until refreshed");
  assert.match(shim, /conversation\.refresh\(\)/, "so the shim refreshes until it materializes");
  assert.match(shim, /phase === "error"/, "a stream error is surfaced, not swallowed");
});

test("shim: tool inputs are truncated — truncation is load-bearing against kubelet's 10Mi rotation", () => {
  const shim = shimOf();
  assert.match(shim, /slice\(0, 100\)/, "Bash capped at 100 chars (jr's filter)");
  assert.match(shim, /slice\(0, 150\)/, "unknown tools capped at 150");
  assert.match(shim, /file_path/, "Write/Edit/Read reduce to the path");
});

test("shim: tool RESULTS never print — a boundary (ADR-0023, ADR-0014), not an unfinished implementation", () => {
  const shim = shimOf();
  const printer = shim.slice(shim.indexOf("function renderPart"), shim.indexOf("export default"));
  assert.ok(printer.length > 0, "the printer is in the generated shim");
  assert.ok(!/part\.output|part\.errorText/.test(printer), "the printer never reads a tool part's output");
  assert.match(shim, /ADR-0023/, "the boundary is attributed, so nobody 'completes' it later");
});

test("shim: no ANSI — the writer structures, the reader colorizes", () => {
  const shim = shimOf();
  assert.ok(!shim.includes(String.fromCharCode(27)), "escape codes are corruption in a piped log");
  assert.ok(!/\\u001b|\\x1b/.test(shim), "nor as an escape sequence the shim would emit");
});
