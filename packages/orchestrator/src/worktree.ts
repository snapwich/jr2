// `worktree()`, the kit Effect that cuts a Worktree, and the
// path types that carry a body's Repo Slots to every Worktree input.
//
// A Worktree is a folder, `/work/<slot>/<name>`. The Workspace clones only; the Machine cuts. The cut
// runs on the `command` machinery: a kit program (`packages/harness/src/cut.ts`) on the runtime
// volume, no new wire kind, marked idempotent, so a restore that finds no exec sends it again with
// the same id. What an Agent's param can cause settles as `refused`, never `onError` (ADR-0067). A
// settled `ready` row keeps the slot, the path and the branch as fields: a push reads its branch
// there, because the row's output drops its tail and a name in an input is a Chart's word.

import { z } from "zod";
import type { Duration, EffectLogic, ExecPortFactory, LaterOutcome, Unknown } from "./effect.ts";
import { commandWith } from "./effect.ts";
import { createExecPort } from "./harness-client.ts";
import type { Handoff, HandoffCarrier } from "./handoff.ts";
import { handoffCarrier } from "./handoff-carry.ts";

/** What a Worktree's name may start with: neither `.` nor `-`, and not the end of the path. */
type NameStart =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z"
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z"
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "_";

/** A Worktree of any Repo Slot: what a kit factory states, before `jr2Setup` narrows it to the
 * slots of the body. */
export type AnyWorktreePath = `/work/${string}/${string}`;
/** A Worktree of the Repo Slots `S`. One segment below the slot, that starts with a letter, a
 * digit or `_`: `${context.workspace.repos.app}/run`. The compiler sees the start of the name; a
 * `/` further on is the Effect's own refusal. */
export type WorktreePath<S extends string> = `/work/${S}/${NameStart}${string}`;
/** A Turn's Frame: a Worktree, or `/work`, stated. `jr2Setup` narrows it to the body's slots. */
export type AnyFramePath = "/work" | `/work/${string}`;
/** A Turn's Frame in a Workspace with the Repo Slots `S`. */
export type FramePath<S extends string> = WorktreePath<S> | "/work";

/** A pick param that names a branch: the rule the cut and the push share, as one JSON-schema
 * pattern, so that a bad name is refused at the Menu, and the Agent can correct it. */
export const BRANCH_NAME =
  /^(?!\/)(?!HEAD$)(?!refs\/)(?!origin\/)(?![0-9a-f]{7,40}$)(?!.*\.\.)(?!.*\/\/)(?!(?:.*\/)?[.-])(?!.*\.lock(?:\/|$))(?!.*[./]$)[A-Za-z0-9._/-]+$/;

/** A kit schema for a pick param that names a branch. For example:
 * `input: z.object({ branch: branchName })`. */
export const branchName = z.string().regex(BRANCH_NAME, "a branch name git and jr2's push both take");

/** The input of a `worktree()`: a branch Worktree, a detached one, or a branch Worktree at a
 * {@link Handoff}. */
export type WorktreeInput =
  | {
      /** The root of the Worktree: `${context.workspace.repos.app}/<name>`, a constant word. */
      path: AnyWorktreePath;
      /** The branch. It resolves as a local branch, then `origin/<branch>` (tracked), then a new
       * branch. */
      branch: string;
      /** Where a new branch starts. Default: the Binding's base. On a branch that exists, it must
       * be that branch's tip, or the cut is `refused`. */
      from?: string;
      detach?: never;
      handoff?: never;
      expect?: never;
    }
  | {
      path: AnyWorktreePath;
      /** The commit to check out, with no branch. The Worktree is forced to it and cleaned on each
       * cut. Ignored files stay, so that a reviewer can run the tests. */
      detach: string;
      branch?: never;
      from?: never;
      handoff?: never;
      expect?: never;
    }
  | {
      path: AnyWorktreePath;
      /** The commit of a `ready` cut of an enclosing Workspace of this run, which this nested
       * Workspace takes (ADR-0080). The cut checks each field against the run's ledger. */
      handoff: Handoff;
      /** The branch of the new Worktree. Default: the Handoff's branch. A detached Handoff needs
       * it. */
      branch?: string;
      detach?: never;
      from?: never;
      expect?: never;
    };

/** What a cut found. `held`: a cut made this Worktree earlier, so what is in it is earlier work;
 * `local`, a local branch; `remote`, `origin/<branch>`, now tracked; `none`, a new branch with no
 * upstream; `commit`, a detached cut; `handoff`, a branch at a Handoff's commit. Open: a later
 * value does not break an author's code. */
export type WorktreeFound = "held" | "local" | "remote" | "none" | "commit" | "handoff" | (string & {});

export type WorktreeReady<S extends string = string> = {
  outcome: "ready";
  slot: S;
  path: WorktreePath<S>;
  /** The branch of the cut, from git and the cut's record, never from the folder or HEAD. `null`
   * when the Worktree is detached. */
  branch: string | null;
  /** The tip of `branch` (of the commit, when detached). Never HEAD. */
  head: string;
  found: WorktreeFound;
  /** ADR-0053's words when the remote did not answer. The cut used what the clone holds. */
  stale?: string;
};

/** No Worktree, and nothing changed. The cause is a bad path, a name git or the push refuses, a
 * re-cut that does not agree with the first, a branch that another Worktree holds, an `expect` that does not hold, a
 * name that the remote cannot confirm, or a Handoff that the run's ledger does not hold. */
export type WorktreeRefused = { outcome: "refused"; reason: string };

/** The output of a `worktree()`. `unknown`: its state exited while it ran, or the cut did not end. */
export type WorktreeOutput<S extends string = string> = WorktreeReady<S> | WorktreeRefused | Unknown | LaterOutcome;

/** Is it `ready`? For a guard. A Chart's form is the guard `jr2.ready`. */
export const isReady = <O extends { outcome: string }>(output: O): output is Extract<O, { outcome: "ready" }> =>
  output.outcome === "ready";

/** The `ready` output of an `onDone` arm that `isReady` guards. xstate carries no guard's narrowing
 * to its actions, so an `assign` reads the output through this. */
export function readyOf<O extends { outcome: string }>(output: O): Extract<O, { outcome: "ready" }> {
  if (output.outcome !== "ready") throw new Error("readyOf: the output is not ready: guard the arm with isReady");
  return output as Extract<O, { outcome: "ready" }>;
}

/** The options of `worktree()`. */
export type WorktreeOptions = {
  /** `"new"`: refuse a branch that exists, local or on the remote. For a name that a planner or a
   * door chose for new work: a collision is a refusal, not someone else's branch. `"existing"`:
   * refuse a branch that does not exist, and make nothing. For a run that must continue a branch.
   * A Chart cannot change it, and a cut lent to a Chart must state it. */
  expect?: "new" | "existing";
  /** How long the fetch and the cut can take. Default `"10m"`. A cut at a Handoff carries its
   * files before the cut starts, and this time does not include the carry: the carry has a time of
   * its own (ADR-0080). */
  timeout?: Duration;
};

/** Over an injected port: the seam of the tests. `carrier` carries the files of a Handoff
 * (ADR-0080). With none, nothing is carried, and the cut takes a Handoff's commit from its clone. */
export function worktreeWith(
  portFactory: ExecPortFactory,
  options: WorktreeOptions = {},
  carrier?: HandoffCarrier,
): EffectLogic<WorktreeInput, WorktreeOutput> {
  return commandWith(
    portFactory,
    ["/opt/jr2/bin/node", "/opt/jr2/src/cut.ts"],
    { timeout: options.timeout ?? "10m" },
    undefined,
    { ...(options.expect !== undefined ? { expect: options.expect } : {}) },
    carrier,
  ) as unknown as EffectLogic<WorktreeInput, WorktreeOutput>;
}

/**
 * Make a `worktree` Effect: it cuts a Worktree of a Repo Slot, or reads the one that is there. Put it
 * in `actors`, and invoke it from a `workspace()` body.
 *
 * With `{ path, branch, from? }`, the branch resolves in this order, after a fetch: a local branch;
 * `origin/<branch>`, tracked; a new branch from `from` or the Binding's base, with no upstream. With
 * `{ path, detach }`, the Worktree is forced to that commit and cleaned, each time. `path` is exactly
 * `/work/<slot>/<name>`. Each outcome is output: `ready`, `refused`, `unknown`.
 *
 * With `{ path, handoff, branch? }`, in a nested Workspace, the cut makes a branch Worktree at the
 * {@link Handoff}'s commit: the `ready` output of a cut of an enclosing Workspace, which came in
 * through the door (ADR-0080). The branch is `branch`, or the Handoff's branch, and it tracks
 * `origin/<branch>` when the clone holds that branch. `found` is `"handoff"`. A re-cut of the path
 * with the same Handoff is `held`; with another Handoff, it is `refused`. jr2 trusts no field of a
 * Handoff: the cut finds it in the run's ledger, and refuses it when a fact does not agree. The
 * commit must be the head of a `ready` cut of that path in an enclosing Workspace of this run (an
 * earlier `ready` cut of the path is good too), on the Handoff's branch, in the same Repo. A
 * Handoff of the nested Workspace's own cut, of a sibling or of another run is `refused`. A
 * detached Handoff needs `branch`. `expect` applies to the branch, as at a branch cut. Each round
 * of a final review is a new nested Workspace: invoke it after the parent leaves the state that
 * invoked the last one, or the new one takes over the last one's Sandbox and its cut.
 *
 * `expect` says if the branch can exist: `worktree({ expect: "new" })` refuses a branch that exists,
 * and `worktree({ expect: "existing" })` refuses a branch that does not exist. A run cannot change it.
 *
 * A cut needs a Repo Slot. Under a Workspace with no Repo Slot, `jr2 up` refuses it, and the invoke
 * fails with `worktree "<slot>" runs under a Workspace with no Repo Slot: a cut makes a Worktree of a
 * Repo Slot, and there is none — declare one: repos: { app: "<url>" } (ADR-0075)`.
 *
 * @param options - Optional. `expect`, and `timeout`, how long the fetch and the cut can take.
 *   Default: `"10m"`. The carry of a Handoff's files, before the cut, has a time of its own.
 * @returns The actor logic of the Effect's slot. Its output is a {@link WorktreeOutput}.
 *
 * @example
 * ```ts
 * import { fail, isReady, jr2Setup, worktree, type Workspaced } from "@jr2/orchestrator";
 *
 * type BodyInput = Workspaced<{ branch: string }, "app">;
 * const tree = (context: BodyInput) => `${context.workspace.repos.app}/fix` as const;
 *
 * export const body = jr2Setup({
 *   types: {} as { input: BodyInput; context: BodyInput },
 *   actors: { cut: worktree({ expect: "new" }), fail: fail() },
 * }).createMachine({
 *   context: ({ input }) => input,
 *   on: { "workspace.lost": ".notCut" },
 *   initial: "cutting",
 *   states: {
 *     cutting: {
 *       invoke: {
 *         src: "cut",
 *         input: ({ context }) => ({ path: tree(context), branch: context.branch }),
 *         // The last arm has no guard: it takes `refused`, `unknown` and each later outcome.
 *         onDone: [{ guard: ({ event }) => isReady(event.output), target: "done" }, { target: "notCut" }],
 *       },
 *     },
 *     done: { type: "final" },
 *     notCut: { invoke: { src: "fail", input: { reason: "the Worktree was not cut" } } },
 *   },
 * });
 * ```
 *
 * @see docs/guides/cut-a-worktree.md
 * @see docs/guides/review-in-a-nested-workspace.md
 * @see docs/concepts/workspaces.md
 * @see docs/concepts/effects.md
 * @see docs/reference/decisions/0075-a-machine-cuts-a-worktree-and-the-workspace-only-clones.md
 * @see docs/reference/decisions/0080-a-nested-workspace-takes-a-handoff-at-its-cut.md
 */
export function worktree(options: WorktreeOptions = {}): EffectLogic<WorktreeInput, WorktreeOutput> {
  return worktreeWith(
    (endpoint, bearer) => createExecPort({ baseUrl: endpoint, ...(bearer ? { token: bearer } : {}) }),
    options,
    handoffCarrier(),
  );
}
