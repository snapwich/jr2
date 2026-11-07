# jr2 briefs the Agent on its seat, never on its task

The model saw two sources of text: the Agent's `instructions` (identity, ADR-0018) and the Frame's prompt (the Machine
state's, ADR-0057). The repo that an Agent works in said nothing, although a repo can hold an `AGENTS.md` for each
coding agent that works in it. jr2 itself spoke only after a failure — the no-signal nudge — so an Agent had no way to
learn facts only the mechanism knows. ADR-0057 opens with that failure: a weak model never learned its working
directory, wrote outside the worktree and still called `finish`. ADR-0060 adds more such facts: `os.cpus()` reports the
node, not the Sandbox's CPUs. ADR-0061 adds events: a kernel memory kill ends a conversation, and the next Agent
inherits a Workspace whose processes are gone, with no way to know why.

## Decision

- **jr2 has its own text to the model, the Briefing.** It says a fact only if a correct Agent would act differently
  knowing it **and** cannot find it out for itself: how it acts on the workflow, the Sandbox's CPUs and Size, the
  working directory, that a Menu-only Agent has no Working tools, and what happened to the last Turn. Nothing about the
  task — that is the Frame's — and nothing about style or care — that is identity's. Stand-ins are left out: the only
  change that knowing could cause is an attempt to go around the Custodian.
- **Two parts, placed by how often they change.** The standing part is the same on every Turn of a seat; it is last in
  the system prompt, after `instructions` and the project context (below), in its own delimited section, and is
  byte-stable (no timestamps, no counters, no Menu names). The Turn part follows the Frame's prompt in a delimited
  block: the working directory, the notices, a **pick's briefing** for each Allowed pick that has one (jr2's text on the
  pick's parameter, which the Orchestrator's surface marks on the pick: the Chart briefing of
  [ADR-0070](0070-a-machine-lends-its-parts-to-a-chart.md), said only on a Turn that may make that pick), and the Turn's
  Allowed picks ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)). So the
  Briefing never breaks the provider's prompt cache — the Turn part sits in the newest message, which is uncached
  anyway, and stays unchanged in the history after.
- **An Agent in `/work` reads its project context, which is not the Briefing.** The project context is the context files
  that pi-coding-agent's `loadProjectContextFiles` finds from the Turn's working directory up to the Workspace's bound
  (below), one in each folder (the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`
  that is there); the skills that its `loadSkills` finds in `<cwd>/.pi/skills`, as `formatSkillsForPrompt` lists them;
  and the Sandbox Image's user context, when the image has one (below). The system prompt is the `instructions`, then
  the project context in pi's frame (its `project_context` section for the files, then its `skills` section), then the
  standing part. The Briefing stays jr2's own text, is read last, and does not mention the project context.
  - **Who gets it.** An Agent with Working tools whose working directory is `/work` or a folder in it, except jr2's own
    `/work/.jr2` ([ADR-0075](0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md)). A Menu-only Agent has no
    files.
  - **How far up: the `workspace()`'s `projectContext`.** `"worktree"`, the default: up to the root of the Agent's
    Worktree, `/work/<slot>/<name>`. ADR-0075 makes each Worktree, and each slot's clone `default`, at exactly that
    depth. In `/work` (a Workspace with no Repo Slot) or in a slot's folder, which no Worktree holds, the walk reads
    that folder alone. `"workspace"`: up to `/work`, so a `/work/AGENTS.md` and a `/work/<slot>/AGENTS.md` reach each
    Agent of the Workspace. Neither value reads above `/work`. The default is the narrow one, for isolation, and the
    isolation is for an Agent in a Worktree: an Agent whose working directory is `/work` or a slot's folder reads that
    folder's context file under either value. A file in `/work` or in a slot's folder is in no Worktree, so it is in no
    diff and no reviewer reads it ([ADR-0028](0028-what-an-agent-may-do-to-the-workspace-is-part-of-its-definition.md)).
    And under `"workspace"` one Agent writes text into each other Agent's system prompt, where a peer's word becomes a
    rule; ADR-0002 keeps a peer's word from being an order (`peer-not-order`). An author who wants rules that each Agent
    of the Workspace shares chooses `"workspace"` and accepts that. Neither value is a wall: the Agents of one Workspace
    share `/work` ([ADR-0076](0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md)), so one
    Agent can still write in another's Worktree. A write to a file that is not ignored is then in that Worktree's diff.
    An ignored context file is in no diff (an Agent writes the clone's shared `info/exclude`), so each detached cut
    removes the ignored context files and skills of its Worktree
    ([ADR-0075](0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md)): a reviewer's system prompt has only
    what the commit under review has, and what an Agent writes after the cut. A branch Worktree is given back as it is,
    so an ignored context file that another Agent writes there reaches its Agent, in no diff.
  - **The path sets the bound, and the Harness enforces it.** The bound comes from the working directory's path, not
    from a `.git` in a folder: the Agent can remove its Worktree's `.git` file or make one, and that moves no bound.
    pi's walk goes up to `/` and has no option to stop. So the Harness keeps only the files that the child names in a
    folder from the working directory up to the bound, and drops the rest. The walk reads the folders above in the
    domain, which can read them anyway, and their text goes nowhere.
  - **The image user's context, when the image has one, read-only from the image.** When the Sandbox Image's user has
    `~/.pi/agent` (pi's user folder, `agentDir`), pi reads it: its context file comes first, before the walk's files,
    and its skills come from `skills/`. It does not depend on `projectContext`. Each Agent of the Workspace runs as the
    image's user, and ADR-0037 requires a writable `HOME` for that user, so a folder there that the image's user owns is
    one that each Agent writes
    ([ADR-0076](0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md)). What one Agent (or the
    repo code that it runs) wrote there would be in the system prompt of each later Agent: a coder could tell the
    reviewer to approve. So the Agents never read that folder as it is in `HOME`:
    - `jr2 up` records, for each Sandbox Image that it builds, the folder `<home>/.pi/agent`, when each folder of that
      path is a real folder in the image and no link, and the path has no empty, `.` or `..` part (`HOME=/home//u`): the
      Orchestrator mounts only such a path, and it refuses the whole image map for one that is not. `<home>` is the
      image's `HOME`, or its `USER`'s home in the image's `/etc/passwd`. An image with no `USER` has none: its home is
      jr2's emptyDir (`/home/jr2`, [ADR-0037](0037-an-instance-builds-its-sandbox-images-jr2-injects-the-harness.md)). A
      multi-platform image is read for its first platform, from the registry. A registry ref that jr2 did not build has
      none.
    - The Sandbox pod mounts the Sandbox Image a second time, as an `image` volume, with that folder as its `subPath`,
      at the same path, read-only, in the Harness container. The files are the image's, at the path that pi expects, and
      the kernel refuses each write, each new file, each removal and each move there. The mount needs the record: a
      `subPath` that the image does not have stops the container.
    - The pod tells the Harness the folder (`JR2_USER_CONTEXT`, after `harness.env`, `""` for none). The Harness reads
      the user context from that mount alone: with none, it reads none, also when an Agent makes a `~/.pi/agent`. At its
      start, it checks that the folder is its own real path and a read-only mount (`/proc/self/mountinfo`), and notes
      the mount and its device. Before each load and after it, it checks that the folder is still that mount, the newest
      at that path, on that device. Before: if not, the load reads no user context, and the pod log has one line. After:
      if not, the folder gives no project context, as a child that fails does. An Agent cannot unmount it or mount over
      it; the check is for the folder above it, which can move when the home is on a file system that lets it. A move
      and a move back within one load is not seen.
    - The child that reads it is confined further: in that folder it reads only the names that pi's loaders read there,
      so not `auth.json`, `settings.json` or `models.json` (ADR-0076). The image's author put a link there, if there is
      one, and a read through it is a read of the path that it names, which the rules do not allow.
  - **Loaded once for each conversation and folder,** at the first Submission there, and kept in memory: the system
    prompt is the same bytes on each later Submission, so the provider's prefix cache holds
    ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)). A change to
    `AGENTS.md` during a conversation reaches its next conversation. A Harness restart loads it again.
  - **Read in the domain.** pi reads the files in the process that calls it, so a child in the domain calls it, never
    the Harness process ([ADR-0076](0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md)). A
    child that fails, runs too long or writes too much gives no project context and one line in the pod log, and the
    Turn goes on.
- **How the Agent acts on the workflow is one standing statement**, true whether a pick ends the Turn or keeps it open
  ([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)): "You act on the workflow by picking from
  your Menu: a call to one of the workflow's tools that the newest "Allowed now" lists. Each pick's answer says if your
  Turn is over. If it is over, stop and call no other tool. If it is not, continue. If nothing is allowed, stop: the
  workflow prompts you again when something is." The last sentence is safe because the wake asks a model that stopped
  with nothing allowed when a pick opens ([ADR-0016](0016-agent-turn-mechanics-are-internal.md)). A line that says a
  Turn ends with exactly one pick would be false for a pick that keeps the Turn open.
- **An Agent with MCP tools is told that they are not picks.** Its standing part has one more statement: "Your tools
  named `mcp__<server>__<tool>`, where `<server>` is not `jr2`, act on outside services, not on the workflow. A call to
  one is not a pick, and it does not end your Turn." Both tool families share the `mcp__` prefix: the Menu's own tools
  are `mcp__jr2__<event>`, so the statement names `jr2` as the exception. A model that read a call of a service as its
  pick would stop with the workflow's work not done. The statement names no server and no tool, so it is byte-stable; an
  Agent with no MCP tools does not get it. A `"none"` Agent with MCP tools is not told that it acts only by picking from
  its Menu, because its MCP tools act too. The `@model` claim `mcp-then-pick` measures it
  ([ADR-0066](0066-a-model-tier-runs-a-real-model-and-a-change-to-what-it-reads-runs-the-tier.md),
  [ADR-0079](0079-an-agent-holds-mcp-tools-a-machine-calls-them-as-an-effect-and-the-machine-is-the-approval.md)).
- **The Turn part is written once per Submission, and restated when its Allowed picks change.** When something other
  than the Agent's own pick changes them inside the Turn, the Harness appends the Allowed picks again at the next step
  boundary, in a `<jr2-turn>` block of their own: "The workflow's state changed since you last read the Allowed picks.
  Allowed now: …" ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)). It is
  appended, never a rewrite of the first, so the cache argument above holds for it too. It carries a pick's briefing
  when the restatement opens that pick. The same read at a step boundary returns the conversation's pending notices, and
  the Harness appends them in the same way (below).
- **The Turn part comes last, because a model obeys what it read last.** Measured on the home-lab vLLM model: with a
  prompt that argued for a pick the Turn did not allow, the Allowed picks placed ahead of the prompt were obeyed 0/10
  (thinking off) and 5/10 (thinking on); placed after it, 10/10 both. Wording made no difference. The author's task
  still reads first, as it would with no jr2.
- **Always on.** No author can turn it off: every fact in it passes the rule above, so removing one can only make the
  Agent act worse. An `instructions` that repeats a fact is harmless.
- **A notice is heard once by each member of its audience.** A member takes it at its next admission, or at a step
  boundary of an open Turn: the surface read of the open Turn returns the conversation's pending notices, and the
  Harness appends them, as it appends a changed Allowed-picks list
  ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md), ADR-0002). For a guard
  kill that the Agent of an open Turn was not told, a member also takes it at that Turn's nudge or wake (below). A
  conversation is an Instance ID ([ADR-0057](0057-a-turn-is-its-frame-its-dials-and-whether-it-continues.md)): a fresh
  Turn, a runaway reroll and a burned conversation's successor each start a new one.
  - **Conversation scope** ("this conversation is new; earlier context is gone") goes to that Agent's next Turn. So does
    a pick's answer that never reached its call
    ([ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md)): the route left the Agent's state, and
    the next Turn of the conversation the picking Turn continued hears "the workflow left the state of your last turn
    while your pick was outstanding", with the answer — or, when something other than the route left the state while the
    pick's work ran, "your pick did not finish: the workflow left the state that asked for your last turn while it ran,
    and that stopped it" (`stopped`), with an earlier link's reply when one came. No pick-answer notice says the work
    ran to its end. A fresh picking Turn has no such conversation, and its answer is no notice.
  - **Workspace scope** ("the Sandbox's processes were killed at its memory limit during `coder`'s Turn; `/dev/shm` was
    cleared. Anything that was running in the Sandbox at that time is gone.") goes to an **audience** that the ledger
    fixes when it raises the notice. The rule is: an Agent hears a kill if it was there for it.
    1. Each conversation admitted in that Workspace before the kill that can still take a Turn: the conversation of an
       open Turn, which hears it at its next step boundary, or a continued conversation, which hears it at its next
       Turn. A fresh Turn that already ended is not in the audience.
    2. When the kill cut a specific Turn — a kill read on that Turn's stream names it — that Agent's next Turn, fresh or
       continued: the retry of the broken work.
    3. Minus each conversation whose own `bash` answer returned the kill's verdict (`told`, below). That answer told it
       already.

    Each member hears the notice once. The notice retires when every member has heard it. A conversation that starts
    after the kill does not hear it, except the retry of (2). So a Pool of coders in one Workspace
    ([ADR-0075](0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md)) all hear a kill that cut their work.
    Only a kill read on a stream while its wait is live names the Turn whose Submission ran. Both forms end with the
    whole Sandbox, because every process in it died, a shared Workspace's too, and in the past tense, because the Agent
    may hear it after processes started again. A kill read from the pod's list names no Turn and says nothing of when or
    whose: "the Sandbox's processes were killed at its memory limit (peak X of Y); /dev/shm was cleared. Anything that
    was running in the Sandbox at that time is gone." The list cannot say whose Turn a kill ended: the kill may land
    after a state exits, or end an attach, a sync or a command. A kernel kill read from the Sandbox's last end (below)
    says the same, with the limit and no peak: "the Sandbox's processes were killed at its memory limit of Y; …". A
    Menu-only Agent outside a Workspace receives conversation notices only.

  - A notice never replaces a fault. The Machine still receives `agent.fault` and decides (ADR-0016); the notice makes
    sure the next Agent is not working blind.

- **The Orchestrator is the only keeper of notices and Steering messages**: pending ones are plain data in the run's
  persisted state (ADR-0007). It sees kernel kills and fresh conversations itself. A kernel kill (ADR-0061, layer 5) has
  two paths, under one source, the Workspace and the time the Harness container ended. A Turn that the kill ended faults
  on it, and the fault raises the notice with the Turn's Agent. A kill while no Turn runs faults nothing, so before each
  admission into a Workspace the Agent actor also reads the container's last end from the Sandbox watch, which the
  operator publishes: a last end `OOMKilled` raises the notice, which names no Turn. The ledger's `seen` makes the two
  paths one notice. An actor whose own watch saw the restart reads the last end only when it re-admits the Turn after
  the cut. When the Turn faults, the fault's notice names the Turn's Agent. A watch that has not listed yet says
  nothing, and the next admission reads again: the last end stays until the container ends again. A nudge and a wake
  take no kernel kill; it stays for the next Turn. The re-admission after a cut takes it, as it takes every notice in
  scope that is not a guard kill. The Harness reports a guard kill (ADR-0061) on two paths, under one id that the
  Harness gives the kill:
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
    failure again only when a read fails after a read that worked. The file is beside the Harness's conversations, which
    no confined child can reach
    ([ADR-0076](0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md)). The bounds stay as a
    second layer: a `peak` or a `limit` that is not a size in the guard's form, or is long, is left out and logged, on
    the Harness's read of the file and on the Orchestrator's read of the list and of a stream. The kill is kept, so a
    real kill is never lost, and its notice says no sizes: "the Sandbox's processes were killed at its memory limit;
    /dev/shm was cleared. …". Only a kill with no id or no time, or one outside the bounds below, is dropped. A stream
    event from an older Harness has no id; its source is then its place on the stream, exactly as the Orchestrator
    raised it before.

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
  reads at most 256 KiB of it. The two sides hold the same bounds: an `id` and an `at` of at most 64, an `agent` and an
  `instanceId` of at most 128, and an `at` that parses as a time. A kill outside them is dropped, and a `told` entry
  outside them is left out. The Harness counts the bytes of the JSON text, and the Orchestrator counts characters, which
  are never more, so the Harness keeps no kill that the Orchestrator drops. The Harness reads at most the last 256 KiB
  of the file. With these bounds the largest list is 149,259 bytes. When more come between two admissions, the oldest is
  lost, and a newer kill tells the same thing. When more than 16 come in one Turn, the Turn's mark leaves the list too,
  and every kill in the list then counts as after the mark; a nudge or a wake of that Turn may then carry a kill from
  before it. The Instance Harness keeps no kill, because it holds no Workspace.

  A notice counts as delivered when its admission is ledgered, so a restart before that point delivers it again and a
  restart after it does not. A notice at a step boundary has no admission. The surface read of the open Turn reserves it
  for that member, and it counts as delivered, and heard, when the Harness acknowledges the append. When the Turn ends
  with no acknowledgment, the reservation is released, and the notice is pending again for that member. A reservation
  lives in the Orchestrator's memory only, so a restart forgets it: the notice is pending again, and the next read or
  admission carries it. So a conversation can hear a notice twice after a crash, as for an admission. Delivered is not
  yet heard: if the Orchestrator ends the Turn before the Harness reads its surface, the Harness never prompts it
  (ADR-0026), so the Orchestrator raises that admission's notices again. This holds for a nudge and a wake too: each one
  must have its surface read again before its notices count as heard. An admission that fails leaves the earlier
  admission's notices heard. A nudge and a wake re-prompt the Turn within itself. Of the notices, they take only the
  guard kills of the list that come after the newest kill whose `told` names their conversation. That `bash` answer told
  the Agent that all its processes died, so it covers every kill up to it. They also take no kill from before the Turn
  started. Such a kill would tell the Agent that processes it started in this Turn died. The Turn's first read of the
  list sets its mark: the id of the newest kill it saw, or "none". The mark is ledgered with every admission of the
  Turn, and a restore reads it back, so a nudge or a wake takes only kills after it. Only when the first read failed is
  the Turn's start the mark, ledgered the same way, with one second allowed for a pod clock that runs behind. A read
  that failed is "could not tell", never an empty list, so it sets no mark. The kills they do not take stay pending for
  the next Turn. The re-admission after a Harness restart cut the Turn continues the same Turn, so it takes every notice
  in scope except the guard kills that this rule leaves out. When its read could not tell, it takes no guard kill at
  all, as a nudge then takes none: it cannot know which kills its own `bash` reported. The notices that the Turn's
  admissions carried since the Harness last read the Turn's surface are pending again first, each with the source it was
  raised with, and this re-admission carries them whatever else its scope leaves out. A notice with no source merges
  only into a pending one with no source, so an equal notice of another kill never takes its place. When such an unread
  admission carried the Turn's task, the task follows the re-admit text. When the rebuilt Harness lost the conversation,
  nothing of the Turn is left: every notice that the Turn's admissions carried is pending again whatever the surface
  reads said, the re-admission takes every notice in scope, as a Turn's admission does, and the Turn's task follows the
  re-admit text. It says once that the conversation is new. A restore drops the prompt from a Turn's input, so the task
  rides the ledgered admission too; a lost conversation with no task to send faults the Turn instead. Whether the
  Harness still holds the conversation is asked again for up to 30 seconds while the new container does not listen yet
  or drains, and only then is the answer taken as "held". The continue path asks the same way, so a continued Turn after
  a restart can wait up to 30 seconds before its admission. A Harness in CrashLoopBackOff can take longer than that: the
  answer is then "held", and it can be wrong. So every admission to a conversation that the Harness was taken to keep
  says so with `kept: true`: the re-admission after a cut, a continued Turn, and a nudge or a wake. A Harness that keeps
  no such conversation refuses it with 404 and `kept: false` in the body, and seats none. The Orchestrator takes only
  that 404 as the refusal; another 404 is a failed admission. Without the refusal the Harness would seat a new
  conversation, and a model on an empty context would read "continue your task" with no task. On the refusal the Turn
  takes the path of a lost conversation. The re-admission is admitted as a Turn, with the task after the re-admit text
  and the notice that the conversation is new, or faults when it has no task to send. A continued Turn is told that its
  conversation is new, and is admitted again. A nudge or a wake is admitted again as a Turn: its prompt is the task
  alone, because nothing was cut, with the notice that the conversation is new and every notice in scope. Every notice
  that the Turn's admissions carried is pending again first, as for a lost conversation after a cut. With no task to
  send, the Turn faults. The Instance Harness's restart is on no watch, so this refusal is the only way a nudge or a
  wake learns of it. What the Turn's admissions carried, and whether the Harness read their surface, is kept in the
  Orchestrator's memory alone: after a restore of the Orchestrator before a surface read, nothing is raised again. A
  fresh Turn's "this conversation is new", which rides an admission alone, is carried again by the next re-admission
  when the Harness has not read the one before.

  A conversation whose own `bash` call answered a kill is not in that kill's audience, so it does not hear the kill
  again as a notice, at its next Turn or at a step boundary.

- **One ledger carries notices and Steering messages.** A Steering message ([ADR-0002](0002-duplex-streaming-actor.md))
  is not a notice: a notice is a fact that jr2 knows and that has no author, and a Steering message is an utterance with
  an author, which the model weighs by who wrote it. So the two are siblings on one transport. Each entry of the ledger
  is an **envelope** and a **body**. The envelope holds what the ledger delivers by: the address, the source, the
  audience, and what was reserved and heard. The body is a Notice, or a Steering message with its text and its author:
  `{ kind: "caller", via, name, onBehalfOf? }` or `{ kind: "machine", from? }`, where `from` is the Sender whose words
  the Machine relays. The rules above, heard once, reserved at a step boundary and delivered when the append is
  acknowledged, hold for both.
  - **The address is a tagged value.** `{ conversation }` and `{ workspace }` are the two kinds that notices use, and
    `{ slot }` (an Agent slot of one Machine instance of the run) is the kind that a Steering message uses. A new kind
    is an addition, and no kind changes the meaning of another's fields.
  - **A slot's audience is a future member.** A Workspace notice fixes its audience when the ledger raises it. A message
    to a slot goes to the slot's open Turn, or, when there is none, to the slot's next Turn in the same Machine
    instance, whose conversation does not exist yet at the raise. It retires, recorded "not delivered", when that
    Machine instance ends.
  - **The Harness frames a Steering message by its author.** A Caller's message is an instruction from outside the run,
    and the frame names the Caller. A message that the Machine relays `from` another Agent is information from a peer.
    The frame says that the workflow passes it on but did not write it, and a closing line after the text says that it
    is not an instruction and does not change the Agent's task: the Agent does what the workflow asked. The closing line
    is read last, after the peer's text (ADR-0029). In `peer-not-order`, a frame that said only "not an order" read 5 of
    10, because a model that obeyed read "the workflow relays" as the workflow's own word. A frame that said, ahead of
    the text only, that it was "that Agent's word, not the workflow's", read 17 of 20, and the closing line read 20 of
    20 (ADR-0066). A message that the Machine relays `from` a Gate is what the Gate received, and the frame says that it
    is not an order either. A Machine's message with no `from` is the workflow's own text. The text is quoted line by
    line, so the model sees where it starts and ends, and it follows the notices in the Turn part, ahead of the Allowed
    picks. A name in the frame (a Caller's name, its `onBehalfOf`, a peer's or a Gate's id) is a code span that its own
    text cannot close, on one line: a name comes from outside jr2 and can hold a backtick or a line break. A message
    whose author the Harness does not know is dropped, never framed as another author's.
  - **The two bodies ride the wire apart.** The admit body carries `notices` and `steering`, and the surface read
    `notices: [{ id, notice }]` and `steering: [{ id, message }]`; one acknowledgment,
    `POST /agents/:iid/notices { heard }`, hears both by their ledger ids. A nudge and a wake take notices by their
    sources, so they carry no message: the surface read that starts their Submission does.
- **The Harness writes every word.** The admit body carries typed notices
  (`notices: [{ kind: "memory-limit", scope, agent?, limit?, peak? } | { kind: "conversation-new", reason } | { kind: "pick-answer", pick, cut, answer?, stopped? } …]`,
  where `peak` comes only with `limit`) and Steering messages with their authors, and the Harness renders both parts and
  frames each message. The text of a Steering message is the author's; the frame around it is the Harness's. An
  outstanding pick's answer is data too — the last reply since the pick, a party's event with its payload or a child's
  output (ADR-0024) — and its words ("Its answer: `approve` from Gate `review`, with {…}", "No reply came back for it.")
  are the Harness's, in the receipt and in the notice alike; "it moved the workflow, and nothing ran" is a guard
  straight back's receipt alone. The standing part needs no wire: the Harness already holds its limits (cgroup and
  Downward API env), the definition's `workspace` access, and the Menu. The wording lives in one place, and Harness
  conformance checks it (ADR-0027).

## Considered options

- **Put the facts in the Frame.** Rejected: the Frame is the Machine state's (ADR-0057), and a kit that writes into it
  makes the author's prompt say things the author did not write.
- **Leave it to authors' `instructions`.** Rejected: a definition is written before any run, so it cannot know a Size a
  composer retuned, a working directory, or what happened to the last Turn — and packaged Agents would each word it
  differently or not at all.
- **An author switch** (`agent({ briefing: false })`, or notices only). Rejected: under the rule, each fact is one a
  correct Agent needs; the switch only lets the ADR-0057 failure back in.
- **Walk to `/`** (pi's own walk). Rejected: a folder above `/work` is the image's or the node's. A file there is in no
  repo and in no review, and in a Sandbox the Agents write some of those folders (`HOME`).
- **Stop at the nearest folder that holds a `.git`.** Rejected: the Agent writes its Worktree's `.git` file. If it
  removes the file, the walk goes up to the next `.git` or to `/work`.
- **A third value, `"user"`, above `"workspace"`, that also reads the image's user context.** Rejected: the image's user
  context is the image author's choice, not a level of the walk. Tied above `"workspace"`, an author who wants the
  image's context would have to accept a shared `/work` file too.
- **Read the image user's folder as it is in `HOME`** (live, in the Agents' domain). Rejected: each Agent writes it, so
  one Agent's text reaches each later Agent's system prompt, in no diff. An image could give the folder to root, but jr2
  cannot tell an image's author to, and an image built for a person's own use leaves it to that person.
- **Copy the folder out of the image at the Harness's start.** Rejected: a copy is only as safe as where it is kept. A
  folder that no process of the domain writes is one more place in the Harness container, and the Harness reads the
  image's folder in the Harness process to copy it, where a link the image has is followed. The mount is the image's own
  files, and the kernel keeps them read-only.
- **A shared, writable user context** (`userContext: "shared"`, the folder in `HOME` as it is). Not now: no Workflow
  needs Agents that leave rules to each other there. A Workflow that does would name it, and its pod would have no
  mount.
- **No user context, or the user context only by an author's switch.** Rejected: an image that has `~/.pi/agent` is an
  author's statement that its Agents read it, as the image's tools are its statement of what they run.
- **No project context** (jr2 before pi-coding-agent). Rejected: a repo's `AGENTS.md` is where its rules for each coding
  agent are, and an Agent that never reads them works against them. The rule above is for jr2's own text; the repo's
  text is the repo's, as the Frame's prompt is the Machine's.
- **The project context after the standing part, or in the Turn part.** Rejected: a model obeys what it read last, so
  the Briefing is last. In the Turn part, a file that the Agent changes would move the newest message on each Turn, and
  a repo's rules are not news.
- **pi's whole system prompt** (`buildSystemPrompt`). Rejected: its preamble, its tool snippets and its rules are for
  pi's own CLI. jr2 takes only the two sections, in pi's frame, and its own text stays jr2's.
- **Load it in the Harness process.** Rejected: the Agent writes its Worktree, so an `AGENTS.md` that links to a file
  under `/run/jr2` would put the control Stand-in in the prompt.
- **Load it again at each Submission.** Rejected: an Agent that edits `AGENTS.md` would move the system prompt, and the
  provider's prefix cache would miss on each later request.
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
- **A Steering message as a kind of notice.** Rejected: a notice is a fact with no author, and the Harness words it. A
  Steering message is an author's text, and the model must weigh a Caller's instruction and a peer's word differently.
  Folded into a notice, the author and that difference have no place.
- **The Harness words the kill into the next Turn itself.** Rejected: a second keeper of notices, outside the run's
  persisted state, which cannot know when an admission is ledgered or heard.

## Consequences

- ADR-0060's CPU fact and ADR-0061's memory-limit notice are the Briefing's first users.
- The project context changes what the model reads, so the `@model` tier must pass on it
  ([ADR-0066](0066-a-model-tier-runs-a-real-model-and-a-change-to-what-it-reads-runs-the-tier.md)). A pi bump can change
  which files load and their frame. jr2 writes the frame itself (`projectContextText`), as a copy of pi's, because the
  package root does not export pi's: a unit test compares the copy with the sections that pi's own system prompt builds
  at the pin, so a bump that moves the frame fails it.
- Each conversation in a Worktree starts one node child per folder, about half a second before its first request.
- `jr2 up` reads each Sandbox Image that it builds once more for the user context: a container that it creates and does
  not start, and one `docker cp` header for each folder of the path. Each Sandbox pod whose image has the folder mounts
  the image twice.
- Each admission into a Workspace costs one more request to its Harness, `GET /memory-kills`. The first read from a
  Harness that fails is said in one line of the Orchestrator's log.
- The no-signal nudge stays a re-prompt within a Turn (ADR-0016); it is not a notice.
- The Briefing is how a Turn learns its Allowed picks: the tools block is the whole Menu, fixed for a conversation so it
  does not break the cache
  ([ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)).
- A Workspace notice reaches each conversation that was there for the kill, and the retry of the Turn that it cut; an
  open Turn hears it at its next step boundary, not only at its next admission (ADR-0002,
  [ADR-0029](0029-a-menu-is-fixed-for-a-conversation-and-a-turn-is-told-its-allowed-picks.md)). So a memory kill reaches
  every coder of a Pool that shares one Workspace (ADR-0075).
- GLOSSARY.md gains **Briefing**.
