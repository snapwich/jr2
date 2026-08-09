// `workspace(body, spec)` (ADR-0012): the j2-owned wrapper Machine that owns ONLY Sandbox
// lifecycle — provision the Sandbox + attach repos/worktrees, run the author's body Machine
// inside it with `{ workspace: { workdir, repos, branch } }` appended to its input (the
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

import { assign, createMachine, fromCallback, fromPromise, sendTo, type AnyStateMachine } from "xstate";
import { registerAmbientHandles, type AmbientHandles } from "./ambient.ts";
import { runBindingOf, type AnyActorSystem } from "./registration.ts";
import { attachInputSchema, attachVocabulary, inputSchemaOf, vocabularyOf } from "./vocabulary.ts";

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
  /** The Sandbox Image (ADR-0037): an `images/<name>` DIRNAME, never a ref. Resolution to a ref is
   * the port's, which keeps the Machine cluster-agnostic and — the load-bearing half — keeps a
   * content-addressed tag out of the persisted snapshot, where it would outlive the image it
   * names. Absent → `images/default`, then the stock Harness. */
  image?: string;
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
   * will hold this workspace to. `image` is the spec's Sandbox Image NAME (ADR-0037) — the port
   * resolves it to a ref, and an unknown name fails here rather than converge-time. */
  provision(req: {
    name: string;
    runId: string;
    workflow: string;
    image?: string;
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
 * Wrap a body Machine in Sandbox lifecycle (ADR-0012). `spec` maps the wrapper's input to the
 * workspace-domain spec; the body receives the wrapper's input plus `workspace` (the handles).
 * The wrapper's output is the body's output. A body ERROR is deliberately unhandled: it faults
 * the run loudly (RunStatus.fault) and leaves the Sandbox to the operator's idle-timeout GC —
 * the trail stays inspectable, and silent cleanup would destroy the evidence.
 */
export function workspace(body: AnyStateMachine, spec: (args: { input: any }) => WorkspaceSpec): AnyStateMachine {
  const wrapper = buildWorkspaceMachine(body, spec);
  // Propagate the body's vocabulary onto the wrapper (ADR-0015): a workflow whose ROOT is this
  // wrapper still registers its defs — discovery reads the vocabulary off the exported machine.
  const vocab = vocabularyOf(body);
  if (vocab) attachVocabulary(wrapper, vocab);
  // Same propagation for the body's declared run input (ADR-0033): the wrapper passes its own
  // input to the body untouched (`runInput`), so the body's contract IS the wrapper's door.
  const inputSchema = inputSchemaOf(body);
  if (inputSchema) attachInputSchema(wrapper, inputSchema);
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
  // Shape only. Whether the NAME exists is unanswerable here — the image map lives in the cluster
  // and this runs before any port call — so an unknown name fails at provision (ADR-0037), loudly
  // and listing what was discovered.
  if (spec?.image !== undefined && (typeof spec.image !== "string" || !spec.image))
    bad.push(`image (got ${JSON.stringify(spec?.image)})`);
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
        // The NAME, straight through (ADR-0037) — the port owns resolution.
        ...(input.spec.image !== undefined ? { image: input.spec.image } : {}),
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
