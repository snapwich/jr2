# `workspace()` wraps a body Machine and owns only Sandbox lifecycle

j2 provides Workspaces as a helper so workflows never provision Sandboxes themselves: `workspace(body, spec)` is a
statically-imported factory (per [ADR-0011](0011-workflow-defined-events.md)'s import doctrine) returning a Machine that
provisions a Sandbox and its worktrees, runs the author's **body** Machine inside it, and tears the Sandbox down when
the body finishes. This makes CONTEXT.md's "Workspace = child Machine bound to a unit of work" concrete.

```
provisioning:  create Sandbox CR → await phase: Ready → attach repos/worktrees (post-Ready, ADR-0004)
running:       invoke body; input = parent input + { workspace: { workdir, repos, branch } }
teardown:      destroy the CR
done:          final; workspace output = body output
```

## Why a wrapper Machine and not actors in the workflow

Teardown forces the shape. In xstate v5 a stop is synchronous — a stopped machine cannot run async work or transition
through cleanup states — so reliable multi-step teardown must be **internal states the machine reaches by its own
transitions**. The thing that provisions must therefore also observe the body's completion, which means it wraps the
body. The persisted `teardown` state is also **durable intent**: a crash mid-teardown restores into it and re-runs the
idempotent destroy, which host-side lifecycle could only replicate by rebuilding the same ledger the state machine
already is. When the guarantee still fails (`kill -9`, hard cancel), the operator's heartbeat-lease GC is the backstop
(ADR-0001) — the reason ADR-0001 made the CR the durable desired state. Author-assembled provisioning/cleanup states
(the obvious alternative) put the guarantee in every workflow's hands to forget, on every error path.

## Boundary: the spec speaks workspace vocabulary only

The spec — `{ repos: [{ name, baseRef }], branch }` — is mapped from the parent's context by the author, but its _shape_
is workspace-domain: what to attach and on what ref. Workflow configuration (review rounds, budgets, ticket data) passes
through to the body untouched; the workspace never sees it. In return the body gets what it needs to operate inside the
Sandbox: `{ workdir, repos, branch }`. The Harness `endpoint` and the Sandbox name are mechanism-facing, not body-facing
— `agentRun` resolves them **ambiently** from the enclosing wrapper (a registrar actor co-invoked in `running`,
ADR-0016), so the body cannot mis-thread them. Keeping this boundary is what lets one helper serve any workflow rather
than coupling to coding-shaped ones.

## There is no retain policy: parking is retention

Teardown fires **only when the body reaches a final state**. A body that needs its Sandbox kept alive — escalation, a
human inspecting the worktree, a human-review gate — simply parks in a non-final state (typically holding a `gate`,
ADR-0011). We considered and rejected an `onSettled → retain | destroy` policy knob: parking expresses retention with no
new API, and keeps the run visibly "waiting" in `j2 runs`. A parked run's Sandbox stays alive as long as the run does —
each live workspace renews its own lease, and the operator reaps only Sandboxes whose lease has lapsed (abandonment, not
parking — ADR-0001).

## Commits leave via the workflow, never the workspace

Getting commits out of the pod-local clone (push, PR) is **body flow**, decided by the workflow — a coding workflow
pushes the branch / opens a PR before its human gate, so review is PR-based and the forge owns merging. The workspace
attaches and destroys; it never touches remotes. A body that finishes without publishing loses its commits by design —
the same contract as a temp directory.

## Consequences

- ADR-0004's single-active-Agent-per-Workspace invariant becomes structural: one sequential body per workspace, no lock
  machinery.
- The workspace labels the CR with its run (`j2.dev/run`, `j2.dev/workflow`), which is what `j2 ls` groups by
  (ADR-0009).
- **Lost workspace: the wrapper emits, the body decides.** While the body runs, a lease actor beside it renews the
  Sandbox's keepalive and reads back whether the workspace it attached to is still there (ADR-0021) — continuously, and
  on snapshot restore as the first tick of that same loop rather than a separate restore-time path. Intact → carry on
  (same endpoint — deterministic per Sandbox name; in-flight turns re-attach from the host ledger, ADR-0016). Lost —
  reaped, deleted, or a replacement pod after an eviction or node loss — → the pod-local clone and any unpushed commits
  are gone, so silently re-provisioning would resume into an inconsistent world (tickets closed, commits vanished);
  instead the wrapper delivers a **`workspace.lost`** event into the body — same channel as `agent.fault` — and the
  body's policy decides (route it to escalation, settle as lost, or choose to re-provision and restart).
