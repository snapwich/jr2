# PoC Plan

Each PoC validates a named assumption behind the j2 architecture. PoCs 1–4 are independent infra/flue experiments with
**no xstate** — they de-risk the biggest unknowns and can run in parallel. 5 depends on 3+4; 6 is independent; 7–8 come
last, once the primitives exist.

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

Probe, against real flue: (a) is a run's event stream resumable by `dispatchId` after disconnect? (b) which
Machine→Agent messages can be delivered mid-run, and when do they take effect? (c) how far does runtime Agent config go
(skills / instructions / MCP tool sources) **without** an image rebuild? (d) can the Agent reach an **MCP callback
toolset** and does `request_approval` block on the tool result as expected?

**Validates:** ADR-0002's split-channel control plane and the "agents not baked in / customizable" claim. _xstate: no._
**(High risk — front-load.)**

## 5. Duplex Actor (with MCP control plane)

Build the core runtime primitive as an xstate `fromCallback` actor that drives **one** Agent run end-to-end against a
real Harness in a real Sandbox. Per ADR-0002, the control plane is **MCP tool calls**, not stream interpretation:

- The Actor hosts a per-run **MCP callback endpoint** (keyed by `dispatchId`/run id). The Agent emits domain events by
  calling tools (`done`, `request_review`, `request_approval`, `report_blocked`); the Actor `sendBack`s them as xstate
  events.
- **Solicited down-channel = tool result:** the Machine answers `request_approval` by returning the tool result; the
  Agent blocks on it (flue's native pause-for-approval). Prove the Machine can drive into a waiting state and release
  the Agent by answering the call.
- **Interrupts:** prove `cancel` via infra-level run abort; (optionally) a `check_inbox` poll tool for cooperative
  steer-at-checkpoint.
- **Progress:** optionally consume the flue SSE stream as passive telemetry (not control flow).
- **Reconnect:** persisted `dispatchId` + flue's durable log let a fresh Actor re-attach to an in-flight run.

Requires a **Sandbox → Orchestrator ingress** (reverse of the Actor→Harness path) over a Kubernetes Service.

**Validates:** the one primitive every Machine is built on — "the Machine drives remote Agents." _xstate: yes._ _Depends
on #3 + #4._

## 6. Work Source port

Implement the work-source behavior port against two genuinely different backends — `tk` **and** GitHub issues — with
`claimNext` (atomic lease), `ready`, `updateStatus`, `comment`, and dependency resolution gated by advertised
capabilities.

**Validates:** ports-not-schema holds across heterogeneous backends. _xstate: yes._ _Independent._

## 7. Orchestrator durability

Persist the xstate snapshot (Postgres), crash the Orchestrator, restore, and reconcile against live Sandbox CRs +
in-flight `dispatchId`s + the Work Source.

**Validates:** the forever-running daemon survives crashes without losing or duplicating work. _xstate: yes._

## 8. Thin end-to-end slice

The coding template — top Machine (bounded worker pool) → Workspace child Machine → code/review inner loop — first with
**mock** providers, then swapped for real ones.

**Validates:** template/provider composition is real and unit-testable with mocks (no Kubernetes, no flue). _xstate:
yes._
