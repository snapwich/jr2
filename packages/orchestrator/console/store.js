// What the page BELIEVES, kept apart from what it has painted (main.js's `shown`/`queue`).
//
// A pure reducer over everything the Console hears — the selected workflow's feed frames
// (ADR-0022), fleet snapshots, gate re-fetches (ADR-0032), the token's state, the reader's own
// selections — no DOM, no fetch, no module state — so the interesting cases are testable under
// `node:test` with no jsdom and no build step. The renderer downstream is already a pure function
// of (doc, status); this is the other half.
//
// The feed is LEVEL-TRIGGERED: every `status` carries a whole observation and `runs` carries the
// whole live set, so nothing here merges patches or replays a log. Re-delivery of any frame is
// idempotent by construction, which is the entire reconnect story — there is no cursor to resume
// from and no gap to detect. The gate inbox rides the same idiom one band up: every `gates` frame
// is a whole re-fetch of one run's open gates, so an emptied card is a fact the server stated,
// never bookkeeping this side did after a delivery (ADR-0032).

/** How many finished runs stay on the page. Enough to see what just happened, bounded so a page
 *  left open for a week does not grow without end. */
export const SETTLED_CAP = 20;

/** How many emits stay in the log, for the same reason. */
export const EMIT_CAP = 200;

/**
 * `runs`     the SELECTED workflow's live runs by id — replaced wholesale by a `runs` frame,
 *            updated per-run by `status`. Only the selection holds a feed; everything else is
 *            `fleet`.
 * `settled`  runs THIS page watched leave. The client's own memory: the server does not keep a
 *            history for it (that would be a read-through, which stays behind the Instance token),
 *            so a hard reload starts empty and that is correct, not a bug.
 * `emits`    newest-first, across the selected workflow's runs — each tagged with its run.
 * `connection` the socket's state, owned by the page, never by a frame off the wire.
 * `workflow` the selection the ADDRESS carries (`/workflows/:name`); null at `/`.
 * `workflows` the registered names (`GET /workflows`) — what the fleet rail lists.
 * `fleet`    REST snapshots per workflow (`GET /workflows/:name/runs`), for the workflows that do
 *            NOT hold the feed. Never more than one EventSource — the rest of the fleet is polled.
 * `expanded` which workflows the rail shows runs for (the reader's folding, plus auto-expand on
 *            select).
 * `token`    the credential's STATE, never its value — the secret stays in sessionStorage
 *            (ADR-0032), outside anything a test would snapshot. "none" | "checking" | "live" |
 *            "invalid". Anything but "live" means observer mode.
 * `gates`    the gate inbox: runId -> { workflow, gates } from `GET /runs/:id` re-fetches. Guarded
 *            data (Instance band), so it cannot outlive the credential that read it.
 * `inboxAll` the widen control: false = the inbox follows the selection, true = every workflow.
 * `startFormFor` which workflow's start-run form is open, if any.
 * `selectedNodeId` the diagram node the reader clicked — an elk node id (scope + state id), one at
 *            a time, outline only (the click is RESERVED — selection is the whole behavior for
 *            now). Diagram-scoped, so a `select` navigation clears it; a run switch does not need
 *            to — an id minted under another run's instance scopes simply matches no box, and the
 *            root-scope ids stay valid across runs, which is exactly the selection worth keeping.
 */
export function emptyStore() {
  return {
    runs: new Map(),
    settled: new Map(),
    emits: [],
    selectedRunId: null,
    selectedNodeId: null,
    connection: "connecting",
    workflow: null,
    workflows: [],
    fleet: new Map(),
    expanded: new Set(),
    token: "none",
    gates: new Map(),
    inboxAll: false,
    startFormFor: null,
  };
}

/** Fold one frame into the store, returning a new one. Unknown frame kinds are ignored, so a server
 *  that learns a new frame type does not break a page still running yesterday's script. */
export function applyFrame(store, frame) {
  switch (frame.kind) {
    case "runs":
      // The server's whole truth about what is live. Runs that ended during a disconnect are simply
      // ABSENT — no `gone` was delivered for them and none is needed; they were never ours to settle.
      // The same wholeness settles the inbox: a selected-workflow run the frame does not mention can
      // never be re-fetched again, so its card leaves with it.
      return select({
        ...store,
        runs: new Map(frame.runs.map((r) => [r.runId, r])),
        gates: dropAbsent(store.gates, store.workflow, new Set(frame.runs.map((r) => r.runId))),
      });

    case "status":
      return select({ ...store, runs: new Map(store.runs).set(frame.status.runId, frame.status) });

    case "gone": {
      // `gone` is its own fact, not an inference from a terminal status: a run can leave the live
      // set without one (`j2 stop`). A run we never saw live is a no-op — it began and ended inside
      // a reconnect window, which is ordinary. Its inbox card goes either way: a gate exists exactly
      // while its invoking state is entered (ADR-0011), and this run has no entered states left.
      const gates = mapWithout(store.gates, frame.runId);
      const departing = store.runs.get(frame.runId);
      if (!departing) return store.gates === gates ? store : { ...store, gates };
      const runs = new Map(store.runs);
      runs.delete(frame.runId);
      const settled = new Map(store.settled).set(frame.runId, departing);
      while (settled.size > SETTLED_CAP) settled.delete(settled.keys().next().value);
      return select({ ...store, runs, settled, gates });
    }

    case "emit":
      return { ...store, emits: [{ runId: frame.runId, type: frame.type }, ...store.emits].slice(0, EMIT_CAP) };

    case "connection":
      return { ...store, connection: frame.state };

    case "workflows":
      return { ...store, workflows: frame.workflows };

    case "select": {
      // The address moved. The feed's state belongs to the OLD selection — the new feed's opening
      // `runs` frame is a whole set, so starting empty is convergent, not lossy. The inbox and the
      // fleet are global and stay; the selection auto-expands in the rail (clicking a name into the
      // breadcrumb and still having to unfold it would be two gestures for one intent).
      if (frame.workflow === store.workflow) return store;
      const expanded = new Set(store.expanded);
      if (frame.workflow) expanded.add(frame.workflow);
      return {
        ...store,
        workflow: frame.workflow,
        expanded,
        runs: new Map(),
        settled: new Map(),
        emits: [],
        selectedRunId: null,
        selectedNodeId: null,
        connection: "connecting",
      };
    }

    case "selectRun":
      // Unvalidated on purpose: a card click can select a run the new feed has not delivered yet.
      // The next frame's `select()` sweep keeps it if the run is real and moves on if it is not.
      return { ...store, selectedRunId: frame.runId };

    case "selectNode":
      // A second click on the selected node deselects — with no other click behavior yet, the
      // outline would otherwise be unremovable short of selecting something else.
      return { ...store, selectedNodeId: frame.nodeId === store.selectedNodeId ? null : frame.nodeId };

    case "fleet": {
      // One unselected workflow's REST snapshot — the same wholeness contract as a `runs` frame,
      // so it settles that workflow's inbox cards the same way (a run the snapshot does not carry
      // will never be re-fetched again).
      const fleet = new Map(store.fleet).set(frame.workflow, frame.runs);
      const gates = dropAbsent(store.gates, frame.workflow, new Set(frame.runs.map((r) => r.runId)));
      return { ...store, fleet, gates };
    }

    case "toggleWorkflow": {
      const expanded = new Set(store.expanded);
      expanded.has(frame.workflow) ? expanded.delete(frame.workflow) : expanded.add(frame.workflow);
      return { ...store, expanded };
    }

    case "token":
      // Guarded data cannot outlive the credential that read it: leaving "live" for "none" or
      // "invalid" (the any-later-401 drop of ADR-0032) empties the inbox. "checking" keeps it — a
      // re-validation of a token that turns out fine should not flash the inbox empty.
      if (frame.state === "none" || frame.state === "invalid") {
        return { ...store, token: frame.state, gates: new Map() };
      }
      return { ...store, token: frame.state };

    case "gates": {
      // A whole re-fetch of one run's open gates (`GET /runs/:id` on a frame — ADR-0032). Empty
      // means the card LEAVES: that is how a delivery's success shows, and the only way it does.
      // No credential, no inbox: a re-fetch that was in flight when the token dropped must not
      // repopulate the map the `token` frame just emptied (invisible while locked, but it would
      // surface intact on the next unlock — guarded data outliving the credential that read it).
      if (store.token !== "live") return store;
      if (!frame.gates.length) return { ...store, gates: mapWithout(store.gates, frame.runId) };
      const gates = new Map(store.gates);
      gates.set(frame.runId, { workflow: frame.workflow, gates: frame.gates });
      return { ...store, gates };
    }

    case "inboxScope":
      return { ...store, inboxAll: frame.all };

    case "startForm":
      return { ...store, startFormFor: frame.workflow };

    default:
      return store;
  }
}

/** A copy of `map` without `key` — or `map` itself when the key was never there, so a caller can
 *  cheaply tell "nothing changed". */
function mapWithout(map, key) {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

/** Drop `workflow`'s inbox entries for runs a whole-set frame did not mention. Those runs will
 *  never be re-fetched again (frames and snapshots are per-run triggers), so a card kept here would
 *  be stale forever — this is the level-triggered idiom applied to the inbox, not bookkeeping. */
function dropAbsent(gates, workflow, present) {
  if (!workflow) return gates;
  let next = gates;
  for (const [runId, entry] of gates) {
    if (entry.workflow !== workflow || present.has(runId)) continue;
    if (next === gates) next = new Map(gates);
    next.delete(runId);
  }
  return next;
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

/** The selected workflow's run list as the rail draws it: live runs first, then what we watched
 *  leave (newest first). One ordered list keeps the renderer from having to know there are two
 *  maps behind it. */
export function runList(store) {
  return [
    ...[...store.runs.values()].map((run) => ({ run, settled: false })),
    ...[...store.settled.values()].reverse().map((run) => ({ run, settled: true })),
  ];
}

/** One workflow's rail rows: the feed's view for the selection, the REST snapshot for the rest.
 *  Same shape either way, so the painter draws a run row without knowing which side fed it. */
export function fleetRuns(store, workflow) {
  if (workflow === store.workflow) return runList(store);
  return (store.fleet.get(workflow) ?? []).map((run) => ({ run, settled: false }));
}

/** The inbox as the Attention tab draws it: every card, or the selection's slice. The inbox itself
 *  is GLOBAL (every workflow the fleet knows) — the filter is presentation, which is why it lives
 *  in a selector and not in `applyFrame`. */
export function visibleGates(store) {
  const all = [...store.gates.entries()].map(([runId, entry]) => ({ runId, ...entry }));
  if (store.inboxAll || !store.workflow) return all;
  return all.filter((entry) => entry.workflow === store.workflow);
}

/** The SELECTED run's open gates — what the diagram pins (`GateView.path` resolves each one to a
 *  node). A selector, not reducer state: the pins are a view over the global inbox, exactly like
 *  {@link visibleGates}, and derive from two facts the store already holds. */
export function selectedRunGates(store) {
  return store.gates.get(store.selectedRunId)?.gates ?? [];
}

/** What the nav badge counts: every open gate everywhere — attention is global even when the
 *  inbox view is filtered. */
export function gateCount(store) {
  let n = 0;
  for (const entry of store.gates.values()) n += entry.gates.length;
  return n;
}
