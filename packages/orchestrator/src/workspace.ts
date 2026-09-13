// `workspace(body, { input, image, user, repos, spec })` (ADR-0012, ADR-0049, ADR-0051): the
// j2-owned wrapper Machine that owns ONLY Sandbox lifecycle — provision the Sandbox (out of the
// STATIC `image`/`user`/`repos` options it carries) + attach one worktree per Repo Slot, run the
// author's body Machine inside it as the named slot `body`, with `{ workspace: { workdir, repos,
// branch } }` appended to its input (the mechanism-facing endpoint/sandbox are published ambiently
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
// (invoked actors re-execute from persisted input), so all four operations must be idempotent.
//
// Restore-reconcile (ADR-0012): the `running` state co-invokes a reconcile probe beside the
// body. Invoked callback actors restart on every (re)entry — including snapshot restore — so
// after an orchestrator restart the probe re-checks the Sandbox CR mechanically: present →
// nothing (agent admissions re-attach — ADR-0016); absent → the pod-local clone and any unpushed
// commits are gone, so it delivers `workspace.lost` INTO the restored body (same channel as
// `agent.fault`) and the body's policy decides. Never silently re-provision.

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
  repoSlotState,
  sandboxPartsOf,
  type Binding,
  type J2Repos,
  type J2Wrapper,
  type RepoSlot,
  type WrapperActors,
} from "./parts.ts";
import { runBindingOf, type AnyActorSystem } from "./registration.ts";
import { attachInputSchema, inputSchemaOf, invokingMachine, type HostInjectedInput } from "./vocabulary.ts";

/** Lease cadence when the backend names none. Well inside the 30m default idle timeout, so a
 * few missed renewals in a row are survivable; also the worst-case detection latency for a
 * workspace that went away (ADR-0021). */
const DEFAULT_LEASE_INTERVAL_MS = 5 * 60_000;

/** What to attach, in workspace vocabulary only (ADR-0012 boundary): the one branch the body
 * works on, the pod's work group, and the review sha. Derived PER RUN from the wrapper's input,
 * which is what keeps it out here rather than in the options — and which is exactly why the two
 * IMAGES and the REPOS are NOT here (ADR-0049, ADR-0051): `j2 up` must find them by walking the
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
 * silent widening the slot key exists to refuse.
 */
export type WorkspaceHandles<TSlots extends string> = {
  /** The primary working directory: the FIRST declared slot's branch worktree. */
  workdir: string;
  /** Every slot's branch-worktree path: `/work/<slot>/<branch>`. */
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
 * What a renewal learned about the workspace it just stamped (ADR-0021).
 *
 * `identity` is the backing pod's identity, NOT its address. Addresses are deterministic — the
 * CR name, the Service DNS, the worktree paths are all derived from the run — so every name a
 * live run holds still resolves after an eviction or a node loss, while the pod behind them is
 * a replacement with an empty `work` volume: clones, worktrees, and unpushed commits gone.
 * Presence cannot see that; identity can. A backend with no such notion may omit it, and its
 * workspaces are then reconciled on presence alone.
 */
export type Continuity = { present: false } | { present: true; identity?: string };

/** One Repo Slot as the port receives it at provision (ADR-0051): resolved to a Binding, and
 * flagged when the run — not the Machine — chose the url, because that is what the credentials
 * fence keys on. */
export type ProvisionedRepo = { slot: string; url: string; ref?: string; perRun: boolean };

/**
 * The Sandbox backend a host supplies (`RunHostOptions.sandbox`) — the seam between the
 * workspace Machine and the cluster. All four operations MUST be idempotent: the invoking
 * states re-run on snapshot restore (create-if-absent, attach-if-absent, delete-if-present).
 */
export interface SandboxPort {
  /** Ensure the Sandbox CR exists (labeled with its run for `j2 ls`) and await `phase: Ready`;
   * resolve with the Harness endpoint the orchestrator can reach, and the identity the lease
   * will hold this workspace to. `image`/`user` are the wrapper's static image options
   * (ADR-0037/0005/0049) — a `file:` context or a registry ref, the port resolves both, and a
   * context the last converge did not build fails here rather than converge-time. `repos` are the
   * wrapper's slots, resolved, in declaration order (ADR-0051): the port names each Repo on the
   * CR so the cluster mounts its cache, and refuses a per-run url no `git.credentials` entry
   * admits. `workGroup` is the pod's `fsGroup`; the port owns the default. */
  provision(req: {
    name: string;
    runId: string;
    workflow: string;
    image?: string;
    user?: string;
    workGroup?: number;
    repos: ProvisionedRepo[];
  }): Promise<{ endpoint: string; identity?: string }>;
  /** Post-Ready attach (ADR-0004): per slot, `git clone --shared --no-checkout` off the node's
   * read-only cache, then a branch worktree sibling — and, with `spec.reviewSha`, the detached
   * review worktree (ADR-0028). Resolves with the worktree paths by slot; `stale` names the slots
   * whose cache could not be fetched before this attach, with git's own error (ADR-0051: freshness
   * degrades, absence does not). */
  attach(req: {
    name: string;
    spec: WorkspaceSpec;
    repos: Array<{ slot: string; url: string; ref?: string }>;
  }): Promise<{
    workdir: string;
    repos: Record<string, string>;
    review?: Record<string, string>;
    stale?: Record<string, string>;
  }>;
  /**
   * Renew this workspace's keepalive lease AND report what the renewal found — one exchange,
   * because it is one question: is the thing I am keeping alive still the thing I attached to?
   * Nothing in the cluster represents a run (ADR-0001), so the lease is how the Orchestrator
   * asserts liveness; the answer is how it learns the truth. Idempotent, called on a timer.
   *
   * A renewal that FAILS must reject, not resolve `{present: false}` — an unreachable API server
   * is "unknown", and fabricating loss would settle a live run holding real work.
   */
  renew(name: string): Promise<Continuity>;
  /** Delete the Sandbox CR. Absent is success. */
  destroy(name: string): Promise<void>;
  /** How often to renew. Must be well inside the backend's idle-timeout, since a lapsed lease is
   * what lets the operator reap. Also the detection latency for a lost workspace. */
  readonly leaseIntervalMs?: number;
}

/** Resolve the host's Sandbox backend, failing with a pointed message on a host without one. */
export function sandboxOf(system: AnyActorSystem): SandboxPort {
  const port = runBindingOf(system).sandbox;
  if (!port) {
    throw new Error(
      "this orchestrator has no Sandbox backend — a Workspace is always a real Sandbox (ADR-0012); " +
        "this process is not deployed in a cluster (J2_NAMESPACE unset). `j2 up` the instance and run there.",
    );
  }
  return port;
}

/**
 * The Sandbox CR name for one workspace invocation: DNS-1123, deterministic from the run and
 * the wrapper's actor id (both stable across restore — that is what lets the reconcile probe
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
  /** The pod identity this workspace attached to, captured at provision and persisted so the
   * lease can hold the workspace to it across a restart (ADR-0021). Plain serializable data,
   * exactly like `endpoint` — ADR-0007's rule about what may ride context. */
  identity?: string;
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
 * through the wrapper, without the composer ever spelling `body`. {@link J2Wrapper} is what SAYS
 * it is a wrapper — the type twin of the `attachWrapperBody` stamp `workspace()` writes below — so
 * `customize()` reaches the body because this Machine IS one, never because a slot is spelled
 * `body`: that name is an author's to choose too (parts.ts).
 */
export type WorkspaceMachine<
  TInput,
  TOutput,
  TBody extends AnyStateMachine = AnyStateMachine,
  TSlots extends string = string,
> = StateMachine<
  any,
  any,
  any,
  WrapperActors<"body", TBody, "provision" | "attach" | "registrar" | "lease" | "destroy">,
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
  J2Wrapper<TBody> &
  J2Repos<TSlots>;

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
    ? unknown
    : { "the body's declared input must accept the door plus the injected handles": Workspaced<TDoor, TSlots> };

/**
 * What the Sandbox is MADE OF (ADR-0037, ADR-0005) and which Repos it attaches (ADR-0051), as
 * STATIC options on the wrapper rather than fields of the per-run spec (ADR-0049). Static is the
 * whole point: `j2 up` walks the registered Machines to find every `file:` context and build it,
 * every bound Repo and warm it, every open slot and refuse it (parts.ts) — and a spec is a function
 * of run input that no walk can evaluate. They are also never persisted — the provisioning state
 * re-reads them off the Machine it was invoked as, so a restore, a `provide()` and a `customize()`
 * all get the image and the slots the Machine carries NOW.
 *
 * Each image is one string in ADR-0037's two shapes: a `file:` URL to a docker context the
 * Machine's module ships (`import.meta.resolve("./image")`), or a registry ref its owner baked and
 * hosts.
 */
export type SandboxOptions<TSlots extends string = string, TInput = unknown> = {
  /** The Sandbox Image. Absent → the Instance's `images/default`, then the stock Harness. */
  image?: string;
  /** The User Container's image (ADR-0005). Absent → the pod has no third container: there is no
   * default, because the seat's whole identity is "what j2 does not own" and j2 has nothing to put
   * there. One string is the entire authoring surface — env, ports, and resources are deliberately
   * not forwarded. */
  user?: string;
  /**
   * The Repo Slots (ADR-0051), keyed by the Machine's own word for each — the key of the body's
   * `workspace.repos` handles and the directory under `/work`; the FIRST is the body's `workdir`.
   * Required, at least one: a Workspace exists to work on a repository. Each slot is bound (a url,
   * or `{ url, ref? }` — the package's own), open (`open` — the consumer binds it with
   * `customize`), or per-run (a mapper over the door: `({ input }) => input.repo`).
   */
  repos: Record<TSlots, RepoSlot<TInput>>;
};

/**
 * How a Workspace with a declared door is configured (ADR-0012, ADR-0033) — the wrapper's own
 * run-input schema, what the pod is made of, and the mapping from what comes through the door to
 * workspace vocabulary.
 */
export type WorkspaceOptions<TSchema extends z.ZodObject, TSlots extends string = string> = SandboxOptions<
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
 * How a Workspace with NO declared door is configured: absence is permissive (ADR-0033), so j2
 * has nothing to infer from and says `unknown` rather than `any` — an honest "j2 does not know",
 * which the mapper must narrow before it reads a field. A wrapper that is fed by something other
 * than a caller — a pool worker, a nested invoke — may state what it is fed by annotating the
 * parameter (`spec: ({ input }: { input: Item }) => …`), which types the wrapper's input too. For
 * anything a caller starts, the honest fix is to declare `input`.
 */
export type PermissiveWorkspaceOptions<TInput = unknown, TSlots extends string = string> = SandboxOptions<
  TSlots,
  TInput
> & {
  /** Never present on this path. Spelled out so a declared schema can never fall through to the
   * permissive overload, where the body would go unchecked. */
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
export function workspace<TBody extends AnyStateMachine, TInput = unknown, TSlots extends string = string>(
  body: TBody,
  options: PermissiveWorkspaceOptions<TInput, TSlots>,
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
  for (const seat of ["image", "user"] as const) {
    const value = options[seat];
    if (value !== undefined && (typeof value !== "string" || !value)) {
      throw new Error(
        `workspace(): \`${seat}\` must be a non-empty string (got ${JSON.stringify(value)}) — either a \`file:\` ` +
          'URL to a docker context this module ships (`import.meta.resolve("./image")`) or a registry ref ' +
          "(ADR-0037).",
      );
    }
  }
  // The slots, checked NOW for the same reason (ADR-0051): every value is one of the three forms,
  // every key is a directory name, and there is at least one — a Workspace exists to work on a
  // repository, and a wrapper with no slot would attach nothing and hand the body no `workdir`.
  const repos = options.repos;
  if (typeof repos !== "object" || repos === null || Array.isArray(repos) || Object.keys(repos).length === 0) {
    throw new Error(
      'workspace(): `repos` must name at least one Repo Slot — `repos: { app: "https://…" }`, or ' +
        "`open` for a slot the consumer binds, or a mapper over the door for one the run chooses (ADR-0051).",
    );
  }
  for (const [slot, value] of Object.entries(repos)) assertRepoSlot("workspace()", slot, value);
  const wrapper = buildWorkspaceMachine(body, options.spec);
  // The wrapper is TRANSPARENT to its body (ADR-0049): `customize(machine, { agents })` on a
  // Workspace means the Machine inside, so the composer never spells `body` and never has to know
  // that j2 wrapped anything.
  attachWrapperBody(wrapper, "body");
  // What the pod is MADE of and which Repos it attaches ride the Machine (ADR-0049, ADR-0051),
  // keyed on `machine.config` like the vocabulary — so a `provide()` clone keeps them, and the
  // provisioning state reads them back off the Machine it was invoked as instead of closing over
  // these values. That is also what lets `j2 up` find every `file:` context, every bound Repo and
  // every open slot by walking the registered Machines (parts.ts).
  attachSandboxParts(wrapper, {
    ...(options.image !== undefined ? { image: options.image } : {}),
    ...(options.user !== undefined ? { user: options.user } : {}),
    repos: { ...repos },
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
 * mapping fn, so a `j2 run --input` missing a field the mapping reads arrives here as `undefined` —
 * unchecked, it survives until the attach script's string ops and dies as "Cannot read properties
 * of undefined", with a Sandbox already provisioned and nothing pointing back at the input.
 */
function assertSpec(spec: WorkspaceSpec): void {
  const bad: string[] = [];
  if (typeof spec?.branch !== "string" || !spec.branch) bad.push(`branch (got ${JSON.stringify(spec?.branch)})`);
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
        "`j2 run --input` carry every field this workflow's workspace() mapping reads?",
    );
  }
}

/**
 * Resolve every Repo Slot to a Binding, in declaration order (ADR-0051). A bound slot is its
 * Binding; a per-run slot is its mapper called over the run input, validated like the static forms
 * because it derives from `j2 run --input` exactly as the spec does; an open slot nobody bound is
 * a fault BEFORE the port, naming the `customize` line that fixes it — the run-time twin of the
 * refusal `j2 up`'s walk makes for a registered Machine, reached here only by a Machine that was
 * never registered as itself (a test seam, a nested invoke of an unbound import). The Machine is
 * named as the walk names it: the Workflow it runs under, and the slot chain (`path`) from that
 * root to this wrapper — which is the `actors` nesting of the line, so it pastes.
 */
function resolveBindings(
  where: { workflow: string; path: string[] | undefined },
  slots: Record<string, RepoSlot>,
  runInput: unknown,
): Record<string, ResolvedBinding> {
  const bindings: Record<string, ResolvedBinding> = {};
  for (const [slot, value] of Object.entries(slots)) {
    const state = repoSlotState(value);
    if (state.kind === "open") {
      const fix =
        where.path === undefined
          ? "no customize() reaches a Machine invoked inline; declare it under setup({ actors }) and bind the slot there"
          : `bind it where the Machine is registered: export const machine = ${customizeLine("<import>", where.path, slot)}`;
      throw new Error(`workflow "${where.workflow}": Repo Slot "${slot}" is open — nobody bound it; ${fix} (ADR-0051)`);
    }
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
          "input; does `j2 run --input` carry every field this workflow's workspace() slot reads?",
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
  const provision = fromPromise<
    { endpoint: string; identity?: string; bindings: Record<string, ResolvedBinding> },
    { wsId: string; spec: WorkspaceSpec; runInput: unknown }
  >(async ({ input, self, system }) => {
    assertSpec(input.spec); // before the port: a bad spec must never cost a pod
    const binding = runBindingOf(system);
    // The images and the slots come off the WRAPPER, at invoke time, not out of context and not
    // out of a build-time closure (ADR-0049, ADR-0051). This state re-runs on every restore, so
    // the re-read is the whole mechanism: a redeployed instance provisions what the Machine
    // carries NOW, and no snapshot ever holds an image name — let alone a resolved
    // content-addressed tag, which would outlive the image it names. The RESOLVED bindings are
    // persisted, because a per-run mapper's answer is this run's fact.
    const parts = sandboxPartsOf(invokingMachine(self));
    const bindings = resolveBindings(
      { workflow: binding.workflow, path: actorSlotPath(self._parent) },
      parts.repos,
      input.runInput,
    );
    const provisioned = await sandboxOf(system).provision({
      name: workspaceName(binding.runId, input.wsId),
      runId: binding.runId,
      workflow: binding.workflow,
      // The image strings straight through (ADR-0037/0005) — the port owns resolution, and the
      // work group's default (ADR-0005 puts it in pod composition, where the pod is built).
      ...(parts.image !== undefined ? { image: parts.image } : {}),
      ...(parts.user !== undefined ? { user: parts.user } : {}),
      ...(input.spec.workGroup !== undefined ? { workGroup: input.spec.workGroup } : {}),
      repos: Object.entries(bindings).map(([slot, b]) => ({ slot, ...b })),
    });
    return { ...provisioned, bindings };
  });

  const attach = fromPromise<
    { workdir: string; repos: Record<string, string>; review?: Record<string, string>; stale?: Record<string, string> },
    { wsId: string; spec: WorkspaceSpec; bindings: Record<string, ResolvedBinding> }
  >(async ({ input, system }) => {
    const name = workspaceName(runBindingOf(system).runId, input.wsId);
    const out = await sandboxOf(system).attach({ name, spec: input.spec, repos: attachedRepos(input.bindings) });
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
    const detachEcho = runBindingOf(system as AnyActorSystem).echo?.(input.handles.endpoint);
    return () => {
      detachEcho?.();
      disposeHandles();
    };
  });

  /**
   * The lease (ADR-0021). One actor owns the whole exchange with the cluster for one workspace:
   * it asserts liveness (nothing in the cluster represents a run, so the Orchestrator must keep
   * saying "still mine" or the operator's idle GC reaps — ADR-0001) and, in the same call, reads
   * back whether what it just stamped is still what the body attached to.
   *
   * Being an INVOKED actor is the whole design. Its lifetime IS `running`'s lifetime, which
   * xstate already manages: it re-invokes on snapshot restore (so a restart reconciles for free,
   * with no restore-specific code path), and it stops on every exit — body final, run stopped,
   * run faulted. That last one is why there is no `release()`: a faulted run stops its actors,
   * the lease stops with them, and the abandoned pod ages out of the idle timeout on its own.
   *
   * Level-triggered on purpose. The one-shot probe this replaces could only fire on entry, so a
   * run parked on a gate for hours — the state most likely to outlive its Sandbox — never
   * rechecked anything until the next restart.
   */
  const lease = fromCallback<{ type: string }, { wsId: string; identity?: string }>(({ input, system, sendBack }) => {
    const port = sandboxOf(system);
    const name = workspaceName(runBindingOf(system).runId, input.wsId);
    let stopped = false;

    const renew = async (): Promise<void> => {
      let seen: Continuity;
      try {
        seen = await port.renew(name);
      } catch {
        return; // unknown, never lost: an API blip must not settle a run holding real work
      }
      if (stopped) return;
      // Two ways to lose a workspace, one event. Gone: reaped, deleted, namespace cleared.
      // Replaced: the CR survived an eviction or node loss but the pod behind it did not, so
      // every name still resolves over an empty `work` volume. Re-provisioning either silently
      // would resume into an inconsistent world — the body decides (ADR-0012).
      const replaced =
        seen.present && input.identity !== undefined && seen.identity !== undefined
          ? seen.identity !== input.identity
          : false;
      if (!seen.present || replaced) sendBack({ type: "workspace.lost" });
    };

    void renew(); // immediately on entry: this is the restore-reconcile, no longer a special case
    const timer = setInterval(() => void renew(), port.leaseIntervalMs ?? DEFAULT_LEASE_INTERVAL_MS);
    timer.unref?.(); // a lease never holds the process open; it matters only while the run runs
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  });

  const destroy = fromPromise<void, { wsId: string }>(async ({ input, system }) =>
    sandboxOf(system).destroy(workspaceName(runBindingOf(system).runId, input.wsId)),
  );

  // Every actor this wrapper runs is a NAMED SLOT (ADR-0049), the body first among them: a Machine
  // composes by invoking a declared `src`, and `body` is what `provide()`, `customize()`, Stately,
  // the Console's join key and the `j2 up` parts walk all reach it by. The mechanism's own four —
  // provision, attach, registrar, lease, destroy — are named for the same price, and the Console
  // now shows what each state is doing instead of "inline".
  return setup({
    actors: { body, provision, attach, registrar, lease, destroy },
  }).createMachine({
    id: "workspace",
    context: ({ input, self }: { input: unknown; self: { id: string } }): WsContext => ({
      runInput: (input ?? {}) as Record<string, unknown>,
      wsId: self.id,
      spec: spec({ input }),
    }),
    initial: "provisioning",
    states: {
      provisioning: {
        invoke: {
          src: "provision",
          input: ({ context }) => ({
            wsId: (context as unknown as WsContext).wsId,
            spec: (context as unknown as WsContext).spec,
            runInput: (context as unknown as WsContext).runInput,
          }),
          onDone: {
            target: "attaching",
            actions: assign({
              endpoint: ({ event }) => (event as unknown as { output: { endpoint: string } }).output.endpoint,
              identity: ({ event }) => (event as unknown as { output: { identity?: string } }).output.identity,
              bindings: ({ event }) =>
                (event as unknown as { output: { bindings: Record<string, ResolvedBinding> } }).output.bindings,
            }),
          },
        },
      },
      attaching: {
        invoke: {
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
                    output: { workdir: string; repos: Record<string, string>; review?: Record<string, string> };
                  }
                ).output;
                return {
                  endpoint: ctx.endpoint!,
                  // Derived, not remembered: the same function every port operation names the CR
                  // with, so the Sandbox the registrar publishes — and the Agent actor records on its
                  // registration — is the one the Adapter's token is scoped to, by construction
                  // (ADR-0013).
                  sandbox: workspaceName(runBindingOf(system as AnyActorSystem).runId, ctx.wsId),
                  workdir: out.workdir,
                  repos: out.repos,
                  branch: ctx.spec.branch,
                  ...(out.review ? { review: out.review } : {}),
                };
              },
            }),
          },
        },
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
              const { workdir, repos, branch, review } = ctx.handles!;
              // Body-facing subset only (ADR-0016): endpoint/sandbox are mechanism-internal.
              return {
                ...ctx.runInput,
                workspace: { workdir, repos, branch, ...(review ? { review } : {}) } satisfies WorkspaceHandles<string>,
              };
            },
            onDone: {
              target: "teardown",
              actions: assign({ output: ({ event }) => (event as unknown as { output: unknown }).output }),
            },
          },
          {
            id: "lease",
            src: "lease",
            input: ({ context }) => ({
              wsId: (context as unknown as WsContext).wsId,
              identity: (context as unknown as WsContext).identity,
            }),
          },
        ],
        // The wrapper emits, the body decides (ADR-0012): forward loss into the body's policy.
        on: { "workspace.lost": { actions: sendTo("body", { type: "workspace.lost" }) } },
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
