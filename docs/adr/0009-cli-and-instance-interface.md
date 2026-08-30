# The `j2` CLI and instance interface

ADR-0008 fixed that j2 is a library + CLI and that an Orchestrator instance is a user-owned folder hosting many
workflows. This ADR fixes the **instance folder convention**, the **orchestrator HTTP API**, and the **`j2` CLI** — one
set of conventions both sides of the system speak. Operational mechanics (how `j2 up` converges a cluster, addressing,
secrets) live in ADR-0019.

## Instance folder convention (filename discovery)

```
my-orchestrator/
  j2.config.ts     # instance config — minimal; convention over configuration (see below)
  workflows/       # filename-discovered: workflows/review.ts (contract: export const machine) → "review"
  agents/          # filename-discovered plain-data Agent definitions (ADR-0018); j2 assembles the Harness
  manifests/       # user-supplied objects applied by `j2 up` (e.g. SealedSecrets); optional
  .env             # local secrets + deployment-varying env; uncommitted
  .j2/             # scratch; nothing durable lives on the host (state is in-cluster, ADR-0019)
```

`workflows/<name>.ts` registers a workflow named `<name>` via `export const machine` — the one-export module contract
(ADR-0015; vocabulary rides the machine object, so there is no manifest export). `agents/<name>.ts` registers an Agent
definition the same way (`export default defineAgent({…})`, ADR-0018). No central registry file.

**The instance repo is a deployment assembly, not a sharing unit** (ADR-0019): reusable workflows/agents are published
as npm packages and re-exported here; `j2.config.ts` holds only what is specific to this deployment's repos, models, and
cluster — committed, because the instance repo is the GitOps unit (ADR-0008), with deployment-varying values resolved
from env.

## Minimum config, and the source volume

`j2.config.ts` favors convention over configuration — a sandbox-ful instance can be as small as:

```ts
import { defineConfig } from "@j2/orchestrator";

export default defineConfig({ name: "my-orchestrator", sandbox: {} });
```

- **`name` is the instance's identity**; its namespace defaults to it (`-n` overrides — ADR-0019).
- **`repos[]` is the source catalog.** Each `{ name, url, ref? }` entry is cloned into the in-cluster source volume by
  the boot reconcile (ADR-0004); Sandboxes clone `--shared` against it. There is no host-side catalog directory — a repo
  pods should see must be fetchable from the cluster.
- **A non-empty `repos` list is the data-plane switch** (as amended by ADR-0031): with it, the instance gets the kubectl
  Sandbox backend; without it, the instance is workspace-less — a Workspace needs repos. ~~Image composition lives in
  the `images` block: `images.harness`/`images.adapter`/`images.operator` default to the published `<kitversion>` tags
  (every Sandbox gets an Adapter — an Agent without one cannot act, ADR-0013); `images.user` opts into the User
  Container (ADR-0005).~~ **Superseded by [ADR-0038](0038-j2-up-builds-every-image-it-deploys.md)**: the `images` block
  is deleted outright, no key and no env escape hatch — `j2 up` builds every image it deploys and resolves each to a
  content-addressed tag, and `images.user` died with the User Container
  ([ADR-0037](0037-an-instance-builds-its-sandbox-images-j2-injects-the-harness.md)). An Adapter in every Sandbox is
  unchanged; it is simply not configurable. Agent-runtime concerns live in `harness` (ADR-0018).
- **`harness` is the agent-runtime section** (ADR-0018): custom provider (`api`, `baseUrl`) and the env/creds the Agents
  need (e.g. an Anthropic key, read from `process.env`/`.env` and materialized as a Secret by `j2 up`, or `envFrom` refs
  to Secrets you manage) — never which model to use; each definition names its own (ADR-0018).
- **`registry`** (deployment-varying, resolve from env): absent → images are `kind load`-ed; present → pushed
  (ADR-0019).
- **The snapshot store defaults to sqlite** on a PVC in the instance's namespace (zero setup); **Postgres** is opt-in
  via `DATABASE_URL` — j2 points at a database you provide, it never deploys or operates one (the single-table,
  single-writer snapshot fits sqlite, and `replicas: 1` keeps it single-writer).
- Git credentials for private repos: an HTTPS token from `.env`, or a `j2-git-ssh` deploy-key Secret `j2 up` offers to
  generate (ADR-0019). Kube target: the current `kubectl` context (`--context` to override).

## Agents ship as npm; instances compose or override

The kit publishes to npm under `@j2/*`; stock Agent definitions ship in **`@j2/agents`** (coder, reviewer, …). Because a
definition is plain data (ADR-0018), composition needs no API: an instance file re-exports a stock one
(`export { coder as default } from "@j2/agents"` — filename-discovery stays the single registration mechanism) or
extends it by spread (`export default defineAgent({ ...coder, model: "…" })`). Adding tools/skills waits on the
definition contract growing that seat (ADR-0018).

## Orchestrator HTTP API (hono, run-addressed-by-id)

Push + control + observe only — the **pull** path needs no HTTP (the Orchestrator's Source pulls, ADR-0017). Auth bands
per ADR-0014: structure + observation open; the Agent surface takes the Sandbox token; run state, control, and gates
take the Instance token.

```
GET  /workflows                        # list registered workflows                       [open]
GET  /workflows/:name/machine  /viz/*  # machine structure + visualizer                  [open]
GET  /workflows/:name/runs[, /:runId/events]  # observation projection (ADR-0014)        [open]
GET  /workflows/:name/events           # SSE: the whole workflow, level-triggered (ADR-0022) [open]
POST /workflows/:name/runs             # start a run (push work); body = input → { runId } [instance]
GET  /runs   GET /runs/:runId          # live list; durable run status (read-through)    [instance]
GET  /runs/resolve?prefix=<p>          # run ids sharing a prefix, live + settled        [instance]
GET  /runs/:runId/events               # SSE: status replay + live deltas                [instance]
POST /runs/:runId/events               # run-level infra interrupt: CANCEL               [instance]
POST /runs/:runId/gates/:gate/events   # deliver a workflow event to an open gate        [instance]
GET  /agents/:iid/surface   POST /agents/:iid/events   # the Adapter's surface           [sandbox]
GET  /healthz   GET /readyz
```

Gates are the human/webhook/CI seam (ADR-0011): a gated state registers `{ gate, accepts, meta }`; `GET /runs/:runId`
lists the open gates (with schemas + `meta`), and the gate POST validates the body against the named event schema and
delivers it into that state. Per-gate addressing exists because concurrent children park concurrently — a run-level
events POST is ambiguous. `CANCEL` is the one reserved run-level event; everything else is workflow vocabulary. It
**ends** the run — its Agents' turns end with it and it does not restore
([ADR-0025](0025-cancel-ends-a-run-stop-parks-it.md)).

## The `j2` CLI

```
# lifecycle (instance)
j2 init [dir] [--name <n>]        # scaffold the minimum runnable instance
j2 up [--yes]                     # converge the current context to this instance (ADR-0019)
j2 down [--all]                   # remove the instance from the cluster (--all: operator too)

# runs / workflows (wrap the HTTP API)
j2 run <workflow> [--input <json>] [--detach]
j2 runs   j2 status <runId|abbrev>   j2 logs <runId|abbrev> [-f]
j2 send <runId|abbrev> --event CANCEL
j2 send <runId|abbrev> --gate <gate> --event <name> [--input <json>]

# workspaces (kubectl-style, over the operator's Sandbox CRs)
j2 ls                             # list workspaces + run + status + endpoint
j2 ssh <workspace>                # exec into the Sandbox's harness container (ADR-0037)
j2 logs <workspace>   j2 rm <workspace>
```

`j2 ssh` is `kubectl exec -c harness` into the Sandbox Image
([ADR-0037](0037-an-instance-builds-its-sandbox-images-j2-injects-the-harness.md)) — the inspect seat: the agent's own
tools, worktrees, and filesystem. The optional User Container ([ADR-0005](0005-sandbox-pod-composition.md)) is reached
by its own front door (its sshd, or `kubectl exec -c user`), not by this verb — its point is sessions and services the
agent's container must not host.

The CLI is the everyday surface; HTTP is the machine-to-machine one. The workspace verbs make the orchestrator feel like
`kubectl` for agents: the run↔workspace link rides on the CR's labels (`j2.dev/run`, `j2.dev/workflow`), so `j2 ls` can
group without the orchestrator being reachable. CLI and hono app sit on one shared API client.

A planned `j2 build` (build + push + render manifests, no apply — the pure-GitOps CI verb) is deferred; `j2 up` in CI
covers the interim (ADR-0019).

## Settled CLI behavior (v1)

**Instance addressing.** The CLI finds its instance by walking up from cwd to the directory containing `j2.config.ts` —
the root marker. The _deployment_ is addressed by the current kube context + the instance's namespace: run-verbs
port-forward the Orchestrator Service for the duration of the command and read the Instance token from its in-cluster
Secret (kube RBAC is the gate). `--url` / `J2_URL` (+ token env) overrides both — the ingress-exposed/remote-caller case
— and skips the folder walk entirely. Every run-verb prints the context it targets on stderr, so ambient-context drift
is visible (ADR-0019).

**`j2 run` — blocking, attach-by-default.** Start the run, stream activity to **stderr**, print the terminal `RunStatus`
as JSON to **stdout**, exit — so `j2 run … | jq` yields just the result. It **attaches to the running orchestrator**,
not a temporary per-invocation runtime — a j2 run is durable and may park on a Gate indefinitely, outliving the CLI
call. `--detach` starts the run, prints its `runId`, returns.

**Attach / detach / re-attach.** A run lives server-side, so attaching = opening `GET /runs/:runId/events` and detaching
= closing it (Ctrl-C); neither affects the run. `j2 logs <runId> -f` re-attaches to any running run. On attach, the SSE
**replays the run's current status immediately** (so a parked run shows where it is) before streaming live deltas; it
carries `status` events (auto, per transition) and `emit` events (the workflow author's `emit({…})`).

**Terminal runs stay readable.** The final snapshot persists to the store before the run drops from the live registry,
so `status` / `GET /runs/:runId` **read through to the store** — a completed run reports its terminal status/context
instead of `404`. (`GET /runs` stays live-only; history via `?all` is deferred.)

**Run ids abbreviate to a unique prefix.** A run id is a bare uuid, so every id-taking verb takes a git-style short
form: `j2 status 1a2b3c4d`. **Prefix only** — not fuzzy, not suffix — which keeps it an indexed range scan and keeps the
mental model borrowed intact. Four characters is the floor, and that floor is about **noise, not safety**: a short
prefix never resolves to the wrong run, it resolves to a list. Safety comes from ambiguity being an error — matching
more than one id prints the candidates and fails (exit 1), never guesses. A malformed or too-short argument is a usage
failure (exit 2); a full id short-circuits resolution entirely, so scripted pipelines issue unchanged traffic.

**The CLI resolves; the addressed routes stay full-id.** Abbreviation is a human affordance and lives on the human
surface — `GET /runs/resolve` answers prefix→ids, and the CLI then addresses the run by its full id. `/runs/:runId` and
both event POSTs never accept a prefix, because **a prefix is not an identity**: one that resolves today goes ambiguous
tomorrow when an unrelated run starts, and `j2 send <prefix> --event CANCEL` is a write. Resolving as a separate
read-only step is what guarantees no write is ever prefix-sensitive. (It also gives a bad id a real error: `host.stop()`
returns silently for an unknown run, so an unresolved CANCEL used to report success.)

The candidate set is the ids that **exist**, not the ones that read: `lost` runs are included, because dropping them
would let a prefix they share with a live run resolve silently to the live one. The set unions the live registry with
the store — neither alone is complete, since `persist()` is microtask-scheduled (a just-started run is live before it is
stored) and a settled run is stored but not live. Note the deliberate tension with `GET /runs`'s deferred `?all`: this
route does reveal that settled run **ids** exist to an Instance-token holder. It answers ids only — no status, no
context, no gates — to keep that widening as small as the feature allows, and it is Instance-only rather than open,
since prefix probing on an open route would be a run-id enumeration oracle.

**`j2 init` (v1).** Scaffolds the minimum runnable instance: `j2.config.ts` (root marker), `package.json` (deps on
`@j2/*` + xstate), one starter `workflows/<name>.ts`, and `.gitignore` (`.j2/`, `.env`, `node_modules/`). `[dir]`
positional (default cwd); `--force` to overwrite an existing `j2.config.ts`. `agents/`, `manifests/`, and `.env` are
added by their later slices. No auto-install — it prints the `pnpm install && j2 up` next step.

## Consequences

- All `packages/*` publish to npm under `@j2/*`; instances depend on them. The CLI ships as the `j2` bin (`npx j2`).
- Workspaces are a first-class CLI resource backed by the operator's `Sandbox` CRs, label-linked to their runs.
- Dynamic third-party workflow/plugin loading stays deferred (ADR-0008); discovery is over the instance's own code.
