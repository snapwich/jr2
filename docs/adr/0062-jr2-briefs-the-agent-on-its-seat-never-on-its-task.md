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
  Menu names). The Turn part follows the Frame's prompt in a delimited block: the working directory, the notices, a
  **pick's briefing** for each Allowed pick that has one (jr2's text on the pick's parameter, which the Orchestrator's
  surface marks on the pick: the Chart briefing of [ADR-0070](0070-a-machine-lends-its-parts-to-a-chart.md), said only
  on a Turn that may make that pick), and the Turn's Allowed picks
  ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)). So the Briefing never
  breaks the provider's prompt cache — the Turn part sits in the newest message, which is uncached anyway, and stays
  unchanged in the history after.
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
  are for the next Turn in their scope. It carries a pick's briefing when the restatement opens that pick.
- **The Turn part comes last, because a model obeys what it read last.** Measured on the home-lab vLLM model: with a
  prompt that argued for a pick the Turn did not allow, the Allowed picks placed ahead of the prompt were obeyed 0/10
  (thinking off) and 5/10 (thinking on); placed after it, 10/10 both. Wording made no difference. The author's task
  still reads first, as it would with no jr2.
- **Always on.** No author can turn it off: every fact in it passes the rule above, so removing one can only make the
  Agent act worse. An `instructions` that repeats a fact is harmless.
- **A notice is delivered once**, on the next admission in its scope that takes it, then cleared. That is the next Turn,
  or, for a guard kill that the Agent of an open Turn was not told, that Turn's nudge or wake (below).
  - **Conversation scope** ("this conversation is new; earlier context is gone") goes to that Agent's next Turn. So does
    a pick's answer that never reached its call
    ([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)): the route left the Agent's state, and
    the next Turn of the conversation the picking Turn continued hears "the workflow left the state of your last turn
    while your pick was outstanding", with the answer — or, when something other than the route left the state while the
    pick's work ran, "your pick did not finish: the workflow left the state that asked for your last turn while it ran,
    and that stopped it" (`stopped`), with an earlier link's reply when one came. No pick-answer notice says the work
    ran to its end. A fresh picking Turn has no such conversation, and its answer is no notice.
  - **Workspace scope** ("the Sandbox's processes were killed at its memory limit during `coder`'s Turn; `/dev/shm` was
    cleared. Anything that was running in the Sandbox at that time is gone.") goes to the next admission of any Agent in
    that Workspace that takes it. One kill is one notice, however many Turns saw it. Only a kill read on a stream while
    its wait is live names the Turn whose Submission ran. Both forms end with the whole Sandbox, because every process
    in it died, a shared Workspace's too, and in the past tense, because the Agent may hear it after processes started
    again. A kill read from the pod's list names no Turn and says nothing of when or whose: "the Sandbox's processes
    were killed at its memory limit (peak X of Y); /dev/shm was cleared. Anything that was running in the Sandbox at
    that time is gone." The list cannot say whose Turn a kill ended: the kill may land after a state exits, or end an
    attach, a sync or a command. A kernel kill read from the Sandbox's last end (below) says the same, with the limit
    and no peak: "the Sandbox's processes were killed at its memory limit of Y; …". A Menu-only Agent outside a
    Workspace receives conversation notices only.
  - A notice never replaces a fault. The Machine still receives `agent.fault` and decides (ADR-0016); the notice makes
    sure the next Agent is not working blind.
- **The Orchestrator is the only keeper of notices**: pending notices are plain data in the run's persisted state
  (ADR-0007). It sees kernel kills and fresh conversations itself. A kernel kill (ADR-0061, layer 5) has two paths,
  under one source, the Workspace and the time the Harness container ended. A Turn that the kill ended faults on it, and
  the fault raises the notice with the Turn's Agent. A kill while no Turn runs faults nothing, so before each admission
  into a Workspace the Agent actor also reads the container's last end from the Sandbox watch, which the operator
  publishes: a last end `OOMKilled` raises the notice, which names no Turn. The ledger's `seen` makes the two paths one
  notice. An actor whose own watch saw the restart reads the last end only when it re-admits the Turn after the cut.
  When the Turn faults, the fault's notice names the Turn's Agent. A watch that has not listed yet says nothing, and the
  next admission reads again: the last end stays until the container ends again. A nudge and a wake take no kernel kill;
  it stays for the next Turn. The re-admission after a cut takes it, as it takes every notice in scope that is not a
  guard kill. The Harness reports a guard kill (ADR-0061) on two paths, under one id that the Harness gives the kill:
  - **On a stream.** While a Submission runs, the kill is an event on that conversation's updates stream. The Agent
    actor reads a stream while it waits on the Submission. It stops when the Agent's state exits, before its abort
    reaches the Harness. So a stream does not always reach a reader: a kill in that window is on a stream that no one
    reads. A stopped actor raises nothing from its stream.
  - **In the pod's list.** The Harness keeps every kill, with `told`: the conversations whose `bash` call returned the
    kill's verdict to the model. A conversation goes into it when the answer returns, not when the guard fires: a call
    cut short (the container's end, a restart) told no one. A model that writes text, or waits, is not told. The Harness
    keeps the list in a file beside its conversations and answers it on `GET /memory-kills`. A kill while no Submission
    runs is on this path alone: for example, a dev server killed while the workflow waits at a Gate. Before each
    admission into a Workspace, the Agent actor reads the list. The actor sets the read's limit of 5 seconds, and it is
    the only limit. A read that never left the Orchestrator, or a draining Harness's 503, is sent again in that time. A
    read that fails or times out is none, and the next admission reads again: the list keeps the kill. The Orchestrator
    logs one line when the reads from a Harness start to fail. It logs no line when a read works again, and it logs the
    failure again only when a read fails after a read that worked. The Agent's uid can write the file, as it can the
    conversation records: it can change only what its own Workspace is told. So a `peak` or a `limit` that is not a size
    in the guard's form, or is long, is left out and logged, on the Harness's read of the file and on the Orchestrator's
    read of the list and of a stream. The kill is kept, so a real kill is never lost, and its notice says no sizes: "the
    Sandbox's processes were killed at its memory limit; /dev/shm was cleared. …". Only a kill with no id or no time, or
    one outside the bounds below, is dropped. A stream event from an older Harness has no id; its source is then its
    place on the stream, exactly as the Orchestrator raised it before.

  Both paths raise the notice with the same source, the Workspace and the kill's id. The ledger keeps every source it
  raised (`seen`) in the run's persisted state. So a kill read on both paths, or on two streams, is one notice. Each
  read of the list raises one notice at most: the newest kill's, unless it is raised already. The read marks the older
  kills in it seen, and they give no notice, so a burst of kills in one read tells the Agent one thing. Kills read on a
  stream are not folded: each one with different sizes gives its own notice. Two notices with the same words keep two
  entries in the ledger, and an admission that takes both says them once. The run is saved when a raise changes the
  ledger, and only then. A read removes nothing, so a crash between the read and the save that keeps it loses no kill. A
  restart of the Orchestrator raises no kill twice. A restart of the Harness container keeps the file, which is on the
  pod's emptyDir with its conversations (ADR-0031). A lost pod takes the file with it, but then the Workspace is lost
  (ADR-0021). The list keeps the newest 16 kills, each with at most 32 conversations in `told`, and the Orchestrator
  reads at most 256 KiB of it. The Agent's uid can write the file, so the two sides hold the same bounds: an `id` and an
  `at` of at most 64, an `agent` and an `instanceId` of at most 128, and an `at` that parses as a time. A kill outside
  them is dropped, and a `told` entry outside them is left out. The Harness counts the bytes of the JSON text, and the
  Orchestrator counts characters, which are never more, so the Harness keeps no kill that the Orchestrator drops. The
  Harness reads at most the last 256 KiB of the file. With these bounds the largest list is 149,259 bytes. When more
  come between two admissions, the oldest is lost, and a newer kill tells the same thing. When more than 16 come in one
  Turn, the Turn's mark leaves the list too, and every kill in the list then counts as after the mark; a nudge or a wake
  of that Turn may then carry a kill from before it. The Instance Harness keeps no kill, because it holds no Workspace.

  A notice counts as delivered when its admission is ledgered, so a restart before that point delivers it again and a
  restart after it does not. Delivered is not yet heard: if the Orchestrator ends the Turn before the Harness reads its
  surface, the Harness never prompts it (ADR-0026), so the Orchestrator raises that admission's notices again. This
  holds for a nudge and a wake too: each one must have its surface read again before its notices count as heard. An
  admission that fails leaves the earlier admission's notices heard. A nudge and a wake re-prompt the Turn within
  itself, so they take no notice of the kind a Turn takes. They take only the guard kills of the list that come after
  the newest kill whose `told` names their conversation. That `bash` answer told the Agent that all its processes died,
  so it covers every kill up to it. They also take no kill from before the Turn started. Such a kill would tell the
  Agent that processes it started in this Turn died. The Turn's first read of the list sets its mark: the id of the
  newest kill it saw, or "none". The mark is ledgered with every admission of the Turn, and a restore reads it back, so
  a nudge or a wake takes only kills after it. Only when the first read failed is the Turn's start the mark, ledgered
  the same way, with one second allowed for a pod clock that runs behind. A read that failed is "could not tell", never
  an empty list, so it sets no mark. The kills they do not take stay pending for the next Turn. The re-admission after a
  Harness restart cut the Turn continues the same Turn, so it takes every notice in scope except the guard kills that
  this rule leaves out. When its read could not tell, it takes no guard kill at all, as a nudge then takes none: it
  cannot know which kills its own `bash` reported. The notices that the Turn's admissions carried since the Harness last
  read the Turn's surface are pending again first, each with the source it was raised with, and this re-admission
  carries them whatever else its scope leaves out. A notice with no source merges only into a pending one with no
  source, so an equal notice of another kill never takes its place. When such an unread admission carried the Turn's
  task, the task follows the re-admit text. When the rebuilt Harness lost the conversation, nothing of the Turn is left:
  every notice that the Turn's admissions carried is pending again whatever the surface reads said, the re-admission
  takes every notice in scope, as a Turn's admission does, and the Turn's task follows the re-admit text. It says once
  that the conversation is new. A restore drops the prompt from a Turn's input, so the task rides the ledgered admission
  too; a lost conversation with no task to send faults the Turn instead. Whether the Harness still holds the
  conversation is asked again for up to 30 seconds while the new container does not listen yet or drains, and only then
  is the answer taken as "held". The continue path asks the same way, so a continued Turn after a restart can wait up to
  30 seconds before its admission. A Harness in CrashLoopBackOff can take longer than that: the answer is then "held",
  and it can be wrong. So the admission that continues a conversation the Harness was taken to keep — the re-admission
  after a cut, and a continued Turn — says so with `kept: true`. A Harness that keeps no such conversation refuses it
  with 404 and `kept: false` in the body, and seats none. The Orchestrator takes only that 404 as the refusal; another
  404 is a failed admission. Without the refusal the Harness would seat a new conversation, and a model on an empty
  context would read "continue your task" with no task. On the refusal the Turn takes the path of a lost conversation.
  The re-admission is admitted as a Turn, with the task after the re-admit text and the notice that the conversation is
  new, or faults when it has no task to send. A continued Turn is told that its conversation is new, and is admitted
  again. What the Turn's admissions carried, and whether the Harness read their surface, is kept in the Orchestrator's
  memory alone: after a restore of the Orchestrator before a surface read, nothing is raised again. A fresh Turn's "this
  conversation is new", which rides an admission alone, is carried again by the next re-admission when the Harness has
  not read the one before.

  A continued Turn of the same conversation is told, as a notice, a kill that its own `bash` call answered in an earlier
  Turn. The Agent reads that kill twice, which is true and costs little. The `told` rule could later extend to the first
  admission of a continued Turn too; it does not now, because a fresh Turn's conversation holds no earlier answer, and
  the rule would then need the conversation in the ledger's scope.

- **The Harness writes every word.** The admit body carries typed notices
  (`notices: [{ kind: "memory-limit", scope, agent?, limit?, peak? } | { kind: "conversation-new", reason } | { kind: "pick-answer", pick, cut, answer?, stopped? } …]`,
  where `peak` comes only with `limit`), and the Harness renders both parts. An outstanding pick's answer is data too —
  the last reply since the pick, a party's event with its payload or a child's output (ADR-0024) — and its words ("Its
  answer: `approve` from Gate `review`, with {…}", "No reply came back for it.") are the Harness's, in the receipt and
  in the notice alike; "it moved the workflow, and nothing ran" is a guard straight back's receipt alone. The standing
  part needs no wire: the Harness already holds its limits (cgroup and Downward API env), the definition's `workspace`
  access, and the Menu. The wording lives in one place, and Harness conformance checks it (ADR-0027).

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
- **Report a guard kill on the stream alone.** Rejected: a kill while no Submission runs, or after the wait stopped,
  reaches no reader. A dev server killed while the workflow waits at a Gate is then never told to the next Turn, which
  works blind.
- **Put that kill on every conversation's stream.** Rejected: the next Admission reads its conversation's stream from
  its own offset, which is after the event.
- **Keep in the list only the kills that no stream carried.** Rejected: a kill on a stream whose wait stopped is then in
  no place that is read. And two streams that carry one kill would give two notices.
- **The Harness pushes the kill to the Orchestrator.** Rejected: the Harness container is the Agent's, and ADR-0013
  closes a route from it to the Orchestrator. A push also needs a retry and an acknowledgement, and an idempotent read
  does not.
- **Read the kill on the Sandbox watch.** Rejected: the operator publishes what the kubelet says about the container,
  and a guard kill does not end the container. The Harness has no Kubernetes credentials to publish it.
- **The Harness words the kill into the next Turn itself.** Rejected: a second keeper of notices, outside the run's
  persisted state, which cannot know when an admission is ledgered or heard.

## Consequences

- ADR-0060's CPU fact and ADR-0061's memory-limit notice are the Briefing's first users.
- Each admission into a Workspace costs one more request to its Harness, `GET /memory-kills`. The first read from a
  Harness that fails is said in one line of the Orchestrator's log.
- The no-signal nudge stays a re-prompt within a Turn (ADR-0016); it is not a notice.
- The Briefing is how a Turn learns its Allowed picks: the tools block is the whole Menu, fixed for a conversation so it
  does not break the cache
  ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)).
- GLOSSARY.md gains **Briefing**.
