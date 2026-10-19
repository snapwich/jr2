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
  argv, no image and no Repo, and it names no Turn's placement: the Open body places every Agent Turn its Chart starts
  from its own input, as its wrapper placed it (the stub tier's explicit `endpoint`, or the ambient `workspace()`). The
  grammar is version 1 of a kit schema, `chartSchema`, not xstate's config whole: a state's own `onDone`, a parallel
  join and an `emit` action are not in it, a nested final state's output is refused because nothing reads it, and a
  Chart is at most 200 states, 8 deep. A spike against xstate 5.32.2 bound such a chart as a child of a hand-written
  wrapper, with lent actors, named guards and actions reading `params`, `sendParent`, `onDone` output and a snapshot
  round-trip.
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
  any nested Machine's. The payload schema is a named subset: `type`, `properties`, `required`, `items`, `enum`,
  `const`, `additionalProperties`, the numeric and length bounds, `title` and `description`; `pattern`, `$ref`, the
  combinators and the conditionals are refused by name, because the Orchestrator checks every pick against the schema in
  its own process, and a payload field named `type` is refused, because the event name is a constant the Orchestrator
  writes after the payload. It mints its Gates, whose ids sit below the body's own actor path, so a Chart cannot take
  the name of its wrapper's Gate; and its own Agents, because an Agent is five plain fields
  ([ADR-0049](0049-a-machine-carries-its-parts-and-composes-by-invoke.md)) and the Harness runs whatever definition
  rides the Turn. A minted Agent's model must be one the Open body allows and the Assembly placed a key for;
  `workspace: "none"` needs the Instance Harness the Assembly converged. Both are door refusals, never a 401 mid-run. It
  borrows, by slot name only, every Effect (the url, argv and secret were bound once by the author and the Chart fills
  only its input slots), every Repo and image, every secret, every child Machine, and every guard, action or delay
  beyond the generic set. Lending is attenuated by construction; an author who lends
  `command(["sh", "-c", arg("script")])` has lent a shell, and that is theirs to choose. A lent name may not be dotted,
  `gate`, a generic action's name or an integer, because those are the kit's.
- **Constants for authority, references for data.** `invoke.src`, guard and action `type`s, delay names and event names
  are constants, checked against the lent set and the Chart's own declarations at admission. Data flows through
  references: a placeholder `{{context.ticket.title}}`, or `{ "$ref": "event.summary" }`, in an invoke's `input`, an
  action's `params`, a Gate's `meta` and the root `output`. A reference is a **path lookup** that jr2's own code
  performs at invoke time: a list of property names walked on the run's context, event or input, which are plain data by
  [ADR-0007](0007-durable-machine-state.md). There is no evaluation, no operator, no call; `{{context.round + 1}}` fails
  the grammar. The roots are `context`, `event` and `input`, and nothing else; `event.output` and `event.error` are read
  whole, and `event.error` is a line jr2 writes that names the invoke, never the error's own message, because a child's
  error is a defect whose text never reaches a model
  ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)). A placeholder is read
  from the Chart's own strings and never from data: a ticket body that contains `{{context.notes}}` lands in a prompt as
  those characters; a lone placeholder yields the value itself, and one inside a string writes an object as JSON. Four
  generic actions exist, `set { path, from }`, `append`, `increment` and `clear`, with `path` relative to the context;
  everything else a Chart does is states, named guards and lent actions. The kit's own `task` builds its coder prompt
  with a conditional on the round; in a Chart that is two states and a guard. A reference the door admitted but the
  run's data lacks (a read before the state that writes it) settles the body `refused` with the reference named, never
  as an error. A terminating, side-effect-free expression (CEL-class) is the named later addition, as a new reference
  kind: adding one breaks no Chart, removing one would.
- **A Chart always runs under a Chart wrapper, and the Chart is the body actor's input.** Four doors, nothing else:

  | Who                            | One-shot                                                        | Named                                                                                                              |
  | ------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
  | HTTP (a human, a tool, an MCP) | `POST /workflows/<wrapper>/runs` with `chart` in the input      | `PUT /workflows/<wrapper>/charts/<name>` once, then `POST /workflows/<wrapper>/charts/<name>/runs`                 |
  | A Machine (an Agent)           | a pick carries the Chart; a state invokes the Open body with it | the Open body's input carries `{ chart: { name } }`, the wrapper's own Chart by its short name, resolved at invoke |

  One-shot, the Chart wrapper is the Workflow whose run it is. Named, the Chart is a child of its wrapper: its Workflow
  name is `<wrapper>/<name>`, its routes live under the wrapper's, and `jr2 run task/review-loop` starts it as the
  ordinary run-start does. A Chart never runs on its own: the Open body it binds is where its lent parts and ceilings
  come from. Either way the Chart arrives as the body actor's input, so the grammar reaches a planner as the JSON Schema
  of its pick for free (`chartSchema` is exported by `@jr2/orchestrator`, and `chartSchemaFor(declaration)` is the same
  grammar narrowed to one Open body, for a planner's pick), **narrowed per wrapper**:
  `GET /workflows/<wrapper>/chart-schema` is the grammar with the wrapper's lent slot names, guard, action and delay
  names, and allowed models as `enum`s, derived from the two facts jr2 already reads. A human writing
  `workflows/<wrapper>/<name>.chart.json` points an editor at it and gets validation and completion; a planner whose
  pick is `{ chart }` gets it as its tool parameters, so the model is constrained at generation time, which is as close
  to a type as a model can get. A Chart file is admitted by `jr2 up`'s host-side walk with the same door, so its errors
  surface at the same command as `tsc`'s, one step later. That is what compile-time type safety becomes for a Chart: the
  wrapper stays TypeScript and typechecked, and the Chart's references into it are checked at a door that sees the live
  lent set, which a compiler would not. And a name is resolved to text at invoke time and admitted exactly as text would
  be, and **a name is a binding**: a named Chart was created against one Chart wrapper and runs under that wrapper only,
  which its name and its path both say. So the by-name path takes the short name alone, `review-loop`, and resolves it
  among the Charts of the wrapper that is the run's root Workflow, seen through a transparent wrapper; a Chart wrapper
  that another Machine invokes as a child resolves no name, because the run is not that wrapper's, and there is no way
  to write another wrapper's. Portability belongs to the text alone: to run one Chart under another wrapper, pass the
  text one-shot or publish it under that wrapper too. The body actor constructs the live Machine from the text at start
  and again at restore, which is [ADR-0007](0007-durable-machine-state.md)'s own rule: the text and its hash persist in
  the body's own snapshot, so the run holds what it ran even if the name is later deleted or republished, and the run's
  shape stamp ([ADR-0030](0030-a-snapshot-names-the-machine-it-was-written-under.md)) stays its wrapper's, because the
  Chart is the run's data and not its Machine's shape. At restore the body admits its text again against the parts lent
  now and compiles it again; a hash that does not match the text, or a text the door now refuses, is drift naming the
  body slot and the reason. A one-shot Chart lives nowhere but its run, and
  [ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md)'s pin covers it by
  construction. Resolving by name is invoke-by-name, which
  [ADR-0049](0049-a-machine-carries-its-parts-and-composes-by-invoke.md) rejected for Machines; a name here resolves to
  data the Open body still binds, so nothing that decision protects is lost.

- **A Chart's author is an Agent, and jr2 briefs it on the Turn that may write one.** A Chart is written by a model at
  run time: a planner whose pick carries one. A human who keeps a Chart file reads the same grammar through an editor,
  and is the second audience, not the first. The narrowed grammar constrains the Chart's names, but it does not teach
  what a Chart IS, and a measured planner guessed xstate: `onDone` on an Agent, no `events`, the lent Agent redefined
  under `agents`, `input.change` for a prompt, `event.result.value` for a pick's field. Its first Chart drew a ten-line
  report and admitted on the third or fourth. So jr2 says how a Chart runs BEFORE the first Chart, as the **Chart
  briefing** (`CHART_BRIEFING`, `chartBriefing(narrow)`): one text, jr2's, naming no task and no pick, that reaches
  every author by one channel each. It is the grammar's root `description`, so `GET /workflows/<wrapper>/chart-schema`
  and a pick's tool parameters carry it, and a future MCP built on the schema carries it for free. A narrowed grammar's
  briefing names the lent Agents, and a body that allows no model has NO `agents` in its grammar and a briefing that
  says so: a planner reads a field it cannot fill as one to fill (measured: eight of ten first Charts minted under a
  `never` model, and read "must not have additional properties" for it), and a Chart that brings `agents` anyway reads
  at the door why there is none. And the Agent's surface MARKS a pick whose parameter is a Chart with that grammar's
  briefing (`SurfaceEvent.briefing`, by schema identity), so the Harness says the text in the Turn part, right before
  "Allowed now", on every Turn where that pick is Allowed, and on a restatement that opens it
  ([ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md)). Nowhere else: the standing Briefing stays
  Chart-agnostic, the tools block stays the same bytes on every Turn
  ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)), and a seat whose Menu
  holds no Chart pick reads not a word of it. The cost is the author's to scope: a seat whose Menu holds a Chart pick
  carries the grammar as cached tool parameters on every Turn, so an author who wants a planner that only sometimes
  writes a Chart gives the pick to a seat of its own. The grammar's fields keep terse sentences at the places a planner
  got wrong (`agents`, `invoke.input`, `invoke.onDone`, `events`, `output`), because a model reads a property's
  description as it emits the property. The door's report stays complete, one line per fault, as the second teacher. A
  worked example in the schema is the next lever, if a measured run says the text is not enough; it is not taken ahead
  of one.

- **A Chart under a name is a Workflow and a child of its wrapper, from one of two origins.** Its name is
  `<wrapper>/<name>`, one rule for both, and `<name>` is lower-case letters, digits and hyphens, 63 at most. A **Chart
  file** in the Assembly sits at `workflows/<wrapper>/<name>.chart.json` and carries the Chart alone: discovered one
  level below the flat `workflows/*.ts` of
  [ADR-0050](0050-what-code-names-config-declares-what-the-cli-names-discovery-finds.md), in a directory named after its
  wrapper and holding nothing else jr2 reads (a `_` or `.` directory is a helper's, as ADR-0050 has it, and a
  `.chart.json` at the flat level is a warning, never a Chart); published by `jr2 up`, which admits every Chart file on
  the host before any cluster work, reproducible from the Instance repo, admitted by the same static door at the
  publish. A **runtime Chart** is `PUT /workflows/<wrapper>/charts/<name>` and `DELETE` on the same path, the body the
  Chart alone, behind the Instance token, not the publish token, because a Chart is data and cannot reach the process,
  which is the whole point of this decision; it lives on the Orchestrator's volume at
  `.jr2/charts/<wrapper>/<name>.chart.json` beside the Assemblies, written durably, and survives restarts. A live run
  holds its Chart through the text in its own snapshot, so a `DELETE` while a run is live answers at once and the run
  goes on. It lists in `jr2 runs` and the Console with its origin shown: `jr2 runs` keeps its result, the live runs, and
  prints the listing beside it as activity, with `--workflows` to make the listing the result
  ([ADR-0009](0009-cli-and-instance-interface.md)); there is no verb for `PUT` or `DELETE`, an MCP or `curl` is the
  client. `GET /workflows` lists each wrapper with its Charts inside its entry, not beside it, and
  `GET /workflows/<wrapper>` carries each Open body's declaration. So a Workflow is one of three things: a Machine from
  the Assembly, a Chart file from the Assembly, or a runtime Chart, and the last two are children of the first. **There
  is no collision rule between a Machine and a Chart**: a Machine's name is a filename stem and holds no slash, a
  Chart's name always holds one, and a wrapper missing from a new Assembly makes its Charts unrunnable by construction,
  which the publish reports. Between the two origins there is one: a Chart file and a runtime Chart of one name are the
  file's, and the runtime Chart is unrunnable, kept, until the file leaves the Assembly; a `PUT` to a name a file holds
  is refused. Rejected: flat names with a collision refusal and the wrapper named in the `PUT` body, the shape this
  decision first took; the binding was then a rule to check in two places instead of a fact the name and the path state.
  **jr2 tells a Chart wrapper from two facts it already reads**, and the author marks nothing: the walk sees the Open
  body on the registered Machine (a kit constructor in `actors`, as `agent()` is, seen through a transparent wrapper's
  body), and the door schema ([ADR-0033](0033-a-machine-declares-the-input-that-starts-it.md)) shows which field is
  `chartSchema`. A wrapper whose door has no Chart field is a wrapper for in-Machine Charts only, run by `jr2 run` like
  any Workflow; one with a Chart field can also be run one-shot by HTTP and can have named Charts. `GET /workflows`
  lists both facts. A named Chart's fixed input supplies every Chart-typed field of the wrapper's door and nothing else,
  so a named Chart stays a Chart and not a preset of a Workflow's door, which would be a decision of its own; a Machine
  with two Open bodies has two Chart fields and a named Chart fixes both, and a Chart, named or a field, is admitted
  when one of the bodies admits it, each report line naming its body, because the door cannot tell which body a field
  feeds. A `PUT` or a Chart file under a wrapper with no Chart door is refused, as is one under a Workflow that is no
  wrapper at all. **An Assembly publish re-admits every named Chart** against the new Assembly, because a lent slot may
  have gone: a Chart file that fails refuses the publish, since the file is the Instance's own; a runtime Chart that
  fails is marked unrunnable and reported in the publish's answer, never deleted, because it is someone else's. An
  unrunnable Chart still lists, with its reason, and a start of it answers 409. An MCP that lets a user's own agent
  author and run Charts is a client of these routes plus `GET /workflows/<wrapper>` for the Open body's declaration and
  `GET /runs/<id>/events`; whether the kit ships one is a product question, not this one.
- **Admission is static and mandatory, because xstate refuses nothing.** The spike found that an un-lent `invoke.src`
  kills the WRAPPER actor with a `TypeError` that bypasses the body invoke's `onError`; an unknown action is silently
  ignored, even in the development build; an unknown delay name fires at once; an unguarded `always` cycle exhausted the
  heap. So the door checks, before `createActor`, in this order: the size cap, then the grammar, and if either fails
  nothing else is read; then every fault of the rules that follow, reported together, each line with its path in the
  Chart and what is lent or allowed. The names: every `src`, `type` and delay name against the lent set and the Chart's
  own `agents`, and a delay below the wall clock. The events: every `on` key against the Chart's events and the events
  against a handling state ([ADR-0011](0011-workflow-defined-events.md)'s rules), each payload within the schema subset
  above. The minted Agents: every model against the allowed list and the placed keys, every Workspace access against the
  allowed set. The structure: no `always` cycle without a guard, through parallel regions and history too; no `onDone`
  on an Agent invoke, because a Turn never settles by itself, it ends on a pick in `on`; no Agent state that nothing can
  end; no parallel state at or below an Agent's. And two checks that stand in for the types a Chart does not have.
  **Dataflow**: every reference a Chart makes, `{{context.summary}}` or `{ "$ref": "event.notes" }`, must be supplied by
  something the door can see: the Chart's initial `context`, the Chart's input (the wrapper's door less its Chart fields
  and the placement, or, for a body a Machine invokes, what that invoke sends), the schema of the event the transition
  handles, or a `set`, `append` or `increment` on that path or above it, where a `set` from one reference supplies what
  that reference supplies and nothing deeper; a reference nothing supplies would resolve to an empty string in a prompt
  with no one the wiser, so it is refused. The fields a Chart declares are its types. **Lent input shapes**: an Effect
  carries an `input` schema and an Agent's Turn input is a fixed key set (`prompt`, `cwd`, `continue`, `model`,
  `thinkingLevel`, no placement), so the literal parts of a Chart's `input` objects are validated at the door and the
  resolved object again at invoke time, where a failure is that invoke's error and never a mid-Turn surprise. Last, the
  door compiles the Chart as the body would: `jr2Setup`'s own refusals, and the load warnings a hand-written Machine
  gets (an unentered mode), are refusal lines for a Chart, because a planner reads a report and nobody reads a warning.
  A refusal is the body's OUTPUT, `{ outcome: "refused", report }`, routed by the wrapper's `onDone` with a guard on
  `outcome`, so a wrapper whose `onDone` returns to the planning state hands it to the planner as the output link in its
  Chain ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)): "Chart refused:
  `src: "linter"` is not a lent actor; lent: coder, reviewer, push", and the planner answers with a corrected Chart. It
  is not the body's error, because a child's error is a defect that never reaches the model (ADR-0067, which stands); at
  the HTTP door it is 422 with the same report. No new mechanism: an Agent reads its children's outputs through the
  Chain already.
- **Counters are the Open body's.** Its declaration states the Chart's ceilings: Turns, every Agent Turn below the body,
  a lent Machine's included; wall clock, at most xstate's timer bound of 2^31-1 ms; transitions, one microstep budget
  for the whole run, since xstate has no loop guard; fan-out width, the children live at once; and Chart size in bytes,
  at most 1 MiB. One bound is the kit's and not the declaration's: a context or an output above 4 MiB. A ceiling met
  settles the body `{ outcome: "ceiling", ceiling }`, its children stopped, and a Turn one past the Turns ceiling never
  starts. A spend ceiling checked before each model call is the right next one; jr2 meters no spend today, so it is
  named and deferred.
- **The Console renders the run's Machine.** Every machine doc came from the definition, so a Chart's states would not
  render. A per-run doc route exists, `GET /workflows/<name>/runs/<id>/machine`, and the run view draws the bound
  Machine, keyed by the Charts the run binds now, so a planner's second Chart draws a second doc; a Chart the run cannot
  draw (a drifted run) is named in the doc. A Chart one cannot watch is a Chart one cannot trust.
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
  models, ceilings) so the keys and the Instance Harness a Chart could need are placed before any run: a body that lends
  an Agent with a Workspace puts its allowed models on the pods, and one that allows `"none"` on the Instance Harness,
  which is converged for it.
- `fingerprintOf` stays the wrapper's; the Chart's text and hash ride the body's own snapshot inside `RunBlob`, and
  restore admits and compiles the text again. A Chart that no longer passes the door at restore is drift with that
  reason. Under [ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md) a live run
  holds its Assembly and a publish takes no lent slot from it, so this drift guards a Kit change or a damaged volume,
  not a later publish.
- The GLOSSARY gains **Chart**, **Chart wrapper**, **Open body** and **Reference**; **Workflow** gains its three
  origins; **Open** no longer says a run never sees one. The Briefing's Turn part gains a pick's briefing
  ([ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md) as amended): the Chart briefing is its first.
- The `@model` tier gains the claim `chart-refusal`: a planner whose pick is `run_chart` with the narrowed grammar is
  asked for a Chart that names a slot the body does not lend, the door refuses it, and the planner's next Chart admits.
  A Chart's prompts are its author's, so the claim measures jr2's text: the Chart briefing and the door's report. The
  floor is 7 of 10, set ahead of a measured run. Measured 2026-10-19 on the home-lab instrument, one lever per run of
  ten: with no briefing, 0, 4 and 2 trials (the first report was about twelve lines; the second Chart fixed most and not
  all); with the briefing and a body that allowed no model, 0 (the first report fell to a median of three lines, but
  eight first Charts minted an Agent under a `never` model and the measured pick hit the Menu's "must not have
  additional properties"); with `agents` gone from that grammar, 1 of 10 (the second Chart's fault was now one line,
  "context.summary is supplied by nothing", in six of nine, and every one of them WAS written, from a pick field the
  Chart never put in `required`, which the line hid); with that line naming the write and the field, and the briefing
  teaching `required`, 5 of 10, and every miss admitted on the third Chart. The misses that remain are two the kit still
  lures: the narrowed `src` enum offers the kit's `gate` beside the one lent Agent, and three second Charts reached for
  it as "the linter"; and a pick that carries the Chart as a JSON string, which pi's validation refuses ("chart: must be
  object") before the door sees it, twelve times in ten trials. What the next Chart gets wrong is in the trial evidence;
  the claim's baseline is written when a read run clears the floor.
- Deferred, named: a spend ceiling; a CEL-class reference kind; `publishChart`.
