// `workspace(body, { input, spec })` (ADR-0012): the j2-owned wrapper Machine that owns ONLY
// Sandbox lifecycle — provision the Sandbox + attach repos/worktrees, run the author's body
// Machine inside it with `{ workspace: { workdir, repos, branch } }` appended to its input (the
// mechanism-facing endpoint/sandbox are published ambiently — ADR-0016, ambient.ts), and
// destroy the Sandbox when the body reaches a final state. Teardown lives INSIDE the
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
  createMachine,
  fromCallback,
  fromPromise,
  sendTo,
  type AnyStateMachine,
  type InputFrom,
  type OutputFrom,
  type StateMachine,
} from "xstate";
import type { z } from "zod";
import { registerAmbientHandles, type AmbientHandles } from "./ambient.ts";
import { runBindingOf, type AnyActorSystem } from "./registration.ts";
import {
  attachInputSchema,
  attachVocabulary,
  inputSchemaOf,
  vocabularyOf,
  type HostInjectedInput,
} from "./vocabulary.ts";

/** Lease cadence when the backend names none. Well inside the 30m default idle timeout, so a
 * few missed renewals in a row are survivable; also the worst-case detection latency for a
 * workspace that went away (ADR-0021). */
const DEFAULT_LEASE_INTERVAL_MS = 5 * 60_000;

/** What to attach, in workspace vocabulary only (ADR-0012 boundary): which repos on what base
 * ref, the one branch the body works on — and, since ADR-0037, what the Sandbox is MADE OF.
 * Workflow configuration still never enters the spec; pod composition is admitted because it is
 * the wrapper's business in exactly the way its worktrees are. */
export type WorkspaceSpec = {
  repos: Array<{ name: string; baseRef: string }>;
  branch: string;
  /** The Sandbox Image (ADR-0037), in either of its two origins: an `images/<name>` DIRNAME the
   * instance builds, or a registry REF its owner baked and hosts. The two are told apart by shape
   * — a ref contains `/` or `:`, a dirname cannot — and resolution to a concrete ref is the
   * port's, which keeps the Machine cluster-agnostic. A ref is safe to persist for the same reason
   * a dirname is: both are stable NAMES. What must never reach a snapshot is a resolved
   * content-addressed tag, which would outlive the image it names — and that only ever exists on
   * the port's side of the seam. Absent → `images/default`, then the stock Harness. */
  image?: string;
  /** The User Container's image (ADR-0005), same two origins and the same resolution as `image`.
   * Absent → the pod has no third container: there is no default, because the seat's whole
   * identity is "what j2 does not own" and j2 has nothing to put there. One string is the entire
   * authoring surface — env, ports, and resources are deliberately not forwarded. */
  user?: string;
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
 * What the workspace hands the BODY (ADR-0012, ADR-0016): worktree geography only.
 * `endpoint` and `sandbox` are mechanism-internal now — `agentRun` resolves them ambiently from
 * the enclosing wrapper (ambient.ts), so a workflow can no longer forget to thread them (the
 * baba71f incident: `sandbox` omitted, every tool call 403'd, fail-closed but silent).
 */
export type WorkspaceHandles = {
  /** The primary working directory: the FIRST spec repo's branch worktree. */
  workdir: string;
  /** Every attached repo's branch-worktree path, by repo name. */
  repos: Record<string, string>;
  branch: string;
  /** Detached review-worktree paths by repo name (ADR-0028) — present only when the spec carried
   * `reviewSha`. The reviewer's seat: hand one of these as its cwd/prompt frame. */
  review?: Record<string, string>;
};

/**
 * A body's input under a Workspace: the run input the wrapper passes through, PLUS the handles it
 * injects. The composition is the whole reason the door is declared on the wrapper and not on the
 * body (ADR-0033) — `Workspaced<RunInput>` is what the body receives, `RunInput` is what a caller
 * may send, and no caller can send `workspace` (the handles do not exist until a Sandbox is
 * provisioned and attached). Naming it here keeps the body from hand-copying
 * {@link WorkspaceHandles}, which drifts.
 *
 * The wrapper passes its input through UNTOUCHED, so a ROOT-placed wrapper's body also receives
 * what the host injected beside the door — `HostInjectedInput` today (the run's `instanceId`).
 * That is outside this type on purpose: it depends on where the wrapper sits, and `Workspaced` is
 * the composition the WRAPPER makes.
 */
export type Workspaced<TInput> = TInput & { workspace: WorkspaceHandles };

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

/**
 * The Sandbox backend a host supplies (`RunHostOptions.sandbox`) — the seam between the
 * workspace Machine and the cluster. All four operations MUST be idempotent: the invoking
 * states re-run on snapshot restore (create-if-absent, attach-if-absent, delete-if-present).
 */
export interface SandboxPort {
  /** Ensure the Sandbox CR exists (labeled with its run for `j2 ls`) and await `phase: Ready`;
   * resolve with the Harness endpoint the orchestrator can reach, and the identity the lease
   * will hold this workspace to. `image`/`user` are the spec's image NAMES (ADR-0037/0005) —
   * dirname or registry ref, the port resolves both, and an unknown dirname fails here rather
   * than converge-time. `workGroup` is the pod's `fsGroup`; the port owns the default. */
  provision(req: {
    name: string;
    runId: string;
    workflow: string;
    image?: string;
    user?: string;
    workGroup?: number;
  }): Promise<{ endpoint: string; identity?: string }>;
  /** Post-Ready attach (ADR-0004): per repo, `git clone --shared --no-checkout` from the RO
   * `default/` volume, then a branch worktree sibling — and, with `spec.reviewSha`, the detached
   * review worktree (ADR-0028). Resolves with the worktree paths. */
  attach(req: {
    name: string;
    spec: WorkspaceSpec;
  }): Promise<{ workdir: string; repos: Record<string, string>; review?: Record<string, string> }>;
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
      "this orchestrator has no Sandbox backend — workspace() needs a cluster with the instance's " +
        "repos (declare a non-empty `repos` in j2.config.ts and converge with `j2 up` — ADR-0031)",
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

type WsContext = {
  /** The wrapper's own input, passed through to the body untouched (plus `workspace`). */
  runInput: Record<string, unknown>;
  /** This invocation's stable identity (the actor id the parent invoked/spawned us under). */
  wsId: string;
  /** The resolved spec — computed once from input and persisted, like any other context data. */
  spec: WorkspaceSpec;
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
 * What `workspace()` returns: a Machine erased to the two parameters that carry meaning across
 * the seam — the door a run of it starts with, and the body's output, which the wrapper forwards
 * verbatim (ADR-0012). Everything else is the wrapper's own business, so it stays `any`: a
 * generic `setup()` over the body does not infer (report-xstate.md §3), which is why the
 * implementation is loosely typed and only the public signature is precise.
 */
export type WorkspaceMachine<TInput, TOutput> = StateMachine<
  any,
  any,
  any,
  any,
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
>;

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
type BodyAcceptsDoor<TBody extends AnyStateMachine, TDoor> =
  Workspaced<TDoor> & HostInjectedInput extends InputFrom<TBody>
    ? unknown
    : { "the body's declared input must accept the door plus the injected handles": Workspaced<TDoor> };

/**
 * How a Workspace with a declared door is configured (ADR-0012, ADR-0033) — the wrapper's own
 * run-input schema, and the mapping from what comes through it to workspace vocabulary.
 */
export type WorkspaceOptions<TSchema extends z.ZodObject> = {
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
export type PermissiveWorkspaceOptions<TInput = unknown> = {
  /** Never present on this path. Spelled out so a declared schema can never fall through to the
   * permissive overload, where the body would go unchecked. */
  input?: never;
  spec: (args: { input: TInput }) => WorkspaceSpec;
};

/**
 * Wrap a body Machine in Sandbox lifecycle (ADR-0012). `spec` maps the wrapper's input to the
 * workspace-domain spec; the body receives the wrapper's input plus `workspace` (the handles) —
 * `Workspaced<TInput>`, which is also what the declared door checks the body against. The
 * wrapper's output is the body's output. A body ERROR is deliberately unhandled: it faults the run
 * loudly (RunStatus.fault) and leaves the Sandbox to the operator's idle-timeout GC — the trail
 * stays inspectable, and silent cleanup would destroy the evidence.
 */
export function workspace<TSchema extends z.ZodObject, TBody extends AnyStateMachine>(
  body: TBody & BodyAcceptsDoor<TBody, z.infer<TSchema>>,
  options: WorkspaceOptions<TSchema>,
): WorkspaceMachine<z.infer<TSchema>, OutputFrom<TBody>>;
export function workspace<TBody extends AnyStateMachine, TInput = unknown>(
  body: TBody,
  options: PermissiveWorkspaceOptions<TInput>,
): WorkspaceMachine<TInput, OutputFrom<TBody>>;
export function workspace(
  body: AnyStateMachine,
  options: { input?: z.ZodObject; spec: (args: { input: any }) => WorkspaceSpec },
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
  const wrapper = buildWorkspaceMachine(body, options.spec);
  // Propagate the body's vocabulary onto the wrapper (ADR-0015): a workflow whose ROOT is this
  // wrapper still registers its defs — discovery reads the vocabulary off the exported machine.
  const vocab = vocabularyOf(body);
  if (vocab) attachVocabulary(wrapper, vocab);
  // The door does NOT propagate from the body (ADR-0033): the wrapper hands the body the run
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
  if (!Array.isArray(spec?.repos) || spec.repos.length === 0) bad.push("repos (need at least one)");
  else
    spec.repos.forEach((r, i) => {
      if (typeof r?.name !== "string" || !r.name) bad.push(`repos[${i}].name (got ${JSON.stringify(r?.name)})`);
      if (typeof r?.baseRef !== "string" || !r.baseRef)
        bad.push(`repos[${i}].baseRef (got ${JSON.stringify(r?.baseRef)})`);
    });
  if (spec?.reviewSha !== undefined && (typeof spec.reviewSha !== "string" || !spec.reviewSha))
    bad.push(`reviewSha (got ${JSON.stringify(spec?.reviewSha)})`);
  // Shape only, for both image names. Whether a DIRNAME exists is unanswerable here — the image
  // map lives in the cluster and this runs before any port call — so an unknown one fails at
  // provision (ADR-0037), loudly and listing what was discovered. A REF is not checkable anywhere
  // on this side: it is deployed-never-built, and its pull is the cluster's own.
  if (spec?.image !== undefined && (typeof spec.image !== "string" || !spec.image))
    bad.push(`image (got ${JSON.stringify(spec?.image)})`);
  if (spec?.user !== undefined && (typeof spec.user !== "string" || !spec.user))
    bad.push(`user (got ${JSON.stringify(spec?.user)})`);
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

function buildWorkspaceMachine(body: AnyStateMachine, spec: (args: { input: any }) => WorkspaceSpec): AnyStateMachine {
  const provision = fromPromise<{ endpoint: string }, { wsId: string; spec: WorkspaceSpec }>(
    async ({ input, system }) => {
      assertSpec(input.spec); // before the port: a bad spec must never cost a pod
      const binding = runBindingOf(system);
      return sandboxOf(system).provision({
        name: workspaceName(binding.runId, input.wsId),
        runId: binding.runId,
        workflow: binding.workflow,
        // The NAMES, straight through (ADR-0037/0005) — the port owns resolution, and the
        // work group's default (ADR-0005 puts it in pod composition, where the pod is built).
        ...(input.spec.image !== undefined ? { image: input.spec.image } : {}),
        ...(input.spec.user !== undefined ? { user: input.spec.user } : {}),
        ...(input.spec.workGroup !== undefined ? { workGroup: input.spec.workGroup } : {}),
      });
    },
  );

  const attach = fromPromise<
    { workdir: string; repos: Record<string, string>; review?: Record<string, string> },
    { wsId: string; spec: WorkspaceSpec }
  >(async ({ input, system }) =>
    sandboxOf(system).attach({ name: workspaceName(runBindingOf(system).runId, input.wsId), spec: input.spec }),
  );

  // The ambient registrar (ADR-0016): publishes this wrapper's handles for the parent-chain
  // walk `agentRun` does. An INVOKED actor, co-invoked in `running` beside the body — invoked
  // actors restart on snapshot restore (entry actions do not), so the publication is
  // restore-safe by construction; and it is listed FIRST, so the handles are readable before
  // the body's first agentRun starts.
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

  return createMachine({
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
          src: provision,
          input: ({ context }) => ({
            wsId: (context as unknown as WsContext).wsId,
            spec: (context as unknown as WsContext).spec,
          }),
          onDone: {
            target: "attaching",
            actions: assign({
              endpoint: ({ event }) => (event as unknown as { output: { endpoint: string } }).output.endpoint,
              identity: ({ event }) => (event as unknown as { output: { identity?: string } }).output.identity,
            }),
          },
        },
      },
      attaching: {
        invoke: {
          src: attach,
          input: ({ context }) => ({
            wsId: (context as unknown as WsContext).wsId,
            spec: (context as unknown as WsContext).spec,
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
                  // with, so the Sandbox the registrar publishes — and agentRun records on its
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
            src: registrar,
            input: ({ context }) => ({ handles: (context as unknown as WsContext).handles! }),
          },
          {
            id: "body",
            src: body,
            input: ({ context }) => {
              const ctx = context as unknown as WsContext;
              const { workdir, repos, branch, review } = ctx.handles!;
              // Body-facing subset only (ADR-0016): endpoint/sandbox are mechanism-internal.
              return {
                ...ctx.runInput,
                workspace: { workdir, repos, branch, ...(review ? { review } : {}) } satisfies WorkspaceHandles,
              };
            },
            onDone: {
              target: "teardown",
              actions: assign({ output: ({ event }) => (event as unknown as { output: unknown }).output }),
            },
          },
          {
            id: "lease",
            src: lease,
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
          src: destroy,
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
