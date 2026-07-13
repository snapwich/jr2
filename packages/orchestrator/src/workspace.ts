// `workspace(body, spec)` (ADR-0012): the j2-owned wrapper Machine that owns ONLY Sandbox
// lifecycle — provision the Sandbox + attach repos/worktrees, run the author's body Machine
// inside it with `{ workspace: { endpoint, workdir, repos, branch } }` appended to its input,
// and destroy the Sandbox when the body reaches a final state. Teardown lives INSIDE the
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
// nothing (agent offsets re-attach streams); absent → the pod-local clone and any unpushed
// commits are gone, so it delivers `workspace.lost` INTO the restored body (same channel as
// `agent.fault`) and the body's policy decides. Never silently re-provision.

import { assign, createMachine, fromCallback, fromPromise, sendTo, type AnyStateMachine } from "xstate";
import { runBindingOf, type AnyActorSystem } from "./registration.ts";

/** What to attach, in workspace vocabulary only (ADR-0012 boundary): which repos on what base
 * ref, and the one branch the body works on. Workflow configuration never enters the spec. */
export type WorkspaceSpec = {
  repos: Array<{ name: string; baseRef: string }>;
  branch: string;
};

/** What the workspace hands the body: where to reach the Harness and where the worktrees are. */
export type WorkspaceHandles = {
  /** The Sandbox Harness base URL — what the body feeds `agentRun`'s `endpoint`. */
  endpoint: string;
  /** The primary working directory: the FIRST spec repo's branch worktree. */
  workdir: string;
  /** Every attached repo's branch-worktree path, by repo name. */
  repos: Record<string, string>;
  branch: string;
};

/**
 * The Sandbox backend a host supplies (`RunHostOptions.sandbox`) — the seam between the
 * workspace Machine and the cluster. All four operations MUST be idempotent: the invoking
 * states re-run on snapshot restore (create-if-absent, attach-if-absent, delete-if-present).
 */
export interface SandboxPort {
  /** Ensure the Sandbox CR exists (labeled with its run for `j2 ls`) and await `phase: Ready`;
   * resolve with the Harness endpoint the orchestrator can reach. */
  provision(req: { name: string; runId: string; workflow: string }): Promise<{ endpoint: string }>;
  /** Post-Ready attach (ADR-0004): per repo, `git clone --shared --no-checkout` from the RO
   * `default/` volume, then a branch worktree sibling. Resolves with the worktree paths. */
  attach(req: { name: string; spec: WorkspaceSpec }): Promise<{ workdir: string; repos: Record<string, string> }>;
  /** Is the Sandbox CR still there? (Restore-reconcile probe — a probe FAILURE is not "no".) */
  exists(name: string): Promise<boolean>;
  /** Delete the Sandbox CR. Absent is success. */
  destroy(name: string): Promise<void>;
}

/** Resolve the host's Sandbox backend, failing with a pointed message on a host without one. */
export function sandboxOf(system: AnyActorSystem): SandboxPort {
  const port = runBindingOf(system).sandbox;
  if (!port) {
    throw new Error(
      "this orchestrator has no Sandbox backend — workspace() needs a cluster " +
        "(configure `sandbox` in j2.config.ts and create the kind cluster with `j2 cluster up`)",
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

type WsContext = {
  /** The wrapper's own input, passed through to the body untouched (plus `workspace`). */
  runInput: Record<string, unknown>;
  /** This invocation's stable identity (the actor id the parent invoked/spawned us under). */
  wsId: string;
  /** The resolved spec — computed once from input and persisted, like any other context data. */
  spec: WorkspaceSpec;
  endpoint?: string;
  handles?: WorkspaceHandles;
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
  const provision = fromPromise<{ endpoint: string }, { wsId: string }>(async ({ input, system }) => {
    const binding = runBindingOf(system);
    return sandboxOf(system).provision({
      name: workspaceName(binding.runId, input.wsId),
      runId: binding.runId,
      workflow: binding.workflow,
    });
  });

  const attach = fromPromise<{ workdir: string; repos: Record<string, string> }, { wsId: string; spec: WorkspaceSpec }>(
    async ({ input, system }) =>
      sandboxOf(system).attach({ name: workspaceName(runBindingOf(system).runId, input.wsId), spec: input.spec }),
  );

  // The restore-reconcile probe: runs on every entry into `running` — fresh start (one cheap
  // existence check on the CR just created) and snapshot restore (the check that matters).
  const reconcile = fromCallback<{ type: string }, { wsId: string }>(({ input, system, sendBack }) => {
    let stale = false;
    void sandboxOf(system)
      .exists(workspaceName(runBindingOf(system).runId, input.wsId))
      .then((present) => {
        if (!present && !stale) sendBack({ type: "workspace.lost" });
      })
      .catch(() => {}); // a failed probe is "unknown", never "lost" — do not fabricate loss
    return () => {
      stale = true;
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
          input: ({ context }) => ({ wsId: (context as unknown as WsContext).wsId }),
          onDone: {
            target: "attaching",
            actions: assign({
              endpoint: ({ event }) => (event as unknown as { output: { endpoint: string } }).output.endpoint,
            }),
          },
        },
      },
      attaching: {
        invoke: {
          src: attach,
          input: ({ context }) => ({ wsId: (context as unknown as WsContext).wsId, spec: (context as unknown as WsContext).spec }),
          onDone: {
            target: "running",
            actions: assign({
              handles: ({ context, event }): WorkspaceHandles => {
                const ctx = context as WsContext;
                const out = (event as unknown as { output: { workdir: string; repos: Record<string, string> } }).output;
                return { endpoint: ctx.endpoint!, workdir: out.workdir, repos: out.repos, branch: ctx.spec.branch };
              },
            }),
          },
        },
      },
      running: {
        invoke: [
          {
            id: "body",
            src: body,
            input: ({ context }) => ({
              ...(context as unknown as WsContext).runInput,
              workspace: (context as unknown as WsContext).handles,
            }),
            onDone: {
              target: "teardown",
              actions: assign({ output: ({ event }) => (event as unknown as { output: unknown }).output }),
            },
          },
          {
            id: "reconcile",
            src: reconcile,
            input: ({ context }) => ({ wsId: (context as unknown as WsContext).wsId }),
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
