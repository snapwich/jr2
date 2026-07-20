// What the page BELIEVES, kept apart from what it has painted (main.js's `shown`/`queue`).
//
// A pure reducer over the workflow feed's frames (ADR-0022) — no DOM, no fetch, no module state —
// so the interesting cases are testable under `node:test` with no jsdom and no build step. The
// renderer downstream is already a pure function of (doc, status); this is the other half.
//
// The feed is LEVEL-TRIGGERED: every `status` carries a whole observation and `runs` carries the
// whole live set, so nothing here merges patches or replays a log. Re-delivery of any frame is
// idempotent by construction, which is the entire reconnect story — there is no cursor to resume
// from and no gap to detect.

/** How many finished runs stay on the page. Enough to see what just happened, bounded so a page
 *  left open for a week does not grow without end. */
export const SETTLED_CAP = 20;

/** How many emits stay in the log, for the same reason. */
export const EMIT_CAP = 200;

/**
 * `runs`     live runs by id — replaced wholesale by a `runs` frame, updated per-run by `status`.
 * `settled`  runs THIS page watched leave. The client's own memory: the server does not keep a
 *            history for it (that would be a read-through, which stays behind the Instance token),
 *            so a hard reload starts empty and that is correct, not a bug.
 * `emits`    newest-first, across all runs — each tagged with the run it came from.
 * `connection` the socket's state, owned by the page, never by a frame.
 */
export function emptyStore() {
  return { runs: new Map(), settled: new Map(), emits: [], selectedRunId: null, connection: "connecting" };
}

/** Fold one frame into the store, returning a new one. Unknown frame kinds are ignored, so a server
 *  that learns a new frame type does not break a page still running yesterday's script. */
export function applyFrame(store, frame) {
  switch (frame.kind) {
    case "runs":
      // The server's whole truth about what is live. Runs that ended during a disconnect are simply
      // ABSENT — no `gone` was delivered for them and none is needed; they were never ours to settle.
      return select({ ...store, runs: new Map(frame.runs.map((r) => [r.runId, r])) });

    case "status":
      return select({ ...store, runs: new Map(store.runs).set(frame.status.runId, frame.status) });

    case "gone": {
      // `gone` is its own fact, not an inference from a terminal status: a run can leave the live
      // set without one (`j2 stop`). A run we never saw live is a no-op — it began and ended inside
      // a reconnect window, which is ordinary.
      const departing = store.runs.get(frame.runId);
      if (!departing) return store;
      const runs = new Map(store.runs);
      runs.delete(frame.runId);
      const settled = new Map(store.settled).set(frame.runId, departing);
      while (settled.size > SETTLED_CAP) settled.delete(settled.keys().next().value);
      return select({ ...store, runs, settled });
    }

    case "emit":
      return { ...store, emits: [{ runId: frame.runId, type: frame.type }, ...store.emits].slice(0, EMIT_CAP) };

    default:
      return store;
  }
}

/**
 * Keep a selection pointed at a run the page can still say something about.
 *
 * This is the actual fix for the page that was opened before any run existed: with no push channel
 * there was nothing to select and nothing to re-check, so the diagram stayed blank until a reload.
 * A settled run still counts as selectable — a reader watching a run to its end keeps watching it.
 */
function select(store) {
  if (store.selectedRunId && (store.runs.has(store.selectedRunId) || store.settled.has(store.selectedRunId))) {
    return store;
  }
  const next = store.runs.keys().next();
  return { ...store, selectedRunId: next.done ? null : next.value };
}

/** The run the page is currently showing, live or settled — whichever half still holds it. */
export function selectedRun(store) {
  return store.runs.get(store.selectedRunId) ?? store.settled.get(store.selectedRunId) ?? null;
}

/** The run list as the sidebar draws it: live runs first, then what we watched leave (newest first).
 *  One ordered list keeps the renderer from having to know there are two maps behind it. */
export function runList(store) {
  return [
    ...[...store.runs.values()].map((run) => ({ run, settled: false })),
    ...[...store.settled.values()].reverse().map((run) => ({ run, settled: true })),
  ];
}
