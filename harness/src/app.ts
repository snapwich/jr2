// j2 Harness — the flue server that runs inside a Sandbox and hosts j2 Agents.
//
// At runtime this builds to `dist/server.mjs`, a long-running HTTP server that
// the Orchestrator's Actors drive via a flue client. Each Agent in `src/agents/`
// is served at `POST /agents/<name>/<id>`.

import { registerProvider } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

// Reach the shared model backend over its OpenAI-compatible API. For j2 this is
// a vLLM server (a Provider, in CONTEXT.md terms); the Agent loop is co-located
// with the worktree, the model backend stays shared and remote.
//
// TLS: when the backend uses a private CA (e.g. vllm.cluster.home), make the CA
// trusted by the process via NODE_EXTRA_CA_CERTS — do NOT disable verification.
registerProvider("vllm", {
  api: "openai-completions",
  baseUrl: process.env.VLLM_BASE_URL ?? "https://vllm.cluster.home/v1",
  apiKey: process.env.VLLM_API_KEY ?? "vllm",
});

const app = new Hono();
app.route("/", flue());

export default app;
