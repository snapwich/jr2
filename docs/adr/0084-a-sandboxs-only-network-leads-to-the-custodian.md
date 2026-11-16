# A Sandbox's only network leads to the Custodian

A Sandbox had the cluster's network, and its egress was open. The Custodian was a container in the pod, and a tool used
it only when it obeyed `HTTPS_PROXY`. So Workspace code could send the Worktree, or a Stand-in that its Workspace
grants, to any host. A rule in the pod cannot close this: Workspace code that becomes root in the pod removes a redirect
there and reads the memory of a proxy there. A NetworkPolicy cannot close it either: it permits addresses, and one
address serves many names.

The requirement is a boundary that governs all traffic of a Sandbox, with no action by the Agent and no way round it,
and that holds when Workspace code is root in the Sandbox.

## Decision

- **The Fence is the Sandbox's only network.** A Sandbox pod has one interface, on a segment that is isolated from the
  cluster's network. It has no interface on the cluster's own network: no pod address, no Service, no cluster DNS. On
  the segment, a Sandbox can exchange frames with one peer only, the Custodian's uplink on its node. It cannot reach
  another Sandbox, the node, the kubelet, the API server, a pod or a public address.
- **The Fence is outside the pod and has no rule for each pod.** Each Sandbox node has one bridge, and a static rule set
  keeps the node's own network stack off it. Each Sandbox has a VLAN of its own on the bridge, and the uplink has the
  trunk. The Sandbox cannot choose its VLAN, so the uplink knows which Sandbox sent a frame. Nothing is written when a
  pod starts, so nothing is lost when a pod, the kubelet or the container runtime starts again, and there is no window
  at a pod's start. Nothing in the pod is part of the Fence.
- **The uplink gives all traffic to the Custodian.** It sends each TCP connection to the Custodian and each DNS query to
  the Custodian's resolver, whatever address the Sandbox dialed. It drops all else: UDP, QUIC, ICMP, IPv6 and frames of
  another type. No tool needs a proxy setting, and `HTTPS_PROXY` is not set.
- **There is one Custodian for each Instance, outside every Sandbox**
  ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). It has one set of rules for each
  Sandbox, which the Orchestrator writes at provision and can change while the Sandbox lives, with no restart. A
  provision waits until the Custodian says that the Sandbox's rules are live. A Sandbox with no rules reaches nothing.
- **The Egress list states what a Sandbox may reach, and all else is refused.** The Instance's config holds the default
  list (`egress`), and a `workspace()` that states its own list replaces it for that Workspace. An entry is
  `"host[:port]"` or `{ host, port?, intercept: true }`. With no port, the entry permits ports 443 and 80. `*.` at the
  start permits each name below a domain, for TLS and HTTP only. `["*"]` permits each name. `jr2 up` gives a warning for
  `["*"]` and for each `*.` entry, because each one is a channel out (Consequences).
- **A name decides, never an address.** The resolver answers each name on the Egress list with a placeholder address
  that stands for that name in that Sandbox, and it asks no server. It refuses each other name, also when the tool names
  its own DNS server. The Custodian reads the name from the placeholder address, checks that the TLS name or the `Host`
  header agrees, and dials the real name itself. So one rule serves each port and each protocol: TLS, HTTP, SSH, a
  database. An entry for a protocol that has no name in its first bytes must be an exact name.
- **An address is permitted only as an entry that the author wrote.** An entry can be an exact address with a port, for
  a host that has no name, such as a model on the local network. A connection to an address that has no such entry is
  refused, because it has no name. The same applies to a placeholder address that the Sandbox did not get for that name.
- **A host is an Intercepted host or a Tunneled host.** The Custodian ends the TLS of an Intercepted host, so it can
  read the request, swap a Stand-in and check the `Host` header (ADR-0059). These are each host that the Custodian holds
  a secret for, for that Sandbox's Harness or its Sandbox Effector, the name of jr2's control routes, and each host
  whose entry has `intercept: true`. Each other host on the list is a Tunneled host: the Custodian checks the name and
  carries the bytes, and the client sees the real host's certificate or host key.
- **A bound host needs no entry.** Each host that the Custodian holds a secret for, for a pod's Harness or its Sandbox
  Effector, is permitted for that pod, and it is an Intercepted host. The Custodian refuses a request to it that carries
  no Stand-in. So Workspace code cannot use the model's host unless its Workspace grants a secret for it.
- **A host with no secret needs an entry, also when jr2 itself uses it.** Examples are a model endpoint with no key, an
  MCP server with no token and the url of an Effect with no secret. `jr2 up` refuses to converge while such a host has
  no entry, and it prints the entry to add. All code in the Sandbox can then reach that host.
- **A Sandbox's Intercepted hosts are fixed at provision.** The certificates for them are made before the pod starts
  (ADR-0059). A new Intercepted host applies to the next Sandbox. A Tunneled host can be added while the Sandbox lives.
- **jr2's own traffic takes the same path.** The Harness's model calls, its MCP calls, the Menu, the fetch route and the
  Sandbox Effector's calls go through the Fence to the Custodian, as a tool's traffic does. The control routes are a
  name of jr2's own that the resolver answers, and it is an Intercepted host. The push of a Sandbox Effector over SSH is
  a Tunneled host: jr2 permits port 22 of the host of each SSH Repo that the Workspace binds, and the push key stays in
  the Effector's container ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)).
- **The Orchestrator reaches a Harness pod through the uplink, and nothing else does.** A pod behind a Fence has no
  Service and no pod address, so the Orchestrator's dial to a Harness or to a Sandbox Effector goes to the uplink, which
  carries it to that pod. The uplink accepts such a dial from the Orchestrator only, and the bearer check stays as the
  second control ([ADR-0058](0058-a-harness-answers-the-orchestrator-alone.md)). The kubelet's probes of the pod's
  containers are exec probes.
- **A refusal has a reason, and each one is logged.** A refused name gets a DNS refusal at once. A refused connection
  gets a TLS alert, an HTTP 403 or a line of text, with jr2's reason. The Custodian logs each refusal with the Sandbox,
  the name, the port and the reason. This log replaces the flow log of the cluster's network.
- **The Instance Harness and each check pod are behind a Fence too.** Each Harness pod has the same network and reaches
  the Custodian the same way, so no Harness has a proxy setting. The Instance Harness
  ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md)) has an Egress list with no entry of the author's:
  it reaches its bound hosts, the hosts that `jr2 up` requires an entry for, and jr2's control routes. A check pod calls
  a model as a Turn of its class calls it ([ADR-0019](0019-one-converging-command-against-the-current-context.md)). The
  Instance Effector holds real values and runs no code of an Agent, and it stays on the cluster's network.
- **How a Sandbox's traffic reaches the Custodian is one seam.** The segment is the only form that is built. A cluster
  that cannot have it needs another form behind the same seam, and the rules of the Custodian do not change.
- **`jr2 up` installs the uplink, the Custodian and the resolver, and it probes what it does not install.** The second
  network of a pod (Multus), the bridge and the node's rule set are prerequisites. `jr2 up` refuses to converge while a
  Sandbox node lacks one, and it names the node and the part.

## Considered options

- **The Custodian or a redirect in the pod.** Rejected: root in the pod removes the redirect and reads the Custodian's
  memory.
- **A NetworkPolicy, or Cilium's `toFQDNs`.** Rejected: both permit addresses. In a test, a denied name on a shared
  address was reached.
- **Cilium's own L7 rule.** Rejected: it swaps a header, but it needs Cilium, it sees HTTP headers only, and it drops
  with no reason.
- **Redirect rules on the pod's network device on the node.** Rejected: they do not work on Cilium with eBPF host
  routing, and a new pod sandbox loses them.
- **A node plugin of jr2 that writes redirect rules when a pod is made.** Rejected for now. It held against root in the
  pod, and the pod keeps the cluster's network. But jr2 would own privileged code on each node, and the boundary fails
  open when another agent on the node removes the rules. It is the candidate for a cluster that cannot have a second pod
  network.
- **One Custodian port for each SSH host, or no SSH.** Rejected: the placeholder address gives the name for each
  protocol with one mechanism, and a stock client needs no setting.
- **An SSH proxy in the Custodian that holds the push key.** Not built. It keeps the key out of the pod, but the client
  then sees a host key of jr2's, and a tool that pins the real host's key fails. If it is built, it must listen on the
  Custodian's own loopback: as a pod of its own, it gave a Sandbox's key to a pod that named that Sandbox.

## Consequences

- **A Sandbox has no part in the cluster's network.** No Service names it, no NetworkPolicy or service mesh applies to
  it, and no HTTP or TCP probe reaches it. `kubectl exec` and `kubectl logs` work.
- **A tool with a fixed address fails.** So does a tool that needs UDP or QUIC. A client falls back from QUIC to TCP.
- **A Tunneled host is permitted for read and for write, at each host behind its address.** The Custodian does not see
  inside its TLS. A client can name a permitted host in the TLS name and another host of the same CDN in the `Host`
  header, and some CDNs serve it. A client can also write to a permitted host with an account of its own.
  `intercept: true` closes both for that host.
- **A `*.` entry keeps a DNS channel.** When a Sandbox connects to a name below the domain, the Custodian resolves that
  name, so the domain's owner sees each label. Exact names close it.
- **A removed entry does not cut an open connection.** The rule applies to each new connection.
- **A protocol where the server speaks first waits about 2 seconds** for each connection, because the Custodian waits
  for a TLS name on each port.
- **A Sandbox can fill the bridge's address table.** This can stop the node's Sandboxes. It leaks nothing.
- **The Custodian is one point for all Sandboxes of an Instance.** While it is down, no Sandbox reaches anything, and no
  Turn makes a model call. It fails closed.
- **The cluster needs a second pod network and a rule set on each Sandbox node.** On Cilium, the node's config must let
  another CNI plugin run. A managed cluster that permits neither cannot have the segment.
- **An Instance with no Workspace needs the Fence too,** because its Instance Harness is behind one. So the first model
  call of a new Instance needs the prerequisites on a node.
