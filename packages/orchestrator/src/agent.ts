// The Agent definition (ADR-0018/0027): the part of an Agent a user genuinely owns — model +
// instructions + workspace access — as SERIALIZABLE DATA. Everything mechanical (the Adapter
// leash, the Working-tool assembly, the wire) lives in the stock Harness image (`@jr2/harness`),
// which runs the definition it is handed and re-reads it per Submission.
//
// A definition is NOT an Instance roster entry: a Machine CARRIES it as an actor slot —
// `jr2Setup({ actors: { coder: agent(def) } })`, invoked as `src: "coder"` (ADR-0049) — so the
// Agent's name is the slot key and its scope is that one Machine. Two Machines in one run may
// both carry a `coder`; neither can see the other's.
//
// This module is the plain-data contract plus the slot BRAND (`isAgent` — the readable
// `definition` property `agent()` stamps on the logic). The brand lives HERE, apart from the
// logic that carries it, so `jr2Setup`'s menu derivation can recognize an Agent slot without
// pulling the wire client onto its load path.
//
// Since ADR-0054 the contract has two halves, and the split is the whole point: `AgentDefinition`
// is the WIRE type — `model: string`, because a Symbol does not ride a Turn — while
// `AgentDeclaration` is what an AUTHOR writes, whose `model` may be Open (open.ts) for a composer
// to bind. `jr2 up` refuses an Open Agent before anything is built; the Agent actor refuses to
// admit a Turn under one, as the second fence. Everything downstream of admission sees a
// definition.

import { open } from "./open.ts";

/** jr2's reasoning-effort scale (ADR-0027) — a strict subset of the runtime's, so every value
 * passes through unmapped; mirrored by `@jr2/harness`'s spec contract. */
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
   * there is no instance-wide default (ADR-0018): `jr2.config.ts`'s `harness` section
   * declares which providers are REACHABLE, and the definition makes the choice. This is also the
   * only model `jr2 up` can preflight, since a workflow's is not statically recoverable. An
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

/**
 * The Agent as an author DECLARES it (ADR-0054): the definition, except that `model` may be Open —
 * the one part a packaged Machine cannot honestly fill, since the package cannot pay for it. Every
 * other field is the wire's, because every other field a package CAN state.
 *
 * This is what `agent()` takes and what the slot's brand carries, so the walk and `customize()`
 * read the author's own answer, Open included. Nothing sends this: the wire takes an
 * {@link AgentDefinition}, and {@link requireBoundAgent} is the one door between the two.
 */
export type AgentDeclaration = Omit<AgentDefinition, "model"> & { model: string | typeof open };

/** The brand `agent(declaration)` stamps on its logic (ADR-0049): the declaration itself, readable
 * off the logic object. Everything that must recognize an Agent slot reads THIS — never a name
 * convention and never a roster. */
export type AgentSlot = { definition: AgentDeclaration };

/**
 * Is this actor logic an Agent slot? What `jr2Setup` asks of every `actors` entry an invoke names,
 * to decide whether the invoke gets a derived Menu, a minted instance id, and its slot key as the
 * Agent name (ADR-0049) — replacing the retired `src === "agentRun"` test.
 *
 * Duck-typed on the brand, not an instanceof: a `.provide()`-substituted fake (the unit-test seam)
 * is deliberately NOT an Agent slot — the wrapping already happened at createMachine time, against
 * the declared slot.
 *
 * An Open model counts (ADR-0054): a Machine whose Agent nobody bound yet is still a Machine that
 * carries an Agent, and the walk that refuses it has to SEE it first — an unrecognized slot would
 * be reported as nothing at all.
 */
export function isAgent(logic: unknown): logic is AgentSlot {
  if (typeof logic !== "object" || logic === null) return false;
  const definition = (logic as { definition?: unknown }).definition;
  if (typeof definition !== "object" || definition === null) return false;
  const { model, instructions } = definition as Partial<AgentDeclaration>;
  return (typeof model === "string" || model === open) && typeof instructions === "string";
}

/** Is this Agent's model still Open — nobody's answer yet (ADR-0054)? What the walk reports and
 * the actor refuses on. */
export function isOpenAgent(declaration: AgentDeclaration): boolean {
  return declaration.model === open;
}

/**
 * The declaration as the wire takes it, or a refusal naming the slot — the SECOND fence
 * (ADR-0054). The first is `jr2 up`'s walk, which refuses an Open Agent on a registered Machine
 * before anything is built; this one catches every path that walk never saw (a Machine invoked as
 * itself in a test, an unregistered import composed mid-run) and it catches it before a Turn is
 * admitted rather than as a Harness 400 with nothing but a slot key in it.
 */
export function requireBoundAgent(slot: string, declaration: AgentDeclaration): AgentDefinition {
  if (typeof declaration.model !== "string") {
    throw new Error(
      `agent "${slot}" has an Open model — nobody bound it; bind it where the Machine is registered ` +
        `(\`customize(<machine>, { agents: { ${slot}: { model: "<provider>/<model>" } } })\`), ` +
        "because a packaged Machine cannot pick a model on your behalf (ADR-0054)",
    );
  }
  return { ...declaration, model: declaration.model };
}
