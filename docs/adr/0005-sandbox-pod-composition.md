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
- **User Container** — opt-in third seat, composed only when the `workspace()` spec names its image (a discovered
  `images/<name>` dirname or a registry ref, the same resolution as the Sandbox Image, no default). The whole authoring
  surface is that one string — `user?: string` on the `WorkspaceSpec`, beside `image` — and deliberately no more: env,
  resources, and ports are not forwarded, because every key j2 forwarded would be a crack in "j2 puts nothing in it";
  widening the string to an object stays compatible if a concrete need ever argues its own way in (the routable-port
  follow-up below is the known candidate). In the pod it is the container named `user` (`kubectl exec -c user`). It runs
  its **own entrypoint, untouched**: j2 injects nothing, probes nothing, and overrides nothing — the zero-contract seat,
  which is exactly why it exists. Two jobs no other seat can do:
  - **Unattended services.** A container's one command belongs to the Harness in the primary seat (ADR-0037), so an
    image's own services — an sshd for managed access, an IDE server, a metrics agent — need a container whose command
    j2 deliberately does not own. A system built _on_ j2 that hands people access to their Sandboxes automates through
    this seat.
  - **Credential visibility.** A session's secrets — a forwarded ssh agent socket above all — live in this container's
    private mount namespace, where the Agent executes nothing. The human sshs in with agent forwarding, works, and the
    socket is gone on disconnect; at no point does it share a filesystem with code the Agent runs.

The Harness and User containers mount `/work` read-write, so human and agent see identical files. The Adapter mounts no
worktree — the pod's credential holder has no business in the working tree.

## Sharing `/work` across uids

j2 sets `runAsUser` nowhere — each image's own `USER` decides its seat's uid — so the two writing seats may disagree,
and POSIX permissions would then make the other seat's files read-only. j2 closes that with the two knobs it happens to
own, unconditionally (both are inert when the uids already match):

- **The pod carries `fsGroup` — the work group, default `2000`.** The default is convention; the one override lives on
  the `WorkspaceSpec` (`workGroup?: number`, beside `image` and `user` — pod composition is the spec's business,
  ADR-0037), because a _brought_ image (a registry ref) cannot take the two setup lines below — its whole value is zero
  rebuild — so its escape is pointing the work group at a gid its session users already hold, which also shrinks the
  image's half of the setup to the umask alone. Never a config key. Any value is safe for the j2 seats: Kubernetes
  grants the fsGroup as a supplemental group to every container process, so the Harness writes `/work` whatever the
  number, and no image's `/etc/group` needs to know it — group _names_ matter only to sshd logins, which rebuild their
  groups from the file. fsGroup puts a setgid group on `/work`'s root, and setgid propagates to every directory created
  under it.
- **The Harness runs at `umask 002`**, itself and every tool child, so everything the Agent writes lands group-writable
  (664/775) for the work group all the way down — fsGroup without the umask half is group-_read_, which is the trap.

A User Container whose sessions run a different uid then needs two lines in its own image, documented and never
enforced: put the session user in gid 2000 (`groupadd -g 2000 work && usermod -aG work <user>` — membership must be in
`/etc/group`, because a login wipes inherited supplemental groups) and set `umask 002` in the login shell, which covers
the reverse direction: files the human creates that the Agent must edit. Same-uid seats need nothing. Two umask caveats,
both edge-shaped: sshd's `StrictModes` refuses logins over a group-writable `~/.ssh`, so it bites only a session that
_regenerates_ those files from a loosened shell; and the shell line belongs scoped to the pod
(`[ -d /work ] && umask 002`), not unconditionally in dotfiles that also stow onto other machines.

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
  (`git fetch "ext::kubectl exec -i <pod> -c harness -- git upload-pack /work/<repo>"` needs no credential in the pod at
  all) and push from where the keys already live.

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

## Consequences

- The generic `Sandbox` CRD composes all of this as plain container specs
  ([ADR-0001](0001-operator-owned-generic-sandbox.md) holds — the operator stays agent-agnostic); the Orchestrator's
  `kubectlSandbox` supplies the images. Absent a `user` entry in the spec, the pod runs two containers.
- j2 does not gate readiness on the User Container and never restarts the pod for it; it lives and dies by the pod's own
  policy.
- **Operator**: `runAsNonRoot` moves from the pod level to the two j2-owned containers; the hardened-by-default rule for
  sidecar specs exempts the `user` container; the pod gains `fsGroup` (`spec.workGroup ?? 2000`). **Harness**: sets
  `umask 002` at startup. `shareProcessNamespace` stays off — ever — because the credential-visibility boundary depends
  on it.
- The Harness container's `/work` writes being group-writable widens nothing: every process that could abuse group
  access already runs in the same trust domain, and the work group exists only inside this pod.
- **Routable access is a follow-up, deliberately untaken**: the operator's Service serves the Harness at `:8080`, and a
  managed system wanting cluster-routed ssh to the User Container needs a declared port there. `kubectl port-forward`
  reaches any listener in the pod without one, which covers the human case day one.
- **CONTEXT.md**: **User Container** is a glossary term.
