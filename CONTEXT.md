# j2

A kit for building agentic workflows modeled as [xstate](https://stately.ai/docs) state machines. Provides composable,
xstate-compatible pieces (an Actor backed by a Harness client, worktree creation, pooling, gates) that you assemble into
a Machine for any workflow — coding or otherwise. The feature/task coding flow is one example Machine, not the
architecture. Agents run in isolated pods (host-level sandbox), coordinated by an Orchestrator running a Machine, on
Kubernetes (kind locally).

## Language

**Machine**: The xstate state machine that defines a workflow's control flow. The unit a user authors. _Avoid_:
workflow, graph

**Workflow**: A Machine registered under a name — the unit an Orchestrator instance runs and `j2 run` addresses. Lives
as a code module in the instance's `workflows/` directory (contract: `export const machine`); the Machine carries
everything it needs (ADR-0049), so a Workflow is a name and nothing more. **Not** declarative config, and **not**
shipped by the kit — a packaged Machine becomes a Workflow when a workflows file exports it. _Avoid_: app, pipeline

**Orchestrator**: The runtime that executes Machines. A single-writer daemon (`replicas: 1`, always in-cluster —
ADR-0019) persisting run snapshots to its store (sqlite by default, Postgres opt-in). `replicas: 1` means single
_writer_ (no split-brain on the snapshot), not one workflow per process — one Orchestrator hosts **many** Workflows and
many runs, fed by both Sources (pull) and the HTTP API (push). _Avoid_: runner, engine

**Instance**: A user-owned folder scaffolded by `j2 init` — `j2.config.ts` (reach and credentials: the deployment facts
a Machine cannot carry, ADR-0050/0051) + the discovered `workflows/` directory + manifests. `j2 up` bakes the engine +
the instance's workflows into one image and converges the target cluster; this folder is the deployed Orchestrator. A
deployment assembly, not a sharing unit — reusable workflows/agents travel as npm packages (ADR-0019). _Avoid_:
workspace (collides), project

**j2 CLI**: The `j2` binary — the primary interface to an Instance (`init`, `up`, `run`, status). Operates on the
current `kubectl` context, argo/cilium-style; users reach for the CLI far more than the raw HTTP API; the CLI sits on
top of that API. _Avoid_: cli tool

**j2 Application**: An Instance under GitOps — its manifests deploy the Orchestrator plus config and secrets. The same
folder runs on kind locally and on a real cluster. _Avoid_: deployment

**Console**: The browser surface the Orchestrator serves — one shell, master–detail: the Workflows and their runs in the
left rail, the selected Workflow's Machine in the center (structure alone, or lit by a selected run), open Gates
gathered in the right drawer. Observation is open (ADR-0014); entering the Instance token in the nav unlocks control —
starting runs, answering Gates — without moving any band. _Avoid_: visualizer (one panel of it, and the Console also
acts), dashboard, UI (unqualified), viz

**Actor**: An xstate actor inside a Machine that drives a remote worker via a Harness client. The local handle in the
Orchestrator; the compute is remote. An Agent is one as a named slot — `actors: { coder: agent(…) }`, invoked as
`src: "coder"` (ADR-0049). _Avoid_: agent actor

**Agent**: A configured worker persona — model + instructions + Working tools + workspace access (e.g. coder, reviewer).
A plain-data definition a Machine carries as an actor slot, `agent({ model, instructions, … })`, so its name is the
slot's and its scope is that Machine (ADR-0049); the Harness runs the definition it is handed with each Turn (ADR-0018,
ADR-0027). A composer retunes it with `customize()`; a Turn may set its **Dials** but never its identity. _Avoid_: role,
persona, roster entry

**Dials**: The two fields a Machine state may set for one Turn on top of an Agent's definition — `model` and
`thinkingLevel` — because they say how hard to run, not who is running (ADR-0018). Everything else in a definition is
identity (`instructions`, `workspace`, `cwd`) and only the definition sets it: an invocation that rewrote identity would
make the Agent's name a lie, and overriding `workspace` would void ADR-0028's containment. _Avoid_: options, overrides,
settings

**Sandbox**: The isolated pod that gives an Agent a host-level sandbox plus its own filesystem. The primary motivation
for the Kubernetes architecture — agents must not share host resources (ports, filesystem, process space). _Avoid_:
worker pod, container

**Harness**: j2's own long-running server (`@j2/harness`), hosted in two placements: inside every Sandbox, and once per
Instance as the Instance Harness (ADR-0031). Hosts conversations over the Harness wire (ADR-0027) and executes their
Working tools; it holds no Agents of its own — each admission carries the definition it runs (ADR-0049). Ships both as
the stock `j2-harness:<ver>` image and as the runtime j2 mounts into every Sandbox at `/opt/j2` at pod time — Working
tools execute in this container, so the tools they can reach are the Sandbox Image's (ADR-0037). _Avoid_: flue agent,
server, `local()`

**Instance Harness**: The per-Instance Harness deployment `j2 up` converges when an Agent a registered Machine carries
declares `workspace: "none"` — the placement for every Menu-only Agent's Turn, regardless of any enclosing Workspace, so
a continued conversation always lands on the Harness that holds it (ADR-0031). Its pod pairs the Harness with an Adapter
and mounts no worktree. _Avoid_: shared harness, global harness, dev harness

**Adapter**: The j2-owned sidecar container in a Sandbox that serves the current turn's Menu to the Agent over MCP and
forwards the Agent's picks to the Orchestrator as Gate deliveries. The Agent's only control-plane peer is this process
on `localhost`; it never speaks to the Orchestrator. A separate container from the Harness _because_ Working tools give
the Agent code execution there — so the Orchestrator credential lives where the Agent cannot read it. In Orchestrator
terms it is the MCP dialect adapter, relocated into the Sandbox. _Avoid_: shim, proxy, sidecar (that's its deployment
shape, not what it is), MCP server

**Kit image**: One of the three j2-owned images an Instance deploys but never authors — `j2-harness`, `j2-adapter`,
`j2-operator`. Built from the checkout in checkout mode; installed, pulled at published `<kitversion>` tags from the
canonical home (`ghcr.io/snapwich`) or from a self-hosted mirror of it (`kitRegistry`, ADR-0044); one release train with
the npm packages (ADR-0019, ADR-0038). The kit's second distribution channel: what users don't get from npm, they get as
these images (ADR-0043). _Avoid_: system image, base image, j2 image (ambiguous with the instance image `j2 up` bakes)

**Sandbox Image**: A user-owned image a Sandbox's primary container runs — the tools an Agent's Working tools can reach,
and the shell a human gets on `exec`. A `workspace()` names it statically (ADR-0049): a `file:` URL to a docker context
the Machine's module ships, built by `j2 up`, or a registry ref. j2 mounts the Harness runtime into the pod at
`/opt/j2`, so the image carries zero j2 layers and its floor is glibc + git (ADR-0037). _Avoid_: workspace image (a
Workspace is a Machine; the image is the pod's), agent image, harness image (the kit's own), toolchain

**User Container**: The optional third container in a Sandbox pod — a user-owned image a `workspace()` names statically,
in the same two shapes as the Sandbox Image and beside it (`user`, ADR-0049), running its own entrypoint with `/work`
mounted read-write and nothing injected (ADR-0005). The zero-contract seat: j2 never builds, probes, or commands it. For
services that must run unattended (an sshd for managed access) and for sessions whose credentials must stay out of the
Agent's mount namespace (a forwarded ssh agent). Not port isolation — the pod has one network namespace. _Avoid_:
sidecar (its deployment shape, not what it is), debug container (an ephemeral attach is a one-off mechanism, not a
seat), dev container

**Instance ID**: The identifier for a resumable Agent exchange — the `<id>` in `POST /agents/:name/:id` on the Harness
wire. Successive prompts to the same `(Agent name, instance id)` continue one conversation; j2 computes ids and persists
`(name, instance id)` + stream offset host-side to re-attach after an Orchestrator restart. New agent invocations get
fresh ids by default (the lossy handoff); continuing a conversation is opt-in. _Avoid_: conversation id, session id

**Turn**: One Agent's answer to the frame a Machine state set for it — the prompt, the work, and the single menu pick
that ends it (ADR-0006). A turn belongs to the state that asked for it: when that state stops waiting, the turn is over,
whatever made it stop (ADR-0024). It rides on one Submission but is not the same thing — a Submission is the Harness's
durable unit, and an Agent whose turn has ended can still be generating, which is the failure ADR-0024 closes. _Avoid_:
session (a conversation spans turns), generation, request

**Submission**: One admitted prompt on a conversation — the Harness's unit of work. A Turn rides on exactly one; a
conversation (Instance ID) spans many. Per-conversation queue, processed in admission order; an abort sweeps the active
Submission and everything queued behind it (ADR-0024, ADR-0027). _Avoid_: request, job

**Admission**: The Harness's acceptance of a Submission — the serializable `{streamUrl, offset, submissionId}` handle
the host persists in its ledger beside the snapshot (ADR-0016), and the coordinate a restarted Orchestrator re-attaches
by (ADR-0007). _Avoid_: handle, ticket

**Settlement**: How a Submission ends — `completed`, `failed`, or `aborted`. What the history view reports and the tests
assert; j2 deliberately never observes the settlement of a turn it aborted (ADR-0024). _Avoid_: result, status

**Runaway**: A Turn that will not conclude on its own — ended by the Harness when it runs past the point where j2 stops
believing it will end. The third absorbed fault class beside infra and no-signal (ADR-0016, ADR-0035): rerolled once as
a fresh conversation, then surfaced as the one terminal `agent.fault`. Named for what j2 observed, not the model's
pathology. _Avoid_: degeneration (the model behavior a runaway guard usually catches, not the fault class), loop, hang,
stall

**Compaction**: The cut itself — what a conversation's model context still holds, replaced by a summary plus a retained
tail — taken by the Harness mid-Turn at a step boundary when the context crosses its reserve (ADR-0036). Turn mechanics
(ADR-0016): j2-owned thresholds, no author surface, not a Dial. It changes what the model sees, never what j2 recorded:
the history view is what was said. _Avoid_: summarization (one step of taking a Compaction, and the LLM call is not the
decision), truncation (the failure Compaction exists to prevent), pruning

**Menu**: The current Turn's control-plane tools — the workflow events the invoking state derived (ADR-0015), narrowed
to those its guards would currently accept (ADR-0029), served by the Adapter over MCP. What the Agent may **say**. The
derived set is the state's vocabulary and the scope delivery validates against; the Menu is what a given turn is
offered, so one state can offer different Menus as its context changes. _Avoid_: tools (unqualified), tool list

**Vocabulary**: The workflow events a Machine accepts — each a `defineEvent` def: a name, a payload schema, an optional
audience — taken as values by its `j2Setup` and scoped to that Machine alone (ADR-0011). What a Gate's accepted set and
an Agent's Menu are drawn from, and what a delivery is validated against. A nested Machine keeps its own; the Machine
that invokes it never sees or merges it. _Avoid_: events (unqualified — the mechanism also delivers `agent.fault`-class
events no author declared), event manifest (the retired module export), schema

**Machine shape**: The facts about a Machine that decide whether a persisted snapshot can still be read by it — state
ids and nesting, invoke ids and srcs, transition targets — as a digest stamped on every save and compared on restore
(ADR-0030). Deliberately excludes guard and action bodies: those change what a run does next, not whether its snapshot
is interpretable. A mismatch is **drift**, and a drifted run is refused and kept, never resumed. _Avoid_: version (this
is a content address, not an ordering), schema

**Working tools**: The file and shell tools (read, write, edit, bash, grep, glob) the Harness executes in its own
container — what the Agent may **do**; filtered by the definition's `workspace` access (ADR-0028; `"none"` withholds
them all — a Menu-only Agent). _Avoid_: tools (unqualified), sandbox tools

**Source**: The generalized port a Pool draws work items from — "next item, excluding these", plus an optional wake
signal and a re-query cadence. A queue, a generator, or a re-queried set; a Work Source is one Source adapter. _Avoid_:
queue (one possible backing, and Sources are not FIFO), feed

**Pool**: The kit-provided Machine that runs one worker Machine per Source item under a concurrency cap, collecting
completions and triaging the run's end: drained (all work done), deadlocked (items exist but none can start), or waiting
(children parked on Gates). The top of a jr-shaped workflow is a Pool. _Avoid_: scheduler, work loop

**Work Source**: The ticket-flavored Source adapter — `tk`, GitHub issues, Jira, a task queue. Modeled as a behavior
port (verbs like `claimNext`, `updateStatus`, `comment`) gated by advertised capabilities, not a canonical data schema.
Owns the dependency graph and emits the dependency-ordered, currently-unblocked items; the Machine never encodes
dependency edges itself. _Avoid_: ticket system, backend

**Ready-set**: The currently-unblocked work items a Work Source will hand out — dependency-ordered and mutating during
execution (items can be reopened or created mid-run). Not a static FIFO queue; the Machine re-queries it rather than
materializing it into context. _Avoid_: queue, backlog (the backlog is the full set of items; the ready-set is the
unblocked subset)

**Gate**: A pending external input on a run — from a human or any outside system (webhook, CI) — created when a state
invokes the `gate` actor and destroyed when the state exits. An addressable resource (`gate` id + accepted events +
`meta` context), because concurrent children park concurrently and a caller acts on one specific decision. What
`j2 send`, a UI inbox card, or a webhook translator targets. _Avoid_: humanGate (humans are one caller among many),
approval (one possible event, not the resource)

**Emit**: A message a workflow author surfaces from a Machine for whoever is watching (xstate `emit({...})`), carried on
the observation feeds beside the automatic status deltas. Progress and notice — "review requested", "branch pushed" —
never control: nothing consumes an Emit, and a Machine cannot be driven by one. Its PAYLOAD is author data of the same
class as context, so the open band carries the type alone (ADR-0014/0022). Also the sole author API for the run
narrative a Workspace Harness prints (ADR-0023): Emits land in that log because the log is a projection of the feed.
_Avoid_: event (the down-channel thing a Gate or an Agent delivers, which does drive a Machine), log (an Emit is
deliberate vocabulary, not a diagnostic)

**Workspace**: A long-lived Sandbox bound to a unit of work, modeled as a child Machine. Entering the state creates the
Sandbox and its worktree; the child Machine's states manage what happens inside (e.g. coding, review, merge); reaching
its final state cleans up the Sandbox. Coder and reviewer Agents share one Workspace (per-feature isolation, not
per-Agent-run). _Avoid_: workspace pod

**Lease**: The assertion that a Workspace is still wanted — an annotation one actor renews for as long as its Workspace
runs. Nothing in the cluster represents a run, so liveness is asserted, not referenced: a lapsed lease is what lets the
operator reap (ADR-0001). The renewal answers back, which is how the run learns about Continuity. _Avoid_: heartbeat
(one-directional, and it named a process-global timer this replaced), keepalive (the annotation, not the concept)

**Continuity**: Whether a Workspace is still the one its body attached to — the question a Lease renewal answers.
Distinct from existence: addresses are deterministic, so a replacement pod after an eviction or node loss keeps the CR,
the name, and the endpoint while taking the clones, worktrees, and unpushed commits with it. Broken Continuity — reaped
or replaced — is one `workspace.lost` event, and the body's policy decides (ADR-0021). _Avoid_: liveness (that is what
the Lease asserts outward), health (a probe concept, about serving)

**Repo**: A git repository, identified by its url — host plus path; scheme, user, and `.git` do not distinguish two
spellings of one Repo. A Machine names one only through a Repo Slot; the cluster keeps one read-only cache of it per
node for Workspaces to clone against (ADR-0051). There is no catalog and no repo name: `j2.config.ts` declares nothing
about a Repo, and the set the Instance holds is whatever its Machines bind plus whatever its runs have attached.
_Avoid_: project, source, remote, catalog entry, repo name

**Repo Slot**: The name a `workspace()` gives one Repo it attaches — the key in its `repos` option, the key of the
body's `workspace.repos` handles, and the directory under `/work`. A slot is **bound** (the Machine wrote the url),
**open** (the Machine left it for a composer to bind with `customize`), or **per-run** (a mapper over the door binds it
from input). Bound and open are what `j2 up` can see; per-run is the run's business. _Avoid_: role, alias, repo name

**Binding**: The `{ url, ref? }` a Repo Slot resolves to. `ref` is the base the branch Worktree is cut from; absent, the
Repo's own default branch. _Avoid_: config, catalog entry

**Project layout**: The `<slot>/default/` + sibling-worktrees convention (gwtmux's) inside a Sandbox: the pod-local
clone is the `default/` under the Repo Slot's directory and branch Worktrees sit beside it — so worktree tooling works
unchanged when you exec in. The node cache a clone borrows from is not part of the layout; it is mounted read-only
beside it. _Avoid_: directory structure, repo tree

**Worktree**: A git worktree for the one branch a Workspace works on — sibling to the Sandbox's `default/` clone; work
is sequential commits on that branch, not separate worktrees. The branch's name and granularity (per feature, per task,
from a ticket, from run input) are the Workflow's policy, not j2's. _Avoid_: per-task worktree, task branch
