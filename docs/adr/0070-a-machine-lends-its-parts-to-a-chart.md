# A Machine lends its parts to a Chart

The ask behind [ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md) had a second
half: an Agent should be able to create a powerful workflow at run time and run it, without a commit to the Instance and
without a human redeploying anything, and it must not be able to take the system over. The first half settled that only
`jr2 up` publishes code, because a Machine is TypeScript the Orchestrator imports into a process that holds the
ServiceAccount, the signing key and the Instance token, and every fence jr2 built keeps the Agent away from that
process: it reaches its Machine through a container it cannot read
([ADR-0013](0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md)), holds Stand-ins and never keys
([ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md)), and spends a credential only through
an Effector ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)). One `fromPromise` written by
an Agent and imported by the Orchestrator collapses all of them. So an Agent's workflow cannot be code. The grill of
2026-10-18 found that it does not need to be, and the prior art agrees: Step Functions keeps every `Resource` a constant
and puts all authority in the role; Argo's answer to "anyone who can submit a Workflow gets any ServiceAccount" was a
strict mode where a submitter may only reference a human-owned template; Temporal's own answer to "dynamic" is a trusted
interpreter walking untrusted JSON; Stately's v6 serializer stores a machine as data with implementations by name and
refuses inline code outright. In-process isolates (`node:vm`, `isolated-vm`, QuickJS in wasm) are argued against by
their own maintainers, and the escapes shipped in systems that used them were in the bridge.

## Decision

- **A Chart is a Machine written as data alone.** States, transitions, invokes, `after` delays, nested and parallel
  states, a final state's output: xstate's own JSON-serializable config, with every guard, action and delay named
  (`{ type, params }`) and every `invoke.src` a slot name. It carries no function, no import, no secret name, no url, no
  argv, no image and no Repo. A spike against xstate 5.32.2 bound such a chart as a child of a hand-written wrapper,
  with lent actors, named guards and actions reading `params`, `sendParent`, `onDone` output and a snapshot round-trip.
- **An Open body is the slot a Chart binds.** A Machine declares a body slot and leaves it Open for a run to bind, the
  one Open part that a run, not a composer, binds
  ([ADR-0054](0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md)), as a per-run Repo Slot is
  bound from the door ([ADR-0051](0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md)). The declaration
  states three things: what it **lends**, by slot name (Agents, Effects, child Machines, guards, actions, delays); what
  a Chart may **define** (the models and the Workspace access its own Agents may have); and the **ceilings** (below).
  Nothing a Chart names resolves anywhere but there.
- **A Chart mints routing, events and Agents; it borrows reach.** It mints its states and transitions; its Vocabulary,
  each event `{ name, input: <JSON Schema>, audience? }`, built into zod at admission (zod 4 reads JSON Schema natively,
  and the wire to the Harness was JSON Schema already), so a lent Agent's Menu derives from the Chart's events as from
  any nested Machine's; its Gates and Emits; and its own Agents, because an Agent is five plain fields
  ([ADR-0049](0049-a-machine-carries-its-parts-and-composes-by-invoke.md)) and the Harness runs whatever definition
  rides the Turn. A minted Agent's model must be one the Open body allows and the Assembly placed a key for;
  `workspace: "none"` needs the Instance Harness the Assembly converged. Both are door refusals, never a 401 mid-run. It
  borrows, by slot name only, every Effect (the url, argv and secret were bound once by the author and the Chart fills
  only its input slots), every Repo and image, every secret, every child Machine, and every guard, action or delay
  beyond the generic set. Lending is attenuated by construction; an author who lends
  `command(["sh", "-c", arg("script")])` has lent a shell, and that is theirs to choose.
- **Constants for authority, references for data.** `invoke.src`, guard and action `type`s, delay names and event names
  are constants, checked against the lent set and the Chart's own declarations at admission. Data flows through
  references: a placeholder `{{context.ticket.title}}`, or `{ "$ref": "event.summary" }`, in an invoke's `input`, an
  action's `params`, a Gate's `meta` and the root `output`. A reference is a **path lookup** that jr2's own code
  performs at invoke time: a list of property names walked on the run's context, event or input, which are plain data by
  [ADR-0007](0007-durable-machine-state.md). There is no evaluation, no operator, no call; `{{context.round + 1}}` fails
  the grammar. The roots are `context`, `event` and `input`, and nothing else. A placeholder is read from the Chart's
  own strings and never from data: a ticket body that contains `{{context.notes}}` lands in a prompt as those
  characters. Four generic actions exist, `set { path, from }`, `append`, `increment` and `clear`; everything else a
  Chart does is states, named guards and lent actions. The kit's own `task` builds its coder prompt with a conditional
  on the round; in a Chart that is two states and a guard. A terminating, side-effect-free expression (CEL-class) is the
  named later addition, as a new reference kind: adding one breaks no Chart, removing one would.
- **The Chart is the body actor's input.** It arrives as a pick's payload or in the run's door input, so the grammar
  reaches a planner as the JSON Schema of its pick for free (`chartSchema` is exported by `@jr2/orchestrator`). The body
  actor constructs the live Machine from it at start and again at restore, which is
  [ADR-0007](0007-durable-machine-state.md)'s own rule, so the Chart's text persists with the run and the run's shape
  stamp ([ADR-0030](0030-a-snapshot-names-the-machine-it-was-written-under.md)) hashes the text, never the compiled
  config, which turns references into closures. Nothing of a Chart lives outside its run: it is one-shot, and
  [ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md)'s pin covers it by
  construction.
- **Admission is static and mandatory, because xstate refuses nothing.** The spike found that an un-lent `invoke.src`
  kills the WRAPPER actor with a `TypeError` that bypasses the body invoke's `onError`; an unknown action is silently
  ignored, even in the development build; an unknown delay name fires at once; an unguarded `always` cycle exhausted the
  heap. So the door checks, before `createActor`: the grammar; every `src`, `type` and delay name against the lent set
  and the Chart's own `agents`; every `on` key against the Chart's events and the events against a handling state
  ([ADR-0011](0011-workflow-defined-events.md)'s rules); every minted model against the allowed list and the placed
  keys; no `always` cycle without a guard; the size cap. A refusal is the body invoke's error, so a wrapper whose
  `onError` returns to the planning state hands it to the planner as a link in its Chain
  ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)): "Chart refused:
  `src: "linter"` is not a lent actor; lent: coder, reviewer, push", and the planner answers with a corrected Chart. No
  new mechanism: a refusal is a child's error, and an Agent reads its children's outcomes through the Chain already.
- **Counters are the Open body's.** Its declaration states the Chart's ceilings: Turns, wall clock, transitions (a
  microstep budget, since xstate has no loop guard), fan-out width, and Chart size. A spend ceiling checked before each
  model call is the right sixth; jr2 meters no spend today, so it is named and deferred.
- **The Console renders the run's Machine.** Every machine doc came from the definition, so a Chart's states would not
  render. A per-run doc route exists, and the run view draws the bound Machine. A Chart one cannot watch is a Chart one
  cannot trust.
- **The trust statement.** Code is published by the Instance; a run supplies only data. The fence is structural, so it
  holds whether the Agent is prompt-injected or the model is adversarial: data cannot reach the process, and a borrowed
  Effect reaches only the host its author fixed. What remains is cost and routing abuse, which the counters bound, and a
  Gate the Chart itself defines being approved on bad information, which is the author's Gate placement to decide.

## Considered options

- **Code, and trust the publisher**: an Agent publishes a Machine through an Effect holding the Instance token, behind a
  human Gate. Rejected: the Gate is the only fence, on a process that holds the cluster, and a reviewer reading
  generated code under time is not a fence
  [ADR-0059](0059-a-harness-holds-stand-ins-and-the-custodian-holds-the-keys.md) would accept anywhere else.
- **Isolation**: a dynamic body's logic in an isolate or a worker with no secrets. Rejected: Node disclaims `vm` as a
  security mechanism, `isolated-vm` is in maintenance mode with a bridge its author calls trivially crossed, QuickJS in
  wasm is unaudited; the run host is in-process xstate, so this is a second Orchestrator and a coordination protocol;
  and it buys a generality the body does not need.
- **Composition only, no minted Agents.** Rejected: an Agent is honestly data, and a Chart that cannot say "a tester
  with these instructions" is not powerful enough to be worth the door.
- **An expression language from the start.** Rejected above: it is [ADR-0008](0008-orchestrator-as-deployed-app.md)'s
  rejected DSL arriving through a side door; a reference kind can be added later without breaking a written Chart.
- **A Chart as a Workflow**: registered, named, re-runnable. Deferred, not rejected: it would be a Workflow registered
  as DATA, a far safer publish door than an Assembly, and it may come back as the agent-facing API. One-shot keeps
  [ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md)'s one publisher true now.
- **A Chart as an anonymous run with no wrapper.** Rejected: every fence above is the wrapper's; and the run would have
  no Workflow name for `jr2 status`, drift reporting and the Console.

## Consequences

- [ADR-0008](0008-orchestrator-as-deployed-app.md)'s "code, not config" is restated, not reversed: a human writes code;
  what a run supplies is data. Its "dynamic plugin loading stays deferred" line retires: code is never loaded
  dynamically, and a run may bind an Open body with a Chart.
- The walk learns a second mode. Today it is not `provide()`-aware and reads nothing a per-run binding adds; the door's
  walk runs over the bound Chart, and the `jr2 up` walk reads an Open body's declaration (its lent parts, allowed
  models, ceilings) so the keys and the Instance Harness a Chart could need are placed before any run.
- `fingerprintOf` moves from `def.machine` to the run's bound Machine with its Chart text; `RunBlob` carries the text;
  restore recompiles it. A Chart that no longer passes the door at restore (a lent slot the Assembly dropped) is drift
  with that reason.
- The GLOSSARY gains **Chart** and **Open body**, and **Open** no longer says a run never sees one.
- The `@model` tier gains a claim when an ADR states what a correct planner does with a refusal (resubmits a corrected
  Chart) and a step can observe it; a Chart's prompts are its author's, so the claim measures the refusal text, which is
  jr2's.
- Deferred, named: a spend ceiling; a CEL-class reference kind; a Chart under a name.
