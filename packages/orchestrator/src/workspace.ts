// `workspace(body, { input, image, user, repos, resources, spec })` (ADR-0012, ADR-0049, ADR-0051,
// ADR-0060): the jr2-owned wrapper Machine that owns ONLY Sandbox lifecycle — provision the Sandbox
// (out of the STATIC `image`/`user`/`repos`/`resources` options it carries) + attach one worktree per Repo Slot, run the
// author's body Machine inside it as the named slot `body`, with `{ workspace: { repos, branch } }`
// appended to its input (the mechanism-facing endpoint/sandbox are published ambiently
// — ADR-0016, ambient.ts), and destroy the Sandbox when the body reaches a final state. Teardown lives INSIDE the
// wrapper's own states because an xstate stop is synchronous — multi-step async cleanup must be
// states the machine transitions through itself, which forces the thing that provisions to also
// observe the body's completion (the ADR's load-bearing argument). There is no retain policy: a
// body that parks in a non-final state keeps its Sandbox alive by construction; the operator's
// idle-timeout GC is the backstop for the paths no machine can cover (kill -9, body error).
//
// The SandboxPort is HOST infrastructure reached via the run binding (like the registration
// table): one cluster per orchestrator instance, so the port rides `RunHostOptions.sandbox`,
// never workflow code — `workspace` stays a plain static import (ADR-0011 doctrine) and unit
// tests bind a fake port. Every port operation is invoked from a state that RE-RUNS on restore
// (invoked actors re-execute from persisted input), so every operation must be idempotent.
//
// The lifecycle (ADR-0012, ADR-0064): `placing` writes the Sandbox and waits, with no deadline,
// for its pod to be scheduled; `provisioning` waits for Ready under a budget that starts there;
// `attaching` runs the Harness's attach; `running` runs the body; `teardown` destroys.
//
// Restore-reconcile (ADR-0012, ADR-0021): every state from `placing` to `running` co-invokes the
// lease, and in `running` the lease judges Continuity from the Orchestrator's watch for its
// Sandbox (ADR-0063). Invoked callback actors restart on every (re)entry — including snapshot
// restore — so after an orchestrator restart the watch's first list is the reconcile: present and
// not Lost → nothing (agent admissions re-attach — ADR-0016); gone or Lost → the pod-local clone
// and any unpushed commits are gone, so it delivers `workspace.lost` INTO the restored body (same
// channel as `agent.fault`) and the body's policy decides. Never silently re-provision.

import {
  assign,
  fromCallback,
  fromPromise,
  sendTo,
  setup,
  type AnyStateMachine,
  type InputFrom,
  type OutputFrom,
  type StateMachine,
} from "xstate";
import type { z } from "zod";
import { registerAmbientHandles, type AmbientHandles } from "./ambient.ts";
import {
  actorSlotPath,
  assertRepoSlot,
  attachSandboxParts,
  attachWrapperBody,
  customizeLine,
  open,
  repoSlotState,
  sandboxPartsOf,
  type Binding,
  type JR2Repos,
  type JR2Wrapper,
  type RepoSlot,
  type SandboxParts,
  type WrapperActors,
} from "./parts.ts";
import { actorPath, runBindingOf, type AnyActorSystem } from "./registration.ts";
import { assertSize, assertUserSeat, userSeatOf, type Size, type UserContainer } from "./size.ts";
import { attachInputSchema, inputSchemaOf, invokingMachine, type HostInjectedInput } from "./vocabulary.ts";

/** Lease cadence when the backend names none. Well inside the 30m default idle timeout, so a
 * few missed renewals in a row are survivable. It bounds only how long an orphan waits to be
 * reaped: loss is the watch's news, within seconds (ADR-0021, ADR-0063). */
const DEFAULT_LEASE_INTERVAL_MS = 5 * 60_000;

/** Each renewal lands at the interval ±20% (ADR-0021), so Leases restored together after an
 * Orchestrator restart never renew in lockstep. */
const LEASE_JITTER = 0.2;

/**
 * When the lease renews next (ADR-0021), for a draw `random` in [0, 1]: every renewal at the
 * interval ±20%, and the FIRST within a fifth of it — spread, like the rest, but soon, because a
 * restore may follow an Orchestrator that was away for a while and the idle timeout has been
 * running since its last stamp. Exported for the tests; the lease draws `Math.random()`.
 */
export function leaseDelay(interval: number, which: "first" | "next", random: number): number {
  if (which === "first") return interval * LEASE_JITTER * random;
  return interval * (1 - LEASE_JITTER + 2 * LEASE_JITTER * random);
}

/** What to attach, in workspace vocabulary only (ADR-0012 boundary): the one branch the body
 * works on, the pod's work group, and the review sha. Derived PER RUN from the wrapper's input,
 * which is what keeps it out here rather than in the options — and which is exactly why the two
 * IMAGES and the REPOS are NOT here (ADR-0049, ADR-0051): `jr2 up` must find them by walking the
 * Machine, and no walk can evaluate a function of run input. They are static `workspace()`
 * options instead; a Repo that IS a function of run input is a per-run slot, a mapper the walk
 * can see the shape of even though it cannot see the url. */
export type WorkspaceSpec = {
  branch: string;
  /** The pod's work group (ADR-0005): `fsGroup`, default 2000. The two writing seats may run
   * different uids — each image's own `USER` decides — and POSIX would then make the other seat's
   * files read-only; fsGroup (group ownership) plus the default ACL the attach stamps on each
   * repo root (group writability, umask-proof) closes that, both inert when the uids already
   * match. The override exists for the image whose sessions already hold a gid of their own —
   * a root sshd's logins rebuild groups from `/etc/group`, so pointing the work group at one
   * they have costs no rebuild. Never a config key — pod composition is the spec's business. */
  workGroup?: number;
  /** Attach the detached review worktree at this sha (ADR-0028): `<branchDir>-review`, a sibling
   * of the branch worktree, forced to exactly this sha on every attach. Creation-time seat only;
   * the per-round refresh verb (the sha moves between review rounds) is a later, workflow-driven
   * change. */
  reviewSha?: string;
};

/**
 * What the workspace hands the BODY (ADR-0012, ADR-0016): worktree geography only, keyed by Repo
 * Slot (ADR-0051) — so a path a prompt names is right in every Instance that consumes the Machine.
 * `endpoint` and `sandbox` are mechanism-internal — the Agent actor resolves them ambiently from
 * the enclosing wrapper (ambient.ts), so a workflow can no longer forget to thread them (the
 * baba71f incident: `sandbox` omitted, every tool call 403'd, fail-closed but silent).
 *
 * `TSlots` has NO default on purpose (ADR-0050): a body names the slots it reads, and
 * `workspace()` holds those names to the ones the wrapper declares. A default of `string` would
 * type `repos` as `Record<string, string>`, under which a misspelled slot reads as a path — the
 * silent widening the slot key exists to refuse. `string` WRITTEN is a different statement: the
 * body names no slot at all — it enumerates them, in the order the composer wrote — which is the body
 * under a wrapper that declares its map Open (`repos: open`, ADR-0051), where the slots are the
 * composer's words and no body could name them.
 */
export type WorkspaceHandles<TSlots extends string> = {
  /** Every slot's branch-worktree path: `/work/<slot>/<branch>`, keyed in DECLARATION ORDER. The
   * kit gives no slot a privileged meaning — there is no `workdir` — because which tree an Agent
   * works in is a fact about that Agent's Turn, not about the Workspace: a body that names its
   * slots frames each Agent with its own, and a body that names none may give the order a
   * meaning of its own (`task`: the first is the one the coder edits). The order is the kit's
   * promise; the meaning is the Machine's (ADR-0051). */
  repos: Record<TSlots, string>;
  branch: string;
  /** Detached review-worktree paths by slot (ADR-0028) — present only when the spec carried
   * `reviewSha`. The reviewer's seat: hand one of these as its cwd/prompt frame. */
  review?: Partial<Record<TSlots, string>>;
};

/**
 * A body's input under a Workspace: the run input the wrapper passes through, PLUS the handles it
 * injects. The composition is the whole reason the door is declared on the wrapper and not on the
 * body (ADR-0033) — `Workspaced<RunInput, Slot>` is what the body receives, `RunInput` is what a caller
 * may send, and no caller can send `workspace` (the handles do not exist until a Sandbox is
 * provisioned and attached). Naming it here keeps the body from hand-copying
 * {@link WorkspaceHandles}, which drifts. The second argument is the body's word for each Repo
 * Slot it reads (`Workspaced<RunInput, "target">`) — required, never defaulted, so
 * `workspace.repos.<slot>` is typed by the same keys the wrapper declares (ADR-0050, ADR-0051).
 *
 * The wrapper passes its input through UNTOUCHED, so a ROOT-placed wrapper's body also receives
 * what the host injected beside the door — `HostInjectedInput` today (the run's `instanceId`).
 * That is outside this type on purpose: it depends on where the wrapper sits, and `Workspaced` is
 * the composition the WRAPPER makes.
 */
export type Workspaced<TInput, TSlots extends string> = TInput & { workspace: WorkspaceHandles<TSlots> };

/**
 * What the watch says about a workspace (ADR-0021, ADR-0063): gone, or present — and, once the
 * operator has judged its one pod gone or terminal, `lost` with the operator's reason and the pod's
 * own words. A Sandbox has one pod for its life, so a Lost Sandbox never comes back; the operator
 * judges identity because it knows which pod it created, and nothing here compares pod UIDs.
 */
export type Continuity = { present: false } | { present: true; lost?: SandboxLoss };

/** Why a Sandbox is Lost (ADR-0021): the pod's own reason (`Evicted`, `NodeShutdown`, ...) or the
 * operator's (`PodDeleted`, `NodeLost`, `PodFailed`, `PodSucceeded`), and its message. */
export type SandboxLoss = { reason: string; message: string };

/**
 * Why a Sandbox with no node waits (ADR-0064): the scheduler found no node for it, or a
 * ResourceQuota refused its pod. `message` is the scheduler's or the API server's own words, which
 * can name nodes and taints — so it rides the authenticated status and the per-run feed only.
 */
export type PlacingWait = { on: "node" | "quota"; message: string };

/** The Harness container's restarts on the Sandbox's one pod, and how it last ended — as the
 * operator publishes them (ADR-0021, ADR-0063). The signal that ends the Turns a restart took. */
export type HarnessRestarts = {
  restartCount: number;
  lastTerminated?: { reason?: string; exitCode?: number; finishedAt?: string };
};

/** What the port writes when a Workspace is placed (ADR-0012, ADR-0064). */
export type PlaceRequest = {
  name: string;
  runId: string;
  workflow: string;
  image?: string;
  user?: string;
  workGroup?: number;
  repos: ProvisionedRepo[];
  resources?: Size;
  userResources?: Size;
};

/** One Repo Slot as the port receives it at provision (ADR-0051): resolved to a Binding, and
 * flagged when the run — not the Machine — chose the url, because that is what the credentials
 * fence keys on. */
export type ProvisionedRepo = { slot: string; url: string; ref?: string; perRun: boolean };

/**
 * The Sandbox backend a host supplies (`RunHostOptions.sandbox`) — the seam between the
 * workspace Machine and the cluster. Every operation MUST be idempotent: the invoking
 * states re-run on snapshot restore (create-if-absent, attach-if-absent, delete-if-present).
 */
export interface SandboxPort {
  /**
   * Write the Sandbox (its token Secret, then the CR, labeled with its run for `jr2 ls`) and wait,
   * with NO deadline, until the operator says its pod is scheduled (ADR-0064). `image`/`user` are
   * the wrapper's static image options (ADR-0037/0005/0049) — a `file:` context or a registry ref,
   * the port resolves both, and a context the last converge did not build fails here rather than
   * converge-time. `repos` are the wrapper's slots, resolved, in declaration order (ADR-0051): the
   * port names each Repo on the CR so the cluster mounts its cache, and refuses a per-run url no
   * `git.credentials` entry admits. `workGroup` is the pod's `fsGroup`; the port owns the default.
   * `resources` is the Size the Machine states and `userResources` the User Container's split of it
   * (ADR-0060), both as stated — the port resolves the rest of the chain and splits the Size inside
   * the pod.
   *
   * While the pod has no node, `onWait` hears why, each time the reason changes. A Sandbox that is
   * Lost, or deleted, before it is placed rejects. `signal` ends the wait: the promise rejects once
   * any write in flight has settled, so a caller that deletes after it never races the apply.
   */
  place(req: PlaceRequest, opts: { onWait: (wait: PlacingWait) => void; signal?: AbortSignal }): Promise<void>;
  /**
   * Wait for the placed Sandbox's `phase: Ready` under the port's budget, which starts NOW — the
   * pod is scheduled, so it measures only what jr2 controls: the image pull, the Harness start, the
   * Repos (ADR-0064). Resolves with the Harness endpoint the orchestrator can reach. Lost, or gone,
   * rejects naming why.
   */
  provision(name: string): Promise<{ endpoint: string }>;
  /** Post-Ready attach (ADR-0004): per slot, `git clone --shared` off the node's read-only
   * cache (the `default/` checkout), then a branch worktree sibling — and, with `spec.reviewSha`, the detached
   * review worktree (ADR-0028). Resolves with the worktree paths by slot; `stale` names the slots
   * whose cache could not be fetched before this attach, with git's own error (ADR-0051: freshness
   * degrades, absence does not). */
  attach(req: {
    name: string;
    spec: WorkspaceSpec;
    repos: Array<{ slot: string; url: string; ref?: string }>;
  }): Promise<{
    repos: Record<string, string>;
    review?: Record<string, string>;
    stale?: Record<string, string>;
  }>;
  /**
   * Renew this workspace's keepalive lease — a WRITE, and only that (ADR-0021, ADR-0063). Nothing
   * in the cluster represents a run (ADR-0001), so the lease is the Orchestrator's assertion
   * that lets the operator reap an orphan and no one else. It learns nothing: Continuity is the
   * watch's. Idempotent, called on a jittered timer; a failure rejects and the caller shrugs —
   * the next renewal is minutes away and the idle timeout is thirty.
   */
  renew(name: string): Promise<void>;
  /**
   * Hear this workspace's Continuity from the watch (ADR-0021, ADR-0063): once the watch has
   * listed, what it holds now, then again on every change the cluster reports — a Sandbox gone, or
   * one the operator has made Lost. A dropped watch reports NOTHING: unknown is never loss, and the
   * listener never hears a fabricated `{present: false}`. Returns the unsubscribe.
   */
  continuity(name: string, listener: (seen: Continuity) => void): () => void;
  /**
   * Hear the Harness container's restarts on this Sandbox's pod (ADR-0021): once the watch has
   * listed, then on every change. A Turn records the count at its admission, and a count above it
   * means the conversation it waits on is gone. Silent for a name the watch does not hold — the
   * Instance Harness is a Deployment, not a Sandbox. Returns the unsubscribe.
   */
  harnessRestarts(name: string, listener: (seen: HarnessRestarts) => void): () => void;
  /**
   * Name a memory kill (ADR-0061): when the Harness container of this Sandbox last ended
   * `OOMKilled` at or after `since`, the kill — its fault reason, starting with the fixed prefix
   * `memory limit`, and the data the next Turn's notice is made of (ADR-0062) — else undefined.
   * Asked when a Turn faults on a lost conversation; it may wait a moment for the operator's word,
   * which can trail the Harness's restart. A backend that cannot see the container answers
   * undefined, and every lost conversation stays lost — never an optional method (ADR-0021).
   */
  memoryFault(name: string, since: Date): Promise<MemoryKill | undefined>;
  /** Delete the Sandbox CR. Absent is success. */
  destroy(name: string): Promise<void>;
  /** How often to renew. Must be well inside the backend's idle-timeout, since a lapsed lease is
   * what lets the operator reap. */
  readonly leaseIntervalMs?: number;
}

/** A kernel memory kill of a Sandbox's Harness container (ADR-0061, layer 5). */
export type MemoryKill = {
  /** The fault reason, starting with the fixed prefix `memory limit`. */
  reason: string;
  /** The limit the kernel enforced, as the Sandbox states it (`1920Mi`). */
  limit?: string;
  /** When the container ended — which kill this was, so every Turn it ended names the same one. */
  at?: string;
};

/** Resolve the host's Sandbox backend, failing with a pointed message on a host without one. */
export function sandboxOf(system: AnyActorSystem): SandboxPort {
  const port = runBindingOf(system).sandbox;
  if (!port) {
    throw new Error(
      "this orchestrator has no Sandbox backend — a Workspace is always a real Sandbox (ADR-0012); " +
        "this process is not deployed in a cluster (JR2_NAMESPACE unset). `jr2 up` the instance and run there.",
    );
  }
  return port;
}

/**
 * The Sandbox CR name for one workspace invocation: DNS-1123, deterministic from the run and
 * the wrapper's actor id (both stable across restore — that is what lets the lease
 * and a re-run provision find the SAME CR), collision-proofed by a content suffix.
 */
export function workspaceName(runId: string, wsId: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  let h = 0;
  for (const ch of `${runId}/${wsId}`) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const base = `ws-${slug(runId).slice(0, 8)}-${slug(wsId)}`.replace(/-+/g, "-").replace(/-+$/, "").slice(0, 55);
  return `${base}-${(h >>> 0).toString(36)}`;
}

/** The full mechanism-facing handles: what the registrar publishes for ambient resolution
 * (ambient.ts). The body sees only the {@link WorkspaceHandles} subset. */
type MechanismHandles = AmbientHandles;

/** One slot as the run resolved it (ADR-0051): the Binding, and whether the run's input chose
 * it. Persisted, so the attach after a restore reuses exactly what was provisioned — a per-run
 * mapper is not re-evaluated against an input that may since have been re-parsed. */
export type ResolvedBinding = { url: string; ref?: string; perRun: boolean };

/**
 * A Workspace's wait for capacity as its context holds it (ADR-0064): the reason as the port last
 * heard it, and when the wait began. `since` survives a changed reason and a restart — it is how
 * long the Workspace has waited, which is what the feed's closing line reports.
 */
export type WorkspaceWait = PlacingWait & { since: string };

/** The context key the wait rides under — what `RunStatus.waiting` reads off a Workspace's
 * snapshot, live or persisted. */
export const WORKSPACE_WAIT_KEY = "wait";

type WsContext = {
  /** The wrapper's own input, passed through to the body untouched (plus `workspace`). */
  runInput: Record<string, unknown>;
  /** This invocation's stable identity (the actor id the parent invoked/spawned us under). */
  wsId: string;
  /** The resolved spec — computed once from input and persisted, like any other context data. */
  spec: WorkspaceSpec;
  /** Every slot's resolved Binding, by slot, in declaration order — assigned at provision. */
  bindings?: Record<string, ResolvedBinding>;
  endpoint?: string;
  /** Why the Sandbox waits for a node, while `placing` (ADR-0064) — persisted, so a restart keeps
   * when the wait began and `RunStatus.waiting` reads it off the snapshot. Cleared once placed. */
  wait?: WorkspaceWait;
  /** Persisted in context so the registrar can re-publish them on restore. */
  handles?: MechanismHandles;
  output?: unknown;
};

/**
 * What `workspace()` returns: a Machine erased to the parameters that carry meaning across the
 * seam — the door a run of it starts with, the body's output, which the wrapper forwards verbatim
 * (ADR-0012), and the wrapper's own actor slots. Everything else is the wrapper's own business,
 * so it stays `any`: a generic `setup()` over the body does not infer (report-xstate.md §3),
 * which is why the implementation is loosely typed and only the public signature is precise.
 *
 * The slots are stated because the wrapper is TRANSPARENT to its body (ADR-0049): `body` holding
 * the body's own type is what lets `customize(machine, { agents })` offer the BODY's Agents
 * through the wrapper, without the composer ever spelling `body`. {@link JR2Wrapper} is what SAYS
 * it is a wrapper — the type twin of the `attachWrapperBody` stamp `workspace()` writes below — so
 * `customize()` reaches the body because this Machine IS one, never because a slot is spelled
 * `body`: that name is an author's to choose too (parts.ts).
 *
 * No parameter defaults (ADR-0050, as {@link Workspaced}): an annotation names the body and the
 * Repo Slots it carries, because a default would widen exactly where the phantom exists to refuse
 * — `JR2Repos<string>` offers `customize()` every key, and `AnyStateMachine` as the body offers no
 * Agent at all. `PoolMachine` names its worker the same way.
 */
export type WorkspaceMachine<TInput, TOutput, TBody extends AnyStateMachine, TSlots extends string> = StateMachine<
  any,
  any,
  any,
  WrapperActors<"body", TBody, "place" | "provision" | "attach" | "registrar" | "lease" | "destroy">,
  any,
  any,
  any,
  any,
  any,
  TInput,
  TOutput,
  any,
  any,
  any
> &
  JR2Wrapper<TBody> &
  JR2Repos<TSlots>;

/**
 * The door CONSTRAINS the body (ADR-0033), in one direction only: the body may not demand more
 * than the wrapper will hand it, which is the door plus the injected handles ({@link Workspaced}).
 * A body that demands LESS is safe — it is fed a superset — so this is an assignability test, not
 * an equality one.
 *
 * {@link HostInjectedInput} is added to the PROVIDED side, not subtracted from the demanded one.
 * `RunHost.start` hands the ROOT machine `{ ...runInput, instanceId }` and the wrapper passes its
 * input through untouched, so a root-placed wrapper feeds its body that field too — while a nested
 * one does not, and no type can see which. Of the two answers a type can give, this takes the
 * permissive one: holding the body to the door alone rejects one that declares the field honestly
 * (`features/kind-instance/workflows/*.ts` do) with a diagnostic telling the author to widen the
 * door — the wrong fix, since the field is host-supplied, never sent, and never served as JSON
 * Schema (ADR-0033).
 *
 * Widening the provided side is what keeps the carve-out from becoming a hole. SUBTRACTING the
 * keys instead (`Omit<InputFrom<TBody>, keyof HostInjectedInput>`) drops them from the comparison
 * entirely, which loses two cases claim 1 owns: a body declaring `instanceId: number` passes,
 * because the key it got wrong is the key that was removed; and a body whose input is a UNION is
 * checked against the union's SHARED keys only, so every member could demand a field the door
 * never carries and still compile. Stated on the provided side, both are rejected, and the admit
 * set is otherwise identical.
 *
 * The failure is spelled as an object type whose single key is the sentence to read: TypeScript
 * prints the key of the property it could not satisfy, so the diagnostic on a rejected body names
 * the fix instead of a structural diff. Pinning the body's TInput slot instead would NOT work —
 * `StateMachine`'s members include methods, and method parameters are bivariant, so a body
 * demanding MORE than the door provides compiles. Both directions are pinned by
 * `test/door-types.test.ts`, which the typecheck gate runs.
 */
// The handles are keyed by the wrapper's DECLARED slots (ADR-0051), so a body demanding a slot the
// wrapper never declared is refused here too; demanding fewer is fine, as with any other field.
type BodyAcceptsDoor<TBody extends AnyStateMachine, TDoor, TSlots extends string> =
  Workspaced<TDoor, TSlots> & HostInjectedInput extends InputFrom<TBody>
    ? BodyNamesNoSlotUnderOpenMap<TBody, TSlots>
    : { "the body's declared input must accept the door plus the injected handles": Workspaced<TDoor, TSlots> };

/**
 * The one case assignability cannot see (ADR-0051): a wrapper that declares its map Open
 * (`repos: open`) hands the body `Record<string, string>`, and TypeScript relates that to a body's
 * `Record<"target", string>` — an index signature satisfies a mapped type's named keys — so the
 * check above would pass a body that names a slot the composer may never write. Under an Open
 * map the body must name NO slot: its handles' keys are `string`, which is how a body says "I
 * enumerate whatever is attached". A body that names one is refused here,
 * where the wrapper is written.
 */
type BodyNamesNoSlotUnderOpenMap<TBody extends AnyStateMachine, TSlots extends string> = string extends TSlots
  ? InputFrom<TBody> extends { workspace: { repos: infer THandles } }
    ? string extends keyof THandles
      ? unknown
      : {
          "a body under an Open slot map (repos: open) names no slot — its handles are Workspaced<…, string>": keyof THandles;
        }
    : unknown
  : unknown;

/**
 * The handles half of {@link BodyAcceptsDoor} alone, for the wrapper with NO declared door. The
 * door is unchecked there because it is unknown (ADR-0033) — but the Repo Slots are declared on
 * this path exactly as on the other, so a body naming a slot the wrapper never declared is refused
 * here too (ADR-0051): it would read `workspace.repos.<slot>`, a path that never exists. The test
 * is the same one-direction assignability, on the `workspace` field alone: the handles the wrapper
 * will inject must satisfy what the body declares for them, so a body that names fewer slots, or
 * no handles at all, is fed a superset and passes, as ever.
 */
type BodyAcceptsSlots<TBody extends AnyStateMachine, TSlots extends string> =
  InputFrom<TBody> extends { workspace: infer THandles }
    ? WorkspaceHandles<TSlots> extends THandles
      ? BodyNamesNoSlotUnderOpenMap<TBody, TSlots>
      : { "the body's declared handles must accept the Repo Slots the wrapper declares": WorkspaceHandles<TSlots> }
    : unknown;

/**
 * What the Sandbox is MADE OF (ADR-0037, ADR-0005) and which Repos it attaches (ADR-0051), as
 * STATIC options on the wrapper rather than fields of the per-run spec (ADR-0049). Static is the
 * whole point: `jr2 up` walks the registered Machines to find every `file:` context and build it,
 * every bound Repo and warm it, every open slot and refuse it (parts.ts) — and a spec is a function
 * of run input that no walk can evaluate. They are also never persisted — the provisioning state
 * re-reads them off the Machine it was invoked as, so a restore, a `provide()` and a `customize()`
 * all get the image and the slots the Machine carries NOW.
 *
 * Each image is one string in ADR-0037's two shapes: a `file:` URL to a docker context the
 * Machine's module ships (`import.meta.resolve("./image")`), or a registry ref its owner baked and
 * hosts.
 *
 * `TSlots` has no default, here and on the two option types below (ADR-0050): a value annotated
 * with a `string` slot set types `repos` as `Record<string, RepoSlot>`, under which a body naming
 * any slot passes the wrapper's check — the widening {@link WorkspaceHandles} refuses for the
 * same reason. The `workspace()` overloads infer it; an annotation names it.
 */
export type SandboxOptions<TSlots extends string, TInput = unknown> = {
  /** The Sandbox Image. Absent → the Instance's `images/default`, then the stock Harness. */
  image?: string;
  /** The User Container (ADR-0005): its image, or `{ image, resources }` when the Machine states
   * the seat's split of the Size (ADR-0060) — the widening ADR-0005 foresaw. Absent → the pod has
   * no third container: there is no default, because the seat's whole identity is "what jr2 does
   * not own" and jr2 has nothing to put there. Env and ports are deliberately not forwarded. With
   * no split stated, the seat has no limit of its own and shares the pod's budget. */
  user?: string | UserContainer;
  /**
   * The Size (ADR-0060): the ceiling for the whole Sandbox, `limits.memory` and `limits.cpu` and
   * nothing else — Agent Substrate's template size, so the Workspace moves there unchanged. A fact
   * of the Machine, like its image: the author knows the toolchain, the runner, the worker count.
   * jr2 reserves all of it (every request equals its limit) and enforces the CPU limit. Absent, or
   * a field left out → the Instance's `sandbox.resources`, then the kit default (2Gi, 1 cpu). A
   * composer retunes it with `customize(machine, { resources })`.
   */
  resources?: Size;
  /**
   * The Repo Slots (ADR-0051), keyed by the Machine's own word for each — the key of the body's
   * `workspace.repos` handles and the directory under `/work`. The handles keep this map's order,
   * and the kit reads nothing into it. Required, at least one: a Workspace exists to work on a repository. Each slot is bound (a url,
   * or `{ url, ref? }` — the package's own), open (`open` — the consumer binds it with
   * `customize`), or per-run (a mapper over the door: `({ input }) => input.repo`).
   *
   * Or the whole map Open (`repos: open`): the Machine names no slot, the composer names every
   * one with `customize`, in an order the Machine may give a meaning to. The shape a packaged
   * Machine takes when its body enumerates its checkouts rather than naming them (`@jr2/machines`'s
   * `task`, whose first slot is the one the coder edits). Under it `TSlots` is `string`, and the body's handles must say so.
   */
  repos: Record<TSlots, RepoSlot<TInput>> | typeof open;
};

/**
 * How a Workspace with a declared door is configured (ADR-0012, ADR-0033) — the wrapper's own
 * run-input schema, what the pod is made of, and the mapping from what comes through the door to
 * workspace vocabulary.
 */
export type WorkspaceOptions<TSchema extends z.ZodObject, TSlots extends string> = SandboxOptions<
  TSlots,
  z.infer<TSchema>
> & {
  /** The wrapper's OWN declared run input (ADR-0033) — what a caller sends to start a run of it,
   * what types `spec`'s `input`, and what the body is checked against. Deliberately NOT the body's
   * schema: the body is fed the run input PLUS the injected `workspace` handles
   * ({@link Workspaced}), which no caller can send, so the body's contract is the door plus
   * something that does not exist yet. Symmetric with `PoolSpec.input`. */
  input: TSchema;
  /** Map what came through the door to the workspace-domain spec: what to attach, on what ref,
   * on which branch (ADR-0012's boundary — workflow configuration never enters it). */
  spec: (args: { input: z.infer<TSchema> }) => WorkspaceSpec;
};

/**
 * How a Workspace with NO declared door is configured: absence is permissive (ADR-0033), so jr2
 * has nothing to infer from and says `unknown` rather than `any` — an honest "jr2 does not know",
 * which the mapper must narrow before it reads a field. A wrapper that is fed by something other
 * than a caller — a pool worker, a nested invoke — may state what it is fed by annotating the
 * parameter (`spec: ({ input }: { input: Item }) => …`), which types the wrapper's input too. For
 * anything a caller starts, the honest fix is to declare `input`.
 */
export type PermissiveWorkspaceOptions<TSlots extends string, TInput = unknown> = SandboxOptions<TSlots, TInput> & {
  /** Never present on this path. Spelled out so a declared schema can never fall through to the
   * permissive overload, where the body's door would go unchecked. */
  input?: never;
  spec: (args: { input: TInput }) => WorkspaceSpec;
};

/**
 * Wrap a body Machine in Sandbox lifecycle (ADR-0012). `spec` maps the wrapper's input to the
 * workspace-domain spec; the body receives the wrapper's input plus `workspace` (the handles) —
 * `Workspaced<TInput, TSlots>`, which is also what the declared door checks the body against. The
 * wrapper's output is the body's output. A body ERROR is deliberately unhandled: it faults the run
 * loudly (RunStatus.fault) and leaves the Sandbox to the operator's idle-timeout GC — the trail
 * stays inspectable, and silent cleanup would destroy the evidence.
 */
export function workspace<TSchema extends z.ZodObject, TBody extends AnyStateMachine, TSlots extends string>(
  body: TBody & BodyAcceptsDoor<TBody, z.infer<TSchema>, TSlots>,
  options: WorkspaceOptions<TSchema, TSlots>,
): WorkspaceMachine<z.infer<TSchema>, OutputFrom<TBody>, TBody, TSlots>;
export function workspace<TBody extends AnyStateMachine, TSlots extends string, TInput = unknown>(
  body: TBody & BodyAcceptsSlots<TBody, TSlots>,
  options: PermissiveWorkspaceOptions<TSlots, TInput>,
): WorkspaceMachine<TInput, OutputFrom<TBody>, TBody, TSlots>;
export function workspace(
  body: AnyStateMachine,
  options: SandboxOptions<string, any> & { input?: z.ZodObject; spec: (args: { input: any }) => WorkspaceSpec },
): AnyStateMachine {
  // A body that still declares its own run input is a dead declaration under the door design: the
  // wrapper never serves it, never validates against it, and feeds the body something it does not
  // describe. Silence would leave an author believing a contract that nothing enforces (ADR-0033).
  if (inputSchemaOf(body)) {
    throw new Error(
      `workspace(): the body "${body.id}" declares its own run input, which nothing will ever ` +
        "serve or enforce — the wrapper feeds the body the run input PLUS the injected `workspace` " +
        "handles, so the body's schema is not the door. Move it to the wrapper: " +
        "workspace(body, { input, spec }) (ADR-0033).",
    );
  }
  // Static, so checkable NOW rather than at the first provision — an empty or non-string image is
  // the same derives-from-a-typo bug `assertSpec` catches for the spec, one build earlier.
  const image = options.image;
  if (image !== undefined && (typeof image !== "string" || !image)) {
    throw new Error(
      `workspace(): \`image\` must be a non-empty string (got ${JSON.stringify(image)}) — either a \`file:\` ` +
        'URL to a docker context this module ships (`import.meta.resolve("./image")`) or a registry ref ' +
        "(ADR-0037).",
    );
  }
  if (options.user !== undefined) assertUserSeat("workspace()", options.user);
  // The Size, refused by field where it is written (ADR-0060): only the two limits. A request, or
  // any key Substrate would refuse, is a dependency the move to it would drop.
  if (options.resources !== undefined) assertSize("workspace(): resources", options.resources);
  // The slots, checked NOW for the same reason (ADR-0051): every value is one of the three forms,
  // every key is a directory name, and there is at least one — a Workspace exists to work on a
  // repository, and a wrapper with no slot would attach nothing and hand the body no checkout.
  // An Open map defers all of that to the `customize` that fills it, which runs the same checks.
  const repos = options.repos;
  if (repos !== open) {
    if (typeof repos !== "object" || repos === null || Array.isArray(repos) || Object.keys(repos).length === 0) {
      throw new Error(
        'workspace(): `repos` must name at least one Repo Slot — `repos: { app: "https://…" }`, or ' +
          "`open` for a slot the consumer binds, or a mapper over the door for one the run chooses — or be " +
          "`open` whole, for a map the consumer names (ADR-0051).",
      );
    }
    for (const [slot, value] of Object.entries(repos)) assertRepoSlot("workspace()", slot, value);
  }
  const wrapper = buildWorkspaceMachine(body, options.spec);
  // The wrapper is TRANSPARENT to its body (ADR-0049): `customize(machine, { agents })` on a
  // Workspace means the Machine inside, so the composer never spells `body` and never has to know
  // that jr2 wrapped anything.
  attachWrapperBody(wrapper, "body");
  // What the pod is MADE of and which Repos it attaches ride the Machine (ADR-0049, ADR-0051),
  // keyed on `machine.config` like the vocabulary — so a `provide()` clone keeps them, and the
  // provisioning state reads them back off the Machine it was invoked as instead of closing over
  // these values. That is also what lets `jr2 up` find every `file:` context, every bound Repo and
  // every open slot by walking the registered Machines (parts.ts).
  attachSandboxParts(wrapper, {
    ...(options.image !== undefined ? { image: options.image } : {}),
    ...(options.user !== undefined ? { user: options.user } : {}),
    repos: repos === open ? open : { ...repos },
    ...(options.resources !== undefined ? { resources: options.resources } : {}),
  });
  // The body's vocabulary stays the BODY's (ADR-0011, ADR-0049): the wrapper declares no events
  // of its own and merges none, because the actors that use the body's names resolve against the
  // Machine that invoked them — the body — at any nesting depth. Propagating them up was what
  // made a nested Machine's events its parent's problem to re-declare.
  //
  // The door does NOT propagate from the body either (ADR-0033): the wrapper hands the body the run
  // input plus the injected `workspace` field, so the body's declared input would be the door
  // plus a field no caller can send — declaring it there 400s every valid start. The wrapper
  // declares its own, exactly as a pool does.
  if (options.input) attachInputSchema(wrapper, options.input);
  return wrapper;
}

/**
 * Fail a malformed spec BEFORE any pod exists. The spec derives from run input via the workflow's
 * mapping fn, so a `jr2 run --input` missing a field the mapping reads arrives here as `undefined` —
 * unchecked, it survives until the attach script's string ops and dies as "Cannot read properties
 * of undefined", with a Sandbox already provisioned and nothing pointing back at the input.
 */
function assertSpec(spec: WorkspaceSpec): void {
  const bad: string[] = [];
  if (typeof spec?.branch !== "string" || !spec.branch) bad.push(`branch (got ${JSON.stringify(spec?.branch)})`);
  // The branch Worktree is a SIBLING of the pod-local clone at `<slot>/default/` (ADR-0004), so
  // the one branch name that is not a worktree directory is `default`.
  else if (spec.branch === "default")
    bad.push(
      'branch "default" (the pod-local clone\'s own directory — a branch Worktree sits beside `default/`, ADR-0004)',
    );
  if (spec?.reviewSha !== undefined && (typeof spec.reviewSha !== "string" || !spec.reviewSha))
    bad.push(`reviewSha (got ${JSON.stringify(spec?.reviewSha)})`);
  // A gid, so an integer — a float or a negative becomes a pod the API server rejects at
  // admission, which surfaces as "never reached Ready" with nothing pointing back at the spec.
  if (
    spec?.workGroup !== undefined &&
    (typeof spec.workGroup !== "number" || !Number.isInteger(spec.workGroup) || spec.workGroup < 0)
  )
    bad.push(`workGroup (got ${JSON.stringify(spec?.workGroup)}; want a gid)`);
  if (bad.length) {
    throw new Error(
      `workspace spec invalid: ${bad.join("; ")} — the spec derives from run input; does ` +
        "`jr2 run --input` carry every field this workflow's workspace() mapping reads?",
    );
  }
}

/**
 * Resolve every Repo Slot to a Binding, in declaration order (ADR-0051). A bound slot is its
 * Binding; a per-run slot is its mapper called over the run input, validated like the static forms
 * because it derives from `jr2 run --input` exactly as the spec does; an open slot nobody bound is
 * a fault BEFORE the port, naming the `customize` line that fixes it — the run-time twin of the
 * refusal `jr2 up`'s walk makes for a registered Machine, reached here only by a Machine that was
 * never registered as itself (a test seam, a nested invoke of an unbound import). The Machine is
 * named as the walk names it: the Workflow it runs under, and the slot chain (`path`) from that
 * root to this wrapper — which is the `actors` nesting of the line, so it pastes.
 */
function resolveBindings(
  where: { workflow: string; path: string[] | undefined },
  slots: SandboxParts["repos"],
  runInput: unknown,
): Record<string, ResolvedBinding> {
  const unbound = (slot: string | undefined): Error => {
    const fix =
      where.path === undefined
        ? "no customize() reaches a Machine invoked inline; declare it under setup({ actors }) and bind the slots there"
        : `bind them where the Machine is registered: export const machine = ${customizeLine("<import>", where.path, slot)}`;
    const what =
      slot === undefined ? "Repo Slots are open — nobody named any" : `Repo Slot "${slot}" is open — nobody bound it`;
    return new Error(`workflow "${where.workflow}": ${what}; ${fix} (ADR-0051)`);
  };
  if (slots === open) throw unbound(undefined);
  const bindings: Record<string, ResolvedBinding> = {};
  for (const [slot, value] of Object.entries(slots)) {
    const state = repoSlotState(value);
    if (state.kind === "open") throw unbound(slot);
    if (state.kind === "bound") {
      bindings[slot] = { ...state.binding, perRun: false };
      continue;
    }
    const mapped = state.mapper({ input: runInput });
    const binding: Binding | undefined =
      typeof mapped === "string" ? { url: mapped } : typeof mapped === "object" && mapped !== null ? mapped : undefined;
    const bad: string[] = [];
    if (typeof binding?.url !== "string" || !binding.url)
      bad.push(`url (got ${JSON.stringify(binding === undefined ? mapped : binding.url)})`);
    if (binding?.ref !== undefined && (typeof binding.ref !== "string" || !binding.ref))
      bad.push(`ref (got ${JSON.stringify(binding.ref)})`);
    if (bad.length) {
      throw new Error(
        `workspace spec invalid: repos.${slot} mapper returned ${bad.join("; ")} — the mapper derives from run ` +
          "input; does `jr2 run --input` carry every field this workflow's workspace() slot reads?",
      );
    }
    bindings[slot] = { ...binding!, perRun: true };
  }
  return bindings;
}

/** The port-facing view of the persisted bindings, in declaration order. */
function attachedRepos(bindings: Record<string, ResolvedBinding>): Array<{ slot: string; url: string; ref?: string }> {
  return Object.entries(bindings).map(([slot, b]) => ({
    slot,
    url: b.url,
    ...(b.ref !== undefined ? { ref: b.ref } : {}),
  }));
}

function buildWorkspaceMachine(body: AnyStateMachine, spec: (args: { input: any }) => WorkspaceSpec): AnyStateMachine {
  /**
   * `placing` (ADR-0064): write the Sandbox and wait, with no deadline, for its pod to be
   * scheduled. jr2 cannot tell "full now" from "never fits", so a bound is the Machine's own
   * `after` on the state that holds the Workspace.
   *
   * The wait is said, never sent to the body: each reason the port hears is assigned into this
   * wrapper's context (`workspace.waiting`, where `RunStatus.waiting` reads it), and the feed gets
   * two lines — the wait starting, with its reason, and the wait ending ("placed after …"). A
   * changed reason updates the context and adds no line. A restart re-enters here: the apply is
   * idempotent, the watch's first list answers at once, and `since` is read back off the
   * wrapper's context, so neither line is said twice.
   *
   * Delete what never ran: stopped before its pod has a node — a parent `after`, a cancelled run, a
   * run faulted elsewhere — this Sandbox is deleted at once, because nothing on it can be inspected
   * and left alone it could take a node later for nobody. xstate's stop is synchronous, so the
   * delete rides the abort, after any write in flight has settled. A wait that fails on its own —
   * the Sandbox Lost before its node, a write that half landed — is the same end: the delete comes
   * before the fault, and the fault carries the reason. The host stopping the run for a restart is
   * not an end: the restored run re-enters `placing` and keeps its place.
   */
  const place = fromPromise<
    { bindings: Record<string, ResolvedBinding> },
    { wsId: string; spec: WorkspaceSpec; runInput: unknown }
  >(async ({ input, self, system, signal }) => {
    assertSpec(input.spec); // before the port: a bad spec must never cost a pod
    const binding = runBindingOf(system);
    // The images and the slots come off the WRAPPER, at invoke time, not out of context and not
    // out of a build-time closure (ADR-0049, ADR-0051). This state re-runs on every restore, so
    // the re-read is the whole mechanism: a redeployed instance provisions what the Machine
    // carries NOW, and no snapshot ever holds an image name — let alone a resolved
    // content-addressed tag, which would outlive the image it names. The RESOLVED bindings are
    // persisted, because a per-run mapper's answer is this run's fact.
    const parts = sandboxPartsOf(invokingMachine(self));
    const user = userSeatOf(parts.user);
    const bindings = resolveBindings(
      { workflow: binding.workflow, path: actorSlotPath(self._parent) },
      parts.repos,
      input.runInput,
    );
    const port = sandboxOf(system);
    const name = workspaceName(binding.runId, input.wsId);
    const wrapper = self._parent;
    const child = wrapper ? actorPath(wrapper).join("/") : "";
    // A wait opened before a restart is the same wait: its start is in the wrapper's persisted
    // context, never in this actor's input, which a restore replays as it was first invoked.
    const opened = (): string | undefined =>
      ((wrapper?.getSnapshot() as { context?: WsContext } | undefined)?.context?.wait as WorkspaceWait | undefined)
        ?.since;
    let since: string | undefined;
    let heard: PlacingWait | undefined;
    const onWait = (wait: PlacingWait) => {
      if (signal.aborted || (heard?.on === wait.on && heard.message === wait.message)) return;
      heard = wait;
      since ??= opened();
      if (since === undefined) {
        since = new Date().toISOString();
        binding.marker?.({ kind: "placing", child, on: wait.on, message: wait.message, since });
      }
      wrapper?.send({ type: "workspace.waiting", wait: { ...wait, since } });
    };
    const placed = port.place(
      {
        name,
        runId: binding.runId,
        workflow: binding.workflow,
        // The image strings straight through (ADR-0037/0005) — the port owns resolution, and the
        // work group's default (ADR-0005 puts it in pod composition, where the pod is built).
        ...(parts.image !== undefined ? { image: parts.image } : {}),
        ...(user.image !== undefined ? { user: user.image } : {}),
        ...(input.spec.workGroup !== undefined ? { workGroup: input.spec.workGroup } : {}),
        repos: Object.entries(bindings).map(([slot, b]) => ({ slot, ...b })),
        // The Size as the Machine states it, re-read here like the images (ADR-0060): a redeploy
        // that retuned it reaches the next provision, and no snapshot holds it.
        ...(parts.resources !== undefined ? { resources: parts.resources } : {}),
        ...(user.resources !== undefined ? { userResources: user.resources } : {}),
      },
      { onWait, signal },
    );
    signal.addEventListener(
      "abort",
      () => {
        if (binding.hostStopping) return;
        void placed
          .catch(() => {})
          .then(() => port.destroy(name))
          .catch(() => {}); // a delete that fails leaves the CR to the idle GC, as ever
      },
      { once: true },
    );
    try {
      await placed;
    } catch (err) {
      // An abort is the listener's to delete; a failure of the wait itself is deleted here.
      if (!signal.aborted && !binding.hostStopping) await port.destroy(name).catch(() => {});
      throw err;
    }
    since ??= opened();
    if (since !== undefined) {
      binding.marker?.({ kind: "placed", child, since, after: Date.now() - Date.parse(since) });
    }
    return { bindings };
  });

  /** `provisioning`: the placed pod's Ready, under the port's budget, which starts here (ADR-0064). */
  const provision = fromPromise<{ endpoint: string }, { wsId: string }>(async ({ input, system }) =>
    sandboxOf(system).provision(workspaceName(runBindingOf(system).runId, input.wsId)),
  );

  const attach = fromPromise<
    { repos: Record<string, string>; review?: Record<string, string>; stale?: Record<string, string> },
    { wsId: string; spec: WorkspaceSpec; bindings: Record<string, ResolvedBinding> }
  >(async ({ input, system, signal }) => {
    const port = sandboxOf(system);
    const name = workspaceName(runBindingOf(system).runId, input.wsId);
    // The attach is loss-aware (ADR-0021): a Sandbox gone or Lost under it fails the attach at
    // once and by name, as it fails the placing and the provisioning — never a transport error
    // one attach window later. Only the cluster's word: a dropped watch says nothing.
    let unsubscribe = (): void => {};
    const loss = new Promise<never>((_, reject) => {
      unsubscribe = port.continuity(name, (seen) => {
        const lost = !seen.present ? GONE : seen.lost;
        if (lost === undefined) return;
        const what = seen.present ? "is Lost" : "is gone";
        reject(new Error(`Sandbox "${name}" ${what} while it attached: ${lost.reason}: ${lost.message} (ADR-0021)`));
      });
    });
    loss.catch(() => {});
    signal.addEventListener("abort", () => unsubscribe(), { once: true });
    let out: Awaited<ReturnType<typeof port.attach>>;
    try {
      out = await Promise.race([port.attach({ name, spec: input.spec, repos: attachedRepos(input.bindings) }), loss]);
    } finally {
      unsubscribe();
    }
    // Announced, never persisted (ADR-0051): a stale cache is a degraded attach the run proceeds
    // through on the objects the node holds. The pod cannot heal it — the worktree's `origin`
    // fetches from the cache, not the remote (ADR-0005: the pod holds no credential) — so stale
    // lasts until the cache agent's next successful fetch lands in place, which the Agent's own
    // `git fetch` then picks up. It is a notice, not a fact of the run.
    for (const [slot, error] of Object.entries(out.stale ?? {})) {
      console.error(`workspace ${name}: Repo Slot "${slot}" attached from a stale cache — ${error}`);
    }
    return out;
  });

  // The ambient registrar (ADR-0016): publishes this wrapper's handles for the parent-chain
  // walk the Agent actor does. An INVOKED actor, co-invoked in `running` beside the body — invoked
  // actors restart on snapshot restore (entry actions do not), so the publication is
  // restore-safe by construction; and it is listed FIRST, so the handles are readable before
  // the body's first Agent turn starts.
  //
  // The run-narrative echo (ADR-0023) rides the same seat: attaching here IS "at workspace
  // attach" — the host replays the run's feed-so-far to this Workspace's Harness (the log opens
  // with its preamble) and tees live thereafter — and the invoked-actor lifetime makes the tee
  // restore-safe and self-detaching for free. Per-run binding, so the tee carries the OWNING
  // run's lineage only, never a sibling run's.
  const registrar = fromCallback<{ type: string }, { handles: MechanismHandles }>(({ input, self, system }) => {
    const wrapperRef = self._parent;
    if (!wrapperRef) return;
    const disposeHandles = registerAmbientHandles(wrapperRef, input.handles);
    const detachEcho = runBindingOf(system as AnyActorSystem).echo?.(input.handles.endpoint, input.handles.sandbox);
    return () => {
      detachEcho?.();
      disposeHandles();
    };
  });

  /**
   * The lease (ADR-0021). One actor owns both halves of the exchange with the cluster for one
   * workspace: it ASSERTS liveness with a write (nothing in the cluster represents a run, so the
   * Orchestrator must keep saying "still mine" or the operator's idle GC reaps — ADR-0001), and it
   * LISTENS to the watch for whether what the body attached to is still there (ADR-0063).
   *
   * Being an INVOKED actor is the whole design. It is invoked beside the work of every state from
   * `placing` to `running`, so the renewal covers the Sandbox from its write to its teardown — a
   * Sandbox that waits for capacity is never reaped as abandoned (ADR-0064) — and there is one at
   * a time, because a state's invocations stop when it exits. It re-invokes on snapshot restore (so
   * a restart reconciles for free: the watch's first list is the first thing it hears), and it
   * stops on every exit — body final, run stopped, run faulted. That last one is why there is no
   * `release()`: a faulted run stops its actors, the lease stops with them, and the abandoned pod
   * ages out of the idle timeout on its own.
   *
   * Continuity is JUDGED only in `running`, once there is an attached pod: before that, a Sandbox
   * that is Lost or gone fails the placing, the provisioning or the attach, by name, on its own. The two halves
   * share no call: loss arrives within seconds of the cluster saying so; the renewal is a merge
   * patch every interval ±20%, whose only job is to keep the Sandbox from being reaped.
   */
  const lease = fromCallback<{ type: string }, { wsId: string; judging: boolean }>(
    ({ input, self, system, sendBack }) => {
      const port = sandboxOf(system);
      const name = workspaceName(runBindingOf(system).runId, input.wsId);
      let stopped = false;
      let lost = false;

      const unsubscribe = input.judging
        ? port.continuity(name, (seen) => {
            if (stopped || lost) return;
            // Two ways to lose a workspace, one event. Gone: reaped, deleted, namespace cleared. Lost:
            // the CR survived but its one pod did not — evicted, its node lost or shut down — so
            // every name still resolves over an empty `work` volume, and the operator never gives it
            // a second pod. Re-provisioning either silently would resume into an inconsistent world
            // — the body decides (ADR-0012).
            const loss: SandboxLoss | undefined = !seen.present ? GONE : seen.lost;
            if (loss !== undefined) {
              lost = true; // once: the body has been told, and the workspace does not come back
              sendBack({ type: "workspace.lost", reason: loss.reason, message: loss.message });
            }
          })
        : () => {};

      // The assertion, jittered from the first renewal on (see `leaseDelay`).
      const interval = port.leaseIntervalMs ?? DEFAULT_LEASE_INTERVAL_MS;
      let timer: ReturnType<typeof setTimeout>;
      const schedule = (ms: number) => {
        timer = setTimeout(() => {
          // A Workspace that ended in error stopped processing without stopping its children (xstate
          // does not), and a parent that handled the error only stops what still processes: the
          // lease asks, and asserts nothing for a Workspace that is over.
          if (stopped || self._parent?.getSnapshot().status !== "active") return;
          // A failed renewal is unknown, never lost: the next one is an interval away, well inside
          // the idle timeout, and loss is the watch's to report. Before the CR's write lands it is a
          // 404, and the same shrug.
          port.renew(name).catch(() => {});
          schedule(leaseDelay(interval, "next", Math.random()));
        }, ms);
        timer.unref?.(); // a lease never holds the process open; it matters only while the run runs
      };
      schedule(leaseDelay(interval, "first", Math.random()));
      return () => {
        stopped = true;
        clearTimeout(timer);
        unsubscribe();
      };
    },
  );

  const destroy = fromPromise<void, { wsId: string }>(async ({ input, system }) =>
    sandboxOf(system).destroy(workspaceName(runBindingOf(system).runId, input.wsId)),
  );

  /** The lease beside a state's own work — renewing everywhere, judging in `running` alone. */
  const leaseInvoke = (judging: boolean) => ({
    id: "lease",
    src: "lease" as const,
    input: ({ context }: { context: unknown }) => ({ wsId: (context as WsContext).wsId, judging }),
  });

  // Every actor this wrapper runs is a NAMED SLOT (ADR-0049), the body first among them: a Machine
  // composes by invoking a declared `src`, and `body` is what `provide()`, `customize()`, Stately,
  // the Console's join key and the `jr2 up` parts walk all reach it by. The mechanism's own six —
  // place, provision, attach, registrar, lease, destroy — are named for the same price, and the
  // Console shows what each state is doing instead of "inline".
  return setup({
    actors: { body, place, provision, attach, registrar, lease, destroy },
  }).createMachine({
    id: "workspace",
    context: ({ input, self }: { input: unknown; self: { id: string } }): WsContext => ({
      runInput: (input ?? {}) as Record<string, unknown>,
      wsId: self.id,
      spec: spec({ input }),
    }),
    initial: "placing",
    states: {
      placing: {
        invoke: [
          {
            id: "place",
            src: "place",
            input: ({ context }) => ({
              wsId: (context as unknown as WsContext).wsId,
              spec: (context as unknown as WsContext).spec,
              runInput: (context as unknown as WsContext).runInput,
            }),
            onDone: {
              target: "provisioning",
              actions: assign({
                bindings: ({ event }) =>
                  (event as unknown as { output: { bindings: Record<string, ResolvedBinding> } }).output.bindings,
                wait: undefined,
              }),
            },
          },
          leaseInvoke(false),
        ],
        // The wait's reason, into context and nowhere else: scheduling detail is not the body's
        // concern (ADR-0064), and a bound is the parent's `after`.
        on: {
          "workspace.waiting": {
            actions: assign({ wait: ({ event }) => (event as unknown as { wait: WorkspaceWait }).wait }),
          },
        },
      },
      provisioning: {
        invoke: [
          {
            id: "provision",
            src: "provision",
            input: ({ context }) => ({ wsId: (context as unknown as WsContext).wsId }),
            onDone: {
              target: "attaching",
              actions: assign({
                endpoint: ({ event }) => (event as unknown as { output: { endpoint: string } }).output.endpoint,
              }),
            },
          },
          leaseInvoke(false),
        ],
      },
      attaching: {
        invoke: [
          {
            id: "attach",
            src: "attach",
            input: ({ context }) => ({
              wsId: (context as unknown as WsContext).wsId,
              spec: (context as unknown as WsContext).spec,
              bindings: (context as unknown as WsContext).bindings!,
            }),
            onDone: {
              target: "running",
              actions: assign({
                handles: ({ context, event, system }): MechanismHandles => {
                  const ctx = context as WsContext;
                  const out = (
                    event as unknown as {
                      output: { repos: Record<string, string>; review?: Record<string, string> };
                    }
                  ).output;
                  return {
                    endpoint: ctx.endpoint!,
                    // Derived, not remembered: the same function every port operation names the CR
                    // with, so the Sandbox the registrar publishes — and the Agent actor records on its
                    // registration — is the one the Custodian's token is scoped to, by construction
                    // (ADR-0013).
                    sandbox: workspaceName(runBindingOf(system as AnyActorSystem).runId, ctx.wsId),
                    repos: out.repos,
                    branch: ctx.spec.branch,
                    ...(out.review ? { review: out.review } : {}),
                  };
                },
              }),
            },
          },
          leaseInvoke(false),
        ],
      },
      running: {
        invoke: [
          // Registrar FIRST: the ambient handles must be readable before the body starts.
          {
            id: "registrar",
            src: "registrar",
            input: ({ context }) => ({ handles: (context as unknown as WsContext).handles! }),
          },
          {
            id: "body",
            // Annotated because the body is `AnyStateMachine`: its declared input type is opaque,
            // so `setup()` has nothing to contextually type this callback's parameter from.
            src: "body",
            input: ({ context }: { context: WsContext }) => {
              const ctx = context;
              const { repos, branch, review } = ctx.handles!;
              // Body-facing subset only (ADR-0016): endpoint/sandbox are mechanism-internal.
              return {
                ...ctx.runInput,
                workspace: { repos, branch, ...(review ? { review } : {}) } satisfies WorkspaceHandles<string>,
              };
            },
            onDone: {
              target: "teardown",
              actions: assign({ output: ({ event }) => (event as unknown as { output: unknown }).output }),
            },
          },
          leaseInvoke(true),
        ],
        // The wrapper emits, the body decides (ADR-0012): forward loss, with its reason, into the
        // body's policy.
        on: { "workspace.lost": { actions: sendTo("body", ({ event }) => event) } },
      },
      teardown: {
        invoke: {
          src: "destroy",
          input: ({ context }) => ({ wsId: (context as unknown as WsContext).wsId }),
          onDone: "done",
          // A failed delete is the operator GC's problem (ADR-0012 backstop), not the run's.
          onError: "done",
        },
      },
      done: { type: "final" },
    },
    // Machine output must be declared at the ROOT in xstate v5 (a final state's own `output`
    // only rides the done event); the workspace's output is the body's, verbatim (ADR-0012).
    output: ({ context }) => (context as unknown as WsContext).output,
  });
}

/** A Sandbox the watch says is gone — reaped by the idle GC, deleted by hand, its namespace
 * cleared — as the loss `workspace.lost` carries. */
const GONE: SandboxLoss = {
  reason: "Deleted",
  message: "the Sandbox is gone: deleted, or reaped by the operator's idle GC (ADR-0001)",
};
