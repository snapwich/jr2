#!/bin/sh
# The Fence's node parts on one node of a kind cluster (ADR-0084), except the CNI plugins and Multus. `jr2 up` runs it
# at each converge on a kind cluster, in each node container, as `docker exec -i <node> flock <lock> sh -s` with this
# text on stdin (src/kind-fence.ts). It is also an example of each part for the nodes of another cluster, where jr2
# makes none of them.
#
#   kind-node.sh check|make <segment>        segment: the Fence's IPv4 prefix, such as 198.19.0.0/20
#
# `check` changes nothing that stays: it says what is missing. `make` makes what is missing, and a second run changes
# nothing. The output has one fact on each line:
#   arch <uname -m>
#   plugin <name> <sha256 of /opt/cni/bin/<name>, or ->
#   missing <part>        (check) a part that the node does not have
#   made <part>           (make)  a part that this run made
#   refuse 8021q <why>    the kernel cannot give the 8021q module
#
# The parts:
#   8021q      the module, which the uplink of the Custodian needs for a VLAN interface of each slot. A kind node
#              shares the kernel of the host, so the module is the host's;
#   bridge     the bridge jr2fence0: vlan_filtering 1, vlan_default_pvid 0, no VLAN on the bridge itself, no address,
#              IPv6 off, arp_ignore 8. An access port gets only its VLAN. The stock bridge plugin v1.10.0 gives a
#              vlanTrunk port VID 1 (PVID, untagged) when its NAD has no vlan, so the trunk NAD also sets vlan to the
#              first VLAN of its range; the trunk port then has exactly its range, tagged, and no PVID;
#   rule-set   one table inet jr2_fence: frames bridged on jr2fence0 skip the node's conntrack (so no NAT of the node
#              changes them), and nothing from jr2fence0 reaches the node's own stack or is routed off the bridge;
#   route      unreachable <segment>, so the node never sends a packet to the segment on its default route.
# A restart of the node loses the bridge, its settings, the rule set and the route, and can lose the module.
set -eu

MODE=${1:?usage: kind-node.sh check|make <segment>}
SEGMENT=${2:?usage: kind-node.sh check|make <segment>}
B=jr2fence0
T=jr2_fence
case $MODE in check) SAY=missing ;; make) SAY=made ;; *) echo "kind-node.sh: unknown mode $MODE" >&2; exit 2 ;; esac
case $SEGMENT in *[!0-9./]* | "") echo "kind-node.sh: the segment must be an IPv4 prefix, not '$SEGMENT'" >&2; exit 2 ;; esac

echo "arch $(uname -m)"
for p in bridge static tuning; do
  s=$(sha256sum "/opt/cni/bin/$p" 2>/dev/null | cut -d' ' -f1) || s=""
  echo "plugin $p ${s:--}"
done

# 1. The module. Built in, or loaded: /sys/module/8021q is there.
if [ ! -d /sys/module/8021q ]; then
  if [ "$MODE" = check ]; then
    if modprobe -n -q 8021q 2>/dev/null; then echo "missing 8021q"; else
      echo "refuse 8021q the kernel $(uname -r) has no module 8021q in /lib/modules"
    fi
  elif why=$(modprobe 8021q 2>&1) && [ -d /sys/module/8021q ]; then
    echo "made 8021q"
  else
    echo "refuse 8021q the kernel $(uname -r) could not load the module 8021q: ${why:-no reason}" | tr '\n' ' '
    echo
  fi
fi

# 2. The bridge and its settings.
# Run a command in make mode only.
act() {
  if [ "$MODE" = make ]; then "$@"; fi
}
if ! ip link show "$B" >/dev/null 2>&1; then
  echo "$SAY bridge"
  if [ "$MODE" = make ]; then
    ip link add "$B" type bridge vlan_filtering 1 vlan_default_pvid 0
  fi
fi
if ip link show "$B" >/dev/null 2>&1; then
  [ "$(cat "/sys/class/net/$B/bridge/vlan_filtering")" = 1 ] || {
    echo "$SAY bridge:vlan_filtering"
    act ip link set "$B" type bridge vlan_filtering 1
  }
  [ "$(cat "/sys/class/net/$B/bridge/default_pvid")" = 0 ] || {
    echo "$SAY bridge:default_pvid"
    act ip link set "$B" type bridge vlan_default_pvid 0
  }
  vids=$(bridge -j vlan show dev "$B" | grep -o '"vlan":[0-9]*' | cut -d: -f2) || vids=""
  if [ -n "$vids" ]; then
    echo "$SAY bridge:no-vlan"
    for v in $vids; do act bridge vlan del dev "$B" vid "$v" self; done
  fi
  [ "$(cat "/proc/sys/net/ipv6/conf/$B/disable_ipv6")" = 1 ] || {
    echo "$SAY bridge:no-ipv6"
    act sysctl -qw "net.ipv6.conf.$B.disable_ipv6=1"
  }
  [ "$(cat "/proc/sys/net/ipv4/conf/$B/arp_ignore")" = 8 ] || {
    echo "$SAY bridge:arp_ignore"
    act sysctl -qw "net.ipv4.conf.$B.arp_ignore=8"
  }
  if ip -4 addr show dev "$B" | grep -q inet; then
    echo "$SAY bridge:no-address"
    act ip -4 addr flush dev "$B"
  fi
  ip link show "$B" | grep -q ',UP' || {
    echo "$SAY bridge:up"
    act ip link set "$B" up
  }
fi

# 3. The rule set. Its comment carries a hash of its own text.
body="  chain pre {
    type filter hook prerouting priority -350; policy accept;
    iifname \"$B\" counter notrack
  }
  chain input {
    type filter hook input priority -200; policy accept;
    iifname \"$B\" counter drop
  }
  chain forward {
    type filter hook forward priority -200; policy accept;
    iifname \"$B\" oifname != \"$B\" counter drop
    iifname != \"$B\" oifname \"$B\" counter drop
  }
  chain out {
    type filter hook output priority -200; policy accept;
    oifname \"$B\" counter drop
  }"
sum=$(printf '%s' "$body" | sha256sum | cut -c1-16)
table() { printf 'table inet %s {\n  comment "jr2 fence rule set %s"\n%s\n}\n' "$1" "$sum" "$body"; }
# The loaded table is compared rule by rule with the rule set, not by its comment alone: a rule deleted from the table
# leaves the comment in place. The rule set is loaded once more under a scratch name of this process, both listings
# are read with no counter, and the scratch table goes again.
norm() { sed -e "1s/ $1 / T /" -e 's/ counter packets [0-9]* bytes [0-9]*/ counter/'; }
scratch="${T}_want_$$"
loaded=$(nft list table inet "$T" 2>/dev/null | norm "$T") || loaded=""
table "$scratch" | nft -f -
want=$(nft list table inet "$scratch" | norm "$scratch")
nft delete table inet "$scratch"
if [ "$loaded" != "$want" ]; then
  echo "$SAY rule-set"
  if [ "$MODE" = make ]; then
    { printf 'table inet %s\ndelete table inet %s\n' "$T" "$T"; table "$T"; } | nft -f -
  fi
fi

# 4. The route.
if ! ip route show type unreachable | sed 's/ *$//' | grep -qxF "unreachable $SEGMENT"; then
  echo "$SAY route"
  if [ "$MODE" = make ]; then ip route replace unreachable "$SEGMENT"; fi
fi
