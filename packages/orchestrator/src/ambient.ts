// Ambient workspace coordinates (ADR-0016): how an Agent's turn finds its Harness without the
// workflow threading `endpoint`/`sandbox` through every input. `workspace()`'s `running` state
// co-invokes a REGISTRAR actor that records the wrapper's mechanism handles here, keyed by the
// wrapper's own actorRef; the Agent actor walks `self._parent` to the nearest registered ancestor.
//
// Why an invoked actor and not an entry action: invoked actors restart on snapshot restore,
// entry actions do not — so the registration is restore-safe by construction (the same property
// the reconcile probe leans on, ADR-0012). Why the parent CHAIN: many concurrent workspaces
// share one actor system, so a system-keyed map cannot carry per-workspace handles; the chain
// resolves the ENCLOSING wrapper structurally, never a sibling's — which is what keeps
// cross-feature event injection impossible and lets the registration record the right Sandbox
// (ADR-0013's token scope) with zero consumer plumbing.
//
// A pure leaf (no flue, no machines) for the same reason as vocabulary.ts: actor.ts must reach
// it without dragging workspace.ts (and its SandboxPort surface) onto the actor's load path.

import type { AnyActorRef } from "xstate";

/** The mechanism-facing handles a workspace registers: where the Harness is, WHICH Sandbox
 * (ADR-0013 token scope), and the worktree geography the body-facing subset is cut from. */
export type AmbientHandles = {
  endpoint: string;
  sandbox: string;
  workdir: string;
  repos: Record<string, string>;
  branch: string;
  /** Detached review-worktree paths, when the spec carried `reviewSha` (ADR-0028). */
  review?: Record<string, string>;
};

const byRef = new WeakMap<AnyActorRef, AmbientHandles>();

/** Registrar-side: record a wrapper's handles under its actorRef; returns the disposer. */
export function registerAmbientHandles(ref: AnyActorRef, handles: AmbientHandles): () => void {
  byRef.set(ref, handles);
  return () => {
    // Dispose only our own entry (a re-registration on restore must not be clobbered late).
    if (byRef.get(ref) === handles) byRef.delete(ref);
  };
}

/** Actor-side: the nearest enclosing workspace's handles, via the actor parent chain.
 * (`_parent` is typed public API on `ActorRef` — underscore-prefixed, not hidden.) */
export function ambientHandlesFor(self: AnyActorRef): AmbientHandles | undefined {
  for (let ref = self._parent; ref; ref = ref._parent) {
    const handles = byRef.get(ref);
    if (handles) return handles;
  }
  return undefined;
}
