# j2

A kit for building agentic workflows modeled as [xstate](https://stately.ai/docs) state machines. Provides composable,
xstate-compatible pieces (an Actor backed by a flue client, worktree creation, memory, etc.) that you assemble into a
Machine for any workflow — coding or otherwise. The feature/task coding flow is one example Machine, not the
architecture. Agents run in isolated pods (host-level sandbox), coordinated by an Orchestrator running a Machine, on
Kubernetes (kind locally).

## Language

**Machine**: The xstate state machine that defines a workflow's control flow. The unit a user authors. _Avoid_:
workflow, graph

**Workflow**: A concrete, deployable assembly — a Machine wired to its Agents and config — that an Orchestrator instance
registers and runs. Lives as a code module in the instance's `workflows/` directory (contract: `export const machine`);
**not** declarative config, and **not** shipped by the kit. _Avoid_: app, pipeline

**Orchestrator**: The runtime that executes Machines. A single-writer daemon (`replicas: 1`, always in-cluster —
ADR-0019) persisting run snapshots to its store (sqlite by default, Postgres opt-in). `replicas: 1` means single
_writer_ (no split-brain on the snapshot), not one workflow per process — one Orchestrator hosts **many** Workflows and
many runs, fed by both Sources (pull) and the HTTP API (push). _Avoid_: runner, engine

**Instance**: A user-owned folder scaffolded by `j2 init` — `j2.config.ts` + discovered `workflows/` and `agents/`
directories + manifests (mirroring flue's `flue.config.ts` + `agents/`). `j2 up` bakes the engine + the instance's
workflows into one image and converges the target cluster; this folder is the deployed Orchestrator. A deployment
assembly, not a sharing unit — reusable workflows/agents travel as npm packages (ADR-0019). _Avoid_: workspace
(collides), project

**j2 CLI**: The `j2` binary — the primary interface to an Instance (`init`, `up`, `run`, status). Operates on the
current `kubectl` context, argo/cilium-style; users reach for the CLI far more than the raw HTTP API; the CLI sits on
top of that API. _Avoid_: cli tool

**j2 Application**: An Instance under GitOps — its manifests deploy the Orchestrator plus config and secrets. The same
folder runs on kind locally and on a real cluster. _Avoid_: deployment

**Actor**: An xstate actor inside a Machine that drives a remote worker via a flue client. The local handle in the
Orchestrator; the compute is remote. _Avoid_: agent actor

**Agent**: A configured worker persona — model + instructions + tools (e.g. coder, reviewer). What a user customizes: a
plain-data definition in the instance's `agents/<name>.ts` (filename = Agent name, mirroring `workflows/`); j2 maps it
onto a flue agent definition when it assembles the Harness image (ADR-0018). _Avoid_: role, persona

**Sandbox**: The isolated pod that gives an Agent a host-level sandbox plus its own filesystem. The primary motivation
for the Kubernetes architecture — agents must not share host resources (ports, filesystem, process space). _Avoid_:
worker pod, container

**Harness**: Flue's long-running server process running inside a Sandbox. Hosts one or more Agents and serves them over
HTTP. Runs in its own container (the j2-owned Harness container) alongside the user container, carrying the agent's own
toolchain since `local()` tools execute there. _Avoid_: flue agent, server

**Adapter**: The j2-owned sidecar container in a Sandbox that serves the current turn's tool menu to the Agent over MCP
and forwards the Agent's picks to the Orchestrator as Gate deliveries. The Agent's only control-plane peer is this
process on `localhost`; it never speaks to the Orchestrator. A separate container from the Harness _because_ `local()`
tools give the Agent code execution there — so the Orchestrator credential lives where the Agent cannot read it. In
Orchestrator terms it is the MCP dialect adapter, relocated into the Sandbox. _Avoid_: shim, proxy, sidecar (that's its
deployment shape, not what it is), MCP server

**User Container**: The user-owned container in a Sandbox pod — a customizable image (nvim, dotfiles, extra CLIs) that
the human `exec`/SSH-es into to work alongside the agent. Shares the worktree volume with the Harness container, so
human and agent see identical files. A peer of the Harness container; the pod (not the container) is the isolation unit
— ADR-0005. _Avoid_: workbench, workspace container (collides with Workspace), dev container

**Instance ID**: Flue's identifier for a resumable Agent exchange — the `<id>` in `POST /agents/:name/:id`. Successive
prompts to the same `(Agent name, instance id)` continue one durable, replayable conversation; j2 computes ids and
persists `(name, instance id)` + stream offset host-side to re-attach after an Orchestrator restart. New agent
invocations get fresh ids by default (the lossy handoff); continuing a conversation is opt-in. Borrowed verbatim from
flue rather than renamed, to keep j2 and flue speaking the same language. _Avoid_: conversation id, session id

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

**Project layout**: The `<repo>/default/` + sibling-worktrees convention (gwtmux's), used in two places: the in-cluster
source volume's `repos/<name>/default` read-only checkouts, and inside a Sandbox, where the pod-local clone is the
`default/` and branch Worktrees sit beside it — so worktree tooling works unchanged when you exec in. _Avoid_: directory
structure, repo tree

**Worktree**: A git worktree for the one branch a Workspace works on — sibling to the Sandbox's `default/` clone; work
is sequential commits on that branch, not separate worktrees. The branch's name and granularity (per feature, per task,
from a ticket, from run input) are the Workflow's policy, not j2's. _Avoid_: per-task worktree, task branch
