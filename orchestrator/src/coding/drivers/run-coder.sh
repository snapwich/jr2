#!/usr/bin/env bash
# Coder-Actor tier of the PoC #8 mock↔real swap, executed against a real Harness
# + vLLM (host-side, exactly like PoC #5). Builds/starts the Harness with the
# control-plane-speaking `worker` Agent overlay, then runs coder.driver.ts, which
# wires the coding template with the REAL coder Actor (`makeRealAgent`) and mocks
# for everything else.
#
#   orchestrator/src/coding/drivers/run-coder.sh
#
# The control plane runs on a FIXED port so the Harness can be told
# CONTROL_MCP_BASE at start while the Actor attaches lazily at first prompt.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
HARNESS="$ROOT/harness"
ORCH="$ROOT/orchestrator"
OVERLAY="$ROOT/poc/actor/overlay/worker.ts" # reuse the PoC #5 control-plane agent
PORT="${PORT:-8092}"                        # harness
CP_PORT="${CP_PORT:-8391}"                  # control-plane (MCP ingress)
VLLM_BASE_URL="${VLLM_BASE_URL:-https://vllm.cluster.home/v1}"
MODEL="${CODER_MODEL:-vllm/Qwen/Qwen3-Coder-Next-FP8}"
WT="$(mktemp -d)"
PIDS=()

note() { printf '\033[2m%s\033[0m\n' "$*"; }
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  fuser -k "$PORT/tcp" 2>/dev/null || true
  rm -f "$HARNESS/src/agents/worker.ts"
  rm -rf "$WT"
}
trap cleanup EXIT

[ -e "$ORCH/node_modules" ] || { echo "run pnpm install first" >&2; exit 1; }

cp "$OVERLAY" "$HARNESS/src/agents/worker.ts"
( cd "$HARNESS" && pnpm build >/dev/null 2>&1 ) && note "built harness (overlay: worker)"

fuser -k "$PORT/tcp" 2>/dev/null || true; sleep 1
( cd "$HARNESS" && env WORKTREE_DIR="$WT" PORT="$PORT" VLLM_BASE_URL="$VLLM_BASE_URL" CODER_MODEL="$MODEL" \
    CONTROL_MCP_BASE="http://127.0.0.1:$CP_PORT/mcp" \
    node dist/server.mjs >"$WT/harness.log" 2>&1 ) &
PIDS+=($!)
for _ in $(seq 1 40); do
  curl -s -o /dev/null -m 2 "http://localhost:$PORT/agents/worker/_ping?wait=result" \
    -d '{"message":"hi"}' -H 'content-type: application/json' && break || sleep 1
done
note "harness up on :$PORT ($(tail -1 "$WT/harness.log"))"

cd "$ORCH" && env BASE="http://localhost:$PORT" CP_PORT="$CP_PORT" WORKTREE_DIR="$WT" \
  node src/coding/drivers/coder.driver.ts

# Evidence: the worker Agent attached the control tools and drove them.
note "--- harness control-plane activity ---"
grep -E "worker|mcp__control__|control tools" "$WT/harness.log" | tail -20 || true
