# A Turn is its Frame, its Dials, and whether it continues

A live `task` run (2026-09-20, `fa45e88f`, seven tool calls, eight minutes, zero bytes of the target read) exposed the
seam: the prompt said `Work in /work/target/summarize` while every Working tool resolved relative paths at `/work`,
because `cwd` lived on the Agent definition and a definition is written before any run — before any worktree — exists.
The package compensated with prose, and a weak model ignored prose: it wrote `SUMMARY.md` outside the worktree, called
`finish`, and the run parked at `review` claiming done. The audit that followed found the invoke input carrying four
ways to name one conversation (`session: "continue"`, `scope`, `conversation`, and an undeclared `instanceId`), one of
them (`scope`) with two unrelated author intents, none with a stated precedence, and every `@kind` fixture bypassing all
of them. ADR-0028 already said the reviewing state hands a per-round worktree path as the reviewer's "cwd and prompt";
ADR-0018 and CONTEXT.md said `cwd` is identity, never per Turn. The decided thing had no field to land in.

## Decision

- **A Turn's input is its Frame, its Dials, and whether it continues — nothing else.**

  ```ts
  { prompt, cwd?, continue?, model?, thinkingLevel? }
  ```

  Identity — `instructions`, `workspace` — stays on the definition, and the definition is exactly identity plus one
  default: `agent({ model, instructions, workspace?, thinkingLevel?, description? })`.

- **The Frame is `prompt` and `cwd`: what this Turn is about and where it works.** Neither identity nor a Dial. A
  worktree path is per run by nature — `/work/<slot>/<branch>` exists only once a run has a branch — so no definition
  can name it, and a directory is not a property of a persona any more than a prompt is. `cwd` leaves `AgentDefinition`.
  The Harness roots the Working tools at the Frame's `cwd`, which rides the admit body beside the prompt and the Dials.

- **Under a Workspace, an absent `cwd` resolves to the only Repo Slot's Worktree, and is refused when there is more than
  one.** With one slot there is no choice, so no convention is being smuggled in (ADR-0051: the kit gives no slot a
  meaning). With two or more, the state must say which — `cwd: context.workspace.repos.target` — and the actor refuses
  the Turn before admission, naming the slots and the line to add. The trap is accepted with open eyes: a composer who
  adds a second slot on the `customize` line can make a Machine that ran yesterday refuse today, in a file the Machine's
  author never sees. The refusal is explicit, at the first Turn, before any pod is spent; `jr2 up` cannot see it because
  the invoke's input is a function. A `workspace: "none"` Agent has no Working tools and no `cwd` (ADR-0028); a
  stub-Harness run with no Workspace keeps `/work`. `task` always passes its `cwd`, because "the first slot is the one
  the coder edits" is its convention and a convention is stated, not defaulted.

- **`continue: true` is the whole continuation surface.** Absent, every invocation is a fresh conversation — jr's lossy
  handoff, ADR-0016's default, unchanged. Present, the Turn lands on **this Agent's one conversation in this Machine
  instance**, whichever state of the Machine invokes it. The Instance ID is structural —
  `<runId>/<machine actor path>/<agent>` — so the author writes a boolean, not a key: in a state machine the identity is
  already on the page (the run, the Machine instance, the Agent slot), and a caller-chosen string would only restate it,
  or contradict it. Every surveyed orchestration framework makes the caller hold a key (LangGraph `thread_id`, Temporal
  Workflow Id, Mastra `threadId`) because nothing else can; here something else can.

  - **Fan-out is safe by construction.** A Pool spawns each worker with the item id as its actor id (pool.ts), so three
    `task` children each mint their own `…/backlog.worker.<item>/coder`. The packaged Machine never learns it is under a
    Pool.
  - **States of one Machine share by saying `continue`.** States differ by Menu — a coder in `implement` offers
    `finish`, the same coder in `fix` offers `finish` and `dispute` — and the same conversation is wanted across them. A
    state that wants a clean context leaves `continue` off.
  - **Two Agents never share a conversation.** The agent name is in the id, and it always was; a second persona under
    one transcript would swap the system prompt mid-conversation. The memory-Agent shape ("read the coder's
    conversation, store what matters") is served by handing the transcript as prompt _data_ to an Agent with its own
    conversation — Letta's sleep-time agents — not by joining; how a transcript reaches a Machine as data is a follow-on
    decision.
  - **A faulted conversation is never continued.** No fault leaves a conversation worth continuing: a runaway either had
    its reroll or has a poisoned context; infra and no-signal mean the Harness that held it is unreachable (ADR-0035).
    jr2 keeps an **epoch** per continued conversation in the ledger beside the snapshot; the terminal `agent.fault`
    bumps it, and the next `continue` on that Agent mints `<id>/<epoch>` — a virgin conversation. The author deletes
    their generation counter. What stays with the author is re-briefing: the fault event is the signal that the next
    prompt must carry the whole task again, and jr2 cannot write that prompt.
  - **The reroll stays closed to continued conversations** (ADR-0035): the one recovery jr2 knows is the identical
    prompt on a fresh conversation, and a continued Turn's prompt ("Continue.") is meaningless fresh. Fault route plus
    re-brief is the recovery.
  - **Two live invocations of one continued id — parallel states — are refused at the registration table**, one live
    surface per address; a Submission that arrives behind a live one on the _Harness_ queues (ADR-0027). Sequential
    states never race, because ADR-0024 ends the previous Turn before the next state invokes.

- **`session`, `scope`, `conversation`, and `instanceId` retire.** `session: "continue"` was already this boolean under
  a longer name — its id was the invoking Machine's actor path plus `scope` — so what retires there is the name and the
  suffix; `conversation` was the cross-Machine pin (a name _replacing_ the path, so two Machine instances — two Pool
  children — collided by construction, the hazard ADR-0049 recorded and could not refuse); `scope` suffixed all of them
  and carried two intents (a subject under `continue`, a generation counter in `task`); `instanceId` bypassed minting
  for tests. One boolean replaces all four because the id is deterministic when continued, so nothing needs a handle to
  address it.

- **The author type carries no mechanism.** `endpoint` and `sandbox` — set only by stub-tier fixtures that have no
  `workspace()` to resolve from — move to a mechanism type the tests import. `tools`, the Menu override, retires: a
  hand-written Menu can only agree with the invoking state's transitions or lie about them, and the lie is a pick that
  moves nothing (ADR-0029). It was also hiding one real shape — a fixture whose picks sat in SUBSTATES of the invoking
  state, where ADR-0015's derivation (own plus ancestors) cannot see them, so the derived Menu was empty and the
  override supplied what the state could not. That shape is now refused at build, naming the state, the Agent and the
  buried picks; an empty Menu with nothing below it stays legal, because a state a Gate or a timer moves asks its Agent
  for text and nothing else. A real run never sets any of them: a Sandbox Agent resolves ambiently (ADR-0016), a
  `workspace: "none"` Agent lands on the Instance Harness (ADR-0031).

## Considered options

- **Prompt-only** — tell the model that relative paths resolve at `/work` and demand absolute ones. Rejected by the
  incident: ADR-0024 already established that the same prompt produces compliance on one run and not the next, and every
  other Machine would repeat the sentence.
- **`cwd` stays on the definition, overridable per Turn.** Rejected: a definition-level `cwd` can only ever say `/work`,
  the parent of every checkout, where grep and glob hit the pristine `default/` clone beside the worktree. A default
  that is wrong under every `workspace()` is not a default.
- **`cwd` as a third Dial.** Rejected on the word: Dials say how hard to run. A directory says where, which is the same
  kind of fact as the prompt — hence Frame.
- **Default `cwd` to the first Repo Slot.** Rejected: reverses ADR-0051 ("there is no `workdir`"). The single-slot
  default is not the same thing — with one slot there is nothing to privilege.
- **Refuse an absent `cwd` under every Workspace.** The safer twin of the single-slot default: one line per invoke, no
  composition trap. Not taken: the trap's failure is explicit and early, and the line is noise for the common
  single-repo Machine.
- **A caller-chosen conversation key (`conversation: "coder"`).** Rejected: it either restates the structure or
  contradicts it. Path-scoping the key was proposed and made the key redundant — once the id is
  `<run>/<machine path>/<agent>`, the author has nothing left to name.
- **Continuation scoped to the invoking state.** Rejected: splits one conversation across the states that differ only by
  Menu, which is the case continuation exists for.
- **The cross-Machine pin kept as an opt-in.** Rejected: zero users since `examples/coding` went (ADR-0054), never sound
  — the two states it joined sat on different Harnesses, and a conversation lives on one server (ADR-0031) — and an
  unused opt-in is the fourth mechanism back under a new name. If a sound case appears it is a new decision.
- **Continue a faulted conversation, author's choice.** Rejected: there is no case. Every fault class leaves either a
  poisoned context or no server.

## Consequences

- `AgentTurnInput` is `{ prompt, cwd?, continue?, model?, thinkingLevel? }`; `AgentDefinition` loses `cwd`. The Harness
  admit body gains the Frame's `cwd`; `ResolvedDefinition.cwd` resolves from it, not the definition; the Harness stops
  validating `description`, which the Orchestrator strips before admission (it is Console material).
- **A Frame's `cwd` is absolute or the admission is refused**, naming the Frame. Absent is the one silent case, and it
  says `/work` — a stated default. A relative path has no such answer: it would resolve against whatever directory the
  Harness process sits in, which is the silent wrong directory this ADR was written for, one level further from the
  author. The refusal is a 400 at admission, before a pod is spent.
- `task` passes `cwd: worktreeOf(context).path` and `continue: true`, and drops `generation` (and its `scope`). It keeps
  `turns`, reset on `agent.fault`, because re-briefing is prompt policy.
- The ledger record for a continued conversation carries its epoch; the input mapper reads it at mint time, so the
  minted id persists with the input and restore re-attaches the same conversation (ADR-0016's mapper rule holds — the
  fresh suffix is still the random component).
- The `@kind` fixtures drop `tools:` and `instanceId:`; the steps compute the continued id from the actor path, as they
  already computed today's pin.
- A regression scenario for the silent success: a `task` whose model uses relative paths must produce its file inside
  the worktree, and a multi-slot Machine with no `cwd` must be refused with the slots named.
- CONTEXT.md: **Frame** enters; **Dials** loses `cwd`; **Instance ID** states the `continue` scope and the epoch.
  ADR-0016 (continuation), ADR-0018 (identity line), ADR-0031 (placement scenario), ADR-0035 (reroll gate wording),
  ADR-0049 (persona hazard), and ADR-0054 (`task`'s continuation) are edited to state this truth.
