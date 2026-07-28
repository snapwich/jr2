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
  /** Model specifier, `<provider>/<modelId>`. Optional: `harness.model` is the instance default. */
  model?: string;
  /** The Agent's system prompt. */
  instructions: string;
  /** Optional static description — observability, never sent to the model. */
  description?: string;
  /** Working directory inside the Sandbox. Default `/work` (ADR-0005). */
  cwd?: string;
  /** Reasoning effort. Omitted → the runtime's default. */
  thinkingLevel?: ThinkingLevel;
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

/** The harness section: instance-wide model default + optional custom provider. */
export type HarnessSpec = {
  model?: string;
  provider?: ProviderSpec;
};

/** The whole mounted spec — what `j2 up` writes into the `j2-agents` ConfigMap. */
export type AgentsSpec = {
  agents: Array<{ name: string; definition: AgentDefinition }>;
  harness?: HarnessSpec;
};

/** One definition with its per-Submission resolution applied: the model default and the `/work`
 * cwd default are resolved here, so a turn works from concrete values. */
export type ResolvedDefinition = {
  model: string;
  instructions: string;
  cwd: string;
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

  const agents = spec?.agents ?? [];
  if (agents.length === 0) {
    throw new Error("no Agent definitions in the mounted spec — nothing to serve (ADR-0018)");
  }
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
    if (!a.definition.model && !spec.harness?.model) {
      throw new Error(
        `agent "${a.name}" names no model and the instance sets no harness.model default — ` +
          "set one of them (ADR-0018)",
      );
    }
  }
  return spec;
}

/** One Agent's definition off a loaded spec, defaults applied — the per-Submission read
 * (model/instructions/cwd/thinkingLevel resolve when the turn starts, ADR-0027). */
export function resolveDefinition(spec: AgentsSpec, name: string): ResolvedDefinition {
  const def = spec.agents.find((a) => a.name === name)?.definition;
  if (!def) {
    throw new Error(`agent "${name}" is not in the mounted spec — the pod predates a definition rename? (ADR-0018)`);
  }
  const model = def.model ?? spec.harness?.model;
  if (!model) {
    throw new Error(`agent "${name}" resolves no model (neither definition.model nor harness.model)`);
  }
  return {
    model,
    instructions: def.instructions,
    cwd: def.cwd ?? "/work",
    ...(def.thinkingLevel ? { thinkingLevel: def.thinkingLevel } : {}),
  };
}
