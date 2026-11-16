#!/usr/bin/env bash
# The Fence's node prerequisites on a kind cluster (ADR-0084). Run by `just fence-node-prep`. Nothing here is per pod
# or per Instance: it is done once for each node, and a second run changes nothing.
#
#   node-prep.sh <cluster> [segment]        segment: the Fence's IPv4 prefix, default 198.19.0.0/20
#
# KUBECONFIG must name the cluster's own kubeconfig file (the recipe sets it). For each node of the cluster:
#   1. the stock CNI plugins bridge, static and tuning, v1.10.0, from the release tarball, checked by sha256;
#   2. the bridge jr2fence0: vlan_filtering 1, vlan_default_pvid 0, no VLAN on the bridge itself, no address, IPv6
#      off, arp_ignore 8. An access port gets only its VLAN. A vlanTrunk port still gets VID 1 (PVID, untagged) from
#      the stock bridge plugin v1.10.0, also with preserveDefaultVlan false in its NAD (seen in M1);
#   3. the rule set, one table inet jr2_fence: frames bridged on jr2fence0 skip the node's conntrack (so no NAT of the
#      node changes them), and nothing from jr2fence0 reaches the node's own stack or is routed off the bridge;
#   4. the route: unreachable <segment>, so the node never sends a packet to the segment on its default route.
# Then Multus v4.3.2 thick (vendored, with namespaceIsolation) for the cluster.
set -euo pipefail

CLUSTER=${1:?usage: node-prep.sh <cluster> [segment]}
SEGMENT=${2:-198.19.0.0/20}
: "${KUBECONFIG:?KUBECONFIG must name the kubeconfig file of the cluster}"
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
BRIDGE=jr2fence0
TABLE=jr2_fence
CNI_VERSION=v1.10.0
PLUGINS="bridge static tuning"
DL="$ROOT/features/.tmp/fence-dl"

if ! [[ $SEGMENT =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]]; then
  echo "node-prep: the segment must be an IPv4 prefix such as 198.19.0.0/20, not '$SEGMENT'" >&2
  exit 2
fi
if [ "$(command kubectl config current-context)" != "kind-$CLUSTER" ]; then
  echo "node-prep: KUBECONFIG ($KUBECONFIG) does not select kind-$CLUSTER" >&2
  exit 2
fi
kc() { command kubectl --context "kind-$CLUSTER" "$@"; }

NODES=$(kind get nodes --name "$CLUSTER")
[ -n "$NODES" ] || { echo "node-prep: kind cluster '$CLUSTER' has no nodes" >&2; exit 2; }

# The tarball of one architecture, downloaded once and checked against cni-plugins.sha256.
tarball() {
  local arch=$1 name="cni-plugins-linux-$1-$CNI_VERSION.tgz" want
  want=$(awk -v n="$name" '$2 == n { print $1 }' "$HERE/cni-plugins.sha256")
  [ -n "$want" ] || { echo "node-prep: no sha256 for $name in cni-plugins.sha256" >&2; exit 1; }
  mkdir -p "$DL"
  if ! echo "$want  $DL/$name" | sha256sum -c --status 2>/dev/null; then
    curl -fsSL -o "$DL/$name.part" "https://github.com/containernetworking/plugins/releases/download/$CNI_VERSION/$name"
    echo "$want  $DL/$name.part" | sha256sum -c --status || { echo "node-prep: $name: sha256 does not match" >&2; exit 1; }
    mv "$DL/$name.part" "$DL/$name"
  fi
  if [ ! -d "$DL/$arch" ]; then
    mkdir -p "$DL/$arch.part"
    # shellcheck disable=SC2086
    tar -C "$DL/$arch.part" -xzf "$DL/$name" $(for p in $PLUGINS; do echo "./$p"; done)
    mv "$DL/$arch.part" "$DL/$arch"
  fi
  echo "$DL/$arch"
}

# The rule set. Its comment carries a hash of its own text, so a run can see that the loaded table is this one.
ruleset() {
  local body
  body=$(cat <<NFT
  chain pre {
    type filter hook prerouting priority -350; policy accept;
    iifname "$BRIDGE" counter notrack
  }
  chain input {
    type filter hook input priority -200; policy accept;
    iifname "$BRIDGE" counter drop
  }
  chain forward {
    type filter hook forward priority -200; policy accept;
    iifname "$BRIDGE" oifname != "$BRIDGE" counter drop
    iifname != "$BRIDGE" oifname "$BRIDGE" counter drop
  }
  chain out {
    type filter hook output priority -200; policy accept;
    oifname "$BRIDGE" counter drop
  }
NFT
)
  local sum
  sum=$(printf '%s' "$body" | sha256sum | cut -c1-16)
  printf 'table inet %s\ndelete table inet %s\ntable inet %s {\n  comment "jr2 fence rule set %s"\n%s\n}\n' \
    "$TABLE" "$TABLE" "$TABLE" "$sum" "$body"
}
RULES=$(ruleset)
RULES_ID=$(printf '%s\n' "$RULES" | sed -n 's/.*comment "\(jr2 fence rule set [0-9a-f]*\)".*/\1/p')

for node in $NODES; do
  changed=""
  case $(docker exec "$node" uname -m) in
    x86_64) arch=amd64 ;;
    aarch64) arch=arm64 ;;
    *) echo "node-prep: $node: unknown architecture" >&2; exit 1 ;;
  esac
  dir=$(tarball "$arch")
  for p in $PLUGINS; do
    want=$(sha256sum "$dir/$p" | cut -d' ' -f1)
    have=$(docker exec "$node" sh -c "sha256sum /opt/cni/bin/$p 2>/dev/null | cut -d' ' -f1" || true)
    if [ "$want" != "$have" ]; then
      docker cp "$dir/$p" "$node:/opt/cni/bin/$p.jr2-new"
      docker exec "$node" sh -c "chmod 0755 /opt/cni/bin/$p.jr2-new && mv /opt/cni/bin/$p.jr2-new /opt/cni/bin/$p"
      changed="$changed plugin:$p"
    fi
  done

  bridge_out=$(docker exec -i "$node" sh -eu -s "$BRIDGE" <<'SH'
B=$1; out=""
if ! ip link show "$B" >/dev/null 2>&1; then
  ip link add "$B" type bridge vlan_filtering 1 vlan_default_pvid 0
  out="$out bridge:made"
fi
[ "$(cat /sys/class/net/$B/bridge/vlan_filtering)" = 1 ] || { ip link set "$B" type bridge vlan_filtering 1; out="$out vlan_filtering"; }
[ "$(cat /sys/class/net/$B/bridge/default_pvid)" = 0 ] || { ip link set "$B" type bridge vlan_default_pvid 0; out="$out default_pvid"; }
vids=$(bridge -j vlan show dev "$B" | grep -o '"vlan":[0-9]*' | cut -d: -f2 || true)
if [ -n "$vids" ]; then
  for v in $vids; do bridge vlan del dev "$B" vid "$v" self; done
  out="$out bridge-vlans"
fi
[ "$(cat /proc/sys/net/ipv6/conf/$B/disable_ipv6)" = 1 ] || { sysctl -qw "net.ipv6.conf.$B.disable_ipv6=1"; out="$out disable_ipv6"; }
[ "$(cat /proc/sys/net/ipv4/conf/$B/arp_ignore)" = 8 ] || { sysctl -qw "net.ipv4.conf.$B.arp_ignore=8"; out="$out arp_ignore"; }
if ip -4 addr show dev "$B" | grep -q inet; then ip -4 addr flush dev "$B"; out="$out address-flushed"; fi
ip link show "$B" | grep -q ',UP' || { ip link set "$B" up; out="$out up"; }
echo "$out"
SH
)
  changed="$changed$bridge_out"

  # Each listing is read whole before it is matched: with pipefail, grep -q would end the pipe early and fail it.
  loaded=$(docker exec "$node" nft list table inet "$TABLE" 2>/dev/null || true)
  if ! grep -qF "comment \"$RULES_ID\"" <<<"$loaded"; then
    printf '%s\n' "$RULES" | docker exec -i "$node" nft -f -
    changed="$changed rule-set"
  fi

  routes=$(docker exec "$node" ip route show type unreachable | sed 's/ *$//')
  if ! grep -qxF "unreachable $SEGMENT" <<<"$routes"; then
    docker exec "$node" ip route replace unreachable "$SEGMENT"
    changed="$changed route"
  fi

  echo "node-prep: $node:${changed:- unchanged}"
done

kc apply -f "$HERE/multus-v4.3.2.yaml" | sed 's/^/node-prep: multus: /'
kc -n kube-system rollout status ds/kube-multus-ds --timeout=300s | sed 's/^/node-prep: multus: /'
echo "node-prep: done (segment $SEGMENT)"
