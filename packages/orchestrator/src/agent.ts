// Agent definitions (ADR-0018): the instance's `agents/<name>.ts` surface, mirroring `workflows/`.
// A definition is the part of an Agent a user genuinely owns — model + instructions — as
// SERIALIZABLE DATA. Everything mechanical (the Adapter leash, `sandbox: local()`, the `route`
// export, the flue dependency pin) lives in the stock Harness image's boot assembly
// (`harness/boot.mjs`), never written by the instance; the instance never imports flue.
//
// `defineAgent` is an identity passthrough like `defineConfig` beside it in this package: it
// exists solely so `agents/<name>.ts` gets full type inference against `AgentDefinition`.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverModules } from "./instance.ts";

/** Flue's reasoning-effort scale, mirrored as literals so the definition stays flue-import-free. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** The plain-data Agent definition (ADR-0018). Must stay JSON-serializable: definitions travel to
 * pods as ConfigMap JSON (`j2 up` → the stock image's boot assembly), so anything non-serializable
 * would be silently lost — grow this contract deliberately (custom tools/skills mean ejecting to a
 * real flue project). */
export type AgentDefinition = {
  /** Flue model specifier, e.g. `anthropic/claude-sonnet-4-6`. Optional: `harness.model` in
   * `j2.config.ts` is the instance-wide default (ADR-0018); an assembly with neither fails. */
  model?: string;
  /** The Agent's system prompt. */
  instructions: string;
  /** Optional static description, surfaced by flue's `listAgents()`. */
  description?: string;
  /** Working directory inside the Sandbox. Default `/work` — the pod volume the attach step put
   * the worktrees on (ADR-0005); override only for non-Workspace layouts. */
  cwd?: string;
  /** Reasoning effort. Flue defaults to `medium` when omitted. */
  thinkingLevel?: ThinkingLevel;
};

/** Identity passthrough that pins a definition's type to `AgentDefinition` for inference. */
export function defineAgent(def: AgentDefinition): AgentDefinition {
  return def;
}

/** A discovered instance Agent: filename stem = Agent name (the `:name` in flue's routes). */
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
