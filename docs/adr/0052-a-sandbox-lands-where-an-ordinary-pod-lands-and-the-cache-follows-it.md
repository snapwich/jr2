# A Sandbox lands where an ordinary pod lands, and the cache follows it

[ADR-0051](0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md) made a Sandbox schedulable on any node and
put a Repo cache agent on every node as a DaemonSet that tolerates every taint. The grill of 2026-09-13 found the two
halves disagreeing about which nodes matter: the Sandbox pod carries no tolerations and no selector, so it lands only
where an ordinary pod lands, while the cache agent probes and clones on control-plane and GPU nodes no Sandbox can reach
— and a `present` cache there scores a node the scheduler cannot use. Meanwhile
[ADR-0045](0045-the-platform-joins-the-image-address-and-the-cluster-chooses-it.md) read a third set (every node not
cordoned) to choose build platforms, and nothing in `jr2.config.ts` could say which nodes an Instance's Sandboxes may
use. **Which nodes are an Instance's Sandbox nodes, and who follows that set** is one decision.

## Decision

- **A Sandbox node is where an ordinary pod lands. There is no jr2 node label.** A node is a Sandbox node when it is not
  cordoned, matches the Instance's `sandbox.nodeSelector`, and carries no taint the Instance's `sandbox.tolerations` do
  not tolerate. With no config that is exactly the default scheduler's answer: taints already express "not for ordinary
  work" for every workload on the cluster, so jr2 reads them instead of asking for a second, jr2-only opt-in that every
  kind cluster and every fresh pool would have to perform before `jr2 up` could work.
- **The override is Instance-level and raw Kubernetes**: `sandbox: { nodeSelector?, tolerations? }` in `jr2.config.ts`,
  pod-spec shapes verbatim, the stance `harness.env` takes for `EnvVar`. A node label or taint is a deployment fact a
  Machine cannot know (ADR-0050), so it lives in the file that holds deployment facts. No `affinity` key: the operator
  owns the Sandbox's affinity (the soft preference toward nodes holding its Repo caches), and a user preference beside
  it would need a merge rule for a case no cluster has asked for. A requirement (`nodeSelector`) never conflicts with a
  preference, so the two sit side by side untouched.
- **One predicate, three readers.** The Sandbox pod, the cache-agent DaemonSet, and `jr2 up`'s summary all use the same
  `nodeSelector` and `tolerations`. The DaemonSet loses its blanket `operator: Exists` toleration: one cache agent per
  Sandbox node, so a cache is only ever present where a Sandbox can land, and the affinity it feeds only ever names a
  usable node. The build set (ADR-0045) is the union of the nodes an ordinary pod lands on — the Orchestrator
  Deployment's own placement — and the Sandbox nodes, intersected with the supported set as before.
- **The Sandbox CR carries the placement.** `Sandbox.spec` gains `nodeSelector` and `tolerations` beside `resources`,
  `initContainers`, and `volumes`; the Orchestrator writes them from its baked config at provision and the operator
  copies them onto the pod, merging nothing. The operator stays config-blind (ADR-0001), and every Instance's placement
  is its own: the CR is namespaced, the DaemonSet is per Instance with a per-namespace hostPath, and the shared operator
  holds no placement state. Version skew is ADR-0019's contract: an older operator would place a pod without the new
  fields, and the `jr2 up` that introduces them is the one that upgrades the operator.
- **An empty set warns; it never refuses.** `jr2 up` prints the Sandbox nodes it sees, and when there are none names
  each node with the taint or selector that excluded it and the `sandbox.*` line that would admit it — then converges.
  The set moves: a pool autoscales from zero, a node is cordoned mid-converge, a GPU box joins tomorrow. A refusal would
  turn `jr2 up` into a point-in-time check of a moving set. The run-time truth is the operator's: a `Pending` Sandbox
  reports the scheduler's own `FailedScheduling` message through its condition, so `jr2 status` shows the taint or
  selector while the run waits (ADR-0048's pattern).
- **A Machine says nothing about placement — for now.** A packaged `workspace()` that needs a GPU cannot write the
  consumer's label (the encapsulation gap ADR-0049/0051 closed for Agents and Repos). The extension, when a Machine
  needs it, is a named class: `workspace(body, { node: "gpu" })` and
  `sandbox: { classes: { gpu: { nodeSelector, tolerations } } }`, refused by `jr2 up`'s walk when unmapped — the Repo
  Slot pattern. `sandbox.nodeSelector` and `sandbox.tolerations` are that shape's default class, so the extension adds
  `classes` beside them and renames nothing; and because placement rides the CR, a per-Machine class needs no new
  plumbing.

## Considered options

- **A jr2 label** (`jr2.dev/sandbox=true` on nodes that opt in). Rejected: every cluster pays a labeling step before the
  first `jr2 up`, a single-node kind cluster included, and a labeled node is a candidate for every Sandbox — a GPU node
  labeled for one Machine hosts all of them. Taints already say what the label would, for every workload at once.
- **A jr2 vocabulary** (`sandbox.nodes: ["node-4"]`, or `pool: "workers"`). Rejected: simpler to type and wrong on the
  first autoscaled pool, where node names are not stable and "pool" is a cloud provider's word with a different label on
  each.
- **The operator reads placement from a per-Instance object** (a ConfigMap, or the DaemonSet's own template) instead of
  the CR. Rejected: a second read per reconcile and a cross-object dependency the CR does not declare, for no gain — the
  CR already carries everything else the pod needs.
- **Refuse `jr2 up` on an empty set**, the ADR-0051 stance for an unbound slot. Rejected: a slot is a static fact of the
  code; the node set is a fact of the cluster right now.
- **Keep the DaemonSet on every node.** Rejected: a cache on a node no Sandbox reaches is a clone nobody reads, a probe
  that fails on a control-plane node's egress rules, and an affinity term the scheduler cannot honor.

## Consequences

- ADR-0045 is rewritten in place: "schedulable nodes" is the union above, and the `platforms` escape hatch's "polluted
  set" case narrows to an untainted pool of a foreign arch — a tainted GPU pool is no longer counted.
- ADR-0051 is rewritten in place: the cache agent is a DaemonSet over the Sandbox nodes, not every node.
- The DaemonSet controller auto-tolerates `node.kubernetes.io/unschedulable`, so a cache agent also sits on a cordoned
  Sandbox node. Harmless: the scheduler ignores the soft affinity toward a node it cannot use.
- A Sandbox node of a NEW architecture that joins after a converge meets a Sandbox Image the cluster never built for it
  and fails with `exec format error` until the next `jr2 up` — as any node did before this ADR; `platforms` is the
  answer for a pool that autoscales from zero.
- The Orchestrator and operator Deployments keep their own placement; `sandbox.*` names Sandboxes only.
- A `NoExecute` taint an Instance tolerates on the Sandbox pod is tolerated verbatim: jr2 adds no `tolerationSeconds`,
  so a Sandbox stays through the taint for as long as its Lease is renewed (ADR-0021).
