// The Sandbox Effector's kinds (ADR-0067, ADR-0068): an `http` whose body is a Worktree file, a
// `push`, and a `command` that names a secret. Each is an actor slot; each runs in the Sandbox
// Effector of the Workspace whose body invokes it — a container beside the Agent in its Sandbox pod,
// with the Worktree mounted read-only, that holds the Effect secrets and the push credential the
// Agent never reads.
//
//   publish: push({ sign: true }),
//   report:  http({ method: "PUT", url: "https://files.example.com/r", auth: bearer(secret("files")),
//                   input: z.object({ path: z.string() }), body: file(({ path }) => path) }),
//   deploy:  command(["terraform", "apply", "-auto-approve"], { env: { AWS_PROFILE_FILE: secret("aws").path } }),
//
// What this module adds to the Effector's wire (http-effect.ts has the http kind's):
//
//   - THE PIN. A push and a credentialed command run against one commit: the Agent's branch tip
//     when the Effect starts — which the Effector reads as data and its answer names — or the
//     commit `pin` names (an approved one, from the Effect's input). It is written to the intent
//     row, so a restore repeats a push of only that commit.
//   - THE RESTORE RULE PER KIND. After an Orchestrator restart, or a start whose answer never came,
//     the Effect asks its Effector for its id: found, it is followed. Not found: a push and a
//     credentialed command are sent again with only the pinned commit the intent row holds — a run
//     is a function of (commit, argv, secrets), never of the Agent's tip now — and with none
//     recorded settle `unknown`; a file-body http is sent again only when marked `idempotent`.
//   - THE PAIRS AND THE SYNC. A push sends every push of its Workspace and Repo Slot that published
//     (each one's published commit, source and `squashed`), oldest first, as `pairs`: the input of
//     the Effector's `pair` fallback and of its map before signing.
//     After every push whose published commit is not the Agent's own — signed copies, or one
//     squashed commit, signed or not — the Orchestrator relays the bundle of the published commits
//     to the Workspace's Harness, which moves the Agent's branch to them (`POST /sync`); its
//     answer rides the output as `sync`, a
//     field beside the push's outcome. When the newest push's sync did not finish, it is run again
//     before the next push. The push never trusts it.
//   - D1. When its state exits, the Orchestrator stops polling and records the abort, "outcome
//     unknown". A credentialed command is stopped: one signed DELETE on its own path, and the
//     Effector ends its process group (SIGTERM, then SIGKILL past a grace); a stop that reaches it
//     before the command's start is kept there, and that start runs nothing. A push and a file-body
//     http are one request each and have no stop: the Effector runs them to their end. A park is
//     not an exit, and stops nothing.

import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ActorLogic, AnyActorRef, EventObject } from "xstate";
import type { z } from "zod";
import { ambientHandlesFor, type AmbientHandles } from "./ambient.ts";
import type {
  Arg,
  CommandParts,
  Duration,
  EffectLogic,
  EffectMarker,
  EffectRow,
  EffectSnapshot,
  HttpParts,
  PushParts,
  Unknown,
} from "./effect.ts";
import { lastPushOf, pushPairsOf } from "./effect.ts";
import {
  createEffectorClient,
  EffectorForged,
  EffectorMalformed,
  EffectorNotSent,
  EffectorRefused,
  MAX_START_BYTES,
  nodeEffectorTransport,
  type CommandStartRequest,
  type CommandWireOutput,
  type EffectorPort,
  type EffectState,
  type HttpOutput,
  type HttpStartRequest,
  type Pair,
  type PushStartRequest,
  type PushWireOutput,
  type RepoRef,
  type StartRequest,
} from "./effector-wire.ts";
import {
  httpParts,
  openHttpOf,
  OPEN_SECRET,
  openSecretsIn,
  secret,
  startRequestOf,
  type EffectorPortFactory,
  type FromInput,
  type HttpDefinition,
  type HttpOpenParts,
} from "./http-effect.ts";
import { open } from "./open.ts";
import type { OpenOf } from "./open-effect.ts";
import { boundRun, type AnyActorSystem } from "./registration.ts";
import { repoKey } from "./repo-identity.ts";
import { harnessSyncPort, type SyncPortFactory } from "./sync-client.ts";
import type { SyncAnswer } from "./wire.ts";

/** The work root a Sandbox pod's Worktrees sit under (ADR-0004), as both containers mount it. */
const WORK_ROOT = "/work";

const DEFAULT_PUSH_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TAIL = 4096;
const RETRY_MAX_MS = 10_000;

/** The real port factory: the Sandbox Effector's address, signed with its per-pod key. */
export function sandboxEffectorPort(target: Parameters<EffectorPortFactory>[0]): ReturnType<EffectorPortFactory> {
  return createEffectorClient({ key: target.key, transport: nodeEffectorTransport(target.service) });
}

// --- Naming a secret's file -----------------------------------------------------------------------

/** `secret("x").path` in a command's env: the path of the secret's file in the Sandbox Effector's
 * own mount, never its value (ADR-0067). */
export type SecretPath = { readonly secret: string; readonly path: true };

// --- Where a Repo Slot's repositories are in the pod ----------------------------------------------

/** The Repo Slot an Effect runs on: the one named, or the Workspace's only one. */
function slotOf(kind: string, slot: string, named: string | undefined, ambient: AmbientHandles): string {
  const slots = Object.keys(ambient.repos);
  if (named !== undefined) {
    if (ambient.repos[named] === undefined) {
      throw new Error(
        `${kind} "${slot}" names Repo Slot "${named}", which its Workspace does not carry (${slots.join(", ") || "none"})`,
      );
    }
    return named;
  }
  if (slots.length === 1) return slots[0]!;
  throw new Error(
    `${kind} "${slot}" runs under a Workspace carrying ${slots.length === 0 ? "no" : "more than one"} Repo Slot ` +
      `(${slots.join(", ") || "none"}) — say which: { slot: "<slot>" } (ADR-0051)`,
  );
}

/** The slot's repositories, relative to the work root: the Agent's common git dir is the pod-local
 * clone's, beside the branch Worktree (ADR-0004); the cache is the Binding's key (ADR-0051). */
export function repoRefOf(ambient: AmbientHandles, repoSlot: string): RepoRef & { url: string } {
  const worktree = ambient.repos[repoSlot]!;
  const url = ambient.bindings?.[repoSlot];
  if (url === undefined) {
    throw new Error(`Repo Slot "${repoSlot}" has no Binding url in its Workspace's handles — a jr2 defect`);
  }
  const rel = posix.relative(WORK_ROOT, worktree);
  return {
    gitDir: posix.join(posix.dirname(rel), "default", ".git"),
    worktree: rel,
    cache: repoKey(url),
    url,
  };
}

// --- The definitions -------------------------------------------------------------------------------

/** The options of `push()`. */
export type PushOptions = {
  // A pinned commit the Agent pruned is refused by the remote, never substituted (ADR-0067).
  /**
   * `true`: the input of the Effect names the commit to push (`{ sha }`, a full commit id, for
   * example one that a Gate approved). Default: the tip of the Agent's branch when the Effect
   * starts. When the Agent removed that commit from its branch, the remote refuses the push. jr2
   * never pushes another commit in its place.
   *
   * When it starts, it refuses a `sha` that is not a full commit id: `push({ pin: true }): its
   * input's sha is not a full commit id (got <sha>)`.
   */
  pin?: boolean;
  /**
   * `true`: push signed copies of the commits. The `sign` field of the `git.credentials` entry that
   * the Binding matches names the key. Default `false`.
   *
   * At `jr2 up`, it refuses an entry with no `sign` field: `<push> signed, and git.credentials
   * entry "<match>" holds no sign field — add sign: { sshKey: "<a Secret with identity>", name:
   * "<committer name>", email: "<committer email>" } to it; the email must belong to the forge
   * account that holds the key (ADR-0051, ADR-0067)`. `<push>` names the push: `workflow
   * "<workflow>": push "<slot>" pushes Repo Slot "<name>" (<url>)`.
   */
  sign?: boolean;
  /**
   * `true`: push one commit that holds all the changes. The input of the Effect gives its message
   * (`{ message }`). Signed, its committer is the signer. Unsigned, it is the `committer` of the
   * `git.credentials` entry that the Binding matches. Default `false`.
   *
   * When it starts, it refuses an input with no message: `push({ squash: true }): its input
   * carries no message`.
   *
   * At `jr2 up`, it refuses an unsigned squash whose entry has no `sign` and no `committer`:
   * `<push> squashed without sign, and git.credentials entry "<match>" holds neither sign nor
   * committer — the squashed commit is new and needs a committer; add committer: { name:
   * "<committer name>", email: "<committer email>" } to it, or sign the push — push({ squash:
   * true, sign: true }) — and add sign: { sshKey: "<a Secret with identity>", name: "<committer
   * name>", email: "<committer email>" } to it (ADR-0051, ADR-0067)`.
   */
  squash?: boolean;
  /** `true`: replace what the remote branch holds. Default `false`. */
  force?: boolean;
  /**
   * The Repo Slot to push. Write it only when the Workspace has more than one.
   *
   * When it starts, it refuses:
   * - no `slot` under a Workspace with more than one Repo Slot: `push "<slot>" runs under a
   *   Workspace carrying more than one Repo Slot (<slots>) — say which: { slot: "<slot>" }
   *   (ADR-0051)`
   * - a `slot` that the Workspace does not have: `push "<slot>" names Repo Slot "<name>", which
   *   its Workspace does not carry (<slots>)`
   */
  slot?: string;
  /**
   * How long jr2 waits for the push: a number and a unit, such as `"90s"` or `"5m"`. Default
   * `"5m"`. With no answer in that time, the output is `unknown`. It refuses a value that is not a
   * positive duration: `timeout "<timeout>" is not a positive duration (like "30s", "5m")`.
   */
  timeout?: Duration;
};

/** The input of a `push` Effect: `{ sha }` with `pin`, and `{ message }` with `squash`. */
export type PushInput<O extends PushOptions> = (O["pin"] extends true ? { sha: string } : unknown) &
  (O["squash"] extends true ? { message: string } : unknown);

/**
 * The sync's answer as a push's output carries it: a field beside the outcome, never the outcome.
 *
 * @internal
 */
export type SyncState = SyncAnswer["sync"];

// The sync's bundle never reaches the Machine: `deliver` drops it from the output (ADR-0067).
/**
 * The output of a `push` Effect: what the `onDone` of its state gets as `event.output`. Every
 * outcome is output, so route on `outcome`:
 *
 * - `pushed`: the remote has the commit. `published` is the commit on the remote, and `source` is
 *   the Agent's commit that it comes from. They are the same commit, unless the push was signed or
 *   squashed. `previous` is what the remote had before, and `unchanged` is `true` when the remote
 *   had the commit already. `squashed` is `signed` or `unsigned` when the commit on the remote is
 *   one squashed commit. `via` tells how jr2 found the new commits after a signed push:
 *   `ancestry`, `pair`, `cherry` or `force`.
 * - `rejected`: git or the remote refused the push. `stage` tells where, `reason` tells why, and
 *   `detail` has the words of git.
 * - `diverged`: the commit on the remote is not in the history of the Agent's branch, and jr2
 *   could not pair it with a commit there. Nothing was pushed. `reason` tells why, and `published`
 *   and `source` name the two commits.
 * - `unknown`: jr2 cannot tell what the push did. `reason` tells why.
 *
 * Beside `pushed`, `sync` tells what jr2 did to the Agent's branch after the push:
 *
 * - `synced`: the commit on the remote is not the Agent's own, and jr2 moved the branch to the
 *   published commits.
 * - `already`: the branch has the published commit already.
 * - `skipped`: the remote has the Agent's own commit, so the branch does not move.
 * - `busy`: a rebase, merge, cherry-pick or revert of the branch is in progress. Nothing changed.
 * - `not-synced`: the branch did not move.
 *
 * With `busy` or `not-synced`, `syncReason` tells why, and jr2 tries again before the next push.
 *
 * @example
 * ```ts
 * import { jr2Setup, push, workspace, type PushOutput, type Workspaced } from "@jr2/orchestrator";
 *
 * type Input = Workspaced<{ sha: string }, "app">;
 *
 * // A push that did not happen (`rejected` or `diverged`) is a different problem from one jr2
 * // cannot see (`unknown`).
 * const notPushed = (output: PushOutput): boolean =>
 *   output.outcome === "rejected" || output.outcome === "diverged";
 *
 * const body = jr2Setup({
 *   types: {} as { context: Input; input: Input },
 *   actors: { publish: push({ pin: true }) },
 * }).createMachine({
 *   id: "release",
 *   context: ({ input }) => input,
 *   initial: "publishing",
 *   states: {
 *     publishing: {
 *       invoke: {
 *         src: "publish",
 *         input: ({ context }) => ({ sha: context.sha }),
 *         onDone: [
 *           { guard: ({ event }) => event.output.outcome === "pushed", target: "published" },
 *           { guard: ({ event }) => notPushed(event.output), target: "notPushed" },
 *           { target: "unknown" },
 *         ],
 *       },
 *     },
 *     published: { type: "final" },
 *     notPushed: { type: "final" },
 *     unknown: { type: "final" },
 *   },
 * });
 *
 * export const machine = workspace(body, {
 *   repos: { app: { url: "https://github.com/you/app.git" } },
 *   spec: () => ({ branch: "release" }),
 * });
 * ```
 *
 * @see docs/guides/push-and-sign-a-branch.md
 * @see docs/concepts/effects.md
 * @see docs/reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md
 */
export type PushOutput =
  | Exclude<PushWireOutput, { outcome: "pushed" }>
  | (Omit<Extract<PushWireOutput, { outcome: "pushed" }>, "bundle"> & { sync: SyncState; syncReason?: string });

export function pushParts(options: PushOptions = {}): PushParts {
  const inputKeys = [...(options.pin ? ["sha"] : []), ...(options.squash ? ["message"] : [])];
  return {
    kind: "push",
    pin: options.pin === true,
    sign: options.sign === true,
    squash: options.squash === true,
    force: options.force === true,
    timeoutMs: options.timeout === undefined ? DEFAULT_PUSH_TIMEOUT_MS : parseDuration(options.timeout),
    secrets: [],
    inputKeys,
    ...(options.slot !== undefined ? { slot: options.slot } : {}),
  };
}

/** The push's start for one run: the Binding, the branch, the pin, the ledger's last pair. */
export function pushStartOf(
  parts: PushParts,
  ref: RepoRef & { url: string },
  branch: string,
  input: { sha?: string; message?: string } | undefined,
  pairs?: readonly Pair[],
): PushStartRequest {
  const pin = parts.pin ? input?.sha : undefined;
  if (parts.pin && (typeof pin !== "string" || !/^[0-9a-f]{40}$/.test(pin))) {
    throw new Error(`push({ pin: true }): its input's sha is not a full commit id (got ${JSON.stringify(pin)})`);
  }
  const message = parts.squash ? input?.message : undefined;
  if (parts.squash && (typeof message !== "string" || message.trim() === "")) {
    throw new Error("push({ squash: true }): its input carries no message");
  }
  return {
    kind: "push",
    push: {
      repo: { gitDir: ref.gitDir, worktree: ref.worktree, cache: ref.cache },
      url: ref.url,
      branch,
      ...(pin ? { pin } : {}),
      ...(parts.sign ? { sign: true } : {}),
      ...(message ? { squash: message } : {}),
      ...(parts.force ? { force: true } : {}),
      ...(pairs?.length ? { pairs: [...pairs] } : {}),
    },
    timeoutMs: parts.timeoutMs,
  };
}

/** A file-body http's start for one run (ADR-0067): the definition's parts, the url's segments, and
 * the Worktree file as the body. */
export function fileStartOf(
  parts: HttpParts,
  worktree: string,
  run: { path: string; segments?: readonly string[] },
): HttpStartRequest {
  if (typeof run?.path !== "string") throw new Error("http: `file()` gave no path");
  if (run.segments !== undefined && !run.segments.every((s) => typeof s === "string")) {
    throw new Error("http: `file()`'s segments are not a list of strings");
  }
  const http = startRequestOf(parts, run.segments ? { path: run.segments } : {});
  const contentType = parts.file?.contentType;
  return { ...http, body: { file: { worktree, path: run.path, ...(contentType ? { contentType } : {}) } } };
}

/** The `env` of a `command`: for each variable, `secret("name")` for the value of an Effect
 * secret, or `secret("name").path` for the path of a file that holds it. */
export type CommandEnv = Readonly<Record<string, { readonly secret: string; readonly path: unknown }>>;

export function commandEnvParts(env: CommandEnv): Pick<CommandParts, "env" | "secrets" | "openSecret"> {
  const out: Record<string, { secret: string; path?: true }> = {};
  for (const [name, ref] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === "PATH" || name === "HOME" || name === "TMPDIR") {
      throw new Error(
        `command(argv, { env }): "${name}" is not a variable the author sets — PATH, HOME and TMPDIR are the ` +
          "Effector's (ADR-0067)",
      );
    }
    // `secret(open)` and its `.path` stand under OPEN_SECRET until the composer names it (ADR-0054).
    const s = ref.secret === OPEN_SECRET ? ref : secret(ref.secret);
    out[name] = (ref as { path?: unknown }).path === true ? { secret: s.secret, path: true } : { secret: s.secret };
  }
  const opened = openSecretsIn(Object.values(env));
  const secrets = [...new Set(Object.values(out).map((r) => r.secret))].filter((n) => n !== OPEN_SECRET).sort();
  return { env: out, secrets, ...(opened ? { openSecret: true as const } : {}) };
}

/** The credentialed command's start for one run. */
export function commandStartOf(
  parts: CommandParts,
  argv: string[],
  ref: RepoRef,
  branch: string,
  pin?: string,
): CommandStartRequest {
  return {
    kind: "command",
    command: {
      repo: { gitDir: ref.gitDir, worktree: ref.worktree, cache: ref.cache },
      branch,
      ...(pin ? { pin } : {}),
      argv,
      env: Object.fromEntries(
        Object.entries(parts.env ?? {}).map(([k, v]) => [
          k,
          v.path ? { secret: v.secret, path: true } : { secret: v.secret },
        ]),
      ),
      tail: parts.tail,
    },
    timeoutMs: parts.timeoutMs,
  };
}

// --- The actor logic -------------------------------------------------------------------------------

type Settle = { type: "jr2.effect.settle"; output: unknown };
type Fault = { type: "jr2.effect.error"; error: unknown };

/** What a kind's hooks get: the run's ledger, the Workspace, and the call's signal. */
type KindContext = {
  ambient: AmbientHandles;
  binding: ReturnType<typeof boundRun>;
  id: string;
  slot: string;
  signal: AbortSignal;
  mark: (marker: Omit<EffectMarker, "kind" | "slot" | "effect">) => void;
};

/** How one Sandbox kind builds its start and what a restore may send again. */
type KindSpec = {
  kind: "http" | "push" | "command";
  idempotent: boolean;
  /** A restore that finds no Effect sends it again with only the pinned commit. */
  repeatsPinned: boolean;
  label: (ambient: AmbientHandles) => string;
  /** The Repo Slot the Effect runs on, written to its settled row. */
  repoOf: (ambient: AmbientHandles, slot: string) => string;
  /** The start for this run; `pinned` is the commit the intent row recorded. */
  build: (input: unknown, ambient: AmbientHandles, slot: string, pinned?: string, extra?: StartExtra) => StartRequest;
  /** Run before a start is sent (a push: the last sync again, and the ledger's pair). */
  before?: (ctx: KindContext) => Promise<StartExtra>;
  /** Run on the Effector's settled output before it is ledgered (a push: the sync). */
  finish?: (output: unknown, ctx: KindContext) => Promise<unknown>;
  /** What a settled output becomes for the Machine. */
  deliver?: (output: unknown) => unknown;
};

type StartExtra = { pairs?: readonly Pair[] };

/** An Effect's run: its abort, and — for a credentialed command, once its Effector is known — the
 * port its stop goes through (ADR-0067). */
type Running = { controller: AbortController; port?: EffectorPort };
const running = new WeakMap<AnyActorRef, Running>();

/** How long a stop's DELETE may take: the Effector answers once the command's group is gone,
 * SIGTERM then SIGKILL past its grace, within its poll's hold. */
const STOP_WAIT_MS = 60_000;

function sandboxLogic<I, O>(
  portFactory: EffectorPortFactory,
  parts: HttpParts | PushParts | CommandParts,
  spec: KindSpec,
): EffectLogic<I, O> {
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
      const controller = new AbortController();
      running.set(self, { controller });
      void drive(self, system, snapshot, spec, portFactory, controller.signal).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (self.getSnapshot().status === "active") self.send({ type: "jr2.effect.error", error } as Fault);
      });
    },
    getPersistedSnapshot: (snapshot) => snapshot,
  };
  return Object.assign(logic, { effect: parts });
}

const slotName = (self: AnyActorRef): string => (typeof self.src === "string" ? self.src : self.id);

async function drive<I, O>(
  self: AnyActorRef,
  system: AnyActorSystem,
  snapshot: EffectSnapshot<O, I>,
  spec: KindSpec,
  portFactory: EffectorPortFactory,
  signal: AbortSignal,
): Promise<void> {
  const binding = boundRun(system);
  const id = snapshot.effectId;
  const slot = slotName(self);
  const ambient = ambientHandlesFor(self);
  const now = (): string => new Date().toISOString();
  const mark = (marker: Omit<EffectMarker, "kind" | "slot" | "effect">): void =>
    binding?.marker?.({ kind: "effect", slot, effect: id, ...marker });
  const settle = (output: unknown): void => {
    if (signal.aborted || self.getSnapshot().status !== "active") return;
    binding?.recordEffect?.(id, {
      state: "settled",
      kind: spec.kind,
      slot,
      ...(ambient ? { sandbox: ambient.sandbox, ...repoField(spec, ambient, slot) } : {}),
      output,
      at: now(),
    });
    mark({ stage: "settled", output: output as HttpOutput });
    self.send({ type: "jr2.effect.settle", output: spec.deliver ? spec.deliver(output) : output } satisfies Settle);
  };
  const unknown = (reason: string): Unknown => ({ outcome: "unknown", reason });

  const row = binding?.effectRow?.(id);
  if (row?.state === "settled") {
    await Promise.resolve();
    if (!signal.aborted && self.getSnapshot().status === "active") {
      self.send({
        type: "jr2.effect.settle",
        output: spec.deliver ? spec.deliver(row.output) : row.output,
      } satisfies Settle);
    }
    return;
  }
  if (row?.state === "aborted") {
    settle(unknown("its state exited while it ran; not run again"));
    return;
  }

  if (!ambient) {
    throw new Error(
      `${spec.kind} "${slot}" runs in the Sandbox Effector of a Workspace, and its state is not inside a ` +
        "workspace() — invoke it from a Workspace's body (ADR-0067)",
    );
  }
  const target = binding?.effector?.({ sandbox: ambient.sandbox });
  if (!target) {
    throw new Error(
      `${spec.kind} "${slot}" runs in the Sandbox Effector of Sandbox "${ambient.sandbox}", and this Orchestrator ` +
        "knows no address for it (ADR-0067)",
    );
  }
  const port = portFactory(target);
  // A credentialed command's stop goes through this port when its state exits (ADR-0067).
  const run = running.get(self);
  if (spec.kind === "command" && run) run.port = port;
  const ctx: KindContext = { ambient, binding, id, slot, signal, mark };

  const find = async (): Promise<{ found: EffectState | undefined } | undefined> => {
    try {
      return { found: await retrying(() => port.find(id, signal), signal) };
    } catch (err) {
      if (signal.aborted || !(err instanceof EffectorForged)) throw err;
      settle(unknown(`${err.message}: the answer is not the Sandbox Effector's; not run again`));
      return undefined;
    }
  };
  const intent = (pinned?: string): EffectRow => ({
    state: "intent",
    kind: spec.kind,
    slot,
    placement: "sandbox",
    sandbox: ambient.sandbox,
    idempotent: spec.idempotent,
    ...(pinned ? { pinned } : {}),
    at: now(),
  });
  /** Not found where it was: the restore rule of the kind. */
  const notFound = async (pinned: string | undefined, why: string): Promise<void> => {
    if (spec.repeatsPinned && pinned) {
      mark({
        stage: "started",
        text: `${spec.label(ambient)} (sent again: only the pinned commit ${pinned.slice(0, 12)})`,
      });
      const extra = spec.before ? await spec.before(ctx) : {};
      if (signal.aborted) return;
      await send(spec.build(snapshot.input, ambient, slot, pinned, extra), pinned);
      return;
    }
    if (spec.kind === "http" && spec.idempotent) {
      mark({ stage: "started", text: `${spec.label(ambient)} (sent again: it is idempotent)` });
      await send(spec.build(snapshot.input, ambient, slot), undefined);
      return;
    }
    settle(unknown(`${why}; not run again`));
  };

  if (row?.state === "intent") {
    const pinned = "pinned" in row ? row.pinned : undefined;
    const asked = await find();
    if (!asked || signal.aborted) return;
    if (asked.found) {
      await follow(asked.found, pinned);
      return;
    }
    await notFound(
      pinned,
      "it was in flight when the Orchestrator restarted, and its Sandbox Effector no longer holds it",
    );
    return;
  }

  const extra = spec.before ? await spec.before(ctx) : {};
  if (signal.aborted) return;
  const req = spec.build(snapshot.input, ambient, slot, undefined, extra);
  const big = tooLarge(req);
  if (big) {
    settle(big);
    return;
  }
  binding?.recordEffect?.(id, intent());
  mark({ stage: "started", text: spec.label(ambient) });
  await send(req, undefined);

  async function send(req: StartRequest, pinned: string | undefined): Promise<void> {
    for (let wait = 250; ; wait = Math.min(wait * 2, RETRY_MAX_MS)) {
      let state: EffectState;
      try {
        state = await port.start(id, req, signal);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof EffectorRefused || err instanceof EffectorMalformed) throw err;
        if (!(err instanceof EffectorNotSent)) {
          const asked = await find();
          if (!asked || signal.aborted) return;
          if (asked.found) {
            await follow(asked.found, pinned);
            return;
          }
          await notFound(pinned, "its start may have reached the Sandbox Effector, which does not hold it now");
          return;
        }
        await sleep(wait, signal);
        if (signal.aborted) return;
        continue;
      }
      await follow(state, pinned);
      return;
    }
  }

  async function follow(first: EffectState, pinned: string | undefined): Promise<void> {
    let state = first;
    // The commit the Effector pinned goes to the intent row, saved at the write: a restore repeats
    // only it.
    if (state.pinned && state.pinned !== pinned) {
      pinned = state.pinned;
      binding?.recordEffect?.(id, intent(pinned));
    }
    for (;;) {
      if (state.state === "settled" && state.output) {
        const output = spec.finish ? await spec.finish(state.output, ctx) : state.output;
        if (signal.aborted) return;
        settle(output);
        return;
      }
      if (state.state === "unknown") {
        const asked = await find();
        if (!asked || signal.aborted) return;
        if (!asked.found) {
          await notFound(pinned, "its Sandbox Effector no longer holds it (it restarted)");
          return;
        }
        state = asked.found;
        continue;
      }
      try {
        state = await port.poll(state.replica, id, signal);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof EffectorRefused || err instanceof EffectorMalformed) throw err;
        state = { effect: id, replica: state.replica, state: "unknown" };
      }
      if (signal.aborted) return;
    }
  }
}

/** The settled row's Repo Slot, or none when the Workspace does not name one the kind can run on.
 */
function repoField(spec: KindSpec, ambient: AmbientHandles, slot: string): { repo?: string } {
  try {
    return { repo: spec.repoOf(ambient, slot) };
  } catch {
    return {};
  }
}

function stopped(self: AnyActorRef, system: AnyActorSystem, effectId: string): void {
  const run = running.get(self);
  run?.controller.abort();
  running.delete(self);
  const binding = boundRun(system);
  if (binding?.hostStopping) return;
  const row = binding?.effectRow?.(effectId);
  if (row?.state !== "intent" || !("sandbox" in row)) return;
  // A credentialed command is stopped where it runs: one signed DELETE on its own path, and its
  // Sandbox Effector ends its process group (ADR-0067). A push and a file-body http are one request
  // each, and have no stop.
  // What the stop's answer says goes to the feed after the abort's line: the outcome the Effector
  // settled it with (`exited` with the signal), or that the stop did not reach it. It is sent at once,
  // while a start may still be on the wire: the Effector keeps a stop of an id it does not hold, and
  // the start that arrives after it runs nothing.
  const port = row.kind === "command" ? run?.port : undefined;
  port?.stop(effectId, AbortSignal.timeout(STOP_WAIT_MS)).then(
    (state) => {
      binding?.marker?.({
        kind: "effect",
        slot: row.slot,
        effect: effectId,
        stage: "aborted",
        text: stoppedText(state),
      });
    },
    (err: unknown) => {
      binding?.marker?.({
        kind: "effect",
        slot: row.slot,
        effect: effectId,
        stage: "aborted",
        text: `the stop did not reach its Sandbox Effector (${err instanceof Error ? err.message : String(err)}); it may run until its timeout`,
      });
    },
  );
  binding?.recordEffect?.(
    effectId,
    { state: "aborted", kind: row.kind, slot: row.slot, at: new Date().toISOString() },
    "with-transition",
  );
  binding?.marker?.({
    kind: "effect",
    slot: row.slot,
    effect: effectId,
    stage: "aborted",
    text: port
      ? "its state exited while it ran: its Sandbox Effector was asked to stop it; outcome unknown"
      : "its state exited while it ran: no longer followed; the Sandbox Effector may still run it; outcome unknown",
  });
}

/** The feed's line for a stop's answer (ADR-0067): the outcome a stopped command settled with —
 * `exited` with the signal the stop sent last, and its code when the program caught SIGTERM; for
 * one stopped before its program started, `unknown` with the Effector's reason (it did not run);
 * for one that had ended first, that outcome. When no replica holds it, the start may not have
 * arrived yet: the Effector keeps the stop, and the line says that a start still on the way runs
 * nothing; one not settled within the stop's answer is said as such. */
function stoppedText(state: EffectState | undefined): string {
  if (state === undefined) {
    return "its Sandbox Effector held no such Effect when asked to stop it; a start still on the way runs nothing";
  }
  const out = state.state === "settled" ? state.output : undefined;
  if (!out) return "its Sandbox Effector had not settled it when the stop answered; outcome unknown";
  if (out.outcome === "exited" && "signal" in out) {
    return `its Sandbox Effector stopped it: exited with ${out.signal}${out.code === undefined ? "" : `, code ${out.code}`}`;
  }
  if (out.outcome === "unknown" && "reason" in out) return `its Sandbox Effector stopped it: ${out.reason}`;
  return `its Sandbox Effector stopped it: it had already ended (${out.outcome})`;
}

/** A start over the bytes an Effector reads is sent nowhere, and settles as its kind's own outcome
 * (ADR-0067): an http `refused`; a push `rejected` at stage `start` — nothing pushed; a
 * credentialed command `exited` 127 with the reason in its tail, the Effector's own form for a
 * command that could not start. An Agent's pick parameter — a squash message, an argv part — can
 * reach the bound. */
function tooLarge(req: StartRequest): HttpOutput | PushWireOutput | CommandWireOutput | undefined {
  const bytes = Buffer.byteLength(JSON.stringify(req), "utf8");
  if (bytes <= MAX_START_BYTES) return undefined;
  const reason = `the request is ${bytes} bytes, over the ${MAX_START_BYTES} bytes an Effector reads`;
  if (req.kind === "push") return { outcome: "rejected", stage: "start", reason: `${reason}; nothing was pushed` };
  if (req.kind === "command") return { outcome: "exited", code: 127, tail: `${reason}; nothing was run\n` };
  return { outcome: "refused", reason: `${reason}; nothing was sent` };
}

async function retrying<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let wait = 250; ; wait = Math.min(wait * 2, RETRY_MAX_MS)) {
    try {
      return await call();
    } catch (err) {
      if (
        signal.aborted ||
        err instanceof EffectorRefused ||
        err instanceof EffectorMalformed ||
        err instanceof EffectorForged
      ) {
        throw err;
      }
      await sleep(wait, signal);
      if (signal.aborted) throw err;
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms / 2 + Math.random() * (ms / 2));
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function parseDuration(d: Duration): number {
  const n = Number.parseFloat(d);
  if (!(n > 0)) throw new Error(`timeout "${d}" is not a positive duration (like "30s", "5m")`);
  return d.endsWith("h") ? n * 3_600_000 : d.endsWith("m") ? n * 60_000 : n * 1000;
}

// --- The constructors, over an injected port factory (the unit tests' seam) ----------------------

export function pushWith<const O extends PushOptions>(
  portFactory: EffectorPortFactory,
  options?: O,
  syncPorts: SyncPortFactory = harnessSyncPort,
): EffectLogic<PushInput<O> | void, PushOutput> {
  const parts = pushParts(options);
  const repoOf = (ambient: AmbientHandles, slot: string) => slotOf("push", slot, parts.slot, ambient);
  const worktreeOf = (ctx: KindContext) => ctx.ambient.repos[repoOf(ctx.ambient, ctx.slot)]!;
  const syncOf = (ctx: KindContext) =>
    syncPorts(ctx.ambient.endpoint, ctx.binding?.harnessBearer?.(ctx.ambient.sandbox));
  return sandboxLogic(portFactory, parts, {
    kind: "push",
    idempotent: false,
    repeatsPinned: true,
    label: (ambient) => `push ${ambient.branch}${parts.sign ? " (signed)" : ""}`,
    repoOf,
    build: (input, ambient, slot, pinned, extra) => {
      const repoSlot = slotOf("push", slot, parts.slot, ambient);
      const ref = repoRefOf(ambient, repoSlot);
      const req = pushStartOf(parts, ref, ambient.branch, input as { sha?: string; message?: string }, extra?.pairs);
      if (pinned) req.push.pin = pinned;
      return req;
    },
    // Every push of this Workspace's Repo Slot — one branch, one remote — that published gives the
    // Effector a pair, oldest first (ADR-0067). The newest one's sync, when it did not finish, runs
    // again first, in that slot's Worktree and from the bundle the row keeps while it is the newest
    // push and its sync did not finish (`dropSavedTails`); the push does not depend on it.
    before: async (ctx) => {
      const rows = ctx.binding?.effectRows?.() ?? {};
      const repo = repoOf(ctx.ambient, ctx.slot);
      const last = lastPushOf(rows, ctx.ambient.sandbox, repo, ctx.id);
      if (last === undefined) return {};
      const { row, rowId, output } = last;
      if (output.sync === "busy" || output.sync === "not-synced") {
        const answer = await syncOf(ctx).sync(
          {
            worktree: worktreeOf(ctx),
            branch: ctx.ambient.branch,
            published: output.published,
            source: output.source,
            ...(typeof output.bundle === "string" ? { bundle: output.bundle } : {}),
          },
          ctx.signal,
        );
        if (ctx.signal.aborted) return {};
        ctx.mark({ stage: "output", text: `the last push's sync, run again before this push: ${answer.sync}` });
        ctx.binding?.recordEffect?.(rowId, { ...row, output: { ...output, ...syncFields(answer) } });
      }
      // Each row's `squashed` rides beside its pair: a push that maps the same commit names what it is.
      return { pairs: pushPairsOf(rows, ctx.ambient.sandbox, repo, ctx.id) };
    },
    // After every pushed outcome whose published commit is not the Agent's own — signed copies, or
    // one squashed commit, signed or not (ADR-0067): the sync, in the Workspace's Harness, from the
    // bundle the Effector wrote, a push that published nothing new (a pair or cherry that mapped
    // the published tip) included. The decision keys on published != source, never on `sign`. A
    // push of the Agent's own commit is `skipped`, nothing to send.
    finish: async (output, ctx) => {
      const o = output as PushWireOutput;
      if (o.outcome !== "pushed") return o;
      if (o.published === o.source) return { ...o, sync: "skipped" satisfies SyncState };
      const answer = await syncOf(ctx).sync(
        {
          worktree: worktreeOf(ctx),
          branch: ctx.ambient.branch,
          published: o.published,
          source: o.source,
          ...(o.bundle !== undefined ? { bundle: o.bundle } : {}),
        },
        ctx.signal,
      );
      return { ...o, ...syncFields(answer) };
    },
    deliver: (output) => {
      const o = output as PushWireOutput;
      if (o.outcome !== "pushed" || o.bundle === undefined) return o;
      const { bundle: _bundle, ...rest } = o;
      return rest;
    },
  }) as EffectLogic<PushInput<O> | void, PushOutput>;
}

/** The sync's answer as the output's fields: its state, and its reason when it moved nothing. */
function syncFields(answer: SyncAnswer): { sync: SyncState; syncReason?: string } {
  return {
    sync: answer.sync,
    ...("reason" in answer && answer.sync !== "skipped" ? { syncReason: answer.reason } : {}),
  };
}

export { lastPushOf };

/** An http whose body is a Worktree file (ADR-0067), over an injected port factory — the seam
 * `http()` and the unit tests share. It runs in the Sandbox Effector of the Workspace whose body
 * invokes it. */
export function httpFileWith<
  S extends z.ZodType | undefined = undefined,
  const U extends HttpDefinition<S>["url"] = string,
  const A extends HttpDefinition<S>["auth"] = undefined,
  const H extends HttpDefinition<S>["headers"] = undefined,
>(
  portFactory: EffectorPortFactory,
  def: HttpDefinition<S> & { url: U; auth?: A; headers?: H },
): EffectLogic<S extends z.ZodType ? z.infer<S> : void, HttpOutput> & OpenOf<HttpOpenParts<U, A, H>>;
export function httpFileWith<S extends z.ZodType | undefined = undefined>(
  portFactory: EffectorPortFactory,
  def: HttpDefinition<S>,
): EffectLogic<S extends z.ZodType ? z.infer<S> : void, HttpOutput> {
  // Open parts (ADR-0054), as http's own: the unbound logic binds by building this Effect again,
  // whole, with the composer's url or secret — a file body changes where it runs, not how it binds.
  const unbound = openHttpOf(def, (bound) => httpFileWith(portFactory, bound));
  if (unbound) return unbound as EffectLogic<S extends z.ZodType ? z.infer<S> : void, HttpOutput>;
  const parts = httpParts(def);
  const body = def.body!.file;
  const fromInput = <T>(v: FromInput<S, T> | undefined, input: unknown): T | undefined =>
    typeof v === "function" ? (v as (i: unknown) => T)(input) : v;
  return sandboxLogic(portFactory, parts, {
    kind: "http",
    idempotent: parts.idempotent,
    repeatsPinned: false,
    label: () => `http ${parts.method} ${parts.target.scheme}://${parts.target.host} (a Worktree file)`,
    repoOf: (ambient, slot) => slotOf("http", slot, body.slot, ambient),
    build: (input, ambient, slot) => {
      let value: unknown = input;
      if (def.input !== undefined) {
        const parsed = def.input.safeParse(input);
        if (!parsed.success) throw new Error(`http "${slot}": its input does not match the definition's input schema`);
        value = parsed.data;
      }
      const repoSlot = slotOf("http", slot, body.slot, ambient);
      const worktree = posix.relative(WORK_ROOT, ambient.repos[repoSlot]!);
      const segments = fromInput<readonly string[]>(body.segments, value);
      return fileStartOf(parts, worktree, {
        path: fromInput<string>(body.path, value)!,
        ...(segments !== undefined ? { segments } : {}),
      });
    },
  });
}

/** A command whose env names a secret: it runs in the Sandbox Effector against the pinned commit.
 */
export function credentialedCommandWith(
  portFactory: EffectorPortFactory,
  parts: CommandParts,
  argvOf: (input: unknown, slot: string) => string[],
  pin = false,
): EffectLogic<unknown, CommandWireOutput> {
  return sandboxLogic(portFactory, parts, {
    kind: "command",
    idempotent: false,
    repeatsPinned: true,
    label: () => parts.argv.map((a) => (typeof a === "string" ? a : `<${(a as Arg).arg}>`)).join(" "),
    repoOf: (ambient, slot) => slotOf("command", slot, parts.slot, ambient),
    build: (input, ambient, slot, pinned) => {
      const repoSlot = slotOf("command", slot, parts.slot, ambient);
      const ref = repoRefOf(ambient, repoSlot);
      const approved = pin ? (input as { sha?: unknown } | undefined)?.sha : undefined;
      if (pin && (typeof approved !== "string" || !/^[0-9a-f]{40}$/.test(approved))) {
        throw new Error(`command "${slot}" (pin): its input's sha is not a full commit id`);
      }
      return commandStartOf(
        parts,
        argvOf(input, slot),
        ref,
        ambient.branch,
        pinned ?? (approved as string | undefined),
      );
    },
  });
}

/**
 * Make a `push` Effect: it pushes the branch of the Workspace to the Binding of its Repo Slot.
 * Put it in `actors`, and invoke it from the body of a `workspace()`: `actors: { publish: push({
 * sign: true }) }`.
 *
 * It runs in the Sandbox Effector of the Workspace, with the push credential of the
 * `git.credentials` entry that the Binding matches. The Agent never reads that credential. It
 * pushes one commit: the tip of the Agent's branch when the Effect starts, or, with `pin`, the
 * commit that the input names. After an Orchestrator restart, jr2 pushes only that same commit
 * again. With `sign` or `squash`, the commit on the remote is not the Agent's own. Then jr2 moves
 * the Agent's branch to it.
 *
 * Every outcome is output (`PushOutput`): `pushed`, `rejected`, `diverged` or `unknown`. Each
 * field of {@link PushOptions} tells what it refuses. When it starts, it also refuses a push
 * outside a Workspace: `push "<slot>" runs in the Sandbox Effector of a Workspace, and its state is
 * not inside a workspace() — invoke it from a Workspace's body (ADR-0067)`.
 *
 * @param options - Optional. Each field tells what it does.
 * @returns An Effect, for `actors`.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import {
 *   agent,
 *   defineEvent,
 *   jr2Setup,
 *   push,
 *   workspace,
 *   type Workspaced,
 * } from "@jr2/orchestrator";
 *
 * const committed = defineEvent({
 *   name: "committed",
 *   description: "Say that the fix is committed.",
 *   input: z.object({}),
 * });
 *
 * type Input = Workspaced<{}, "app">;
 *
 * const body = jr2Setup({
 *   types: {} as { context: Input; input: Input },
 *   events: [committed],
 *   actors: {
 *     coder: agent({
 *       model: "anthropic/claude-haiku-5-5",
 *       instructions: "You are a careful engineer.",
 *     }),
 *     publish: push({ sign: true }),
 *   },
 * }).createMachine({
 *   id: "fix-test",
 *   context: ({ input }) => input,
 *   initial: "coding",
 *   states: {
 *     coding: {
 *       invoke: { src: "coder", input: { prompt: "Fix the failing test, and commit the fix." } },
 *       // The Agent moves the Machine on with a pick. An Agent's actor never ends, so `onDone`
 *       // never fires.
 *       on: { committed: "publishing" },
 *     },
 *     publishing: {
 *       invoke: {
 *         src: "publish",
 *         onDone: [
 *           { guard: ({ event }) => event.output.outcome === "pushed", target: "done" },
 *           { target: "failed" },
 *         ],
 *       },
 *     },
 *     done: { type: "final" },
 *     failed: { type: "final" },
 *   },
 * });
 *
 * export const machine = workspace(body, {
 *   repos: { app: { url: "https://github.com/you/app.git" } },
 *   spec: () => ({ branch: "fix-test" }),
 * });
 * ```
 *
 * @see docs/guides/push-and-sign-a-branch.md
 * @see docs/concepts/effects.md
 * @see docs/guides/give-the-cluster-git-credentials.md
 * @see docs/reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md
 * @see docs/reference/decisions/0051-a-repo-is-a-slot-on-the-workspace-and-a-cache-on-the-node.md
 */
export function push<const O extends PushOptions>(options?: O): EffectLogic<PushInput<O> | void, PushOutput> {
  // After an Orchestrator restart, a push is sent again with only the commit its intent row holds
  // (ADR-0067): a run is a function of the commit, never of the Agent's tip now.
  return pushWith(sandboxEffectorPort, options);
}

export { DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_TAIL };
