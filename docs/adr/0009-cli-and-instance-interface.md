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
  Every Harness pod gets a Custodian — an Agent without one cannot act (ADR-0013, ADR-0059) — and that is not
  configurable. Agent-runtime concerns live in `harness` (ADR-0018).
- **`harness` is the agent-runtime section** (ADR-0018): custom provider (`api`, `baseUrl`), the gateways pi's catalog
  providers call (`catalog`) and any other env — never which model to use; each definition names its own (ADR-0018).
- **`secrets` is the Instance's one list of secrets**
  ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)): the credentials the Agents use — an
  Anthropic key, read from `process.env`/`.env`, held by the Custodian and never by the Harness (ADR-0059) — and the
  ones an Effect names, which only its Effector holds. Where each goes is read, never declared.
- **`mcp` is the Instance's MCP servers**
  ([ADR-0079](0079-an-agent-holds-mcp-tools-a-machine-calls-them-as-an-effect-and-the-machine-is-the-approval.md)): each
  by a name that the author chooses, remote (`url`, an optional `secret`) or stdio (`command`, `args`), with a
  `timeout`. An Agent and an `mcp` Effect name a server by that name.
- **`callers`, `hooks` and `cors`** are the Instance's reach for Callers
  ([ADR-0078](0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md)): the named Caller tokens
  and the JWT issuers with their scopes, the Hooks with their credentials and the Hook kinds that the config imports,
  and the origins a browser app may call from.
- **`registry`** (deployment-varying, resolve from env): absent → images are `kind load`-ed; present → pushed
  (ADR-0019). **`kitRegistry`** (also env) re-homes the published Kit image refs for self-hosted, air-gapped, or
  mirror-only clusters ([ADR-0044](0044-kit-images-live-at-a-canonical-home-a-self-host-mirrors-it.md)).
- **The snapshot store is sqlite** on a PVC in the instance's namespace (zero setup); no other store is owed
  ([ADR-0065](0065-a-persist-survives-a-crash-and-history-is-kept-for-a-set-time.md)) — the single-table, single-writer
  snapshot fits sqlite, and `replicas: 1` keeps it single-writer. The kept conversations are a second sqlite file on the
  same volume ([ADR-0023](0023-the-harness-prints-the-conversation.md)).
- **`runs`** sets how long jr2 keeps an ended run and the size of the state volume, `{ retain: "30d", volume: "5Gi" }`
  by default (ADR-0065).
- Git credentials for private repos: an HTTPS token from `.env`, or a `jr2-git-ssh` Secret holding the key `jr2 up`
  asked the user to choose — a generated in-cluster deploy keypair (the recommended default), a local key, or one pasted
  on stdin (ADR-0019, [ADR-0047](0047-the-git-ssh-key-source-is-the-users-choice.md)). Kube target: the current
  `kubectl` context (`--context` to override).

## Machines ship as npm; instances compose or customize

The kit publishes to npm under `@jr2/*`; stock Agent definitions ship in **`@jr2/agents`** (coder, reviewer, …), and a
package may ship whole Machines with their Agents and image inside (ADR-0049). Because a definition is plain data
(ADR-0018), composition needs no API: a Machine carries `agent(coder)`, a workflows file exports a packaged Machine
as-is or through `customize(machine, { agents: { coder: { model: "…" } } })`. An Agent's tools beyond its own come from
the MCP servers that it names, and the same `customize()` rebinds them
([ADR-0079](0079-an-agent-holds-mcp-tools-a-machine-calls-them-as-an-effect-and-the-machine-is-the-approval.md)). Adding
skills waits on the definition contract growing that seat (ADR-0018).

## Orchestrator HTTP API (hono, run-addressed-by-id)

Push + control + observe only — the **pull** path needs no HTTP (the Orchestrator's Source pulls, ADR-0017). Auth bands
per ADR-0014: structure + observation open; the Agent surface takes the Sandbox token; run state, control, and gates
take a Caller with the scope in brackets (ADR-0078); `[instance]` is the Instance token alone.

```
GET  /workflows                        # list registered workflows                       [open]
GET  /workflows/:name/machine  /viz/*  # machine structure + visualizer                  [open]
GET  /workflows/:name/runs[, /:runId/events]  # observation projection (ADR-0014)        [open]
GET  /workflows/:name/runs/:runId/machine     # the run's own Machine, Charts compiled (ADR-0069) [open]
GET  /workflows/:name/events           # SSE: the whole workflow, level-triggered (ADR-0022) [open]
POST /workflows/:name/runs             # start a run (push work); body = input → { runId } [start]
                                       # a standing Workflow: resume a paused one [?drop-held=true] (ADR-0017)
GET  /runs                             # run summaries; ?status ?workflow ?since ?cursor  [read]
GET  /runs/:runId                      # durable run status (read-through)               [read]
GET  /runs/resolve?prefix=<p>          # run ids sharing a prefix, live + settled        [any scope]
GET  /runs/:runId/events               # SSE: status replay + live deltas                [read]
GET  /runs/:runId/conversations        # the run's kept conversations (ADR-0023)         [read]
GET  /runs/:runId/conversations/:iid[?after=<seq>]  /events   # entries; SSE follow   [read]
GET  /gates                            # open Gates the Caller may answer; ?workflow     [answer]
POST /runs/:runId/events               # run-level infra interrupt: CANCEL               [cancel]
POST /runs/:runId/gates/:gate/events   # deliver a workflow event to an open gate        [answer]
POST /runs/:runId/steering             # a Steering message to an Agent slot (ADR-0002)  [steer]
GET  /runs/:runId/agents               # the slot list, one row per Agent slot           [steer]
GET  /whoami                           # the request's Caller record (ADR-0078)          [any Caller]
POST /hooks/:name                      # a Hook's delivery (ADR-0011)                    [the Hook's verifier]
GET  /hooks/:name                      # the Hook's log, newest first (ADR-0011)         [instance]
GET  /repos                            # per-Repo node-cache sync state (ADR-0048)        [instance]
GET  /agents/:iid/surface   POST /agents/:iid/events   # the Menu, via the Custodian    [sandbox]
POST /agents/:iid/conversation         # a batch of the record's entries (ADR-0023)      [sandbox]
POST /sandboxes/:name/fetch                            # the ask (ADR-0053)             [sandbox]
GET  /healthz   GET /readyz
```

`GET /repos` is [ADR-0048](0048-the-orchestrator-boots-without-its-repos.md)'s observability half: a failed clone
degrades the Repo, not the boot, so each `Repo` resource's status (per node: synced, or git's own error) is a thing to
ask the instance for, read off the resources (ADR-0051). `jr2 status` with **no** run id renders it — the place
ADR-0047's "register the key, the cache agent retries" points at. Instance band, not open: a row names a Repo and
carries git's error text, exactly the class of author/deployment detail the open projections strip (ADR-0014).

Gates are the human/webhook/CI seam (ADR-0011): a gated state registers `{ gate, accepts, meta }`; `GET /runs/:runId`
lists the open gates (with schemas + `meta`), `GET /gates` lists the open Gates of every live run that the Caller may
answer, and the gate POST validates the body against the named event schema and delivers it into that state. Per-gate
addressing exists because concurrent children park concurrently — a run-level events POST is ambiguous. `CANCEL` is the
one reserved run-level event; everything else is workflow vocabulary. It **ends** the run — its Agents' turns end with
it and it does not restore ([ADR-0025](0025-cancel-ends-a-run-stop-parks-it.md)).

## The `jr2` CLI

```
# lifecycle (instance)
jr2 init [dir] [--name <n>]        # scaffold the minimum runnable instance
jr2 check                          # the typecheck and the Machine walk of `up`, with no cluster (ADR-0050)
jr2 up [--yes] [--force] [--skip-provider-preflight]
                                   # converge the current context to this instance (ADR-0019)
jr2 down [--all] [--yes]           # remove the instance from the cluster (--all: operator too)
jr2 gc [--dry-run]                 # sweep unreachable labeled images — the same sweep up/down run (ADR-0039)

# kit (instance-less)
jr2 kit push <registry>            # mirror the published Kit images into a self-hosted registry (ADR-0044)

# what runs where
jr2 version [--local] [--json]     # this jr2, the global that handed off, the Instance's Kit, and what the cluster runs

# runs / workflows (wrap the HTTP API)
jr2 run <workflow> [--input <json>] [--detach]
jr2 run <workflow> [--drop-held]   # resume a paused standing Pool (ADR-0017)
jr2 runs [--status <s>] [--workflow <w>] [--since <d>]   # live runs by default; `--status ended|all|<list>`
jr2 workflows [--json]             # the Workflows a run can start, with their origins and Charts (ADR-0070)
jr2 status [runId|abbrev]          # bare `status` = the instance's repos (ADR-0048)
jr2 watch <runId|abbrev> [--json]  # the run's status feed, followed to its end
jr2 logs <runId|abbrev> [agent] [-f]   # the run's conversations, printed as ADR-0023 prints them
jr2 gates [--workflow <w>]         # the open Gates this Caller may answer, oldest first
jr2 send <runId|abbrev> --event CANCEL
jr2 send <runId|abbrev> --gate <gate> --event <name> [--input <json>]
jr2 steer <runId|abbrev> [<agent> "<text>"]   # a Steering message; the slots alone (ADR-0002)

# Callers and Hooks (ADR-0078, ADR-0011)
jr2 whoami                         # the Caller this credential is
jr2 caller token <name>            # print a named Caller token's value
jr2 caller rotate <name>           # make a new value; the old one stops working
jr2 hooks <name>                   # the Hook's log of deliveries

# workspaces (kubectl-style, over the operator's Sandbox CRs; kube credentials only)
jr2 workspace ls [run]             # the Workspaces, with run, path, status and age
jr2 workspace shell <ws> [--user] [-- <cmd>]   # a shell in the Workspace, as its Agents work (--user: the User Container)
jr2 workspace forward <ws> <port> [--stdio]    # a local port to a port in the pod (--stdio: an ssh ProxyCommand)
jr2 workspace rm <ws>              # remove a Sandbox that no live run holds

# shell completion
jr2 completion bash|zsh|fish       # the completion script, generated from the command table
```

**The workspace verbs read the cluster, not the Orchestrator.** They use the kube credentials of the current context and
no Caller scope, so they work when the Orchestrator is down, and kube RBAC is the gate. A Workspace's handle is
`<run-prefix>/<workspace path>`: a prefix of its run's id and its path in the run's Machine, read off the CR's label
`jr2.dev/run` and its annotation `jr2.dev/workspace-path` ([ADR-0012](0012-workspace-wrapper-machine.md)). The CLI lists
the instance's CRs and compares on the client, because a label selector cannot match a prefix. `workspace ls` prints the
exact path. The CR's name is also a handle, and a handle that ends in `.jr2` is the CR's name with that suffix, for the
ssh config below. A handle that matches more than one Workspace prints the candidates and fails, as a run prefix does.

- **`workspace shell`** asks the Harness to start a shell through its spawner, so the shell is a process of the Agents'
  Landlock domain, with its env, the Workspace's grants and its cwd
  ([ADR-0076](0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md)). It can signal and trace
  the Agents' processes, as a later `bash` call can. So the shell has the agent's own tools, worktrees and filesystem
  ([ADR-0037](0037-an-instance-builds-its-sandbox-images-jr2-injects-the-harness.md)), and it never reaches the control
  Stand-in or any Stand-in that the Workspace does not grant. `-- <cmd>` runs one command in place of a shell. `--user`
  is `kubectl exec -c user` into the optional User Container ([ADR-0005](0005-sandbox-pod-composition.md)), where jr2
  starts nothing of its own.
- **`workspace forward`** is a port-forward to the Sandbox pod: a local port to `<port>` in the pod's network namespace,
  which reaches a server the Agent started or the User Container's sshd. It prints `127.0.0.1:<local port>` and holds
  the forward until Ctrl-C. With `--stdio` it carries the connection on its stdin and stdout, so it is an ssh
  `ProxyCommand`: `Host *.jr2` with `ProxyCommand jr2 workspace forward %h 22 --stdio -n <namespace>`, where the host is
  the CR's name with `.jr2` after it. ssh runs the command in any folder, and with `-n` the verb needs no instance
  folder. There is no routable Service for the User Container; the forward reaches it through the kube API.
- **`workspace rm`** deletes a Sandbox that no live run holds: an ended run's Sandbox that waits for its idle timeout,
  or one that a fault left as evidence (ADR-0021). It refuses the Sandbox of a live run and says "cancel the run first".
  It tells from the cluster alone, with no Orchestrator, by the hold mark that the Lease writes on the CR (ADR-0021):
  `jr2.dev/hold` is `held` from the Lease's first write, and the Lease sets it to `released` when it stops for the
  body's final state, a fault, a cancel or a parent that leaves the Workspace's state, but not while a live Workspace of
  the run holds the same name (a parent that invokes the same Machine again after a defect). A restore that ends a run
  `drifted` or `lost` without hosting it marks each of its CRs `released`. A park and a process shutdown write nothing,
  so the CR of a run that an Orchestrator crash left stays `held`. `rm` removes a CR that is `released`, and a CR whose
  `jr2.dev/keepalive` is older than the CR's idle timeout, which the operator reaps then in any case. It refuses every
  other CR, a CR with no mark included. It measures the keepalive's age on the API server's clock (the `Date` header of
  its answer), not on the local clock, so a fast laptop clock cannot make a live Sandbox look free. There is no
  `--force`: the run owns its Workspace's life (ADR-0012).

Pod logs stay `kubectl logs`. The conversations of a Workspace's Agents are `jr2 logs <run> [agent]`, which reads the
Orchestrator's record and works after the Sandbox is gone (ADR-0023).

**`jr2 completion`** prints the script for bash, zsh or fish, made from the command table, so a verb or a flag cannot
complete that the CLI does not take. It completes dynamic values too: Workspace handles (from the CR labels and the
`jr2.dev/workspace-path` annotation), live run ids, Workflow names, and the Agent slots of a run. A lookup that takes
more than 2 s offers nothing, so a slow cluster never holds the shell.

The CLI is the everyday surface; HTTP is the machine-to-machine one. The workspace verbs make the orchestrator feel like
`kubectl` for agents. CLI and hono app sit on one shared API client.

A planned `jr2 build` (build + push + render manifests, no apply — the pure-GitOps CI verb) is deferred; `jr2 up` in CI
covers the interim (ADR-0019).

## Settled CLI behavior (v1)

**Instance addressing.** The CLI finds its instance by walking up from cwd to the directory containing `jr2.config.ts` —
the root marker. The _deployment_ is addressed by the current kube context + the instance's namespace: run-verbs
port-forward the Orchestrator Service for the duration of the command and read the Instance token from its in-cluster
Secret (kube RBAC is the gate); its Caller is `token/instance`, on behalf of the kube user (ADR-0078). `--url` /
`JR2_URL` (+ `JR2_TOKEN`, any Caller's credential) overrides both — the ingress-exposed/remote-caller case — and skips
the folder walk entirely. Every run-verb prints the context it targets on stderr, so ambient-context drift is visible
(ADR-0019).

**The command table.** Each verb is an entry in `packages/cli/src/command-table.ts`: its arguments, its flags, the env
vars it reads, what it prints, and its ADRs, as data. The verb's `parseArgs` options come from its entry, and so does
the help, so a flag cannot be accepted and not documented, or documented and not read. `jr2 --help` prints the whole
table. `jr2 <verb> --help` or `-h` prints that verb's entry, runs nothing, and exits 0. A usage error prints the verb's
usage line. The CLI Reference of the docs is generated from the same table
([ADR-0072](0072-the-docs-ship-inside-the-kit-and-an-instances-agents-md-indexes-them.md)).

**Two output classes (amended 2026-09-20).** The stream rule below — JSON result on stdout, activity on stderr — was
written for `jr2 run`, whose reason is the pipe: `jr2 run … | jq` must yield the result alone. It generalises to every
**result verb** — `run`, `runs`, `status <runId>`, `gates`, `kit push` — because their result is small and the stderr
lines beside it are advisory. It does not generalise to a **report verb** — `version`, `status` with no run id, `watch`,
`logs` and `workspace ls` — whose output a human reads whole: dual-printing there shows a JSON blob and a partial table,
and the readable form exists nowhere. So a report verb prints its human table or lines on **stdout**, and `--json` swaps
them for the JSON (for `watch`, the feed's JSON frames; `logs` has no `--json`). No `isatty` sniffing: output that
changes with how it is invoked is a debugging trap of its own. `init`, `check`, `up`, `down`, `gc`, `send`,
`caller rotate` and `workspace rm` are neither class — activity only, no result. `workspace shell` and
`workspace forward --stdio` give the terminal to the session or the connection. `whoami` is a result verb. A **value
verb** — `caller token`, `completion`, `workspace forward` (its local address) — prints one value alone on stdout, not
JSON, and activity on stderr, because its one use is `JR2_TOKEN=$(jr2 caller token ci)`, and a JSON string there needs
`jq -r` for nothing. `caller rotate` prints no value: the new one is a `caller token` away, and a value is printed only
when it is asked for.

**`jr2 version` (amended 2026-09-20).** The report you paste into a bug: what is _here_ and what is _deployed_, side by
side, so the gap between the halves is the answer ("you edited the pin and never ran `jr2 up`"). The local half: `cli`
(the copy that runs — version + real path, so the path says global or Instance), `global` (the copy that handed off,
ADR-0056), `kit` (the `@jr2/orchestrator` the Instance resolves + the ADR-0056 check result, and
`package.json pins X, reinstall` when the manifest disagrees with what is installed), `instance` (name, root, and mode:
kit checkout or installed from which registry — the reader needs the mode to know whether deployed Kit tags are versions
or content hashes), `node`. The deployed half, best-effort: `orchestrator` (what the pod answers on `/healthz` —
version + hash, flagging a Deployment label that disagrees as an incomplete rollout), `operator` (its version label —
never downgraded, so no skew verdict on it), `harness`/`custodian` and any Sandbox Image refs from the `jr2-images`
ConfigMap pods actually read, and one `skew` verdict comparing the two kit numbers: `same`/`behind`/`ahead`/`unknown`,
with the `jr2 up` consequence spelled out and, in checkout mode, a reminder that `same` is weak and the hash is the
address. Nothing is computed that `jr2 up` computes: no bundle staging, no local hash. It is the one Instance verb that
reads the Instance without asserting it — a Kit mismatch is a line, never the ADR-0056 refusal, because this is the verb
you reach for when that refusal fires. It hands off like every verb. The shared addressing flags (`--url`, `-n`,
`--context`) as every run verb; `--url` leaves only the orchestrator line; `--local` skips the cluster. Exit 0 whatever
it finds: a report. No registry lookup: "out of date" here means behind the Instance, and `npm view` answers the other
question.

**`jr2 check`.** It runs the Instance check of `jr2 up` and nothing more. First it runs the Instance's own
`tsc --noEmit`. Then it loads each registered Workflow and walks its Machine. The load and the walk find the refusals
that the compiler cannot make: a refusal of `createMachine`, `defineEvent` or `workspace()` when a module loads, an Open
part, a Chart file, a dispatch, an Effect secret, a Size. It reads no kube context. It touches no cluster, docker or
registry, and it writes no file. When it refuses, it exits 1 with the `refusing:` or `error:` line of `jr2 up`. It is
one function with `jr2 up` (`checkInstance`), not a copy, so the two cannot disagree.

It is for an Assistant that may not run `jr2 up`. `npm run typecheck` loads no module. And `node` cannot import a
workflow module of an installed Instance. The kit's `.ts` sources are under `node_modules`, and Node does not strip
types there. The `jr2` binary strips them. The scaffold names `jr2 check` as its `check` script. The AGENTS.md block
names it as the step before the Assistant gives a change to the user (ADR-0072).

It does not stage the Assembly. Staging installs the production dependencies from the lockfile, and its refusals are
about that install. It also does not write the AGENTS.md block. An Assistant or CI must be able to run a check with no
diff as a result.

**`jr2 run` — blocking, attach-by-default.** Start the run, stream activity to **stderr**, print the terminal
`RunStatus` as JSON to **stdout**, exit — so `jr2 run … | jq` yields just the result. It **attaches to the running
orchestrator**, not a temporary per-invocation runtime — a jr2 run is durable and may park on a Gate indefinitely,
outliving the CLI call. `--detach` starts the run, prints its `runId`, returns.

**Attach / detach / re-attach.** A run lives server-side, so attaching = opening `GET /runs/:runId/events` and detaching
= closing it (Ctrl-C); neither affects the run. `jr2 watch <runId>` re-attaches to any run: it prints the lines that
`jr2 run` prints while it is attached, follows the run to its end, and for an ended run prints its last status once. It
exits 0 when it followed the feed to its end, for a failed or a parked run too: its exit code is the watch's, and
`jr2 run`'s is the run's result. On attach, the SSE **replays the run's current status immediately** (so a parked run
shows where it is) before streaming live deltas; it carries `status` events (auto, per transition) and `emit` events
(the workflow author's `emit({…})`).

**Terminal runs stay readable.** The final snapshot persists to the store before the run drops from the live registry,
so `status` / `GET /runs/:runId` **read through to the store** — a completed run reports its terminal status/context
instead of `404`.

**`GET /runs` lists history.** Its filters are `status` (`live` by default; `ended`, `all`, or a list of statuses),
`workflow` and `since` (a duration back from now, such as `7d`, or an ISO-8601 time). It lists the newest start first, a
page at a time: `limit` (50 by default, at most 500) and `cursor`, and the answer is `{ runs, next? }`. An item is a
summary, not the whole `RunStatus`:
`{ runId, workflow, status, reason?, startedBy?, startedAt, endedAt?, assembly?, openGates, placing?, dispatchedBy? }`,
where `placing` names the child paths of the Workspaces that wait for capacity
([ADR-0064](0064-a-workspace-waits-for-capacity.md)) and `dispatchedBy` names the run that started this one
([ADR-0071](0071-a-run-starts-a-run-through-a-dispatch-effect.md)), because `jr2 runs` prints both. A `drifted` run is
listed, with its reason (ADR-0030). A `live` row whose restore a boot deferred or that failed is listed as `active`,
with the reason `waiting for restore`. A run is listed while its row is kept (`runs.retain`, ADR-0065). `jr2 runs` takes
the same filters as `--status`, `--workflow` and `--since`.

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
stored) and a settled run is stored but not live. It answers ids only — no status, no context, no gates — to a Caller
with any scope for their Workflow, where `GET /runs` needs `read`, and it is guarded rather than open, since prefix
probing on an open route would be a run-id enumeration oracle. Any scope opens it, for the Workflows of that scope,
because a Caller that may only cancel or steer also addresses a run by a prefix.

**`jr2 init` (v1).** Scaffolds the minimum runnable instance: `jr2.config.ts` (root marker), `package.json` (deps on
`@jr2/*` + xstate), one starter `workflows/<name>.ts`, `images/default/Dockerfile` (the Sandbox Image every Workspace
falls back to, ADR-0037), `.gitignore` (`.jr2/`, `.env`, `node_modules/`), and `AGENTS.md` with a `CLAUDE.md` that
imports it (the index of the Kit's bundled docs for an Assistant, ADR-0072). `[dir]` positional (default cwd); `--name`
for the package name (default: the folder's name). It skips each file that exists, and says so; for an `AGENTS.md` with
no markers, or a `CLAUDE.md` that does not import `AGENTS.md`, it also says what to add. `manifests/` and `.env` are
added by their later slices. No auto-install — it prints the next step, naming no package manager, since the instance's
lockfile is what picks one ([ADR-0043](0043-the-kit-is-tested-as-installed-a-local-registry-stands-in-for-npm.md)).

## Consequences

- The instance-facing packages (`@jr2/cli`, `@jr2/orchestrator`, `@jr2/agent-protocol`, `@jr2/machines`) publish to npm;
  `@jr2/harness` ships inside a Kit image, never via npm
  ([ADR-0043](0043-the-kit-is-tested-as-installed-a-local-registry-stands-in-for-npm.md)). The CLI ships as the `jr2`
  bin (`npx jr2`).
- Workspaces are a first-class CLI resource backed by the operator's `Sandbox` CRs, label-linked to their runs and their
  paths, and reached with kube credentials alone.
- Code is never loaded from a third party at run time (ADR-0008, ADR-0069): discovery is over the instance's own
  Assembly, which only `jr2 up` publishes. A run may bind a Machine's Open body with a Chart, which is data (ADR-0070).
