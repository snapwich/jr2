import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  git: {
    // The credentials that the cluster uses to clone and push. The token comes from JR2_GIT_TOKEN in .env.
    credentials: [{ match: "*", token: "JR2_GIT_TOKEN", sshKey: "jr2-git-ssh" }],
  },
  harness: {
    // An OpenAI-compatible endpoint, such as vLLM or llama.cpp. An Agent names its model as local/<model>.
    provider: {
      id: "local",
      api: "openai-completions",
      // An address that a pod can reach, from .env. With no apiKey, plain http:// is permitted.
      baseUrl: process.env.LOCAL_MODEL_URL ?? "",
      // The key is the name that the endpoint gives for GET /v1/models. The limits agree with the server.
      models: { "qwen3.6-35b-a3b": { contextWindow: 65536, maxTokens: 8192 } },
    },
  },
});
