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
  start permits each name below a domain, for TLS and HTTP only, on each port of the entry. `["*"]` permits each name,
  for TLS and HTTP only too, because one placeholder address serves each name of such an entry, and only a TLS name or a
  `Host` header then says which name was meant. Such an entry never carries an Intercepted host of the Sandbox or a name
  of jr2's, in any spelling of the name, and it carries no `Host` that names a port other than the entry's. A Tunneled
  name that also has an exact entry keeps, at its own placeholder, the TLS and HTTP that such an entry permits for it on
  each port where the name has no entry of its own: one name has one placeholder, so the wildcard's address cannot serve
  it. `intercept: true` takes an exact name or address, because the Custodian's leaf names one host. `jr2 up` gives a
  warning for `["*"]` and for each `*.` entry, because each one is a channel out (Consequences).
- **A name decides, never an address.** The resolver answers each name on the Egress list with a placeholder address
  that stands for that name in that Sandbox, and it asks no server. It refuses each other name, also when the tool names
  its own DNS server. The Custodian reads the name from the placeholder address, checks that the TLS name or the `Host`
  header agrees, and dials the real name itself. So one rule serves each port and each protocol: TLS, HTTP, SSH, a
  database. Port 80 of a name carries HTTP alone, because there the `Host` header must agree too, so that plain HTTP to
  a server that serves many names reaches only the name permitted. An entry for a protocol that has no name in its first
  bytes must be an exact name.
- **An address is permitted only as an entry that the author wrote.** An entry can be an exact IPv4 address with a port,
  for a host that has no name, such as a model on the local network. A connection to an address that has no such entry
  is refused, because it has no name. The same applies to a placeholder address that the Sandbox did not get for that
  name. `jr2 up` refuses an entry that is an IPv6 address, a range, an address that the dial guard refuses (ADR-0059),
  an address in the Fence's own ranges, or a multicast or reserved address, because no TCP connection has one.
- **The Fence has two address ranges of its own.** The segment, where each Harness pod has its address, is
  198.19.0.0/20, and the placeholder addresses are in 198.18.0.0/16. The Instance's config can move each one (`fence`)
  to a range that is at least as large and that does not overlap the other, an address that the dial guard refuses, or a
  multicast or reserved address, because a network can already use those addresses. No entry can name an address in
  198.18.0.0/15, whatever `fence` says.
- **A host is an Intercepted host or a Tunneled host.** The Custodian ends the TLS of an Intercepted host, so it can
  read the request, swap a Stand-in and check the `Host` header (ADR-0059). These are each host that the Custodian holds
  a secret for, for that Sandbox's Harness or its Sandbox Effector, the name of jr2's control routes, and each host
  whose entry has `intercept: true`. Each other host on the list is a Tunneled host: the Custodian checks the name and
  carries the bytes, and the client sees the real host's certificate or host key.
- **A bound host needs no entry.** Each host that the Custodian holds a secret for, for a pod's Harness or its Sandbox
  Effector, is permitted for that pod, and it is an Intercepted host. The Custodian refuses a request to it that carries
  no Stand-in. So Workspace code cannot use the model's host unless its Workspace grants a secret for it.
- **A host with no secret needs an entry, also when jr2 itself uses it.** Examples are a model endpoint with no key, an
  MCP server with no token and the url of an Effect with no secret. A secret in a url's path stays in the Effector
  (ADR-0068), so the Custodian holds no secret for that host, and it needs an entry too. `jr2 up` refuses to converge
  while such a host has no entry, and it prints the entry to add. All code in the Sandbox can then reach that host. A
  host that no entry can name, such as `localhost` or an IPv6 address, is refused with the reason.
- **A Sandbox's Intercepted hosts are fixed at provision.** The certificates for them are made before the pod starts
  (ADR-0059). A new Intercepted host applies to the next Sandbox. A Tunneled host can be added while the Sandbox lives.
- **jr2's own traffic takes the same path.** The Harness's model calls, its MCP calls, the Menu, the fetch route and the
  Sandbox Effector's calls go through the Fence to the Custodian, as a tool's traffic does. The control routes are a
  name of jr2's own that the resolver answers, and it is an Intercepted host. The push of a Sandbox Effector over SSH is
  a Tunneled host: jr2 permits the port of the url (22 by default) of each SSH Repo that the Workspace binds, and the
  push key stays in the Effector's container
  ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)).
- **The Orchestrator reaches a Harness pod through the uplink, and nothing else does.** A pod behind a Fence has no
  Service and no pod address, so the Orchestrator's dial to a Harness or to a Sandbox Effector goes to the uplink, which
  carries it to that pod. The uplink accepts such a dial from the Orchestrator only, and the bearer check stays as the
  second control ([ADR-0058](0058-a-harness-answers-the-orchestrator-alone.md)). The kubelet's probes of the pod's
  containers are exec probes.
- **A refusal has a reason, and each one is logged.** A refused name gets a DNS refusal at once. A permitted name has
  only its placeholder address, so a query for another record of it, such as an IPv6 address, gets an empty answer at
  once, and a client that asks for both does not wait. A refused connection gets a TLS alert, an HTTP 403 or a line of
  text, with jr2's reason. A Tunneled connection that the Custodian refuses after the TLS name, because of the address
  that the name resolves to or because the name is refused there, is closed with no text: the client's TLS has started,
  and only the log line gives the reason. The Custodian logs each refusal with the Sandbox, the name, the port and the
  reason. A refusal before a name is known names the address dialed and the TLS name instead (ADR-0059). The resolver
  writes at most 20 refusal lines a second for each Sandbox, and then one line with the count of the others, so that a
  Sandbox that asks for many names cannot push the lines of the other Sandboxes out of the log. This log replaces the
  flow log of the cluster's network.
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
- **A removed entry cuts an open connection after about a minute.** The rule applies to each new connection at once. A
  connection that the change no longer permits stays open for the Custodian's drain time, 60 seconds, and is then
  closed. Envoy's default is 600 seconds, and churn then holds memory for ten minutes. A changed held value has the same
  effect on each connection of that Sandbox that the Custodian ends: those to its Intercepted hosts, to jr2's control
  routes and plain HTTP, whose `Host` it reads. So a model stream or a long poll of the Menu that is open then closes
  after the drain time. A change to the names that a port of a Sandbox carries by `Host` (on port 80, each Tunneled name
  and wildcard there; on another port, the wildcards and the exact names that they cover) also closes, after the drain
  time, each plain HTTP connection of that Sandbox on that port, also one to a name that did not change, because one
  HTTP chain of the port reads the `Host` of all of them. A chain for each name would make the rules of each Sandbox
  larger, because each chain holds an HTTP manager of its own.
- **A protocol where the server speaks first waits about 2 seconds** for each connection, because the Custodian waits
  for a TLS name on each port.
- **A Sandbox can fill the bridge's address table.** This can stop the node's Sandboxes. It leaks nothing.
- **The Harness pods of an Instance on a node share the Custodian pod's cache of names and its connection limit.** The
  cache holds 8,192 names and 4,096 lookups in flight, and the pod holds 16,384 connections, for all its slots; no slot
  has a bound of its own. A Sandbox that dials many names, through a `*` entry or a `*.` entry whose names it can make
  up, can fill the cache. Then each new name of those Harness pods is refused with jr2's reason (`reason=name-cache`)
  until names that no dial used for 5 minutes leave the cache, so for as long as the Sandbox keeps dialing its names and
  for up to 5 minutes after it stops. A name in the cache still works. A Sandbox that holds many connections open can
  stop the new connections of those pods. Such a connection is closed with no text and no log line, and a held
  connection is logged only when it closes, so no line names that Sandbox while it holds them. The Orchestrator's dial
  has its own bound and is not stopped (ADR-0059). It leaks nothing.
- **The Harness pods of an Instance on a node share the resolver.** One process of the Custodian pod serves the resolver
  of each slot on the node and makes each slot's rules live. So each part of the resolver that a Sandbox can fill has a
  bound for each slot: a slot holds at most 4 TCP connections; the resolver closes a connection with a reset 1 s after
  the 64th answer (which goes with a FIN), after 10 s with no message, when the client sends its FIN, and at once when
  the kernel does not take an answer, so that a closed connection leaves no answer with the kernel (after a plain close,
  a client that does not read keeps those answers in the memory of the process, and the bound of 4 does not count them);
  a UDP query from port 0 gets no answer; and a failed answer or a failed accept loses that answer or that connection
  only. A Sandbox that holds its 4 connections stops only its own lookups over TCP. While the process is down, each
  Harness pod of the Instance on that node gets no answer to a lookup, and no Sandbox there becomes live. It fails
  closed.
- **The Custodian is one point for all Sandboxes of an Instance.** While it is down, no Sandbox reaches anything, and no
  Turn makes a model call. It fails closed.
- **The cluster needs a second pod network and a rule set on each Sandbox node.** On Cilium, the node's config must let
  another CNI plugin run. A managed cluster that permits neither cannot have the segment.
- **An Instance with no Workspace needs the Fence too,** because its Instance Harness is behind one. So the first model
  call of a new Instance needs the prerequisites on a node.
