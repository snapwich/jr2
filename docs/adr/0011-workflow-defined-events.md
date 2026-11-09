# Control events are workflow-defined and delivered by closure, not routed

Two decisions, out of the jr-parity design exercise: **jr2 ships the event mechanism and zero events**, and **an event
binds to a Machine state through the actor that exposes it** — delivery is a closure created at invoke time, so no
routing layer exists anywhere.

## `defineEvent`: mechanism, not policy

`defineEvent({ name, input, audience?, semantics? })` produces a pure-data definition: a name, a zod input schema (flat
tagged objects, never `oneOf` — the ADR-0006 encoding rule), an optional audience tag (`agent` | `external` | `any`;
unset, each writing of the event belongs to the party its state, or the nearest state above it, invokes — ADR-0015), and
an optional semantics tag (`ack`, or the reserved `poll`; a def declares no output — ADR-0006). It is a **pure factory —
no import-time side effects, no global registry**. Because actor **inputs are serializable** (ADR-0007) they carry event
_names_, so resolution needs a name→def scope; that scope is **per-Machine**: `jr2Setup` takes the defs as values and
attaches the vocabulary to the machine (ADR-0015 — discovery reads it there; the module contract is
`export const machine` alone), and `gate`/`agentRun` resolve names against **the Machine that invoked them** —
`self._parent.logic`, public xstate API — never a run-wide set. Names are local to their Machine: `coding`'s `approve`
and `release`'s `approve` may differ, and one run may hold both, because a Machine nested inside another resolves
against its own defs and no map is ever merged. That is what makes a Machine composable by plain `invoke` (ADR-0049):
the importing Machine neither re-declares nor sees the nested one's events, and `workspace()`/`pool()` propagate
nothing. An unlisted name fails at invoke time with an error naming the Machine and its declared set. The attachment is
keyed on the machine's `config`, which xstate's `.provide()` passes through unchanged, so the host's per-run provide and
a test's `.provide()` both keep it. We rejected a global name registry (import = registration): it couples every
workflow in an instance — and any future npm-distributed one — through one namespace, and attribution can't be inferred
at import time. We also retired the run-scoped set this ADR first specified (`RunBinding.events`, the root's
vocabulary): it made every nested Machine's events the root's problem to re-declare, and turned a
same-name-different-payload pair into a collision that the per-Machine defs had already avoided.

`defineEvent` also carries the TypeScript side: `jr2Setup` derives the machine's event union from the defs — one source
of truth, no schema/type drift, and the machine stays fully typed for xstate tooling.

A def's `input` is what its sender supplies, and nothing the Machine adds. Where a pick starts work,
`fromPick(def, fill)` carries those params into the invoked Effect's input by name, and `fill` adds the Machine's part;
the load walk refuses a param nothing reads and a `fill` that overwrites one (ADR-0067, ADR-0015).

There is no jr2-blessed event vocabulary. `request_review`, `review_verdict`, `approve` are the _coding workflow's_
words; another workflow defines others. jr2 owns only definition, transport, validation, and delivery.

## Agent side: invoke-scoped registration, delivery via `sendBack`

On start, the `agentRun` actor registers, for its instance id, a toolset — the menu derived from its invoking state's
transitions (ADR-0015) — whose handlers **close over that invocation's `sendBack`**; on stop it deregisters. A tool call
→ validate against the named schema → `sendBack` a typed event, plus its sender → the event lands on **the state that
invoked the agent** (bubbling to ancestor states per statechart semantics — a machine can handle a
`report_blocked`-style event once at its root). The binding _is_ the closure.

- **No routing.** There is no instance→actor table and no workflow-side forwarding boilerplate; delivery works at any
  nesting depth (workspace wrappers, pool children) with zero authored code.
- **State-scoped menus for free.** A transition swaps actors, which swaps registrations; the surface an Agent sees is
  exactly the live registration.
- **One catch point.** A call for an unregistered iid (settled run, exited state) is rejected at the demux.

**Transport: the Agent's registration is read from the Sandbox** (ADR-0013). The Orchestrator speaks no MCP: it serves
`GET /agents/:iid/surface` + `POST /agents/:iid/events` under the Sandbox token, and the pod's Harness reads them
through the Custodian on `localhost`, which holds the token, and presents the surface to its model as the Menu (the
Harness re-reads per Submission, so the iid in the path is all the addressing needed). Lookup, validation, delivery, and
lifecycle stay implemented once, in the registration table.

## External side: the same primitive over HTTP (`gate`), and each gate is a resource

`gate` is the symmetric actor for **every non-agent caller** — humans (`jr2 send`, the Console), a Hook, CI, other
systems. "Human" is policy, not mechanism, so the actor is not named for one caller. Each invocation is an addressable
**gate**: input is `{ gate?, meta? }` — `gate` an optional authored id (the id is derived when absent — below), `meta`
serializable caller/integration context (PR URL, title); its accepted set derives from the gated state's transitions,
its ancestors' and its plain children's (ADR-0015). Registration is per-gate: `GET /runs/:runId` lists open gates
(`{ gate, accepts (names + schemas), acceptsNow, meta }` — `acceptsNow` the names the run would take from this Gate now,
read the way an Agent's Allowed picks are, ADR-0029), `POST /runs/:runId/gates/:gate/events` validates the body against
the named schema and delivers via `sendBack` into the gated state — or refuses a send the run would not take (ADR-0013)
— and leaving the state destroys the gate. Gate ids are **run-scoped by mechanism** (the same `system`→run mapping that
scopes event resolution), so `gate: "F-12"` in two concurrent runs cannot collide.

Gate-as-resource is forced by concurrency: several children park simultaneously (three features in `humanReview` is the
_normal_ case), all accepting `approve` — a run-level POST is ambiguous. And every real external surface already thinks
in gates: a CLI listing shows pending decisions and acts on one; a UI inbox renders one card per gate (schemas drive the
forms, `meta` drives the copy); a hooked Gate's own handler matches a forge's delivery against its `meta` (e.g. `pr`,
below), which is why `meta` exists. Generalizing beyond humans also closes a hole hard-coded event types left: a push
seam like "a Hook brings an item" is a Pool's `source` Gate ([ADR-0017](0017-pool-over-a-source-port.md)). The cross-run
inbox is `GET /gates`: the open Gates of every live run that the Caller may answer, oldest first, with a `workflow`
filter, each entry `{ runId, workflow, gate, path, accepts, acceptsNow, meta, openedAt, hook? }` (`hook` names the Hook
kinds that the Gate hears, when it hears one) and never the run's `context`
([ADR-0014](0014-observation-is-open-run-state-is-not.md)). A Gate that takes no event from a Caller, as a Pool's
`source` Gate that hears only Hooks, is not in it: no person can answer it. `jr2 gates [--workflow]` prints it, and the
Console's Gate cards read it. A stream of it is a later addition. CLI segment-matching over derived gate ids
(`--gate F-12` resolving an unambiguous segment, git-style like run-id prefixes) is deferred.

**The `answer` scope can name single Gates**, in the form of
[ADR-0078](0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md). It names a Gate by its invoke
id, the one static name a Gate has in the Machine that invokes it, and the id that its events carry as their sender
(below): the invoke `id` that the author wrote, or else the key path of its gated state below the root of that Machine
(`body.humanReview`), with `.0`, `.1` after it when that state invokes more than one unnamed Gate. So `body.humanReview`
names that Gate in every child of a Pool, and two gated states with one key at two paths of one Machine have two names.
The name is not unique across the Workflow: a Workflow composes Machines by invoke
([ADR-0049](0049-a-machine-carries-its-parts-and-composes-by-invoke.md)), and two composed Machines that each gate a
state `approve` give that name to two Gates. One per-Gate name covers every Gate of the Workflow that has that invoke
id, and `jr2 up` refuses a per-Gate name that matches Gates in more than one Machine of the Workflow, so a scope never
opens a Gate that its author did not see; the author writes an invoke `id` on one of them to tell them apart. It is not
the caller-facing gate id, which is different in each child and which a workflow may compute.

**The gate id is derived; authoring one is the exception.** Absent an authored `gate`, the id is the gate actor's own
path below the run root, and jr2Setup's menu-derivation walk names an unnamed gate invoke with its state key path so the
leaf segment is readable — `F-12.body.humanReview`, not xstate's `0.body.humanReview` default. This is unique wherever
concurrently live siblings have distinct actor ids — the invariant any correct fan-out already maintains, because xstate
keys children by id (a duplicate silently shadows the children-map entry and breaks `xstate.done.actor.<id>`
correlation). Authored ids exist for meaningful flat names (jr's feature id) and collision on them is a loud invoke-time
error. Derivation runs at actor start, not the input mapper — deterministic from structure, so recomputation on every
(re)start is restore-stable, and one mechanism serves jr2Setup and plain-`setup` machines alike (the walk contributes id
_quality_ only, never correctness). Rejected: a workflow-computed id as the default (`gate: context.feature.id`) — it
quietly violated the address doctrine (Consequences below), making the gate id the one caller-facing address a workflow
computed by hand, and a machine with a static id (`"humanReview"`) was correct standalone but a latent, timing-dependent
collision once composed under a pool, firing only when two children park concurrently. Also rejected: deriving only in
the walk (a second dialect and an error case for plain-setup callers), and xstate's default invoke ids as the name
(invoke-index noise no caller cares about).

The full symmetry: **agents deliver through their per-iid registration (via the Custodian); everything else delivers
over HTTP (per-gate registration).** Two dialects, one primitive, zero routing. Internally that is literal structure:
one registration table (`address → { accepted event defs, deliver closure, meta, sender }`) that `agentRun` and `gate`
register into, with the agent surface and the gates HTTP API as dialect adapters over it — a future caller class (a
Slack bridge, an email reply) is another adapter, not a third mechanism. The table is implementation structure, not
vocabulary — workflows speak only `defineEvent` / `agentRun` / `gate`.

**Every delivered event carries its sender.** The table writes `sender: { party: "agent" | "gate", id }` on each event
it delivers, after the schema parse and from the registration alone: `id` is the Agent's slot, or the Gate's invoke id
(static in the Machine, the same after a restore — not the caller-facing gate id, which a workflow may compute). A
Gate's event also carries the **Caller** that answered it
([ADR-0078](0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md)): `via`, `name` and
`onBehalfOf`, with `checked` naming the fields that jr2 verified. `via` and `name` are always checked, because an
authenticator made them; `onBehalfOf` is checked only for a Hook, whose signature covers the payload it comes from. The
run records the same Caller as the answer's `answeredBy`. An event that a Gate's `look` gives (below) has the Gate as
its Sender and no Caller. The Sender is plain data on the event, so it rides the mailbox, a delayed event the run host
persists beside the snapshot, and a restore; a restored registration writes it again from the persisted input and the
invoke id. The Machine's own events (`raise`, `sendTo` itself) carry none. `defineEvent` refuses an input that declares
`sender`, and both surfaces refuse a body that carries it (ADR-0013): no caller and no def can write it. What an author
does with it is ADR-0015's.

`CANCEL` stays reserved as the run-level infra interrupt. jr's "exit 3 and let the human drive the bash script" becomes
"park in a durable state that advertises its human surface."

## A Gate hears a Hook, and looks before it waits

A Hook ([ADR-0078](0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md)) is a door for one
outside service. Its delivery is not an event of any Machine: a Gate makes one of it, or ignores it. So a hooked Gate is
an extension of the Gate, not a second concept. It has the same derived id, accepted set, Sender, Console card and
`jr2 send` path as any Gate. The Hook checks the delivery and decides nothing; only a Gate's handler or its look makes
an event for a run.

- **A Gate slot declares what it hears.** `actors: { review: gate({ meta, delivers, hooks, look, reply }) }`, and the
  state invokes it by its key:
  `invoke: { src: "review", input: ({ context }) => ({ meta: { pr: context.pr, sha: context.sha } }) }`. A plain Gate
  stays `src: "gate"`. `meta` is a zod schema of the meta that the invoking state sets. The Gate checks the meta when it
  opens, and the handlers and the look read it typed. It is a schema and not a type argument, because TypeScript does
  not infer `delivers` when an author names one type argument.
- **`delivers` lists the events that the handlers and the look can give.** The load walk refuses one that is not in the
  Gate's derived accepted set. The Chart door refuses one that is not in the Chart's Vocabulary
  ([ADR-0070](0070-a-machine-lends-its-parts-to-a-chart.md)). An event in `delivers` is `audience: "external"` unless
  its def sets an audience, so an Agent below the Gate never has it on its Menu, and the author does not have to know
  this ([ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md)). This default can change what a Menu shows, so the
  change that builds it runs the `@model` tier
  ([ADR-0066](0066-a-model-tier-runs-a-real-model-and-a-change-to-what-it-reads-runs-the-tier.md)).
- **A handler for each Hook kind and event key.** `hooks: { github: { "pull_request_review.submitted": handler } }`. The
  key is the kind's id and the event key that the kind reads from the delivery (ADR-0078), never a Hook's name: two
  Hooks of one kind (two organizations, two secrets) reach the same handlers. The table is typed at compile time: each
  kind module that the program imports adds its id and its payload types to `interface HookKinds` by declaration
  merging, and a key that no kind in scope gives does not compile. There is no registry at run time: the door matches a
  delivery by the kind's id and the event key, exactly. A kind's schema key can end in `.*` (`"block_actions.*"`) to
  type each key with that prefix, but a handler names the full key (`"block_actions.approve"`): a handler key that holds
  `*` does not compile, and `gate()` and `source()` refuse it, so the load walk refuses its Workflow. No handler hears a
  handshake. A handler reads `{ payload, meta, caller }`, where `payload` is the decoded body after the kind's schema
  parsed it (below). Its type is the schema's output, so a handler reads only the fields that the schema names. It is
  pure and synchronous, as a guard is: no I/O, no Promise, no clock. It matches the payload against the Gate's `meta`
  (for a review, the PR's url and the pushed commit) and gives one plain event of `delivers`, such as
  `{ type: "approve", by }`, typed by that list, or `undefined` to ignore the delivery. The Orchestrator parses the
  event with its def's schema and asks the run whether it takes it from this Gate now, as it does for `jr2 send`
  (ADR-0013). There are no correlation keys: each delivery calls every open handler of its kind and event key.
- **A look reads the fact that the Gate waits for.** `look: { read, input, every?, until }`. `read` is an `http` Effect
  marked `idempotent: true`, or a promise actor, which a Machine can invoke anyway; `gate()` refuses another Effect
  ([ADR-0067](0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md)). The promise is for
  the default test tier, which has no Instance Effector, and for a fact inside the Instance. A read of a service outside
  the Instance is an `http` read, because the Orchestrator makes no call out of the Instance for a run. The read is a
  child of the Gate in the run's actor system, so an `http` read goes through the run's Instance Effector and its
  ledger, and `jr2 up` places it as it places an Effect slot. The look runs once after the Gate registers: a change
  before the read is in its answer, and a change after the Gate registered reaches the Gate as a delivery. It runs again
  after each restore, and every `every` (10 minutes by default) while the Gate is open. `until` gives an event of
  `delivers`, or `undefined` for "not yet". So a delivery that came before the Gate opened, a delivery lost while the
  Orchestrator was down, and a restart all come to the same read, and the author writes no idiom for them. The run takes
  a looked event only when it takes it from this Gate now, as for `jr2 send`. A read that fails, an `until` that throws,
  and an event that the run does not take now are each a line in the Orchestrator's log, and the look reads again at the
  next `every`: a look never faults the run. A looked event has the Gate as its Sender and no `answeredBy`: the look is
  the Machine's own read, not a Caller. The per-run feed marks it `looked`, behind the token as a Turn marker is, before
  the delivery, because a delivery can end the run in its own send. The look stops after the run takes its event, until
  the Gate opens again, because a look reads a level: a Gate that stays open after its event would get the same event
  every `every`. So a state that goes back to its own Gate must change the `meta` (a new `sha`), or it loops. A restore
  opens the Gate again, so a Gate that stayed open after its event looks one more time after a restore.
- **`look: "none"` for a Gate that hears a command.** A `/retry` comment is an edge, not a level, so there is no fact to
  read. A lost delivery of a command stays lost.
- **`jr2 up` warns about a hooked Gate with no look and no `after` on its state**, and does not refuse: a delivery lost
  in an outage then stops the run until a person answers the Gate. The fix is one line, a look or `look: "none"`.
- **A bad delivery marks the feed and never faults the run.** A handler that throws, an event that is not in `delivers`,
  and an event that the run does not take now each put a `hook-refused` mark on the run's feed and a line in the
  answer's `refused`. The run goes on. A refusal that the author wants the person to read is a throw in the handler,
  with the reason as its message.
- **`reply` gives the text that the person who acted reads**, for a kind whose answer a person reads (`slack`,
  `discord`; not `github`, and not a Slack event). `reply(outcome, { meta, caller })` is pure and synchronous, as a
  handler is. `outcome` is that Gate's own: `delivered` with the event, or `refused` with the reason. It gives plain
  text or `undefined`, never a service's JSON, and the kind escapes the text and puts it in its envelope (below). It
  runs after the run answers, because only then is `refused` known, so the text is not in the handler's return. A Gate
  whose handler gave `undefined` was not a target, and its `reply` does not run: a click on one message does not make
  the other open Gates of that key speak. A throw gives no text, and the hook log keeps the error. Only the person who
  acted sees the text. A message that everyone sees is a change of shared state, so it is an Effect of the Machine. So
  is the reply after the work: a plain `http` Effect with a bot token, such as Slack's `chat.postMessage`, never the
  delivery's `response_url`, which takes 5 posts in 30 minutes.
- **A packaged Machine writes its handlers and leaves its look Open.** A forge's payload is public, so a package writes
  the handlers for each forge that it supports, and handlers are never Open. It imports the kinds that it hears, so
  their payload types are in scope where it is compiled. A look needs a url and a token, so a package leaves
  `look: open` ([ADR-0054](0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md)). The composer
  binds it with `customize(m, { gates: { review: { look, hooks } } })`, which also adds or replaces a handler by kind
  and event key; `null` removes one. An Open look that nobody binds gets the warning above, not a refusal, so a person
  can still answer the Gate with `jr2 send`. A forge part gives the handlers and the look for one fact (a review
  verdict, CI on a commit). It takes event defs and secrets, never a Hook's name, and each verdict compares the commit,
  not only the PR. It types its handlers by the kind's schemas, so a field that it reads is a field that the kind
  parses.
- **A parked run keeps the handlers, the look and the `reply` of the Assembly that it holds**
  ([ADR-0069](0069-the-orchestrator-is-a-kit-image-and-an-instance-publishes-its-assembly.md)): they are code in the
  Assembly, and the Gate's input stays data, so a restore registers the Gate again as before.

## The Hook's door

- **`POST /hooks/:name`.** Each Hook that `jr2.config.ts` declares has one stable address, which a service is set up
  with once. The Hook's verifier authenticates the route, outside the bands of ADR-0014 (ADR-0078). A delivery that
  fails it, or whose signed timestamp is more than 300 seconds from the door's clock, gets 401, and nothing else
  happens. The window is jr2's, the same for every kind. A name that the current config does not declare gets 404. With
  no current Assembly the door answers 503 before the verifier, because no config says which Hooks exist. A body above 2
  MiB gets 413, after the name and before the verifier. The door reads no more of the body than the limit, because this
  is the one route with no bearer token that takes a body, and a `mac` check sends the body to the Instance Effector as
  base64, which its wire limits to 4 MiB. Without the limit, a large delivery that is correctly signed would get a
  false 503. The hook log keeps a `too-large` line, which claims no delivery id. A `mac` check that the Instance
  Effector cannot answer (none is deployed, or no replica answers) is 503 too, so the service can send again: the
  Orchestrator holds no secret to check with
  ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)).
- **The kind's handshake comes after the verifier.** A Slack `url_verification` gets `{ "challenge": … }`, and a Discord
  `PING` gets `{ "type": 1 }`. A handshake reaches no handler, and the hook log keeps it as `handshake`. A request that
  the kind cannot read (its `read` throws, or gives no id or no event key) gets 400, and the hook log keeps the error as
  `unreadable`.
- **The door parses the payload before the fan-out.** A Hook kind gives a zod schema for each event key, and the door
  parses the decoded body with the schema of the delivery's key. Each object in a schema is a loose object, and a schema
  names only the fields that handlers need. So a field that the service adds breaks nothing, and a named field that is
  missing or of the wrong type fails the parse. A failed parse reaches no handler. The hook log keeps a
  `payload-refused` line with zod's issues, and the answer names the kind and the event key in
  `payloadRefused: { kind, key, issues }`. The status is 200, because a second try fails the same way. A key that the
  kind gives no schema for is not parsed, and it reaches nothing, because no handler can hear it.
- **A repeat is found by the delivery id AND the body's digest.** A delivery whose id or digest the hook log holds gets
  200 with `seen: true`, and nothing is delivered. The check is for each Hook, because two Hooks can get one body (an
  organization's webhook and a repository's). Only a delivery that the door claimed counts: a handshake, a
  `payload-refused` line, an `unreadable` line, a `hold-full` line (a 429, below) and a `no-live-run` line (a 503,
  below) never make a repeat, so a refused payload that comes again is parsed again, and a delivery that every Source
  was too full to hold is heard again. The check and the claim are one synchronous step, so of two copies that come at
  once, one is delivered. A service may or may not send a delivery again; the design depends on neither, because the
  look finds what a lost delivery said.
- **The fan-in reaches open Gates only.** A delivery goes to every open Gate, in every live run of a Workflow that the
  Hook may answer, whose handlers hear its kind and event key, and to nothing else. A Pool's `source` Gate is one of
  them ([ADR-0017](0017-pool-over-a-source-port.md)). So a Hook answers a Gate of a run, or brings items to a Source. It
  never starts a run, and it never names one.
- **The answer is the outcome.** 200 with
  `{ delivery, seen, delivered: [{ run, workflow, gate, event }], refused: [{ run, gate, event?, reason }], ignored, sources, payloadRefused? }`:
  `ignored` counts the open Gates whose handler gave nothing, and `sources` holds each Source's verdict (ADR-0017). A
  delivery that reached nothing gets 200 with `delivered: []`. After the verifier, the fan-out always runs first. Then
  the answer is 429 when every Source's verdict is `hold-full`, and 503 only in two cases: a standing Pool that hears
  this kind and event key has no live run and is not paused, or the delivery followed a standing Pool's hand-overs to
  the new run's Source 3 times and the Pool handed its run over again (ADR-0017). In the second case the Pool can have a
  live run: the delivery stops following it, so that it cannot follow without end. Neither 503 claims the delivery's id,
  so the service's send again is heard. The 503s that come before the verifier are in the door's rule above. So a Pool
  in back-off does not stop the review Gates of other runs. This is the answer of a kind whose answer no person reads: a
  forge, or a Slack event, which keeps its 429 and 503 so that Slack sends it again.
- **A person reads the answer to a chat command or click.** For a Slack command or click and a Discord interaction, the
  kind's envelope takes the place of the outcome, and the hook log keeps the outcome. The text joins the `reply` of
  every target: Sources first (what the act brought), then Gates (what the act answered), and in each by Workflow name,
  then by run id. Empty texts and exact repeats are dropped. A text from a `skipped` verdict shows only when no other
  target gave a text, because a skip says "not for me". Every target speaks, and not one winner, because the outcome is
  already a list and the load walk cannot see which Gates will be open. When no target gives a text, the door writes one
  from the outcome: a repeat, a delivery that reached nothing, a payload that the parse refused, or what the fan-in did
  (a Gate that took an event, a Pool that is paused). For a 429 or a 503 of the fan-in, the door adds a line with the
  cause after the targets' texts, so the text always says why. This text is the same for every service, so the kind
  never sees the outcome. A paused Pool has no run, so no `reply` of it runs: the door's text says that it is paused.
  The 503s and the 404 that come before the verifier stay as they are, because the door cannot know who reads the answer
  before the kind reads a verified request. The door cuts the text to the limit that the kind gives (Discord: 2000
  characters), and the kind puts it in its envelope. The envelope shows the text to the person who acted, and to nobody
  else: Slack `{ "response_type": "ephemeral", "text": … }`, Discord
  `{ "type": 4, "data": { "content": …, "flags": 64 } }`. The text is plain: no Block Kit blocks, no Discord embeds and
  no `in_channel` in v1. A rich reply adds later without a break.
- **Such an answer is 200.** Where the rules above give 429 or 503, a delivery whose answer a person reads gets 200, and
  its text says why. A non-200 shows the person the service's own error, which says nothing about what jr2 did. The hook
  log keeps the status that the rules give. A failed verifier stays 401.
- **The reply to a Slack click goes to its `response_url`.** Slack shows no text from the answer to a Block Kit click:
  that answer can only be an empty 200. So the `slack` kind's envelope for a click is an empty 200 and a follow-up, as
  data: a post of the text to the click's `response_url`. The door answers the empty 200, and then makes the post
  through the Instance Effector's `http` call
  ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)): to a host that the kind declares
  (`hooks.slack.com`), with no secret (the url is in the verified payload), one try. The door refuses a url that does
  not start with one of the kind's `posts`, and posts nothing. A failed or refused post is a `follow-up` line in the
  hook log. A `reply` that threw is in its delivery's line, as `replyErrors`. It is the answer by another road, with no
  slot, no ledger row and no run. No Machine can post it, because a click that reaches nothing has no run.
- **No deferred answer.** The text is a verdict or an outcome, which is ready when the answer leaves. The work never is.
  Discord's deferred answer (type 5) would make the run's result the answer, but its token lives 15 minutes, a run is
  often longer, and a deferred answer that nobody edits stays "thinking". When the door misses the service's 3 seconds,
  the person sees the service's error, the hook log keeps what jr2 did, and a held item still runs.
- **The hook log keeps each delivery for `runs.retain`**
  ([ADR-0065](0065-a-persist-survives-a-crash-and-history-is-kept-for-a-set-time.md)): its Hook, id, digest, outcome and
  the status that the rules give, a `payload-refused` delivery with zod's issues, a Source's skip with its reason, a
  `reply` that threw, and a failed follow-up post. `jr2 hooks <name>` prints it, newest first, from `GET /hooks/:name`,
  which takes the Instance token alone ([ADR-0014](0014-observation-is-open-run-state-is-not.md)): a line can hold a
  payload's fields and a handler's words. A run's blob keeps its `(delivery, gate)` pairs as the `delivery` of each
  answer that a Hook gave (the run's last 100 answers, ADR-0078), so a restore never gives one delivery twice to one
  Gate.
- **Tests.** The default tier drives `POST /hooks/:name` with a `token` and an `ed25519` verifier against hooked Gates
  and a Pool's Source, with the handshakes, the parse, the join of the replies and the envelopes. It has no Instance
  Effector, so the `@kind` tier drives a `mac` verifier through the Instance Effector, and a look whose `http` read runs
  there ([ADR-0078](0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md) lists the facts of
  the services that the build must check).

## Static imports; live objects constructed per-invocation from input

Everything above is reachable by plain `import`. We rejected two alternatives:

- **Injected closures / a `defineWorkflow(kit)` wrapper** — xstate's `provide()` fills only the machine it is called on;
  it cannot reach actors inside child machines, so host-side injection cannot compose past one level (the finding that
  retired the templates-with-injected-providers model — see ADR-0015).
- **Adapter singletons** — a module-global "current adapters" holder cross-contaminates in-process multi-instance use
  and turns mocking into global state. (The demux registry above is not this: it is rendezvous keyed by globally unique
  ids, not a swappable adapter.)

The doctrine that makes static import work, sharpening ADR-0007: **actor logic is code; everything live is constructed
per-invocation from serializable input** — the Harness client from an endpoint, the kube client from ambient config.
Tests mock by `machine.provide()` at the layer under test.

## Considered options for a Hook's delivery

- **Correlation keys**: a Gate states keys (`{ pr }`, `{ sha }`), a Hook event carries them, and the door routes by
  them. Not now: the fan-out calls every open handler of the kind and event key, and keys can come later as an index,
  without a break, when a measurement shows the need.
- **A kept buffer**: the door keeps each Hook event for a time and gives it to a Gate that opens later. Rejected: it
  gives edges again in the order that they arrived, so an old verdict can come after a newer one. The look reads the
  level instead.
- **A Listener**: an actor at a Machine's root, `listen(kind, { delivers, on, hold })`, that turns each delivery into
  one of its own events and holds it until the Machine takes it. Rejected: it is a second concept beside the Gate, and a
  third party of Sender, outside the position rule of ADR-0015.
- **A Lookout**: a delivery only wakes an Effect slot, which reads the fact with an idempotent read and settles on it,
  so the payload never decides. Rejected as the only form: it is the soundest, and the hardest to write. Each wait needs
  a read and a schema, and a service with nothing to read needs a second form. Its read is the Gate's `look`.
- **Payloads typed only**: a kind gives a TypeScript type for each event key, and the door parses nothing. Rejected: the
  type then promises what nothing checks, and a fault in it shows in the handler of every Workflow, as a `hook-refused`
  mark far from its cause, instead of at the kind.
- **Handlers as a list of `on(kind, handlers)` calls**, which needs no `HookKinds`. Rejected: TypeScript lost the Gate's
  `meta` type through the nested generic call, and the handler's `meta` was `never`.
- **A brand on a handler's return** (`deliver(approve, { by })`). Rejected: a plain event typed by `delivers` gets the
  same checks from the compiler and the walk, with one name less.
- **The reply text in the handler's return.** Rejected: the handler runs before the run answers, so it cannot know
  `refused`.
- **`reply` in the Hook's config**, a function of the whole outcome. Rejected: the config is not the Assembly, it knows
  no Workflow, and a publish does not hand it over.
- **The author's envelope** (`{ response_type, text }`, a Discord type), or a `reply` for each kind. Rejected: every
  author learns two services for one text, and a message that the channel sees is shared state, which is an Effect.
- **A reply that changes the message** (Discord type 7, Slack `replace_original`). Rejected: a click that counts for
  nothing would remove the buttons for everyone. The Machine's update of the message follows its state.
- **One winner** among the targets' texts (the first target, or a load-walk refusal of two). Rejected: it hides what
  happened at the other targets, and the walk cannot see which Gates will be open.
- **No text for a Slack click**, only the Machine's update. Rejected: a click that reaches nothing, or that the run
  refuses, then shows nothing at all.
- **A deadline fallback** (a deferred answer at 2.5 s, and the text posted later). Not now: the door is fast by design,
  and the fallback adds a timer and a second road for a rare case.

## Consequences

- Addresses are computed by jr2, never by the workflow — iids always (ADR-0016): fresh per invocation by default (the
  fresh conversation), or `<run>/<machine actor path>/<agent>` plus its epoch under `continue: true` (ADR-0057); gate
  ids derived from the gate's actor path by default, authored only to give external callers a meaningful name. Durable
  handles live in the host ledger (ADR-0016), not in machine contexts.
- **Test stubbing happens at the wire, not in the actor.** The e2e tier (ADR-0010) hosts a wire-compatible stub Harness
  beside its orchestrator fixture (admits the agent, holds the stream open, never acts). An endpoint is just a URL, so
  `agentRun` keeps a single code path and cannot tell it is talking to a fake. Scope: **workspace-less test workflows
  only**, which pass `endpoint` directly in run input — e2e drives their Machines by playing the Harness's Menu against
  `/agents/<iid>/*` with no cluster. Workflows that invoke `workspace()` always get real Sandboxes (the data plane is
  never faked — ADR-0009); their e2e tier requires kind.
- A Caller's free text to an Agent is a Steering message ([ADR-0002](0002-duplex-streaming-actor.md)), never a workflow
  event: it is in no Vocabulary, and no Gate takes it.
- Not set yet: a time budget for the handlers, which run in the Orchestrator's event loop for each open Gate of their
  kind and event key.
