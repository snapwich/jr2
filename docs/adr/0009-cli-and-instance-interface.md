# The `jr2` CLI and instance interface

ADR-0008 fixed that jr2 is a library + CLI and that an Orchestrator instance is a user-owned folder hosting many
workflows. This ADR fixes the **instance folder convention**, the **orchestrator HTTP API**, and the **`jr2` CLI** — one
set of conventions both sides of the system speak. Operational mechanics (how `jr2 up` converges a cluster, addressing,
secrets) live in ADR-0019.

## Instance folder convention (filename discovery)

```
my-orchestrator/
  jr2.config.ts     # instance config: reach and credentials — harness, git.credentials, registry; nothing a Machine names (ADR-0050)
  workflows/       # filename-discovered: workflows/review.ts (contract: export const machine) → "review"
  images/default/  # the fallback docker context a `workspace()` with no `image` uses (ADR-0037); a path convention, not discovery
  manifests/       # user-supplied objects applied by `jr2 up` (e.g. SealedSecrets); optional
  .env             # local secrets + deployment-varying env; uncommitted
  .jr2/             # scratch; nothing durable lives on the host (state is in-cluster, ADR-0019)
```

`workflows/<name>.ts` registers a workflow named `<name>` via `export const machine` — the one-export module contract
(ADR-0015; vocabulary rides the machine object, so there is no manifest export). Workflows are the one discovered kind
because nothing in code names one: `jr2 run` and the API do. Agents, images, and Repos are named from Machines, so they
ride the Machine — Agent slots, `workspace()` options, Repo Slots (ADR-0049, ADR-0051) — and nothing in config names
them (ADR-0050).

**The instance repo is a deployment assembly, not a sharing unit** (ADR-0019): reusable workflows/agents are published
as npm packages and re-exported here; `jr2.config.ts` holds only what is specific to this deployment's reach,
credentials, and cluster — committed, because the instance repo is the GitOps unit (ADR-0008), with deployment-varying
values resolved from env.

## Minimum config, and the Repo cache

`jr2.config.ts` favors convention over configuration — an Instance whose Machines compose Sandboxes can be as small as:

```ts
import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  name: "my-orchestrator",
  git: { credentials: [{ match: "*", token: "JR2_GIT_TOKEN", sshKey: "jr2-git-ssh" }] }, // narrow before untrusted runs
});
```

- **`name` is the instance's identity**; its namespace defaults to it (`-n` overrides — ADR-0019).
- **There is no `repos` list.** A Repo is a slot on a `workspace()`, bound by url (ADR-0051); `jr2.config.ts` holds what
  reaches one — `git.credentials`, the prefix-matched list that is also the fence a per-run slot's url must pass. The
  scaffold writes one wildcard entry, commented, for the user to narrow (ADR-0051). The operator keeps a bare cache per
  node from the `Repo` resources the Orchestrator creates off its Machines (ADR-0004); Sandboxes clone `--shared`
  against it. There is no host-side directory — a Repo pods should see must be fetchable from the cluster.
- **A registered Machine that composes a Sandbox is the data-plane switch** (ADR-0051), read off `jr2 up`'s walk: with
  one, the instance gets the kubectl Sandbox backend; without one, the instance is workspace-less. There is **no
  `images` config block**: `jr2 up` builds every image it deploys and resolves each to a content-addressed tag
  ([ADR-0038](0038-jr2-up-builds-every-image-it-deploys.md)). Image composition is per Workspace, not per instance — a
  `workspace()` names its Sandbox Image statically (a `file:` docker context the Machine ships or a registry ref,
  [ADR-0037](0037-an-instance-builds-its-sandbox-images-jr2-injects-the-harness.md),
  [ADR-0049](0049-a-machine-carries-its-parts-and-composes-by-invoke.md)) and opts into a User Container the same way
  ([ADR-0005](0005-sandbox-pod-composition.md)); `images/default` is the one path convention `jr2 up` still checks.
  Every Sandbox gets an Adapter — an Agent without one cannot act (ADR-0013) — and that is not configurable.
  Agent-runtime concerns live in `harness` (ADR-0018).
- **`harness` is the agent-runtime section** (ADR-0018): custom provider (`api`, `baseUrl`) and the env/creds the Agents
  need (e.g. an Anthropic key, read from `process.env`/`.env` and materialized as a Secret by `jr2 up`, or `envFrom`
  refs to Secrets you manage) — never which model to use; each definition names its own (ADR-0018).
- **`registry`** (deployment-varying, resolve from env): absent → images are `kind load`-ed; present → pushed
  (ADR-0019). **`kitRegistry`** (also env) re-homes the published Kit image refs for self-hosted, air-gapped, or
  mirror-only clusters ([ADR-0044](0044-kit-images-live-at-a-canonical-home-a-self-host-mirrors-it.md)).
- **The snapshot store defaults to sqlite** on a PVC in the instance's namespace (zero setup); **Postgres** is opt-in
  via `DATABASE_URL` — jr2 points at a database you provide, it never deploys or operates one (the single-table,
  single-writer snapshot fits sqlite, and `replicas: 1` keeps it single-writer).
- Git credentials for private repos: an HTTPS token from `.env`, or a `jr2-git-ssh` Secret holding the key `jr2 up`
  asked the user to choose — a generated in-cluster deploy keypair (the recommended default), a local key, or one pasted
  on stdin (ADR-0019, [ADR-0047](0047-the-git-ssh-key-source-is-the-users-choice.md)). Kube target: the current
  `kubectl` context (`--context` to override).

## Machines ship as npm; instances compose or customize

The kit publishes to npm under `@jr2/*`; stock Agent definitions ship in **`@jr2/agents`** (coder, reviewer, …), and a
package may ship whole Machines with their Agents and image inside (ADR-0049). Because a definition is plain data
(ADR-0018), composition needs no API: a Machine carries `agent(coder)`, a workflows file exports a packaged Machine
as-is or through `customize(machine, { agents: { coder: { model: "…" } } })`. Adding tools/skills waits on the
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
GET  /repos                            # per-Repo node-cache sync state (ADR-0048)        [instance]
GET  /agents/:iid/surface   POST /agents/:iid/events   # the Adapter's surface           [sandbox]
GET  /healthz   GET /readyz
```

`GET /repos` is [ADR-0048](0048-the-orchestrator-boots-without-its-repos.md)'s observability half: a failed clone
degrades the Repo, not the boot, so each `Repo` resource's status (per node: synced, or git's own error) is a thing to
ask the instance for, read off the resources (ADR-0051). `jr2 status` with **no** run id renders it — the place
ADR-0047's "register the key, the cache agent retries" points at. Instance band, not open: a row names a Repo and
carries git's error text, exactly the class of author/deployment detail the open projections strip (ADR-0014).

Gates are the human/webhook/CI seam (ADR-0011): a gated state registers `{ gate, accepts, meta }`; `GET /runs/:runId`
lists the open gates (with schemas + `meta`), and the gate POST validates the body against the named event schema and
delivers it into that state. Per-gate addressing exists because concurrent children park concurrently — a run-level
events POST is ambiguous. `CANCEL` is the one reserved run-level event; everything else is workflow vocabulary. It
**ends** the run — its Agents' turns end with it and it does not restore
([ADR-0025](0025-cancel-ends-a-run-stop-parks-it.md)).

## The `jr2` CLI

```
# lifecycle (instance)
jr2 init [dir] [--name <n>]        # scaffold the minimum runnable instance
jr2 up [--yes]                     # converge the current context to this instance (ADR-0019)
jr2 down [--all]                   # remove the instance from the cluster (--all: operator too)
jr2 gc [--dry-run]                 # sweep unreachable labeled images — the same sweep up/down run (ADR-0039)

# kit (instance-less)
jr2 kit push <registry>            # mirror the published Kit images into a self-hosted registry (ADR-0044)

# what runs where
jr2 version [--local] [--json]     # this jr2, the global that handed off, the Instance's Kit, and what the cluster runs

# runs / workflows (wrap the HTTP API)
jr2 run <workflow> [--input <json>] [--detach]
jr2 runs   jr2 status [runId|abbrev]   jr2 logs <runId|abbrev> [-f]   # bare `status` = the instance's repos (ADR-0048)
jr2 send <runId|abbrev> --event CANCEL
jr2 send <runId|abbrev> --gate <gate> --event <name> [--input <json>]

# workspaces (kubectl-style, over the operator's Sandbox CRs) — decided, not yet in the binary
jr2 ls                             # list workspaces + run + status + endpoint
jr2 ssh <workspace>                # exec into the Sandbox's harness container (ADR-0037)
jr2 logs <workspace>   jr2 rm <workspace>
```

`jr2 ssh` is `kubectl exec -c harness` into the Sandbox Image
([ADR-0037](0037-an-instance-builds-its-sandbox-images-jr2-injects-the-harness.md)) — the inspect seat: the agent's own
tools, worktrees, and filesystem. The optional User Container ([ADR-0005](0005-sandbox-pod-composition.md)) is reached
by its own front door (its sshd, or `kubectl exec -c user`), not by this verb — its point is sessions and services the
agent's container must not host.

The CLI is the everyday surface; HTTP is the machine-to-machine one. The workspace verbs make the orchestrator feel like
`kubectl` for agents: the run↔workspace link rides on the CR's labels (`jr2.dev/run`, `jr2.dev/workflow`), so `jr2 ls`
can group without the orchestrator being reachable. CLI and hono app sit on one shared API client.

A planned `jr2 build` (build + push + render manifests, no apply — the pure-GitOps CI verb) is deferred; `jr2 up` in CI
covers the interim (ADR-0019).

## Settled CLI behavior (v1)

**Instance addressing.** The CLI finds its instance by walking up from cwd to the directory containing `jr2.config.ts` —
the root marker. The _deployment_ is addressed by the current kube context + the instance's namespace: run-verbs
port-forward the Orchestrator Service for the duration of the command and read the Instance token from its in-cluster
Secret (kube RBAC is the gate). `--url` / `JR2_URL` (+ token env) overrides both — the ingress-exposed/remote-caller
case — and skips the folder walk entirely. Every run-verb prints the context it targets on stderr, so ambient-context
drift is visible (ADR-0019).

**Two output classes (amended 2026-09-20).** The stream rule below — JSON result on stdout, activity on stderr — was
written for `jr2 run`, whose reason is the pipe: `jr2 run … | jq` must yield the result alone. It generalises to every
**result verb** — `run`, `runs`, `status <runId>`, `send`, `logs` — because their result is small and the stderr lines
beside it are advisory. It does not generalise to a **report verb** — `version`, and `status` with no run id — whose
output is a diagnosis a human reads whole: dual-printing there shows a JSON blob and a partial table, and the readable
form exists nowhere. So a report verb prints its human table on **stdout**, and `--json` swaps the table for the one
object. No `isatty` sniffing: output that changes with how it is invoked is a debugging trap of its own. `up`, `down`,
`gc` are neither class — activity only, no result.

**`jr2 version` (amended 2026-09-20).** The report you paste into a bug: what is _here_ and what is _deployed_, side by
side, so the gap between the halves is the answer ("you edited the pin and never ran `jr2 up`"). The local half: `cli`
(the copy that runs — version + real path, so the path says global or Instance), `global` (the copy that handed off,
ADR-0056), `kit` (the `@jr2/orchestrator` the Instance resolves + the ADR-0056 check result, and
`package.json pins X, reinstall` when the manifest disagrees with what is installed), `instance` (name, root, and mode:
kit checkout or installed from which registry — the reader needs the mode to know whether deployed Kit tags are versions
or content hashes), `node`. The deployed half, best-effort: `orchestrator` (what the pod answers on `/healthz` —
version + hash, flagging a Deployment label that disagrees as an incomplete rollout), `operator` (its version label —
never downgraded, so no skew verdict on it), `harness`/`adapter` and any Sandbox Image refs from the `jr2-images`
ConfigMap pods actually read, and one `skew` verdict comparing the two kit numbers: `same`/`behind`/`ahead`/`unknown`,
with the `jr2 up` consequence spelled out and, in checkout mode, a reminder that `same` is weak and the hash is the
address. Nothing is computed that `jr2 up` computes: no bundle staging, no local hash. It is the one Instance verb that
reads the Instance without asserting it — a Kit mismatch is a line, never the ADR-0056 refusal, because this is the verb
you reach for when that refusal fires. It hands off like every verb. `TARGET_ARGS` as every run verb; `--url` leaves
only the orchestrator line; `--local` skips the cluster. Exit 0 whatever it finds: a report. No registry lookup: "out of
date" here means behind the Instance, and `npm view` answers the other question.

**`jr2 run` — blocking, attach-by-default.** Start the run, stream activity to **stderr**, print the terminal
`RunStatus` as JSON to **stdout**, exit — so `jr2 run … | jq` yields just the result. It **attaches to the running
orchestrator**, not a temporary per-invocation runtime — a jr2 run is durable and may park on a Gate indefinitely,
outliving the CLI call. `--detach` starts the run, prints its `runId`, returns.

**Attach / detach / re-attach.** A run lives server-side, so attaching = opening `GET /runs/:runId/events` and detaching
= closing it (Ctrl-C); neither affects the run. `jr2 logs <runId> -f` re-attaches to any running run. On attach, the SSE
**replays the run's current status immediately** (so a parked run shows where it is) before streaming live deltas; it
carries `status` events (auto, per transition) and `emit` events (the workflow author's `emit({…})`).

**Terminal runs stay readable.** The final snapshot persists to the store before the run drops from the live registry,
so `status` / `GET /runs/:runId` **read through to the store** — a completed run reports its terminal status/context
instead of `404`. (`GET /runs` stays live-only; history via `?all` is deferred.)

**Run ids abbreviate to a unique prefix.** A run id is a bare uuid, so every id-taking verb takes a git-style short
form: `jr2 status 1a2b3c4d`. **Prefix only** — not fuzzy, not suffix — which keeps it an indexed range scan and keeps
the mental model borrowed intact. Four characters is the floor, and that floor is about **noise, not safety**: a short
prefix never resolves to the wrong run, it resolves to a list. Safety comes from ambiguity being an error — matching
more than one id prints the candidates and fails (exit 1), never guesses. A malformed or too-short argument is a usage
failure (exit 2); a full id short-circuits resolution entirely, so scripted pipelines issue unchanged traffic.

**The CLI resolves; the addressed routes stay full-id.** Abbreviation is a human affordance and lives on the human
surface — `GET /runs/resolve` answers prefix→ids, and the CLI then addresses the run by its full id. `/runs/:runId` and
both event POSTs never accept a prefix, because **a prefix is not an identity**: one that resolves today goes ambiguous
tomorrow when an unrelated run starts, and `jr2 send <prefix> --event CANCEL` is a write. Resolving as a separate
read-only step is what guarantees no write is ever prefix-sensitive. (It also gives a bad id a real error: `host.stop()`
returns silently for an unknown run, so an unresolved CANCEL used to report success.)

The candidate set is the ids that **exist**, not the ones that read: `lost` runs are included, because dropping them
would let a prefix they share with a live run resolve silently to the live one. The set unions the live registry with
the store — neither alone is complete, since `persist()` is microtask-scheduled (a just-started run is live before it is
stored) and a settled run is stored but not live. Note the deliberate tension with `GET /runs`'s deferred `?all`: this
route does reveal that settled run **ids** exist to an Instance-token holder. It answers ids only — no status, no
context, no gates — to keep that widening as small as the feature allows, and it is Instance-only rather than open,
since prefix probing on an open route would be a run-id enumeration oracle.

**`jr2 init` (v1).** Scaffolds the minimum runnable instance: `jr2.config.ts` (root marker), `package.json` (deps on
`@jr2/*` + xstate), one starter `workflows/<name>.ts`, `images/default/Dockerfile` (the Sandbox Image every Workspace
falls back to, ADR-0037), and `.gitignore` (`.jr2/`, `.env`, `node_modules/`). `[dir]` positional (default cwd);
`--force` to overwrite an existing `jr2.config.ts`. `manifests/` and `.env` are added by their later slices. No
auto-install — it prints the next step, naming no package manager, since the instance's lockfile is what picks one
([ADR-0043](0043-the-kit-is-tested-as-installed-a-local-registry-stands-in-for-npm.md)).

## Consequences

- The instance-facing packages (`@jr2/cli`, `@jr2/orchestrator`, `@jr2/agent-protocol`) publish to npm; `@jr2/harness`
  and `@jr2/adapter` ship inside Kit images, never via npm
  ([ADR-0043](0043-the-kit-is-tested-as-installed-a-local-registry-stands-in-for-npm.md)). The CLI ships as the `jr2`
  bin (`npx jr2`).
- Workspaces are a first-class CLI resource backed by the operator's `Sandbox` CRs, label-linked to their runs.
- Dynamic third-party workflow/plugin loading stays deferred (ADR-0008); discovery is over the instance's own code.
