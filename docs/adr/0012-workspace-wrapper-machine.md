# `workspace()` wraps a body Machine and owns only Sandbox lifecycle

j2 provides Workspaces as a helper so workflows never provision Sandboxes themselves: `workspace(body, spec)` is a
statically-imported factory (per [ADR-0011](0011-workflow-defined-events.md)'s import doctrine) returning a Machine that
provisions a Sandbox and its worktrees, runs the author's **body** Machine inside it, and tears the Sandbox down when
the body finishes. This makes CONTEXT.md's "Workspace = child Machine bound to a unit of work" concrete, and settles its
consumer API (from the jr-parity exercise, `examples/coding/`).

```
provisioning:  create Sandbox CR → await phase: Ready → attach repos/worktrees (post-Ready, ADR-0004)
running:       invoke body; input = parent input + { workspace: { endpoint, workdir, repos, branch } }
teardown:      destroy the CR
done:          final; workspace output = body output
```

## Why a wrapper Machine and not provider actors in the workflow

Teardown forces the shape. In xstate v5 a stop is synchronous — a stopped machine cannot run async work or transition
through cleanup states — so reliable multi-step teardown must be **internal states the machine reaches by its own
transitions**. The thing that provisions must therefore also observe the body's completion, which means it wraps the
body. When the guarantee still fails (`kill -9`, hard cancel), the operator's ownership/idle-timeout GC is the backstop
— the reason ADR-0001 made the CR the durable desired state. Author-assembled provisioning/cleanup states (the obvious
alternative) put the guarantee in every workflow's hands to forget, on every error path.

## Boundary: the spec speaks workspace vocabulary only

The spec — `{ repos: [{ name, baseRef }], branch }` — is mapped from the parent's context by the author, but its _shape_
is workspace-domain: what to attach and on what ref. Workflow configuration (review rounds, budgets, ticket data) passes
through to the body untouched; the workspace never sees it. In return the workspace outputs what bodies need to operate
inside it: the Harness `endpoint`, the worktree locations, the branch. Keeping this boundary is what lets one helper
serve any workflow rather than coupling to coding-shaped ones.

## There is no retain policy: parking is retention

Teardown fires **only when the body reaches a final state**. A body that needs its Sandbox kept alive — escalation, a
human inspecting the worktree, a human-review gate — simply parks in a non-final state (typically holding a `gate`,
ADR-0011). We considered and rejected an `onSettled → retain | destroy` policy knob: parking expresses retention with no
new API, keeps the run visibly "waiting" in `j2 runs`, and the operator's idle timeout still reaps abandoned Sandboxes.

## Commits leave via the workflow, never the workspace

This resolves ADR-0004's open "branch/push-back flow" item: getting commits out of the pod-local clone (push, PR) is
**body flow**, decided by the workflow — in the coding workflow, an `openingPr` state pushes the branch and opens a PR
_before_ the human gate, so review is PR-based and the forge owns merging (jr's `merge-all`/`rebase-feature` retire).
The workspace attaches and destroys; it never touches remotes. A body that finishes without publishing loses its commits
by design — the same contract as a temp directory.

## Consequences

- ADR-0004's invariant 2 (single active Agent per Workspace) becomes structural: one sequential body per workspace, no
  lock machinery.
- The workspace sets owner refs/labels linking the CR to its run, which is what `j2 ls` groups by (ADR-0009).
- Bodies own durable agent handles in their context, so the recursive-restore work noted in ADR-0011 (fold child
  offsets, rewrite grandchild inputs, reconcile per-workspace CR) is a prerequisite for workspaces surviving an
  orchestrator restart.
- **Restore-reconcile, absent CR: the workspace emits, the body decides.** On restore the wrapper reconciles its Sandbox
  CR. Present → re-attach (same endpoint; offsets re-attach streams). Absent (idle-timeout reap, node loss) → the
  pod-local clone and any unpushed commits are gone, so silently re-provisioning would resume into an inconsistent world
  (tickets closed, commits vanished); instead the wrapper delivers a **`workspace.lost`** event into the restored body —
  same channel as `agent.fault` — and the body's policy decides (the coding body routes it to `escalated`: human gets
  the ticket + trail, siblings keep running; another workflow may choose to re-provision and restart).

> **Amended by [ADR-0016](0016-agent-turn-mechanics-are-internal.md):** the body-facing handles shrink to
> `{ workdir, repos, branch }` — `endpoint` and `sandbox` are mechanism-facing, resolved ambiently by `agentRun` from
> the enclosing wrapper (a registrar actor co-invoked in `running`, beside the reconcile probe). The wrapper decision
> itself was re-validated in the API redesign and stands, for a reason this ADR understated: the persisted `teardown`
> state is **durable intent** — a crash mid-teardown restores into it and re-runs the idempotent destroy, which
> host-side lifecycle could only replicate by rebuilding the same ledger the state machine already is.
