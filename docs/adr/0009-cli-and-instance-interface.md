# The `j2` CLI and instance interface

ADR-0008 fixed that j2 is a library + CLI and that an Orchestrator instance is a user-owned folder hosting many
workflows. This ADR fixes the **instance folder convention**, the **orchestrator HTTP API**, and the **`j2` CLI** — all
shaped to mirror flue so both sides of the system speak one set of conventions.

## Instance folder convention (flue-shaped, filename discovery)

```
my-orchestrator/
  j2.config.ts     # instance config — minimal; convention over configuration (see below)
  workflows/       # filename-discovered: workflows/coding.ts (default export = assembled Machine) → "coding"
  agents/          # filename-discovered flue createAgent personas; compose @j2/agents or define custom
  manifests/       # Deployment(replicas:1)+Service+operator RBAC+PVCs — same on kind & cluster
  .env             # local secrets; cluster uses Secret refs
  repos/           # source-of-truth: repos/<name>/default RO checkout (PoC #2); hostPath in dev, PVC deployed
```

`workflows/<name>.ts` (default-exporting an assembled Machine) registers a workflow named `<name>`; `agents/<name>.ts`
registers a persona — exactly mirroring flue's `agents/hello-world.ts → hello-world`. No central registry file.

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

## Consequences

- All `packages/*` publish to npm under `@j2/*`; instances depend on them. The CLI ships as the `j2` bin (`npx j2`,
  mirroring `npx flue`).
- Workspaces are a first-class CLI resource backed by the operator's `Sandbox` CRs; the run→workspace link rides on
  owner-refs/labels so `j2 ls` can group workspaces by run without the orchestrator being reachable.
- `j2 ssh` targets the **User Container** (ADR-0005), the human's peer to the Harness container in the Sandbox pod.
- Dynamic third-party provider/workflow plugin loading stays deferred (ADR-0008); discovery is build-time over the
  instance's own code.
