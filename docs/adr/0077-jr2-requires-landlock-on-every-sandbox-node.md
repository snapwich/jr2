# jr2 requires Landlock on every Sandbox node

Two boundaries of jr2 are Landlock domains. [ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)
confines the child of a credentialed `command` in the Effector, so that the Agent's code cannot read the Effector's key
or a secret that the command does not name.
[ADR-0076](0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md) confines each process that the
Harness starts in `/work`, so that no Workspace code can read the control credential and act as an Agent. On a node with
no Landlock, neither boundary exists. A path that runs there with less confinement is a second jr2, with a weaker
boundary, to support and to test.

## Decision

- **Landlock is a requirement of jr2 on every Sandbox node.** It holds where Workspace code runs, which is also where
  the check reaches. No component has an unconfined branch, anywhere.
- **The Repo cache agent detects it, on each Sandbox node.** The cache agent's DaemonSet has one pod on each Sandbox
  node, by the same `nodeSelector` and `tolerations` as the Sandboxes
  ([ADR-0052](0052-a-sandbox-lands-where-an-ordinary-pod-lands-and-the-cache-follows-it.md)). The agent probes Landlock
  on its node. On a node without it, the agent is NotReady, and its status gives the reason.
- **`jr2 up` refuses to converge while a Sandbox node lacks Landlock.** It reads the DaemonSet's pods (one list call),
  and it names each Sandbox node whose cache agent reports no Landlock
  ([ADR-0019](0019-one-converging-command-against-the-current-context.md)). The admin keeps a bad node out of the set
  with `sandbox.nodeSelector` or a taint, as ADR-0052 says. There is still no jr2 node label.
- **The refusal is an ordinary converge failure** (ADR-0019). It comes within the cache agent's rollout wait, which
  `jr2 up` already makes. It names each Sandbox node without Landlock, the probe's reason, and the fix: keep the node
  out with `sandbox.nodeSelector` or a taint (ADR-0052), or enable Landlock in its kernel. A run of `jr2 up` after the
  fix converges.
- **Each confining component probes at its start, and refuses to serve without it.** These are the Harness of a Sandbox
  and the Sandbox Effector. The probe is `landlock_create_ruleset` with `LANDLOCK_CREATE_RULESET_VERSION`. This is the
  backstop for a node that joins after the converge.
- **No component keeps a path for a node that cannot confine a child.** ADR-0068's Effector refuses to start on such a
  node, whatever its Workspace holds.
- **The minimum ABI is 3.** Under ABI 1, a confined process can never move or link a file into another folder, whatever
  the rules allow, and package managers, git and `mv` do that. ABI 2 adds the `REFER` right, so the domain can do it
  (ADR-0076). Under ABI 2, Landlock does not handle `truncate(2)`, so a confined process can truncate a file that the
  rules let it do nothing else to: a conversation under `/run/jr2`, which the Harness rebuilds an Agent's record from.
  ABI 3 adds the `TRUNCATE` right, and the confiner always handles it. The confiner uses the scopes of abstract Unix
  sockets and of signals (ABI 6) when the kernel offers them. Each probe refuses a kernel below ABI 3, with the ABI that
  it found.
- **The components that probe.** The cache agent probes as the detector, though it confines nothing. The Harness of a
  Sandbox and the Sandbox Effector probe because they confine. The Instance Harness and the Instance Effector confine
  nothing: a Menu-only Agent has no Working tools ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md)),
  and the Instance Effector runs no `command`. They do not probe.

## Considered options

- **A minimum of ABI 1.** Rejected: under it no confined process can move a file into another folder, which stops normal
  work.
- **A minimum of ABI 2.** Rejected: under it the domain can truncate a file under `/run/jr2`. One Agent's code can then
  erase or roll back another Agent's conversation, and below ABI 6 it can end the Harness so that the Harness rebuilds
  from the cut file. It admits Linux 5.19 to 6.1 (Debian 12's stock kernel among them), for a boundary with a hole.
- **Refuse only a Sandbox with more than one Agent on a node without Landlock.** Rejected: it keeps a less secure
  branch, which jr2 must then support and test.
- **Run unconfined, with a warning.** Rejected: Workspace code can then read the control credential, and a warning does
  not stop it.
- **A check pod on each node at each `jr2 up`.** Rejected: it starts one pod for each node on every converge, and it
  misses a node that joins later.
- **One check pod, with the start-up probe as the backstop.** Rejected: a bad node shows only when a run lands there and
  fails.
- **jr2 labels the nodes that have Landlock, and a Sandbox requires the label.** Rejected: it reverses ADR-0052, and it
  needs a cluster-wide permission to patch Nodes.

## Consequences

- **The kernels that this excludes.** Landlock ABI 3 is in Linux 6.2 and later. A node with an older kernel cannot run
  jr2: for example RHEL 8 (4.18), Debian 11 (5.10), Debian 12 on its stock kernel (6.1), Ubuntu 20.04 and 22.04 on their
  first kernels (5.4, 5.15), and Amazon Linux 2 (4.14 or 5.10). A distribution kernel can carry a backport: the probe,
  not the version, decides. A newer kernel must also enable Landlock: its list of security modules (`CONFIG_LSM`, or the
  `lsm=` boot parameter) must name `landlock`. On a node, `/sys/kernel/security/lsm` lists the modules that run.
  Measured from a hardened pod with no capabilities: kind on WSL2 (6.6) offers ABI 3; the home cluster's arm64 nodes
  (6.8), ABI 4; spark (6.11, arm64), ABI 5.
- **kind on a host inherits the host's kernel.** A kind node is a container, so the kernel of the host decides. On macOS
  or Windows, Docker runs the nodes in a virtual machine, and the kernel of that machine decides.
- **A mixed cluster.** `jr2 up` names each Sandbox node without Landlock and refuses until the admin keeps it out of the
  set. A node that joins after the converge shows as a NotReady cache agent. A Sandbox placed on it fails at its start,
  because its Harness refuses to serve.
- **The check runs when a Machine uses a Sandbox.** `jr2 up` converges the cache agent then
  ([ADR-0051](0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md)). With no Sandbox, no node needs
  Landlock, and there is nothing to check.
- **The docs list the requirement** where they list what jr2 needs from a cluster and from a host.
