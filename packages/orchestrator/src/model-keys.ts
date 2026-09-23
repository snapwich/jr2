// The known model keys (ADR-0059): every env var pi's catalog reads a provider's credential from,
// the catalog provider(s) that read it, and the one host those providers' calls go to by default.
//
// A COPY of pi's data at the exact pin `@jr2/harness` holds, because this package has no pi
// dependency and must not grow one: `jr2 up` reads this table host-side (R1, and the default
// `hosts` of a held secret), and the in-cluster Orchestrator never touches pi. The copy cannot
// drift silently — `@jr2/harness`'s `model-keys.test.ts` checks it against pi itself, env names per
// provider and every provider's default host, in the default gate. A pi bump that adds or moves a
// provider fails there first, the same canary role Harness conformance plays (ADR-0027).
//
// `host` is present only when every model of every provider that reads the name goes to ONE static
// host. It is absent when there is none: the base URL is a template (`{location}`, an account id),
// the providers disagree (MOONSHOT_API_KEY serves two regions), or the host is regional (Bedrock).
// A held secret with such a name must then say its `hosts` itself (§3.4 of the spec, R5).

/** One known model-key env name. */
export type ModelKey = {
  /** The catalog provider ids that read this name. */
  providers: readonly string[];
  /** The host (port 443) those providers' calls go to by default, when there is exactly one. */
  host?: string;
};

export const MODEL_KEYS: Readonly<Record<string, ModelKey>> = {
  // anthropic reads three names. AUTH_TOKEN goes as `Authorization: Bearer`, the other two as
  // `x-api-key` (an `sk-ant-oat` value is an OAuth token, which a Stand-in never is).
  ANTHROPIC_API_KEY: { providers: ["anthropic"], host: "api.anthropic.com" },
  ANTHROPIC_AUTH_TOKEN: { providers: ["anthropic"], host: "api.anthropic.com" },
  ANTHROPIC_OAUTH_TOKEN: { providers: ["anthropic"], host: "api.anthropic.com" },
  OPENAI_API_KEY: { providers: ["openai"], host: "api.openai.com" },
  GEMINI_API_KEY: { providers: ["google"], host: "generativelanguage.googleapis.com" },
  // `https://{location}-aiplatform.googleapis.com` — regional, so no default.
  GOOGLE_CLOUD_API_KEY: { providers: ["google-vertex"] },
  COPILOT_GITHUB_TOKEN: { providers: ["github-copilot"], host: "api.individual.githubcopilot.com" },
  // The bearer form of Bedrock auth. Regional, so no default. (SigV4 credentials cannot be held at
  // all — a signature is not a header a Stand-in can be swapped into — and `jr2 up` warns on them.)
  AWS_BEARER_TOKEN_BEDROCK: { providers: ["amazon-bedrock"] },
  ANT_LING_API_KEY: { providers: ["ant-ling"], host: "api.ant-ling.com" },
  QWEN_TOKEN_PLAN_API_KEY: {
    providers: ["qwen-token-plan"],
    host: "token-plan.ap-southeast-1.maas.aliyuncs.com",
  },
  QWEN_TOKEN_PLAN_CN_API_KEY: { providers: ["qwen-token-plan-cn"], host: "token-plan.cn-beijing.maas.aliyuncs.com" },
  // The catalog names no base URL: an Azure deployment is the user's own resource.
  AZURE_OPENAI_API_KEY: { providers: ["azure-openai-responses"] },
  NVIDIA_API_KEY: { providers: ["nvidia"], host: "integrate.api.nvidia.com" },
  DEEPSEEK_API_KEY: { providers: ["deepseek"], host: "api.deepseek.com" },
  GROQ_API_KEY: { providers: ["groq"], host: "api.groq.com" },
  CEREBRAS_API_KEY: { providers: ["cerebras"], host: "api.cerebras.ai" },
  XAI_API_KEY: { providers: ["xai"], host: "api.x.ai" },
  // pi reads the name, and its catalog lists no model for the provider at this pin.
  RADIUS_API_KEY: { providers: ["radius"] },
  OPENROUTER_API_KEY: { providers: ["openrouter"], host: "openrouter.ai" },
  AI_GATEWAY_API_KEY: { providers: ["vercel-ai-gateway"], host: "ai-gateway.vercel.sh" },
  ZAI_API_KEY: { providers: ["zai"], host: "api.z.ai" },
  ZAI_CODING_CN_API_KEY: { providers: ["zai-coding-cn"], host: "open.bigmodel.cn" },
  MISTRAL_API_KEY: { providers: ["mistral"], host: "api.mistral.ai" },
  MINIMAX_API_KEY: { providers: ["minimax"], host: "api.minimax.io" },
  MINIMAX_CN_API_KEY: { providers: ["minimax-cn"], host: "api.minimaxi.com" },
  // Two providers, two hosts (`.ai` and `.cn`): no single default.
  MOONSHOT_API_KEY: { providers: ["moonshotai", "moonshotai-cn"] },
  HF_TOKEN: { providers: ["huggingface"], host: "router.huggingface.co" },
  FIREWORKS_API_KEY: { providers: ["fireworks"], host: "api.fireworks.ai" },
  TOGETHER_API_KEY: { providers: ["together"], host: "api.together.ai" },
  // Two providers, one host.
  OPENCODE_API_KEY: { providers: ["opencode", "opencode-go"], host: "opencode.ai" },
  KIMI_API_KEY: { providers: ["kimi-coding"], host: "api.kimi.com" },
  // Account-templated base URLs.
  CLOUDFLARE_API_KEY: { providers: ["cloudflare-workers-ai", "cloudflare-ai-gateway"] },
  XIAOMI_API_KEY: { providers: ["xiaomi"], host: "api.xiaomimimo.com" },
  XIAOMI_TOKEN_PLAN_CN_API_KEY: { providers: ["xiaomi-token-plan-cn"], host: "token-plan-cn.xiaomimimo.com" },
  XIAOMI_TOKEN_PLAN_AMS_API_KEY: { providers: ["xiaomi-token-plan-ams"], host: "token-plan-ams.xiaomimimo.com" },
  XIAOMI_TOKEN_PLAN_SGP_API_KEY: { providers: ["xiaomi-token-plan-sgp"], host: "token-plan-sgp.xiaomimimo.com" },
};

/** Every catalog provider id some known model key belongs to — the set `harness.catalog` may name. */
export const MODEL_KEY_PROVIDERS: ReadonlySet<string> = new Set(
  Object.values(MODEL_KEYS).flatMap((key) => key.providers),
);

/**
 * Credentials that sign a request instead of riding it in a header (ADR-0059). A Stand-in cannot be
 * swapped into a signature, so these cannot be held — `jr2 up` warns when `harness.env` sets one,
 * because the Agent can read it, and names a gateway as the way out.
 */
export const SIGNING_CREDENTIALS: readonly string[] = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
];
