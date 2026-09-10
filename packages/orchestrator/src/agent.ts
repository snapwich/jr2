// The Agent definition (ADR-0018/0027): the part of an Agent a user genuinely owns — model +
// instructions + workspace access — as SERIALIZABLE DATA. Everything mechanical (the Adapter
// leash, the Working-tool assembly, the wire) lives in the stock Harness image (`@j2/harness`),
// which runs the definition it is handed and re-reads it per Submission.
//
// A definition is NOT an Instance roster entry: a Machine CARRIES it as an actor slot —
// `j2Setup({ actors: { coder: agent(def) } })`, invoked as `src: "coder"` (ADR-0049) — so the
// Agent's name is the slot key and its scope is that one Machine. Two Machines in one run may
// both carry a `coder`; neither can see the other's.
//
// This module is the plain-data contract plus the slot BRAND (`isAgent` — the readable
// `definition` property `agent()` stamps on the logic). The brand lives HERE, apart from the
// logic that carries it, so `j2Setup`'s menu derivation can recognize an Agent slot without
// pulling the wire client onto its load path.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverModules } from "./instance.ts";

/** j2's reasoning-effort scale (ADR-0027) — a strict subset of the runtime's, so every value
 * passes through unmapped; mirrored by `@j2/harness`'s spec contract. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** What an Agent may DO to the Workspace (ADR-0028) — and, through `"none"`, where its Turn runs
 * (ADR-0031): the value the Agent actor reads off its own slot's definition to place the Turn. */
export type WorkspaceAccess = "write" | "read" | "none";

/** The plain-data Agent definition (ADR-0018). Must stay JSON-serializable: the definition rides
 * the Turn to the Harness (ADR-0049), so anything non-serializable would be silently lost — grow
 * this contract deliberately. ADR-0028 added a restriction vocabulary (`workspace`), not an
 * extension one: custom tool implementations stay out of the contract. */
export type AgentDefinition = {
  /** Model specifier, `<provider>/<modelId>`, e.g. `anthropic/claude-sonnet-4-6`. REQUIRED —
   * there is no instance-wide default (ADR-0018): `j2.config.ts`'s `harness` section
   * declares which providers are REACHABLE, and the definition makes the choice. This is also the
   * only model `j2 up` can preflight, since a workflow's is not statically recoverable. An
   * invocation may override it for one Turn (`AgentTurnInput.model`). */
  model: string;
  /** The Agent's system prompt. */
  instructions: string;
  /** Optional static description — observability, never sent to the model. */
  description?: string;
  /** Working directory inside the Sandbox. Default `/work` — the pod volume the attach step put
   * the worktrees on (ADR-0005); override only for non-Workspace layouts. */
  cwd?: string;
  /** Reasoning effort. Omitted → the runtime's default. An invocation may override it for one
   * Turn (`AgentTurnInput.thinkingLevel`) — effort is a property of the task's difficulty, so the
   * same persona legitimately runs at different settings in different Machines. */
  thinkingLevel?: ThinkingLevel;
  /** What this Agent may DO to the Workspace (ADR-0028) — the persona in one word, deliberately
   * not `tools` (that names the control-plane Menu, what it may SAY). `"read"` withholds the
   * write/edit Working tools; bash stays, so this states intent and stops the honest path — the
   * detached review worktree is the containment. `"none"` withholds the ENTIRE Working toolset:
   * the Menu-only Agent converses and picks from its Menu, nothing else (`cwd` is moot — only
   * Working tools consume it) — and places the Turn on the Instance Harness (ADR-0031).
   * Default `"write"`. */
  workspace?: WorkspaceAccess;
};

/** The brand `agent(definition)` stamps on its logic (ADR-0049): the definition itself, readable
 * off the logic object. Everything that must recognize an Agent slot reads THIS — never a name
 * convention and never a roster. */
export type AgentSlot = { definition: AgentDefinition };

/**
 * Is this actor logic an Agent slot? What `j2Setup` asks of every `actors` entry an invoke names,
 * to decide whether the invoke gets a derived Menu, a minted instance id, and its slot key as the
 * Agent name (ADR-0049) — replacing the retired `src === "agentRun"` test.
 *
 * Duck-typed on the brand, not an instanceof: a `.provide()`-substituted fake (the unit-test seam)
 * is deliberately NOT an Agent slot — the wrapping already happened at createMachine time, against
 * the declared slot.
 */
export function isAgent(logic: unknown): logic is AgentSlot {
  if (typeof logic !== "object" || logic === null) return false;
  const definition = (logic as { definition?: unknown }).definition;
  if (typeof definition !== "object" || definition === null) return false;
  const { model, instructions } = definition as Partial<AgentDefinition>;
  return typeof model === "string" && typeof instructions === "string";
}

/** A discovered instance Agent: filename stem = Agent name (the `:name` in the Harness wire's
 * routes — ADR-0027).
 *
 * TEMPORARY (ADR-0049): the `agents/` folder is retired, and a Machine carries its Agents. What
 * keeps this alive for now is the deployed Harness, which still resolves a definition from the
 * `J2_AGENTS_JSON` roster `j2 up` writes; the step that puts the definition on the Turn deletes
 * this function, its callers, and the folder with it. */
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
    if (!definition?.instructions || !definition.model) {
      throw new Error(
        `agent "${name}" (${file}) is not a definition — the contract (ADR-0018) is ` +
          "`export default { model, instructions, … } satisfies AgentDefinition`, and BOTH are " +
          "required (there is no instance-wide model default)",
      );
    }
    agents.push({ name, definition });
  }
  return agents;
}
