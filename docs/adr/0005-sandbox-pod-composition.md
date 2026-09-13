# The Sandbox pod's containers: Harness, Adapter, and an optional User Container

A Sandbox pod composes up to three containers around one shared worktree volume (`/work`):

- **Harness container** — the CR's primary container: the Sandbox Image (user-built or user-brought,
  [ADR-0037](0037-an-instance-builds-its-sandbox-images-j2-injects-the-harness.md)) with j2's runtime mounted at
  `/opt/j2` and the command overridden to start the Harness. The Agent's toolchain lives here because the Working tools
  (read/write/edit/bash) execute here — the tools the Agent can reach are this image's. It is also where a human
  `kubectl exec`s to inspect a run with the agent's exact tools, worktrees, and filesystem.
- **Adapter container** — j2-owned sidecar ([ADR-0013](0013-adapter-hosts-the-agent-mcp-surface.md)): serves the Agent
  its MCP tool menu on `localhost` and is the pod's credential holder for the control plane. It exists as a separate
  container precisely _because_ the Working tools give the Agent code execution in the Harness container — the
  Orchestrator credential lives where the Agent cannot read it.
- **User Container** — opt-in third seat, composed only when the `workspace()` names its image (a `file:` docker context
  the Machine ships or a registry ref, the same resolution as the Sandbox Image, no default —
  [ADR-0049](0049-a-machine-carries-its-parts-and-composes-by-invoke.md)). The whole authoring surface is that one
  string — `user?: string` among `workspace()`'s options, beside `image` — and deliberately no more: env, resources, and
  ports are not forwarded, because every key j2 forwarded would be a crack in "j2 puts nothing in it"; widening the
  string to an object stays compatible if a concrete need ever argues its own way in (the routable-port follow-up below
  is the known candidate). In the pod it is the container named `user` (`kubectl exec -c user`). It runs its **own
  entrypoint, untouched**: j2 injects nothing, probes nothing, and overrides nothing — the zero-contract seat, which is
  exactly why it exists. Two jobs no other seat can do:
  - **Unattended services.** A container's one command belongs to the Harness in the primary seat (ADR-0037), so an
    image's own services — an sshd for managed access, an IDE server, a metrics agent — need a container whose command
    j2 deliberately does not own. A system built _on_ j2 that hands people access to their Sandboxes automates through
    this seat.
  - **Credential visibility.** A session's secrets — a forwarded ssh agent socket above all — live in this container's
    private mount namespace, where the Agent executes nothing. The human sshs in with agent forwarding, works, and the
    socket is gone on disconnect; at no point does it share a filesystem with code the Agent runs.

The Harness and User containers mount `/work` read-write **and `/repos` read-only** — the node's Repo cache, one bare
checkout per Repo the Sandbox names (ADR-0004, ADR-0051) — so human and agent see identical files. `/repos` is not a
second exception but half of the first: the worktrees are `--shared` clones whose alternates resolve objects from
`/repos/<key>`, so a seat holding `/work` alone holds checkouts whose every borrowed object is missing — git in the User
Container dies on "unable to normalize alternate object path". The Adapter mounts neither — the pod's credential holder
has no business in the working tree.

One git wall stays the image's own: git's dubious-ownership guard fires in the User Container whenever its uid differs
from the Harness's (the attach created the trees), and `safe.directory` is honored only from system/global config —
files j2 does not own in this seat. Env-form config (`GIT_CONFIG_*` on the sidecar) was considered and rejected: it
would crack "j2 puts nothing in it", and it does not even cover the seat's flagship access path — ssh login sessions
scrub container env — so the image would still owe a line for sshd while carrying j2's env for exec sessions, two
mechanisms where one honest one serves. A User Container image whose sessions run git carries its own
`git config --global --add safe.directory '*'` (or ships it in `/etc/gitconfig`).

The worktrees' remotes encode which hop each seat can make: `git fetch origin` reads the node cache (refreshed by the
cache agent — the hop the pod can make), while origin's **push url** is the real remote in the Binding's own spelling —
the attach sets it from the slot the Machine bound (ADR-0051), so a Machine that bound over ssh pushes over ssh even
when the cache was cloned over https, and nothing else plumbs it. A push therefore succeeds exactly when a caller
supplies the credential — a human's forwarded agent in the User Container — and never for the Agent, because the pod
holds none (the credential-visibility story above, unchanged). Creating a pull request is a GitHub API call on top: the
human's own `gh` login in their session. An UNATTENDED publish (workflow pushes a branch, opens a PR) is deliberately
absent: it belongs to the Orchestrator, which already holds the git credential and can fetch a branch out of a pod
without one (`ext::kubectl exec … git upload-pack`) — a future decision, not a pod-composition change.

## Sharing `/work` across uids

j2 sets `runAsUser` nowhere — each image's own `USER` decides its seat's uid — so the two writing seats may disagree,
and plain POSIX modes would then make the other seat's files read-only. j2 closes that with two mechanisms it happens to
own, unconditionally (both are inert when the uids already match):

- **The pod carries `fsGroup` — the work group, default `2000`.** The default is convention; the one override lives on
  the `WorkspaceSpec` (`workGroup?: number`, beside `image` and `user` — pod composition is the spec's business,
  ADR-0037), for the image whose session users already hold a gid of their own. Never a config key. Any value is safe
  for the j2 seats: Kubernetes grants the fsGroup as a supplemental group to every container process, so the Harness
  writes `/work` whatever the number, and no image's `/etc/group` needs to know it. fsGroup puts a setgid group on
  `/work`'s root, and setgid propagates down, so everything either seat creates is group-_owned_ by the work group.
- **The attach stamps a default ACL on every repo root it creates** — `u::rwx,g::rwx,o::r-x`, set by `work-acl`, a
  static helper on the runtime volume (part of ADR-0037's published `/opt/j2` surface, static for the same reason `rg`
  is: it executes on a libc j2 does not control). A default ACL is inherited by everything created beneath it, and POSIX
  ignores the process umask where one is present — so every file either seat writes under a repo tree lands
  group-writable (664/775), with **zero lines in any image**: no umask in a login shell, no j2 knowledge in a brought
  User Container. Ownership without writability was the trap — fsGroup alone leaves the other seat group-_read_. On a
  filesystem without POSIX ACL support the helper warns and changes nothing, and sharing degrades to the umask fallback
  below.

Group _membership_ is the one thing an image can still owe. `kubectl exec` sessions and a non-root sshd's logins hold
the work group automatically — both inherit the container's supplemental groups, where Kubernetes put the fsGroup. A
**root** sshd is the exception: the logins it setuids rebuild their groups from `/etc/group`, so that image puts its
session user in the work group itself (`groupadd -g 2000 work && usermod -aG work <user>`) — or the spec points
`workGroup` at a gid its users already hold.

**The promise is scoped to repo trees.** An ad-hoc path at `/work`'s top level — either seat's `mkdir /work/scratch` —
carries no default ACL, so files there fall back to the writer's umask. The Harness runs at `umask 002` (itself and
every tool child) and the attach script opens with the same line, so j2's own writes are group-writable even there; what
a User Container session writes outside a repo tree is its own business.

## Constraints on the seat

The seat is zero-_contract_, not zero-_physics_. What an image brought here must live with:

- **The entrypoint must block.** The pod's restart policy restarts an exited container, so a `CMD` that finishes
  crash-loops. Run a long-lived process — an sshd, an IDE server, `sleep infinity` at minimum.
- **`:8080` and the Adapter's port are taken** — one network namespace. Everything else is the image's.
- **Root is allowed.** The hardened security context (non-root, all capabilities dropped, no escalation) applies to the
  seats j2 owns — Harness and Adapter, per container — and deliberately not here: the seat's identity is "what j2 does
  not own", and hardening it is an opinion. A root sshd that binds `:22` and setuids sessions down to its login user —
  the standard shape for managed access — runs unmodified; a platform that wants this seat hardened hardens its own
  image or its namespace's Pod Security profile. The credential-visibility boundary never depended on this seat being
  unprivileged, only on the Agent executing nothing in it.

## Why separate containers, not one image

- **Image ownership** — the Sandbox Image is the user's (ADR-0037), the Adapter is a tiny j2-owned image, and the User
  Container is whatever its owner wants, contract-free because j2 puts nothing in it. None bloats or constrains the
  others.
- **Independent resource limits** — the agent loop and a heavy interactive session get separate cpu/memory limits, so a
  runaway build in the User Container can't starve the agent (and vice-versa).
- **Lifecycle independence** — a Harness crash restarts only the Harness; an interactive session in the User Container
  survives, and vice-versa.

## What the split is — and is not — a security boundary

The **pod** is the isolation unit (one per Workspace, the k8s north-star): its containers share a kernel, network
namespace, node, and the worktree volume, and are one trust domain in every isolation sense. The one property a
container edge does provide is **credential visibility** — the asymmetry ADR-0013 builds on: the Agent executes code in
the Harness container and none in the others, so a secret that exists only in another container's mount namespace is out
of its reach. That is why the Adapter holds the Orchestrator credential, and it is what the User Container offers a
human session — with its edges stated plainly:

- It holds only for what stays in the private filesystem or session. Anything on `/work` or listening on `localhost` is
  shared with the Agent — the pod has one network namespace.
- A live forwarded agent socket is usable by anything that executes as that session's user in that namespace — so a
  session holding one should not blindly execute what it finds on `/work` (the worktree is agent-authored; sourcing its
  `direnv`, running its scripts, or trusting its `justfile` volunteers the boundary away).
- **It is not port isolation.** The User Container's sshd and the Agent's dev server contend for the same ports.
- **It is not a seat for parallel authorship.** Two writers on one checkout collide as files, whatever the container
  layout; parallel work belongs on a second checkout — fetch the branch out
  (`git fetch "ext::kubectl exec -i <pod> -c harness -- git upload-pack /work/<slot>/default"` needs no credential in
  the pod at all) and push from where the keys already live.

## Considered options

- **No third seat; start services by hand** (`kubectl exec -c harness -- sshd`). Works for a person, rejected as the
  mechanism: a service a managed system relies on cannot depend on a human's exec, and it plants the session's
  credentials in the Agent's own mount namespace.
- **Ephemeral containers as the attach path.** Right for one-off, creds-free debugging (`kubectl debug --target=harness`
  with a plain image), rejected as the standing mechanism: they cannot run from pod birth, accumulate per attach, and
  are spent on exit.
- **A truly minimal Harness** (agent loop only, tools executed in a sibling container) — would need a cross-container
  execution transport j2 does not have. Not blocking: the agent toolchain lives in the Sandbox Image; revisit only if
  that ever becomes a real cost (ADR-0037 records the same rejection from the image side).
- **umask discipline as the sharing mechanism** (fsGroup + `umask 002` in every writer). Rejected as what the promise
  rests on: the Harness's half is one startup line j2 controls, but the User Container's half is a line every image must
  remember (`[ -d /work ] && umask 002` in a login shell) — a gotcha, and a silent one: forgetting it costs nothing
  until the Agent cannot edit a human's file, and the failure reads as the Agent's. It also cuts the other way — a
  session's deliberate `umask 077` under a repo tree would break the sharing the pod exists for; under a default ACL,
  `/work`'s repo trees are definitionally shared. The umask survives as defence in depth, not contract.
- **A root init container stamping the ACL on `/work`'s own root** — complete coverage (no repo-tree scoping), owner
  rights with every capability dropped, kit code only, the standard volume-permissions idiom. Rejected: it puts a
  `runAsNonRoot: false` container in _every_ pod, so no j2 pod could satisfy the Pod Security "restricted" profile —
  today that is forfeited only by a User Container that chooses root, and that choice belongs to the user, not to the
  composition. The attach already owns the only place repo roots are born, so the narrower stamp costs one script line.
- **Unifying uids across seats** (document "make both images run the same `USER`"). Rejected: it makes the uid a
  cross-image contract — every pairing of Sandbox Image and User Container must agree forever, which is exactly the
  coupling the zero-contract seat exists to remove.

## Consequences

- The generic `Sandbox` CRD composes all of this as plain container specs
  ([ADR-0001](0001-operator-owned-generic-sandbox.md) holds — the operator stays agent-agnostic); the Orchestrator's
  `kubectlSandbox` supplies the images. Absent a `user` entry in the spec, the pod runs two containers.
- j2 does not gate readiness on the User Container and never restarts the pod for it; it lives and dies by the pod's own
  policy.
- **Operator**: `runAsNonRoot` moves from the pod level to the two j2-owned containers; the hardened-by-default rule for
  sidecar specs exempts the `user` container; the pod gains `fsGroup` (`spec.workGroup ?? 2000`). **Orchestrator**: the
  attach script stamps the default ACL on each repo root _before_ the clone that fills it — inheritance happens at
  creation, never retroactively. **Harness image**: vendors the static `work-acl` into `/opt/j2/bin` (ADR-0037's
  surface). **Harness**: sets `umask 002` at startup. `shareProcessNamespace` stays off — ever — because the
  credential-visibility boundary depends on it.
- The Harness container's `/work` writes being group-writable widens nothing: every process that could abuse group
  access already runs in the same trust domain, and the work group exists only inside this pod.
- **Routable access is a follow-up, deliberately untaken**: the operator's Service serves the Harness at `:8080`, and a
  managed system wanting cluster-routed ssh to the User Container needs a declared port there. `kubectl port-forward`
  reaches any listener in the pod without one, which covers the human case day one.
- **CONTEXT.md**: **User Container** is a glossary term.
