// The stock Harness image's entrypoint (ADR-0018). At pod start it:
//   1. reads the instance's Agent definitions + harness config from J2_AGENTS_JSON (the
//      `j2-agents` ConfigMap, injected by the Sandbox spec — a ConfigMap update + pod restart
//      is how definition edits arrive; no image build anywhere);
//   2. writes one generated flue module per definition (only agent NAMES are frozen at the boot
//      build — the shim bodies read model/instructions/cwd back off the spec at runtime, flue
//      initializers re-run per submission), plus src/app.ts when a custom provider is configured;
//   3. runs `flue build --target node` (~0.5 s, fully offline — deps are baked in the image;
//      its stderr goes straight to the pod log: duplicate/zero agent names fail HERE, loudly);
//   4. execs the built server (dist/server.mjs) — binding :8080 is the pod's Ready signal.
//
// Dependency-free plain JS: this file IS the image's PID 1 logic, and it is unit-tested from the
// orchestrator package (`test/harness-boot.test.ts`) — the codegen is pure data in → files out.

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The mounted spec → the generated flue modules. Throws (loudly, into the pod log) on anything
 * that would otherwise become a silently thinner or mute Harness.
 *
 * spec: { agents: [{ name, definition: { instructions, model?, description?, cwd?,
 *         thinkingLevel? } }], harness?: { model?, provider?: { id, api, baseUrl,
 *         contextWindow?, maxTokens?, models? } } }
 */
export function assemble(spec) {
  const agents = spec?.agents ?? [];
  if (agents.length === 0) {
    throw new Error("no Agent definitions in the mounted spec — nothing to assemble (ADR-0018)");
  }
  for (const a of agents) {
    if (!a?.name || !a.definition?.instructions) {
      throw new Error(`agent "${a?.name ?? "?"}" is not a definition — { instructions, … } required (ADR-0018)`);
    }
    if (!a.definition.model && !spec.harness?.model) {
      throw new Error(
        `agent "${a.name}" names no model and the instance sets no harness.model default — ` +
          "set one of them (ADR-0018)",
      );
    }
  }

  const files = agents.map((a) => ({ path: `src/agents/${a.name}.ts`, content: agentShim(a) }));
  if (spec.harness?.provider) files.push({ path: "src/app.ts", content: appShim(spec.harness.provider) });
  return files;
}

/** One generated flue agent module: the j2 mechanism around a definition it looks up at runtime. */
function agentShim(agent) {
  const name = JSON.stringify(agent.name);
  const description = agent.definition.description
    ? `\nexport const description = ${JSON.stringify(agent.definition.description)};\n`
    : "";
  return `// GENERATED at pod start by the stock Harness image (ADR-0018) — never edited, never baked.
// Only this agent's NAME is frozen by the boot build; everything else (model, instructions, cwd,
// thinking) is read back off the mounted spec per submission, so a ConfigMap update + pod restart
// is a full definition change.
//
// The j2 leash (ADR-0013): the Agent's ONLY control-plane peer is the Adapter on localhost. Each
// initialization connects an MCP client to \`\${J2_ADAPTER_URL}/mcp/<id>\` — the initializer re-runs
// per submission and \`id\` IS the flue instance id, so the menu it fetches is exactly what the
// invoking Machine state derived for this turn (ADR-0015). Tools surface to the model as
// \`mcp__j2__<name>\` (flue prefixes by connection name).

import {
  connectMcpServer,
  defineAgent as defineFlueAgent,
  type AgentRouteHandler,
  type McpServerConnection,
} from "@flue/runtime";
import { local } from "@flue/runtime/node";
${description}
// Expose over HTTP so the orchestrator can address this agent. The pod is the trust boundary
// (only the orchestrator can reach the Harness port), so the route admits without extra auth.
export const route: AgentRouteHandler = async (_c, next) => next();

/** The mounted spec, re-read per submission — the runtime seat of the definition. */
function definition(): { model: string; instructions: string; cwd: string; thinkingLevel?: string } {
  const raw = process.env.J2_AGENTS_JSON;
  if (!raw) throw new Error("no J2_AGENTS_JSON: the Sandbox spec did not mount the agents ConfigMap (ADR-0018)");
  const spec = JSON.parse(raw) as {
    agents: Array<{ name: string; definition: Record<string, string | undefined> }>;
    harness?: { model?: string };
  };
  const def = spec.agents.find((a) => a.name === ${name})?.definition;
  if (!def) throw new Error(\`agent ${name} is not in the mounted spec — the pod predates a definition rename?\`);
  const model = def.model ?? spec.harness?.model;
  if (!model) throw new Error(\`agent ${name} resolves no model (neither definition.model nor harness.model)\`);
  return { model, instructions: def.instructions ?? "", cwd: def.cwd ?? "/work", thinkingLevel: def.thinkingLevel };
}

// flue re-runs the initializer per submission and offers no disposal hook, so each new connection
// retires the previous one — bounding the leak to ONE open connection instead of one per turn.
let previous: McpServerConnection | undefined;

export default defineFlueAgent(async ({ id }) => {
  const adapter = process.env.J2_ADAPTER_URL;
  if (!adapter) {
    throw new Error("no J2_ADAPTER_URL: this Agent has no Adapter to reach, so it cannot drive its Machine (ADR-0013)");
  }
  // Minted iids are hierarchical (slashes — ADR-0015); the Adapter's route is ONE path segment,
  // so the id travels encoded, exactly like the Adapter's own orchestrator client sends it on.
  const j2 = await connectMcpServer("j2", { url: \`\${adapter}/mcp/\${encodeURIComponent(id)}\` });
  void previous?.close().catch(() => {});
  previous = j2;
  const def = definition();
  return {
    model: def.model,
    instructions: def.instructions,
    ...(def.thinkingLevel ? { thinkingLevel: def.thinkingLevel } : {}),
    tools: j2.tools,
    sandbox: local(),
    cwd: def.cwd,
  };
});
`;
}

/** src/app.ts: register the instance's custom provider (ADR-0018) before mounting flue's routes.
 * The API key rides the instance Secret as env — never the ConfigMap'd spec. Token limits
 * (contextWindow/maxTokens, provider-level and per-model) pass through when the spec carries
 * them: a custom id has no flue catalog entry, so unset limits resolve to 0 — harmless on the
 * wire (0 maxTokens is omitted) but auto-compaction is left without a context budget. */
function appShim(provider) {
  const limits = ["contextWindow", "maxTokens", "models"]
    .filter((k) => provider[k] !== undefined)
    .map((k) => `\n  ${k}: ${JSON.stringify(provider[k])},`)
    .join("");
  return `// GENERATED at pod start by the stock Harness image (ADR-0018) — registers the instance's
// custom model provider (j2.config.ts \`harness.provider\`) so model specifiers like
// "${provider.id}/<model>" resolve. The endpoint must be reachable FROM PODS (never localhost).

import { registerProvider } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

registerProvider(${JSON.stringify(provider.id)}, {
  api: ${JSON.stringify(provider.api)},
  baseUrl: ${JSON.stringify(provider.baseUrl)},${limits}
  // The wire library refuses a keyless HTTP provider outright ("No API key for provider"), so an
  // unauthenticated endpoint (vLLM/Ollama ignore the Authorization header) gets the placeholder
  // it expects — j2's \`apiKey\` stays genuinely optional, and a real key still rides the Secret.
  apiKey: process.env.J2_PROVIDER_API_KEY || "unused",
});

const app = new Hono();
app.route("/", flue());

export default app;
`;
}

/** Pod boot: assemble → flue build → exec the server. Fatal errors land in the pod log. */
async function main() {
  const raw = process.env.J2_AGENTS_JSON;
  if (!raw) {
    throw new Error("no J2_AGENTS_JSON in the environment — the Sandbox spec must inject the agents ConfigMap");
  }
  const appDir = process.cwd();
  const files = assemble(JSON.parse(raw));

  await rm(join(appDir, "src"), { recursive: true, force: true });
  for (const f of files) {
    await mkdir(join(appDir, dirname(f.path)), { recursive: true });
    await writeFile(join(appDir, f.path), f.content);
  }
  console.log(`j2 harness boot: assembled ${files.length} module(s); running flue build`);

  await run("npx", ["flue", "build", "--target", "node"], appDir);

  const server = spawn("node", ["dist/server.mjs"], { cwd: appDir, stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.kill(sig));
  server.on("exit", (code, signal) => process.exit(signal ? 0 : (code ?? 1)));
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" }); // stderr → pod logs, by design
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`j2 harness boot FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
