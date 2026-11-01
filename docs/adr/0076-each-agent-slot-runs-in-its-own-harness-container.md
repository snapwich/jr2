# Each agent slot runs in its own Harness container, so no Agent can act as another

[ADR-0013](0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md) scoped an Agent's control
credential to its Sandbox, which stops one feature's coder from delivering a pick to another feature's reviewer: the two
are in different Sandboxes. [ADR-0075](0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md) made several
Agents in one Sandbox normal — concurrent coders in one clone, or a coder beside an independent security reviewer.
Within one Sandbox the Sandbox scope is not enough. Every Agent's Turn runs in the one Harness container; every Agent's
`bash` Working tool is a same-uid child of that one process and inherits its env, so it reads the one Sandbox token's
Stand-in; and the Custodian accepts that public Stand-in for a pick to **any** registration in the Sandbox. So a coder's
`bash`, driven by a prompt injection, can `POST /agents/<reviewer-iid>/events` and approve its own review. The reviewer
did nothing.

Three designs were weighed against the pod's hardening (`runAsNonRoot`, `allowPrivilegeEscalation: false`,
`capabilities: drop ALL`): a second uid inside the one container, a split of the Harness into a control container and a
tools container, and this one — a Harness container for each agent slot. This design is the only one that gives each
Agent a credential a co-resident Agent's code cannot read **without relaxing the hardening**, because Kubernetes already
isolates one container from another.

## Decision

- **One Harness container for each declared, workspace-ful agent slot.** The slots of a Machine are declared statically
  (`jr2Setup({ actors })`), so the count is known at the Sandbox's provision. The containers share the Sandbox Image and
  the `/work` volume. A slot's container is its home: every Turn, every `continue` epoch and every conversation of that
  slot runs in it, and a new container means a new agent slot, never a new conversation. A Menu-only Agent has no
  Sandbox and is unchanged — it runs on the Instance Harness under its own token
  ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md)).
- **The container is the identity.** Kubernetes gives each container its own filesystem, env and process view — a
  separate mount and PID namespace, with `shareProcessNamespace` off ([ADR-0005](0005-sandbox-pod-composition.md)). The
  slot containers run the same image at the one uid, but a slot's credential is a file in its own container's
  filesystem, so another slot's `bash` cannot read it, its env or its `/proc`. No pod-hardening setting is relaxed:
  every container stays `runAsNonRoot`, `allowPrivilegeEscalation: false`, `capabilities: drop ALL`.
- **A per-slot Stand-in, mapped by the Custodian to a per-slot token.** Each slot container holds its own **secret**
  Stand-in, mounted into that container alone. The Custodian maps it to that slot's real token and the real token never
  leaves the Custodian ([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)). The per-slot
  tokens are signed names like the Sandbox token, domain-separated by a prefix, so they need no new signing key, and
  they are known at provision because the slots are static.
- **The Orchestrator checks the slot.** `mayDeliverToAgent` gains one test: the presented credential's slot must match
  the registration's slot. The check covers the whole `/agents/<iid>/*` set — the surface read, the pick, and the
  delivery poll — so a slot can neither read nor write another slot's iid. `POST /fetch` stays Sandbox-scoped: it is
  about the pod's shared caches
  ([ADR-0053](0053-a-fetch-inside-the-pod-asks-the-node-cache-and-the-cache-asks-the-remote.md)), not an Agent's control
  channel.
- **Identity is the slot, not the Turn.** The credential proves the slot and nothing more. Every fresh Turn and every
  `continue` epoch of a slot presents the same per-slot credential, so continuation returns to the slot's container,
  which holds the conversation. The Orchestrator never checks that a second reviewer Turn is the **same** reviewer as
  the first — slot match is the whole control-plane check.
- **One endpoint for each slot.** The Sandbox's single Harness endpoint becomes one for each slot container. `agentRun`
  resolves the slot's endpoint ambiently, as it resolves the enclosing `workspace()` today
  ([ADR-0016](0016-agent-turn-mechanics-are-internal.md)). The slot list rides the Sandbox's provision so the operator
  can build the containers, their ports and their Services.

## Considered options

- **A second uid inside the one Harness container** — run `bash` as a uid that cannot read the Harness's per-slot
  secret. Rejected. Under `runAsNonRoot` + `allowPrivilegeEscalation: false` + `drop ALL`, nothing in the container can
  `setuid` without adding `CAP_SETUID` (and, under `no_new_privs`, likely flipping `allowPrivilegeEscalation` to true).
  It hides the secret by **adding** privilege to the one container that runs model-controlled code — the wrong direction
  — to re-create, by hand and fragilely, the isolation Kubernetes already gives between containers.
- **A user namespace** so the Harness maps a second uid with no host privilege. Rejected: the default seccomp profile
  (`RuntimeDefault`) blocks `unshare(CLONE_NEWUSER)` from a non-privileged process, so it needs a custom seccomp profile
  and a cooperating kernel. It is not portable to an arbitrary self-hosted cluster.
- **Split the Harness into a trusted control container and a model-code tools container** — two containers in all, not
  one for each slot. Rejected: it keeps the hardening but crosses
  [ADR-0027](0027-the-harness-is-jr2s-own-server-flue-retires-the-wire-stays.md) (the Harness is one server) and sends
  every tool call across a container boundary, for no gain over a container per slot, which Kubernetes isolates the same
  way.
- **The Custodian authenticates the caller.** Rejected on its own: every container reaches the Custodian over one pod
  loopback with the one public Stand-in, so the Custodian — which sees the iid in the path — still cannot tell a
  legitimate caller from a sibling. It can enforce the slot only once each caller presents a secret that only its own
  container holds, which is this decision.
- **Keep the Sandbox-scoped credential and document same-Workspace Agents as mutually trusting.** Rejected: a coder
  beside an independent reviewer or a security reviewer in one Workspace is a motivating case. They share `/work` on
  purpose, but they must not be able to act as each other on the control plane.

## Consequences

- **The Sandbox pod holds N Harness containers**, one for each workspace-ful slot, sharing the image and the `/work`
  volume, each with its own name, port, per-slot Stand-in mount, and Service. The Sandbox's status carries one endpoint
  for each slot. [ADR-0005](0005-sandbox-pod-composition.md) records the composition; the operator builds the pod and
  the per-slot Services.
- **The provision is handed the declared slots** — a new field on the Sandbox's parts. The Orchestrator reads them from
  the Machine; there is no runtime discovery.
- **An idle slot runs its Harness for the pod's life.** The containers share the image, so this is process and memory
  overhead, not image overhead, and it is bounded by the declared slot count (two to a few in practice). jr2 does not
  start a slot's container lazily; a lazy start would add a dynamic-provisioning path this design exists to avoid.
- **Concurrent same-slot Pool workers in one clone are not isolated from each other.** ADR-0075's "concurrent coders in
  one clone" fans one slot into `cap` workers in one pod. They share that slot's container and credential, which is
  correct — they are one agent fanned out, equally trusted. A workflow that needs **mutually-distrusting** workers uses
  a Pool of `workspace()` workers instead, where each worker gets its own Sandbox and is isolated by the Sandbox token
  ([ADR-0075](0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md)).
- **A slot's `bash` can read its own slot's Stand-in.** That authorizes only that slot's own picks, which the model can
  already make through its Menu, and the Orchestrator still judges every pick against the Turn's Allowed picks
  ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)). The real token never
  leaves the Custodian. So a slot that exfiltrates its own Stand-in gains nothing another Agent cannot already do as
  itself, and nothing across slots.
- **The `@kind` tier gains the sibling attack.** ADR-0013's scenario posts a pick straight to the Orchestrator with the
  Stand-in and is refused; this adds the co-resident case — a coder's `bash` posts a pick as the reviewer through the
  Custodian on loopback, and the Orchestrator refuses it on the slot check.
- **The `@model` tier is unaffected in what the model reads.** This change moves containers and credentials, not the
  Briefing, the Menu or any text the model sees, so it is not a `@model`-tier change (ADR-0066).
