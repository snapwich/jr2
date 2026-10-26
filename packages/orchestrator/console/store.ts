// What the page BELIEVES, kept apart from what it has painted (canvas.ts's `shown`/`queue`).
//
// A pure reducer over everything the Console hears — the selected workflow's feed frames
// (ADR-0022), fleet snapshots, gate re-fetches (ADR-0032), the token's state, the reader's own
// selections — no DOM, no fetch, no module state — so the interesting cases are testable under
// `node:test` with no jsdom and no build step. The renderer downstream is already a pure function
// of (doc, status); this is the other half.
//
// One `.ts` read by both consumers (ADR-0034): the test suite through Node's type stripping, the
// browser through the server's erasure (`/assets/store.ts` in http.ts).
//
// The feed is LEVEL-TRIGGERED: every `status` carries a whole observation and `runs` carries the
// whole live set, so nothing here merges patches or replays a log. Re-delivery of any frame is
// idempotent by construction, which is the entire reconnect story — there is no cursor to resume
// from and no gap to detect. The gate inbox rides the same idiom one band up: every `gates` frame
// is a whole re-fetch of one run's open gates, so an emptied card is a fact the server stated,
// never bookkeeping this side did after a delivery (ADR-0032).

/** A run as the OPEN observation band reports it (ADR-0014): identity and where it is, nothing of
 *  what it is carrying. Mirrors `RunObservation` in run-host.ts. */
export type ObservedRun = {
  runId: string;
  workflow: string;
  status: string;
  value: unknown;
  children: Array<Record<string, unknown>>;
  /** The run binds at least one Chart (ADR-0070): its Machine is the Chart wrapper's with each bound
   *  Open body's Chart compiled in, served per run. Absent when it binds none. */
  bound?: true;
  /** The hashes of the Charts the run binds now, distinct and sorted. A run can bind a second Chart
   *  in its life, so these, with the run id, key its doc. Absent from an older Orchestrator. */
  chartHashes?: string[];
  /** The run that dispatched this one, the caller's slot, and this run's depth in the chain
   *  (ADR-0071). Routing, on the open band (ADR-0014): the page reads it off the observation it
   *  already holds, with no fetch and no token. `instance` is set for a foreign caller, opaque text.
   *  Absent for a run nobody dispatched, and from an Orchestrator older than ADR-0071. */
  dispatchedBy?: DispatchedByView;
  /** The runs this run's `dispatch` Effects started, oldest first, by slot (ADR-0071): the chain's
   *  other direction, the same routing on the same band. Absent when it started none. */
  dispatched?: Array<{ slot: string; run: string }>;
};

/** {@link ObservedRun.dispatchedBy} — mirrors `RunObservation.dispatchedBy` in run-host.ts. The
 *  idempotency key is not on the open band: it names the caller's ledger. */
export type DispatchedByView = { run: string; slot: string; depth: number; instance?: string };

/** Where a Workflow came from (ADR-0070): a Machine or a Chart file in the Assembly, or a runtime
 *  Chart put on the Instance. */
export type WorkflowOrigin = "machine" | "file" | "runtime";

/** One entry of `GET /workflows` (ADR-0070) — mirrors `WorkflowListing` in run-host.ts. A Chart
 *  wrapper's named Charts are inside its entry, not beside it. */
export type WorkflowListing = {
  name: string;
  origin: WorkflowOrigin;
  wrapper?: {
    body: string;
    oneShot: boolean;
    charts: Array<{ name: string; origin: "file" | "runtime"; unrunnable?: string }>;
  };
  unrunnable?: string;
};

/** One row of the fleet rail: a Workflow, or a named Chart indented under its Chart wrapper. */
export type FleetEntry = {
  name: string;
  origin: WorkflowOrigin;
  /** 0 for a Workflow, 1 for a Chart under its wrapper. */
  depth: 0 | 1;
  /** A Chart wrapper's Open body slot, and whether its door takes a Chart one-shot. */
  wrapper?: { body: string; oneShot: boolean };
  unrunnable?: string;
  /** A runtime Chart of the same name that this Chart file shadows (ADR-0070): one row per name,
   *  so the rail keys stay distinct; the shadowed Chart is unrunnable, and this says why. */
  shadows?: { origin: WorkflowOrigin; unrunnable?: string };
};

/** One open gate as `GET /runs/:id` reports it — mirrors `GateView` in run-host.ts. */
export type GateCard = {
  gate: string;
  path: string[];
  accepts: Array<{ name: string; description?: string; input: unknown }>;
  meta?: Record<string, unknown>;
};

/** One Workspace waiting for capacity as `GET /runs/:id` reports it (ADR-0064) — mirrors
 *  `RunWaiting` in run-host.ts. Guarded: `message` is the scheduler's or the quota's own words. */
export type WaitingLine = { child: string; on: "node" | "quota"; message: string; since: string };

/** One outstanding pick as `GET /runs/:id` reports it (ADR-0024) — mirrors `RunHeld` in
 *  run-host.ts. There is no default time bound on a held Turn: "held since" is how a human sees one.
 *  Guarded like the reason a Workspace waits: a pick names what an Agent did. */
export type HeldLine = { agent: string; pick: string; since: string };

/** The credential's state — never its value, which stays in sessionStorage (ADR-0032). */
export type TokenState = "none" | "checking" | "live" | "invalid";

/** One frame folded into the store: the workflow feed's wire frames (ADR-0022), plus the page's
 *  own facts — fleet snapshots, gate re-fetches, token state, the reader's selections (ADR-0032). */
export type Frame =
  | { kind: "runs"; runs: ObservedRun[] }
  | { kind: "status"; status: ObservedRun }
  | { kind: "gone"; runId: string }
  | { kind: "emit"; runId: string; type: string }
  | { kind: "connection"; state: Store["connection"] }
  | { kind: "workflows"; workflows: ReadonlyArray<WorkflowListing | string> }
  | { kind: "select"; workflow: string | null }
  | { kind: "selectRun"; runId: string | null }
  | { kind: "selectNode"; nodeId: string | null }
  | { kind: "fleet"; workflow: string; runs: ObservedRun[] }
  | { kind: "toggleWorkflow"; workflow: string }
  | { kind: "token"; state: TokenState }
  | { kind: "gates"; runId: string; workflow: string; gates: GateCard[] }
  | { kind: "waiting"; runId: string; workflow: string; waiting: WaitingLine[]; held?: HeldLine[] }
  | { kind: "failure"; runId: string; reason: string | null }
  | { kind: "inboxScope"; all: boolean }
  | { kind: "startForm"; workflow: string | null };

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
 * `workflows` every registered name (`GET /workflows`), Machines and named Charts alike — what the
 *            fleet polls and selects. A Chart's name is `<wrapper>/<name>` (ADR-0070).
 * `listing`  the same answer with its structure: each Workflow's origin, a Chart wrapper's Charts
 *            inside its entry — what the fleet rail draws ({@link fleetEntries}).
 * `fleet`    REST snapshots per workflow (`GET /workflows/:name/runs`), for the workflows that do
 *            NOT hold the feed. Never more than one EventSource — the rest of the fleet is polled.
 * `expanded` which workflows the rail shows runs for (the reader's folding, plus auto-expand on
 *            select).
 * `token`    the credential's STATE, never its value — the secret stays in sessionStorage
 *            (ADR-0032), outside anything a test would snapshot. "none" | "checking" | "live" |
 *            "invalid". Anything but "live" means observer mode.
 * `gates`    the gate inbox: runId -> { workflow, gates } from `GET /runs/:id` re-fetches. Guarded
 *            data (Instance band), so it cannot outlive the credential that read it.
 * `waiting`  why each run's Workspaces in `placing` wait (ADR-0064): runId -> { workflow, waiting },
 *            off the SAME `GET /runs/:id` re-fetch as `gates`, under the same rules — guarded, whole
 *            per run, gone with the credential. The open band sees `placing` lit and nothing more.
 * `failures` the reason of each run this page knows that ended `failed` (ADR-0073): runId -> reason,
 *            off the SAME `GET /runs/:id` re-fetch, under the same rules — guarded (the open band
 *            sees the `failed` status and its color, never the output), gone with the credential.
 *            A failed run is a settled run, so `gone` keeps it; it goes with the run when the run
 *            leaves both `runs` and `settled`.
 * `inboxAll` the widen control: false = the inbox follows the selection, true = every workflow.
 * `startFormFor` which workflow's start-run form is open, if any.
 * `selectedNodeId` the diagram node the reader clicked — an elk node id (scope + state id), one at
 *            a time, outline only (the click is RESERVED — selection is the whole behavior for
 *            now). Diagram-scoped, so a `select` navigation clears it; a run switch does not need
 *            to — an id minted under another run's instance scopes simply matches no box, and the
 *            root-scope ids stay valid across runs, which is exactly the selection worth keeping.
 */
export type Store = {
  runs: Map<string, ObservedRun>;
  settled: Map<string, ObservedRun>;
  emits: Array<{ runId: string; type: string }>;
  selectedRunId: string | null;
  selectedNodeId: string | null;
  connection: "connecting" | "live" | "retrying";
  workflow: string | null;
  workflows: string[];
  listing: WorkflowListing[];
  fleet: Map<string, ObservedRun[]>;
  expanded: Set<string>;
  token: TokenState;
  gates: Map<string, { workflow: string; gates: GateCard[] }>;
  waiting: Map<string, { workflow: string; waiting: WaitingLine[]; held: HeldLine[] }>;
  failures: Map<string, string>;
  inboxAll: boolean;
  startFormFor: string | null;
};

/** How many finished runs stay on the page. Enough to see what just happened, bounded so a page
 *  left open for a week does not grow without end. */
export const SETTLED_CAP = 20;

/** How many emits stay in the log, for the same reason. */
export const EMIT_CAP = 200;

/** The page before it has heard anything — every field documented on {@link Store}. */
export function emptyStore(): Store {
  return {
    runs: new Map(),
    settled: new Map(),
    emits: [],
    selectedRunId: null,
    selectedNodeId: null,
    connection: "connecting",
    workflow: null,
    workflows: [],
    listing: [],
    fleet: new Map(),
    expanded: new Set(),
    token: "none",
    gates: new Map(),
    waiting: new Map(),
    failures: new Map(),
    inboxAll: false,
    startFormFor: null,
  };
}

/** Fold one frame into the store, returning a new one. Unknown frame kinds are ignored, so a server
 *  that learns a new frame type does not break a page still running yesterday's script. */
export function applyFrame(store: Store, frame: Frame): Store {
  switch (frame.kind) {
    case "runs": {
      // The server's whole truth about what is live. Runs that ended during a disconnect are simply
      // ABSENT — no `gone` was delivered for them and none is needed; they were never ours to settle.
      // The same wholeness settles the inbox: a selected-workflow run the frame does not mention can
      // never be re-fetched again, so its card leaves with it. A failure stays while its run is live
      // or settled here.
      const runs = new Map(frame.runs.map((r): [string, ObservedRun] => [r.runId, r]));
      const orphans = [...store.failures.keys()].filter((id) => !runs.has(id) && !store.settled.has(id));
      let failures = store.failures;
      for (const id of orphans) failures = mapWithout(failures, id);
      return select({
        ...store,
        runs,
        gates: dropAbsent(store.gates, store.workflow, new Set(frame.runs.map((r) => r.runId))),
        waiting: dropAbsent(store.waiting, store.workflow, new Set(frame.runs.map((r) => r.runId))),
        failures,
      });
    }

    case "status":
      return select({ ...store, runs: new Map(store.runs).set(frame.status.runId, frame.status) });

    case "gone": {
      // `gone` is its own fact, not an inference from a terminal status: a run can leave the live
      // set without one (`jr2 stop`). A run we never saw live is a no-op — it began and ended inside
      // a reconnect window, which is ordinary. Its inbox card goes either way: a gate exists exactly
      // while its invoking state is entered (ADR-0011), and this run has no entered states left.
      const gates = mapWithout(store.gates, frame.runId);
      const waiting = mapWithout(store.waiting, frame.runId);
      const departing = store.runs.get(frame.runId);
      if (!departing) return store.gates === gates && store.waiting === waiting ? store : { ...store, gates, waiting };
      const runs = new Map(store.runs);
      runs.delete(frame.runId);
      const settled = new Map(store.settled).set(frame.runId, departing);
      let failures = store.failures;
      while (settled.size > SETTLED_CAP) {
        const evicted = settled.keys().next().value!;
        settled.delete(evicted);
        failures = mapWithout(failures, evicted);
      }
      return select({ ...store, runs, settled, gates, waiting, failures });
    }

    case "emit":
      return { ...store, emits: [{ runId: frame.runId, type: frame.type }, ...store.emits].slice(0, EMIT_CAP) };

    case "connection":
      return { ...store, connection: frame.state };

    case "workflows": {
      // Replaced wholesale. An Orchestrator older than ADR-0070 answers bare names: each reads as
      // a Machine, so the rail has one shape to draw.
      const listing = frame.workflows.map(
        (w): WorkflowListing => (typeof w === "string" ? { name: w, origin: "machine" } : w),
      );
      return { ...store, listing, workflows: fleetEntries(listing).map((e) => e.name) };
    }

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
        // Each failure belongs to a run of the old selection's `runs` or `settled`, which go.
        failures: new Map(),
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
      const present = new Set(frame.runs.map((r) => r.runId));
      const gates = dropAbsent(store.gates, frame.workflow, present);
      return { ...store, fleet, gates, waiting: dropAbsent(store.waiting, frame.workflow, present) };
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
        return { ...store, token: frame.state, gates: new Map(), waiting: new Map(), failures: new Map() };
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

    case "waiting": {
      // The same guarded re-fetch's other half (ADR-0064), folded the same way: whole per run, and
      // nothing folded without the credential that read it.
      // The run's outstanding picks (ADR-0024) ride the same frame: one re-fetch, one fold.
      if (store.token !== "live") return store;
      const held = frame.held ?? [];
      if (!frame.waiting.length && !held.length) {
        const waiting = mapWithout(store.waiting, frame.runId);
        return waiting === store.waiting ? store : { ...store, waiting };
      }
      const waiting = new Map(store.waiting).set(frame.runId, {
        workflow: frame.workflow,
        waiting: frame.waiting,
        held,
      });
      return { ...store, waiting };
    }

    case "failure": {
      // The same guarded re-fetch's third half (ADR-0073): the reason of a run that ended `failed`.
      // Nothing folded without the credential, and nothing for a run that the page does not hold:
      // the re-fetch can come back after a `select` moved on. `null` says the run did not fail.
      if (store.token !== "live") return store;
      if (frame.reason === null) {
        const failures = mapWithout(store.failures, frame.runId);
        return failures === store.failures ? store : { ...store, failures };
      }
      if (!store.runs.has(frame.runId) && !store.settled.has(frame.runId)) return store;
      if (store.failures.get(frame.runId) === frame.reason) return store;
      return { ...store, failures: new Map(store.failures).set(frame.runId, frame.reason) };
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
function mapWithout<K, V>(map: Map<K, V>, key: K): Map<K, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

/** Drop `workflow`'s guarded entries (inbox cards, waits) for runs a whole-set frame did not
 *  mention. Those runs will never be re-fetched again (frames and snapshots are per-run triggers),
 *  so an entry kept here would be stale forever — this is the level-triggered idiom applied to the
 *  guarded maps, not bookkeeping. */
function dropAbsent<V extends { workflow: string }>(
  entries: Map<string, V>,
  workflow: string | null,
  present: Set<string>,
): Map<string, V> {
  if (!workflow) return entries;
  let next = entries;
  for (const [runId, entry] of entries) {
    if (entry.workflow !== workflow || present.has(runId)) continue;
    if (next === entries) next = new Map(entries);
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
function select(store: Store): Store {
  if (store.selectedRunId && (store.runs.has(store.selectedRunId) || store.settled.has(store.selectedRunId))) {
    return store;
  }
  const next = store.runs.keys().next();
  return { ...store, selectedRunId: next.done ? null : next.value };
}

/** The run the page is currently showing, live or settled — whichever half still holds it. */
export function selectedRun(store: Store): ObservedRun | null {
  if (store.selectedRunId === null) return null;
  return store.runs.get(store.selectedRunId) ?? store.settled.get(store.selectedRunId) ?? null;
}

/** The selected workflow's run list as the rail draws it: live runs first, then what we watched
 *  leave (newest first). One ordered list keeps the renderer from having to know there are two
 *  maps behind it. */
export function runList(store: Store): Array<{ run: ObservedRun; settled: boolean }> {
  return [
    ...[...store.runs.values()].map((run) => ({ run, settled: false })),
    ...[...store.settled.values()].reverse().map((run) => ({ run, settled: true })),
  ];
}

/** One workflow's rail rows: the feed's view for the selection, the REST snapshot for the rest.
 *  Same shape either way, so the painter draws a run row without knowing which side fed it. */
export function fleetRuns(store: Store, workflow: string): Array<{ run: ObservedRun; settled: boolean }> {
  if (workflow === store.workflow) return runList(store);
  return (store.fleet.get(workflow) ?? []).map((run) => ({ run, settled: false }));
}

/**
 * The fleet rail's rows (ADR-0070): each Workflow in the listing's order, a Chart wrapper's named
 * Charts indented under it as `<wrapper>/<name>`. A Chart the listing also gives at the top level
 * is drawn once, under its wrapper; one whose wrapper the listing does not give stays at the top.
 */
export function fleetEntries(listing: readonly WorkflowListing[]): FleetEntry[] {
  const full = (wrapper: string, name: string): string => (name.includes("/") ? name : `${wrapper}/${name}`);
  const nested = new Set<string>();
  for (const w of listing) for (const c of w.wrapper?.charts ?? []) nested.add(full(w.name, c.name));
  const rows: FleetEntry[] = [];
  for (const w of listing) {
    if (w.origin !== "machine" && nested.has(w.name)) continue;
    rows.push({
      name: w.name,
      origin: w.origin,
      depth: 0,
      ...(w.wrapper ? { wrapper: { body: w.wrapper.body, oneShot: w.wrapper.oneShot } } : {}),
      ...(w.unrunnable ? { unrunnable: w.unrunnable } : {}),
    });
    for (const c of w.wrapper?.charts ?? []) {
      const name = full(w.name, c.name);
      // A Chart file and a runtime Chart of one name: the listing gives both, the file wins
      // (ADR-0070). One row per name, the shadowed Chart a note on it, so no two rows share a key.
      const twin = rows.find((r) => r.depth === 1 && r.name === name);
      if (twin) {
        const fileFirst = twin.origin === "file" || c.origin !== "file";
        const shadowed = fileFirst ? c : { origin: twin.origin, unrunnable: twin.unrunnable };
        if (!fileFirst) {
          twin.origin = c.origin;
          if (c.unrunnable) twin.unrunnable = c.unrunnable;
          else delete twin.unrunnable;
        }
        twin.shadows = { origin: shadowed.origin, ...(shadowed.unrunnable ? { unrunnable: shadowed.unrunnable } : {}) };
        continue;
      }
      rows.push({
        name,
        origin: c.origin,
        depth: 1,
        ...(c.unrunnable ? { unrunnable: c.unrunnable } : {}),
      });
    }
  }
  return rows;
}

/**
 * Which Machine doc the center pane draws (ADR-0070), as a cache key and the route that serves it.
 * A run that binds a Chart draws its own Machine, the Chart compiled into the Open body, so its doc
 * is per run id; every other selection draws the Workflow's Machine, shared by all its runs. The
 * Workflow name rides the route as one encoded segment (`<wrapper>%2F<name>` for a named Chart).
 */
export function machineDocSource(
  workflow: string,
  run: Pick<ObservedRun, "runId" | "bound" | "chartHashes"> | null,
): { key: string; path: string } {
  const base = `/workflows/${encodeURIComponent(workflow)}`;
  if (run?.bound === true) {
    // The run id and the Charts it binds now: a second Chart in the run's life is a new doc.
    const charts = run.chartHashes?.length ? `:${run.chartHashes.join(",")}` : "";
    return { key: `run:${run.runId}${charts}`, path: `${base}/runs/${encodeURIComponent(run.runId)}/machine` };
  }
  return { key: `workflow:${workflow}`, path: `${base}/machine` };
}

/** The fleet row's badge for a dispatched run (ADR-0071): `↳ <run8>`, the caller's run id cut as
 *  the row cuts its own. Null for a run nobody dispatched. */
export function dispatchBadge(run: ObservedRun): string | null {
  const by = run.dispatchedBy;
  return by ? `↳ ${by.run.slice(0, 8)}` : null;
}

/** The Machine pane's strip for a dispatched run (ADR-0071): `dispatched by <run8> · <slot> ·
 *  depth n`, and `· from Orchestrator <name>` when the caller is on another Orchestrator (its
 *  name as it sent it, never an Instance ID). Null for a run
 *  nobody dispatched. */
export function dispatchStrip(run: ObservedRun | null): string | null {
  const by = run?.dispatchedBy;
  if (!by) return null;
  const from = by.instance ? ` · from Orchestrator ${by.instance}` : "";
  return `dispatched by ${by.run.slice(0, 8)} · ${by.slot} · depth ${by.depth}${from}`;
}

/** The most runs the pane's `dispatched` strip names: a watcher dispatches on every pass. */
const DISPATCHED_SHOWN = 5;

/** The Machine pane's strip for a run that dispatched (ADR-0071): `dispatched <run8> (<slot>) · …`,
 *  newest last, the older ones counted. Null for a run that started none. */
export function dispatchedStrip(run: ObservedRun | null): string | null {
  const all = run?.dispatched ?? [];
  if (all.length === 0) return null;
  const shown = all.slice(-DISPATCHED_SHOWN);
  const older = all.length - shown.length;
  const named = shown.map((d) => `${d.run.slice(0, 8)} (${d.slot})`).join(" · ");
  return `dispatched ${older > 0 ? `${older} more · ` : ""}${named}`;
}

/** The inbox as the Attention tab draws it: every card, or the selection's slice. The inbox itself
 *  is GLOBAL (every workflow the fleet knows) — the filter is presentation, which is why it lives
 *  in a selector and not in `applyFrame`. */
export function visibleGates(store: Store): Array<{ runId: string; workflow: string; gates: GateCard[] }> {
  const all = [...store.gates.entries()].map(([runId, entry]) => ({ runId, ...entry }));
  if (store.inboxAll || !store.workflow) return all;
  return all.filter((entry) => entry.workflow === store.workflow);
}

/** The SELECTED run's open gates — what the diagram pins (`GateView.path` resolves each one to a
 *  node). A selector, not reducer state: the pins are a view over the global inbox, exactly like
 *  {@link visibleGates}, and derive from two facts the store already holds. */
export function selectedRunGates(store: Store): GateCard[] {
  if (store.selectedRunId === null) return [];
  return store.gates.get(store.selectedRunId)?.gates ?? [];
}

/** Why the SELECTED run's Workspaces wait for capacity (ADR-0064) — empty in observer mode, where
 *  the diagram still lights `placing` but the reason is not the page's to know. */
export function selectedRunWaiting(store: Store): WaitingLine[] {
  if (store.selectedRunId === null) return [];
  return store.waiting.get(store.selectedRunId)?.waiting ?? [];
}

/** The reason of a run that ended `failed`, off a `GET /runs/:id` answer (ADR-0073): the Failure's
 *  `reason` in the run's output. Null for every other status, and for an output with no reason
 *  text — the same reading as `jr2 status`'s `failed:` line. */
export function failureReason(body: { status?: string; output?: unknown }): string | null {
  if (body.status !== "failed") return null;
  const reason = (body.output as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === "string" ? reason : null;
}

/** Why the SELECTED run failed (ADR-0073): the reason of its Failure, or null when it did not fail
 *  or the page has no live token to read it with. */
export function selectedRunFailure(store: Store): string | null {
  if (store.selectedRunId === null) return null;
  return store.failures.get(store.selectedRunId) ?? null;
}

/** The SELECTED run's outstanding picks, each with since when it is held (ADR-0024) — empty in
 *  observer mode. */
export function selectedRunHeld(store: Store): HeldLine[] {
  if (store.selectedRunId === null) return [];
  return store.waiting.get(store.selectedRunId)?.held ?? [];
}

/** One party's seat on one state (ADR-0015): who may send which names there — mirrors
 *  `MachineSeat` in vocabulary.ts. */
export type Seat = { state: string; party: "agent" | "gate"; agent?: string; names: string[] };

/** The part of a Machine doc the seats are read from: each body's `seats` and `warnings`, and the
 *  child Machines below its states (canvas.ts's `MachineBodyDoc`, structurally). */
export type SeatedBody = {
  seats?: Seat[];
  warnings?: string[];
  root: SeatedState;
};
type SeatedState = { states: SeatedState[]; children: Array<{ machine?: SeatedBody }> };

/**
 * Who may send what, per state, and what the build found suspect (ADR-0015) — for the Machine and
 * every Machine it composes, in the order `jr2 up` prints them: the root's body, then each child
 * Machine's, depth-first in state order. A function of the doc, not of the store: the doc is
 * structure the server serves (app.ts's `MachineView`), and this is the one piece of it worth a
 * unit test outside the canvas.
 */
export function docSeats(doc: SeatedBody | null): { seats: Seat[]; warnings: string[] } {
  const seats: Seat[] = [];
  const warnings: string[] = [];
  const body = (b: SeatedBody): void => {
    seats.push(...(b.seats ?? []));
    warnings.push(...(b.warnings ?? []));
    state(b.root);
  };
  const state = (s: SeatedState): void => {
    for (const child of s.children) if (child.machine) body(child.machine);
    s.states.forEach(state);
  };
  if (doc) body(doc);
  return { seats, warnings };
}

/** What the nav badge counts: every open gate everywhere — attention is global even when the
 *  inbox view is filtered. */
export function gateCount(store: Store): number {
  let n = 0;
  for (const entry of store.gates.values()) n += entry.gates.length;
  return n;
}
