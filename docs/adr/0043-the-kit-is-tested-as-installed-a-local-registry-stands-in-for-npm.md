# The kit is tested as installed: a local registry stands in for npm

j2's product shape ([ADR-0009](0009-cli-and-instance-interface.md)) is a globally installed CLI and a standalone
Instance folder that just works — scaffold anywhere (`/tmp` included), install with whatever package manager the user
already has, `j2 up`. None of that path existed: the scaffold wrote `workspace:*` deps only the kit's own pnpm workspace
can resolve, the bundle step was `pnpm deploy` (workspace members only), every package was `private: true`, and
installed mode's kit image refs name published tags that exist nowhere. Every test tier ran checkout mode, so the mode
users will actually run was the one mode nothing exercised. This ADR fixes the loop that closes that gap — and the loop
is **permanent, not a pre-1.0 crutch**: "test 1.3.0 before it exists on npm" is the same problem forever.

## The rule: fake the registry, never the mechanism

The loop feeds the real machinery a local upstream — the same philosophy as
[ADR-0038](0038-j2-up-builds-every-image-it-deploys.md)'s scripted model provider (only the LLM is faked; here, only the
registries are local). Concretely: an ephemeral [verdaccio](https://verdaccio.org) npm registry per loop run;
`pnpm -r publish --registry` into it; `npm i -g @j2/cli --registry` into a temp npm prefix; `j2 init` in a temp dir
outside any checkout and any git repo; the user's own package manager installs; `j2 up` converges in installed mode.

`npm link` was the tempting shortcut and is rejected for cause: a linked package is a symlink into the checkout, Node
resolves modules by real path, so `detectKitCheckout()` finds the checkout and the CLI runs **checkout mode** — the
branch under test never executes. Link also skips `npm pack` entirely (no `files:` check, no `workspace:*` rewrite),
which is exactly the works-linked-broken-published failure class a release loop exists to catch. Tarball installs fail
differently: npm cannot resolve inter-package deps (`@j2/cli` → `@j2/orchestrator`) to tarballs. A registry is the only
stand-in that exercises the real chain.

**An ephemeral registry deletes version bookkeeping.** Fresh verdaccio per run means `0.0.0` publishes cleanly every
time — no `-dev.N` stamping, no manifest mutation before publish (a loop that edits manifests tests edited manifests).

## What publishes, and the guard

`@j2/cli`, `@j2/orchestrator`, `@j2/agent-protocol` flip to `private: false` — the prod-resolution chain an instance
pulls. `@j2/harness` and `@j2/adapter` stay private: they reach users as **Kit images**, never via npm install
([ADR-0027](0027-the-harness-is-j2s-own-server-flue-retires-the-wire-stays.md),
[ADR-0037](0037-an-instance-builds-its-sandbox-images-j2-injects-the-harness.md)). This amends ADR-0009's "all
`packages/*` publish to npm" — that line wrote down a mechanism, not the intent.

Losing `private: true` loses the accidental-publish guard, so the guard moves into `publishConfig`:

```json
"publishConfig": { "registry": "http://localhost:4873" }
```

The manifest names the only registry it may publish to. `publishConfig` outranks CLI and env registry settings at
publish time, so a stray `--registry` cannot leak past it, and a publish with no verdaccio up fails connection-refused.
Publishing to npmjs becomes a deliberate, reviewable **edit** — changing that line is the "we are ready" commit — never
an absence-of-flag accident.

In the loop, Kit images need no registry at all on kind: build from the checkout, tag with the published names
(`j2-harness:<version>`), `kind load` — the same delivery checkout mode already uses. Registry-prefixed kit refs for
non-kind clusters stay deferred (ADR-0038). (**Amended by
[ADR-0044](0044-kit-images-live-at-a-canonical-home-a-self-host-mirrors-it.md)**: `kind load` bypassed the pull path, so
the mode users run had no tier — the `@dist` bring-up now adds a local OCI registry, seeds it with `just kit-push`, and
scenarios pull Kit images through `kitRegistry` like any self-host.)

## The binary is the kit's one `.js` file

Running the loop found what running checkout mode forever had hidden: Node's type stripping **refuses files under
`node_modules`**, and an installed kit is nothing else — `j2 --help` died on its own shebang. The image bundle already
knew (its entrypoint runs through `tsx`, ADR-0038); the host-side binary had nowhere to learn it.

So `bin/j2.js` replaces `bin/j2.ts`: it registers a `module.registerHooks` load hook that erases types with
`ts-blank-space` — the same erasure ADR-0034 already makes for the Console — and then imports `../src/cli.ts`. What
`ts-blank-space` cannot erase is what Node's own stripping rejects too, so this widens where the kit runs, never what it
may be written in, and the repo stays zero-build. **One entry for both worlds**, for the same reason `j2 init` grows no
mode branch: a checkout-only `.ts` bin beside an installed-only `.js` bin would mean the binary users run is not the
binary the tiers run.

The loop's own state — registry storage, npmrc, throwaway global prefix — therefore lives **outside** the checkout. A
prefix under the kit root is `npm link`'s rejected failure in another costume: `detectKitCheckout()` walks up from the
CLI's real path, finds the kit above the prefix, and converges in **checkout mode** while reporting success. The publish
script refuses a `J2_DIST_DIR` inside the checkout, and the `@dist` converge asserts the mode line it expects.

## The scaffold pins the kit that scaffolded it

`j2 init` renders `"@j2/orchestrator"` and `"@j2/cli"` at the **exact** running `KIT_VERSION` — exact, not caret,
because 0.x minors break (the same reasoning that pinned pi exact, ADR-0027). One template serves both worlds; init
grows no checkout/installed branch, because a branch means the tested output and the shipped output diverge.
`templates/default` carries the same literal, so the byte-for-byte mirror test survives and becomes the version-bump
tripwire. The checkout resolves the exact version to its own packages via `linkWorkspacePackages: true`; kit inter-deps
stay `workspace:*` (publish rewrites them at pack). The scaffold names no package manager — no `packageManager` field, a
PM-neutral install hint — and instances upgrade the kit by editing two dep lines, which pre-1.0 is a feature.

## The bundle installs from the lockfile, with the lockfile's own package manager

The instance-image bundle ([ADR-0038](0038-j2-up-builds-every-image-it-deploys.md)) is keyed off the **instance's own
workspace membership** — the nearest `pnpm-workspace.yaml` at or above the instance directory — and not off the mode
`j2 up` detects for its Kit image refs. That membership, not the CLI's provenance, is what says whether `pnpm deploy`
can run at all, and the two keys disagree in both directions: a checkout CLI legitimately drives a standalone instance
(a developer's `/tmp` folder), and an installed kit legitimately drives an instance nested in the user's own pnpm
monorepo — which carries no lockfile of its own, because the workspace root holds it.

- **Workspace member**: unchanged `pnpm deploy --legacy`. Its job — materializing workspace symlinks — only exists in a
  workspace. pnpm is a **contributor prerequisite** (like go for the operator), and in the one installed-mode shape that
  reaches this branch it is a prerequisite the user already met: they wrote the `pnpm-workspace.yaml` that selects it.
- **Standalone**: stage a copy of the instance (minus `node_modules/`, `.j2/`, `.git/`, and the credential files
  `.env*`/`.npmrc` — `j2 up` reads `.env` host-side into the Orchestrator's Secret, ADR-0019, so a copy would bake a key
  into an image layer and into the tag addressing it) and run a **frozen install from the lockfile**, dispatched on
  which lockfile is present: `package-lock.json` → `npm ci --omit=dev`; `pnpm-lock.yaml` →
  `pnpm install --prod --frozen-lockfile` (with `node-linker=hoisted`, so the bundle is flat real files regardless of
  PM); `bun.lock[b]` → `bun install --production --frozen-lockfile`. A private registry reaches that install through the
  environment (`npm_config_registry`) or the user-level npmrc, never through image content.

The lockfile — not the user's `node_modules/` — is the input, and that is forced, not stylistic: the GitOps/CI path
(ADR-0008's instance repo, the planned `j2 build`) runs from a clean checkout where **no `node_modules` exists**, a
copied tree bakes in accidents rather than declarations, and prod-pruning a copied tree means reimplementing resolution.
Lockfile-as-input is also [ADR-0019](0019-one-converging-command-against-the-current-context.md)'s derivability rule
applied to dependencies: the deployed bundle is a function of what `up` can see committed. The lockfile is therefore
part of the instance contract; no lockfile is a hard error naming the supported three, two lockfiles is an ambiguity
error.

The package-manager "dependency matrix" collapses to nothing: lockfiles are proprietary formats, so supporting any PM
mechanically means invoking the binary that speaks the lockfile present — and that binary's presence is guaranteed by
the very thing that selects it (the user wrote the lockfile with it). j2 itself depends on no package manager.

**v1 ships npm, pnpm, and bun. Yarn is deliberately out**: one filename hides two incompatible generations (classic
`--frozen-lockfile` vs berry `--immutable`), and berry defaults to PnP — no `node_modules` at all, which the image's
resolution model cannot host. A `yarn.lock` gets a named rejection ("use npm, pnpm, or bun"), and adding it later is one
dispatch row plus its tests, no design change.

## The loop's two faces

- **`@dist`**: a new opt-in e2e tag beside `@kind` (docker + kind + verdaccio), whose Rule is literally ADR-0009's
  claim: a globally installed CLI converges a standalone instance. Publish happens once per suite run; scenarios isolate
  by namespace; scenarios cover npm and pnpm instances (bun rides unit coverage on the dispatch until the tier needs
  it), scaffolded in temp dirs with no git, converged, blown away.
- **The manual loop**: a `just` recipe leaves verdaccio and the temp global install standing, so a developer plays the
  way a user lives — `j2 init /tmp/anything && npm install && j2 up`, entirely outside the repo.

## Consequences

- ADR-0009's consequences are amended: the instance-facing packages publish to npm; harness/adapter ship in Kit images.
- Scaffolded instances pin exact and bump manually; a `j2 upgrade` verb can exist later if that ever hurts.
- The checkout's `pnpm-workspace.yaml` gains `linkWorkspacePackages: true`; `templates/default` trades `workspace:*` for
  the exact version literal.
- The npmjs `@j2` scope must be claimed early regardless of readiness — the localhost guard protects against accidents,
  not squatters.
- **`j2 up` still shells out to pnpm in one installed-mode shape**: an instance nested in the user's own pnpm workspace.
  That is not the product dependency creeping back, because the thing that selects pnpm is a file the user wrote with
  pnpm — the same self-selecting argument the lockfile dispatch already rests on.
- **The published packages carry `files:` allowlists, and the over-include half is a unit assertion**
  (`packages/cli/test/publish.test.ts`). A `files:` list fails loudly only when it OMITS something, so the `@dist` tier
  is structurally incapable of catching a package that ships its test tree — and these are prod deps, unpacked into
  every instance image.
- The staged bundle drops `node_modules/.pnpm-workspace-state.json` beside `.modules.yaml` (ADR-0038's seal): it is a
  `lastValidatedTimestamp` and nothing else, so leaving it in re-addressed every pnpm bundle on every converge — a
  pod-template change, and a snapshot restore for every live run, on a no-op `up`.
- Everything the loop needs in-tree (public flags, localhost `publishConfig`, exact-pin scaffold, lockfile dispatch) is
  the real shipping configuration. Nothing anywhere special-cases "testing" — which is the point.
