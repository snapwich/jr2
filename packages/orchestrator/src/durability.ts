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
