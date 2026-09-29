// The one watch (ADR-0063): every Sandbox of this Instance, held in memory and pushed to whoever
// subscribes to a name. It replaces every poll the Orchestrator made — the provision's Ready wait,
// the fetch ask's wait on its landing (ADR-0053), and Continuity (ADR-0021) — and the first list
// after start IS the restore reconcile (ADR-0012).
//
// The loop is list → watch → watch → … and it is honest about what it does not know:
//
//   - list: the cache becomes the list, and every name whose object changed (or went) is told.
//   - watch from the last resourceVersion, with bookmarks and `timeoutSeconds=240`. EVERY
//     bookmark's resourceVersion is kept, so a resume after a quiet period starts from a recent
//     point rather than one the API server may have compacted away.
//   - the server closes the watch → resume from the last resourceVersion. So does
//     `UND_ERR_BODY_TIMEOUT`: fetch's 300s body timeout is a quiet stream, not a failure.
//   - ANY `ERROR` event → re-list. A resume that is too old arrives as `ERROR` with code 410
//     INSIDE an HTTP 200; no other ERROR leaves the resourceVersion usable either.
//   - anything else (the API server unreachable, a refused request) → back off, then resume.
//
// A subscriber hears only what the cluster said: a Sandbox that is there, or one a list or a
// DELETED event says is gone. A dropped watch says nothing, so it tells nobody anything — unknown
// is never loss (ADR-0021).

import { SANDBOXES, KubeError, type KubeClient, type KubeObject } from "./kube-client.ts";

/** A Sandbox CR as the Orchestrator reads it — the fields its ports use. */
export type SandboxObject = KubeObject & {
  spec?: {
    repos?: Array<{ key?: string; url?: string }>;
    /** The Harness container's share of the Size (ADR-0060): what a memory kill hit. */
    resources?: { limits?: { memory?: string; cpu?: string } };
  };
  status?: SandboxStatus;
};

/** The status the operator publishes (ADR-0001, ADR-0063) — pod facts included, so the
 * Orchestrator never reads a Pod. */
export type SandboxStatus = {
  phase?: string;
  endpoint?: string;
  podUID?: string;
  conditions?: Condition[];
  /** Per Repo key, what the node cache did about the latest ask (ADR-0053). */
  repos?: SandboxRepoStatus[];
  /** The Harness container's restarts and last end on the current pod (ADR-0061, ADR-0063). */
  harness?: {
    restartCount?: number;
    lastTerminated?: { reason?: string; exitCode?: number; finishedAt?: string };
  };
  /** Every waiting container of the current pod, init containers first, in the kubelet's words
   * (ADR-0063) — the only evidence of a container that never starts. */
  waiting?: ContainerWaiting[];
};

/** One waiting container, as the operator copies it off the pod. */
export type ContainerWaiting = { container: string; reason?: string; message?: string };

/** One entry of a Sandbox CR's `status.conditions`, as the operator writes it. */
export type Condition = { type: string; status: string; reason?: string; message?: string };

/** The operator's standing per-key Repo entry on a Sandbox (ADR-0053). */
export type SandboxRepoStatus = {
  key: string;
  asked?: string;
  fetched?: string;
  attempted?: string;
  error?: string;
};

/** What a subscriber is handed: the Sandbox as the cluster now says it is, or `undefined` for
 * one the cluster says is gone. */
export type SandboxListener = (sandbox: SandboxObject | undefined) => void;

export interface SandboxWatch {
  /** Resolves once the first list has landed — before it, the cache knows nothing. */
  synced(): Promise<void>;
  /** The Sandbox as last seen, or `undefined` for none. Meaningful only once synced. */
  get(name: string): SandboxObject | undefined;
  /** Hear every change to one name. Once synced, the listener is called at once with what the
   * cache holds (on a later tick), then on every event and every re-list that changes it. */
  subscribe(name: string, listener: SandboxListener): () => void;
  /** End the loop. */
  stop(): void;
}

/** The ask a watch makes (ADR-0063): the API server closes it well inside fetch's 300s body
 * timeout. */
export const WATCH_TIMEOUT_SECONDS = 240;

export type SandboxWatchOptions = {
  namespace: string;
  /** This Instance's Sandboxes. Default: every CR this Orchestrator provisions carries `jr2.dev/run`;
   * the namespace is the Instance's own (ADR-0019), so no Instance label is needed to tell them apart. */
  labelSelector?: string;
  /** Back-off after a failed list or watch request: doubling from this, capped at 30s. Default 500ms. */
  backoffMs?: number;
  /** Where a failure line goes. Default `console.warn`. */
  log?: (line: string) => void;
};

/** Start the loop. It runs until `stop()`; nothing it meets ends it. */
export function watchSandboxes(client: KubeClient, opts: SandboxWatchOptions): SandboxWatch {
  const labelSelector = opts.labelSelector ?? "jr2.dev/run";
  const backoffFloor = opts.backoffMs ?? 500;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const cache = new Map<string, SandboxObject>();
  const listeners = new Map<string, Set<SandboxListener>>();
  const controller = new AbortController();
  let isSynced = false;
  let onSynced!: () => void;
  const syncedP = new Promise<void>((resolve) => (onSynced = resolve));

  const tell = (name: string) => {
    const object = cache.get(name);
    for (const l of [...(listeners.get(name) ?? [])]) {
      try {
        l(object);
      } catch (err) {
        log(`jr2: a Sandbox listener for "${name}" threw: ${(err as Error).message}`);
      }
    }
  };

  /** The cache becomes the list. Told: every name whose object changed or went — and, on the
   * FIRST list, every name anyone is waiting on, present or not: that is the reconcile. */
  const replace = (items: SandboxObject[]) => {
    const before = new Map(cache);
    cache.clear();
    for (const item of items) {
      const name = item.metadata?.name;
      if (name) cache.set(name, item);
    }
    const first = !isSynced;
    isSynced = true;
    const names = new Set([...before.keys(), ...cache.keys(), ...(first ? listeners.keys() : [])]);
    for (const name of names) {
      const was = before.get(name)?.metadata?.resourceVersion;
      const now = cache.get(name)?.metadata?.resourceVersion;
      if (first || was !== now) tell(name);
    }
    if (first) onSynced();
  };

  const loop = async () => {
    let rv: string | undefined;
    let backoff = backoffFloor;
    while (!controller.signal.aborted) {
      try {
        if (rv === undefined) {
          const list = await client.list<SandboxObject>(SANDBOXES, opts.namespace, { labelSelector });
          replace(list.items);
          rv = list.resourceVersion;
        }
        const events = client.watch<SandboxObject>(SANDBOXES, opts.namespace, {
          resourceVersion: rv,
          labelSelector,
          timeoutSeconds: WATCH_TIMEOUT_SECONDS,
          signal: controller.signal,
        });
        let heard = false;
        for await (const event of events) {
          if (event.type === "ERROR") {
            // 410 Gone (too old) or anything else: this resourceVersion cannot be trusted.
            rv = undefined;
            break;
          }
          heard = true;
          backoff = backoffFloor; // the stream is healthy
          const object = event.object;
          const next = object.metadata?.resourceVersion;
          if (next) rv = next;
          if (event.type === "BOOKMARK") continue;
          const name = object.metadata?.name;
          if (!name) continue;
          if (event.type === "DELETED") cache.delete(name);
          else cache.set(name, object);
          tell(name);
        }
        // The server closed the watch (its timeout, or after an ERROR): resume at once — unless it
        // said nothing but an ERROR, or nothing at all, which a healthy server does not do twice:
        // a beat keeps a misbehaving one from being asked in a hot loop.
        if (!heard) await sleep(backoffFloor, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) return;
        // fetch's body timeout: the stream was quiet for 300s. A resume, not a failure.
        if (isBodyTimeout(err)) continue;
        // A 410 on the request itself (not inside the stream) is the same verdict as the event.
        if (err instanceof KubeError && err.status === 410) rv = undefined;
        log(`jr2: the Sandbox watch failed, retrying in ${backoff}ms: ${(err as Error).message}`);
        await sleep(backoff, controller.signal);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  };
  void loop();

  return {
    synced: () => syncedP,
    get: (name) => cache.get(name),
    subscribe(name, listener) {
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(listener);
      // Already synced: what the cache holds now is this subscriber's first answer. Later, so a
      // caller can finish wiring before it hears anything.
      if (isSynced) {
        queueMicrotask(() => {
          if (listeners.get(name)?.has(listener)) listener(cache.get(name));
        });
      }
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(name) === set) listeners.delete(name);
      };
    },
    stop: () => controller.abort(),
  };
}

/** Undici's code for a body that sent nothing for its `bodyTimeout` — on the error or its cause. */
function isBodyTimeout(err: unknown): boolean {
  const code = (e: unknown) => (e as { code?: unknown } | null)?.code;
  return (
    code(err) === "UND_ERR_BODY_TIMEOUT" || code((err as { cause?: unknown } | null)?.cause) === "UND_ERR_BODY_TIMEOUT"
  );
}

/** Wait `ms`, or less if the loop stops. The abort listener goes when the timer fires: the loop's
 * signal lives as long as the process, and one listener per back-off would pile up on it. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
