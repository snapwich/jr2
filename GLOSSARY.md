# jr2

A kit of composable pieces that a user assembles into an xstate Machine for any agentic workflow, coding or otherwise.
Agents that use a Workspace work in isolated Sandboxes, and an Orchestrator that runs the Machine coordinates them.

## Language

### Instance and distribution

**Instance**:
A user-owned folder, made by `jr2 init`, that holds its Workflows and the deployment facts that a Machine cannot carry,
such as reach and credentials. This folder is the deployed Orchestrator, and it is a deployment assembly, not a unit to
share: reusable work is published as packages.
_Avoid_: workspace (collides with Workspace), project

**jr2 CLI**:
The `jr2` binary: the primary interface to an Instance, on top of the Orchestrator's API. It is installed globally and
also in each Instance; inside an Instance, a Handoff makes the Instance's own copy the one that runs.
_Avoid_: cli tool, launcher (the global copy is the same package)

**Handoff**:
The passing of a command, unchanged, from a global jr2 CLI to the Instance's own copy when the Instance holds a
different copy; the global copy then does nothing else. Outside an Instance, or when the Instance holds the same copy,
there is no Handoff.
_Avoid_: shim, proxy, wrapper, delegate, relaunch, re-exec

**Kit version**:
The one version an Instance is: the version of the Orchestrator package that the Instance pins, which is the tag of
every Kit image it deploys, the Orchestrator's own included. The jr2 CLI that runs and the Assembly it publishes must
use that same version; two copies in one Instance are not a version but a refusal.
_Avoid_: CLI version, orchestrator version, kit release (when meaning the Instance's pin)

**Assembly**:
The Instance's Workflows, its config and what they import, as the one unit that the Orchestrator loads: what `jr2 up`
publishes to a running Orchestrator, and what a run holds for its life. The Orchestrator keeps the current Assembly,
every Assembly that a live run holds, and the one its `current` pointer names, and collects the rest.
_Avoid_: program (an executable), bundle (the staging mechanism), build, release, generation

**jr2 Application**:
An Instance under GitOps, whose manifests deploy the Orchestrator with its config and secrets. The same folder runs on
a local cluster and on a real cluster.
_Avoid_: deployment

**Assistant**:
The AI product that works for its user in an Instance folder, on the host and outside any cluster and any run: it
writes Machines, config and Sandbox Images from the docs that its Kit version bundles. It is never an Agent: an Agent
works inside a run, and an Assistant never does.
_Avoid_: agent (unqualified), coding agent (a `coder` Agent codes too), copilot, AI (unqualified)

**Console**:
The browser surface that the Orchestrator serves, where a person sees the Workflows, their runs and their Machines.
Observation needs no token; the Instance token unlocks control, so that a person can start runs and see and answer the
open Gates.
_Avoid_: visualizer (only one panel of it), dashboard, UI (unqualified), viz

**Kit image**:
An image that jr2 owns and builds, and that an Instance deploys but never authors. Kit images are the kit's second
channel of distribution, beside its packages, and they are released together with the packages, at one version.
_Avoid_: system image, base image, jr2 image (ambiguous with a Sandbox Image), instance image (retired: the
Orchestrator is a Kit image, and an Instance publishes an Assembly)

**Pinned image**:
An image that an Instance deploys but that jr2 neither owns nor builds. The kit names its exact bytes, so one Kit
version always deploys the same image.
_Avoid_: kit image (it is not jr2-owned), vendored image, third-party image, base image

### Machines and authoring

**Machine**:
The xstate state machine that defines the control flow of a workflow. It is the unit that a user writes.
_Avoid_: workflow, graph

**Workflow**:
A Machine or a Chart registered under a name in an Instance: the unit that the Orchestrator runs and that `jr2 run`
names, from one of three origins, a Machine in the Assembly, a Chart file in the Assembly, or a Chart published at run time; a named Chart is a child of its Chart wrapper, named `<wrapper>/<name>`. A Workflow is only that name, because the Machine carries all its parts, so the kit ships Machines and never
Workflows.
_Avoid_: app, pipeline

**Authoring surface**:
The names that an author writes in a Workflow's module or in an Instance's config, and nothing else. What the kit's own
packages share with each other is internal, and the Machines that the kit ships are not part of it.
_Avoid_: public API (the CLI and the HTTP API are public too), SDK, authoring API

**Orchestrator**:
The runtime that runs Machines, as the single writer of their run snapshots. Single means one writer, not one Workflow
per process: one Orchestrator hosts many Workflows and many runs.
_Avoid_: runner, engine (the loop in a Harness that runs a model)

**Run status**:
How a run of a Workflow stands, as the Orchestrator records it: `live` while it runs, then one of six ends. `done`: the
Machine got to a final state; `failed`: a Failure that no state caught ended it; `error`: the run faulted on an error or
a mechanism event that no state of the Machine handled; `cancelled`: a person ended it; `lost`: what it held in the
cluster went away under it while no Orchestrator hosted it; `drifted`: jr2 keeps it but never resumes it, because of
drift.
_Avoid_: outcome (an Effect's output), result, state (the Machine's), settlement (a Submission's), stopped (xstate's)

**Failure**:
The end that a Machine chooses for work that did not succeed, with a reason for a person. It goes up from the state that
fails, through each parent Machine, until a state catches it; when none does, the run ends `failed`. It is not a fault:
a fault is the end that nobody chose.
_Avoid_: abort and aborted (a Settlement's and the wire's), fault and error (a defect's), exception, throw, rejection

**Actor**:
An xstate actor in a Machine that drives a remote worker through a Harness: a local handle in the Orchestrator for work
that occurs remotely. An Agent is an Actor in a named slot.
_Avoid_: agent actor

**Agent**:
A configured worker, such as a coder or a reviewer: a model, instructions, Working tools and access to the Workspace.
It is a data definition that a Machine carries in a named Actor slot, so its name is the slot's name and its scope is
that Machine; a Turn can set its Dials but never its identity.
_Avoid_: role, persona, roster entry

**Dials**:
The two fields of an Agent's definition that a Machine state can set for one Turn: the model and the thinking level,
which tell how hard to run and not who runs. All other fields are identity, which only the definition sets; what a Turn
is about and where it works is its Frame, not a Dial.
_Avoid_: options, overrides, settings

**Frame**:
What a Machine state sets for one Turn that is neither identity nor a Dial: the prompt, and the root directory of the
Working tools. It belongs to the Turn and not to the definition, because a Worktree exists only after its run starts,
so no definition can name it.
_Avoid_: overrides, input (unqualified), working directory (the mechanism, not the concept)

**Turn Placement**:
The mechanism half of a Turn, stated instead of resolved: where its Harness is and which Sandbox can deliver its picks.
It is not an authoring surface: in a real run, an Agent in a Sandbox gets it from its Workspace and an Agent with no
access to the Workspace goes to the Instance Harness, so only a test tier with no Workspace states it.
_Avoid_: coordinates, connection, transport

**Vocabulary**:
The workflow events that a Machine accepts, each with a name, a payload schema and an optional audience, scoped to that
Machine alone: a nested Machine keeps its own. It is the set that a Gate's accepted events and an Agent's Menu come
from, and the set that each delivery is validated against.
_Avoid_: events (unqualified), event manifest (the retired module export), schema

**writing**:
The transitions that one state writes for one event name; one name can have several writings, on one path or on
different paths. A writing belongs to the party that its state, or the nearest state above it, invokes, and at the root
it belongs to both parties.

**Machine shape**:
The facts about a Machine that decide whether it can still read a persisted snapshot: its states, invokes and
transition targets, but not what its guards and actions do. A mismatch between a snapshot and its Machine's shape is
**drift**, as is an Assembly the run holds that the Orchestrator can no longer read (lost from the volume, published
for another Kit version, or failing to load); jr2 keeps a run with drift but never resumes it.
_Avoid_: version (a content address, not an ordering), schema

**Gate**:
A pending external input on a run, from a human or any outside system (a webhook, CI), that lives while the state that
invokes it is active. It is an addressable resource with its own accepted events, because concurrent children park at
the same time and a caller acts on one specific decision.
_Avoid_: humanGate (humans are one caller among many), approval (one possible event, not the resource)

**Sender**:
The party that delivered an event: an Agent or a Gate. Only the Orchestrator writes the Sender, on each event that a
party delivers, and the Machine's own events have none.
_Avoid_: origin, caller (the human or system behind a Gate)

**Emit**:
A message of progress or notice that a Machine's author sends from it to whoever watches the run, beside its
automatic status. It is never control: nothing consumes an Emit, and an Emit cannot drive a Machine.
_Avoid_: event (what a Gate or an Agent delivers), log (not a diagnostic)

**Effect**:
Work that a Machine does outside itself: it runs a command, calls a URL, pushes a branch or starts a run. A run that
an Effect started is **dispatched by** the run that started it, and the two are independent: an in-run child is a
nested Machine, never a dispatched run.
_Avoid_: action (xstate's word), side effect, job, task, step, operation, errand, tool; sub-run, child run, nested run,
spawned run (a dispatched run is a run of its own)

**Open**:
A part that a Machine declares but does not bind, so that its composer binds it: for example, a Repo Slot with no url,
an Agent with no model, or an Effect with no url, program or secret. It is the shape that a packaged Machine ships in,
`jr2 up` refuses an Open part that nobody bound, and a run never sees one, except an Open body, which a run binds.
_Avoid_: unset, default (an Open part has none), placeholder

**Open body**:
A body slot that a Machine declares and leaves for a run to bind with a Chart, stating the parts it lends, the Agents a
Chart may define, and the ceilings it sets. It is the one Open part that a run binds, and nothing a Chart names resolves
anywhere else.
_Avoid_: wrapper (any Machine with a body slot; the Chart wrapper is the one that declares an Open body), host,
template, sandbox

**Chart wrapper**:
A Machine that declares an Open body: the Workflow a Chart runs under, which lends the Chart its parts, allows its
Agents and sets its ceilings. A Chart never runs on its own.
_Avoid_: wrapper (unqualified: any Machine with a body slot, `workspace()` and `pool()` included), host, jig, chassis,
template, scaffold, fixture

**Chart**:
A Machine written as data alone, with no code of its own, that a run supplies to bind an Open body. Its author is an
Agent whose pick carries it; a Chart kept under a name is the same text, kept. Its states, transitions, events and
Agents are its own; every other part is one that the Open body lends it, named by its slot. It carries no url and names
no Turn's placement: the Open body places the Turns its Chart starts.
_Avoid_: dynamic workflow (a Chart under a name IS a Workflow), plan, script, template, body (the slot, not what fills it)

**Reference**:
A path lookup a Chart writes in place of data, `{{context.ticket.title}}` or `{ "$ref": "event.summary" }`, that jr2
resolves on the run's context, event or input at invoke time. A path walk and nothing else: no operator, no call.
_Avoid_: template, expression, interpolation, variable, placeholder (the `{{ }}` spelling of a reference, not the thing)

### Turns and conversations

**Turn**:
One Agent's answer to the Frame that a Machine state set for it: the prompt, the work, and the pick that ends it. It
belongs to the state that asked for it and ends when that state stops waiting; it rides on a Submission but is not one.
_Avoid_: session (a conversation spans Turns), generation, request

**Instance ID**:
The identifier of one Agent's conversation, which jr2 computes and no author names. A Turn gets a fresh one unless it
continues, and one Agent has one continued conversation per Machine instance, which every state of that Machine may
continue until jr2 faults that conversation.
_Avoid_: conversation id, session id, conversation pin, scope

**Turn ID**:
The identifier of one Turn, which jr2 mints through its input mapper when a Machine state invokes the Agent and no
author names. Two Turns that
continue one conversation share an Instance ID and never a Turn ID, so a restore can tell which Turn an admission
belongs to.
_Avoid_: invocation id, run id (a run is a Machine instance), submission id (a Turn can ride several Submissions)

**Submission**:
One admitted prompt on a conversation: the Harness's unit of work. A Turn rides on a Submission, and a conversation,
which an Instance ID names, spans many Submissions.
_Avoid_: request, job

**Admission**:
The Harness's acceptance of a Submission, which the Orchestrator keeps as the coordinate it re-attaches by after a
restart.
_Avoid_: handle, ticket

**Settlement**:
How a Submission ends. It is one of four: completed, ended, failed or aborted. Completed: its run returned, and its
Turn is still open. Failed: the Harness could not run it to its end, as on a provider error, a Runaway or a restart
of the Harness. Ended: the Turn's own pick ended the Turn, from this Submission or from an earlier one of the same
Turn. Aborted: something else ended the Turn, or it was over before it started. The Orchestrator judges how a Turn
ended, and the Turn's sweep says it. It is what the history view reports for each Submission.
_Avoid_: result, status

**Sweep**:
The Turn's sweep: the Orchestrator's end of an Agent's Submissions when the state that asked for the Turn stops
waiting. It settles the running Submission and every one queued behind it. It says how the Turn ended: by the Turn's
own pick, or by something else. Two other sweeps are not this one: the image sweep of `jr2 up` (ADR-0039,
"swept N image(s)"), and the Repo sweep of `jr2 gc` (ADR-0051).
_Avoid_: abort (the wire's route, not the act), cancel (the end of a run)

**Runaway**:
A Turn that will not end on its own, which the Harness ends when the Turn runs past the point where jr2 stops believing
it will end. It is a fault class, named for what jr2 observed and not for what the model did.
_Avoid_: degeneration (the model behavior, not the fault class), loop, hang, stall

**step**:
One tool call of a model answer that the engine starts while a Turn is live, whether or not it runs: a call of a
Working tool or a pick, a call of an unknown tool or with invalid arguments, a pick that the Harness blocks as the
second pick of its model answer, each call of a model answer that hit the output limit, and the call that trips the
Runaway watch. A call after a pick that ended the Turn is not a step. The Harness counts steps to find a Runaway. A
**step boundary** is the point after a model answer and the results of all its calls, and before the next model
request; there the Harness can restate the Turn part.
_Avoid_: turn (a Turn is the Agent's whole answer to its Frame), round, iteration, request

**Compaction**:
The cut that the Harness makes in a conversation's model context during a Turn: a summary plus a retained tail replaces
the earlier context. jr2 alone decides when it occurs, and it changes what the model sees, never what jr2
recorded.
_Avoid_: summarization (one part of a Compaction), truncation (the failure that Compaction prevents), pruning

**Menu**:
The workflow events that an Agent can ever be offered in its Machine, which do not change for the life of a
conversation. It is what the Agent may say, as its Working tools are what it may do; the part that one Turn may pick now
is its Allowed picks.
_Avoid_: tools (unqualified), tool list

**Allowed picks**:
The part of the Menu that one Turn may pick now: the picks that the live Machine would accept from this Agent at this
moment. They follow the active mode and the guards, and they are empty while the invoking state is not at Rest.
_Avoid_: menu (the fixed set), open picks, active tools, legal moves

**mode**:
A child state of an Agent's state that invokes nothing. The Agent is at Rest there, with a different set of Allowed
picks.
_Avoid_: substate, phase

**Rest**:
The condition of an Agent's state in which a pick is answered: no state below it runs something, and no pending timer
will move the Machine to another state inside it. jr2 reads it from the Machine, and it is not a state.
_Avoid_: idle, the rest state (a state named rest means nothing to jr2)

**outstanding**:
A pick that is delivered and not yet answered.
_Avoid_: held pick (collides with Held secret), pending

**Chain**:
Every reply since a pick, oldest first, each one a **link**: a child's output, or an event of the Machine's that a party
below the Agent's state delivered, such as a Gate's answer or a nested Agent's pick. An event that the Machine sends
itself and a child's error are not links, and the last link is the pick's default answer.
_Avoid_: history (the view of Settlements), log

**Briefing**:
jr2's own text to the model: the facts about the Agent's seat and the mechanism that a correct Agent needs and cannot
find out for itself, and nothing about the task. It has a standing part, the same on every Turn, and a Turn part after
the Frame's prompt that carries the Allowed picks, any **notices**, and a **pick's briefing** for an Allowed pick whose
parameter needs one (a Chart).
_Avoid_: system prompt (the Turn part is not in it), preamble, header, instructions (identity's word), nudge (a
re-prompt of an open Turn)

**Working tools**:
The file and shell tools that the Harness runs in its own container: what an Agent may do, as its Menu is what it may
say. The Agent's access to the Workspace decides which of them it gets, and a Menu-only Agent gets none.
_Avoid_: tools (unqualified), sandbox tools

### Sandboxes, Harnesses and secrets

**Sandbox**:
The isolated pod in which an Agent works, with a filesystem of its own. Agents in different Sandboxes share no host
resources: no ports, no filesystem, no process space.
_Avoid_: worker pod, container

**Harness**:
jr2's own long-running server that hosts the conversations of Agents and executes their Working tools, in every Sandbox
and once per Instance as the Instance Harness. It holds no Agent of its own: each Submission carries the definition
that it runs.
_Avoid_: flue agent, server, `local()`

**engine**:
The loop in a Harness that runs a model's requests and the tool calls of each model answer, for one conversation. The
Harness can replace it: the engine is not the Harness's contract. What the engine keeps of a conversation is its
**engine part**, in a folder that the engine names, which jr2's record does not read.
_Avoid_: runtime, runner, agent loop, harness (the server that holds the engine), Orchestrator

**Instance Harness**:
The one Harness of an Instance that is in no Sandbox: the Turns of every Menu-only Agent run on it, also when a
Workspace encloses that Agent. Its pod has a Custodian and no Worktree, and it keeps a conversation only while a live
run holds it.
_Avoid_: shared harness, global harness, dev harness

**Custodian**:
The jr2-composed container in every Harness pod, a Sandbox or the Instance Harness, that holds the pod's Held secrets
and carries the Harness's traffic out. The Agent executes no code in it, and it controls no egress: a client that goes
around it sends only a Stand-in.
_Avoid_: proxy (the mechanism, and the Handoff's word), sidecar (its deployment shape), MITM, vault, egress gateway,
firewall

**Held secret**:
A credential that the Harness uses through its pod's Custodian but never holds: a model API key above all, and the
Sandbox token. The Harness holds only its Stand-in, so the Agent cannot take the secret out of the pod, but it can spend
it through the Custodian while the pod lives.
_Avoid_: masked secret, injected secret, proxied key, secret (unqualified)

**Stand-in**:
The public value that the Harness holds in place of a Held secret. It means something only to the Custodian, and only
toward a host that the secret is bound to; sent anywhere else, it arrives as it left.
_Avoid_: placeholder (an Open part's word), dummy key, fake key, token, mask

**Check pod**:
The one-shot pod in which the provider preflight of `jr2 up` checks the models of one class of Harness pod, before the
converge writes an object that the Instance reads. It has a Custodian, its own copies of the objects that it reads, and
labels that no Harness pod has. Its check container calls each model as a Turn calls it. The preflight is the step of
`jr2 up`, and a check is what the check container does for one model: one call, and at most a second one after an
answer in text. `jr2 check` is not this check: it runs the typecheck and the Machine walk of `jr2 up`, with no pod and no
cluster.
_Avoid_: probe, probe pod, preflight pod, test pod, Harness (it runs none)

**Effector**:
The container where jr2's own process runs a Machine's Effects and holds their secrets, and where the Agent executes
nothing: a Sandbox Effector or the Instance Effector. Every Effect runs in it except a command that names no secret,
which runs beside the Agent, and a dispatch that names no target, which runs in the Orchestrator's own process; a
command that runs in it sees a pinned commit, never the live Worktree.
_Avoid_: Courier, Actuator, Clerk, machine container, tool image

**Sandbox Effector**:
The Effector as a container in a Sandbox pod, present only when a Machine needs it, that can read the Worktree but not
write it. It runs a branch push, an Effect that calls a URL with a Worktree file as its body, and a command that names
an Effect secret.
_Avoid_: sidecar, worker, runner

**Instance Effector**:
The Effector as a stateless pod of its own, one per Instance, for an Effect that calls a URL and reads no Worktree file,
and for a dispatch that starts a run on another Orchestrator.
_Avoid_: sidecar, worker, runner

**Effect secret**:
A secret as an Effect uses it: the real value, in an Effector. It is a placement, not a kind: one secret is a Held
secret where an Agent's pod names it and an Effect secret where an Effect names it, and it can be both.
_Avoid_: secret (unqualified), injected secret

**Sandbox Image**:
The user-owned image that a Sandbox's Harness runs in: the tools that the Agent's Working tools can reach, and the shell
that a human gets where the Harness runs. A Workspace names it as a fact of its Machine, built by `jr2 up` or brought
from a registry, and it carries no part of jr2.
_Avoid_: workspace image (a Workspace is a Machine; the image is the pod's), agent image, harness image (the kit's own),
toolchain

**Sandbox node**:
A node that an Instance's Sandboxes may be placed on: every node where an ordinary pod lands, unless the Instance
selects otherwise, and no node needs a jr2 label. The set moves as nodes come and go, and the node caches of Repos are
kept on exactly these nodes.
_Avoid_: worker, candidate node, eligible node, data-plane node, schedulable node (the wider set that build platforms
are read from)

**Size**:
The ceiling of memory and CPU, and nothing else, that a Workspace states for its whole Sandbox and that jr2 reserves in
full. It is a fact of the Machine, never of a run: a composer can change it, and an Instance only sets the default for a
Workspace that states none.
_Avoid_: resources, requests, limits (the pod fields it becomes), class (a placement word), quota (the cluster owner's
cap)

**User Container**:
The optional third container in a Sandbox pod: a user-owned image, named by the Workspace like the Sandbox Image, that
runs its own entrypoint and shares the pod's checkouts and ports. It is the zero-contract seat for unattended services
and for sessions whose credentials the Agent must not reach: jr2 puts nothing in its process and never commands or
probes it.
_Avoid_: sidecar (its deployment shape), debug container (a one-off attach, not a seat), dev container

### Work, Workspaces and Repos

**Source**:
The port from which a Pool gets its work items. A queue, a generator or a re-queried set can be a Source, and a Work
Source is one Source adapter.
_Avoid_: queue (one possible backing, and not FIFO), feed

**Pool**:
The Machine that the kit supplies to run one worker Machine for each Source item, with a limit on how many run at the
same time.
_Avoid_: scheduler, work loop

**Work Source**:
The Source adapter for tickets, modeled as a set of behaviors and not as one common data schema. It owns the dependency
graph of its items and gives out the Ready-set, so the Machine never encodes a dependency edge.
_Avoid_: ticket system, backend

**Ready-set**:
The work items that a Work Source can give out now: the items that nothing blocks, in dependency order. It changes
during a run, so it is not a fixed queue.
_Avoid_: queue, backlog (all the items; the Ready-set is the unblocked part)

**Workspace**:
A long-lived Sandbox bound to one unit of work, modeled as a child Machine that wraps the author's body Machine. A coder
Agent and a reviewer Agent of that unit of work share one Workspace, so a Workspace is per unit of work and not per
Agent run.
_Avoid_: workspace pod

**Placing**:
The Workspace state in which its Sandbox waits, with no deadline, for capacity: a node, or room under the cluster
owner's quota.
_Avoid_: pending (a Pod phase, and the Gate's word), queued, parked (a Gate's), admission (the Harness's)

**Lease**:
The assertion that a Workspace is still wanted, renewed for the whole life of its Sandbox; a Sandbox whose Lease lapses
can be reaped as abandoned. It only asserts: the run learns nothing about Continuity from the Lease.
_Avoid_: heartbeat (the timer it replaced), keepalive (the annotation, not the concept)

**Continuity**:
Whether a Workspace is still the one that its body Machine attached to. It is not existence: a Sandbox can still exist
after its clones, Worktrees and unpushed commits are gone.
_Avoid_: liveness (what the Lease asserts), health (a probe concept, about serving)

**Repo**:
A git repository, identified by the host and path of its url, so urls that differ only in scheme, user or a `.git`
suffix are one Repo. A Machine names a Repo only through a Repo Slot: a Repo has no name, and a user declares no catalog
of Repos.
_Avoid_: project, source, remote, catalog entry, repo name

**Repo Slot**:
The Machine's own name for one Repo that its Workspace attaches. The Machine binds it, leaves it Open, or binds it from
each run's input; jr2 gives it no meaning.
_Avoid_: role, alias, repo name, workdir, primary repo

**Binding**:
What a Repo Slot resolves to: a Repo's url and an optional base from which the Worktree is cut. With no base, the
Worktree is cut from the Repo's own default branch.
_Avoid_: config, catalog entry

**Project layout**:
The convention for the checkouts in a Sandbox: under each Repo Slot, the Sandbox's own clone of the Repo, with the
Worktrees beside it. The node's cache of the Repo is not part of the layout.
_Avoid_: directory structure, repo tree

**Worktree**:
A git worktree of a Repo Slot for the one branch that its Workspace works on, beside the Sandbox's own clone. Its work
is sequential commits on that branch, not separate worktrees; the Machine, not jr2, chooses the branch and its scope.
_Avoid_: per-task worktree, task branch
