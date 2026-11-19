#!/usr/bin/env bash
# Bring up the M1 proof of the Fence (ADR-0084) on a kind cluster that `just fence-kind-up` made.
#
#   KUBECONFIG=features/.tmp/kubeconfig-jr2 deploy/fence/proof/up.sh [cluster]
#
# Instance A (namespace fence-proof-a, range 0) and Instance B (fence-proof-b, range 1), each with a Custodian pod
# on both workers. Sandboxes of A: slot 3 on jr2-worker, slot 4 on jr2-worker2,
# slot 5 on jr2-worker, slot 6 on jr2-worker with an HTTP probe (it must not become Ready), slot 7 on jr2-worker
# with the window probe. Sandbox of B: slot 3 on jr2-worker. Deleting the two namespaces deletes the objects that this
# script applies. These stay: the image jr2-fence-proof:1 on the host and on each node, and the range Leases
# jr2-fence-range-0 and jr2-fence-range-1 in jr2-system, which this script does not make and which hold ranges 0 and 1
# for the proof Instances.
set -euo pipefail
CLUSTER=${1:-jr2}
: "${KUBECONFIG:?KUBECONFIG must name the kubeconfig file of the cluster}"
HERE=$(cd "$(dirname "$0")" && pwd)
kc() { command kubectl --context "kind-$CLUSTER" "$@"; }
R() { node "$HERE/render.mjs" "$@"; }

docker build -q -t jr2-fence-proof:1 "$HERE" >/dev/null
kind load docker-image jr2-fence-proof:1 --name "$CLUSTER" >/dev/null
API_IP=$(kc get node "$CLUSTER-control-plane" -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')
W1=$CLUSTER-worker
W2=$CLUSTER-worker2

R custodian --ns fence-proof-a --range 0 --live 3,4,5,6,7 --nodes "$W1,$W2" | kc apply -f - >/dev/null
R custodian --ns fence-proof-b --range 1 --live 3 --nodes "$W1,$W2" | kc apply -f - >/dev/null
for ns in fence-proof-a fence-proof-b; do kc -n "$ns" rollout status ds/jr2-custodian --timeout=300s; done

{
  R sandbox --ns fence-proof-a --range 0 --slot 3 --node "$W1"
  echo ---
  R sandbox --ns fence-proof-a --range 0 --slot 4 --node "$W2"
  echo ---
  R sandbox --ns fence-proof-a --range 0 --slot 5 --node "$W1"
  echo ---
  R sandbox --ns fence-proof-a --range 0 --slot 6 --node "$W1" --http-probe
  echo ---
  R sandbox --ns fence-proof-a --range 0 --slot 7 --node "$W1" --window --api-ip "$API_IP"
  echo ---
  R sandbox --ns fence-proof-b --range 1 --slot 3 --node "$W1"
} | kc apply -f - >/dev/null
kc -n fence-proof-a wait --for=condition=Ready pod/sbx-3 pod/sbx-4 pod/sbx-5 pod/sbx-7 --timeout=300s
kc -n fence-proof-b wait --for=condition=Ready pod/sbx-3 --timeout=300s
kc get pods -n fence-proof-a -o wide
kc get pods -n fence-proof-b -o wide
