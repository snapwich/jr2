// Instance config (ADR-0009/0019). Its presence at the folder root is what marks this directory
// as a j2 instance — the `j2` CLI walks up from cwd to find it.
//
// `name` is the instance's identity: `j2 up` converges the current kube context into the `coding`
// namespace (`-n` overrides) and labels everything it owns. Everything deployment-varying resolves
// from env — populate the uncommitted `.env` beside this file (see README); the `j2` CLI loads it
// before evaluating this config, and anything already set in your shell wins over it.
//
// `harness` declares what this instance can REACH — never WHICH model to use. That choice lives in
// the Agent definitions the Machines carry (`workflows/_agents.ts` — ADR-0018/0049):
//   - VLLM_BASE_URL set → a custom `vllm` provider (OpenAI-compatible; the address must be
//     reachable FROM PODS — a LAN address, never localhost). `j2 up` preflights it from inside
//     the cluster, probing every model the definitions name against it, including one tool-call
//     completion each.
//   - The model specifiers themselves (`vllm/Qwen/…`, `anthropic/claude-sonnet-4-6`) are in the
//     agent definitions. There is no instance-wide default: one definition may be carried by
//     several Machines, so the variation that matters is per-definition and per-invocation.
//   - For Anthropic instead of vLLM: point the definitions' `model` at `anthropic/…`, create the
//     `anthropic` kube Secret, and reference it in `harness.envFrom` (`kubectl -n coding create
//     secret generic anthropic --from-literal=ANTHROPIC_API_KEY=...`) — `j2 up` preflights that
//     it exists. Two committed files instead of one `.env` line: the price of the model being a
//     design decision rather than a deployment one.
//
// No image is named here, by design (ADR-0038): `j2 up` builds every image it deploys and resolves
// every ref itself — the kit three from source when it runs out of a kit checkout, the published
// `<kitversion>` tags otherwise. What the AGENTS' toolchain is lives in `images/default/Dockerfile`
// (ADR-0037), which this instance has because it has `repos`.

import { defineConfig } from "@j2/orchestrator";

const vllm = process.env.VLLM_BASE_URL;

export default defineConfig({
  name: "coding",
  repos: ["https://github.com/snapwich/obsidian-tasks.nvim.git"],
  harness: {
    provider: vllm
      ? {
          id: "vllm",
          api: "openai-completions",
          baseUrl: vllm,
          // Committed, not env: token limits are properties of the MODEL (vLLM reports
          // max_model_len on /v1/models), keyed by id — whichever model an agent definition (or
          // a workflow's per-turn dial) names resolves its own entry. Unset would resolve to 0
          // (custom ids have no catalog entry), leaving auto-compaction without a context budget.
          models: { "Qwen/Qwen3-Coder-Next-FP8": { contextWindow: 131072, maxTokens: 32768 } },
        }
      : undefined,
  },
});
