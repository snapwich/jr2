@dist
Feature: the kit, as a user installs it
  Every other tier runs j2 out of this checkout — which means the mode a user actually runs was, until
  ADR-0043, the one mode nothing exercised. Here the `j2` under test is not this repo's `bin/j2.js` at
  all: it is an npm package, published and installed globally, driving an instance folder that lives
  in /tmp with no workspace and no git repo above it.

  Only the REGISTRY is local — the same rule ADR-0038 applies to the model provider. The publish, the
  `npm pack`, the `files:` list, the inter-package resolution, the exact-version pin `j2 init` writes,
  the frozen install the image bundle runs from the lockfile, and the published Kit image tags an
  installed kit deploys instead of building are all the real machinery. A failure here is a release
  bug, in the literal sense: it is what the first user would have hit.

  Opt-in (`@dist`, excluded from the default suite) because it needs infrastructure and a network on
  every run — the registry's storage is wiped per run, so its uplink cache is always cold:
    just e2e-dist-up      # a VANILLA kind cluster; the suite fixture does the rest
    just e2e-dist
  The fixture publishes the kit, builds the three Kit images at their published tags, and installs
  the CLI into a throwaway prefix ONCE per suite run; scenarios isolate by namespace and temp folder.

  Rule: a globally installed CLI converges a standalone instance
    ADR-0009's product claim, and the one this tier exists to prove. Each package manager is its own
    scenario because the manager is not incidental: it decides the lockfile, and the lockfile decides
    which frozen install `j2 up` runs inside the bundle (ADR-0043). npm and pnpm here; bun rides the
    dispatch's unit coverage until this tier needs it.

    Scenario: an npm instance in a temp dir converges and runs
      Given a standalone instance scaffolded by the installed j2
      When I install its dependencies with "npm"
      # `npm ci --omit=dev` in the staged bundle, from the lockfile npm just wrote.
      And I converge it onto the cluster
      And I run "ping" with message "dist"
      Then stdout is the terminal status with reply "pong: dist"
      And the command exits 0

    Scenario: a pnpm instance in a temp dir converges and runs
      Given a standalone instance scaffolded by the installed j2
      When I install its dependencies with "pnpm"
      # The instance stands alone, so this is NOT the `pnpm deploy` path a workspace member takes:
      # it is `pnpm install --prod --frozen-lockfile` in the staged copy — the branch that only
      # exists off a checkout, and the reason the temp dir has no workspace above it.
      And I converge it onto the cluster
      And I run "ping" with message "dist"
      Then stdout is the terminal status with reply "pong: dist"
      And the command exits 0
