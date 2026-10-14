// The Agent definition (ADR-0018/0027): the part of an Agent a user genuinely owns — model +
// instructions + workspace access — as SERIALIZABLE DATA. Everything mechanical (the Menu,
// the Working-tool assembly, the wire) lives in the stock Harness image (`@jr2/harness`),
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

// jr2's reasoning-effort scale (ADR-0027) — a strict subset of the runtime's, so every value
// passes through unmapped; mirrored by `@jr2/harness`'s spec contract.
/**
 * How hard the model thinks before it answers: `"off"`, `"minimal"`, `"low"`, `"medium"`,
 * `"high"` or `"xhigh"`. Set it on an Agent's definition (`thinkingLevel`), or for one Turn in the
 * invoke's `input`.
 *
 * A model can lack a level. Claude Sonnet 5.5 has no `"off"`, and at `"off"` the Harness's request
 * then sends effort `"high"`. The Harness does not refuse such a level: it runs the Turn, and the
 * printed conversation names the level that the model ran at.
 *
 * @example
 * ```ts
 * import { agent, type ThinkingLevel } from "@jr2/orchestrator";
 *
 * const effort: ThinkingLevel = "high";
 *
 * export const reviewer = agent({
 *   model: "anthropic/claude-sonnet-5-5",
 *   instructions: "You review diffs for correctness.",
 *   thinkingLevel: effort,
 * });
 * ```
 *
 * @see docs/guides/set-an-agents-access-and-dials.md
 * @see docs/reference/decisions/0018-instance-agents-are-definitions-jr2-assembles-the-harness.md
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// The value the Agent actor reads off its own slot's definition to place the Turn (ADR-0028,
// ADR-0031).
/** What an Agent may do to the Workspace: `"write"`, `"read"` or `"none"`. With `"none"`, its Turn
 * runs on the Instance Harness, not in a Sandbox. The `workspace` field of {@link AgentDefinition}
 * tells what each value gives. */
export type WorkspaceAccess = "write" | "read" | "none";

// The plain-data Agent definition (ADR-0018): IDENTITY plus one default. A Turn's Frame — what it
// is about and where it works — is not here and cannot be (ADR-0057): a Worktree path exists only
// once a run has a branch, so no definition written before the run could name one.
//
// Must stay JSON-serializable: the definition rides the Turn to the Harness (ADR-0049), so
// anything non-serializable would be silently lost — grow this contract deliberately. ADR-0028
// added a restriction vocabulary (`workspace`), not an extension one: custom tool implementations
// stay out of the contract.
/**
 * An Agent's definition: which model it runs, its instructions, and what it may do to the
 * Workspace. Give it to `agent()` to get the Agent's actor slot. It is plain data that can be
 * written as JSON.
 *
 * It holds who the Agent is, not what one Turn does. The prompt of a Turn and the directory it
 * works in are the Frame. The state that invokes the Agent sets the Frame in the invoke's
 * `input`. That `input` can also set `model` and `thinkingLevel` for one Turn: the Dials. It
 * cannot change `instructions` or `workspace`.
 *
 * @example
 * ```ts
 * import { agent, type AgentDefinition } from "@jr2/orchestrator";
 *
 * const definition: AgentDefinition = {
 *   model: "anthropic/claude-sonnet-5-5",
 *   instructions: "You fix the failing test, and you change nothing else.",
 *   description: "Fixes one failing test",
 *   thinkingLevel: "medium",
 *   workspace: "write",
 * };
 *
 * export const coder = agent(definition);
 * ```
 *
 * @see docs/concepts/agents-and-turns.md
 * @see docs/guides/set-an-agents-access-and-dials.md
 * @see docs/reference/decisions/0018-instance-agents-are-definitions-jr2-assembles-the-harness.md
 * @see docs/reference/decisions/0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md
 */
export type AgentDefinition = {
  // REQUIRED, with no instance-wide default (ADR-0018): `jr2.config.ts`'s `harness` section
  // declares which providers are REACHABLE, and the definition makes the choice. This is also the
  // only model `jr2 up` can preflight, since a workflow's is not statically recoverable. An
  // invocation may override it for one Turn (`AgentTurnInput.model`).
  /** The model, as `<provider>/<modelId>`: for example `anthropic/claude-sonnet-5-5`. The
   * provider must be one that `jr2.config.ts` can reach. Here it is always a string: an `open`
   * model of `agent()` must be bound before a Turn starts. One Turn may set another model in the
   * invoke's `input`. */
  model: string;
  /** The Agent's instructions: the text that tells the model who it is and how to work. The same
   * on every Turn. */
  instructions: string;
  /** A short description, for people who read the Machine. The model never reads it. */
  description?: string;
  // Effort is a property of the task's difficulty, so the same persona legitimately runs at
  // different settings in different Machines; an invocation may override it for one Turn
  // (`AgentTurnInput.thinkingLevel`).
  /** How hard the model thinks: one of {@link ThinkingLevel}. Absent: `"off"`. A model with no
   * `"off"` runs at another level, and the printed conversation names it. One Turn may set another
   * level in the invoke's `input`. */
  thinkingLevel?: ThinkingLevel;
  // The persona in one word (ADR-0028), deliberately not `tools` (that names the control-plane
  // Menu, what it may SAY). `"read"` states intent and stops the honest path: bash stays, and the
  // detached review worktree is the containment. `"none"` frames no directory — only Working tools
  // consume one — and places the Turn on the Instance Harness (ADR-0031).
  /** What the Agent may do to the Workspace. Default: `"write"`.
   * - `"write"`: all the Working tools (read, write, edit, bash, grep, glob).
   * - `"read"`: no write or edit tool. The Agent keeps bash, so `"read"` does not stop a command
   *   that writes. To keep the Agent from changing the branch, frame its Turn in the review
   *   Worktree: `reviewSha` in the spec, then `cwd: context.workspace.review?.<slot>`.
   * - `"none"`: no Working tools. The Agent only reads its prompt and picks from its Menu. Its Turn
   *   runs on the Instance Harness, not in a Sandbox, so it needs no `workspace()` around it. */
  workspace?: WorkspaceAccess;
};

// The Agent as an author DECLARES it (ADR-0054): the definition, except that `model` may be Open —
// the one part a packaged Machine cannot honestly fill, since the package cannot pay for it. Every
// other field is the wire's, because every other field a package CAN state.
//
// This is what `agent()` takes and what the slot's brand carries, so the walk and `customize()`
// read the author's own answer, Open included. Nothing sends this: the wire takes an
// AgentDefinition, and `requireBoundAgent` is the one door between the two.
/** What `agent()` takes: an {@link AgentDefinition}, except that `model` can also be `open`. */
export type AgentDeclaration = Omit<AgentDefinition, "model"> & {
  /** The model, as `<provider>/<modelId>`: for example `anthropic/claude-sonnet-5-5`. Required:
   * there is no default model. The provider must be one that `jr2.config.ts` can reach.
   *
   * Or `open`, in a Machine that you publish as a package. Then the Instance that registers the
   * Machine binds the model with `customize()`. One Turn may set another model in the invoke's
   * `input`. */
  model: string | typeof open;
};

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
