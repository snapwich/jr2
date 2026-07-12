# The `j2` CLI and instance interface

ADR-0008 fixed that j2 is a library + CLI and that an Orchestrator instance is a user-owned folder hosting many
workflows. This ADR fixes the **instance folder convention**, the **orchestrator HTTP API**, and the **`j2` CLI** — all
shaped to mirror flue so both sides of the system speak one set of conventions.

## Instance folder convention (flue-shaped, filename discovery)

```
my-orchestrator/
  j2.config.ts     # instance config — minimal; convention over configuration (see below)
  workflows/       # filename-discovered: workflows/coding.ts (named exports: machine + events) → "coding"
  agents/          # filename-discovered flue createAgent personas; compose @j2/agents or define custom
  manifests/       # Deployment(replicas:1)+Service+operator RBAC+PVCs — same on kind & cluster
  .env             # local secrets; cluster uses Secret refs
  repos/           # source-of-truth: repos/<name>/default RO checkout (PoC #2); hostPath in dev, PVC deployed
```

`workflows/<name>.ts` registers a workflow named `<name>` via **named exports** — `export const machine` (the assembled
Machine) and `export const events` (its declared event vocabulary, ADR-0011); `agents/<name>.ts` registers a persona —
exactly mirroring flue's `agents/hello-world.ts → hello-world`. No central registry file.

## Minimum config: `repos`, and the source volume

`j2.config.ts` favors convention over configuration. The **only** irreducible entry is `repos` — the orchestrator cannot
guess what repositories make up the project:

```ts
import { defineConfig } from "@j2/orchestrator";

export default defineConfig({
  repos: [
    { name: "app", url: "git@github.com:me/app.git" }, // ref defaults to default branch
    { name: "infra", url: "../infra" }, // local path → dev uses your working copy, no clone
  ],
});
```

Everything else resolves without a config-file entry: the snapshot store defaults to **sqlite** at
`<instance>/.j2/state.db` (zero setup), and an optional **Postgres** is opt-in via `DATABASE_URL` — j2 points at a
database you provide, it never deploys or operates one (the single-table, single-writer snapshot fits sqlite, and
`replicas: 1` keeps it single-writer even deployed on a PVC; the ADR-0007 at-most-once edge is identical either way).
Model backend resolves via `.env` (and the agent persona); kube target via the current `kubectl` context (`--context` to
override); git creds via the host **ssh-agent** in dev and a Secret (convention name `j2-git-ssh`) when deployed.

`repos` exists so the orchestrator can **materialize the source-of-truth volume itself**: a read-only `default/`
checkout per repo (`repos/<name>/default`) that every Workspace `git worktree --reference`s against (PoC #2). One model,
two backings — only the backing differs, never the config:

- **`j2 dev`** — clone into `<instance>/repos/<name>/default` on the host; mounted RO into kind workspace pods via
  **hostPath**.
- **Deployed** — clone into a **PVC** (`default/` as ROX/RWX); workspace pods mount that PVC RO.

This adds one orchestrator **boot-time reconcile** — "ensure `default/` matches `config.repos`" (clone/fetch each) — the
same reconcile discipline used for Sandbox CRs on restart (ADR-0007). It is orchestrator infrastructure, **not** a
machine slot: the source volume must exist before any Workspace runs, across all workflows. The hostPath↔PVC choice
lives in `manifests/` (+ a storage provider), so `j2.config.ts` is byte-identical dev vs deployed. (Note: the directory
is `repos/`, not `workspace/` — **Workspace** is the reserved term for the Sandbox-bound child Machine.)

## Agents ship as npm; instances compose or override

The kit publishes to npm under `@j2/*`. Built-in personas ship in **`@j2/agents`** (general-purpose, coder, reviewer…).
An instance runs `npm i @j2/agents` and either references built-ins by name or drops a custom `agents/<name>.ts` (which
may re-export/extend a built-in). The Harness image loads the instance's resolved persona set; workflows reference
personas by name when wiring the agent-actor provider.

## Orchestrator HTTP API (hono, flue-shaped, run-addressed-by-id)

Push + control + observe only — the **pull** work-source path needs no HTTP (the Orchestrator pulls).

```
GET  /workflows                 # list registered workflows
POST /workflows/:name/runs      # start a run (push work); body = input → { runId }
GET  /runs                      # list active runs
GET  /runs/:runId               # durable run status (snapshot read)
GET  /runs/:runId/events        # SSE: run event stream (progress/telemetry)
POST /runs/:runId/events        # feed an event in: APPROVE / steer / CANCEL (ADR-0002 down-channel)
GET  /healthz   GET /readyz
```

`POST /runs/:runId/events` is the human-in-the-loop seam: an Agent's `request_approval` parks the run (ADR-0002/0007); a
`POST {type:"APPROVE"}` becomes `actor.send` and releases the gate. The shape mirrors flue's "durable run addressed by
id": `POST` to start/feed, `GET /…/:id` for status, SSE for events.

**Refined by [ADR-0011](0011-workflow-defined-events.md):** the accepted event types are no longer hard-coded, and each
`gate` invocation is an addressable **gate resource** serving _any_ external caller — humans (`j2 send`, a UI), webhook
translators, CI. A gated state registers `{ gate, accepts: [workflow-defined events], meta }`; `GET /runs/:runId` lists
the open gates (with schemas + `meta`), and `POST /runs/:runId/gates/:gate/events` validates the body against the named
schema and delivers it into that state (`j2 send <runId> <gate> --event '{…}'`). Per-gate addressing exists because
concurrent children park concurrently — a run-level events POST is ambiguous. `CANCEL` stays reserved as the run-level
infra interrupt; `APPROVE` survives only as the answer path for a held `deferred` tool result.

## The `j2` CLI — a kubectl-like client over three resource classes

`workflows` (registered Machines, static) · `runs` (durable executions, orchestrator-owned) · `workspaces` (the Sandbox
pods a run spawns, owner-ref/label-linked back to their run).

```
# lifecycle (instance)
j2 init [--target kind|cluster]   j2 dev   j2 build   j2 deploy

# runs / workflows  (wrap the HTTP API)
j2 run <workflow> --input '{…}'   j2 runs   j2 status <runId>
j2 logs <runId> -f                j2 approve <runId> [--reject]   j2 send <runId> --event '{…}'

# workspaces / cluster  (kubectl-style)
j2 ls                             # list workspaces (pods) + run + status + endpoint
j2 ssh <workspace>                # exec into the User Container (CONTEXT.md)
j2 logs <workspace>               j2 rm <workspace>
```

The CLI is the everyday surface; HTTP is the machine-to-machine one. `run`/`runs`/`status`/`logs <runId>`/`approve`/
`send` wrap the orchestrator API. `ls`/`ssh`/`logs <workspace>`/`rm` make the orchestrator feel like `kubectl` for
agents: the orchestrator supplies the logical run↔workspace binding (it holds the ids, ADR-0007), kube handles
`exec`/teardown. `build`/`deploy`/`dev` are the lifecycle the HTTP API does not cover. CLI and hono app sit on one
shared API client.

## `j2 dev` — local control plane, real data plane

`j2 dev` runs the orchestrator **in-process** (hot reload) for fast iteration, but Workspaces are **real Sandboxes in
the target cluster** (kind or remote) — the data plane is never faked. Caveat: PoC #5's reverse ingress (Agent→
Orchestrator MCP callback) needs pod→orchestrator reachability. In-cluster that is the Service; with a local dev
orchestrator it is pod→host — trivial on kind (`host.docker.internal`), but **dev against a remote cluster requires a
tunnel**. So `dev` targets kind by default; `deploy` is how the control plane runs in a remote cluster.

Second host↔cluster seam, same shape: the repos volume. A host-side orchestrator materializes `<instance>/repos/` on the
host filesystem, but kind's `hostPath` resolves against the **node** (the kind Docker container), not the host — so the
instance's `repos/` dir reaches Sandbox pods only if it was mapped in via `nodes[].extraMounts` **when the kind cluster
was created** (it cannot be added later). j2 therefore owns kind cluster creation and bakes the mount in; a
bring-your-own kind cluster must add the mount itself (documented, loud failure otherwise). Docker Desktop's default
`/Users` sharing covers the macOS host→VM hop. There is **no stubbed workspace mode**: workflows that invoke
`workspace()` always get real Sandboxes; the `j2 dev` localhost stub Harness (ADR-0011) serves only workspace-less test
workflows that pass `endpoint` directly in run input.

## Settled CLI behavior (v1)

The verbs above wrap the HTTP API; this fixes how the run-control loop _behaves_, shaped to mirror `flue run` and
diverging only where j2's durable, human-gated runs require it. (Lifecycle `build`/`deploy` and the kubectl-style
workspace verbs stay out of v1.)

**Instance addressing.** The CLI finds its instance by walking up from cwd to the directory containing `j2.config.ts` —
the root marker, mirroring `flue.config.ts`. Runtime state lives under `<root>/.j2/`: the sqlite store and `dev.json`,
which `j2 dev` writes with its live `{ url, pid }` on boot and removes on exit. Run-control commands read `.j2/dev.json`
for the orchestrator URL; `--url` / `J2_URL` overrides it (the deployed/remote case) and skips the folder walk entirely.

**`j2 run` — blocking, attach-by-default.** Mirrors `flue run`: start the run, stream activity to **stderr**, print the
terminal `RunStatus` (status/value/context) as JSON to **stdout**, exit — so `j2 run … | jq` yields just the result.
Author-emitted messages and transition deltas are activity → stderr; only the terminal result is stdout. j2 diverges
from flue in one way: with no `--url` it **attaches to the running orchestrator** (`.j2/dev.json`), not a temporary
per-invocation runtime — because a j2 run is durable and may park on `request_approval` indefinitely, outliving the CLI
call. `--detach` starts the run, prints its `runId`, returns.

**Attach / detach / re-attach.** A run lives server-side (durable snapshot), so attaching = opening
`GET /runs/:runId/events` and detaching = closing it (Ctrl-C); neither affects the run. `j2 logs <runId> -f` re-attaches
to any running run. On attach, the SSE **replays the run's current status immediately** (so a parked run shows where it
is) before streaming live deltas. The SSE carries two event kinds: `status` (auto, per transition) and `emit` (the
workflow author's `emit({ … })`, forwarded by the host).

**Terminal runs stay readable.** `persist()` writes the final snapshot to the store, then drops the run from the live
registry. So `status` / `GET /runs/:runId` **read through to the store** when a run isn't live — a completed run reports
its terminal status/context instead of `404`. (`GET /runs` stays live-only; history via `?all` is deferred.)

**`j2 init` (v1).** Scaffolds the minimum runnable instance: `j2.config.ts` (root marker), `package.json` (deps on
`@j2/*` + xstate), one starter `workflows/<name>.ts`, and `.gitignore` (`.j2/`, `node_modules/`). `[dir]` positional
(default cwd); `--force` to overwrite an existing `j2.config.ts`. The `--target kind|cluster` flag is deferred alongside
`manifests/`/`deploy`; `agents/`, `manifests/`, `repos/`, and `.env` are added by their later slices. No auto-install —
it prints the `pnpm install && j2 dev` next step.

## Consequences

- All `packages/*` publish to npm under `@j2/*`; instances depend on them. The CLI ships as the `j2` bin (`npx j2`,
  mirroring `npx flue`).
- Workspaces are a first-class CLI resource backed by the operator's `Sandbox` CRs; the run→workspace link rides on
  owner-refs/labels so `j2 ls` can group workspaces by run without the orchestrator being reachable.
- `j2 ssh` targets the **User Container** (ADR-0005), the human's peer to the Harness container in the Sandbox pod.
- Dynamic third-party provider/workflow plugin loading stays deferred (ADR-0008); discovery is build-time over the
  instance's own code.
