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
- **An Open body is the slot a Chart binds, and a Chart wrapper is the Machine that declares it.** A Machine declares a
  body slot and leaves it Open for a run to bind, the one Open part that a run, not a composer, binds
  ([ADR-0054](0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md)), as a per-run Repo Slot is
  bound from the door ([ADR-0051](0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md)). The declaration
  states three things: what it **lends**, by slot name (Agents, Effects, child Machines, guards, actions, delays); what
  a Chart may **define** (the models and the Workspace access its own Agents may have); and the **ceilings** (below).
  Nothing a Chart names resolves anywhere but there. "Wrapper" unqualified keeps
  [ADR-0049](0049-a-machine-carries-its-parts-and-composes-by-invoke.md)'s sense, any Machine with a body slot,
  `workspace()` and `pool()` included; a Chart wrapper is the one whose body a run binds.
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
- **A Chart always runs under a Chart wrapper, and the Chart is the body actor's input.** Four doors, nothing else:

  | Who                            | One-shot                                                        | Named                                                                                                              |
  | ------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
  | HTTP (a human, a tool, an MCP) | `POST /workflows/<wrapper>/runs` with `chart` in the input      | `PUT /workflows/<wrapper>/charts/<name>` once, then `POST /workflows/<wrapper>/charts/<name>/runs`                 |
  | A Machine (an Agent)           | a pick carries the Chart; a state invokes the Open body with it | the Open body's input carries `{ chart: { name } }`, the wrapper's own Chart by its short name, resolved at invoke |

  One-shot, the Chart wrapper is the Workflow whose run it is. Named, the Chart is a child of its wrapper: its Workflow
  name is `<wrapper>/<name>`, its routes live under the wrapper's, and `jr2 run task/review-loop` starts it as the
  ordinary run-start does. A Chart never runs on its own: the Open body it binds is where its lent parts and ceilings
  come from. Either way the Chart arrives as the body actor's input, so the grammar reaches a planner as the JSON Schema
  of its pick for free (`chartSchema` is exported by `@jr2/orchestrator`), and a name is resolved to text at invoke time
  and admitted exactly as text would be, and **a name is a binding**: a named Chart was created against one Chart
  wrapper and runs under that wrapper only, which its name and its path both say. So the by-name path takes the short
  name alone, `review-loop`, and resolves it among the Charts of the Machine's own wrapper; there is no way to write
  another wrapper's. Portability belongs to the text alone: to run one Chart under another wrapper, pass the text
  one-shot or publish it under that wrapper too. The body actor constructs the live Machine from the text at start and
  again at restore, which is [ADR-0007](0007-durable-machine-state.md)'s own rule, so the text persists with the run,
  the run holds what it ran even if the name is later deleted or republished, and the run's shape stamp
  ([ADR-0030](0030-a-snapshot-names-the-machine-it-was-written-under.md)) hashes the text, never the compiled config,
  which turns references into closures. A one-shot Chart lives nowhere but its run, and
  [ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md)'s pin covers it by
  construction. Resolving by name is invoke-by-name, which
  [ADR-0049](0049-a-machine-carries-its-parts-and-composes-by-invoke.md) rejected for Machines; a name here resolves to
  data the Open body still binds, so nothing that decision protects is lost.

- **A Chart under a name is a Workflow and a child of its wrapper, from one of two origins.** Its name is
  `<wrapper>/<name>`, one rule for both. A **Chart file** in the Assembly sits at
  `workflows/<wrapper>/<name>.chart.json` and carries the Chart alone: discovered one level below the flat
  `workflows/*.ts` of [ADR-0050](0050-what-code-names-config-declares-what-the-cli-names-discovery-finds.md), in a
  directory named after its wrapper and holding nothing else jr2 reads; published by `jr2 up`, reproducible from the
  Instance repo, admitted by the same static door. A **runtime Chart** is `PUT /workflows/<wrapper>/charts/<name>` and
  `DELETE` on the same path, the body the Chart alone, behind the Instance token, not the publish token, because a Chart
  is data and cannot reach the process, which is the whole point of this decision; it lives on the Orchestrator's volume
  beside the Assemblies, survives restarts, is held while a live run holds it, and lists in `jr2 runs` and the Console
  with its origin shown. `GET /workflows` lists each wrapper with its Charts inside its entry, not beside it. So a
  Workflow is one of three things: a Machine from the Assembly, a Chart file from the Assembly, or a runtime Chart, and
  the last two are children of the first. **There is no collision rule**: a Machine's name is a filename stem and holds
  no slash, a Chart's name always holds one, and a wrapper missing from a new Assembly makes its Charts unrunnable by
  construction, which the publish reports. Rejected: flat names with a collision refusal and the wrapper named in the
  `PUT` body, the shape this decision first took; the binding was then a rule to check in two places instead of a fact
  the name and the path state. **jr2 tells a Chart wrapper from two facts it already reads**, and the author marks
  nothing: the walk sees the Open body on the registered Machine (a kit constructor in `actors`, as `agent()` is), and
  the door schema ([ADR-0033](0033-a-machine-declares-the-input-that-starts-it.md)) shows which field is `chartSchema`.
  A wrapper whose door has no Chart field is a wrapper for in-Machine Charts only, run by `jr2 run` like any Workflow;
  one with a Chart field can also be run one-shot by HTTP and can have named Charts. `GET /workflows` lists both facts.
  A named Chart's fixed input supplies every Chart-typed field of the wrapper's door and nothing else, so a named Chart
  stays a Chart and not a preset of a Workflow's door, which would be a decision of its own; a Machine with two Open
  bodies has two Chart fields and a named Chart fixes both. A `PUT` or a Chart file under a wrapper with no Chart door
  is refused, as is one under a Workflow that is no wrapper at all. **An Assembly publish re-admits every named Chart**
  against the new Assembly, because a lent slot may have gone: a Chart file that fails refuses the publish, since the
  file is the Instance's own; a runtime Chart that fails is marked unrunnable and reported in the publish's answer,
  never deleted, because it is someone else's. An MCP that lets a user's own agent author and run Charts is a client of
  these routes plus `GET /workflows/<wrapper>` for the Open body's declaration and `GET /runs/<id>/events`; whether the
  kit ships one is a product question, not this one.
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
- **One-shot only, no Chart under a name.** Rejected: a test wants the same Chart on every run (the text already gives
  that), but a person, another tool and an MCP want `jr2 run <name>`, a Console entry and a Chart that outlives the run
  that wrote it; and a Chart under a name is a Workflow registered as DATA, which keeps
  [ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md)'s one publisher of CODE
  true.
- **A Chart as an anonymous run with no Chart wrapper.** Rejected: every fence above is the wrapper's; and the run would
  have no Workflow name for `jr2 status`, drift reporting and the Console.
- **A kit Effect that publishes a Chart from a Machine** (`publishChart`, over the Effector's signed wire, no token).
  Deferred: nothing needs an Agent to keep a Chart yet; a Machine that wants one later runs it by name after a human or
  a tool published it. If it comes, it is an Effect the author writes in, with or without a Gate, and never a side
  effect of running an Open body.

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
- The GLOSSARY gains **Chart**, **Chart wrapper** and **Open body**; **Workflow** gains its three origins; **Open** no
  longer says a run never sees one.
- The `@model` tier gains a claim when an ADR states what a correct planner does with a refusal (resubmits a corrected
  Chart) and a step can observe it; a Chart's prompts are its author's, so the claim measures the refusal text, which is
  jr2's.
- Deferred, named: a spend ceiling; a CEL-class reference kind; `publishChart`.
