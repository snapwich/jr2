@dist
Feature: the kit, as a user installs it
  Every other tier runs jr2 out of this checkout — which means the mode a user actually runs was, until
  ADR-0043, the one mode nothing exercised. Here the `jr2` under test is not this repo's `bin/jr2.js` at
  all: it is an npm package, published and installed globally, driving an instance folder that lives
  in /tmp with no workspace and no git repo above it.

  Only the REGISTRIES are local — the same rule ADR-0038 applies to the model provider — and there are
  two of them, because the product touches two (ADR-0044): npm, and the home its Kit images are pulled
  from. The publish, the `npm pack`, the `files:` list, the inter-package resolution, the exact-version
  pin `jr2 init` writes, the frozen install the image bundle runs from the lockfile, the published Kit
  image tags an installed kit deploys instead of building, and the node PULL that fetches them are all
  the real machinery. A failure here is a release bug, in the literal sense: it is what the first user
  would have hit.

  Opt-in (`@dist`, excluded from the default suite) because it needs infrastructure and a network on
  every run — the npm registry's storage is wiped per run, so its uplink cache is always cold:
    just e2e-dist-up      # a kind cluster; the suite fixture does the rest
    just e2e-dist
  The fixture stands up both registries, publishes the kit, pushes the three Kit images at their
  published tags, and installs the CLI into a throwaway prefix ONCE per suite run; scenarios isolate
  by namespace and temp folder.

  Rule: a globally installed CLI converges a standalone instance
    ADR-0009's product claim, and the one this tier exists to prove. Each package manager is its own
    scenario because the manager is not incidental: it decides the lockfile, and the lockfile decides
    which frozen install `jr2 up` runs inside the bundle (ADR-0043). npm and pnpm here; bun rides the
    dispatch's unit coverage until this tier needs it.

    Both scenarios also close ADR-0044's claim, since both converge anyway: an installed kit builds
    no Kit image, so the three it deploys must arrive by pull from `kitRegistry` — the key a
    self-hosted, air-gapped, or mirror-only cluster sets, and the key this cluster sets at the local
    registry standing in for the canonical home.

    Scenario: an npm instance in a temp dir converges and runs
      Given a standalone instance scaffolded by the installed jr2
      When I install its dependencies with "npm"
      # `npm ci --omit=dev` in the staged bundle, from the lockfile npm just wrote.
      And I converge it onto the cluster
      And I run "ping" with message "dist"
      Then stdout is the terminal status with reply "pong: dist"
      And the command exits 0
      And the cluster pulled its Kit images from the local registry
      # The other end of the loop, from the same installed binary: `jr2 down` takes the namespace
      # and everything `jr2 up` converged into it (ADR-0019) — the one verb this tier had never run.
      When I take the instance down
      Then the instance's namespace is gone

    Scenario: a pnpm instance in a temp dir converges and runs
      Given a standalone instance scaffolded by the installed jr2
      When I install its dependencies with "pnpm"
      # The instance stands alone, so this is NOT the `pnpm deploy` path a workspace member takes:
      # it is `pnpm install --prod --frozen-lockfile` in the staged copy — the branch that only
      # exists off a checkout, and the reason the temp dir has no workspace above it.
      And I converge it onto the cluster
      And I run "ping" with message "dist"
      Then stdout is the terminal status with reply "pong: dist"
      And the command exits 0
      And the cluster pulled its Kit images from the local registry
