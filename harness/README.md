# @j2/harness

The **Sandbox image** (server side). A flue [Harness](../CONTEXT.md) hosting the [Agents](../CONTEXT.md) that run inside
a Sandbox.

At runtime this is a long-running flue server (`dist/server.mjs`) that the Orchestrator's Actors drive via a flue
client. Each Agent in `src/agents/` is served at `POST /agents/<name>/<id>` (and `GET` for the event stream).

## Layout

- `src/app.ts` — flue entry (Hono app). Registers the model backend as a Provider via `registerProvider(...)`.
- `src/agents/<name>.ts` — Agent definitions (`defineAgent`). An Agent is HTTP-addressable only if it also
  `export const route` (see `coder.ts`).
- `flue.config.ts` — `target: 'node'`; `flue build` emits `dist/server.mjs`.
- `Dockerfile` — builds the Sandbox image (built from the **repo root** context for the shared tsconfig base).

## Build & run

Requires Node ≥ 22.18 (flue CLI). The agent's model backend is an OpenAI-compatible endpoint (e.g. vLLM).

```sh
pnpm build                  # flue build -> dist/server.mjs
WORKTREE_DIR=/path/to/wt \
VLLM_BASE_URL=https://vllm.cluster.home/v1 \
  pnpm start                # node dist/server.mjs

curl -X POST 'localhost:8080/agents/coder/run1?wait=result' \
  -H 'Content-Type: application/json' -d '{"message":"..."}'
```

### Environment

| Var                   | Default                          | Purpose                                            |
| --------------------- | -------------------------------- | -------------------------------------------------- |
| `VLLM_BASE_URL`       | `https://vllm.cluster.home/v1`   | OpenAI-compatible model backend                    |
| `VLLM_API_KEY`        | `vllm`                           | backend API key                                    |
| `CODER_MODEL`         | `vllm/Qwen/Qwen3-Coder-Next-FP8` | `coder` Agent model specifier                      |
| `WORKTREE_DIR`        | `/workspace`                     | working dir the Agent's `local()` tools operate on |
| `PORT`                | `8080`                           | HTTP listen port                                   |
| `NODE_EXTRA_CA_CERTS` | (image: `/etc/ssl/vllm/ca.pem`)  | trust a private CA for the backend's TLS           |

## PoC #3 validation (summary)

The sidecar model holds. The Harness builds to a real long-running server, runs as a non-root sidecar beside a worktree,
is reachable at `POST /agents/coder/<id>`, and its Agent edits the worktree through a filesystem tool — with the edit
visible from the co-located sandbox container (proving shared-volume co-location), driven by a shared remote vLLM.

Latency (qualitative): warm trivial completion ~0.4 s; read+edit-a-file round-trip ~3.5–4 s; cold first request ~17–21 s
(vLLM model load, not the sidecar). File I/O against the local worktree is negligible — the point of co-locating the
loop with the worktree.

Deferred to PoC #4: resumable streams by `dispatchId`, mid-run steering/approval, runtime Agent-config limits.

The sidecar deployment + repro script live on disk under `poc/sidecar/` (gitignored validation artifacts, not part of a
clean checkout).
