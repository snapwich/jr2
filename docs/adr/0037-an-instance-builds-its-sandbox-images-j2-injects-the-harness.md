# A Sandbox Image is built or brought; j2 injects the Harness at pod time

Working tools execute in the Harness container
([ADR-0027](0027-the-harness-is-j2s-own-server-flue-retires-the-wire-stays.md),
[ADR-0028](0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md)), so the tools an Agent can reach
are whatever that image carries — a toolchain is the one part of a Sandbox a user genuinely owns. Users own toolchains
in two shapes: a Dockerfile the instance iterates on locally, and an image already baked, versioned, and hosted on their
own registry. j2's runtime must live in the same filesystem either way, and the constraint that decides the mechanism is
ownership: the user's image must stay the user's — zero j2 layers, zero rebuild, zero opinions about its `USER`, `HOME`,
or entrypoint. Any build-time modification makes "bring your own image" impossible (j2 becomes the owner of every build)
and promotes incidental image properties into contract items.

## Decision

- **Two origins, one meaning.** `images/<name>/Dockerfile` is a Sandbox Image — a directory per image, dirname = name,
  discovered like `agents/` and `workflows/` (filename-discovery stays the one registration mechanism). The build
  context is **that directory**, so the content hash covers exactly what the build can see and a workflow edit
  invalidates no image; there is no cross-image `FROM`. `j2 up` builds it, content-tags it, and delivers it
  ([ADR-0038](0038-j2-up-builds-every-image-it-deploys.md)). **Or a registry ref**: a `workspace()` spec's `image` may
  name an image j2 never builds — baked and hosted by the user, pulled by the cluster, its tag discipline its owner's.
  The two are distinguishable by shape (a ref contains `/` or `:`; a dirname cannot). Resolution is: spec `image` →
  `images/default` → stock `j2-harness:<kitversion>`. `j2 init` scaffolds `images/default/Dockerfile`, which is what
  makes the fallback a visible convention rather than magic. An unknown dirname fails loudly at provision, listing what
  was discovered — a converge-time check is impossible because workflow internals are not statically recoverable
  ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md) drew this line).
- **The Harness arrives by volume, never by build.** The operator composes every Sandbox with an `/opt/j2` volume,
  populated from the kit's harness image by an init container, and overrides the primary container's **command** to
  start the Harness. The image the pod runs is the user's, byte-for-byte: no appended layers, no rewritten Dockerfile,
  no j2 knowledge inside it. Its own `USER` and `HOME` are respected — the human who execs in lands in the environment
  the image's author built, dotfiles included; its `ENTRYPOINT`/`CMD` simply do not run, because a container has one
  command and the Harness must own it (its death must be the container's death — the Ready probe and restart semantics
  are the operator's contract at `:8080`). A **built** image that declares no user runs as uid 1000 with `HOME=/home/j2`
  on an emptyDir as the fallback — j2 learns "declares none" for free at build time (`docker inspect`) and records it
  beside the ref. A **brought** ref is never inspected — that is the point of refs — so the fallback cannot apply: a ref
  must declare a numeric non-root `USER` itself, and one that would run as root fails at provision with an error that
  names that line (never as the kubelet's silent `CreateContainerConfigError`). A process the image _wants_ running is
  not lost — it has its own seat, the User Container ([ADR-0005](0005-sandbox-pod-composition.md)).
- **PATH is appended at the process level, never prepended.** The Harness exports `PATH="${PATH}:/opt/j2/bin"` for
  itself, and Working tools spawn without an env override (`execFile(file, args, { cwd, signal })`), so children inherit
  it: the image's `node`, `rg`, and toolchain win where present and j2's are the fallback; prepending would silently
  shadow a pinned toolchain inside the user's own image. The same process-level discipline carries `umask 002`: the
  Harness sets it at startup so even what it writes _outside_ a repo tree stays group-writable for the pod's work group.
  Inside the repo trees the umask stops mattering — the attach stamps a default ACL on each repo root and POSIX ignores
  the umask where one exists ([ADR-0005](0005-sandbox-pod-composition.md)); this is the defence-in-depth layer, inert
  when no other uid ever writes.
- **The contract is the floor, and the preflight proves it.** What is inherent to "j2's runtime in your filesystem" and
  nothing more: a **glibc** base no older than the one j2's node was built against (musl is out entirely), **`git`** on
  the system PATH (relocating git means `/usr/lib/git-core`, templates, `git-remote-https` → curl + openssl + CA store —
  a rabbit hole, and the agent wants the git you chose), a writable `HOME` for the image's user (the attach script
  writes `$HOME/.gitconfig`, and any real toolchain needs `~/.npm`, `~/.cargo`, `~/.cache`), and `/opt/j2`, `/work`,
  `:8080` unclaimed. j2 vendors the rest: **ripgrep** as its official static-musl binary and node's
  `libstdc++.so.6`/`libgcc_s.so.1` into `/opt/j2/lib`. The probe is one command —
  `git config --global safe.directory "*" && /opt/j2/bin/node -e "" && rg --version` — and it runs **only where the seat
  is known: as an init step in the user's own image**, `/opt/j2` mounted, before the Harness starts. It cannot run at
  converge: the floor is a Harness-seat obligation, a built `images/<name>` may equally be destined for the User
  Container seat — which owes no floor at all (ADR-0005) — and which seat a directory serves is workflow-internal and
  statically unrecoverable (ADR-0031, the same line that puts unknown names at provision). So a broken toolchain image
  surfaces at its first provision, in the `preflight` init container's log, with an error that names the fix (because
  "node did not execute" is not actionable) — never as a mid-turn tool failure, and never as a converge refusal for a
  contract the image was not under.
- **A `workspace()` spec names the image; workflow configuration never enters the spec, but pod composition does** —
  what the Sandbox is _made of_ is the wrapper's business in the same way its worktrees are. The User Container rides
  the same rule and the same resolution as one more string beside `image` (`user?: string`,
  [ADR-0005](0005-sandbox-pod-composition.md)). A persisted snapshot never holds a resolved content-addressed tag — that
  is the port's business at provision — but a user's own registry ref is a stable name like a dirname, so either shape
  of `image` may live in a spec.
- **A Menu-only Agent never gets a Sandbox Image.** `workspace: "none"` withholds the entire Working toolset (ADR-0028),
  so there is no tooling to carry; the Instance Harness (ADR-0031) runs the stock image permanently. The feature has
  exactly one seat, and it is the Workspace.

## Considered options

- **A build-time wrap** — j2 builds a kit-owned stage `FROM` the user's image (`COPY /opt/j2`, `USER 1000`,
  `HOME=/home/j2`, `CMD` = the Harness). Rejected on four counts. It makes j2 the owner of every Sandbox Image build, so
  an image baked and hosted by the user cannot exist — the registry-ref origin is unimplementable. It promotes
  non-inherent properties into contract (`USER 1000` forced, `HOME=/home/j2` forced, "your image must not set
  `ENTRYPOINT`") where the inherent floor is only glibc + git + a writable home. It couples every Sandbox Image tag to
  the resolved harness ref (the wrap is `COPY --from=<harness>`), so a kit source edit re-tags, rebuilds, and
  re-delivers every user image on the cluster. And it needs an intermediate tag between the user's build and the wrap
  build — a mutable shared name that serializes concurrent converges of one checkout, a problem space that exists only
  because the wrap does.
- **The user layers on j2** (`FROM j2-harness:<kitversion>`). Simplest, and the contracts come inherited. Rejected: it
  pins every instance to j2's debian/node base forever — you could never start from `golang:1.23` or a company base
  image, which is the entire feature.
- **j2 installs the missing floor packages into the image.** Rejected: package-manager sniffing
  (`apt`/`apk`/`dnf`/`zypper`/`pacman`) is a fragile shell ladder, distroless and scratch have no shell at all, the
  `apk` branch is pointless because musl breaks node regardless, and reaching the network to mutate someone's image
  behind their back fails in exactly the proxied enterprise environments where it is least debuggable. Vendoring covers
  the same ground without any of it.
- **A published `j2-base:<kitversion>` for the scaffold to start from.** Rejected: a fourth image on the release train
  that re-couples the user's Dockerfile to a j2 tag. It would also absorb a future contract change silently, when a
  contract change should be loud in every instance.
- **Cross-container tool execution** — the Harness in its own kit-owned container, Working tools exec'd into a sibling
  running the user's image, making that image truly zero-contract. Rejected: it requires a cross-container execution
  transport j2 does not have, bought only to delete a floor (glibc + git) that most real images already clear by
  accident.
- **Keeping the image's own `CMD` as the container's main process** (the Harness as a second process, or supervised by
  the user's entrypoint). Rejected: the container's lifecycle must be the Harness's — a pod whose main process is the
  user's entrypoint keeps "Running" through a Harness death, which makes the operator's Ready probe and restart
  semantics lies. Unattended services belong in the User Container (ADR-0005), whose command j2 deliberately does not
  own.
- **The Agent definition or an `agentRun` dial names the image.** Rejected on both doctrine and physics: available
  tooling is what an Agent may _do_ (ADR-0028 territory, identity — only `model` and `thinkingLevel` are dials,
  ADR-0018), and a Turn cannot change the image of a pod that already exists. A definition-level _assertion_ ("this
  Agent requires image X, fail at admission if its Workspace provisioned another") stays available later.

## Consequences

- **The runtime's version rides the volume, not the image.** A kit edit moves the harness image's own tag and re-images
  _future_ pods without touching any Sandbox Image tag — the only way a registry-ref image could ever follow a kit
  update. Live Sandboxes keep the runtime they started with, the same create-if-absent stance ADR-0038 takes for images.
- **A registry ref sits outside the build-and-label world**: never built, never labeled, never swept
  ([ADR-0039](0039-image-garbage-collects-by-reachability.md) — what j2 did not stamp, j2 does not touch). Its pull is
  the cluster's own; a mutable ref is its owner's stale-image risk, named here, not solved.
- **Concurrent converges of one checkout share no mutable image name** — a Sandbox Image build is one `docker build`
  straight to its content tag, with no intermediate tag at all. The `@kind` tier's `--parallel` rides on this
  ([ADR-0010](0010-bdd-acceptance-tests.md)).
- **A human exec-ing the Harness container inherits the agent's model credentials.** The person exec-ing is the instance
  owner, so this is an accepted trade — and the User Container (ADR-0005) or `kubectl debug` with a plain image is the
  creds-free shell in the same pod when it matters.
- **A glibc floor.** Bases older than the one j2's node was built against fail the preflight, and alpine/musl is out
  entirely. Named in the error — at converge for a built image, at provision for a ref — not discovered in a pod log.
- **The stock Harness image is also the injection source**: the init container that populates `/opt/j2` runs it, and it
  carries the vendoring step (static ripgrep per `TARGETARCH`, the two relocated C++ runtime libraries).
- **`images/` is instance-local by design.** A built Sandbox Image travels as a folder to copy; a shared one travels as
  a registry ref — which is now a first-class origin, so sharing needs no further mechanism.
- **CONTEXT.md**: **Sandbox Image** covers both origins; **Harness** names the runtime as mounted, not baked; **User
  Container** is defined by ADR-0005.
