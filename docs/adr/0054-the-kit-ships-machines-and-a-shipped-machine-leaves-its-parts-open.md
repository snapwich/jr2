# The kit ships Machines, and a shipped Machine leaves its parts Open

The kit's only worked Machines lived in `examples/`: two model Instances, one of them (`coding`) four workflows deep,
written against surfaces three ADRs old, runnable by nobody but the author, and installable by no one — an example is
copied, never imported. ADR-0049 had already settled that "a package exports a Machine, nothing beside it" and
CONTEXT.md that "reusable workflows travel as npm packages", yet the kit itself shipped none, so the packaged-Machine
story had no first instance to hold it honest. The grill of 2026-09-14 replaced the examples with a package, and in
doing so found the one part ADR-0049/0051 left a package unable to leave unsaid: **the model.**

## Decision

- **The kit ships Machines as `@jr2/machines`.** A fourth published package beside
  `@jr2/{cli,orchestrator,agent-protocol}` (ADR-0043), on the same release train, exporting named Machines from its
  index: `import { task } from "@jr2/machines"`. It ships Machines and never Workflows — a Workflow is the name an
  Instance registers a Machine under, and only the Instance's `workflows/` file can do that (CONTEXT.md). Rejected:
  `@jr2/workflows` — it names exactly the thing the kit does not ship, and `workflow` is on Machine's avoid-list for the
  reason ADR-0049/0050 lean on the distinction.
- **`@jr2/machines` authors against the consumer's `@jr2/orchestrator`: peer dependencies, no regular ones.** Every part
  a Machine carries is keyed in maps `@jr2/orchestrator` holds (vocabulary.ts, parts.ts) and in `xstate`'s own `provide`
  and `isMachine`; a second copy of either is a Machine whose Menus are empty and whose Gates accept nothing, with no
  error anywhere. `peerDependencies: { "@jr2/orchestrator": <exact kit version>, xstate, zod }` states the fact and is
  the shape a user's own Machine package copies. Rejected: regular deps at the exact version — dedupe makes it work by
  the accident of equal versions and installs two copies silently on skew.
- **A shipped Machine leaves its parts Open, and Open widens from the Repo Slot to the Agent's model.** ADR-0051's
  `open` sentinel — "a consumer's to bind, with `customize`" — applies unchanged to the one part a package cannot
  honestly fill: `agent({ model: open, instructions })`. The `jr2 up` walk reports an Open model beside Open Repo Slots
  and refuses the converge naming the `customize` line that binds it; the Agent actor refuses to admit a Turn whose
  definition is still Open, as the second fence. `AgentDefinition` stays the wire type with `model: string` — a Symbol
  does not ride a Turn — and `agent()` takes a declaration whose `model` is `string | typeof open`. The sentinel becomes
  `Symbol.for("jr2.open")`. Rejected: a stock default model — the kit picks a vendor in a published package, and a user
  who never reads the file spends money on a model they did not choose, silently, which is the failure class `jr2 up`
  exists to make loud. Rejected: a Machine factory `task({ model })` — ADR-0049 settled that a package exports a Machine
  and retunes with `customize`, and a factory reopens that.
- **The per-run Dial is the escape hatch, not the default.** A shipped Machine's door may carry `model` and
  `thinkingLevel` (ADR-0018's two Dials) and fold them into each invoke's input; the bound definition is what `jr2 up`
  preflights, the door value overrides it for one run's Turns. Nothing in jr2 changes for this — it is the Machine's own
  four lines.
- **The first Machine is `task`: one prompt, one Workspace, one human says done.** Door
  `{ prompt, branch?, model?, thinkingLevel? }`, branch defaulting to `jr2/task-<run id>`; the Repo Slots Open as a map
  (`repos: open`, ADR-0051) — the consumer names them, and the order is `task`'s own convention, since jr2 gives no slot
  a meaning: the first is where the coder works, any others are checkouts the first Turn frames for the coder to read;
  one Agent `coder` with an Open model. `working` invokes `coder`; its `finish { summary }` parks at the `review` Gate
  (meta: summary, branch, worktree), as does a terminal `agent.fault` (meta: reason). `approve` reaches the final state
  and tears the Workspace down; `request_changes { notes }` **continues the same conversation** (`continue: true`,
  ADR-0057) — one human steering one Agent wants the Agent to remember what it did, unlike ADR-0049's coder⇄reviewer
  handoff, which is lossy on purpose. No round cap: the human is the cap. Rejected: a per-run Repo on the door — a
  packaged door cannot enumerate the Instance's repos, and "a Workflow is a name" reads best when the name means "a
  prompt against THIS repo". Rejected: a named `target: open` slot — the body reads the first checkout the handles
  carry, never `repos.target`, so the name claimed a shape the body did not have and shut out the one thing a task
  commonly wants beside its repository: another checkout to read.
- **The Machine does not push.** ADR-0005/0053: the Agent holds no credential and the push url is the caller's own
  spelling with the caller's own credential. The Gate park is the inspection window — exec in, review, push, then
  `approve`, and unpushed commits go with the pod, as ADR-0012 always said. A credentialed push out of the pod is a
  decision of its own, not this one.
- **`examples/` retires; `templates/default` is the one Instance in the checkout.** The scaffold's model moves from
  `examples/starter` to `templates/default` — the folder documents what an Instance looks like and is what `jr2 init`
  renders, kept byte-equal to the CLI's inline templates by the existing drift test, since an installed CLI cannot read
  a repo-root folder (ADR-0043). `templates/` is plural because a later `jr2 init --template <name>` is the obvious next
  step. The scaffold stays `ping`-only — the `@dist` tier's contract is a fresh instance that runs before any provider
  or repo exists — and `ping.ts`'s prose shows the `@jr2/machines` move as the next step instead of an inline `agent()`
  sketch. `examples/coding` is deleted whole, `jr.ts` included; `docs/architecture.md` draws `task` in its place.

## Consequences

- **Every Machine in `@jr2/machines` ships with a `@kind` scenario.** These are for end users, and the only proof a
  shipped Machine works in jr2 is the stock Harness driving it in a real Sandbox. `features/kind-instance` registers
  each one the way a consumer would — `customize(task, { repos, agents })` over the tier's fixture repo and scripted
  model — and the scenario walks its Gates. The socket-free mechanics test beside the Machine covers the default
  `pnpm -r test` gate; it does not stand in for the scenario.
- `@jr2/machines` joins the `PUBLIC` list in `publish.test.ts` and the guard loop in `scripts/dist-publish.sh`; the
  `@dist` tier publishes it to verdaccio, so its pack and `files:` list execute there even though no `@dist` scenario
  runs it.
- CONTEXT.md gains **Open** as a term, and the Workflow entry says the kit ships Machines. Eleven earlier ADRs cite
  `examples/`; the citations are retargeted in place.
- A `customize` that binds a model is now the common consumer line, not the exotic one; `jr2 up`'s refusal for an Open
  Agent prints it, as it does for an Open Repo Slot.
- The `triaged-task` mechanics test went with `examples/coding`, and the cross-Machine conversation pin it exercised
  went with ADR-0057; the `@kind` `consulted`/`advised` fixtures hold Instance Harness placement.
