import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  // The instance's identity (ADR-0019): its kube namespace and every label `jr2 up` writes. Stated
  // rather than defaulted, because the default is this FOLDER's name — and the folder is `instance`,
  // a sibling of the talk's `slides/`, which would make the namespace `instance`.
  name: "intro",
  git: {
    // The fence (ADR-0051): a per-run repo url — run input, a ticket field — must match an entry here or the
    // attach refuses it, so nothing can spend this cluster's credential against an arbitrary host. `*` is
    // today's two implicit defaults made visible (JR2_GIT_TOKEN from .env for https, the jr2-git-ssh Secret
    // for ssh). Narrow it to your hosts (`match: "github.com/yourorg/"`) before anything untrusted can start
    // a run. The longest match wins; the url's scheme picks token vs sshKey.
    // The toy repo `npm run seed` serves in-cluster over plain http: admitted, and spent no credential on.
    credentials: [{ match: "*", token: "JR2_GIT_TOKEN", sshKey: "jr2-git-ssh" }, { match: "seed.intro-seed.svc/" }],
  },
  // The model provider (ADR-0018): an OpenAI-compatible endpoint this instance can REACH. It says
  // nothing about WHICH model to use — an Agent definition names `local/<model>` and resolves its
  // limits from the map below.
  harness: {
    provider: {
      id: "local",
      api: "openai-completions",
      // Deployment-varying, so it rides `.env` (ADR-0019) — the address is a fact about THIS
      // machine, not about the instance.
      baseUrl: process.env.JR2_PROVIDER_URL ?? "",
      // The endpoint binds 0.0.0.0 — the cluster dials IN, so loopback was never available — which
      // puts it on the LAN. This is the fence. `jr2 up` materializes the value into the instance's
      // Secret and the ConfigMap'd harness config carries the provider MINUS this (ADR-0018/0019).
      apiKey: process.env.JR2_PROVIDER_API_KEY,
      // Committed, not deployment-varying: a CUSTOM provider id has no catalog entry, so unset
      // limits resolve to 0 and Compaction is left with no context budget. The key is the model id
      // AFTER the `local/` prefix — exactly what `GET /v1/models` serves. `contextWindow` must
      // match llama-server's `-c` — `npm run llama` in this folder starts exactly that endpoint.
      models: { "qwen3.6-35b-a3b": { contextWindow: 65_536, maxTokens: 4096 } },
    },
  },
  // Where Sandboxes land (ADR-0052): by default wherever an ordinary pod lands — not cordoned, no taint — and
  // the Repo cache agent follows the same set. No node label is needed. To admit a tainted pool or narrow to
  // a labeled one, name it in raw pod-spec shapes; `jr2 up` reports the Sandbox nodes it sees.
  // sandbox: { nodeSelector: { pool: "agents" }, tolerations: [{ key: "gpu", operator: "Exists" }] },
});
