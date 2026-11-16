#!/bin/sh
# The Custodian's uplink for one Instance (ADR-0084): the static part of the Fence inside the Custodian pod.
#
#   uplink.sh <range> [segment]       range k: VLANs 2+128k ... 129+128k; segment default 198.19.0.0/20
#
# It runs once, as the init container `uplink` of a Custodian pod, with NET_ADMIN in the pod's own network namespace
# (never the node's). The pod's interface net1 is the trunk port of the Instance's VLAN range on the node's bridge.
# For each slot i (0..127), VLAN v = 2 + 128k + i:
#   - the interface v<i> on net1, with the gateway address (segment + 1)/32 and a /32 route to the slot address
#     (segment + v);
#   - the identity: on v<i>, IPv4 only from the slot address, and ARP only from the slot address;
#   - TCP from v<i> goes to the port 20000+i (Envoy's listener of the slot), and DNS (port 53, UDP and TCP) to the
#     port 25000+i (the slot's resolver). So the port tells the Custodian the slot, and no source address does.
# All else from a VLAN is dropped: other UDP, ICMP, IPv6, other frame types. From eth0 (the cluster network) only the
# ports 15021 (health), 18080 (inbound) and 18081 (control) are open. Nothing is forwarded. The rules do not change
# while the pod lives: a Sandbox's start writes nothing here. M8 renders this script into the Custodian's DaemonSet.
set -eu

K=${1:?usage: uplink.sh <range> [segment]}
SEGMENT=${2:-198.19.0.0/20}
SLOTS=128
TRUNK=net1

case $K in '' | *[!0-9]*) echo "uplink: the range must be a number" >&2; exit 2 ;; esac
[ "$K" -le 30 ] || { echo "uplink: the range must be 0..30 (VLAN 4094 is the last)" >&2; exit 2; }

# The segment's base address as a number.
base=${SEGMENT%/*}
IFS=. read -r a b c d <<EOF
$base
EOF
BASE=$(( (a << 24) | (b << 16) | (c << 8) | d ))
addr() { n=$((BASE + $1)); echo "$(( (n >> 24) & 255 )).$(( (n >> 16) & 255 )).$(( (n >> 8) & 255 )).$(( n & 255 ))"; }
GW=$(addr 1)
FIRST=$((2 + 128 * K))

ip link set "$TRUNK" up
i=0
ids=""
tcp=""
dns=""
while [ $i -lt $SLOTS ]; do
  v=$((FIRST + i))
  a=$(addr $v)
  ip link add link "$TRUNK" name "v$i" type vlan id "$v"
  ip addr add "$GW/32" dev "v$i"
  ip link set "v$i" up
  ip route add "$a/32" dev "v$i"
  sep=${ids:+, }
  ids="$ids$sep\"v$i\" . $a"
  tcp="$tcp$sep\"v$i\" : $((20000 + i))"
  dns="$dns$sep\"v$i\" : $((25000 + i))"
  i=$((i + 1))
done

nft -f - <<NFT
table netdev jr2_uplink_l2 {
  chain trunk {
    type filter hook ingress device "$TRUNK" priority -500; policy accept;
    ether type 8021q vlan type { ip, arp } accept
    counter drop comment "jr2: not IPv4 or ARP in a VLAN of the range"
  }
}
table inet jr2_uplink {
  set identity {
    type ifname . ipv4_addr
    elements = { $ids }
  }
  map tcp_port {
    type ifname : inet_service
    elements = { $tcp }
  }
  map dns_port {
    type ifname : inet_service
    elements = { $dns }
  }
  chain identity {
    type filter hook prerouting priority -400; policy accept;
    iifname "v*" meta nfproto ipv4 iifname . ip saddr @identity counter accept
    iifname "v*" counter drop comment "jr2: source is not the Sandbox of this slot"
  }
  chain slot {
    type nat hook prerouting priority dstnat; policy accept;
    iifname "v*" meta l4proto { tcp, udp } th dport 53 counter redirect to : iifname map @dns_port
    iifname "v*" meta l4proto tcp counter redirect to : iifname map @tcp_port
  }
  chain input {
    type filter hook input priority 0; policy drop;
    iifname "lo" accept
    ct state established,related accept
    iifname "v*" ct status dnat counter accept
    iifname "eth0" tcp dport { 15021, 18080, 18081 } accept
    counter drop comment "jr2: not a port of the Custodian"
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    counter drop comment "jr2: the Custodian forwards nothing"
  }
}
table arp jr2_uplink {
  set identity {
    type ifname . ipv4_addr
    elements = { $ids }
  }
  chain input {
    type filter hook input priority 0; policy accept;
    iifname "v*" iifname . arp saddr ip @identity accept
    iifname "v*" counter drop comment "jr2: ARP not from the Sandbox of this slot"
    iifname "$TRUNK" counter drop comment "jr2: ARP outside a VLAN"
  }
}
NFT
echo "uplink: range $K, VLANs $FIRST-$((FIRST + SLOTS - 1)), gateway $GW, $SLOTS slots"
