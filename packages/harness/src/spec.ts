// What the Harness is HANDED, in two pieces with two lifetimes (ADR-0049).
//
//   - The Agent DEFINITION rides every admission. A Machine carries its Agents as actor slots, so
//     the definition travels with the Turn that runs it (ADR-0049) and the Harness runs what it
//     was handed — re-read per Submission as before, now literally: the queued admission IS the
//     definition. There is no roster here, no `agents/` folder and no `JR2_AGENTS_JSON`: a flat
//     roster could not hold two Machines' `coder`s, and the pod would need a restart to learn a
//     definition the Orchestrator already knows.
//   - The harness CONFIG (`JR2_HARNESS_JSON`) is what this instance can REACH — the custom model
//     provider, and nothing else (ADR-0018). Deployment fact, not a Machine's, so it stays
//     mounted config (ADR-0050) and is read once at boot.
//
// Validation of a definition is per ADMISSION and LOUD: a definition that cannot run is a 400
// naming the slot, never a silently thinner turn. Shapes mirror `@jr2/orchestrator`'s
// `AgentDefinition` and `HarnessConfig` deliberately without importing them — the stock image
// carries no Orchestrator.

/** jr2's reasoning-effort scale (mirrors `@jr2/orchestrator`'s `ThinkingLevel`). A strict subset of
 * pi's — every value passes through to the runtime unmapped. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** The scale as data — what an admission's `thinkingLevel` is checked against before pi ever
 * sees it (`mapThinkingLevel` is the second gate, on the resolved value). */
const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** What an Agent may DO to the Workspace (ADR-0028), as data — same reason. */
const WORKSPACE_ACCESS: readonly string[] = ["write", "read", "none"];

/** The plain-data Agent definition (ADR-0018), as the admission body carries it (ADR-0049). */
export type AgentDefinition = {
  /** Model specifier, `<provider>/<modelId>`. REQUIRED — there is no instance-wide default
   * (ADR-0018): an Agent is independently valid, and this is the only place a model is
   * checkable before a workflow names one. An invocation may override it (see {@link TurnDials}). */
  model: string;
  /** The Agent's system prompt. */
  instructions: string;
  /** Optional static description — observability, never sent to the model. */
  description?: string;
  /** Working directory inside the Sandbox. Default `/work` (ADR-0005). */
  cwd?: string;
  /** Reasoning effort. Omitted → the runtime's default. */
  thinkingLevel?: ThinkingLevel;
  /** What the Agent may DO to the Workspace (ADR-0028): `"read"` withholds write/edit from the
   * Working tools; `"none"` withholds them all — the Menu-only Agent. Default `"write"`. */
  workspace?: "write" | "read" | "none";
};

/** Token limits for one model — properties of the MODEL, not the endpoint. */
export type ProviderModelLimits = { contextWindow?: number; maxTokens?: number };

/** A custom model provider (ADR-0018), as `jr2 up` publishes it — `apiKey` is deliberately absent
 * (it rides the instance Secret as `JR2_PROVIDER_API_KEY` env, never the ConfigMap). */
export type ProviderSpec = {
  /** The provider id model specifiers use (`<id>/<model>`), e.g. `vllm`. */
  id: string;
  /** The wire protocol, e.g. `openai-completions`. */
  api: string;
  /** The endpoint — reachable from pods. */
  baseUrl: string;
  /** Endpoint-wide default token limits, for any model this provider serves. */
  contextWindow?: number;
  maxTokens?: number;
  /** Per-model limits, keyed by the model id AFTER the provider prefix. */
  models?: Record<string, ProviderModelLimits>;
};

/** The harness section: what this instance can REACH. Deliberately no model default — the config
 * declares providers, the definition makes the choice (ADR-0018) — and no Agents at all: they
 * ride the Turn (ADR-0049). */
export type HarnessSpec = {
  provider?: ProviderSpec;
};

/** What a Machine state may set for one Turn on top of the definition (ADR-0018) — the
 * DIALS (how hard to run), never identity (`instructions`/`workspace`/`cwd`, which would make the
 * Agent's name a lie). Rides the admit body per Submission, so one `continue` conversation may
 * queue Submissions at different settings. */
export type TurnDials = {
  model?: string;
  thinkingLevel?: ThinkingLevel;
};

/** One definition with its per-Submission resolution applied: the Submission's dials, the `/work`
 * cwd default, and the `"write"` workspace default (ADR-0028) are resolved here, so a turn works
 * from concrete values. */
export type ResolvedDefinition = {
  model: string;
  instructions: string;
  cwd: string;
  workspace: "write" | "read" | "none";
  thinkingLevel?: ThinkingLevel;
};

/**
 * Why the definition on this admission cannot be run, or undefined when it can — the structural
 * half of the admission check (the model's resolvability is `provider.ts`'s half, which needs the
 * registry). Every message names the SLOT, because that is the name the author wrote and the one
 * the Orchestrator's error will quote back (ADR-0049).
 *
 * This is where the retired boot-time spec validation went: the same claims, made per admission,
 * which is the only moment a definition exists here now.
 */
export function definitionFault(agentName: string, definition: unknown): string | undefined {
  const named = `agent "${agentName}"`;
  if (typeof definition !== "object" || definition === null) {
    return (
      `${named}: the admission carries no definition — the Machine's Agent slot rides the Turn ` +
      `(ADR-0049), so \`definition: { model, instructions, … }\` is required on the admit body`
    );
  }
  const { model, instructions, cwd, description, thinkingLevel, workspace } = definition as Record<string, unknown>;
  if (typeof instructions !== "string" || instructions.length === 0) {
    return `${named}: the definition has no \`instructions\` — an Agent is its model plus its prompt (ADR-0018)`;
  }
  if (typeof model !== "string" || model.length === 0) {
    return `${named}: the definition names no model — a definition must name one, there is no instance-wide default (ADR-0018)`;
  }
  if (cwd !== undefined && typeof cwd !== "string") return `${named}: \`cwd\` must be a path string`;
  if (description !== undefined && typeof description !== "string") {
    return `${named}: \`description\` must be a string`;
  }
  if (thinkingLevel !== undefined && !THINKING_LEVELS.includes(thinkingLevel as string)) {
    return `${named}: thinkingLevel "${String(thinkingLevel)}" is not one of ${THINKING_LEVELS.join("|")}`;
  }
  if (workspace !== undefined && !WORKSPACE_ACCESS.includes(workspace as string)) {
    return `${named}: workspace "${String(workspace)}" is not one of ${WORKSPACE_ACCESS.join("|")} (ADR-0028)`;
  }
  return undefined;
}

/** The definition this Submission runs, defaults applied — the per-Submission read
 * (model/instructions/cwd/thinkingLevel resolve when the turn starts, ADR-0027). `dials` is this
 * Submission's override layer: the definition supplies the default, the invocation may turn it. */
export function resolveDefinition(definition: AgentDefinition, dials?: TurnDials): ResolvedDefinition {
  const model = dials?.model ?? definition.model;
  const thinkingLevel = dials?.thinkingLevel ?? definition.thinkingLevel;
  return {
    model,
    instructions: definition.instructions,
    cwd: definition.cwd ?? "/work",
    workspace: definition.workspace ?? "write",
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

/**
 * Read + validate the mounted harness config from the environment (`JR2_HARNESS_JSON` — the
 * `jr2-harness` ConfigMap, written by `jr2 up`). ABSENT is valid and means "pi's own catalog
 * alone": an instance whose Agents name only built-in models declares no provider, and `jr2 up`
 * writes the key with no `provider` in it. Malformed is not — it throws into the pod log, because
 * a Harness that silently dropped its one reachable endpoint would fail every admission instead.
 */
export function loadHarnessSpec(env: Record<string, string | undefined>): HarnessSpec {
  const raw = env.JR2_HARNESS_JSON;
  if (!raw) return {};
  let spec: HarnessSpec;
  try {
    spec = JSON.parse(raw) as HarnessSpec;
  } catch (err) {
    throw new Error(`JR2_HARNESS_JSON is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof spec !== "object" || spec === null) throw new Error("JR2_HARNESS_JSON is not an object");
  const provider = spec.provider;
  if (provider && (!provider.id || !provider.api || !provider.baseUrl)) {
    throw new Error(
      `JR2_HARNESS_JSON's provider needs { id, api, baseUrl } — got ${JSON.stringify(provider)} (ADR-0018)`,
    );
  }
  return spec;
}
