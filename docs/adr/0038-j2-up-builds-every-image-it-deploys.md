# `j2 up` builds every image it deploys

[ADR-0019](0019-one-converging-command-against-the-current-context.md) promised one converging command, but `j2 up`
builds exactly one image — the instance's. The Harness, Adapter, and operator images come from `just` recipes at
**mutable tags** (`j2-harness:local`), pointed at by `images` overrides in `j2.config.ts`. Nothing can detect that a
mutable tag moved, so editing `packages/harness/src` and running `j2 up` reports convergence onto pods running last
week's code — the failure the instance image already fixed for itself by hashing the materialized bundle rather than the
source folder. [ADR-0037](0037-an-instance-builds-its-sandbox-images-j2-injects-the-harness.md) would add a second class
of build-it-yourself-first image on top of that.

## Decision

- **Every image `j2 up` deploys, `j2 up` builds — when its source is visible.** The CLI detects a kit checkout by
  resolving from its own module URL and requiring _both_ `deploy/harness/Dockerfile` and `packages/harness/package.json`
  naming `@j2/harness`. In a checkout it builds the Harness, Adapter, and operator images; installed from npm those
  paths do not resolve, so a real instance takes the published-`<kitversion>` path and never needs docker for kit
  images. **The checkout is the signal** — no flag, no config key, no env. The `just` recipes survive as shortcuts for
  building one image without a converge, never as prerequisites. A registry-ref Sandbox Image (ADR-0037) is the one
  deployed image whose source is nobody's here: never built, labeled, or delivered by j2 — the cluster pulls it, and its
  tag discipline is its owner's.
- **Every tag is a content address.** Instance, Sandbox, Harness, Adapter, operator — each addressed by its own inputs
  and its platform set, the platform as a visible tag suffix
  ([ADR-0045](0045-the-platform-joins-the-image-address-and-the-cluster-chooses-it.md)). Three things follow:
  `imagePullPolicy: IfNotPresent` becomes _correct_ rather than lucky (a unique tag per content means "present" implies
  "current"), which is what makes kind and a real cluster behave identically instead of needing `Never` on one and
  `Always` on the other; a kit source edit moves its own image's tag with no bookkeeping; and skipping is exact.
- **Over-hash deliberately.** A kit image is hashed over its whole source directory, tests included, not over the exact
  file list its Dockerfile copies. Deriving the list by hand means a new `COPY` silently desynchronizes it, which is the
  invisible-stale-image bug being deleted; a needless rebuild in kit dev costs cached-layer seconds. **A Sandbox Image's
  hash covers its `images/<name>/` directory alone** — the Harness rides the pod's `/opt/j2` volume (ADR-0037), so a kit
  edit moves the harness image's own tag and touches no Sandbox Image tag.
- **A staged bundle records nothing about where or when it was staged.** The instance image's tag addresses the
  materialized bundle, so anything in that bundle that names its own scratch directory — or the minute it was written —
  makes one tag name many images, and "present implies current" stops being true for the one image every Instance runs.
  `pnpm deploy` writes both: each `.bin` shim bakes the staging path into `NODE_PATH`, and `node_modules/.modules.yaml`
  is nothing but a record of where and when. So the bundle is **sealed** before it is hashed — the staging path is
  rewritten to `/instance`, the `WORKDIR` the image actually holds it at, so the shims go from _wrong_ to _correct_
  rather than merely stable; `.modules.yaml` is deleted, beside the `images/` deletion that already precedes the hash.
  (**Amended by [ADR-0043](0043-the-kit-is-tested-as-installed-a-local-registry-stands-in-for-npm.md)**: the bundle is
  `pnpm deploy`'s only for a workspace-member instance; a standalone one is a staged copy plus a frozen lockfile
  install, whose shims name no absolute path — but whose pnpm branch leaves a second where-and-when record,
  `node_modules/.pnpm-workspace-state.json`, deleted with `.modules.yaml`.) A non-UTF-8 file holding the path is a loud
  failure, never a blind rewrite. **Nothing is excluded from the hash any more.** The old exclude set named exactly the
  files that varied, so the tag stood still while the bytes moved and the mechanism that should have exposed the drift
  was the one hiding it; with an empty set the failure inverts — a bundle that ever varies again re-tags on every
  converge, in the open, where a rebuild-and-reload every single time is impossible to miss.
- **One transport branch for all of them**, the one the instance image already uses: `registry` configured → push; kind
  context → `kind load`; neither → fail loudly naming `registry`. `j2 up` records the converged name→ref map as an
  annotation on the Orchestrator Deployment and diffs it, so a steady-state converge spends a directory walk and no
  docker at all. **Amended by [ADR-0041](0041-a-build-the-host-already-holds-is-not-spent-again.md)**: when the record
  is silent (a fresh namespace), the host daemon's own labeled listing answers the _build_ question — the seal below is
  what made "present implies current" true enough to ask it — while the record keeps answering the delivery one.
- **The resolved name→ref map reaches the Orchestrator as a ConfigMap, read per provision — never as Deployment env.**
  Env is a pod-template change, so every Dockerfile edit would roll the Orchestrator and put every live run through
  snapshot restore ([ADR-0007](0007-durable-machine-state.md)) for a change that affects only _future_ Sandboxes. The
  map is data consulted when creating a pod, not configuration defining the process. The cost is a stale-read window of
  one kubelet propagation after `j2 up`, and that two workspaces provisioned seconds apart can straddle a change — which
  was already true across a roll.
- **The `images` config block is deleted outright — no key, no env escape hatch.** Its `harness`/`adapter`/`operator`
  entries were kit-dev overrides that auto-build now covers; the User Container is composed per Workspace by the
  `workspace()` spec, not by config (ADR-0005), so no `user` entry belongs here either. Nobody should be able to run a
  patched Harness against a real cluster: that is ADR-0027's "no eject hatch" enforced rather than merely stated.
- **`j2 up` reports live workspaces on an older image; it never re-images one.** Provision is create-if-absent, so a
  running Sandbox keeps the image its CR was created with — the only safe behavior, since replacing the pod takes the
  worktrees and unpushed commits with it, which is precisely the Continuity break
  [ADR-0021](0021-workspace-continuity-is-a-lease-that-answers-back.md) exists to report. So the converge lists them
  (`kubectl get sandboxes`, no new state) and stops: _"2 running workspaces keep `…:9c1e02`; new workspaces use
  `:4a77b1`; delete these runs to re-image."_
- **`j2 down` prunes this instance's images from kind nodes by default** — **superseded by
  [ADR-0039](0039-image-garbage-collects-by-reachability.md)**, which replaces name-scoped, down-only pruning with a
  label-scoped reachability sweep at both `up` and `down`, host daemon included. Kept as written for the record: scoped
  to EXACT repo names: `j2-instance-<name>:*` plus, per discovered `images/<x>/`, `j2-sandbox-<name>-<x>:*` and its
  `-base` intermediate (matched after stripping containerd's `docker.io/library/` namespace, which `kind load`
  normalizes local tags into — and nothing else, so a registry-pushed tag keeps its host and stays unmatched). Exact
  names, never one open-ended `j2-sandbox-<name>-` prefix, which also matches instance `<name>-extra`'s images on a
  shared node. Removal is planned **per image id**: `crictl rmi` cannot untag — it resolves any tag to the id and takes
  the whole image, every tag with it — so an id is removed only when every tag on it is this instance's, and an id
  sharing tags with anyone else (two instances whose image inputs are byte-identical produce one id) is kept whole and
  reported. Content addressing means ten Dockerfile iterations leave ten full images in the node's containerd, invisible
  to `kubectl` and on the developer's own disk. **Kit images are never pruned** — they are shared by every instance on
  the cluster — and neither are registry-pushed tags. The accepted remainder: deleting an `images/<x>/` folder orphans
  that image's already-loaded tags (nothing derives their names any more); they go with the cluster, or by hand.
- **No `repos`, no Sandbox Image builds.** A non-empty `repos` is already the data-plane switch (ADR-0012/0031): a
  workspace-less instance has no Sandboxes, so it must not pay a docker build for a scaffolded `images/default/` it can
  never use.

## Considered options

- **An env escape hatch for kit image refs** (`J2_HARNESS_IMAGE`, …), kept for the `@kind` tier, which pins
  `j2-harness-dev:local`. Rejected once the stub was read properly: `deploy/harness-dev/` is a whole alternate Harness —
  the stub plus a hand-rolled MCP client — written when "flue's real Harness image is not part of this repo," which
  ADR-0027 made false. The substitution belongs at the **provider**, not the image: `harness.provider` already accepts
  any OpenAI-compatible `baseUrl`, so pointing `@kind` at a scripted model endpoint runs the **stock** Harness and
  removes the last consumer of image substitution.
- **The ref map as Deployment env** (symmetric with `J2_AGENTS_JSON`). Attractive because a run's Sandbox image becomes
  a deterministic function of the Orchestrator generation instead of a read-at-a-moment. Rejected on the roll: bouncing
  every run in flight because someone added a CLI to a Dockerfile is the wrong trade.
- **A `--reimage` flag** that deletes and re-provisions live Sandboxes. Rejected: it destroys unpushed work, and the run
  already has a designed path for losing its Sandbox (`workspace.lost`, ADR-0021) that the workflow's policy drives —
  not the CLI.
- **Hashing only the files each Dockerfile copies**, or hashing the whole kit tree via git. The first desynchronizes
  silently; the second rebuilds all three images on any edit anywhere. Per-image directory hashing sits between them and
  errs toward rebuilding.
- **pnpm's hoisted node linker** (`deploy --node-linker=hoisted`), which emits no absolute path at all and so needs no
  seal. Verified to work and to leave the artifact all but identical (60 MB vs 62 MB, 3998 vs 4029 files). Rejected on
  exposure, not on merit: `pnpm deploy` calls itself experimental and j2 already pins `--legacy`, so a third deviation —
  one that changes the `node_modules` layout of every deployed image on every cluster — buys nothing the seal does not.
  The seal changes no pnpm behavior; it corrects strings pnpm wrote for a directory the image never sees.
- **A `.dockerignore` derived from the exclude set.** Rejected: it deletes the shims, and pnpm's shims `exec` through a
  relative `$basedir` — they WORK in the container. An Instance whose dependency ships a CLI would lose it. The four
  varying files are content the image should keep, holding a path that is simply wrong.
- **Freezing the staging path** (a stable scratch dir instead of `mkdtemp`). Rejected twice over: it freezes the wrong
  path rather than fixing it, and it makes the bundle a function of `TMPDIR` and the instance's location — the same
  inputs would yield different bytes in CI than on a laptop, which is the property this decision exists to establish. It
  also collides when one Instance folder is converged concurrently.
- **`pnpm deploy` inside the Dockerfile**, so the bundle is materialized at `/instance` and no host path can leak.
  Rejected for now: it needs the whole monorepo plus the pnpm store in the build context (or network during the build
  for an installed Instance), and it moves the hash off the materialized bundle — the ground ADR-0019 chose
  deliberately, because hashing guessed inputs instead is how `j2 up` came to skip builds it needed.
- **Opt-in `--prune-images`.** Rejected: `down` is already the destructive, always-confirms command, and abandoned
  images are discovered at 100% disk rather than at the moment one would think to pass a flag.

## Consequences

- **The `@kind` tier is rewritten, not renamed.** `deploy/harness-dev/` dies; the scripted persona's behavior moves from
  MCP client calls to OpenAI-format `tool_calls` on a fake provider (in-cluster, or host-side with a LAN `baseUrl` — the
  config already notes a LAN address works on kind). The tier gains real-Harness coverage and becomes a **second pi
  canary** beside the conformance suite (ADR-0027), so a pi bump can now break it too.
- `stub-harness.ts` keeps its job — the socket-free tier reaches it by explicit `endpoint` (ADR-0031). Only the
  containerized stub is retired.
- **`j2 up` in a kit checkout now needs docker for kit images**, including a Go build for the operator. Hash-skip means
  that is a first-converge cost, not a per-converge one.
- **An air-gapped or mirror-only cluster still cannot pull published kit images.** The answer is a registry _prefix_ for
  kit refs, not per-image overrides — a different mechanism, deliberately deferred while nothing is published.
  (**Resolved by [ADR-0044](0044-kit-images-live-at-a-canonical-home-a-self-host-mirrors-it.md)**: the prefix is
  `kitRegistry`, re-homing refs from the canonical `ghcr.io/snapwich` home, fed by a deliberate instance-less mirror.)
- **The seal deletes garbage at its source.** Before it, every converge built a new image id under an unchanged tag, so
  each one orphaned a whole instance image — 465 MB on the `@kind` instance — which ADR-0039's sweep then collected.
  That was garbage produced by the builder on every run, not by iteration, and the collector was doing work that should
  never have existed. It also made the delivery real: `kind load` skips a node already holding the id, so the kit images
  cost under a second each while the instance image was re-transferred every time.
- **`j2 up` leans on `pnpm deploy`, which pnpm still labels experimental**, at `--legacy`. The seal does not deepen that
  exposure — no flag changes — but the assumption that staging is otherwise deterministic is now held by a test that
  stages one Instance into two directories and compares hashes, rather than by trust. A pnpm upgrade that bakes a path
  somewhere new fails that test instead of silently shipping two images under one tag. (**Amended by
  [ADR-0043](0043-the-kit-is-tested-as-installed-a-local-registry-stands-in-for-npm.md)**: only a workspace-member
  instance leans on it. A standalone instance invokes whichever package manager wrote its lockfile, and `pnpm deploy` is
  never reached.)
- **`just` recipes stop being load-bearing**, and the `images:` lines in `features/kind-instance/j2.config.ts` and
  `examples/coding/j2.config.ts` are deleted with the block.
