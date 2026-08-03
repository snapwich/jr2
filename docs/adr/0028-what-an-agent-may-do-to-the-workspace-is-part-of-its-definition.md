# What an Agent may do to the Workspace is part of its definition

j2 is exact about what an Agent may **say** and silent about what it may **do**. The control plane is a menu the Machine
sets per turn — derived from the invoking state's transitions
([ADR-0015](0015-authoring-surface-absorbs-the-mechanism.md)), served from a separate container
([ADR-0013](0013-adapter-hosts-the-agent-mcp-surface.md)), unforgettable by construction
([ADR-0016](0016-agent-turn-mechanics-are-internal.md)). The data plane is one identical working toolset with full write
access to the shared Workspace, for every Agent, in every state.

The gap is not hypothetical. In a live `task-with-review` run (2026-07-27), the coder found nothing to do and committed
nothing; the reviewer then edited `README.md`, set a `user.email`, committed, and approved its own commit — against
instructions that say "Do not modify the code yourself".
[ADR-0024](0024-an-agents-turn-ends-with-the-state-that-asked-for-it.md) already established what that means: the same
prompt, model, and state produce compliance on one run and not the next, "which is what rules out fixing this with
words." The prose ban is a persona, not a boundary. ADR-0024 also named the stakes — an Agent with write access is a
concurrent writer in a Workspace the Machine believes is single-threaded — and
[ADR-0012](0012-workspace-wrapper-machine.md) puts coder and reviewer in that one Workspace on purpose.

Under the retired flue runtime this had no seat — its tool list was take-it-or-replace-it, and the only recorded out was
ejecting to a foreign harness project. [ADR-0027](0027-the-harness-is-j2s-own-server-flue-retires-the-wire-stays.md)
retires that constraint: j2 assembles the working tools per Submission, so what an Agent may do is finally something a
definition can state.

## Decision

- **`AgentDefinition` gains `access?: "write" | "read"`, default `"write"`.** One word that describes the persona — a
  reviewer reads — not a tool inventory. It is deliberately **not** named `tools`: that word already means the
  control-plane menu at the invoke seam (`actor.ts`'s escape hatch) and would name the Harness's menu rather than the
  Agent. A string field, JSON-serializable, riding the existing ConfigMap channel unchanged (ADR-0018's constraint
  holds).
- **The tool layer enforces the honest path.** `access: "read"` withholds `write` and `edit` from the assembled working
  tools (pi's journaled active-tool set). `bash` stays — the reviewer's own instructions require running the tests — and
  the ADR says plainly what that means: a shell can write, so the tool layer states intent and stops the honest path. It
  is known leaky, and it is not the guarantee.
- **The worktree layer contains the blast radius: a reviewer works in a detached review worktree.** The attach step —
  already j2-owned (`sandbox-kubectl.ts`'s `attachScript`) — adds a worktree at the sha under review with a detached
  HEAD, sibling to the branch worktree per the Project layout. A write there cannot move the branch or dirty the coder's
  worktree; a rogue commit lands on a detached HEAD and evaporates with the checkout. This is not a permission boundary
  — it is containment, the property ADR-0024 bought for turns, bought for the filesystem.
- **Two layers, one structure: the tool list is the hint, the worktree is the guarantee** — the same shape as ADR-0024's
  receipt (hint) and abort (guarantee). Neither layer alone: tools without the worktree leak through bash; the worktree
  without tools invites the model to fight its checkout instead of declining politely.
- **The reviewing state requests the review worktree per round.** The sha under review moves between rounds, so the
  detached worktree is attached (idempotently, by sha) on entry to the reviewing state, and its path frames the
  reviewer's turn — cwd and prompt — instead of the branch worktree. The exact Workspace-port verb is settled at
  implementation; what is decided here is the seat: worktree mechanics stay in the attach step and the Workspace
  wrapper, never in Agent instructions.

## Considered options

- **Prose alone** (today). Rejected by the incident; the coin flip is already on record.
- **A `SessionEnv` wrapper that throws on denied operations.** The right stopgap against the retired runtime's fixed
  toolset — ~20 lines, no drift — and moot the day j2 owns tool assembly. Building and testing a mechanism the
  replacement deletes was the argument for folding this decision into ADR-0027.
- **Wait for flue 2.0's tool exports.** Rejected with ADR-0027.
- **A read-only filesystem for the reviewer.** Rejected: the reviewer must run tests and builds, which write caches,
  `node_modules`, temp files. Read-only breaks the persona's own job description.
- **A separate reviewer Sandbox.** Rejected: it pays a pod per review round and breaks ADR-0012's premise — coder and
  reviewer share one Workspace so the review sees exactly the bytes the coder produced, on the shared clone's economics.
- **Naming the field `tools: ["read", "grep", ...]`.** Rejected: it names the Harness's menu, breaks when a tool is
  renamed, and says nothing about the Agent. `access` describes the persona; the tool list is derived mechanism.

## Consequences

- **The reviewer definition becomes `access: "read"`**, and the prose ban stays in its instructions as intent — the half
  of the contract a model reads — no longer as the mechanism.
- **The definition stays plain data.** No code enters the ConfigMap channel; composition by re-export/spread (ADR-0018)
  is preserved. Custom tool _implementations_ remain out of the contract — this decision adds a restriction vocabulary,
  not an extension one. Growing extension tools is a separate, later decision.
- **CONTEXT.md arbitrates the three senses of "tools"**: the Menu (control plane — what an Agent may say) and Working
  tools (data plane — what it may do) become glossary entries; unqualified "tools" joins the Avoid lists.
- **The `@kind` tier gains the containment scenario**: from the review worktree, a write probe followed by a commit must
  leave the branch ref and the coder's worktree untouched.
- **The zero-support guard stays available to workflows**: a workflow can still have both Agents report the sha and gate
  on `event.head === context.head`. Self-reported and unenforced — but it catches the exact incident above, and it needs
  nothing from this ADR.
