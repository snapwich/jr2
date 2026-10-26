# A Machine fails a run with `fail()`, and an uncaught Failure ends it `failed`

A run ended `done` when its Machine got to a final state, and that did not say that the work succeeded. No Machine could
end a run as a failure. An eval in which an Assistant writes jr2 Workflows showed the gap: three of the four
ticket-to-pr trials wanted a failure that is not `done`. Two threw from a plain `fromPromise` ("the planner changed the
code", "the push failed"). The run then ended `error`, with the message in `fault`, no output and the Sandbox kept, so
an operator could not tell a kit bug from a failed ticket. One trial wrote `failed` and `lost` final states with the
comment "the run faults rather than lie about a decision", and that run ended `done`. The fourth put a
`failed: "<reason>"` variant in its output union, which every reader of the run then had to know about.

## Decision

- **A Failure is the end that a Machine chooses for work that did not succeed.** A Machine makes one with the Part
  `fail()`: `actors: { fail: fail() }`, invoked as `src: "fail"` from any state, at any depth. Its input is
  `{ reason: string; detail?: unknown }`: `reason` is text for a person, and `detail` is optional JSON for a machine
  reader. The Part throws an error with a brand. The brand is a registry key (`Symbol.for`), because an Instance can
  load a second copy of the kit, and both copies must read the same brand. The kit does not export it, and an author
  makes a Failure only with `fail()`. It is a Part and not an Effect, because it does no work outside the Machine. The
  slot name is the author's; the docs use `fail`, never `abort`, which is a Settlement's word and the wire's.
- **A Failure goes up by xstate's own error rules.** It goes from the state that invokes `fail` to each parent Machine
  in turn, and an `onError` on the way catches it, as a `catch` does. `isFailure(error)` tells a Failure from a defect
  and narrows it to the payload:
  `onError: [{ guard: ({ event }) => isFailure(event.error), target: "replan" }, { target: "defect" }]`. In a Chart, the
  same guard is `jr2.failure`: every Chart has it, as every Chart has `jr2.sentBy`, because it is a predicate and gives
  no capability.
- **An uncaught Failure ends the run `failed`.** `failed` is a Run status of its own, beside `done` and `error`. `fault`
  stays empty, and the run's output is the payload, not a value of the Machine's output type. `jr2 status` and the
  Console show the reason, and the Console gives `failed` a color that is not the red of `error`.
- **A Failure deletes the Sandbox.** A Failure is a chosen end, as `done` is, and each kept Sandbox holds its whole Size
  ([ADR-0060](0060-a-workspace-states-its-size-and-jr2-reserves-all-of-it.md)) until its Lease lapses. `workspace()`
  catches a Failure from its body: `running` gets `onError` guarded by `isFailure` to a `failing` state, which runs the
  same `destroy` as `teardown` and then invokes `fail` again with the same payload. So `workspace()` still owns the
  Sandbox's life ([ADR-0012](0012-workspace-wrapper-machine.md)), a caught Failure leaves no Sandbox behind, and the
  parent gets the Failure unchanged. A defect still goes up with no `onError`, and its Sandbox stays as evidence. The
  host deletes every Sandbox of a run that ends `failed`, after the stop, as `cancel` does
  ([ADR-0025](0025-cancel-ends-a-run-stop-parks-it.md)); after the wrapper's own delete, that is only a backstop. When a
  Machine above catches the Failure, the host stops the children of the Machine that the Failure ended, and after the
  stop it deletes their Sandboxes, because a stop skips `teardown`. It does not delete a name that a live Workspace of
  the run holds then, and nor does a Workspace that was stopped in `placing`
  ([ADR-0064](0064-a-workspace-waits-for-capacity.md)): a parent that invokes the same Machine again gives the new
  Workspace the same invoke id, and so the same Sandbox name. That new Workspace takes over the Sandbox and its
  Worktree, as a restore does, with the work of the failed attempt still in it. To keep the work for a person to read,
  the Machine waits at a Gate before it fails.
- **`jr2 run` exits 0 only for `done`.** It exits 1 for every other end: `failed`, `error`, `cancelled`, `lost`,
  `drifted`, and a run that was parked before it settled. Exit code 2 stays the CLI's code for a usage error. The status
  line on stderr tells which end it was, and `jr2 status --json` tells a script.
- **A `dispatch` parent reads `failed` as a status.** `settled.status` gets `failed`, on the in-process path and in the
  foreign `DispatchOutput` shape ([ADR-0071](0071-a-run-starts-a-run-through-a-dispatch-effect.md)), and `output` is the
  payload.
- **Each state that can fail the run is static.** The walk finds each state that invokes a `fail()` slot, also in a
  nested Machine. `jr2 up`, `jr2 check` and the Machine doc list them, as they list Gates and Effects.
- **A Machine lends `fail` to a Chart as it lends `gate`**: `lends: { fail: true }`
  ([ADR-0070](0070-a-machine-lends-its-parts-to-a-chart.md)). The Machine decides if a Chart can end its run as a
  Failure, and it can catch one with an `onError` on its Open body state.
- **A plain throw stays a defect.** Logic that throws ends the run `error`, as before. jr2 cannot see in the walk that a
  promise only throws, so the docs say it: to fail, invoke `fail`; never throw to fail, and a final state means `done`.
- **A decision of a person fails the run only when it ends the run.** The rule is about the state where the run ends. A
  `reject` that sends the work back is a usual route. A decision that ends the run, such as a `reject` at a Gate or a
  `roll_back`, goes to a state that invokes `fail` with the reason of the person, not to a final state, and
  `{ outcome: "rejected" }` leaves the output unions. A Machine whose job is the decision itself, such as a triage where
  "no" is a correct answer, keeps a final state and puts the decision in its output.
- **The shipped `task` Machine fails when its Sandbox is lost.** Its `lost` state invokes `fail` and is no longer final,
  and `outcome` leaves `TaskOutput`, which is `{ branch }`. A parent that read `outcome: "lost"` now catches the
  Failure. `pool()` is such a parent: it keeps a worker's Failure in `failures` and goes on, so that one lost worker
  does not delete the Sandboxes of its siblings ([ADR-0017](0017-pool-over-a-source-port.md)). When it ends with
  failures, `drained` or `deadlocked`, it fails the run with the reason `"<n> of <m> items failed"` and the detail
  `{ status, items, failures }`, unless its option `failures` is `"report"`: then it ends `done`, with the failures in
  its output. The docs examples whose final states mean "this did not succeed" change in the same way.
- **A restart replays a Failure.** The state that invokes `fail` persists as any state does
  ([ADR-0007](0007-durable-machine-state.md)), and on restore `fail` runs again and throws again.

## Considered options

- **A failure is only the Workflow's output** (the fourth trial's shape). Rejected: the `jr2 run` exit code, the Sandbox
  decision and the Console must react the same way for every Workflow, and none of them can read a Workflow's own output
  shape. Each CI script would parse the output of each Workflow.
- **`jr2 run --fail-on <path>`.** Rejected: it puts a fact of the run in one client, so the Console and `dispatch` do
  not see it.
- **A tag, `run.failed`, on a top-level final state.** Plain xstate and static, and it was this ADR's first form.
  Rejected: only the root's final state can give the status, so each level between the failure and the root must carry
  it. xstate's done event carries only the output, so `workspace()` would need a second, tagged final state and a fact
  in its context; the Chart wrapper would need a new outcome; each nested Machine would map its child's output to a
  tagged final state of its own. A throw needs none of that, because xstate already sends an unhandled error up through
  each parent.
- **An output shape that jr2 reads**, such as `{ failed: reason }`. Rejected: it gives jr2's meaning to a key in the
  author's own data, which is hidden mechanism ([ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md)), and it
  takes part of the output type from the author.
- **The unbranded throw** that the trials wrote. Rejected: it ends `error` with no output, and nobody can tell it from a
  defect.
- **A separate exit code for `failed`.** Rejected: CI needs to know that the run did not succeed, and the status tells
  which end it was.
- **A typed `fail<T>()`** with an input schema. Not now: it adds a type parameter to the Authoring surface, and no trial
  needed a typed `detail`.
- **`fail` in every Chart, with no lend.** Rejected: the Machine decides which ends a Chart can choose, as it decides if
  a Chart can wait at a Gate.
- **A failed run keeps its Sandbox**, as a fault does. Rejected: a fault keeps it because nobody chose that end; a
  Failure is chosen, a CI loop of failed tickets would fill the cluster, and a Gate keeps the work when the author wants
  it.
- **Another word than `failed`**, because a Settlement has a `failed` value too. Rejected: `failed` is the word CI and
  people use, the two are about different things (a run and a Submission), and each glossary entry names its subject.

## Consequences

- **`onError` carries two things**: a defect or a Failure, which `isFailure` separates
  ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)). A broad
  `onError: "retry"` catches a Failure too, as a broad `catch` does.
- **A failed run's output has the kit's shape**, so `DispatchOutput` has a branch for `failed` and a parent reads the
  payload there.
- **An uncaught Failure stops the tree** as an error does: exit actions and `teardown` above the failing state do not
  run, and the host does their cleanup.
- **`done` now means that the work succeeded**, by the convention that the docs teach: a Machine that did not succeed
  fails.
- The e2e and `@model` settle loops treat every status that is not `live` as settled (`features/lib/run-settled.ts`), so
  a `failed`, `cancelled` or `lost` run does not poll until the timeout. The Workflow fixtures of the `@kind` and
  `@model` tiers that end in a `faulted` or `lost` final state invoke `fail`. A trial's note prints the Failure of a
  `failed` run: `EXPLAINED_STATUSES` in `features/lib/model-status.ts` lists `failed` with the other statuses that it
  explains, and `model-finished.ts` counts only `done` as finished. The Chart fixtures keep their final states: no
  wrapper that runs them lends `fail`, and they test the door and the routing, not how a run ends.
- The change touches what a model reads (the docs, the AGENTS.md index, the fixtures' Machines), so the `@model` tier
  runs before it is done
  ([ADR-0066](0066-a-model-tier-runs-a-real-model-and-a-change-to-what-it-reads-runs-the-tier.md)), and the agents-md
  eval runs against it.
