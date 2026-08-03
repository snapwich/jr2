# PoC Plan

Each PoC validates a named assumption behind the j2 architecture. PoCs 1–4 are independent infra/flue experiments with
**no xstate** — they de-risk the biggest unknowns and can run in parallel. 5 depends on 3+4. **7 and 8 are next and run
in parallel**; they're independent when scoped deliberately (frozen Actor/control-plane interface; #7 persists the
minimal driving Machine, #8 builds the coding template on mocks). **6 is deferred to last** — the right work-source port
shape needs experience with an initial running system, so it waits until 7+8 exist.

The riskiest assumptions are **#2 (worktree contention)** and **#4 (flue runtime behavior)** — if either breaks it
reshapes the architecture, so front-load both.

## 1. Sandbox operator + generic CRD

Reconcile a `Sandbox` custom resource into a Pod + Service, report `status.endpoint`, GC via owner-refs / idle-timeout.
Spec carries a primary container plus a generic list of sidecar container specs (agent-agnostic — see ADR-0001).

**Validates:** durable Sandbox lifecycle independent of the Orchestrator. _xstate: no._

## 2. Worktree without shared-`.git` contention

Create a per-Sandbox worktree via local clone `--reference`/`--shared` against a read-only `default/` object store, so
each Sandbox gets a private `.git` and fast setup without locking on one shared `default/.git`. Includes the kind
storage question (hostPath on single-node kind vs an RWX CSI).

**Validates:** keep the worktree ergonomics (shell in, normal project structure) without re-introducing the file-lock
bottleneck the new architecture exists to escape. _xstate: no._ **(High risk — front-load.)**

## 3. flue sidecar → model backend

Run a lightweight flue Agent as a sidecar container co-located with a Sandbox worktree, pointed at the shared model
backend (vLLM locally / Anthropic in cloud). Drive a trivial task end-to-end.

**Validates:** flue's "local service" model works; Agent images are reusable and low-latency to the worktree/tools.
_xstate: no._

## 4. flue runtime limits

Probe, against real flue: (a) is a run's event stream resumable by `(name, instance id) + offset` after disconnect? (b)
which Machine→Agent messages can be delivered mid-run, and when do they take effect? (c) how far does runtime Agent
config go (skills / instructions / MCP tool sources) **without** an image rebuild? (d) can the Agent reach an **MCP
callback toolset** and does `request_approval` block on the tool result as expected?

**Validates:** ADR-0002's split-channel control plane and the "agents not baked in / customizable" claim. _xstate: no._
**(High risk — front-load.)**

## 5. Duplex Actor (with MCP control plane)

Build the core runtime primitive as an xstate `fromCallback` actor that drives **one** Agent run end-to-end against a
real Harness in a real Sandbox. Per ADR-0002, the control plane is **MCP tool calls**, not stream interpretation:

- The Actor hosts a per-run **MCP callback endpoint** (keyed by **Instance ID**). The Agent emits domain events by
  calling tools (`done`, `request_review`, `request_approval`, `report_blocked`); the Actor `sendBack`s them as xstate
  events.
- **Solicited down-channel = tool result:** the Machine answers `request_approval` by returning the tool result; the
  Agent blocks on it (flue's native pause-for-approval). Prove the Machine can drive into a waiting state and release
  the Agent by answering the call.
- **Interrupts:** prove `cancel` via infra-level run abort; (optionally) a `check_inbox` poll tool for cooperative
  steer-at-checkpoint.
- **Progress:** optionally consume the flue SSE stream as passive telemetry (not control flow).
- **Reconnect:** persisted `(name, instance id) + offset` + flue's durable log let a fresh Actor re-attach to an
  in-flight run.

Requires a **Sandbox → Orchestrator ingress** (reverse of the Actor→Harness path) over a Kubernetes Service.

**Validates:** the one primitive every Machine is built on — "the Machine drives remote Agents." _xstate: yes._ _Depends
on #3 + #4._

**Validated** ([poc/actor](../poc/actor/)). The Actor (`orchestrator/src/`) drove all six control behaviors against real
flue + vLLM: approval round-trip (Agent blocks on the deferred `request_approval`, Machine answers, Agent resumes, gated
action only post-approval), per-Instance-ID routing across concurrent runs, up-events (`done`/`report_blocked`),
between-turn steer, Orchestrator-restart re-attach by `(name, instance id) + offset`, and cancel-as-abandon. The
long-block **risk resolved**: a held approval is bounded by the MCP client `timeoutMs` (60 s default); raised to 600 s
it tolerated a 3-minute hold, and on timeout the gate held (no gated action). See ADR-0002.

**Follow-ups #5b / #5c** (control-surface shape → [ADR-0006](adr/0006-agent-control-surface.md)). _#5b_: flue's native
`finish` (forced, validated structured result) is reachable over HTTP **only via the Workflow surface**
(`POST /workflows/:name` + durable `GET /runs/:runId`), **not** the continuing-agent path (whose executor runs with
`tools: []`); and a JSON menu can be rebuilt server-side into a schema, but it must be a **flat** tagged object — a
strict `oneOf`/`const` union is unsatisfiable for Qwen3-Coder. _#5c_: a Workflow's named session does **not** persist
across runs (the session key is scoped to a server-generated `runId`), so "workflows-on-named-sessions as the per-turn
building block" is **not viable**. Net: continuing memory (agent path) and forced result (workflow path) cannot be
combined on one flue surface — forced final picks become a Machine-level re-prompt on the agent path; `finish` is
reserved for self-contained single-shot decisions.

## 6. Work Source port

Implement the work-source behavior port against two genuinely different backends — `tk` **and** GitHub issues — with
`claimNext` (atomic lease), `ready`, `updateStatus`, `comment`, and dependency resolution gated by advertised
capabilities.

**Validates:** ports-not-schema holds across heterogeneous backends. _xstate: yes._ **Deferred to last** — build it once
#7 + #8 give a running system to learn the real port shape from; until then #8 uses mock/stub work sources.

## 7. Orchestrator durability

Persist the xstate snapshot (Postgres), crash the Orchestrator, restore, and reconcile against live Sandbox CRs +
in-flight `(name, instance id) + offset` handles + the Work Source.

**Validates:** the forever-running daemon survives crashes without losing or duplicating work. _xstate: yes._

**Validated** ([poc/durability](../poc/durability/)). The real entrypoint (`orchestrator/src/index.ts`) was driven
through a real OS-process `kill -9` and restarted against the same Postgres, against real flue + vLLM + a kind Sandbox
CR (18/18 assertions). Proven: (A) a long non-gated run killed mid-flight **re-attaches by
`(name, instanceId) + offset`** — the restarted process posts no second prompt, the same run completes, output is whole
with no duplicated side effects; (B) an approval **held at the moment of the crash** is restored — the worker re-issues
`request_approval` and the restarted Orchestrator answers it, the gated action occurring only post-restart; (C) restore
**reconciles** against the operator's `Sandbox` CR — present → re-attach, absent → the defined failure path (mark
`lost`, no re-attach). Two findings refined the mechanism (see the PoC README): re-attach is driven by the invoked
actor's **persisted input** (xstate v5 restores child input rather than re-evaluating the parent invoke), and the live
`ControlPlane` must be stripped from **both** parent context and that child input before persisting, then re-injected on
restore. The crash-between-admit-and-persist window degrades safely via a live-run probe (replay from `-1`); the
in-flight-POST sliver is the known at-most-once edge.

## 8. Thin end-to-end slice

The coding template — top Machine (bounded worker pool) → Workspace child Machine → code/review inner loop — first with
**mock** providers, then swapped for real ones.

**Validates:** template/provider composition is real and unit-testable with mocks (no Kubernetes, no flue). _xstate:
yes._

**Validated** (`orchestrator/src/coding/`, `orchestrator/test/coding-machine.test.ts`). Both templates (top worker-pool,
Workspace child) run end-to-end on in-memory mocks with no infra, wired through the **same** `assembleCodingMachine`
factory a real run uses — the mock↔real swap is one substituted provider entry, never a template edit (proves ADR-0003).
Asserted: claims in ready (dependency) order; bounded parallelism (saturates at `maxConcurrent`, never exceeds);
sequential tasks within a feature (one Agent at a time); code→review→approve closes + loops; review-round cap escalates
(no infinite loop); daemon idles on empty backlog and wakes on `WORK_READY`; an item added mid-run is picked up on the
next claim with **no special Machine state** ("encode the pattern, never the queue"); the memory slot is an observable
noop unfilled and active **in place** when filled; agents may only emit picks from the state's flat menu (ADR-0006). Two
cross-cutting findings were promoted to [ADR-0007](adr/0007-durable-machine-state.md): the parent holds only counts +
ids (children report UP via `sendParent`), and slots take **semantic** input while infra is bound in the assemble-time
closure — the same serializable-context discipline #7 depends on.

**Follow-up:** the reviewer's verdict menu (`approve` / `request_changes`) is currently modeled at the template layer
because the reviewer is a mock here; it should fold into the shared Actor↔Harness contract registry ADR-0006 anticipates
once the reviewer becomes a real Agent.
