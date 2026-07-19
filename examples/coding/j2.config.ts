// Instance config (ADR-0009/0019). Its presence at the folder root is what marks this directory
// as a j2 instance — the `j2` CLI walks up from cwd to find it.
//
// `name` is the instance's identity: `j2 up` converges the current kube context into the `coding`
// namespace (`-n` overrides) and labels everything it owns. Everything deployment-varying resolves
// from env — populate the uncommitted `.env` beside this file (see README); the `j2` CLI loads it
// before evaluating this config, and anything already set in your shell wins over it.
//
// `sandbox` is pod-shaped only (ADR-0018); model concerns live in `harness`:
//   - VLLM_BASE_URL set → a custom `vllm` provider (OpenAI-compatible; the address must be
//     reachable FROM PODS — a LAN address, never localhost). `j2 up` preflights it from inside
//     the cluster, including one tool-call completion.
//   - J2_MODEL is the instance-wide default model (e.g. `vllm/Qwen/Qwen3-32B` or
//     `anthropic/claude-sonnet-4-6`); the agents/ definitions omit `model` and inherit it.
//   - For Anthropic instead of vLLM: create the `anthropic` kube Secret and reference it in
//     `harness.envFrom` (`kubectl -n coding create secret generic anthropic
//     --from-literal=ANTHROPIC_API_KEY=...`) — `j2 up` preflights that it exists.
//
// The image overrides are kit-dev territory (nothing is published yet — ADR-0019): locally built
// tags, `kind load`ed by `just harness-image-stock` / `just adapter-image` / `just e2e-kind-up`'s
// operator build. Delete them once the published `<kitversion>` images exist.

import { defineConfig } from "@j2/orchestrator";

const vllm = process.env.VLLM_BASE_URL;

export default defineConfig({
  name: "coding",
  repos: [{ name: "obsidian-tasks.nvim", url: "https://github.com/snapwich/obsidian-tasks.nvim.git" }],
  sandbox: {
    image: "j2-harness:local",
    adapterImage: "j2-adapter:local",
  },
  operator: { image: "j2-operator:local" },
  harness: {
    model: process.env.J2_MODEL,
    // The endpoint's cert chains to a private CA (committed here — CA certs are public data).
    // `j2 up` materializes it into the j2-ca ConfigMap; the Harness container and the provider
    // preflight trust it via NODE_EXTRA_CA_CERTS (ADR-0020).
    caBundle: "ca.crt",
    provider: vllm
      ? {
          id: "vllm",
          api: "openai-completions",
          baseUrl: vllm,
          // Committed, not env: token limits are properties of the MODEL (vLLM reports
          // max_model_len on /v1/models), keyed by id — whichever model J2_MODEL or an agent
          // definition names resolves its own entry. Unset would resolve to 0 (custom ids have
          // no flue catalog entry), leaving auto-compaction without a context budget.
          models: { "Qwen/Qwen3-Coder-Next-FP8": { contextWindow: 131072, maxTokens: 32768 } },
        }
      : undefined,
  },
});
