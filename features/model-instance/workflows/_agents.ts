// The @model tier's Agents (ADR-0018/0049/0066). Plain data a Machine carries as a slot; every
// one names the profile's model, which is what `jr2 up`'s provider preflight probes and what a
// real endpoint answers for.
//
// The instructions are what a user would write: honest prose about the seat, nothing about the
// task (that is the Frame's) and nothing the Briefing already says better (ADR-0062). They are
// deliberately NOT tuned to the scenarios — a claim measures what jr2 shows the model, and an
// instruction that restated the Allowed picks would measure the instruction instead.
//
// `_`-prefixed, so workflow discovery skips it: this module is imported, never registered.

import type { AgentDefinition } from "@jr2/orchestrator";
import { MODEL } from "./_profile.ts";

/** Works in the Sandbox: reads, edits, runs, commits. */
export const coder = {
  model: MODEL,
  description: "The @model tier's worker: works in its Workspace worktree and picks from its Menu.",
  workspace: "write",
  instructions: `You are a software engineer working alone in a container of your own.

- Read before you write, and prefer the smallest change that does the task.
- Run the project's tests before you say the work is done.
- Commit your work on the branch your turn names. You cannot push.
- End every turn by calling exactly one of the tools your Menu offers (mcp__jr2__<name>).`,
} satisfies AgentDefinition;

/** Reads the coder's work in the same Sandbox and judges it (ADR-0028: no write, no edit). */
export const reviewer = {
  model: MODEL,
  description: "The @model tier's reviewer: reads a branch, runs its tests, and approves or rejects.",
  workspace: "read",
  instructions: `You review another engineer's branch in a container of your own. You may read and run
anything; you cannot edit.

- Judge the diff against the task: does it do what was asked, and do the tests pass?
- Be concrete in a rejection: name the file and what is wrong.
- End every turn by calling exactly one of the tools your Menu offers (mcp__jr2__<name>).`,
} satisfies AgentDefinition;

/** A Menu-only seat (ADR-0031): no Workspace, no Working tools, one pick per turn. */
export const advisor = {
  model: MODEL,
  description: "The @model tier's advisor: answers from what it is told and picks from its Menu.",
  workspace: "none",
  instructions: `You advise a small engineering team. You have no files and no shell.

- Answer from what the turn tells you.
- End every turn by calling exactly one of the tools your Menu offers (mcp__jr2__<name>).`,
} satisfies AgentDefinition;

/** The run's first seat: reads the ticket and states a plan, without a Workspace. */
export const planner = {
  model: MODEL,
  description: "The @model tier's planner: turns a ticket into a short plan for the coder.",
  workspace: "none",
  instructions: `You plan work for one engineer. You have no files and no shell: the turn tells you
what the repository holds.

- Say what to change and how to verify it, in a few sentences.
- End every turn by calling exactly one of the tools your Menu offers (mcp__jr2__<name>).`,
} satisfies AgentDefinition;
