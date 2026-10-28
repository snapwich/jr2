// The Effect (ADR-0067): work a Machine does outside itself, as an ACTOR SLOT beside `agent()` —
// `actors: { tests: command(["pnpm", "test"]) }`, invoked as `src: "tests"`. Being an actor gives,
// from xstate and nothing new: the Effect stops when its state exits, a typed `onDone` output to
// route on, the input kept in the persisted snapshot, a `src` typo as a compile error, and
// `.provide()` as the unit-test seam.
//
// The kinds: `command`, run in the Harness container of the enclosing Workspace's Sandbox (the
// Harness's `/exec/:id`, ADR-0067), here; `http`, run in the Instance Effector (http-effect.ts,
// ADR-0068); `push`, in the Sandbox Effector (sandbox-effect.ts); and `dispatch`, which starts a run
// of a registered Workflow, in the Orchestrator's own process or, toward another Orchestrator, in
// the Instance Effector (dispatch-effect.ts, ADR-0071). What this module adds to xstate is what makes an Effect safe to
// restart:
//
//   - THE LEDGER. The run host keeps one row per Effect, in the run's blob beside the snapshot
//     (`RunBlob.effects`): an INTENT row written before the call — in the same persist as the
//     snapshot whose state invoked it, saved at the write — and a SETTLED row written with the
//     output, saved at the write before the transition it drives and kept by the save that carries
//     that transition. A restore reads the row, never guesses: settled → deliver the output;
//     intent → re-attach to the exec by id, or, when the Harness no longer knows it, settle
//     `unknown`; no row → nothing left, so it starts. A command never runs twice: it runs the
//     Agent's code, which may spend a Stand-in. No row is dropped: the settled and aborted rows keep
//     id, kind and outcome for the run's life, the record of what the run's Effects did. A settled
//     row's output tail is dropped once the save that carries its transition is on disk
//     (`dropSavedTails`): the full stream is on the feed.
//   - D1. The Effect stops when its state exits — xstate stops the child, and this logic kills the
//     exec's process group: the kill is sent until the Harness keeps it, and a kill that arrives
//     before its start keeps that start from running (a fast exit). The abort goes to the ledger
//     and the feed, "outcome unknown"; the Machine does not get it, because the state that asked
//     has left. Two stops are NOT exits: the host parking the run (`hostStopping`, ADR-0024) and an
//     Orchestrator that dies (it stops no actor) — the Effect re-attaches on restore, or settles
//     `unknown`. There is no "finally": cleanup is a state.
//   - EVERY OUTCOME IS OUTPUT: `exited | timeout | killed | unknown`. `onError` is a jr2 or config
//     defect only — a command outside a Workspace, an argv slot with no value.
//
// The port factory is the dependency, as for `agentActorWith`: `commandWith(() => fake, argv)` is
// the seam, and `command()` (bound to the real wire client) lives in harness-client.ts.

import { randomUUID } from "node:crypto";
import type { ActorLogic, AnyActorRef, EventObject, Snapshot } from "xstate";
import { ambientHandlesFor, type AmbientHandles } from "./ambient.ts";
import { boundRun, type AnyActorSystem } from "./registration.ts";
import type { HttpMethod, HttpOutput, TextPart, WireAuth } from "./effector-wire.ts";
import type { ExecOutcome, ExecRead, ExecRequest, SyncAnswer } from "./wire.ts";
import { bindOpenSecretIn, type EffectorPortFactory, type OpenSecretIn } from "./http-effect.ts";
import { commandEnvParts, credentialedCommandWith, sandboxEffectorPort, type CommandEnv } from "./sandbox-effect.ts";
import { open } from "./open.ts";
import {
  effectBindingShape,
  openEffectLogic,
  openPartsOf,
  type EffectBinding,
  type OpenEffect,
  type OpenOf,
} from "./open-effect.ts";

// --- Parts: what `jr2 up` and the Machine doc read off a slot, without running anything ---------

// ONE argument, whatever its bytes: never shell text.
/** One entry of a command's argv that the input of the Effect fills, as `arg("name")` makes it. It
 * is one argument, whatever its text. No shell reads it. */
export type Arg<N extends string = string> = { readonly arg: N };

/**
 * Mark one argv entry of a `command` that the input of the Effect fills. `arg("file")` is one
 * argument: the value of the `file` key of the input, whatever its characters. No shell reads it.
 *
 * The input of the Effect then has a string key for each `arg`. Give it in the `input` of the
 * `invoke`, or use `fromPick` to give it from a pick.
 *
 * When it starts, with no string in the input for an entry, the Effect fails (its `onError`
 * route): `command "<slot>": argv slot <<name>> has no string value in its input (got <type>) —
 * map it in the invoke's input`. The angle brackets around the name are in the text.
 *
 * @param name - The key of the input that fills this entry.
 * @returns The argv entry, for the argv list of `command`.
 *
 * @example
 * ```ts
 * import { arg, command, fail, jr2Setup, workspace, type Workspaced } from "@jr2/orchestrator";
 *
 * type Input = Workspaced<{ file: string }, "app">;
 *
 * const body = jr2Setup({
 *   types: {} as { context: Input; input: Input },
 *   actors: { lint: command(["npx", "eslint", arg("file")]), fail: fail() },
 * }).createMachine({
 *   id: "lint",
 *   context: ({ input }) => input,
 *   on: { "workspace.lost": ".lost" },
 *   initial: "lint",
 *   states: {
 *     lint: {
 *       invoke: { src: "lint", input: ({ context }) => ({ file: context.file }), onDone: "done" },
 *     },
 *     done: { type: "final" },
 *     lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } },
 *   },
 * });
 *
 * export const machine = workspace(body, {
 *   repos: { app: { url: "https://github.com/you/app.git" } },
 *   spec: () => ({ branch: "lint" }),
 * });
 * ```
 *
 * @see docs/concepts/effects.md
 * @see docs/guides/run-a-command-or-call-a-url.md
 * @see docs/reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md
 */
export const arg = <const N extends string>(name: N): Arg<N> => ({ arg: name });

/** A `command` Effect's plain data. */
export type CommandParts = {
  readonly kind: "command";
  readonly argv: readonly (string | Arg)[];
  /** The env the author named (ADR-0067): each a secret's value, or its file's path. A command
   * that names a secret runs in the Sandbox Effector; one with none in the Harness container. */
  readonly env?: Readonly<Record<string, { readonly secret: string; readonly path?: true }>>;
  /** The secrets `env` names, once each, sorted — what places them (ADR-0068). */
  readonly secrets?: readonly string[];
  /** `env` names `secret(open)`, which the composer binds (ADR-0054): it is a credentialed command
   * before the name is known, and `env` holds `OPEN_SECRET` in its place until then. */
  readonly openSecret?: true;
  /** A credentialed command's `pin`: its input names the commit (`{ sha }`, an approved one) in
   * place of the Agent's branch tip (ADR-0067). */
  readonly pin?: true;
  /** The Repo Slot whose Worktree is the cwd. Needed only where the Workspace carries several. */
  readonly slot?: string;
  readonly timeoutMs: number;
  /** Characters of the stream's end kept in the output. The full stream goes to the feed. */
  readonly tail: number;
};

/**
 * An `http` Effect's plain data (ADR-0068): what `jr2 up` and the Machine doc read — the method,
 * the fixed target (scheme, host, port), the url and headers as `text` parts (a secret is a part,
 * by name), the auth, the secret names, the input's keys, the timeout, the body bound, and whether
 * a restore may send it again.
 */
export type HttpParts = {
  readonly kind: "http";
  readonly method: HttpMethod;
  readonly target: { readonly scheme: "http" | "https"; readonly host: string; readonly port: number };
  readonly url: readonly TextPart[];
  readonly headers: Readonly<Record<string, readonly TextPart[]>>;
  readonly auth?: WireAuth;
  /** Every secret the definition names, once each, in order — what places it (ADR-0068). */
  readonly secrets: readonly string[];
  /** The auth or a header names `secret(open)`, which the composer binds (ADR-0054); they hold
   * `OPEN_SECRET` in its place until then. */
  readonly openSecret?: true;
  /** The keys of the input schema: what a pick param may fill (ADR-0067's load walk reads them). */
  readonly inputKeys: readonly string[];
  readonly timeoutMs: number;
  readonly maxBody: number;
  /** Marked by the author: a restore that cannot find the Effect sends it again. */
  readonly idempotent: boolean;
  /** The body is a Worktree file (`body: file(...)`, ADR-0067): the Effect runs in the Sandbox
   * Effector of the Workspace whose body invokes it. `slot` is the Repo Slot whose Worktree holds
   * the file — needed only where the Workspace carries several. Absent: a json, text or no body, in
   * the Instance Effector. */
  readonly file?: { readonly slot?: string; readonly contentType?: string };
};

/**
 * A `push` Effect's plain data (ADR-0067, ADR-0051): the Workspace's branch to its Repo Slot's
 * Binding. `sign`, `squash`, `force` are the author's; `pin` says the Effect's input names the
 * commit (an approved one) instead of the Agent's branch tip.
 */
export type PushParts = {
  readonly kind: "push";
  readonly slot?: string;
  readonly pin: boolean;
  readonly sign: boolean;
  readonly squash: boolean;
  readonly force: boolean;
  readonly timeoutMs: number;
  /** A push names no secret: its credential is the `git.credentials` entry its Binding matches. */
  readonly secrets: readonly string[];
  readonly inputKeys: readonly string[];
};

/** A `dispatch` Effect's target: another Orchestrator's origin and the secret that holds its
 * Instance token, by name (ADR-0071). */
export type DispatchTarget = { readonly url: string; readonly token: string };

/**
 * A `dispatch` Effect's plain data (ADR-0071): the Workflow it starts a run of, as `jr2 run` names
 * it (`review`, or `<wrapper>/<name>` for a named Chart), whether it waits for that run to end, the
 * bound on the start (or the wait), and the target. No target: it runs in the Orchestrator's own
 * process, through the run host, with no wire and no token. A target: it runs in the Instance
 * Effector, which holds the token as an Effect secret.
 */
export type DispatchParts = {
  readonly kind: "dispatch";
  readonly workflow: string;
  readonly wait: boolean;
  readonly timeoutMs: number;
  readonly target?: DispatchTarget;
  /** The keys of the slot's input schema: what a pick param may fill. Undefined with no schema:
   * the callee's door alone checks the body, so the load walk reads everything (ADR-0071). */
  readonly inputKeys: readonly string[] | undefined;
  /** `[target.token]`, or none in-process: what places the token (ADR-0068). */
  readonly secrets: readonly string[];
  /** Always false: a target's token is never `secret(open)` — the whole target is the Open part
   * (ADR-0071). */
  readonly openSecret: boolean;
};

/**
 * An Effect whose url or argv a package left Open (ADR-0054): the same parts with the sentinel in
 * that one place. The kind, the placement, the timeout and the secrets the other parts name are
 * fixed; the Open part — and an Open secret beside it (`openSecret`) — is the composer's to bind,
 * once, with `customize()` (open-effect.ts).
 */
export type OpenCommandParts = Omit<CommandParts, "argv"> & { readonly argv: typeof open };
export type OpenHttpParts = Omit<HttpParts, "url" | "target"> & {
  readonly url: typeof open;
  readonly target: typeof open;
};

/** A `dispatch` whose target a package left Open (ADR-0071): the composer binds the url and the
 * token together, once. */
export type OpenDispatchParts = Omit<DispatchParts, "target"> & { readonly target: typeof open };

/** Every kind's parts, bound or with an Open part. */
export type EffectParts =
  | CommandParts
  | HttpParts
  | PushParts
  | OpenCommandParts
  | OpenHttpParts
  | DispatchParts
  | OpenDispatchParts;

/** The kinds, as their parts name them. */
export const EFFECT_KINDS: ReadonlySet<string> = new Set(["command", "http", "push", "dispatch"]);

/**
 * Where an Effect runs, derived from its kind and what it names, never authored (ADR-0067,
 * ADR-0068): a `command` that names no secret in the Harness container of its Workspace; an
 * `http` Effect with no Worktree file in the Instance Effector; an `http` whose body is a Worktree
 * file, a `push` and a `command` that names a secret in the Sandbox Effector of its Workspace; a
 * `dispatch` with no target in the Orchestrator's own process, and one with a target (an Open one
 * included: it has one once bound) in the Instance Effector (ADR-0071).
 */
export type Placement = "harness" | "instance" | "sandbox" | "orchestrator";
export function placementOf(parts: EffectParts): Placement {
  switch (parts.kind) {
    case "dispatch":
      return parts.target === undefined ? "orchestrator" : "instance";
    case "http":
      return parts.file ? "sandbox" : "instance";
    case "push":
      return "sandbox";
    case "command":
      return (parts.secrets?.length ?? 0) > 0 || parts.openSecret ? "sandbox" : "harness";
  }
}

/** The brand an Effect slot carries, as `definition` marks an Agent slot (ADR-0049). */
export type EffectSlot = { readonly effect: EffectParts };

/** Is this actor logic an Effect slot? A duck test on the brand, like `isAgent`. */
export function isEffect(logic: unknown): logic is EffectSlot {
  if (typeof logic !== "object" || logic === null) return false;
  const effect = (logic as { effect?: { kind?: unknown } }).effect;
  return (
    typeof effect === "object" && effect !== null && typeof effect.kind === "string" && EFFECT_KINDS.has(effect.kind)
  );
}

/** argv as text a reader can print: an argv slot reads `<name>`; an Open argv reads `<open>`. */
export function argvText(argv: readonly (string | Arg)[] | typeof open): string[] {
  if (argv === open) return ["<open>"];
  return argv.map((a) => (typeof a === "string" ? a : `<${a.arg}>`));
}

/** An http Effect's target as text: `scheme://host` with the port when it is not the scheme's; an
 * Open url reads `<open>`. */
export function targetText(parts: { readonly target: HttpParts["target"] | typeof open }): string {
  if (parts.target === open) return "<open>";
  const { scheme, host, port } = parts.target;
  const standard = (scheme === "https" && port === 443) || (scheme === "http" && port === 80);
  return `${scheme}://${host.includes(":") ? `[${host}]` : host}${standard ? "" : `:${port}`}`;
}

/** The keys an Effect's input has, read off its parts: a command's argv slot names (and `sha` with
 * `pin`); an http Effect's input schema keys; a push's `sha` and `message`; a dispatch's input
 * schema keys. Undefined for an Open argv: its slots are the composer's, unknown until
 * `customize()` binds it (ADR-0054); and for a dispatch with no input schema: the callee's door is
 * the only check, so nothing here says what it reads (ADR-0071). */
export function inputKeysOf(parts: EffectParts): string[] | undefined {
  if (parts.kind === "dispatch") return parts.inputKeys === undefined ? undefined : [...parts.inputKeys];
  if (parts.kind !== "command") return [...parts.inputKeys];
  if (parts.argv === open) return undefined;
  return [...parts.argv.flatMap((a) => (typeof a === "string" ? [] : [a.arg])), ...(parts.pin ? ["sha"] : [])];
}

// --- Output -------------------------------------------------------------------------------------

/** The output `{ outcome: "unknown", reason }`: the Effect may have acted, and jr2 cannot tell.
 * For example, the Harness lost the exec, or its state exited while it ran. Route on it. jr2 does
 * not run the Effect again. */
export type Unknown = { outcome: "unknown"; reason: string };

// `dirty` is a credentialed command's alone (ADR-0067): it runs in the Sandbox Effector against
// the pinned commit, never the live Worktree.
/**
 * The output of a `command` Effect: what the `onDone` of its state gets as `event.output`. Every
 * outcome is output. A failed program is output too. Route on `outcome`:
 *
 * - `exited`: the program ended. `code` is its exit code. A program that the container does not
 *   have is `exited` with code 127.
 * - `timeout`: the command ran past its `timeout`, and jr2 killed it.
 * - `killed`: a signal ended it. `signal` names the signal.
 * - `unknown`: jr2 cannot tell what the command did, for example because the Harness restarted
 *   while it ran. `reason` tells why. jr2 does not run it again.
 *
 * `tail` is the end of what the command wrote, at most the `tail` option of `command` in
 * characters. `dirty` is `true` when a command that names an Effect secret ran against a commit,
 * and the Worktree held changes that it did not see.
 *
 * @example
 * ```ts
 * import {
 *   command,
 *   type CommandOutput,
 *   fail,
 *   jr2Setup,
 *   workspace,
 *   type Workspaced,
 * } from "@jr2/orchestrator";
 *
 * type Input = Workspaced<{}, "app">;
 *
 * const passed = (output: CommandOutput): boolean =>
 *   output.outcome === "exited" && output.code === 0;
 *
 * const body = jr2Setup({
 *   types: {} as { context: Input; input: Input },
 *   actors: { tests: command(["npm", "test"], { timeout: "15m" }), fail: fail() },
 * }).createMachine({
 *   id: "tests",
 *   context: ({ input }) => input,
 *   on: { "workspace.lost": ".lost" },
 *   initial: "testing",
 *   states: {
 *     testing: {
 *       invoke: {
 *         src: "tests",
 *         onDone: [
 *           { guard: ({ event }) => passed(event.output), target: "green" },
 *           { target: "red" },
 *         ],
 *       },
 *     },
 *     green: { type: "final" },
 *     // Not a final state: a final state means `done`, and the run ends `failed` here.
 *     red: { invoke: { src: "fail", input: { reason: "npm test did not pass" } } },
 *     lost: { invoke: { src: "fail", input: { reason: "the Sandbox is gone" } } },
 *   },
 * });
 *
 * export const machine = workspace(body, {
 *   repos: { app: { url: "https://github.com/you/app.git" } },
 *   spec: () => ({ branch: "tests" }),
 * });
 * ```
 *
 * @see docs/concepts/effects.md
 * @see docs/guides/run-a-command-or-call-a-url.md
 * @see docs/reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md
 */
export type CommandOutput = (ExecOutcome & { dirty?: boolean }) | Unknown;

// Reach is output, as an http Effect's is (ADR-0067): a body a model wrote can be fixed through
// the Chain, so a refusal is output too.
/**
 * The output of a `dispatch` Effect. Route on `outcome`:
 *
 * - `started`: the Orchestrator accepted the new run. `run` is its id.
 * - `settled`: with `wait`, the new run ended. `status` is `done`, `failed`, `error`, `cancelled`,
 *   `lost` or `drifted`, and `output` is the output of its Machine. For `failed`, `output` is the
 *   Failure, `{ reason, detail? }`. `status` is `live` when the timeout came first, and the run
 *   continues.
 * - `refused`: the Orchestrator started no run. `status` is the HTTP status: 400 for an input that
 *   the Workflow does not take, 404 for a Workflow that it does not have, 409 for a named Chart that
 *   cannot run now, 422 for a Chart that it refuses. `report` holds the lines of the refusal.
 * - `unreachable`: the Orchestrator of the target did not answer. No run started.
 * - `unknown`: jr2 cannot tell if a run started.
 *
 * @see docs/concepts/effects.md
 */
export type DispatchOutput =
  | { outcome: "started"; run: string }
  | {
      outcome: "settled";
      run: string;
      status: "done" | "failed" | "error" | "cancelled" | "lost" | "drifted" | "live";
      output?: unknown;
    }
  | { outcome: "refused"; status: number; report: string[] }
  | { outcome: "unreachable"; reason: string }
  | Unknown;

// --- The ledger row (persisted in the run's blob, ADR-0007) --------------------------------------

/**
 * One Effect's row. `intent` names where the call went — the Harness's URL and the placement whose
 * bearer reaches it — so a restore re-attaches without the Workspace's handles. `settled` keeps the
 * output: a restore whose transition was not saved delivers it; once that transition is saved, the
 * output less its tail is the record of what ran (`dropSavedTails`). `aborted`: its state exited
 * while it ran. A row replaces the one before it; none is dropped.
 */
export type EffectRow =
  | { state: "intent"; kind: "command"; slot: string; endpoint: string; placement: string; at: string }
  /** An http Effect's intent names its placement and no replica (ADR-0068): a restore asks every
   * replica. `idempotent` is the author's mark, which the restore rule reads. */
  | { state: "intent"; kind: "http"; slot: string; placement: "instance"; idempotent: boolean; at: string }
  /** An Effect of the Sandbox Effector (ADR-0067): its Sandbox, and — for a push or a credentialed
   * command — the commit it runs against, written once the start's answer names it. A restore
   * re-attaches by id, or sends a push or a credentialed command again with only that commit, and
   * sends an http with a Worktree file body again only when it is marked idempotent. */
  | {
      state: "intent";
      kind: "http" | "push" | "command";
      slot: string;
      placement: "sandbox";
      sandbox: string;
      idempotent: boolean;
      pinned?: string;
      at: string;
    }
  /** A dispatch's intent (ADR-0071): where it runs, and — once the start's answer names it — the
   * run it started. A dispatch is idempotent by construction: its ledger id rides every start as
   * the door's key, so a restore sends it again and gets the same run. */
  | {
      state: "intent";
      kind: "dispatch";
      slot: string;
      placement: "orchestrator" | "instance";
      idempotent: true;
      wait: boolean;
      run?: string;
      at: string;
    }
  /** `sandbox` and `repo`: the Workspace and the Repo Slot an Effect of the Sandbox Effector ran on
   * — every later push of its own Workspace and Repo Slot (one branch, one remote) sends its pair,
   * and the newest push's unfinished sync runs again in that slot's Worktree. */
  | {
      state: "settled";
      kind: EffectParts["kind"];
      slot: string;
      sandbox?: string;
      repo?: string;
      output: unknown;
      at: string;
    }
  /** `run`: for a dispatch, the run it started, kept past the abort — the callee runs on, and the
   * caller's row still names it (ADR-0071). */
  | { state: "aborted"; kind: EffectParts["kind"]; slot: string; run?: string; at: string };

/**
 * Retention (ADR-0067): drop, in place, the output tail of every settled row once a save on disk
 * carries the transition its output drove — `persisted` is the snapshot that save held, and it no
 * longer holds the Effect running (its transition, or with no `onDone` the child done in place). A
 * restore reads a settled row's output only for an Effect its saved snapshot holds running, so
 * nothing reads the tail after that save; the full stream is on the feed. An http response's body
 * and headers are its tail: the settled marker on the feed carries them whole. The row keeps its
 * id, kind and outcome — a command's exit code, signal or reason; a response's status, content type
 * and size — for the run's life: the record of what ran. So an Effect in a loop grows the blob by
 * one short row per pass, never by its tails.
 */
export function dropSavedTails(effects: Record<string, EffectRow>, persisted: unknown): void {
  const running = new Set<string>();
  const walk = (snapshot: unknown): void => {
    const children = (snapshot as { children?: Record<string, { snapshot?: unknown } | undefined> } | null)?.children;
    if (!children || typeof children !== "object") return;
    for (const child of Object.values(children)) {
      const { effectId, status } = (child?.snapshot ?? {}) as { effectId?: unknown; status?: unknown };
      if (typeof effectId === "string" && status === "active") running.add(effectId);
      walk(child?.snapshot);
    }
  };
  walk(persisted);
  const newest = newestPushesOf(effects);
  for (const [id, row] of Object.entries(effects)) {
    if (row.state !== "settled" || running.has(id)) continue;
    const output = row.output as Record<string, unknown> | null;
    if (typeof output !== "object" || output === null) continue;
    // A command's tail; an http response's body and headers. What stays is short: the outcome, and
    // a response's status, content type and size.
    const long = tailsOf(row.kind, output, newest.has(id)).filter((field) => field in output);
    if (long.length === 0) continue;
    const outcome = Object.fromEntries(Object.entries(output).filter(([field]) => !long.includes(field)));
    effects[id] = { ...row, output: outcome };
  }
}

/** The fields of a settled output that `dropSavedTails` drops, by kind. */
const TAILS: Record<EffectRow["kind"], readonly string[]> = {
  command: ["tail"],
  http: ["body", "headers"],
  // A push row keeps its pair whole (`published`, `source`, `squashed`) and its sync's answer:
  // every later push of its Repo Slot sends the pair (`pushPairsOf`), and the newest push's sync
  // runs again when it did not finish. The sync's bundle and git's words are its tail.
  push: ["bundle", "detail"],
  // A dispatch's tail is the callee's output, which `GET /runs/<id>` serves for as long as the run
  // is kept, and a refusal's report, which can carry the callee door's whole schema: the feed's
  // settled marker carries both whole. The row keeps the outcome, the run id, its status and the
  // door's HTTP status (ADR-0071).
  dispatch: ["output", "report"],
};

/** A kind's tail for one output. The NEWEST push of its Repo Slot whose sync did not finish (`busy`,
 * `not-synced`) keeps its bundle: the sync that runs again before the next push of that slot moves
 * the branch from it, and the Agent's store may not hold the published commits without it. Once a
 * sync finished, or once a newer push of the slot published, the bundle goes: only the newest
 * push's sync runs again (`lastPushOf`), so an older bundle has no reader. */
function tailsOf(kind: EffectRow["kind"], output: Record<string, unknown>, newest: boolean): readonly string[] {
  if (kind === "push" && newest && (output.sync === "busy" || output.sync === "not-synced")) return ["detail"];
  return TAILS[kind];
}

/** A settled push row that published: its pair, and its sync's answer and bundle when it has them.
 */
export type PushedRow = { published: string; source: string; sync?: SyncAnswer["sync"]; bundle?: string } & Record<
  string,
  unknown
>;

/** The ledger's last push of a Workspace's Repo Slot that published: its row, by `at`, never this
 * Effect's (`self`). A Workspace with two Repo Slots has two branches on two remotes, so two pairs.
 */
export function lastPushOf(
  rows: Readonly<Record<string, EffectRow>>,
  sandbox: string,
  repo: string,
  self?: string,
): { rowId: string; row: Extract<EffectRow, { state: "settled" }>; output: PushedRow } | undefined {
  let best: { rowId: string; row: Extract<EffectRow, { state: "settled" }>; output: PushedRow } | undefined;
  for (const [rowId, row] of Object.entries(rows)) {
    if (rowId === self || row.state !== "settled" || row.kind !== "push") continue;
    if (row.sandbox !== sandbox || row.repo !== repo) continue;
    const output = row.output as Partial<PushedRow> & { outcome?: unknown };
    if (output?.outcome !== "pushed" || typeof output.published !== "string" || typeof output.source !== "string") {
      continue;
    }
    if (best === undefined || row.at > best.row.at) best = { rowId, row, output: output as PushedRow };
  }
  return best;
}

/** Every pair the ledger holds for a Workspace's Repo Slot (ADR-0067): each settled push row that
 * published, oldest first by `at`, never this Effect's (`self`) — its published commit, its source,
 * and its own `squashed`. What a push start carries, so the Effector sees every push's pair. */
export function pushPairsOf(
  rows: Readonly<Record<string, EffectRow>>,
  sandbox: string,
  repo: string,
  self?: string,
): Array<{ published: string; source: string; squashed?: "signed" | "unsigned" }> {
  const found: Array<{ at: string; pair: { published: string; source: string; squashed?: "signed" | "unsigned" } }> =
    [];
  for (const [rowId, row] of Object.entries(rows)) {
    if (rowId === self || row.state !== "settled" || row.kind !== "push") continue;
    if (row.sandbox !== sandbox || row.repo !== repo) continue;
    const output = row.output as Partial<PushedRow> & { outcome?: unknown; squashed?: unknown };
    if (output?.outcome !== "pushed" || typeof output.published !== "string" || typeof output.source !== "string") {
      continue;
    }
    const squashed = output.squashed === "signed" || output.squashed === "unsigned" ? output.squashed : undefined;
    found.push({
      at: row.at,
      pair: { published: output.published, source: output.source, ...(squashed ? { squashed } : {}) },
    });
  }
  return found.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((f) => f.pair);
}

/** The row id of each Repo Slot's newest push that published (`lastPushOf`), over the ledger. */
function newestPushesOf(effects: Readonly<Record<string, EffectRow>>): Set<string> {
  const ids = new Set<string>();
  const seen = new Set<string>();
  for (const row of Object.values(effects)) {
    if (row.state !== "settled" || row.kind !== "push" || row.sandbox === undefined || row.repo === undefined) continue;
    const key = JSON.stringify([row.sandbox, row.repo]);
    if (seen.has(key)) continue;
    seen.add(key);
    const last = lastPushOf(effects, row.sandbox, row.repo);
    if (last !== undefined) ids.add(last.rowId);
  }
  return ids;
}

/** One Effect line on the run's feed (Instance-token band, like the Turn markers). `output` lines
 * carry the stream; `aborted` and an `unknown` settle say the outside world may have acted. */
export type EffectMarker = {
  kind: "effect";
  slot: string;
  effect: string;
  stage: "started" | "output" | "settled" | "aborted";
  text?: string;
  output?: CommandOutput | HttpOutput | DispatchOutput;
};

// --- The port -----------------------------------------------------------------------------------

/** The Harness's exec, as the Effect drives it. `read` answers undefined for an exec the Harness
 * does not know (404): it restarted, and jr2 settles `unknown`. `start` rejects with `ExecNotSent`
 * only when the request certainly never reached the Harness — the one failure it is sent again on.
 */
export interface ExecPort {
  start(id: string, req: ExecRequest, signal: AbortSignal): Promise<void>;
  read(id: string, offset: number | undefined, signal: AbortSignal): Promise<ExecRead | undefined>;
  kill(id: string): Promise<void>;
  forget(id: string): Promise<void>;
}
export type ExecPortFactory = (endpoint: string, bearer?: string) => ExecPort;

// --- The actor logic ----------------------------------------------------------------------------

export type EffectSnapshot<O, I> = Snapshot<O> & {
  input: I | undefined;
  /** Minted once per invocation and persisted with the child: a restored Effect finds its row,
   * and a state entered again gets a new one. */
  effectId: string;
};

type Settle = { type: "jr2.effect.settle"; output: unknown };
type Fault = { type: "jr2.effect.error"; error: unknown };

/** An Effect slot's logic: xstate `ActorLogic`, typed by its input and output, branded with its
 * parts. The brand is a runtime property (`isEffect`) and part of the type, as `definition` is
 * not on an Agent's: nothing substitutes a fake for an Effect's parts.
 *
 * @internal
 */
export type EffectLogic<I, O> = ActorLogic<EffectSnapshot<O, I>, EventObject, I> & EffectSlot;

/** @internal */
type ArgNames<A extends readonly unknown[]> = A[number] extends infer E ? (E extends Arg<infer N> ? N : never) : never;
/** A command's input: one string per argv slot, and with `pin` the approved commit (`{ sha }`);
 * none when there is neither. */
export type CommandInput<A extends readonly unknown[], P = false> = [
  ArgNames<A> | ([P] extends [true] ? "sha" : never),
] extends [never]
  ? void
  : { [K in ArgNames<A> | ([P] extends [true] ? "sha" : never)]: string };

// An Open argv's slots are the composer's (ADR-0054), so any key is one string — what the
// package's invoke hands it, read by the argv the composer binds (`argvOf`).
/** The input of a `command(open)`: a string for each `arg()` of the argv that the Instance binds,
 * and with `pin`, the commit (`{ sha }`). The compiler cannot check the names. When the input has
 * no string for an `arg()`, the Effect fails when it starts. */
export type OpenCommandInput<P = false> = Readonly<Record<string, string>> &
  ([P] extends [true] ? { sha: string } : unknown);

/** A length of time: a positive number and a unit, `s`, `m` or `h`. For example `"90s"`, `"10m"`
 * or `"1h"`. */
export type Duration = `${number}s` | `${number}m` | `${number}h`;

/** The options of `command()`: the Repo Slot it runs in, how long it can run, how much of its
 * output it keeps, its Effect secrets, and the commit it runs against. */
export type CommandOptions = {
  /**
   * The Repo Slot whose Worktree is the working directory of the command. Write it only when the
   * Workspace has more than one Repo Slot. In a Workspace with no Repo Slot, the command starts in
   * `/work`, the folder that the steps of the Workspace share.
   *
   * The command starts in the root of that Worktree. To run it in a subfolder, give the path as an
   * argument, or write `["sh", "-c", "cd <dir> && <program>"]`.
   *
   * When it starts, it refuses:
   * - no `slot` under a Workspace with more than one Repo Slot: `command "<slot>" runs under a
   *   Workspace carrying more than one Repo Slot (<slots>) and names none — say which Worktree it
   *   runs in: command(argv, { slot: "<slot>" }) (ADR-0051)`. When `env` names an Effect secret,
   *   the text is `command "<slot>" runs under a Workspace carrying more than one Repo Slot
   *   (<slots>) — say which: { slot: "<slot>" } (ADR-0051)`.
   * - with an Effect secret in `env`, a Workspace with no Repo Slot: `command "<slot>" runs under
   *   a Workspace with no Repo Slot: a command with an Effect secret runs against one commit of a
   *   Repo Slot's branch, and there is none — declare a Repo Slot, or name no secret in its env, and
   *   it runs in /work beside the Agent (ADR-0051)`.
   * - a `slot` that the Workspace does not have: `command "<slot>" names Repo Slot "<name>", which
   *   its Workspace does not carry (<slots>)`.
   */
  slot?: string;
  /**
   * How long the command can run: a number and a unit, such as `"90s"`, `"10m"` or `"1h"`.
   * Default `"10m"`. When the time ends, jr2 kills the process group, and the output is
   * `timeout`. It refuses a value that is not a positive duration: `command: timeout "<timeout>"
   * is not a positive duration (like "90s", "10m", "1h")`.
   */
  timeout?: Duration;
  /** The number of characters that `tail` keeps from the end of what the command wrote. Default
   * 4096. */
  tail?: number;
  // Naming a secret is the placement (ADR-0067, ADR-0068): there is no placement key.
  /**
   * The environment variables of the command, each an Effect secret. `secret("x")` gives the
   * value, and `secret("x").path` gives the path of a file that holds the value. When `env` names
   * one, the command runs in the Sandbox Effector against one commit, not in the Worktree that the
   * Agent changes. Without `env`, it runs in the Harness container, beside the Agent.
   *
   * It refuses a name that is not a variable name, and `PATH`, `HOME` and `TMPDIR`: ``command(argv,
   * { env }): "<name>" is not a variable the author sets — PATH, HOME and TMPDIR are the
   * Effector's (ADR-0067)``.
   */
  env?: CommandEnv;
  /**
   * Only for a command whose `env` names an Effect secret. `true`: the input of the Effect names
   * the commit to run against (`{ sha }`, a full commit id, for example one that a Gate approved).
   * Default: the tip of the Agent's branch when the Effect starts.
   *
   * It refuses `pin: true` on a command that names no Effect secret: ``command(argv, { pin: true
   * }) names no secret in its env: `pin` chooses the commit a credentialed command runs against in
   * the Sandbox Effector, and a command that names no secret runs in the live Worktree (ADR-0067)
   * — name its secret, command(argv, { env: { NAME: secret("x") }, pin: true }), or drop `pin` ``.
   *
   * When it starts, it refuses an input `sha` that is not a full commit id: `command "<slot>"
   * (pin): its input's sha is not a full commit id`.
   */
  pin?: boolean;
};

/** The Open part a command's options state (ADR-0054): its secret, when its env holds
 * `secret(open)` or its `.path`.
 *
 * @internal
 */
export type EnvOpenParts<Opt> = Opt extends { readonly env: infer E }
  ? OpenSecretIn<E extends Readonly<Record<string, infer V>> ? V : never>
  : never;

/**
 * Why an Effect kind cannot run in a Workspace with no Repo Slot (ADR-0051, ADR-0067), or undefined
 * when it can: a `push` and a credentialed `command` run on a commit of a slot's branch, and that
 * Workspace has none. The invoke and the `jr2 up` walk refuse with the same words.
 */
export function needsASlot(kind: string): string | undefined {
  if (kind === "push")
    return 'a push publishes a Repo Slot\'s branch, and there is none — declare one: repos: { app: "<url>" }';
  if (kind === "command") {
    return (
      "a command with an Effect secret runs against one commit of a Repo Slot's branch, and there is none — " +
      "declare a Repo Slot, or name no secret in its env, and it runs in /work beside the Agent"
    );
  }
  return undefined;
}

/** The work root of a Sandbox pod (ADR-0004): where a command runs in a Workspace with no Repo Slot. */
const WORK_ROOT = "/work";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TAIL = 4096;
/** How long a re-asked request waits, at most, after a transport failure. */
const RETRY_MAX_MS = 10_000;

/** The running side of one live Effect actor — what its stop reads. `timeoutMs`: how long its stop
 * keeps sending the kill — past it the Harness's own timer has ended the group. */
type Running = { controller: AbortController; port?: ExecPort; started: boolean; timeoutMs: number };
const running = new WeakMap<AnyActorRef, Running>();

/**
 * A `command` Effect's slot logic over an injected port factory — the seam `command()` and the
 * unit tests share. `argv` is never shell text: an `arg("x")` entry is ONE argument, filled from
 * the input's `x`.
 */
export function commandWith<const Opt extends CommandOptions = CommandOptions>(
  portFactory: ExecPortFactory,
  argv: typeof open,
  options?: Opt,
  effectorPorts?: EffectorPortFactory,
): EffectLogic<OpenCommandInput<Opt["pin"]>, CommandOutput> & OpenEffect<"argv" | EnvOpenParts<Opt>>;
export function commandWith<
  const A extends readonly (string | Arg)[],
  const Opt extends CommandOptions = CommandOptions,
>(
  portFactory: ExecPortFactory,
  argv: A,
  options?: Opt,
  effectorPorts?: EffectorPortFactory,
): EffectLogic<CommandInput<A, Opt["pin"]>, CommandOutput> & OpenOf<EnvOpenParts<Opt>>;
export function commandWith(
  portFactory: ExecPortFactory,
  argv: readonly (string | Arg)[] | typeof open,
  options: CommandOptions = {},
  effectorPorts: EffectorPortFactory = sandboxEffectorPort,
  // The implementation of the overloads above: each one states the input type.
): EffectLogic<any, CommandOutput> {
  if (argv === open) {
    // An Open argv (ADR-0054): the options are checked now, by the same constructor a bound one
    // goes through — a probe argv takes the composer's place — and the unbound logic carries the
    // parts with the sentinel in the argv's place. Binding calls this constructor again, whole.
    const probe = commandWith(portFactory, ["<open>"], options, effectorPorts);
    const parts: OpenCommandParts = { ...(probe.effect as CommandParts), argv: open };
    return openCommandOf(parts, (binding) => {
      const bound = bindCommand(binding, options);
      return commandWith(portFactory, (binding.argv ?? open) as readonly (string | Arg)[], bound, effectorPorts);
    });
  }
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("command(argv): argv is a non-empty list — each entry one argument, never shell text");
  }
  for (const a of argv) {
    if (typeof a !== "string" && !(typeof a === "object" && a !== null && typeof (a as Arg).arg === "string")) {
      throw new Error(`command(argv): an argv entry is a string or arg("name"), got ${JSON.stringify(a)}`);
    }
  }
  const parts: CommandParts = {
    kind: "command",
    argv: [...argv],
    timeoutMs: options.timeout === undefined ? DEFAULT_TIMEOUT_MS : parseDuration(options.timeout),
    tail: options.tail ?? DEFAULT_TAIL,
    ...(options.slot !== undefined ? { slot: options.slot } : {}),
    ...(options.env !== undefined && Object.keys(options.env).length > 0 ? commandEnvParts(options.env) : {}),
    ...(options.pin === true ? { pin: true as const } : {}),
  };
  if (parts.pin && (parts.secrets?.length ?? 0) === 0 && !parts.openSecret) {
    // A command that names no secret runs in the Harness container, in the live Worktree: there
    // is no pinned checkout for `pin` to choose (ADR-0067).
    throw new Error(
      "command(argv, { pin: true }) names no secret in its env: `pin` chooses the commit a credentialed command " +
        "runs against in the Sandbox Effector, and a command that names no secret runs in the live Worktree " +
        '(ADR-0067) — name its secret, command(argv, { env: { NAME: secret("x") }, pin: true }), or drop `pin`',
    );
  }
  if (parts.openSecret) {
    // An Open secret in its env (ADR-0054): a credentialed command whose secret the composer names.
    return openCommandOf(parts, (binding) => {
      const bound = bindCommand(binding, options);
      return commandWith(portFactory, argv, bound, effectorPorts);
    });
  }
  if ((parts.secrets?.length ?? 0) > 0) {
    // Naming a secret is the placement (ADR-0067): the Sandbox Effector runs it.
    return credentialedCommandWith(
      effectorPorts,
      parts,
      (input, slot) => argvOf(slot, parts, input),
      parts.pin === true,
    ) as unknown as EffectLogic<unknown, CommandOutput>;
  }
  type I = unknown;
  type O = CommandOutput;
  const logic: ActorLogic<EffectSnapshot<O, I>, EventObject, I> = {
    getInitialSnapshot: (_scope, input) => ({
      status: "active",
      output: undefined,
      error: undefined,
      input,
      effectId: randomUUID(),
    }),
    transition: (snapshot, event, { self, system }) => {
      if (snapshot.status !== "active") return snapshot;
      if (event.type === "jr2.effect.settle") {
        return { ...snapshot, status: "done", output: (event as Settle).output as O, input: undefined };
      }
      if (event.type === "jr2.effect.error") {
        return { ...snapshot, status: "error", error: (event as Fault).error, input: undefined };
      }
      if (event.type === "xstate.stop") {
        stopped(self, system, snapshot.effectId);
        return { ...snapshot, status: "stopped", input: undefined };
      }
      return snapshot;
    },
    start: (snapshot, { self, system }) => {
      if (snapshot.status !== "active") return;
      const run: Running = { controller: new AbortController(), started: false, timeoutMs: parts.timeoutMs };
      running.set(self, run);
      void drive(self, system, snapshot, parts, portFactory, run).catch((error: unknown) => {
        if (run.controller.signal.aborted) return;
        if (self.getSnapshot().status === "active") self.send({ type: "jr2.effect.error", error } as Fault);
      });
    },
    getPersistedSnapshot: (snapshot) => snapshot,
  };
  return Object.assign(logic, { effect: parts });
}

/** The slot's name as its parent invoked it — what the ledger and the feed call the Effect. */
const slotOf = (self: AnyActorRef): string => (typeof self.src === "string" ? self.src : self.id);

/** Run, re-attach to, or deliver one Effect, by its ledger row (see the module header). */
async function drive<I, O>(
  self: AnyActorRef,
  system: AnyActorSystem,
  snapshot: EffectSnapshot<O, I>,
  parts: CommandParts,
  portFactory: ExecPortFactory,
  run: Running,
): Promise<void> {
  const binding = boundRun(system);
  const id = snapshot.effectId;
  const slot = slotOf(self);
  const signal = run.controller.signal;
  const now = (): string => new Date().toISOString();
  const mark = (marker: Omit<EffectMarker, "kind" | "slot" | "effect">): void =>
    binding?.marker?.({ kind: "effect", slot, effect: id, ...marker });
  const settle = (output: CommandOutput): void => {
    if (signal.aborted || self.getSnapshot().status !== "active") return;
    // The settled row first, saved at the write: a restart before the transition is saved delivers
    // this output, and runs nothing.
    binding?.recordEffect?.(id, { state: "settled", kind: parts.kind, slot, output, at: now() });
    mark({ stage: "settled", output });
    self.send({ type: "jr2.effect.settle", output } satisfies Settle);
  };

  const row = binding?.effectRow?.(id);
  if (row?.state === "settled") {
    // Settled before the restart, its transition unsaved: the output is delivered, nothing runs.
    await Promise.resolve();
    if (!signal.aborted && self.getSnapshot().status === "active") {
      self.send({ type: "jr2.effect.settle", output: row.output } satisfies Settle);
    }
    return;
  }
  if (row?.state === "aborted") {
    settle({ outcome: "unknown", reason: "its state exited while it ran; not run again" });
    return;
  }
  if (row?.state === "intent" && row.kind === "command" && "endpoint" in row) {
    // In flight at an Orchestrator restart: re-attach by id, or settle `unknown`. Never run again.
    const port = portFactory(row.endpoint, binding?.harnessBearer?.(row.placement));
    run.port = port;
    run.started = true;
    const first = await retrying(() => port.read(id, undefined, signal), signal);
    if (signal.aborted) return;
    if (first === undefined) {
      const output: Unknown = {
        outcome: "unknown",
        reason: "it was running when the Orchestrator restarted, and the Harness no longer knows it; not run again",
      };
      settle(output);
      return;
    }
    await follow(port, id, first, signal, mark, settle);
    return;
  }

  // Fresh: nothing was sent. Where it runs is the enclosing Workspace's Harness — refused outside one.
  const ambient = ambientHandlesFor(self);
  if (!ambient) {
    throw new Error(
      `command "${slot}" runs in the Harness container of a Workspace, and its state is not inside a ` +
        `workspace() — invoke it from a Workspace's body (ADR-0067)`,
    );
  }
  const req: ExecRequest = {
    argv: argvOf(slot, parts, snapshot.input),
    ...cwdOf(slot, parts, ambient),
    timeoutMs: parts.timeoutMs,
    tail: parts.tail,
  };
  const port = portFactory(ambient.endpoint, binding?.harnessBearer?.(ambient.sandbox));
  run.port = port;
  // Write-ahead: the intent row is saved, with the snapshot that holds this child, BEFORE the
  // request leaves. A restart after this line re-attaches; before it, nothing was sent.
  binding?.recordEffect?.(id, {
    state: "intent",
    kind: parts.kind,
    slot,
    endpoint: ambient.endpoint,
    placement: ambient.sandbox,
    at: now(),
  });
  run.started = true;
  mark({ stage: "started", text: req.argv.join(" ") });
  const sent = await startOnce(port, id, req, signal);
  if (signal.aborted) return;
  const first = await retrying(() => port.read(id, 0, signal), signal);
  if (signal.aborted) return;
  if (first === undefined) {
    if (sent === "uncertain") {
      // The start may still be on its way to the Harness that answers now: a kill keeps it from
      // running there (exec.ts keeps an unknown id killed). Best effort — `unknown` either way.
      void killUntilKept(port, id, parts.timeoutMs).catch(() => {});
    }
    settle({
      outcome: "unknown",
      reason:
        sent === "uncertain"
          ? "its start may have reached the Harness, which no longer knows it (it restarted); not run again"
          : "the Harness lost it after it started (it restarted); not run again",
    });
    return;
  }
  await follow(port, id, first, signal, mark, settle);
}

/**
 * Send the start ONCE where it may have reached the Harness. The Harness runs one id once only
 * inside one process: a start that reached a Harness which then restarted, sent again, would run
 * the command a second time in the new one. So a start is sent again only when it certainly never
 * left (`ExecNotSent`: the connection was refused, the name did not resolve). Any other failure is
 * `uncertain`, and the caller reads by id: found, it follows; unknown, it settles `unknown`.
 */
async function startOnce(
  port: ExecPort,
  id: string,
  req: ExecRequest,
  signal: AbortSignal,
): Promise<"sent" | "uncertain"> {
  for (let wait = 250; ; wait = Math.min(wait * 2, RETRY_MAX_MS)) {
    try {
      await port.start(id, req, signal);
      return "sent";
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof ExecRefused) throw err;
      if (!(err instanceof ExecNotSent)) return "uncertain";
      await new Promise((resolve) => setTimeout(resolve, wait / 2 + Math.random() * (wait / 2)));
      if (signal.aborted) throw err;
    }
  }
}

/** Read the exec to its end: each chunk of stream to the feed, the output to the Machine. */
async function follow(
  port: ExecPort,
  id: string,
  first: ExecRead,
  signal: AbortSignal,
  mark: (marker: Omit<EffectMarker, "kind" | "slot" | "effect">) => void,
  settle: (output: CommandOutput) => void,
): Promise<void> {
  let read: ExecRead | undefined = first;
  for (;;) {
    if (read === undefined) {
      settle({ outcome: "unknown", reason: "the Harness lost it while it ran (it restarted); not run again" });
      return;
    }
    if (read.stream) mark({ stage: "output", text: read.stream });
    if (read.state === "settled" && read.output) {
      settle(read.output);
      void port.forget(id).catch(() => {});
      return;
    }
    const offset: number = read.next;
    read = await retrying(() => port.read(id, offset, signal), signal);
    if (signal.aborted) return;
  }
}

/**
 * The state that invoked this Effect exited (D1) — or the host is parking the run. Parking leaves
 * the exec running for the restore to re-attach. An exit kills it and records the abort, "outcome
 * unknown", on the ledger and the feed; the Machine never hears it.
 */
function stopped(self: AnyActorRef, system: AnyActorSystem, effectId: string): void {
  const run = running.get(self);
  running.delete(self);
  run?.controller.abort();
  const binding = boundRun(system);
  if (binding?.hostStopping) return;
  const row = binding?.effectRow?.(effectId);
  if (row?.state !== "intent" || row.kind !== "command") return;
  const port = run?.port;
  if (port) {
    void killUntilKept(port, effectId, run.timeoutMs).then((kept) => {
      if (kept) return;
      binding?.marker?.({
        kind: "effect",
        slot: row.slot,
        effect: effectId,
        stage: "aborted",
        text: "the kill did not reach its Harness; it may run until its timeout",
      });
    });
  }
  // Written now, saved with the transition that stopped it — never inside it: a save mid-transition
  // reads the Machine before its route. A cancel's final save carries it.
  const aborted: EffectRow = { state: "aborted", kind: row.kind, slot: row.slot, at: new Date().toISOString() };
  binding?.recordEffect?.(effectId, aborted, "with-transition");
  binding?.marker?.({
    kind: "effect",
    slot: row.slot,
    effect: effectId,
    stage: "aborted",
    text: "its state exited while it ran: stopped; outcome unknown",
  });
}

/**
 * Send the kill until the Harness keeps it. The start may still be on the wire, so the kill can
 * reach the Harness first — it keeps an unknown id as killed, and that start then runs nothing — or
 * be lost to a transport fault, so it is sent again with backoff. Bounded by the command's timeout:
 * past it the Harness's own timer has ended the group. False when it never reached the Harness.
 */
async function killUntilKept(port: ExecPort, id: string, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (let wait = 250; ; wait = Math.min(wait * 2, RETRY_MAX_MS)) {
    try {
      await port.kill(id);
      return true;
    } catch (err) {
      if (err instanceof ExecRefused || Date.now() + wait > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, wait / 2 + Math.random() * (wait / 2)).unref());
    }
  }
}

/**
 * The unbound logic of a command with Open parts (ADR-0054) — its argv, an Open secret in its env,
 * or both. `rebuild` calls this constructor again, whole, with the bound parts; a binding that
 * names one of two Open parts gives a command still Open in the other.
 */
function openCommandOf(
  parts: CommandParts | OpenCommandParts,
  rebuild: (binding: EffectBinding) => unknown,
): EffectLogic<any, CommandOutput> {
  const opened = openPartsOf(parts);
  return openEffectLogic(parts, opened, (binding) => {
    if (binding.url !== undefined || (binding.argv !== undefined && !opened.includes("argv"))) {
      throw new Error(
        `a command's Open parts here are its ${opened.join(" and ")} — bind it with ${effectBindingShape(opened)}`,
      );
    }
    return rebuild(binding) as EffectLogic<unknown, unknown>;
  });
}

/** A command's options with the binding's secret named in its env, where `secret(open)` stood. */
function bindCommand(binding: EffectBinding, options: CommandOptions): CommandOptions {
  if (binding.secret === undefined || options.env === undefined) return options;
  return { ...options, env: bindOpenSecretIn(options.env, binding.secret) };
}

/** argv with each slot filled from the input — one argument per entry. */
function argvOf(slot: string, parts: CommandParts, input: unknown): string[] {
  const values = (input ?? {}) as Record<string, unknown>;
  return parts.argv.map((a) => {
    if (typeof a === "string") return a;
    const value = values[a.arg];
    if (typeof value !== "string") {
      throw new Error(
        `command "${slot}": argv slot <${a.arg}> has no string value in its input ` +
          `(got ${value === undefined ? "nothing" : typeof value}) — map it in the invoke's input`,
      );
    }
    return value;
  });
}

/**
 * The cwd: a Repo Slot's Worktree (ADR-0051). Named by `slot`, or the one slot where the Workspace
 * carries one; a Workspace with none runs it in `/work`, which its steps share. Named, never left to
 * the Harness: a spawn with no cwd runs in the Sandbox Image's own `WORKDIR`, which is the image's.
 * Several and none named is refused, as a Turn's Frame is (ADR-0057): the kit gives no slot a
 * meaning.
 */
function cwdOf(slot: string, parts: CommandParts, ambient: AmbientHandles): { cwd?: string } {
  const slots = Object.keys(ambient.repos);
  if (parts.slot !== undefined) {
    const cwd = ambient.repos[parts.slot];
    if (cwd === undefined) {
      throw new Error(
        `command "${slot}" names Repo Slot "${parts.slot}", which its Workspace does not carry ` +
          `(${slots.join(", ") || "none"})`,
      );
    }
    return { cwd };
  }
  if (slots.length === 0) return { cwd: WORK_ROOT };
  if (slots.length === 1) return { cwd: ambient.repos[slots[0]!]! };
  throw new Error(
    `command "${slot}" runs under a Workspace carrying more than one Repo Slot (${slots.join(", ")}) and names ` +
      `none — say which Worktree it runs in: command(argv, { slot: "<slot>" }) (ADR-0051)`,
  );
}

/** Ask again on a transport failure, with backoff, until it answers or the Effect stops. For a
 * read only: a read runs nothing. A start goes through `startOnce`. */
async function retrying<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let wait = 250; ; wait = Math.min(wait * 2, RETRY_MAX_MS)) {
    try {
      return await call();
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof ExecRefused) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait / 2 + Math.random() * (wait / 2)));
      if (signal.aborted) throw err;
    }
  }
}

/** The Harness refused the request itself (a 4xx other than 404): a jr2 defect, never retried. */
export class ExecRefused extends Error {}

/** The request certainly never reached the Harness (the connection was refused, the name did not
 * resolve): a start that failed so is safe to send again. Any other transport failure may have
 * reached it. */
export class ExecNotSent extends Error {}

function parseDuration(d: Duration): number {
  const n = Number.parseFloat(d);
  if (!(n > 0)) throw new Error(`command: timeout "${d}" is not a positive duration (like "90s", "10m", "1h")`);
  return d.endsWith("h") ? n * 3_600_000 : d.endsWith("m") ? n * 60_000 : n * 1000;
}
