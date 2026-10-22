// Made from @earendil-works/pi-ai 1.4.0 by `just model-keys` (packages/harness/scripts/model-keys.ts).
// Do not edit: run the recipe at each pi bump. `model-keys.ts` says what the table means (ADR-0059).

import type { ModelKey } from "./model-keys.ts";

export const MODEL_KEYS: Readonly<Record<string, ModelKey>> = {
  // No default host: the calls go to more than one host: bedrock-runtime.us-east-1.amazonaws.com, bedrock-runtime.eu-central-1.amazonaws.com.
  AWS_BEARER_TOKEN_BEDROCK: { providers: ["amazon-bedrock"] },
  ANT_LING_API_KEY: { providers: ["ant-ling"], host: "api.ant-ling.com" },
  ANTHROPIC_AUTH_TOKEN: { providers: ["anthropic"], host: "api.anthropic.com" },
  ANTHROPIC_OAUTH_TOKEN: { providers: ["anthropic"], host: "api.anthropic.com" },
  ANTHROPIC_API_KEY: { providers: ["anthropic"], host: "api.anthropic.com" },
  // No default host: the catalog names no base URL.
  AZURE_OPENAI_API_KEY: { providers: ["azure"] },
  BASETEN_API_KEY: { providers: ["baseten"], host: "inference.baseten.co" },
  CEREBRAS_API_KEY: { providers: ["cerebras"], host: "api.cerebras.ai" },
  // No default host: a base URL is a template.
  CLOUDFLARE_API_KEY: { providers: ["cloudflare-ai-gateway", "cloudflare-workers-ai"] },
  DEEPSEEK_API_KEY: { providers: ["deepseek"], host: "api.deepseek.com" },
  FIREWORKS_API_KEY: { providers: ["fireworks"], host: "api.fireworks.ai" },
  COPILOT_GITHUB_TOKEN: { providers: ["github-copilot"], host: "api.individual.githubcopilot.com" },
  GEMINI_API_KEY: { providers: ["google"], host: "generativelanguage.googleapis.com" },
  // No default host: a base URL is a template.
  GOOGLE_CLOUD_API_KEY: { providers: ["google-vertex"] },
  GROQ_API_KEY: { providers: ["groq"], host: "api.groq.com" },
  HF_TOKEN: { providers: ["huggingface"], host: "router.huggingface.co" },
  KIMI_API_KEY: { providers: ["kimi-coding"], host: "api.kimi.com" },
  META_API_KEY: { providers: ["meta"], host: "api.meta.ai" },
  MINIMAX_API_KEY: { providers: ["minimax"], host: "api.minimax.io" },
  MINIMAX_CN_API_KEY: { providers: ["minimax-cn"], host: "api.minimaxi.com" },
  MISTRAL_API_KEY: { providers: ["mistral"], host: "api.mistral.ai" },
  // No default host: the calls go to more than one host: api.moonshot.ai, api.moonshot.cn.
  MOONSHOT_API_KEY: { providers: ["moonshotai", "moonshotai-cn"] },
  NVIDIA_API_KEY: { providers: ["nvidia"], host: "integrate.api.nvidia.com" },
  OPENAI_API_KEY: { providers: ["openai"], host: "api.openai.com" },
  OPENCODE_API_KEY: { providers: ["opencode", "opencode-go"], host: "opencode.ai" },
  OPENROUTER_API_KEY: { providers: ["openrouter"], host: "openrouter.ai" },
  QWEN_TOKEN_PLAN_API_KEY: {
    providers: ["qwen-token-plan", "qwen-token-plan-individual"],
    host: "token-plan.ap-southeast-1.maas.aliyuncs.com",
  },
  QWEN_TOKEN_PLAN_CN_API_KEY: { providers: ["qwen-token-plan-cn"], host: "token-plan.cn-beijing.maas.aliyuncs.com" },
  RADIUS_API_KEY: { providers: ["radius"], host: "radius.pi.dev" },
  TOGETHER_API_KEY: { providers: ["together"], host: "api.together.ai" },
  AI_GATEWAY_API_KEY: { providers: ["vercel-ai-gateway"], host: "ai-gateway.vercel.sh" },
  XAI_API_KEY: { providers: ["xai"], host: "api.x.ai" },
  XIAOMI_API_KEY: { providers: ["xiaomi"], host: "api.xiaomimimo.com" },
  XIAOMI_TOKEN_PLAN_AMS_API_KEY: { providers: ["xiaomi-token-plan-ams"], host: "token-plan-ams.xiaomimimo.com" },
  XIAOMI_TOKEN_PLAN_CN_API_KEY: { providers: ["xiaomi-token-plan-cn"], host: "token-plan-cn.xiaomimimo.com" },
  XIAOMI_TOKEN_PLAN_SGP_API_KEY: { providers: ["xiaomi-token-plan-sgp"], host: "token-plan-sgp.xiaomimimo.com" },
  ZAI_API_KEY: { providers: ["zai"], host: "api.z.ai" },
  ZAI_CODING_CN_API_KEY: { providers: ["zai-coding-cn"], host: "open.bigmodel.cn" },
};
