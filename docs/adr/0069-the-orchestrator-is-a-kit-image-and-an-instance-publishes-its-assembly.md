# The Orchestrator is a Kit image, and an Instance publishes its Assembly

[ADR-0008](0008-orchestrator-as-deployed-app.md) and
[ADR-0019](0019-one-converging-command-against-the-current-context.md) made the Orchestrator the one image an Instance
produces: the engine and the Instance's `workflows/` in one content-addressed image, rebuilt and rolled on every edit to
a Machine, to `jr2.config.ts`, or to a Sandbox Dockerfile under `images/`. The Harness and the operator had already
become Kit images released at one version ([ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md),
[ADR-0044](0044-kit-images-live-at-a-canonical-home-a-self-host-mirrors-it.md)), so the Orchestrator was the one
jr2-owned process whose image a user built. Three costs followed. Every Machine edit rolled the daemon that hosts every
run, which is the roll [ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md) moved the image map to a ConfigMap to
avoid. An installed Instance needed docker for `jr2 up` even when it had no `workspace()` and so no image of its own to
build. And a Machine edit stranded every parked run of that Workflow at the deploy
([ADR-0030](0030-a-snapshot-names-the-machine-it-was-written-under.md)), by design, because the new process could
resolve a Workflow's name only to the new Machine. The grill of 2026-10-18 split the one artifact into two.

## Decision

- **The Orchestrator is a Kit image.** `ghcr.io/snapwich/jr2-orchestrator:<kitversion>`, built content-addressed in a
  checkout and published at the version with the Harness and the operator, mirrored by `jr2 kit push`, re-homed by
  `kitRegistry` ([ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md),
  [ADR-0044](0044-kit-images-live-at-a-canonical-home-a-self-host-mirrors-it.md)). It holds `@jr2/orchestrator` and its
  dependency closure and nothing of any Instance. The image an Instance produced retires: an installed Instance with no
  `workspace()` needs no docker for `jr2 up`.
- **An Instance publishes an Assembly.** The Assembly is the Instance's Workflows, its `jr2.config.ts`, the `file:`
  image contexts its Machines name, and what they import, staged as one tree with the Kit's packages stripped (below),
  sealed, and hashed. `jr2 up` publishes it to the running Orchestrator over the Orchestrator's own API, and only
  `jr2 up` does: an Agent never publishes code ([ADR-0070](0070-a-machine-lends-its-parts-to-a-chart.md)). The config
  rides the Assembly because it is TypeScript too and the Orchestrator reads it at boot; what was Deployment env stays
  env (`registry`, `kitRegistry`, the Secret refs). Rejected: one bundled file per Workflow, which breaks
  `import.meta.resolve` for a context a Machine ships and splits one lockfile into many; a config ConfigMap published
  beside the Assembly, which is a second artifact that can disagree with the first.
- **A package the Kit image ships resolves from the image, never from the Assembly.** The publisher strips
  `@jr2/orchestrator` and its whole dependency closure from the staged tree, and the Orchestrator resolves them to its
  own copies. Class identity holds by construction, not by dedupe: a second copy of `@jr2/orchestrator`, `xstate` or
  `zod` is a Machine whose Menus are empty with no error anywhere
  ([ADR-0054](0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md)). "Its closure", not a list of
  three, so a new kit dependency cannot reopen the hole. The Assembly keeps `@jr2/machines` and the Instance's own deps.
- **An Assembly names its exact Kit version, and the door refuses any other.** The Assembly's manifest names the
  `@jr2/orchestrator` version it was written against; admission refuses a mismatch naming both numbers, the refusal of
  [ADR-0056](0056-a-global-jr2-hands-off-to-the-instances-own-and-an-instance-has-one-kit-version.md) moved to the door.
  Not semver: the kit is 0.x and its minors break, `@jr2/machines` peers exact for the same reason, and a compatibility
  range is a promise jr2 cannot test without a version matrix. Loosening is one line later; tightening after a range has
  been promised is not. So one `jr2 up` that bumps the Kit version rolls the Orchestrator image first and publishes the
  Assembly built against the new version second; between the two the Orchestrator serves and holds no current Assembly,
  for seconds, inside a converge that restores every run anyway.
- **The route is one noun and two verbs.** `PUT /assembly`, behind a **publish token**: one tarball, the Kit version and
  the content hash in headers; `200 { hash, workflows, held }` or `4xx` carrying the walk's report, the old Assembly
  untouched. The publish token is not the Instance token. Publishing an Assembly is importing code into a process that
  holds the ServiceAccount, so it must cost what deploying an image cost: cluster write access. The token lives in the
  Instance's Secret beside the Instance token, `jr2 up` reads it through the kube API alone, and no env var and no
  `--url` path can supply it, so an ingress-exposed Instance exposes no publish door. The Instance token keeps its
  meaning ([ADR-0032](0032-the-console-unlocks-with-the-instance-token.md)): start runs, answer Gates, read.
  `GET /assembly`, public like `GET /workflows`: the current hash and Kit version, and the Assemblies held with the runs
  that hold them. `jr2 status` prints it; `/healthz` prints the current hash where it printed the content hash.
  Rejected: an OCI artifact the Orchestrator pulls, which needs the registry that dropping docker removed; a ConfigMap,
  at 1 MiB; a git ref the Orchestrator clones, when [ADR-0048](0048-the-orchestrator-boots-without-its-repos.md) just
  took cloning out of the Orchestrator.
- **The walk runs twice, with different duties.** On the host, `jr2 up` keeps the typecheck
  ([ADR-0050](0050-what-code-names-config-declares-what-the-cli-names-discovery-finds.md)) and every duty that needs the
  host or the cluster: it loads the Assembly with the same `loadWorkflows` and `partsOf` the Orchestrator runs, builds
  and delivers `file:` Sandbox Images, writes the images ConfigMap, materializes Secrets and held-secret Secrets, warms
  Repos, preflights the provider, and refuses an Open part nobody bound. Then it publishes, after the cluster objects
  exist and after any image roll. At the door the Orchestrator unpacks to staging, imports the config and every
  `workflows/*.ts`, which is the first check (no `export const machine`, a `jr2Setup.createMachine` refusal), and runs
  the same walk to refuse what it can see: an Open part, a secret the config does not declare, a `file:` digest absent
  from its map, a Vocabulary error, a Kit version mismatch. The door checks are true when the Assembly lands because the
  cluster work came first. The server has no `tsc`: types are the author's duty and the typecheck is the host's gate; a
  type error that survives shows as an import error at the door, named in the refusal.
- **A publish is atomic and reloads; it never rolls.** The Orchestrator unpacks to `assemblies/<hash>/` on its own
  volume beside `state.db`, fsyncs, flips one `current` pointer, and reloads: the `reload()` the deployed entrypoint
  never used. A crash before the flip leaves the old Assembly current; after it, the new. The pod rolls only when the
  Kit version or its env changes. The entrypoint boots from the current Assembly as it booted from `/instance`. Volume
  loss boots an Orchestrator that serves, announces "no Assembly", and holds no Workflows until the next `jr2 up`, the
  pattern of [ADR-0048](0048-the-orchestrator-boots-without-its-repos.md): degrade the capability, not the daemon.
- **A run holds the Assembly it started under.** A new run starts under the current Assembly. A live run keeps the one
  it started under, through restarts too: the snapshot records the Assembly hash, and restore resolves the Workflow's
  name inside that Assembly. The Orchestrator holds the current Assembly and every Assembly that a live run holds, and
  lets one go when no live run holds it, by reachability ([ADR-0039](0039-image-garbage-collects-by-reachability.md)). A
  held Assembly lends only its Machines: the config that applies is always the current Assembly's, because config is
  reach and credentials, not a Machine, and a held run must meet today's `git.credentials` fence, not the one it started
  under. So a publish strands nothing: the "editing a workflow strands its parked runs" consequence of
  [ADR-0030](0030-a-snapshot-names-the-machine-it-was-written-under.md) is retired, and drift is what it always meant,
  "I can no longer read what I saved": an Assembly that cannot load after a Kit version bump, or a volume that lost it.
  Such a run is `drifted` with a reason naming the Assembly hash and the import error; no new status. Rejected: report
  the runs a publish will strand and let them drift at the next restart, which turns today's loud stranding into a
  deferred, silent one.
- **The data plane is always wired.** `serverMain` decided at boot, from the walk, whether to wire Sandbox support at
  all; a reload can publish the first `workspace()`. The Orchestrator always wires its kube client, and a provision on a
  cluster where `jr2 up` deployed no operator fails pointedly naming `jr2 up`. `jr2 up` keeps deciding what to DEPLOY
  from its host-side walk; wiring a client is free, deploying an operator is not.
- **The seal simplifies.** [ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md)'s rule stands: the staged tree
  records nothing about where or when it was staged, so one hash names one Assembly. The `.bin` shims it rewrote are
  deleted instead: the Orchestrator runs no bin from an Assembly (an Effect runs in an Effector,
  [ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)), and a path that names the Assembly's own
  directory cannot be rewritten to a path that contains its own hash.

## Considered options

- **Keep the per-Instance image and roll less.** Rejected: nothing short of a separate artifact stops a Machine edit
  from being a pod-template change, and the roll is what strands parked runs.
- **Let an Agent publish an Assembly through an Effect holding the Instance token, behind a Gate.** Rejected: the
  Assembly is code the Orchestrator imports with its ServiceAccount and signing key in reach, so the only fence is who
  may publish, and a reviewer approving generated code under time is a weak fence for a process that holds the cluster.
  The agent path is data: [ADR-0070](0070-a-machine-lends-its-parts-to-a-chart.md).
- **Semver-compatible Assemblies.** Rejected above; one line to loosen later.
- **Keep only the current Assembly and report the runs a publish will strand.** Rejected above.

## Consequences

- The deployable unit of [ADR-0008](0008-orchestrator-as-deployed-app.md) is rewritten: a Kit image plus a published
  Assembly. Under GitOps the manifests alone no longer reproduce the Workflows; the Instance repo plus `jr2 up` does,
  which was already the record and already the CI path.
- `npm i -g @jr2/cli && jr2 init && jr2 up` works with no docker on the host for an Instance with no `workspace()`,
  which closes the promise of [ADR-0044](0044-kit-images-live-at-a-canonical-home-a-self-host-mirrors-it.md) for the
  common case. A Sandbox Dockerfile edit no longer rolls the Orchestrator.
- The content hash moves off the Deployment: the Deployment's image is the Kit's, and the Assembly hash is an
  Orchestrator fact, read from `GET /assembly`, not a label `jr2 up` compares. The steady-state converge compares the
  staged hash to the current one and publishes nothing when they agree.
- The `@dist` tier publishes the Orchestrator image to its registry with the other Kit images and drives the installed
  CLI through a publish, so `PUT /assembly`, the stripping rule and the Kit version refusal execute there. The e2e
  fixture boots the same entrypoint as a host process, unchanged. The `@kind` tier builds the Orchestrator image in
  checkout mode as it builds the Harness.
- The GLOSSARY gains **Assembly**; **Kit version** becomes "the version the Instance pins, which is the tag of every Kit
  image it deploys, the Orchestrator's own included"; "instance image" joins Kit image's avoid list.
- `RunBlob` gains the Assembly hash; a blob without one cannot be vouched for and is drift, as a blob without a shape
  stamp was in [ADR-0030](0030-a-snapshot-names-the-machine-it-was-written-under.md). Greenfield: a stale volume is
  deleted, not migrated.
- Many Assemblies held means many module trees in one process. They share the Kit's packages by the resolution rule, so
  no identity problem; they are distinct directories, so Node's module cache keeps them apart.
