# `workspace()` wraps a body Machine and owns only Sandbox lifecycle

jr2 provides Workspaces as a helper so workflows never provision Sandboxes themselves:
`workspace(body, { input, repos })` is a statically-imported factory (per [ADR-0011](0011-workflow-defined-events.md)'s
import doctrine) returning a Machine that provisions a Sandbox and clones its Repos, runs the author's **body** Machine
inside it, and tears the Sandbox down when the body finishes. This makes GLOSSARY.md's "Workspace = child Machine bound
to a unit of work" concrete.

```
placing:       create Sandbox CR → await the pod scheduled, no deadline (ADR-0064)
provisioning:  await phase: Ready (watched, ADR-0063) → Harness /attach repos (ADR-0004)
running:       invoke body; input = parent input + { workspace: { repos } }
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

## Boundary: the options speak workspace vocabulary only

The wrapper's options are workspace-domain. Which Repos to attach is not per-run at all: they are slots on the options
(`repos: { target: open, docs: { url, ref } }`, ADR-0051), static so `jr2 up` can see them, each bound by the Machine,
by a composer's `customize`, or by a mapper over the door. The Workspace only clones. A branch and a Worktree are the
body's: their names and their granularity (per feature, per task, from a ticket, from run input) are the Machine's
policy, not jr2's, and the body cuts each Worktree with `worktree()`
([ADR-0075](0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md)). Workflow configuration (review rounds,
budgets, ticket data) passes through to the body untouched; the workspace never sees it. In return the body gets what it
needs to operate inside the Sandbox: `{ repos: Record<slot, path> }`, the handles keyed by the slots the wrapper
declared, in declaration order. A handle is the slot's folder, `/work/<slot>`, and not a Worktree. No handle names a
primary checkout: which tree an Agent works in is a fact about that Agent's Turn, which the body states (ADR-0051). The
Harness `endpoint` and the Sandbox name are mechanism-facing, not body-facing — `agentRun` resolves them **ambiently**
from the enclosing wrapper (a registrar actor co-invoked in `running`, ADR-0016), so the body cannot mis-thread them.
Keeping this boundary is what lets one helper serve any workflow rather than coupling to coding-shaped ones.

The wrapper's `input` is its door — the wrapper's own declared run-input schema, which also types a per-run slot's
mapper ([ADR-0033](0033-a-machine-declares-the-input-that-starts-it.md)). It sits on the wrapper and not on the body
precisely because of the injection above: the body's input is the door plus `workspace`, which no caller sends. That
same composition is what the door checks the body against, one way only — the body may not demand more than the wrapper
hands it; demanding less is safe — so the injection is a compile-time contract, not just a comment. The host's own
injection into a root machine's input (`instanceId`) counts as handed over for that check, because whether it actually
reaches this body depends on where the wrapper sits and no type can see that
([ADR-0033](0033-a-machine-declares-the-input-that-starts-it.md)).

## An Effect runs in its Workspace: the Harness container or the Sandbox Effector

An Effect in the body (ADR-0067) resolves the same ambient handles an Agent does. A `command` that names no secret runs
in the Harness container of the enclosing Workspace's Sandbox, as the Agent's user. A `push`, an `http` whose body is a
Worktree file and a `command` that names a secret run in that Workspace's Sandbox Effector, the pod's `effector`
container ([ADR-0005](0005-sandbox-pod-composition.md),
[ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)), which the provision adds only when an
Effect below the `workspace()` is placed there; its image is the Sandbox Image unless the `workspace()` names
`effector: { image }`. Each one's Worktree follows the Turn's rule (ADR-0057): its input names it, and under Repo Slots
it must. A push goes to the Binding of its Repo Slot, the one slot or the one its static `slot` names, and after every
push whose published commit is not the Agent's own — signed copies, or one squashed commit, signed or not — the
Workspace's Harness moves the Agent's branch to the published commits (the sync, ADR-0067). An Effect of these kinds
outside any `workspace()` is refused at invoke, as an error, never as output. A `command` that names a secret runs
against a pinned commit in a scratch of the Effector's own, and its child is confined with Landlock from the Effector's
key, the secrets it does not name, the push credentials and the Worktree (ADR-0067, ADR-0068).

## There is no retain policy: parking is retention

Teardown fires **only when the body reaches a final state or fails**. A Failure from the body
([ADR-0073](0073-a-machine-fails-a-run-with-fail-and-an-uncaught-failure-ends-it-failed.md)) goes to a `failing` state,
which runs the same `destroy` and then sends the Failure up unchanged; a defect goes up with no `onError`, and its
Sandbox stays as evidence. A body that needs its Sandbox kept alive — escalation, a human inspecting the worktree, a
human-review gate — simply parks in a non-final state (typically holding a `gate`, ADR-0011). We considered and rejected
an `onSettled → retain | destroy` policy knob: parking expresses retention with no new API, and keeps the run visibly
"waiting" in `jr2 runs`. A parked run's Sandbox stays alive as long as the run does — each live workspace renews its own
lease, and the operator reaps only Sandboxes whose lease has lapsed (abandonment, not parking — ADR-0001).

## Commits leave via the workflow, never the workspace

Getting commits out of the pod-local clone (push, PR) is **body flow**, decided by the workflow — a coding workflow
pushes the branch / opens a PR before its human gate, so review is PR-based and the forge owns merging. The workspace
attaches and destroys; it never touches remotes. A body that finishes without publishing loses its commits by design —
the same contract as a temp directory.

## Consequences

- The body chooses how many Agents work in its Workspace (ADR-0004, ADR-0075). The wrapper has no lock machinery for
  them.
- The workspace labels the CR with its run, its Workflow and its path (`jr2.dev/run`, `jr2.dev/workflow`,
  `jr2.dev/workspace`), and writes the exact path in the annotation `jr2.dev/workspace-path`. The path is the workspace
  actor's path in the run's Machine: actor ids joined by `/`, and a Pool child's id is its item's id, which can hold any
  character. A label value holds at most 63 characters from `[A-Za-z0-9._-]`, so the label holds a form of the path for
  a selector only: each other character becomes `-`, leading and trailing characters that are not alphanumeric are
  removed (a label value must start and end with one), and a value above 63 characters is cut and ends with a hash, as
  the CR's name does. A person selects by it with `kubectl -l`; no jr2 reader does. The `jr2 workspace` verbs list the
  CRs by `jr2.dev/run` and compare a handle, `<run-prefix>/<workspace path>`, with the annotation, with no Orchestrator
  (ADR-0009). They do not select by a run prefix, because a label selector matches only a whole value.
- **The CR's name comes from the run and the path.** It is `ws-`, the start of the run id and a form of the path, cut to
  fit 63 characters, then a hash of the run id and the path. The path, and not the workspace actor's own invoke id: an
  invoke id is local to the Machine that invokes it, and a `workspace()` nested in each worker of a Pool has the same
  invoke id in every worker. A Workspace that is the run's root has no path, and its own actor id takes its place. The
  Workspace keeps this id in its context, so a restored run names the same CR, and a parent that invokes the same
  Machine again from the same state gives the new Workspace the same name.
- **Lost workspace: the wrapper emits, the body decides.** While the body runs, a lease actor beside it renews the
  Sandbox's keepalive and follows the Sandbox watch for whether the workspace it attached to is still there (ADR-0021,
  ADR-0063) — continuously, and on snapshot restore as the first tick of that same loop rather than a separate
  restore-time path. Intact → carry on (same endpoint — deterministic per Sandbox name; in-flight turns re-attach from
  the host ledger, ADR-0016). Lost — reaped, deleted, or a replacement pod after an eviction or node loss — → the
  pod-local clone and any unpushed commits are gone, so silently re-provisioning would resume into an inconsistent world
  (tickets closed, commits vanished); instead the wrapper delivers a **`workspace.lost`** event into the body — same
  channel as `agent.fault` — and the body's policy decides (route it to escalation, fail the run, or choose to
  re-provision and restart). The body must route it: `workspace()` refuses a body with a non-final state that has no
  route on itself or an ancestor, and an event that no transition takes faults the run
  ([ADR-0074](0074-an-unrouted-mechanism-event-is-refused-at-load-and-faults-the-run.md)).
