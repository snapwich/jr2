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
- **The Fence is outside the pod. The VLAN state of a bridge of the node is the boundary, and a rule table of the node
  is a second barrier.** Each Sandbox node has one bridge (`jr2fence0`). The stock CNI plugin `bridge` makes it, with
  VLAN filtering, from jr2's attachment objects when the first pod joins it: no other step makes it or changes its VLAN
  state, and only `jr2 down --all` deletes it (Consequences). Each Sandbox's port is a member of the Sandbox's own VLAN
  only, and the uplink's port is a member of its Instance's range only. The bridge's own side, the node's network stack,
  is a member of VLAN 1 only, which no pod's port carries, so a Sandbox cannot exchange a frame with the node. This VLAN
  state keeps a Sandbox off the node and off other pods, also with no rule table. A Sandbox's frame enters the bridge
  untagged at its access port, and the node's prerouting hooks see it before the bridge gives it its VLAN: on a node
  with `net.bridge.bridge-nf-call-iptables = 1`, as with kube-proxy, the NAT of the node changes a dial to a Service
  address there, and the bridge then drops the frame, so the dial gets no answer and the Custodian sees nothing. So each
  node has the rule table `inet jr2_fence`, which matches the bridge alone. It keeps the node's NAT from changing a
  Sandbox's frames, so that each dial reaches the Custodian, and it is a second barrier: each packet that enters from
  the bridge skips the node's connection tracking, and no packet goes from the bridge to the node's own network stack,
  between the bridge and another interface, or from the node's stack to the bridge. The tagged frames of the uplink's
  trunk go through no firewall hook (`net.bridge.bridge-nf-filter-vlan-tagged` is 0 by default). The Sandbox cannot
  choose its VLAN, so the uplink knows which Sandbox sent a frame. The plugin writes the VLAN state when it adds a port,
  and no rule is written for a pod, so there is no window at a pod's start. Nothing in the pod is part of the Fence.
- **Instances share a node's bridge by VLAN ranges.** Each Instance with a Harness pod claims a range of 128 VLANs on
  the cluster: `jr2 up` creates the Kubernetes Lease object `jr2-fence-range-<k>` in `jr2-system`, which names the
  Instance's namespace, and a create of a name that exists fails, so two Instances cannot claim one range. The range is
  the same on every node, because a pod's VLAN is chosen before the scheduler picks its node. Slot i of range k is VLAN
  2 + 128k + i, and its address is that VLAN's address on the segment. `jr2 up` gives slots 0–2 to the Instance Harness,
  the check pod and the node probes, and the Orchestrator gives each Sandbox one of the other slots for the Sandbox's
  life. The Custodian knows a pod only by its VLAN, so the Orchestrator gives a slot again only when the Sandbox that
  had it has been gone for 2 minutes and each Custodian pod of the Instance says that it holds no rules of the slot and
  that no pod answers on the slot's VLAN. A Custodian pod that does not answer stops the reuse of every slot. The
  Orchestrator may not read Secrets, so after it starts again, a slot whose Sandbox went before the start waits for the
  word of the Custodian pods alone, and not for its 2 minutes. The Orchestrator asks the Custodian pods that the
  EndpointSlices of `jr2-custodian` name, and may not read Pods, so a Custodian pod with no address yet (one that a
  rollout replaces, or one that is Pending) is not asked. Then the 2 minutes alone keep the slot: they cover a pod of a
  deleted Sandbox, which leaves its node in its grace period. The uplink of an Instance has the trunk of its own range
  only, and no port of a pod on the bridge is a member of VLAN 1, so a frame of one Instance never reaches the uplink or
  a Harness pod of another. An Instance keeps its range until `jr2 down`, also while it has no Harness pod, because a
  pod of it can still be on a VLAN of the range: a held run's Sandbox
  ([ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md)), or an Instance Harness
  pod that drains. For the same reason, `jr2 up` deletes the Custodian of an Instance with no Harness pod only when its
  namespace has no Sandbox and no Instance Harness pod left. An Orchestrator that `jr2 up` gave no range refuses each
  Sandbox provision, with a reason that names `jr2 up`, so the next Sandbox of a held run after such a converge is not
  on the cluster's network. `jr2 down` gives the range back when the namespace is NotFound, and only the claim that it
  read: a claim that another Instance took in the meantime stays. `jr2 up` takes a range again only when the namespace
  that holds it is NotFound: while that namespace is Terminating, a pod of it can still be on a VLAN of the range. The
  claims are in `jr2-system`, which goes with the operator, so `jr2 down --all` refuses while another namespace on the
  cluster holds a range.
- **The uplink gives all traffic to the Custodian.** It sends each TCP connection to the Custodian and each DNS query to
  the Custodian's resolver, whatever address the Sandbox dialed. It drops all else: UDP, QUIC, ICMP, IPv6 and frames of
  another type. No tool needs a proxy setting, and `HTTPS_PROXY` is not set.
- **There is one Custodian for each Instance, outside every Sandbox**
  ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). It runs as one pod on each Sandbox
  node, which holds that node's uplink, the Custodian and its resolver, and each pod holds the rules of each Sandbox of
  the Instance. It has one set of rules for each Sandbox, which the Orchestrator writes at provision and can change
  while the Sandbox lives, with no restart. A provision waits until the Custodian says that the Sandbox's rules are
  live. A Sandbox with no rules reaches nothing.
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
  bytes must be an exact name. The Custodian looks up the real name as it is written, with no search list of the
  cluster, so an entry for a Service of the cluster names its full name (`<service>.<namespace>.svc.<domain>`, with the
  cluster's domain, `cluster.local` by default).
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
  no Stand-in. So Workspace code cannot use the model's host unless its Workspace grants a secret for it. When an entry
  of the list also names a bound host, the Custodian carries a request with no Stand-in to it, with every credential
  header removed, so Workspace code can read a public repository on the host that the Sandbox Effector pushes to over
  HTTPS. The Custodian answers a request with no credential toward a host whose secret rides a Basic pair, and that no
  entry names, with 401, as ADR-0059 states, so git asks its helper.
- **The Custodian holds the Sandbox Effector's header secrets.** Each bearer, Basic or header secret of a file-body
  `http` is a binding of the pod's held manifest toward the Effect's target, and the token of each push over HTTPS is
  one toward the url's host, which the provision adds, because only the provision knows the url of a slot that the run
  binds (ADR-0068). The Effector holds the Stand-in of each. The Custodian cannot tell the Effector's connection from
  the Harness's, because both have the pod's one address, so each such Stand-in is secret, and Workspace code cannot
  read it.
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
  ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)). The url of a per-run Repo, or of a slot
  that `customize()` binds, is not known to `jr2 up` when it makes the list, so its SSH host needs an entry.
- **The Orchestrator reaches a Harness pod through the uplink, and nothing else does.** No Service routes to a pod
  behind a Fence, and its only address is its slot's on the segment, so the Orchestrator's dial to a Harness or to a
  Sandbox Effector goes to the uplink, which carries it to that pod. The uplink accepts such a dial from the
  Orchestrator only. A NetworkPolicy admits the Instance's Orchestrator alone to the Custodian pod's dial port and to
  the port of its control process, and each dial carries the Instance's dial token, which the Custodian checks also on a
  cluster whose network enforces no policy. The bearer check stays as the second control
  ([ADR-0058](0058-a-harness-answers-the-orchestrator-alone.md)). The Orchestrator finds the Custodian pod on a Harness
  pod's node from the EndpointSlices of the Custodian's headless Service. It finds a Sandbox's node in the Sandbox's
  status, and the Instance Harness's node in the EndpointSlices of the headless Service that governs its StatefulSet,
  which routes nothing; so it reads no Pod ([ADR-0063](0063-the-orchestrator-watches-the-cluster.md)). The kubelet's
  probes of the pod's containers are exec probes.
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
  ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md)) is on slot 0 and has an Egress list with no entry
  of the author's: it reaches its bound hosts, the hosts that `jr2 up` requires an entry for, and jr2's control routes.
  The check pod is on slot 1 and calls a model as a Turn calls it
  ([ADR-0019](0019-one-converging-command-against-the-current-context.md)), so `jr2 up` converges the Custodian before
  the check. Each takes the Sandbox placement, so a Custodian pod is on its node. `jr2 up` writes their slot Secrets,
  with leaves of the Instance's CA (ADR-0059), and starts each pod only after each Custodian pod says that its rules are
  live. It asks each Custodian pod through a port-forward to its control port, with the dial token, because it runs
  outside the cluster. The Instance Effector holds real values and runs no code of an Agent, and it stays on the
  cluster's network.
- **How a Sandbox's traffic reaches the Custodian is one seam.** The segment is the only form that is built. A cluster
  that cannot have it needs another form behind the same seam, and the rules of the Custodian do not change.
- **The Fence has two node prerequisites, and `jr2 up` installs each one that a cluster lacks, after it asks.** They are
  the second network of a pod, Multus, with `namespaceIsolation` and no global namespace, and jr2's DaemonSet
  `jr2-system/jr2-fence-node`, which puts the stock CNI plugins `bridge`, `static` and `tuning` on each node and loads
  the rule table. Without the isolation, a pod of another namespace can name the Instance's uplink or slot attachment
  and join its VLANs. Nothing else on a node is a prerequisite: the bridge plugin makes the bridge, and the kernel loads
  the module for the uplink's VLAN interfaces when the uplink makes the first one. `jr2 up` installs with kubectl alone,
  on any cluster, so a user who installed jr2 from npm and ran `kind create cluster` needs no other step, and the owner
  of a shared cluster gets the same steps that a kind user gets. It reads the cluster at each converge of an Instance
  with a Harness pod, before it applies anything. When a prerequisite is missing, it writes a list of each part that it
  will apply, and asks under the first-contact confirmation (`--yes` answers it). The list names: the namespace
  `jr2-system`, when the cluster has none; the DaemonSet, whose pod runs as root on the node's network, runs the node's
  `bridge` file to read its version, writes into `/opt/cni/bin`, and loads the rule table with the capability
  `NET_ADMIN`; and Multus, whose manifest has a cluster-wide CustomResourceDefinition and ClusterRole, and a privileged
  DaemonSet in `kube-system` that writes the first CNI configuration of each node, so that the cluster makes each new
  pod through Multus. It also says that a later converge of a newer Kit changes the DaemonSet with no question, and what
  `jr2 down --all` removes. When jr2 installs Multus, it says that jr2 asks before it changes that Multus, and that
  `jr2 down --all` removes it, but keeps it while the cluster has a NetworkAttachmentDefinition of another owner. When
  the cluster has a Multus of another owner, it says that jr2 never changes that Multus. A converge that finds both asks
  nothing and writes one line.
  - **Multus:** when the cluster has none, `jr2 up` applies the thick Multus v4.3.2 manifest that the CLI package ships,
    with `namespaceIsolation` and no global namespace. Its DaemonSet has the annotation `jr2.dev/multus`, which names
    the manifest's version, so that jr2 knows that it installed it; jr2 updates only a Multus that has it, and asks
    first. A Multus that jr2 did not install is accepted only when jr2 knows its form and reads, in the place that this
    form uses, `namespaceIsolation` and no global namespace; jr2 never changes it. jr2 finds a Multus in each namespace
    by the command of a DaemonSet's container: the thick `multus-daemon`, the thin `/thin_entrypoint`, or a multus-cni
    image (the last part of the image's repository is `multus-cni`, ends in `-multus-cni`, or is `multus`). A name or a
    label does not count, so RKE2's Multus (`app: rke2-multus`) is found, and an add-on beside a Multus, such as RKE2's
    `rke2-multus-dnc` and `rke2-multus-dhcp` or the upstream `multus-dynamic-networks-controller`, is not a Multus. jr2
    reads the settings of each form from one place:
    - the thick `multus-daemon`: its configuration file (its flag `-config`, by default
      `/etc/cni/net.d/multus.d/daemon-config.json`), which must be a key of a ConfigMap that the container mounts there;
    - the thin `/thin_entrypoint`: its flag `--multus-conf-file`, as its parser (pflag) reads it. For `auto`, the
      default, the settings are its flags `--namespace-isolation` (true only for a value that pflag reads as true) and
      `--global-namespaces`. For a path, they are in the Multus configuration that is the ConfigMap key mounted at that
      path. A ConfigMap that the container mounts but does not read does not count;
    - the v3 `/entrypoint.sh` of a multus-cni image: the same, but the script reads only `--flag=value`, and the
      isolation is on only for the exact text `--namespace-isolation=true`.

    Anything else is a refusal that says that jr2 cannot tell, and names what jr2 saw: a multus-cni image with another
    command, a flag that can take one of those flags as its value, a value that the parser does not read, a file that is
    not a ConfigMap key, or a value of the wrong type.

  - **The DaemonSet `jr2-fence-node`:** `jr2 up` applies `jr2-system/jr2-fence-node`, which runs the operator image. Its
    pod is on the node's network, because the rule table belongs to the node's network namespace, and it runs as root,
    with no privilege escalation, no other host namespace, no token and a read-only root. Two init containers run at
    each start of the pod, so after a restart of the node too. The rule table comes first, so that each node gets it,
    also a node that the checks then refuse. The first container, with the capability `NET_ADMIN` alone, loads the rule
    table with `nft` in one transaction that makes the table when the node has none, deletes it, and makes it again: a
    second load replaces the table, never adds a rule to it, and leaves no moment with no rule. The second, with no
    capability, waits up to 180 s for a CNI configuration in `/etc/cni/net.d` and a file in `/opt/cni/bin`, because on a
    new node the primary CNI writes them after this pod can start. When the node has a `bridge`, it reads its version
    before it writes anything: it runs the file with no `CNI_COMMAND`, and a stock plugin prints
    `CNI bridge plugin v<version>` and stops. A version older than v1.8.0, or none, fails the pod. v1.8.0 is the first
    release that takes the trunk's `vlan` and `vlanTrunk` together (v1.3.0 to v1.7.1 refuse them). And an older plugin
    ignores a key that it does not know: before v1.3.0 it ignores `preserveDefaultVlan` and `vlanTrunk`, keeps VLAN 1 on
    each port and puts the trunks of the Instances on a shared VLAN, and before v1.7.0 it does not isolate a slot's
    port. A node that has a newer `bridge` keeps its own (v1.9.1 made the same VLAN state). The pod sees only the node's
    `/opt/cni/bin`, so a `bridge` that is a link to a file in another folder fails the pod too: jr2 cannot run it, so it
    cannot read its version. Then it copies each plugin of the pinned v1.10.0 release, which the operator image holds,
    checked by sha256 at its build, into `/opt/cni/bin` when the node has no file or link of that name, and never
    replaces one: it copies under a temporary name and links it to the plugin's name, and the link refuses a file of
    that name that came after the check. A copy that fails, for example into a read-only folder, says why. It writes the
    name and the type of the node's first CNI configuration and, when that is a Multus configuration of the thin form
    (`type: "multus"`), its `namespaceIsolation` and its `globalNamespaces`, or that it cannot read them. Then the pod
    idles as a user that is not root, with no capability, so a node that joins later gets the plugins and the table too.
    The pod mounts the node's `/opt/cni/bin` and, read-only, `/etc/cni/net.d`, and nothing else of the node. The kubelet
    mounts a folder that the node does not have yet when it appears, so the wait of 180 s covers a new node with no
    folder too. It runs on each Linux node, as Multus does, because any node can be a Sandbox node of some Instance.
    `jr2 up` applies it after the operator image is delivered and before Multus and the Custodian, and waits until a pod
    of the template in force, or of a later one, is Ready on each Sandbox node. It applies it again at each converge
    whose Kit is not older than the DaemonSet's, as it does the operator: an apply that changes nothing restarts no pod,
    and a later converge of a newer Kit changes it with no question. When `jr2 up` needs each node's first CNI
    configuration as it is now (it is to install Multus, or the cluster has a Multus of another owner), it replaces each
    pod of the DaemonSet that started before this converge, and reads only the lines of the pods that started after,
    because the line of an earlier pod can be old.
  - **A node that joins later is not checked until the next `jr2 up`.** Nothing keeps a Custodian pod or a Sandbox off a
    node whose pod of `jr2-fence-node` failed. On a node that joins later with a `bridge` from v1.3.0 to v1.7.1, the
    trunk's attachment fails, so no Custodian pod runs there, and a Sandbox there reaches nothing. On a node that joins
    later with a `bridge` older than v1.3.0, the attachments do not fail: a Sandbox can start there, and each slot's
    port keeps VLAN 1, so Workspace code that is root in a Sandbox there can exchange frames with the other pods on that
    node's bridge, until the next `jr2 up` refuses the node. The rule table, which loads first, still keeps it off the
    node's own network stack.

- **`jr2 up` does not install when it cannot do so safely: it refuses, and names the setting for the cluster's owner to
  change.** These refusals come before it applies anything:
  - A Multus that jr2 did not install and that has no `namespaceIsolation` or has a global namespace, in the place that
    its form uses (above). The refusal names that place and what to set there: a key of the ConfigMap, or a flag of the
    container. A form or a place that jr2 does not know refuses, and says that jr2 cannot tell. A ConfigMap that is
    missing, or that the API refuses to read, refuses too, and the refusal says which. jr2 never changes a Multus that
    it did not install.
  - Multus's CustomResourceDefinition, `network-attachment-definitions.k8s.cni.cncf.io`, with no Multus DaemonSet that
    jr2 can find. A Multus of a form that jr2 does not know can be on the cluster, and a second Multus beside it can
    lose the isolation. jr2 waits 10 s first, because another converge can be between the definition and the DaemonSet
    of the same apply.
  - A primary CNI that removes each other CNI configuration on a node: Cilium with `cni-exclusive: "true"` in the
    ConfigMap `cilium-config` of the namespace of the Cilium DaemonSet, or in a `CiliumNodeConfig` that selects a
    Sandbox node. A read of those objects that the API refuses cannot tell: `jr2 up` writes that it cannot tell and goes
    on, and the probe after the Custodian finds such a node.
  - A Multus that jr2 did not install that mounts a CNI folder other than `/opt/cni/bin` and `/etc/cni/net.d`.

  These refusals come after `jr2 up` applied the namespace `jr2-system` and the DaemonSet, and before it applies Multus.
  Each names the node and the cause. The namespace and the DaemonSet stay, with the plugins that the DaemonSet wrote and
  the rule table on each node where it loaded, and the refusal says so. `jr2 down --all` removes the DaemonSet and the
  table.
  - A Sandbox node whose pod finds no CNI configuration in `/etc/cni/net.d` or an empty `/opt/cni/bin` after its wait,
    or whose folder the kubelet cannot mount in that time (the refusal names the kubelet's reason): its container
    runtime reads its CNI plugins or configuration from another folder.
  - A Sandbox node whose `bridge` plugin is older than v1.8.0, prints no version, or is a link that the pod cannot run,
    whose `/opt/cni/bin` the pod cannot write, or where the rule table does not load.
  - A Sandbox node whose first CNI configuration is a Multus's, when jr2 found no Multus DaemonSet and is to install its
    own: a Multus that jr2 cannot see in the API is on the node. When the API shows a Multus now that the read before
    the question did not see, it gets the same check of its settings as one that the read saw, and when it has the
    isolation, jr2 installs no Multus beside it.
  - A Sandbox node whose first CNI configuration is a Multus configuration of the thin form with no
    `namespaceIsolation`, with a global namespace, or with settings that jr2 cannot read, when the cluster has a Multus
    of another owner: the node uses that file, whatever the API says.
  - A Sandbox node with no pod, because the cluster refused to create it (Pod Security admission or a webhook): the
    refusal names the DaemonSet's `FailedCreate` event, and only an event that came after the apply of this converge.
    And a Sandbox node with no Ready pod in 300 s.

- **`jr2 up` probes the Fence on each Sandbox node, and refuses to converge while a node fails.** It names the node, the
  part and the likely causes. Before it applies the Custodian, it reads the API: Multus's CustomResourceDefinition must
  exist, and a Ready Multus pod must run on each Sandbox node. After the Custodian's pods are Ready, it runs a one-shot
  pod on slot 2 of the Instance's range on each node of a Custodian pod: its address must be the slot's address, the
  Custodian's resolver must answer it, a dial to the API Service's cluster address must get the Custodian's answer at
  once, and the node's address must give no answer but the Custodian's. When no DNS answer comes, an ARP answer from the
  uplink says that the bridge carries the frames and the node changes them (a firewall hook on bridged VLAN frames), and
  no ARP answer says that the bridge or the Custodian pod does not carry them. Then `jr2 up` also replaces that node's
  Custodian pod, so that the plugin puts its trunk on the bridge that the node has now. When the SYN of the dial to the
  Service address gets no answer in 3 seconds, the node's NAT changed it, so the node has no rule table: `jr2 up` names
  the node and that cause, and replaces the node's pod of `jr2-fence-node`, which loads the table again at its start. A
  dial that a peer accepts and that stays silent, or that fails in another way, is not that sign: `jr2 up` names it as a
  cause of its own and replaces no pod. The refusal says each pod that `jr2 up` replaced. The probe pod has no
  privilege: no node network, no capability and no token. So it sees the effect of the VLAN state and of the rule table,
  not the state; the version check of the `bridge` plugin covers what the effect does not show. The Sandbox node set
  changes between converges, so the operator also does not count a Sandbox Ready until Multus reports its attachment as
  the pod's default network: on a node where Multus did not act, the pod has the cluster's network, and its exec probe
  passes there too.
- **One node setting is optional, and nothing checks it.** An `unreachable` route for the segment makes a dial from the
  node, or from a pod on the cluster's network, to a Sandbox's address fail at once, not after a timeout. The move guide
  gives it.

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
  pod, and the pod keeps the cluster's network. But jr2 would own code on each node that writes rules for each pod, and
  the boundary fails open when another agent on the node removes the rules. The rule table of the Fence is one table for
  all pods and a second barrier: when another agent removes it, a Sandbox's dial to a Service address gets no answer,
  and the VLAN state still keeps the Sandbox off the node and off other pods. The plugin is the candidate for a cluster
  that cannot have a second pod network.
- **The VLAN state alone, with no rule table of the node.** Rejected: a Sandbox's frame enters the bridge untagged, so
  the node's prerouting hooks see it before the bridge tags it. On a stock kind cluster
  (`net.bridge.bridge-nf-call-iptables = 1`), kube-proxy's DNAT changed a Sandbox's dial to `10.96.0.1:443`, the bridge
  dropped the frame, the dial timed out, and the Custodian logged nothing. With the `notrack` chain alone, the same dial
  got the Custodian's refusal at once. The table needs a pod with `NET_ADMIN` on the node's network, which the
  confirmation says.
- **The `notrack` chain alone.** Rejected: the three drop chains cost nothing, and they hold when the node's side of the
  bridge is in a pod's VLAN. In a test on kind with the bridge's own side in the slot's VLAN and an address on the
  segment, and with no drop chain, the kubelet answered the Sandbox, the node's dial reached the Sandbox, and a pod of
  the cluster's network was routed into it. The `input`, `out` and `forward` chains each dropped one of those. With the
  stock VLAN state, no packet from the bridge reached the node's stack in any test, also with the bridge in promiscuous
  mode or with a loose reverse-path filter.
- **A bridge, the `8021q` module and an `unreachable` route that the node makes, as prerequisites.** Rejected: the
  bridge plugin makes the bridge and its VLAN state from the attachment objects, and the kernel loads the module when
  the uplink needs it. The node parts needed privileged code on each node, or a step that the cluster's owner could
  forget, and a restart of the node lost them. The route stays optional.
- **`jr2 up` makes node parts on a kind cluster through `docker exec`, and none elsewhere.** Rejected: the install with
  kubectl works on any cluster, it needs no docker on the host that runs `jr2 up`, and the owner of a shared cluster
  gets the same confirmation.
- **A recipe of the jr2 repository, or a `jr2` command of its own, that prepares the cluster.** Rejected: a user who
  installed jr2 from npm has no clone, and a command of its own is a second step that the user can forget, as
  [ADR-0019](0019-one-converging-command-against-the-current-context.md) says of setup.
- **The pod of `jr2-fence-node` downloads the release tarball of the plugins.** Rejected: a node with no egress to
  GitHub could not get the plugins, and the image already carries what the pod runs, checked by sha256 at its build.
- **The checks of a node before the rule table.** Rejected: a node that the checks refused then got no table, and
  nothing keeps a Sandbox off a node that joins later and that the checks refuse, so the second barrier was missing
  where the VLAN state is weakest.
- **A Multus found by the label `app=multus` alone.** Rejected: a Multus of another owner with another label (RKE2's
  `app: rke2-multus`) was not seen, so jr2 installed a second Multus beside it, and the second can replace the first's
  configuration and lose its isolation.
- **A Multus found by "multus" in the name, a label or an image of a DaemonSet.** Rejected: an add-on (RKE2's
  `rke2-multus-dnc`, with the image `hardened-multus-dynamic-networks-controller`) was taken for a Multus, so jr2
  refused with a fix that the add-on cannot take, or read the plan as a Multus of another owner beside jr2's own.
- **The settings of a thin Multus from each ConfigMap that it mounts, and from its flags only when none holds them.**
  Rejected: the upstream thin manifest mounts a ConfigMap of a Multus configuration and runs `--multus-conf-file=auto`,
  which ignores it. jr2 told the user to change the ConfigMap, then accepted it, and the node's file still had no
  isolation.
- **A question at each converge that changes the DaemonSet `jr2-fence-node`.** Rejected: the DaemonSet is the Kit's, as
  the operator is, and a newer Kit changes the operator with no question too. The first question says so. Multus is not
  the Kit's code, so a change of its manifest asks.
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
- **The Custodian pod of a node is one point for all Harness pods of its Instance on that node.** While it is down, no
  Harness pod there reaches anything, and no Turn there makes a model call. It fails closed. A roll of the Custodian (a
  new Kit version, a changed `fence` or `caBundle`, or a `jr2 up` from a host whose Node.js has other root certificates,
  because the Custodian trusts upstream the roots of the Node.js that runs `jr2 up`) replaces the pod of each node in
  turn, and cuts each open connection of that node's Harness pods. So a Harness pod's rules change through the
  Custodian's control process, never through its pod template. Also, while a Custodian pod of the Instance does not
  answer, no Sandbox of the Instance gets a slot, on any node: the pod could hold rules of any slot.
- **A cluster has 31 VLAN ranges.** So at most 31 Instances with a Harness pod share a cluster, and an Instance has at
  most 125 Sandboxes at once, beside its Instance Harness. Each Custodian pod of an Instance holds the VLAN interfaces
  of its whole range and the rules of each of its slots, so it is sized for a full range: about 1.9 GiB of memory on
  each Sandbox node for each Instance ([ADR-0060](0060-a-workspace-states-its-size-and-jr2-reserves-all-of-it.md)).
- **The cluster needs a second pod network.** On Cilium, the cluster's config must let another CNI plugin run. A managed
  cluster that permits no second CNI plugin, no hostPath pod, or no pod on the node's network with `NET_ADMIN` in
  `jr2-system` cannot have the segment.
- **jr2 writes files and a rule table on each node, and the bridge plugin makes a bridge there.** The plugins stay in
  `/opt/cni/bin` after `jr2 down --all`, because jr2 cannot tell them from files that another tool put there. The kernel
  module `8021q` also stays loaded, because another user of the node can need it. `jr2 down --all` removes the rule
  table, the bridge `jr2fence0`, the DaemonSet `jr2-fence-node` and a Multus that carries jr2's annotation; `jr2 down`
  without `--all` removes none of them. It removes the table and the bridge with the DaemonSet itself: it applies the
  DaemonSet's removal form, whose one init container deletes the table and then the bridge, waits until each pod of it
  is Ready, and then deletes the DaemonSet. So no other pod with `NET_ADMIN` is needed, and no pod of jr2 stays on a
  node. A node with no bridge (no pod joined the Fence there) is a success. The container deletes the bridge only when
  it has no port: a port is a pod that is still on the Fence. Past the refusal of `jr2 down --all` while another
  Instance holds a range, no port is expected; when one exists, the bridge stays, and `jr2 down` gives a warning with
  the node and the ports. A node where no pod became Ready in 2 minutes keeps its table and its bridge, and `jr2 down`
  names the commands that remove them. A read of the DaemonSet or of its pods that fails also gives a warning with those
  commands; it never skips the removal in silence. Multus goes with each object of its manifest, its
  CustomResourceDefinition too, and that definition goes with each NetworkAttachmentDefinition of the cluster. So when
  the cluster has a NetworkAttachmentDefinition after the Instance's namespace is gone (one of another owner), or
  `jr2 down` cannot list them, jr2's Multus and the definition stay, and a warning names them and gives the commands
  that remove them. The confirmation of `jr2 down --all` says so.
- **The Fence survives a restart of the node with no step.** The bridge, its VLAN state and the rule table are gone
  after a restart. The bridge plugin makes the bridge and the VLAN state again when the first pod of the node joins the
  bridge: each Harness pod and Custodian pod of the node starts again, so each port gets its VLANs again. The pod of
  `jr2-fence-node` starts again and loads the table again. Until it has, a Sandbox's dial to a Service address gets no
  answer, and the VLAN state still keeps the Sandbox off the node and off other pods. The plugins are files on the
  node's disk. The thick Multus deletes its CNI configuration (`00-multus.conf`) when it stops in order, and writes it
  again when its pod starts again. Until then, the node's runtime can make a new pod with the primary CNI alone, on the
  cluster's network. The operator does not count a Sandbox Ready until Multus reports its attachment as the pod's
  default network. Only the optional route must be made at boot (a unit, or the node's provisioning).
- **An Instance with no Workspace needs the Fence too,** because its Instance Harness is behind one. So the first model
  call of a new Instance needs the prerequisites on a node.
