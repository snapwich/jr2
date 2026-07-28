// Agent definitions (ADR-0018/0027): the instance's `agents/<name>.ts` surface, mirroring
// `workflows/`. A definition is the part of an Agent a user genuinely owns — model + instructions
// + access — as SERIALIZABLE DATA. Everything mechanical (the Adapter leash, the Working-tool
// assembly, the wire) lives in the stock Harness image (`@j2/harness`), which runs definitions
// directly: `j2 up` publishes them as ConfigMap JSON and the Harness re-reads them per Submission.
//
// `defineAgent` is an identity passthrough like `defineConfig` beside it in this package: it
// exists solely so `agents/<name>.ts` gets full type inference against `AgentDefinition`.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverModules } from "./instance.ts";

/** j2's reasoning-effort scale (ADR-0027) — a strict subset of the runtime's, so every value
 * passes through unmapped; mirrored by `@j2/harness`'s spec contract. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** The plain-data Agent definition (ADR-0018). Must stay JSON-serializable: definitions travel to
 * pods as ConfigMap JSON (`j2 up` → the Harness's `J2_AGENTS_JSON`, re-read per Submission), so
 * anything non-serializable would be silently lost — grow this contract deliberately. ADR-0028
 * added a restriction vocabulary (`access`), not an extension one: custom tool implementations
 * stay out of the contract. */
export type AgentDefinition = {
  /** Model specifier, `<provider>/<modelId>`, e.g. `anthropic/claude-sonnet-4-6`. Optional:
   * `harness.model` in `j2.config.ts` is the instance-wide default (ADR-0018); an assembly with
   * neither fails. */
  model?: string;
  /** The Agent's system prompt. */
  instructions: string;
  /** Optional static description — observability, never sent to the model. */
  description?: string;
  /** Working directory inside the Sandbox. Default `/work` — the pod volume the attach step put
   * the worktrees on (ADR-0005); override only for non-Workspace layouts. */
  cwd?: string;
  /** Reasoning effort. Omitted → the runtime's default. */
  thinkingLevel?: ThinkingLevel;
  /** What this Agent may DO to the Workspace (ADR-0028) — the persona in one word, deliberately
   * not `tools` (that names the control-plane Menu, what it may SAY). `"read"` withholds the
   * write/edit Working tools; bash stays, so this states intent and stops the honest path — the
   * detached review worktree is the containment. Default `"write"`. */
  access?: "write" | "read";
};

/** Identity passthrough that pins a definition's type to `AgentDefinition` for inference. */
export function defineAgent(def: AgentDefinition): AgentDefinition {
  return def;
}

/** A discovered instance Agent: filename stem = Agent name (the `:name` in the Harness wire's
 * routes — ADR-0027). */
export type DiscoveredAgent = { name: string; definition: AgentDefinition };

/**
 * Discover + load `<dir>/agents/*.ts` (the same filename convention as workflow discovery —
 * `discoverModules`). Absent dir → empty (an instance without Agents is fine); a file that fails
 * to import or lacks a default export throws — a broken definition must be loud, never a silently
 * thinner Harness.
 */
export async function loadAgents(dir: string): Promise<DiscoveredAgent[]> {
  const agents: DiscoveredAgent[] = [];
  for (const { name, file } of await discoverModules(join(dir, "agents"))) {
    const mod = (await import(pathToFileURL(file).href)) as { default?: AgentDefinition };
    const definition = mod.default;
    if (!definition?.instructions) {
      throw new Error(
        `agent "${name}" (${file}) is not a definition — the contract (ADR-0018) is ` +
          "`export default defineAgent({ model, instructions, … })`",
      );
    }
    agents.push({ name, definition });
  }
  return agents;
}
