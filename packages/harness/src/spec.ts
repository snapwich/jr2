// The J2_AGENTS_JSON contract (ADR-0018/0027): the mounted `j2-agents` ConfigMap — instance Agent
// definitions + harness config — as the Harness reads it. Re-read per Submission, so a ConfigMap
// update + pod restart is a full definition change; validation is LOUD (into the pod log), never a
// silently thinner or mute Harness. Shapes mirror `@j2/orchestrator`'s `AgentDefinition` and
// `HarnessConfig` deliberately without importing them — the stock image carries no Orchestrator.

/** j2's reasoning-effort scale (mirrors `@j2/orchestrator`'s `ThinkingLevel`). A strict subset of
 * pi's — every value passes through to the runtime unmapped. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** The plain-data Agent definition (ADR-0018), as published to the ConfigMap. */
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

/** A custom model provider (ADR-0018), as `j2 up` publishes it — `apiKey` is deliberately absent
 * (it rides the instance Secret as `J2_PROVIDER_API_KEY` env, never the ConfigMap). */
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
 * declares providers, the definition makes the choice (ADR-0018). */
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

/** The whole mounted spec — what `j2 up` writes into the `j2-agents` ConfigMap. */
export type AgentsSpec = {
  agents: Array<{ name: string; definition: AgentDefinition }>;
  harness?: HarnessSpec;
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
 * Read + validate the mounted spec from the environment. Throws (loudly, into the pod log) on
 * anything that would otherwise become a silently thinner or mute Harness — the same checks the
 * retired boot assembly made (ADR-0018), plus duplicate names, whose only previous check was the
 * boot-time flue build (ADR-0027 deleted it).
 */
export function loadSpec(env: Record<string, string | undefined>): AgentsSpec {
  const raw = env.J2_AGENTS_JSON;
  if (!raw) {
    throw new Error(
      "no J2_AGENTS_JSON in the environment — the Sandbox spec must inject the agents ConfigMap (ADR-0018)",
    );
  }
  let spec: AgentsSpec;
  try {
    spec = JSON.parse(raw) as AgentsSpec;
  } catch (err) {
    throw new Error(`J2_AGENTS_JSON is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  // An EMPTY roster is valid (ADR-0018): a workflow that invokes no Agent — a `workspace()` body
  // parking a Sandbox (ADR-0012) — still needs a serving Harness (binding :8080 is the pod's Ready
  // signal), just no definitions. Any `agentRun` against it 404s at admission.
  const agents = spec?.agents ?? [];
  const seen = new Set<string>();
  for (const a of agents) {
    if (!a?.name || !a.definition?.instructions) {
      throw new Error(`agent "${a?.name ?? "?"}" is not a definition — { instructions, … } required (ADR-0018)`);
    }
    if (seen.has(a.name)) {
      throw new Error(
        `agent "${a.name}" is defined twice in the mounted spec — names are conversation routes (ADR-0027)`,
      );
    }
    seen.add(a.name);
    if (!a.definition.model) {
      throw new Error(
        `agent "${a.name}" names no model — a definition must name one, there is no instance-wide ` +
          "default (ADR-0018)",
      );
    }
  }
  // Normalized: a spec with no `agents` key serves as the empty roster, so callers never null-check.
  return { ...spec, agents };
}

/** One Agent's definition off a loaded spec, defaults applied — the per-Submission read
 * (model/instructions/cwd/thinkingLevel resolve when the turn starts, ADR-0027). `dials` is this
 * Submission's override layer: the definition supplies the default, the invocation may turn it. */
export function resolveDefinition(spec: AgentsSpec, name: string, dials?: TurnDials): ResolvedDefinition {
  const def = spec.agents.find((a) => a.name === name)?.definition;
  if (!def) {
    throw new Error(`agent "${name}" is not in the mounted spec — the pod predates a definition rename? (ADR-0018)`);
  }
  const model = dials?.model ?? def.model;
  const thinkingLevel = dials?.thinkingLevel ?? def.thinkingLevel;
  return {
    model,
    instructions: def.instructions,
    cwd: def.cwd ?? "/work",
    workspace: def.workspace ?? "write",
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}
