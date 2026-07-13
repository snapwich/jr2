// Durable Machine state codec (ADR-0007): strip the non-serializable, environment-bound parts
// of an xstate snapshot on the way to the store, and re-inject them on the way back. Context
// holds live ports (a FlueClient, the ControlPlane) and child actor inputs reference them; the
// codec replaces those with placeholders the host re-hydrates against the current process.
//
// A live handle hides in TWO places: the parent `context`, and each invoked child's persisted
// input at `snapshot.children.<id>.snapshot.input`. We strip both on save and re-inject both on
// restore. The child re-attach lever is the persisted input, not the parent `invoke` (xstate v5
// re-spawns from the child's persisted input on restore), so `rewriteChildInput` is what makes a
// restored run re-attach its stream instead of re-POSTing.
//
// We rebuild the touched paths immutably rather than `structuredClone`-ing the whole snapshot:
// a live handle in `context` (e.g. a function) makes `structuredClone` throw DataCloneError
// *before* a stripper could run, so the strip must replace those references, not clone them.

export type StoredSnapshot = {
  runId: string;
  status: string;
  snapshot: unknown;
  reason?: string;
};

type ChildEntry = { snapshot?: { input?: unknown; [k: string]: unknown }; [k: string]: unknown };

type AnySnapshot = {
  context?: unknown;
  children?: Record<string, ChildEntry | undefined>;
  [k: string]: unknown;
};

/**
 * Rebuild a snapshot, applying `onContext` to `context` and `onChildInput` to every invoked
 * child's persisted input. Returns a new top-level structure (the source is never mutated); the
 * untouched JSON-shaped siblings are carried by reference. Used in both directions — on serialize
 * the callbacks strip live handles (yielding a JSON-safe value), on hydrate they re-inject them.
 */
function mapSnapshot(value: unknown, onContext: (ctx: any) => any, onChildInput: (input: any) => any): unknown {
  if (!value || typeof value !== "object") return value;
  const src = value as AnySnapshot;
  const out: AnySnapshot = { ...src };

  if ("context" in src) {
    out.context = onContext(src.context);
  }

  const children = src.children;
  if (children && typeof children === "object") {
    const nextChildren: Record<string, ChildEntry | undefined> = {};
    for (const id of Object.keys(children)) {
      const child = children[id];
      const childSnapshot = child?.snapshot;
      if (child && childSnapshot && typeof childSnapshot === "object" && "input" in childSnapshot) {
        nextChildren[id] = {
          ...child,
          snapshot: { ...childSnapshot, input: onChildInput(childSnapshot.input) },
        };
      } else {
        nextChildren[id] = child;
      }
    }
    out.children = nextChildren;
  }

  return out;
}

/** Serialize a snapshot for persistence, stripping live context and child inputs. */
export function serializeSnapshot(
  snapshot: unknown,
  opts: { stripContext: (ctx: any) => any; stripChildInput: (input: any) => any },
): unknown {
  return mapSnapshot(snapshot, opts.stripContext, opts.stripChildInput);
}

/** Rebuild a runnable snapshot from stored form, re-injecting live context and child inputs. */
export function hydrateSnapshot(
  stored: unknown,
  opts: { injectContext: (ctx: any) => any; rewriteChildInput: (input: any) => any },
): unknown {
  return mapSnapshot(stored, opts.injectContext, opts.rewriteChildInput);
}

/** A persisted `agentRun` child input: the durable handle is `instanceId`, the Harness is
 * `endpoint` — both strings by construction (machine children carry neither at top level). */
function isAgentRunInput(input: unknown): input is { instanceId: string; endpoint: string } {
  return (
    !!input &&
    typeof input === "object" &&
    typeof (input as { instanceId?: unknown }).instanceId === "string" &&
    typeof (input as { endpoint?: unknown }).endpoint === "string"
  );
}

/** Read a machine context's `offsets` map (the durable re-attach handles), if it keeps one. */
function offsetsIn(context: unknown): Record<string, string> | undefined {
  const offsets = (context as { offsets?: unknown } | null | undefined)?.offsets;
  return offsets && typeof offsets === "object" ? (offsets as Record<string, string>) : undefined;
}

/**
 * Rewrite every persisted `agentRun` child input in a snapshot TREE so restore re-attaches
 * (drop `prompt`, set `attachOffset`) instead of re-prompting — at any nesting depth (GAP(5)):
 * bodies own their durable handles, so each machine level's `context.offsets` scopes the
 * rewrites of the children BELOW it (an inner map extends and shadows the outer one — nearest
 * enclosing wins). An instanceId with no recorded offset re-attaches from the stream start
 * (`attachOffset` undefined would re-prompt, so those keep re-attach semantics only when an
 * offset exists; a run that never advanced simply re-admits its prompt — first-turn at-most-once
 * is the same ADR-0007 edge as before).
 */
export function reattachAgentRuns(snapshot: unknown): unknown {
  const walk = (node: unknown, scope: Record<string, string>): unknown => {
    if (!node || typeof node !== "object") return node;
    const src = node as AnySnapshot & { input?: unknown };
    const out: typeof src = { ...src };

    // This node's own input was invoked by its PARENT — the caller's `scope` governs it.
    const offset = isAgentRunInput(src.input) ? scope[src.input.instanceId] : undefined;
    if (isAgentRunInput(src.input) && offset !== undefined) {
      out.input = { ...src.input, prompt: undefined, attachOffset: offset };
    }

    // This node's context scopes its children; deeper maps extend/shadow the inherited one.
    const own = offsetsIn(src.context);
    const childScope = own ? { ...scope, ...own } : scope;
    const children = src.children;
    if (children && typeof children === "object") {
      const nextChildren: Record<string, ChildEntry | undefined> = {};
      for (const id of Object.keys(children)) {
        const child = children[id];
        nextChildren[id] =
          child && child.snapshot
            ? { ...child, snapshot: walk(child.snapshot, childScope) as ChildEntry["snapshot"] }
            : child;
      }
      out.children = nextChildren;
    }
    return out;
  };
  return walk(snapshot, {});
}
