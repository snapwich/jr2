# jr2 briefs the Agent on its seat, never on its task

The model saw two sources of text: the Agent's `instructions` (identity, ADR-0018) and the Frame's prompt (the Machine
state's, ADR-0057). jr2 itself spoke only after a failure — the no-signal nudge — so an Agent had no way to learn facts
only the mechanism knows. ADR-0057 opens with that failure: a weak model never learned its working directory, wrote
outside the worktree and still called `finish`. ADR-0060 adds more such facts: `os.cpus()` reports the node, not the
Sandbox's CPUs. ADR-0061 adds events: a kernel memory kill ends a conversation, and the next Agent inherits a Workspace
whose processes are gone, with no way to know why.

## Decision

- **jr2 has its own text to the model, the Briefing.** It says a fact only if a correct Agent would act differently
  knowing it **and** cannot find it out for itself: how it acts on the workflow, the Sandbox's CPUs and Size, the
  working directory, that a Menu-only Agent has no Working tools, and what happened to the last Turn. Nothing about the
  task — that is the Frame's — and nothing about style or care — that is identity's. Stand-ins are left out: the only
  change that knowing could cause is an attempt to go around the Custodian.
- **Two parts, placed by how often they change.** The standing part is the same on every Turn of a seat; it follows
  `instructions` in the system prompt, in its own delimited section, and is byte-stable (no timestamps, no counters, no
  Menu names). The Turn part follows the Frame's prompt in a delimited block: the working directory, the Turn's Allowed
  picks ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)) and the notices.
  So the Briefing never breaks the provider's prompt cache — the Turn part sits in the newest message, which is uncached
  anyway, and stays unchanged in the history after.
- **How the Agent acts on the workflow is one standing statement**, true whether a pick ends the Turn or keeps it open
  ([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)): "You act on the workflow by picking from
  your Menu: a call to one of the workflow's tools that the newest "Allowed now" lists. Each pick's answer says if your
  Turn is over. If it is over, stop and call no other tool. If it is not, continue. If nothing is allowed, stop: the
  workflow prompts you again when something is." The last sentence is safe because the wake asks a model that stopped
  with nothing allowed when a pick opens ([ADR-0016](0016-agent-turn-mechanics-are-internal.md)). A line that says a
  Turn ends with exactly one pick would be false for a pick that keeps the Turn open.
- **The Turn part is written once per Submission, and restated when its Allowed picks change.** When something other
  than the Agent's own pick changes them inside the Turn, the Harness appends the Allowed picks again at the next step
  boundary, in a `<jr2-turn>` block of their own: "The workflow's state changed since you last read the Allowed picks.
  Allowed now: …" ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)). It is
  appended, never a rewrite of the first, so the cache argument above holds for it too. It carries no notice: notices
  are for the next Turn in their scope.
- **The Turn part comes last, because a model obeys what it read last.** Measured on the home-lab vLLM model: with a
  prompt that argued for a pick the Turn did not allow, the Allowed picks placed ahead of the prompt were obeyed 0/10
  (thinking off) and 5/10 (thinking on); placed after it, 10/10 both. Wording made no difference. The author's task
  still reads first, as it would with no jr2.
- **Always on.** No author can turn it off: every fact in it passes the rule above, so removing one can only make the
  Agent act worse. An `instructions` that repeats a fact is harmless.
- **A notice is delivered once**, on the next Turn in its scope, then cleared.
  - **Conversation scope** ("this conversation is new; earlier context is gone") goes to that Agent's next Turn. So does
    a pick's answer that never reached its call
    ([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)): the route left the Agent's state, and
    the next Turn of the conversation the picking Turn continued hears "the workflow left the state of your last turn
    while your pick was outstanding", with the answer — or, when something other than the route left the state while the
    pick's work ran, "your pick did not finish: the workflow left the state that asked for your last turn while it ran,
    and that stopped it" (`stopped`), with an earlier link's reply when one came. No pick-answer notice says the work
    ran to its end. A fresh picking Turn has no such conversation, and its answer is no notice.
  - **Workspace scope** ("the Sandbox's processes were killed at its memory limit during `coder`'s Turn; `/dev/shm` was
    cleared") goes to the next Turn of any Agent in that Workspace. A Menu-only Agent outside a Workspace receives
    conversation notices only.
  - A notice never replaces a fault. The Machine still receives `agent.fault` and decides (ADR-0016); the notice makes
    sure the next Agent is not working blind.
- **The Orchestrator is the only keeper of notices**: pending notices are plain data in the run's persisted state
  (ADR-0007). It sees kernel kills and fresh conversations itself; the Harness reports a guard kill (ADR-0061) as an
  event on its updates stream. A notice counts as delivered when its admission is ledgered, so a restart before that
  point delivers it again and a restart after it does not. Delivered is not yet heard: if the Orchestrator ends the Turn
  before the Harness reads its surface, the Harness never prompts it (ADR-0026), so the Orchestrator raises that
  admission's notices again. A nudge takes no notices: it re-prompts the Turn within itself, and a notice raised during
  that Turn is for the next one.
- **The Harness writes every word.** The admit body carries typed notices
  (`notices: [{ kind: "memory-limit", scope, agent, peak?, limit } | { kind: "conversation-new", reason } | { kind: "pick-answer", pick, cut, answer?, stopped? } …]`),
  and the Harness renders both parts. An outstanding pick's answer is data too — the last reply since the pick, a
  party's event with its payload or a child's output (ADR-0024) — and its words ("Its answer: `approve` from Gate
  `review`, with {…}", "No reply came back for it.") are the Harness's, in the receipt and in the notice alike; "it
  moved the workflow, and nothing ran" is a guard straight back's receipt alone. The standing part needs no wire: the
  Harness already holds its limits (cgroup and Downward API env), the definition's `workspace` access, and the Menu. The
  wording lives in one place, and Harness conformance checks it (ADR-0027).

## Considered options

- **Put the facts in the Frame.** Rejected: the Frame is the Machine state's (ADR-0057), and a kit that writes into it
  makes the author's prompt say things the author did not write.
- **Leave it to authors' `instructions`.** Rejected: a definition is written before any run, so it cannot know a Size a
  composer retuned, a working directory, or what happened to the last Turn — and packaged Agents would each word it
  differently or not at all.
- **An author switch** (`agent({ briefing: false })`, or notices only). Rejected: under the rule, each fact is one a
  correct Agent needs; the switch only lets the ADR-0057 failure back in.
- **Everything in the system prompt.** Rejected: per-Turn content there breaks the prompt cache on every Turn.
- **Finished text from the Orchestrator.** Rejected: wording split across two processes, and untestable where the turn
  loop is tested.

## Consequences

- ADR-0060's CPU fact and ADR-0061's memory-limit notice are the Briefing's first users.
- The no-signal nudge stays a re-prompt within a Turn (ADR-0016); it is not a notice.
- The Briefing is how a Turn learns its Allowed picks: the tools block is the whole Menu, fixed for a conversation so it
  does not break the cache
  ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)).
- CONTEXT.md gains **Briefing**.
