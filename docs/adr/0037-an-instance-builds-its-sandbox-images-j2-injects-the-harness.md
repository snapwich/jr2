# An instance builds its Sandbox Images; j2 injects the Harness

Working tools execute in the Harness container
([ADR-0027](0027-the-harness-is-j2s-own-server-flue-retires-the-wire-stays.md),
[ADR-0028](0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md)), so the tools an Agent can reach
are whatever that image happens to carry — today `node:24-slim` plus `git` and `ripgrep`
([ADR-0018](0018-instance-agents-are-definitions-j2-assembles-the-harness.md)). A workflow whose agents need `cargo`, a
Go toolchain, `psql`, or a company CLI has nowhere to put them. `images.user` was not the seat: the User Container
([ADR-0005](0005-sandbox-pod-composition.md)) is where a _human_ works, and no Working tool runs there.

ADR-0018 declared the Harness image stock and published because its content was 100% kit mechanism plus a JSON's worth
of persona. A toolchain is not that — it is the one part of a Sandbox a user genuinely owns. So the premise of that
bullet expires here, while its reasoning survives inverted: the kit still owns every line of the runtime, it just stops
owning the base it runs on.

## Decision

- **`images/<name>/Dockerfile` is a Sandbox Image** — a directory per image, dirname = name, discovered like `agents/`
  and `workflows/` (filename-discovery stays the one registration mechanism). The build context is **that directory**,
  so the content hash covers exactly what the build can see and a workflow edit invalidates no image. There is **no
  cross-image `FROM`**: j2 does not topologically sort image builds, and multi-stage `FROM` inside one Dockerfile
  already covers what people actually want.
- **The Dockerfile has zero j2 knowledge.** Any base, any tools, no `ARG`, no `FROM j2-harness`. `j2 up` builds it, then
  builds a second, kit-owned stage on top of the result — the **wrap**:

  ```dockerfile
  FROM <the image images/<name>/Dockerfile just built>
  COPY --from=<the resolved harness ref> /opt/j2 /opt/j2
  USER root
  RUN mkdir -p /home/j2 && chown 1000:0 /home/j2 && chmod 0775 /home/j2
  ENV HOME=/home/j2 PATH="${PATH}:/opt/j2/bin"
  WORKDIR /work
  USER 1000
  CMD ["/opt/j2/bin/node", "/opt/j2/src/main.ts"]
  ```

  Two builds off one hash, the user's file never rewritten. Every line above is load-bearing:

  - **`/opt/j2`, not `/app`** — the stock image's `WORKDIR /app` would shadow an `/app` the user's base already uses.
    The stock image moves to `/opt/j2` too, so there is one layout, not two.
  - **PATH is _appended_, never prepended.** Working tools spawn without an env override
    (`execFile(file, args, { cwd, signal })`), so children inherit the Harness process env. Appending means the user's
    `node`, `rg`, and toolchain win where present and j2's are the fallback; prepending would silently shadow a pinned
    toolchain inside the user's own image.
  - **`HOME=/home/j2`, created at build.** The attach script's first line is `git config --global safe.directory '*'`,
    which writes `$HOME/.gitconfig`; the operator sets `RunAsNonRoot` but no `runAsUser`, so the image's `USER 1000` is
    what satisfies it — and a minimal base has no uid 1000 and no home, making every attach fail with
    `fatal: $HOME not set`. The agent's own toolchain needs a home anyway (`~/.npm`, `~/.cargo`, `~/.cache`), which is
    the deciding argument: an image whose purpose is "the tools your agents need" with no writable home is broken for
    most real toolchains, and it breaks _inside a turn_, as a tool failure the model must interpret.
  - **An image layer, not a volume.** A mount at `/home/j2` would shadow dotfiles baked into the image; this way
    `COPY dotfiles/ /home/j2/` works.
  - **`WORKDIR /work`** is for the human. It has no effect on the Agent — every Working tool takes an explicit cwd from
    the definition (`def.cwd ?? "/work"`) and the Harness process's own cwd is never consulted. With the User Container
    gone, `WORKDIR` is where `kubectl exec` lands, so it points at the worktree root.

- **Two contracts, one preflight, hard failure.** j2 vendors what it can: **ripgrep** as its official static-musl binary
  (zero deps, any base) and node's `libstdc++.so.6`/`libgcc_s.so.1` into `/opt/j2/lib`. What remains is **`git`**
  (relocating git means `/usr/lib/git-core`, templates, `git-remote-https` → curl + openssl + CA store — a rabbit hole,
  and the agent wants the git you chose) and a **glibc base** no older than the one j2's node was built against (copying
  libstdc++ does not rescue a base whose libc is older). `j2 up` proves all of it in one run per changed image, and
  refuses to converge on failure:

  ```sh
  docker run --rm --user 1000 <wrapped-image> \
    sh -c 'git config --global safe.directory "*" && /opt/j2/bin/node -e "" && rg --version'
  ```

  git present · `$HOME` writable as uid 1000 · glibc + libstdc++ · ripgrep. The error names the fix, because "node did
  not execute" is not actionable.

- **`workspace(body, spec)` names the image; resolution is: spec `image` → `images/default` → stock
  `j2-harness:<kitversion>`.** `j2 init` scaffolds `images/default/Dockerfile`, which is what makes the fallback a
  visible convention rather than magic. An unknown name fails loudly at provision, listing what was discovered — a
  converge-time check is impossible because workflow internals are not statically recoverable
  ([ADR-0031](0031-menu-only-agents-run-on-the-instance-harness.md) drew this line). `WorkspaceSpec`'s "workflow
  configuration never enters the spec" rule widens to admit pod composition: what the Sandbox is _made of_ is the
  wrapper's business in the same way its worktrees are.

- **The User Container is deleted** — `images.user`, the `user` sidecar, and the "your entrypoint must block" contract
  with it, superseding that part of ADR-0005. The wrap already ate it: a Sandbox Image is the user's tools _plus_ the
  Harness, so `kubectl exec` into the Harness container gives a human the agent's tools, worktrees, and filesystem.
  ADR-0005's promise — human and agent see identical files — is now delivered by the image rather than by a second
  container sharing a volume with it.

- **A Menu-only Agent never gets a Sandbox Image.** `workspace: "none"` withholds the entire Working toolset (ADR-0028),
  so there is no tooling to carry; the Instance Harness (ADR-0031) runs the stock image permanently. The feature has
  exactly one seat, and it is the Workspace.

## Considered options

- **The user layers on j2 (`FROM j2-harness:<kitversion>`).** Simplest, and the contracts come inherited. Rejected: it
  pins every instance to j2's debian/node base forever — you could never start from `golang:1.23` or a company base
  image, which is the entire feature.
- **The wrap installs the missing packages.** Rejected: package-manager sniffing (`apt`/`apk`/`dnf`/`zypper`/`pacman`)
  is a fragile shell ladder, distroless and scratch have no shell at all, the `apk` branch is pointless because musl
  breaks node regardless, and reaching the network to mutate someone's image behind their back fails in exactly the
  proxied enterprise environments where it is least debuggable. Vendoring covers the same ground without any of it.
- **A published `j2-base:<kitversion>` for the scaffold to start from.** Rejected: a fourth image on the release train
  that re-couples the user's Dockerfile to a j2 tag — the coupling the wrap exists to remove. It would also absorb a
  future contract change silently, when a contract change should be loud in every instance.
- **`HOME` as an emptyDir, or `HOME=/work`.** Both make the home writable with no `RUN` (an emptyDir lands 0777), and
  `HOME=/work` even works on a shell-free base. Rejected: a mount shadows dotfiles baked into the image, and `/work`
  scatters `.npm`/`.cargo`/`.gitconfig` through the worktree root. `HOME=/work` stays the fallback if a shell-free base
  ever matters.
- **Refactoring the attach to need no `$HOME`** (`GIT_CONFIG_GLOBAL=/work/.gitconfig` — which relocates _global scope_
  rather than bypassing it, so `safe.directory` is still honored, unlike `-c`). Genuinely works, and rejected because it
  buys nothing: the agent's toolchain needs a home anyway, so this is a second mechanism for a problem the first already
  solved.
- **The Agent definition or an `agentRun` dial names the image.** Rejected on both doctrine and physics: available
  tooling is what an Agent may _do_ (ADR-0028 territory, identity — only `model` and `thinkingLevel` are dials,
  ADR-0018), and a Turn cannot change the image of a pod that already exists. A definition-level _assertion_ ("this
  Agent requires image X, fail at admission if its Workspace provisioned another") stays available later; it is not
  worth building before a second image exists.
- **One Sandbox pod running several Harness containers, one per image.** The generic sidecar list (ADR-0001) would carry
  them, but the Service and Ready probe are operator-owned at `:8080`, so per-image endpoints mean an operator change
  and an endpoint _map_ in the ambient handles. Rejected until a Workspace genuinely needs two toolchains on one
  worktree at once.

## Consequences

- **A human exec-ing the Harness container inherits the agent's model credentials.** The separate User Container was
  what kept `harness.env`/`envFrom` off a human shell. The person exec-ing is the instance owner, so this is an accepted
  trade rather than a regression to fix — and `kubectl debug --target=harness` with a plain image is the creds-free
  shell in the same pod and namespaces when it matters.
- **A glibc floor.** Bases older than the one j2's node was built against fail the preflight, and alpine/musl is out
  entirely. Named in the error, not discovered in a pod log.
- **The stock Harness image gains a vendoring step** — fetch static ripgrep per `TARGETARCH`, relocate the two C++
  runtime libraries. Kit-side complexity paid once, to delete two contracts from every instance forever.
- **A Sandbox Image's content hash must include the resolved harness ref**
  ([ADR-0038](0038-j2-up-builds-every-image-it-deploys.md)), since the wrap is `COPY --from=<harness>`. Without it,
  editing `packages/harness/src` leaves every Sandbox Image tag unchanged and pods keep the old runtime.
- **`images/` is instance-local by design.** A Sandbox Image travels as a folder to copy, not as an npm package like a
  reusable workflow or Agent (ADR-0019). If sharing them ever matters, it is a separate decision.
- **CONTEXT.md**: **Sandbox Image** becomes a glossary term; **User Container** is removed; **Harness** names the
  injected runtime beside the stock image.
- **The wrap's intermediate `-base` tag is a shared global name, so one checkout cannot be converged concurrently.** The
  two-stage build tags what `images/<name>/Dockerfile` produced as `j2-sandbox-<instance>-<name>-base:<hash>` and wraps
  it, then untags it — and because the hash is a content address
  ([ADR-0038](0038-j2-up-builds-every-image-it-deploys.md)), every concurrent converge of the same checkout resolves the
  SAME intermediate. Two failures follow: the second untag finds it gone (absorbed — the removal is delete-if-present,
  as ADR-0039 requires of both stores), and an untag that lands while another converge's wrap is resolving
  `FROM <baseTag>` fails that build outright (not absorbable — the image the build needs is gone). This is what makes
  the `@kind` tier serial rather than `--parallel` ([ADR-0010](0010-bdd-acceptance-tests.md), with the measurements).
  The fix is a per-converge-unique intermediate name: it is never delivered, never registry-prefixed, and untagged on
  success, so uniqueness costs no documented property — but it is a naming decision and is deliberately not taken here.
  **Taken by [ADR-0040](0040-the-wraps-intermediate-is-scratch-a-converge-names-its-own.md)**, which names the base per
  converge and unlocks `--parallel` for the `@kind` tier (the wired degree is ADR-0010's).
