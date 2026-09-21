# A release is a pushed tag, and the publish guard is the credential

[ADR-0043](0043-the-kit-is-tested-as-installed-a-local-registry-stands-in-for-npm.md) made the accidental-publish guard
a manifest line — `publishConfig.registry: http://localhost:4873` — and named the edit of that line the "we are ready"
commit. Preparing the first real publish (2026-09-20) found the guard has no exit: `publishConfig` outranks `--registry`
by design, so the edit that lets the kit reach npmjs is the same edit that breaks every reader of the guard at once —
`packages/cli/test/publish.test.ts` asserts a localhost registry, `scripts/dist-publish.sh` refuses any other, and the
`@dist` fixture publishes to whatever the manifest names. After the flip the local loop cannot publish at all, and
flipping it back per release keeps the unit gate red for the length of the release. The property that made the guard
strong is the property that makes it unreleasable. This ADR amends ADR-0043's guard and settles the rest of the release:
version, images, gate, trigger.

## Decision

- **The guard is the credential, not the manifest.** `publishConfig.registry` leaves every manifest. The only holder of
  an npmjs credential is the release job, and it holds no token: it publishes with npm trusted publishing (OIDC from
  GitHub Actions), so nothing long-lived exists to leak. A `pnpm -r publish` on a dev box reaches npmjs and fails
  `ENEEDAUTH`, which is the guard — an absence that cannot be edited past, where the manifest line was a presence that
  had to be. `publishConfig.access: public` stays on all four, because a scoped package's first publish is 402 without
  it. `scripts/dist-publish.sh` passes `--registry` again, and `publish.test.ts` inverts: it asserts that **no** public
  manifest names a registry, so the old guard cannot be smuggled back in one package and silently pin a release to
  localhost.
- **Lockstep, and `main` carries the next version.** One number across `packages/*` and `templates/default`, because
  [ADR-0019](0019-one-converging-command-against-the-current-context.md)'s one release train already reads a single
  `KIT_VERSION`, ADR-0043's scaffold pins two packages at one exact number, and `workspace:*` packs to an exact
  inter-dependency — independent versions would need ranges, and 0.x ranges break. `0.0.0` stops being special: it was
  the ephemeral registry's value only because nothing was released, and a fresh verdaccio publishes any version cleanly.
  `just release patch|minor|major` (or an explicit version) computes the number the way `npm version` does, writes it to
  every manifest and the template, runs the unit gate (`init.test.ts` is the tripwire), commits, and tags `v<ver>`.
  Nothing rewrites a version at publish time: a loop that edits manifests tests edited manifests (ADR-0043), and a
  checkout `KIT_VERSION` must read the number the checkout will ship.
- **The tag push is the release, and one job does the whole train in order.** `release.yml` runs on `v*`; it refuses
  first if the tag disagrees with any manifest. Then the full gate — unit, harness conformance, the default e2e profile,
  and `@kind` and `@dist` on a kind cluster the job creates on the runner (the operator's own e2e job already works this
  way) — so the installed path is proven on the tree that publishes, not on a maintainer's box the day before. Then
  `scripts/kit-push.sh ghcr.io/snapwich` (multi-arch, `GITHUB_TOKEN` with `packages: write`), and **only then** npm:
  each public package is packed with pnpm, which rewrites `workspace:*` to the exact version, and **staged** with
  `npm stage publish`, the client that speaks trusted publishing — in pnpm's topological order, dependencies first,
  skipping a version npm already holds live so a re-run converges. The order is the contract: a package whose images are
  not at the home fails at pull on the user's first `jr2 up`
  ([ADR-0044](0044-kit-images-live-at-a-canonical-home-a-self-host-mirrors-it.md)); images with no package are inert,
  and stay so while the packages sit staged.
- **The job stages; the maintainer approves.** Each trusted publisher is configured for `npm stage publish` only, so the
  tag produces four staged tarballs and one 2FA approval per package (`npm stage approve`, dependencies first) makes
  them live. This is the one human act a release keeps, and it is kept on purpose: the job's identity is bound to the
  repository and the workflow file, so a stolen GitHub session or a bad edit to that file could otherwise publish under
  the project's name; staged, it can stage and nothing more. It is not a runbook step — nothing has to be remembered in
  order, the staged tarballs wait.
- **Two executors of one train.** `scripts/publish.sh` is the irreversible half — images, then packages, dependencies
  first, live versions skipped — and the job runs it with `--stage`. A maintainer runs it as `just publish` from the
  pushed tag when a 0.x release cannot wait the job's hour: `npm publish` with a 2FA prompt per package in place of an
  approval, and the job converges behind it. The checks are the same in both (lockstep, clean tree, HEAD is the pushed
  tag), and so is the guard: a login alone publishes nothing under write-2FA, so a dev box holds no credential that
  publishes by itself.
- **`ci.yml` on push and PR is the light gate**: frozen install, typecheck, format check, `pnpm -r test`, the default
  Cucumber profile — minutes, no docker. The heavy tiers run on the tag and by hand (`just e2e-kind`, `just e2e-dist`)
  when a change touches build, deploy, or dist code.
- **`@jr2/machines` peers on `@jr2/orchestrator` exactly.** `workspace:*` stays; a Machine is written against one
  orchestrator, and a mismatched pair fails at install with a peer error instead of at run.
- **`engines.node: ">=24"` on every public package and the root.** Every runtime the kit runs in is Node 24 already
  (both Kit Dockerfiles, the instance Dockerfile, the `registerHooks` bin); the root's `>=22` was the straggler.

## Considered options

- **Keep the localhost line; the release job rewrites it before publish.** Rejected by ADR-0043's own rule — the
  published manifest would be one no tier tested.
- **Point the manifests at npmjs; the dist loop rewrites them to localhost.** The same objection inverted: the tier that
  proves the tarballs would test a manifest the release never ships.
- **A `prepublishOnly` guard** (refuse unless localhost or `JR2_RELEASE=1`). In-tree, but it rests on pnpm exposing the
  effective registry to lifecycle scripts, and a one-variable bypass is a guard shaped like a suggestion.
- **CI stamps the version from the tag; `main` stays `0.0.0`.** Rejected twice: edited manifests, and a checkout's
  `KIT_VERSION` would read `0.0.0` forever.
- **Changesets in fixed mode.** The right tool once there are contributors and changelogs; today it is a version PR in
  front of a five-file edit. The contract it would implement — tag equals manifests, lockstep — is the one chosen here,
  so adopting it later changes no ADR.
- **`workflow_dispatch` with a version input.** CI would make the bump commit, so the gate runs on a tree the maintainer
  never saw at that version.
- **Manual `just kit-push` before tagging.** A runbook step in front of a release (ADR-0019 calls that an interface
  failure), and nothing checks the images exist before npm publish.

## Consequences

- ADR-0043's "What publishes, and the guard" is amended: the guard is credential absence; the "we are ready" commit is
  no longer an edit, it is the first pushed tag. Its consequence "localhost `publishConfig` … is the real shipping
  configuration" no longer holds; the rest of that list does.
- **Bootstrap, once:** create the `jr2` org on npmjs (a scope is a user or an org), publish the first version by hand
  with a token — npm attaches a trusted publisher only to a package that already exists — then configure the trusted
  publisher on all four packages and revoke the token. After that no token that publishes on its own exists anywhere:
  the job's identity stages, a maintainer's login needs its second factor. Likewise once: make the three GHCR packages
  public after the first push, because GHCR creates them private.
- `publish.test.ts` asserts no registry, `access: public`, and `engines`; `dist-publish.sh` drops its manifest read-back
  and passes `--registry`; the `@dist` fixture takes its registry from `JR2_DIST_PORT`'s default rather than the
  manifest; `kit-push.sh`'s cli-vs-orchestrator cross-check widens to every manifest; `just release` is new;
  `.github/workflows/` gains `ci.yml` and `release.yml`.
- A release costs a runner kind cluster and roughly ten minutes of docker. Accepted: it is the only time the installed
  path must be proven on the exact tree that ships.
- The four tarballs gain the npm-page fields (`description`, `repository` with `directory`, `homepage`, `bugs`,
  `keywords`) and a README each; the root README's "only scaffolding exists" line goes.
