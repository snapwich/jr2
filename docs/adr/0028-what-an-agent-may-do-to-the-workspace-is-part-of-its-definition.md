# What an Agent may do to the Workspace is part of its definition

jr2 is exact about what an Agent may **say** and silent about what it may **do**. The control plane is a menu the
Machine sets per turn — derived from the invoking state's transitions
([ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md)), served from a separate container
([ADR-0013](0013-the-agent-reaches-its-machine-through-a-container-it-cannot-read.md)), unforgettable by construction
([ADR-0016](0016-agent-turn-mechanics-are-internal.md)). The data plane is one identical working toolset with full write
access to the shared Workspace, for every Agent, in every state.

The gap is not hypothetical. In a live `task-with-review` run (2026-07-27), the coder found nothing to do and committed
nothing; the reviewer then edited `README.md`, set a `user.email`, committed, and approved its own commit — against
instructions that say "Do not modify the code yourself".
[ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md) already established what that means: the same
prompt, model, and state produce compliance on one run and not the next, "which is what rules out fixing this with
words." The prose ban is a persona, not a boundary. ADR-0024 also named the stakes — an Agent with write access is a
writer that the Machine did not plan for — and [ADR-0012](0012-workspace-wrapper-machine.md) puts coder and reviewer in
one Workspace on purpose.

Under the retired flue runtime this had no seat — its tool list was take-it-or-replace-it, and the only recorded out was
ejecting to a foreign harness project. [ADR-0027](0027-the-harness-is-jr2s-own-server-flue-retires-the-wire-stays.md)
retires that constraint: jr2 assembles the working tools per Submission, so what an Agent may do is finally something a
definition can state.

## Decision

- **`AgentDefinition` gains `workspace?: "write" | "read" | "none"`, default `"write"`.** One word that describes the
  persona — a reviewer reads, a decisioner needs no Workspace at all — not a tool inventory. It is deliberately **not**
  named `tools`: that word already means the control-plane menu at the invoke seam (`actor.ts`'s escape hatch) and would
  name the Harness's menu rather than the Agent. And it is named for the thing accessed: the field was first shipped as
  `access`, and `"none"` exposed the dropped word as load-bearing — access _to what?_ The object was always the
  Workspace (it is this ADR's title). A string field, JSON-serializable, riding the existing ConfigMap channel unchanged
  (ADR-0018's constraint holds).
- **`"none"` is the Menu-only Agent — and the value also names the Harness that hosts the Agent.** `"none"` withholds
  the entire Working toolset: the Agent converses, picks from its Menu and calls the MCP tools of the remote servers it
  names
  ([ADR-0079](0079-an-agent-holds-mcp-tools-a-machine-calls-them-as-an-effect-and-the-machine-is-the-approval.md)), and
  runs no code — the decisioning persona (read inputs, pick the next event). "Menu-only" means "no Working tools": such
  an Agent can also hold MCP tools. Because such an Agent touches no Workspace, it does not run in one:
  `"write"`/`"read"` place a Turn on the enclosing Workspace's Harness; `"none"` places it on the
  [Instance Harness](0031-menu-only-agents-run-on-the-instance-harness.md), always — even when a `workspace()` encloses
  the invocation. Placement is definitional, which is this ADR's thesis extended one step: what an Agent may do to the
  Workspace decides where it runs. (`cwd` is moot for `"none"` — only Working tools consume it.)
- **The tool layer enforces the honest path.** `workspace: "read"` withholds `write` and `edit` from the assembled
  working tools (the tool set that the Harness gives the loop for each Submission). `bash` stays — the reviewer's own
  instructions require running the tests — and the ADR says plainly what that means: a shell can write, so the tool
  layer states intent and stops the honest path. It is known leaky.
- **The worktree layer keeps the honest path off the branch: a reviewer works in a detached review Worktree.** The
  Machine cuts it with `worktree()`, `{ path, detach: sha }`, at the sha under review, with a detached HEAD, sibling to
  the coder's Worktree per the Project layout
  ([ADR-0075](0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md)). A write there does not move the branch
  or dirty the coder's Worktree; a stray commit lands on a detached HEAD and goes when the next cut forces the folder.
  This is not a permission boundary. The reviewer's `bash` still reaches all of `/work`.
- **Two layers for the honest path: the tool list states the intent, and the worktree keeps a stray write off the
  branch.** Neither layer alone: tools without the worktree leak through bash; the worktree without tools invites the
  model to fight its checkout instead of declining politely. Neither layer is a boundary between Agents (below).
- **The Sandbox is the security boundary, and inside it the Agents have free rein.** The Agents of one Workspace share
  `/work`, the clone's config and objects, one uid and one Landlock domain
  ([ADR-0076](0076-an-agents-control-credential-lives-only-where-no-workspace-code-runs.md)). Each one can write in each
  Worktree, make its own Worktrees and branches, and run its own programs and workflows. jr2 separates their identities
  (the control credential, ADR-0076), not their files. The `workspace` value, the review Worktree, the cut's rules
  (ADR-0075) and the rules for the project context
  ([ADR-0062](0062-jr2-briefs-the-agent-on-its-seat-never-on-its-task.md)) keep an honest Agent on its path. They do not
  stop an Agent that sets out to change what another Agent reads, and jr2 adds no defense whose only job is that.
- **Everything that a Sandbox puts out is untrusted**: its commits and pushes, its Handoffs, its Menu picks and their
  arguments, and its messages. jr2 carries out of a Sandbox exactly what the Machine chose, and finds each fact that it
  acts on in its own records, not in the Sandbox: the branch of a push in the cut's row (ADR-0075), and the whole
  Handoff in the run's ledger ([ADR-0080](0080-a-nested-workspace-takes-a-handoff-at-its-cut.md)). Nothing that an Agent
  wrote steers jr2's own processes (the cut, the sync, the bundle step, the Orchestrator) to do more than the Agent
  could do itself.
- **A quick review runs in one Workspace, and an independent review runs in a nested one.** The coder and the reviewer
  of one Workspace are a quick loop. A final review that the author trusts runs in a nested `workspace()` that the body
  invokes: a new Agent in a new Sandbox, which takes the commit as a Handoff at its cut and sees nothing else of the
  parent Sandbox (ADR-0080). The final reviewer runs the code in its own Sandbox.
- **An MCP allowlist is a guarantee about the credential, and jr2 offers it only where it can keep it.** An Agent's MCP
  tools ([ADR-0079](0079-an-agent-holds-mcp-tools-a-machine-calls-them-as-an-effect-and-the-machine-is-the-approval.md))
  spend the server's token, so the allowlist guards that token, not the Workspace. A remote server needs a list (tool
  names, or `"*"`): the Harness offers and runs only those tools. Where Workspace code of the Sandbox in which the
  Agent's Turns run can spend that secret, Workspace code can call every tool, so `jr2 up` refuses a list and takes only
  `"*"`. That is the case when the Sandbox's `workspace()` grants the secret, when a credentialed `command` of that
  Workspace names it, or when an `http` Effect of that Workspace whose body is a Worktree file names it: the Agent
  writes that body ([ADR-0068](0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md)). A `"none"` Agent's
  Turns run on the Instance Harness, where no Workspace code runs, so it keeps its list. A stdio server runs as
  Workspace code and gets no list. The token's own scopes are the outer limit. This is not the shape of
  `workspace: "read"` above: there the tool list is the hint, because `bash` can write; here the list is the guarantee,
  because no Workspace code can spend the secret.
- **A state before the reviewing state cuts the review Worktree on each round.** The sha under review moves between
  rounds, so each round cuts the one folder again at the new sha. The cut forces the folder to the commit and cleans it
  with `-ffd`, from a git folder of its own, so no config, attributes file or index that an Agent wrote changes the
  files. Files that a `.gitignore` in the Worktree ignores stay, because the reviewer runs the tests and keeps its tools
  (a `.venv`) from round to round, except the context files and skills that pi reads (ADR-0075). So a `.gitignore` that
  another Agent wrote also keeps the files that it ignores, which the Sandbox boundary above accepts. The folder's path
  frames the reviewer's turn — cwd and prompt — instead of the coder's Worktree. What is decided here is the seat:
  worktree mechanics stay in `worktree()` and the Machine's states, never in Agent instructions.

## Considered options

- **Prose alone** (today). Rejected by the incident; the coin flip is already on record.
- **A `SessionEnv` wrapper that throws on denied operations.** The right stopgap against the retired runtime's fixed
  toolset — ~20 lines, no drift — and moot the day jr2 owns tool assembly. Building and testing a mechanism the
  replacement deletes was the argument for folding this decision into ADR-0027.
- **Wait for flue 2.0's tool exports.** Rejected with ADR-0027.
- **A read-only filesystem for the reviewer.** Rejected: the reviewer must run tests and builds, which write caches,
  `node_modules`, temp files. Read-only breaks the persona's own job description.
- **A review Workspace of its own, as the default.** Not the default: one Workspace is cheaper, and ADR-0012's premise
  is that coder and reviewer share one Workspace, so the quick review reads the bytes the coder produced, on the shared
  clone's economics. A nested Workspace costs a pod, an attach, a clone and a second install of the dependencies for
  each round, and the author chooses it for the final review (ADR-0080).
- **A Landlock domain for each Agent, in which the Agent writes only the Worktrees cut for it**, with a clone for each
  Worktree. Rejected. It needs an ownership surface on the cut, a clone and an install for each Agent, a copy of `HOME`
  for each Agent, and about 600 to 1000 lines of jr2 code. Its denials are invisible to the Agent (`test -w` says yes,
  and the write fails with a bare `EACCES`), so it costs the Agents work. And it is still best effort: Landlock does not
  cover `chmod`, `utime` or xattrs, and `/tmp`, `/dev/shm`, the ports and the image's folders stay shared, and signals
  stay open below ABI 6. The Sandbox is a boundary that the kernel and Kubernetes keep whole, and a nested Workspace
  gives an independent review the same boundary.
- **Naming the field `tools: ["read", "grep", ...]`.** Rejected: it names the Harness's menu, breaks when a tool is
  renamed, and says nothing about the Agent. `workspace` describes the persona's relationship to the thing it works in;
  the tool list is derived mechanism.
- **Keeping the name `access`.** Rejected when `"none"` arrived: without the object in the name, `access: "none"` reads
  as "no access to anything," which is false — the Agent has its full Menu. `workspace: "none"` states exactly what is
  absent, and doubles as the placement statement above.

## Consequences

- **The reviewer definition becomes `workspace: "read"`**, and the prose ban stays in its instructions as intent — the
  half of the contract a model reads — no longer as the mechanism. A decisioner becomes `workspace: "none"`.
- **The definition stays plain data.** No code enters the ConfigMap channel; composition by re-export/spread (ADR-0018)
  is preserved. Tool _implementations_ stay out of the contract — this decision adds a restriction vocabulary, not an
  extension one. The extension is MCP: an Agent names servers, and a server holds the code (ADR-0079).
- **GLOSSARY.md arbitrates the senses of "tools"**: the Menu (control plane — what an Agent may say), Working tools
  (data plane — what it may do) and MCP tools (what it may do through a service, ADR-0079) are glossary entries;
  unqualified "tools" joins the Avoid lists.
- **The `@kind` tier has the review Worktree scenario**: from the review worktree, a write probe followed by a commit
  leaves the branch ref and the coder's worktree untouched.
- **The zero-support guard stays available to workflows**: a workflow can still have both Agents report the sha and gate
  on `event.head === context.head`. Self-reported and unenforced — but it catches the exact incident above, and it needs
  nothing from this ADR.
