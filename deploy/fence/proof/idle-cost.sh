#!/usr/bin/env bash
# The idle cost of one proof Custodian pod (ADR-0084), for the M1 report. A test fixture; it goes with
# deploy/fence/proof/ in M16.
#
#   KUBECONFIG=features/.tmp/kubeconfig-jr2 deploy/fence/proof/idle-cost.sh [out] [cluster]
#
# In the namespace fence-idle (range 2, on <cluster>-worker only) it runs the Custodian with 0, 3 and 20 live slots.
# For each one it waits 30 s, then reads `crictl stats` on the node every 10 s for 5 minutes, and writes the
# working-set memory (MiB) and the CPU time of each container; the summary gives the mean and the maximum of the
# memory and of the CPU in millicores over each 10 s interval.
set -euo pipefail
OUT=${1:-features/.tmp/fence-idle-cost.txt}
CLUSTER=${2:-jr2}
: "${KUBECONFIG:?KUBECONFIG must name the kubeconfig file of the cluster}"
HERE=$(cd "$(dirname "$0")" && pwd)
NODE=$CLUSTER-worker
NS=fence-idle
kc() { command kubectl --context "kind-$CLUSTER" "$@"; }

: > "$OUT"
echo "# idle cost of one proof Custodian pod, range 2 (128 VLAN interfaces), node $NODE, $(date -u +%FT%TZ)" >> "$OUT"
for live in "" "3,4,5" "$(seq -s, 3 22)"; do
  n=$( [ -z "$live" ] && echo 0 || echo "$live" | tr ',' '\n' | wc -l )
  node "$HERE/render.mjs" custodian --ns $NS --range 2 --live "$live" --nodes "$NODE" | kc apply -f - >/dev/null
  kc -n $NS rollout restart ds/jr2-custodian >/dev/null
  kc -n $NS rollout status ds/jr2-custodian --timeout=300s >/dev/null
  sleep 30
  pod=$(docker exec "$NODE" crictl pods --namespace $NS --state ready -q | head -1)
  echo "## live slots: $n" >> "$OUT"
  for t in $(seq 1 30); do
    docker exec "$NODE" crictl stats -p "$pod" -o json |
      python3 -c '
import json, sys, time
d = json.load(sys.stdin)
for s in d.get("stats", []):
    if "memory" not in s:  # the exited init container uplink
        continue
    a = s["attributes"]["metadata"]["name"]
    mem = int(s["memory"]["workingSetBytes"]["value"]) / 1048576
    ns = int(s["cpu"]["usageCoreNanoSeconds"]["value"])
    ts = int(s["cpu"]["timestamp"])
    print("sample %s %s mem_mib=%.1f cpu_ns=%d ts=%d" % (sys.argv[1], a, mem, ns, ts))
' "$t" >> "$OUT"
    sleep 10
  done
  python3 - "$OUT" "$n" >> "$OUT" <<'PY'
import re, sys
lines = open(sys.argv[1]).read().split("## live slots: " + sys.argv[2] + "\n")[-1].splitlines()
by = {}
for l in lines:
    m = re.match(r"sample \d+ (\S+) mem_mib=([\d.]+) cpu_ns=(\d+) ts=(\d+)", l)
    if m:
        by.setdefault(m[1], []).append((float(m[2]), int(m[3]), int(m[4])))
tm = tc = 0
for c, v in sorted(by.items()):
    mem = [x for x, _, _ in v]
    # CPU in millicores over each 10 s interval: the delta of the CPU time over the delta of the clock.
    cpu = [(b[1] - a[1]) / (b[2] - a[2]) * 1000 for a, b in zip(v, v[1:]) if b[2] > a[2]]
    tm += sum(mem) / len(mem); tc += sum(cpu) / len(cpu)
    print("summary live=%s %s mem_mib mean=%.1f max=%.1f cpu_m mean=%.2f max=%.2f n=%d" % (
        sys.argv[2], c, sum(mem) / len(mem), max(mem), sum(cpu) / len(cpu), max(cpu), len(v)))
print("summary live=%s pod mem_mib mean=%.1f cpu_m mean=%.2f" % (sys.argv[2], tm, tc))
PY
done
kc delete namespace $NS --wait=false >/dev/null
grep '^summary' "$OUT"
