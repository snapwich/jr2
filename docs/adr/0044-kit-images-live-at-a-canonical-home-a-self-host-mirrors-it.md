# Kit images live at a canonical home; a self-host mirrors it

[ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md) gave installed mode published-`<kitversion>` Kit image refs and
deferred the question of where those tags actually live "while nothing is published." The first installed-mode converge
against a real cluster ends the deferral: `publishedKitRefs()` emits bare `jr2-harness:<kitversion>`, a node resolves
that against `docker.io/library/`, and nothing is there — no registry a user pushes to can help, because the pod spec
never names it.

## Decision

- **Kit images have a canonical public home: `ghcr.io/snapwich`.** `publishedKitRefs()` bakes it:
  `ghcr.io/snapwich/jr2-harness:<kitversion>`, likewise adapter and operator. Public GHCR egress is free to the project,
  so an open-source kit can afford a home every user's nodes pull from — and only a canonical home makes
  `npm i -g @jr2/cli && jr2 init && jr2 up` work with zero image plumbing, which is the product's promise. Pushing there
  is part of the release train ([ADR-0019](0019-one-converging-command-against-the-current-context.md)): a release is
  not done until the images for its npm version are at the home.
- **A new config key `kitRegistry` re-homes the Kit refs** — `<kitRegistry>/jr2-harness:<kitversion>` — for self-hosted,
  air-gapped, or mirror-only clusters. It is deliberately **separate from `registry`**: the two keys answer different
  questions — `registry` says where images _this converge builds_ go; `kitRegistry` says where _published artifacts_
  live. One key for both would force every private-`registry` user to mirror Kit images they could have pulled from the
  home, making the common corporate case pay the rare air-gapped case's cost. Like `registry`, it is deployment-varying
  → env.
- **Getting Kit images into a self-hosted registry is deliberate and instance-less — never part of `jr2 up`.** Kit
  images are shared by every instance on a cluster (and possibly by every instance in an org); updating them is a
  deliberate act, not a side effect of converging one instance. Two arms, split by what each audience holds:
  - **`jr2 kit push <registry>`** (in the binary, for the installed self-hoster): a **mirror**, nothing more —
    registry-to-registry manifest copy of the three refs at the CLI's own `<kitversion>`, canonical home → target, via
    `docker buildx imagetools create`. That copies the full manifest list (every platform, exact digests) without
    landing bytes on the host; a daemon-side `docker pull`/`push` would flatten a multi-arch image to the host's
    platform and ship an amd64-only image to an arm64 cluster. A tag already present in the target is skipped and
    reported: published version tags never move, so present implies current. The binary has **no build arm**: the npm
    packages carry no Harness or Adapter source, and an installed CLI that could build Kit images is exactly the
    patched-Harness eject hatch [ADR-0027](0027-the-harness-is-jr2s-own-server-flue-retires-the-wire-stays.md)/ADR-0038
    welded shut.
  - **`just kit-push <registry>`** (in the checkout, for the kit developer and the release pipeline): build the three
    images from source **multi-arch** (`docker buildx build --platform linux/amd64,linux/arm64 --push`) at the published
    names into the given registry. This is how the canonical home gets its images at release — and how a dev-loop
    registry gets images the home does not have yet. Single-arch pushes here would make the mirror faithfully copy the
    deficiency to every self-host.
- **The `@dist` tier pulls Kit images through a real registry**
  ([ADR-0043](0043-the-kit-is-tested-as-installed-a-local-registry-stands-in-for-npm.md)'s rule — fake the registry,
  never the mechanism — applied to the second registry the product touches). The tier's kind bring-up adds a local OCI
  registry (the upstream kind local-registry pattern: a `registry:2` container plus containerd `hosts.toml` on the
  nodes); the fixture seeds it with `just kit-push`, scenarios set `kitRegistry`, and the nodes genuinely pull —
  `kind load` at published names had bypassed the pull path entirely, leaving the mode users run covered by no tier,
  which is the failure class ADR-0043 exists to delete.

## Considered options

- **No canonical home — self-host as the only model.** Rejected: every user's first `jr2 up` fails until they stand up a
  registry and mirror three images into it, inverting "the CLI does all the work." The bandwidth objection to a home
  turned out to be moot: GHCR egress for public images is GitHub's cost, not the project's.
- **One `registry` key prefixing everything.** Rejected above — the corporate-registry case pays the air-gapped case's
  mirror cost for no benefit.
- **Mirroring inside `jr2 up`** (absent tag → pull home, push self-host, converge on). Rejected: kit updates on a shared
  cluster should be deliberate; a per-instance converge is the wrong actor to move an org-shared artifact, and the same
  logic wants to run with no instance at all.
- **One `jr2 kit push` with a checkout build arm** (checkout-is-the-signal, like `jr2 up`). Rejected: the build arm
  needs the whole repo, so it belongs to the repo's own tooling — ADR-0038 already scoped `just` recipes as "shortcuts
  for building images without a converge." The binary keeps only the arm its audience can use.
- **Digest-pinned Kit refs** (`…@sha256:`), killing tag staleness outright. Rejected: installed mode would need a
  converge-time registry resolve plus digest bookkeeping — a production mechanism purchased to serve a dev-loop
  annoyance (see the accepted remainder).
- **`imagePullPolicy: Always` on Kit containers.** Rejected: taxes every production pull to serve the same dev-loop
  annoyance, inverting ADR-0038's "IfNotPresent is correct because tags are immutable."

## Consequences

- ADR-0038's deferred edge ("air-gapped clusters cannot pull published kit images") closes: the answer is the promised
  registry prefix, spelled `kitRegistry`, fed by a deliberate mirror.
- **Accepted remainder: a re-pushed dev tag is stale on any node that pulled the old one.** The loop pushes
  `jr2-harness:0.0.0` repeatedly; `IfNotPresent` keeps the first bytes a node saw. Version tags are immutable everywhere
  but the loop, and kit-source iteration is checkout mode's job — its content-addressed tags make staleness impossible
  by construction. The installed loop tests distribution mechanics, not Harness code; when its content truly must move
  on a persistent cluster, the escape is manual (`crictl rmi` on the node, or a throwaway cluster). `@dist` is immune —
  its registry and cluster are ephemeral per run.
- `just kit-push` needs a multi-platform buildx builder (qemu for the foreign arch). A checkout-mode converge against a
  foreign-arch cluster needs no workaround: `jr2 up` derives the platform set from the cluster's nodes and passes
  `--platform` explicitly ([ADR-0045](0045-the-platform-joins-the-image-address-and-the-cluster-chooses-it.md)), so
  `DOCKER_DEFAULT_PLATFORM` steers nothing.
- The home-cluster installed-mode loop becomes: `just dist-up` (npm side), `just kit-push zot.cluster.snapwich.net`
  (image side), then an instance whose env sets `kitRegistry`.
