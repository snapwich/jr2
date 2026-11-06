// What the page BELIEVES, kept apart from what it has painted (canvas.ts's `shown`/`queue`).
//
// A pure reducer over everything the Console hears — the selected workflow's feed frames
// (ADR-0022), fleet snapshots, the Gate inbox (ADR-0032), the ended runs, the kept conversations,
// the token's state, the reader's own selections — no DOM, no fetch, no module state — so the interesting cases are testable under
// `node:test` with no jsdom and no build step. The renderer downstream is already a pure function
// of (doc, status); this is the other half.
//
// One `.ts` read by both consumers (ADR-0034): the test suite through Node's type stripping, the
// browser through the server's erasure (`/assets/store.ts` in http.ts).
//
// The feed is LEVEL-TRIGGERED: every `status` carries a whole observation and `runs` carries the
// whole live set, so nothing here merges patches or replays a log. Re-delivery of any frame is
// idempotent by construction, which is the entire reconnect story — there is no cursor to resume
// from and no gap to detect. The Gate inbox rides the same idiom one band up: every `inbox` frame
// is a whole read of `GET /gates`, every open Gate the Caller may answer, so an emptied card is a
// fact the server stated, never bookkeeping this side did after a delivery (ADR-0032).

import { mergeEntries, type AgentLine, type ConversationEntry, type ConversationRow } from "./conversation.ts";

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

/** One open gate as `GET /gates` reports it — mirrors `GateView` in run-host.ts, with the time it
 *  opened. */
export type GateCard = {
  gate: string;
  path: string[];
  accepts: Array<{ name: string; description?: string; input: unknown }>;
  acceptsNow?: string[];
  meta?: Record<string, unknown>;
  openedAt?: string;
  /** The Hook kinds that this Gate hears (ADR-0011). */
  hook?: string[];
};

/** One entry of `GET /gates` (ADR-0011): an open Gate that the Caller may answer, with its run —
 *  mirrors `GateInboxEntry` in run-host.ts. Never the run's context. */
export type InboxGate = GateCard & { runId: string; workflow: string };

/** One run of `GET /runs` (ADR-0009) — mirrors `RunSummary` in run-list.ts. The Console lists the
 *  ended ones of the selected Workflow under its live runs. */
export type RunSummaryView = {
  runId: string;
  workflow: string;
  status: string;
  /** Why a run is `drifted` or `lost`, a Failure's reason, or a fault (ADR-0030, ADR-0073). */
  reason?: string;
  startedAt?: string;
  endedAt?: string;
  /** The hash of the Assembly the run started under (ADR-0069). */
  assembly?: string;
  openGates?: number;
  dispatchedBy?: DispatchedByView;
  swept?: string;
};

/** One row of a Workflow's run list in the rail: a live run, a run that this page watched end, or
 *  an ended run that `GET /runs` lists. */
export type RailRun = {
  runId: string;
  status: string;
  /** The run is not live. */
  settled: boolean;
  reason?: string;
  dispatchedBy?: DispatchedByView;
};

/** One Workspace waiting for capacity as `GET /runs/:id` reports it (ADR-0064) — mirrors
 *  `RunWaiting` in run-host.ts. Guarded: `message` is the scheduler's or the quota's own words. */
export type WaitingLine = { child: string; on: "node" | "quota"; message: string; since: string };

/** One outstanding pick as `GET /runs/:id` reports it (ADR-0024) — mirrors `RunHeld` in
 *  run-host.ts. There is no default time bound on a held Turn: "outstanding since" is how a human
 *  sees one.
 *  Guarded like the reason a Workspace waits: a pick names what an Agent did. */
export type HeldLine = { agent: string; pick: string; since: string };

/** The credential's state — never its value, which stays in sessionStorage (ADR-0032). */
export type TokenState = "none" | "checking" | "live" | "invalid";

/** One scope of a Caller (ADR-0078): the five acts. Mirrors `Scope` in config.ts. */
export type ScopeName = "start" | "answer" | "cancel" | "read" | "steer";

/** The Workflows a scope opens: every one, or the named ones. Mirrors `ScopeGrant` in config.ts. */
export type ScopeGrant = "all" | readonly string[];

/** What the `answer` scope opens (ADR-0078): every Gate, or a list of Workflow names and of
 *  `{ workflow, gates }` items that name single Gates. Mirrors `AnswerGrant` in config.ts. */
export type AnswerGrant = "all" | ReadonlyArray<string | { workflow: string; gates: readonly string[] }>;

/** The page's Caller as `GET /whoami` gives it (ADR-0078) — mirrors `Caller` in tokens.ts. What it
 *  `may` do decides which controls render (ADR-0032); the server still checks each request. */
export type CallerView = {
  via: string;
  name: string;
  /** The name that jr2 shows, when it is not `name` (a JWT's `email`). */
  shown?: string;
  onBehalfOf?: string;
  may: Partial<Record<Exclude<ScopeName, "answer">, ScopeGrant>> & { answer?: AnswerGrant };
};

/** Who started a run, as `GET /runs/:id` gives it (ADR-0078) — mirrors `RunStarter` in callers.ts. */
export type StarterView =
  | { kind: "caller"; via: string; name: string; shown?: string; onBehalfOf?: string }
  | { kind: "run"; run: string; slot: string }
  | { kind: "jr2"; why: string };

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
  | { kind: "caller"; caller: CallerView }
  | { kind: "inbox"; gates: InboxGate[] }
  | { kind: "history"; workflow: string; runs: RunSummaryView[] }
  | { kind: "endedStatus"; status: ObservedRun }
  | { kind: "assembly"; current: string | null; held: Array<{ hash: string; runs: string[] }> }
  | { kind: "conversations"; runId: string; rows: ConversationRow[] }
  | { kind: "agents"; runId: string; agents: AgentLine[] }
  | { kind: "entries"; runId: string; instanceId: string; entries: ConversationEntry[] }
  | { kind: "conversationEnd"; runId: string; instanceId: string; cut: boolean; swept?: string }
  | { kind: "bottom"; open?: boolean; slot?: string | null }
  | { kind: "waiting"; runId: string; workflow: string; waiting: WaitingLine[]; held?: HeldLine[] }
  | { kind: "failure"; runId: string; reason: string | null }
  | { kind: "starter"; runId: string; startedBy: StarterView | null }
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
 * `gates`    the Gate inbox: runId -> { workflow, gates }, from `GET /gates` (ADR-0011), which lists
 *            only the Gates that the Caller may answer. Each read replaces it whole. Guarded data,
 *            so it cannot outlive the credential that read it.
 * `waiting`  why each run's Workspaces in `placing` wait (ADR-0064): runId -> { workflow, waiting },
 *            off a `GET /runs/:id` re-fetch, under the rules of `gates` — guarded, whole
 *            per run, gone with the credential. The open band sees `placing` lit and nothing more.
 * `failures` the reason of each run this page knows that ended `failed` (ADR-0073): runId -> reason,
 *            off the SAME `GET /runs/:id` re-fetch, under the same rules — guarded (the open band
 *            sees the `failed` status and its color, never the output), gone with the credential.
 *            A failed run is a settled run, so `gone` keeps it; it goes with the run when the run
 *            leaves both `runs` and `settled`.
 * `caller`   the page's Caller as `GET /whoami` answered it (ADR-0078): who the page acts as, and
 *            what it may do. Null without a live credential; gone with it. The token's VALUE is
 *            never here — this is what the server said the value is.
 * `starters` who started each run this page knows (ADR-0078): runId -> starter, off the SAME
 *            `GET /runs/:id` re-fetch as `failures`, under the same rules — guarded, gone with the
 *            credential, gone with the run.
 * `opened`   the last status of each ended run that the person opened from the rail and that this
 *            page did not watch end (`GET /runs/:id`, ADR-0032). Guarded (`read`): gone with the
 *            credential, with a change of Caller and with the selection. At most {@link SETTLED_CAP}.
 * `history`  the selected Workflow's ended runs, from `GET /runs?status=ended&workflow=` (ADR-0009):
 *            what the rail lists under the live runs. Needs `read`; guarded, gone with the
 *            credential and with the selection.
 * `assembly` the current Assembly's hash and the hash each live run holds (`GET /assembly`, open):
 *            what marks a run "older Assembly" (ADR-0069).
 * `talk`     the SELECTED run's kept conversations (ADR-0023): its rows, its Agent slots for
 *            Steering, and the entries read so far by Instance ID. Guarded, and gone with the
 *            credential or when the selection moves to another run.
 * `bottom`   the bottom drawer: open or closed, and the Agent slot it shows (null: the first).
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
  opened: Map<string, ObservedRun>;
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
  caller: CallerView | null;
  starters: Map<string, StarterView>;
  history: { workflow: string; runs: RunSummaryView[] } | null;
  assembly: { current: string | null; held: Map<string, string> };
  talk: Talk | null;
  bottom: { open: boolean; slot: string | null };
  inboxAll: boolean;
  startFormFor: string | null;
};

/** The selected run's kept conversations (see {@link Store}). `ended` holds each conversation whose
 *  stream ended, and whether it was cut or swept. */
export type Talk = {
  runId: string;
  rows: ConversationRow[];
  agents: AgentLine[];
  entries: Map<string, ConversationEntry[]>;
  ended: Map<string, { cut: boolean; swept?: string }>;
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
    opened: new Map(),
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
    caller: null,
    starters: new Map(),
    history: null,
    assembly: { current: null, held: new Map() },
    talk: null,
    bottom: { open: false, slot: null },
    inboxAll: false,
    startFormFor: null,
  };
}

/** Fold one frame into the store, returning a new one. Unknown frame kinds are ignored, so a server
 *  that learns a new frame type does not break a page still running yesterday's script. The kept
 *  conversations belong to the selected run: when a frame moves the selection to another run, they
 *  go. */
export function applyFrame(store: Store, frame: Frame): Store {
  const next = foldFrame(store, frame);
  if (next.talk && next.talk.runId !== next.selectedRunId) return { ...next, talk: null };
  return next;
}

function foldFrame(store: Store, frame: Frame): Store {
  switch (frame.kind) {
    case "runs": {
      // The server's whole truth about what is live. Runs that ended during a disconnect are simply
      // ABSENT — no `gone` was delivered for them and none is needed; they were never ours to settle.
      // The same wholeness settles the waits: a selected-workflow run the frame does not mention can
      // never be re-fetched again, so its waits leave with it. A failure stays while its run is
      // live, settled here or listed as ended.
      const runs = new Map(frame.runs.map((r): [string, ObservedRun] => [r.runId, r]));
      const orphan = (id: string): boolean => !runs.has(id) && !store.settled.has(id) && !inHistory(store, id);
      let failures = store.failures;
      for (const id of [...failures.keys()].filter(orphan)) failures = mapWithout(failures, id);
      let starters = store.starters;
      for (const id of [...starters.keys()].filter(orphan)) starters = mapWithout(starters, id);
      return select({
        ...store,
        runs,
        waiting: dropAbsent(store.waiting, store.workflow, new Set(frame.runs.map((r) => r.runId))),
        failures,
        starters,
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
      return select(settle({ ...store, runs, gates, waiting }, departing));
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
        opened: new Map(),
        emits: [],
        selectedRunId: null,
        selectedNodeId: null,
        connection: "connecting",
        // Each failure and starter belongs to a run of the old selection's `runs` or `settled`,
        // which go; so does its list of ended runs.
        failures: new Map(),
        starters: new Map(),
        history: null,
        bottom: { ...store.bottom, slot: null },
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
      // so it settles that workflow's waits the same way (a run the snapshot does not carry will
      // never be re-fetched again).
      const fleet = new Map(store.fleet).set(frame.workflow, frame.runs);
      const present = new Set(frame.runs.map((r) => r.runId));
      return { ...store, fleet, waiting: dropAbsent(store.waiting, frame.workflow, present) };
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
      // The Caller goes with it: a page with no credential acts as nobody. A selected run that only
      // the guarded listing named goes too.
      if (frame.state === "none" || frame.state === "invalid") {
        return select({
          ...store,
          token: frame.state,
          gates: new Map(),
          waiting: new Map(),
          failures: new Map(),
          caller: null,
          starters: new Map(),
          history: null,
          opened: new Map(),
          talk: null,
        });
      }
      return { ...store, token: frame.state };

    case "caller": {
      // What `GET /whoami` said the credential is (ADR-0078). It comes before the `token` frame
      // that makes the page live, so the first live render already knows which controls to show.
      // A card that the new Caller's `answer` does not open goes, as the `gates` fold would refuse it.
      const next = {
        ...store,
        caller: frame.caller,
        gates: keepWhere(store.gates, (entry) => grantOpens(frame.caller?.may.answer, entry.workflow)),
      };
      if (sameCaller(store.caller, frame.caller)) return next;
      // Another Caller: what the old one read does not belong to the new one (the page reads it
      // again for the new one when it goes live). The selection stays only where the page can
      // still say something about it.
      return select({
        ...next,
        waiting: new Map(),
        failures: new Map(),
        starters: new Map(),
        history: null,
        opened: new Map(),
        talk: null,
      });
    }

    case "inbox": {
      // A whole read of `GET /gates` (ADR-0011, ADR-0032): every open Gate that the Caller may
      // answer, oldest first. It replaces the inbox, so a card that is not in it LEAVES: that is
      // how a delivery's success shows, and the only way it does. No credential, no inbox: a read
      // that was in flight when the token dropped must not fill the map the `token` frame just
      // emptied (guarded data outliving the credential that read it).
      if (store.token !== "live") return store;
      const gates = new Map<string, { workflow: string; gates: GateCard[] }>();
      for (const { runId, workflow, ...card } of frame.gates) {
        // The server lists only what the Caller may answer; a card is a send form, so the page
        // checks the Workflow again and holds no form that would meet a 403 (ADR-0032).
        if (!may(store, "answer", workflow)) continue;
        const entry = gates.get(runId) ?? { workflow, gates: [] };
        entry.gates.push(card);
        gates.set(runId, entry);
      }
      return { ...store, gates };
    }

    case "history": {
      // The selected Workflow's ended runs (`GET /runs?status=ended`, ADR-0009): whole, newest
      // first. Guarded (`read`), and only for the Workflow the page still shows.
      if (store.token !== "live" || frame.workflow !== store.workflow || !may(store, "read", frame.workflow)) {
        return store;
      }
      const live = new Set(store.runs.keys());
      return select({
        ...store,
        history: { workflow: frame.workflow, runs: frame.runs.filter((r) => !live.has(r.runId)) },
      });
    }

    case "endedStatus": {
      // The last status of an ended run that the person opened from the rail (ADR-0032): read off
      // `GET /runs/:id`, held with the runs this page watched end, so the graph lights where the run
      // ended. Not for a live run (the feed speaks for it), and not for another Workflow's run.
      const status = frame.status;
      if (store.token !== "live" || store.runs.has(status.runId) || status.workflow !== store.workflow) return store;
      // A run this page watched end: its last status joins what the open feed said of it.
      if (store.settled.has(status.runId)) return select(settle(store, status));
      // A run only the guarded listing names: held apart, so it goes with the credential.
      if (!inHistory(store, status.runId) || !may(store, "read", status.workflow)) return store;
      const opened = new Map(store.opened);
      opened.delete(status.runId);
      opened.set(status.runId, status);
      while (opened.size > SETTLED_CAP) opened.delete(opened.keys().next().value!);
      return select({ ...store, opened });
    }

    case "assembly": {
      // Open structure (`GET /assembly`, ADR-0069): the current Assembly, and each live run's.
      const held = new Map<string, string>();
      for (const { hash, runs } of frame.held) for (const runId of runs) held.set(runId, hash);
      // `GET /assembly` names live runs only. A run that this page watched end keeps the hash it
      // held while it was live, so it stays drawn on its own Machine, with its mark.
      for (const runId of store.settled.keys()) {
        const was = store.assembly.held.get(runId);
        if (was !== undefined && !held.has(runId)) held.set(runId, was);
      }
      return { ...store, assembly: { current: frame.current, held } };
    }

    case "conversations": {
      // The selected run's kept conversations, whole (ADR-0023). Guarded (`read`), and only for
      // the run the page shows: a list that comes back after the selection moved is dropped.
      if (store.token !== "live" || frame.runId !== store.selectedRunId) return store;
      const talk = store.talk ?? emptyTalk(frame.runId);
      return { ...store, talk: { ...talk, rows: frame.rows } };
    }

    case "agents": {
      // The selected run's Agent slots as Steering sees them (ADR-0002): which ones may be steered.
      if (store.token !== "live" || frame.runId !== store.selectedRunId) return store;
      const talk = store.talk ?? emptyTalk(frame.runId);
      return { ...store, talk: { ...talk, agents: frame.agents } };
    }

    case "entries": {
      // Entries of one conversation, off a page or the stream: added in sequence order, each once.
      if (store.token !== "live" || frame.runId !== store.selectedRunId || !frame.entries.length) return store;
      const talk = store.talk ?? emptyTalk(frame.runId);
      const kept = talk.entries.get(frame.instanceId) ?? [];
      const merged = mergeEntries(kept, frame.entries);
      if (merged === kept) return store;
      return { ...store, talk: { ...talk, entries: new Map(talk.entries).set(frame.instanceId, merged) } };
    }

    case "conversationEnd": {
      // The stream of one conversation ended: its Turn closed, or it was cut or swept.
      if (store.token !== "live" || frame.runId !== store.selectedRunId) return store;
      const talk = store.talk ?? emptyTalk(frame.runId);
      const end = { cut: frame.cut, ...(frame.swept !== undefined ? { swept: frame.swept } : {}) };
      return { ...store, talk: { ...talk, ended: new Map(talk.ended).set(frame.instanceId, end) } };
    }

    case "bottom":
      return {
        ...store,
        bottom: {
          open: frame.open ?? store.bottom.open,
          slot: frame.slot === undefined ? store.bottom.slot : frame.slot,
        },
      };

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
      if (!store.runs.has(frame.runId) && !store.settled.has(frame.runId) && !store.opened.has(frame.runId))
        return store;
      if (store.failures.get(frame.runId) === frame.reason) return store;
      return { ...store, failures: new Map(store.failures).set(frame.runId, frame.reason) };
    }

    case "starter": {
      // Who started the run (ADR-0078), off the same guarded re-fetch as the failure, folded by the
      // same rules: nothing without the credential, nothing for a run the page does not hold.
      if (store.token !== "live") return store;
      if (frame.startedBy === null) {
        const starters = mapWithout(store.starters, frame.runId);
        return starters === store.starters ? store : { ...store, starters };
      }
      if (!store.runs.has(frame.runId) && !store.settled.has(frame.runId) && !store.opened.has(frame.runId))
        return store;
      return { ...store, starters: new Map(store.starters).set(frame.runId, frame.startedBy) };
    }

    case "inboxScope":
      return { ...store, inboxAll: frame.all };

    case "startForm":
      return { ...store, startFormFor: frame.workflow };

    default:
      return store;
  }
}

/** No conversation read yet for `runId`. */
function emptyTalk(runId: string): Talk {
  return { runId, rows: [], agents: [], entries: new Map(), ended: new Map() };
}

/** `runId` is one of the selected Workflow's ended runs that `GET /runs` listed, and the Caller
 *  may still read them. */
function inHistory(store: Store, runId: string): boolean {
  return listedEnded(store).some((r) => r.runId === runId);
}

/** The ended runs that `GET /runs` listed, when the Caller may read the selected Workflow; else
 *  none (ADR-0032: without `read`, the rail lists live runs only). */
function listedEnded(store: Store): RunSummaryView[] {
  // The Caller's grant, not `may`: a re-validation (`checking`) of the same Caller keeps the rows.
  if (!store.history || !grantOpens(store.caller?.may.read, store.history.workflow)) return [];
  return store.history.runs;
}

/** The same Caller, so what the page read for one is still the other's. */
function sameCaller(a: CallerView | null, b: CallerView | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Hold `run` with the runs that this page watched end, newest last, at most {@link SETTLED_CAP}.
 *  A run that the cap drops takes its failure and starter with it, unless `GET /runs` still lists
 *  it. */
function settle(store: Store, run: ObservedRun): Store {
  const settled = new Map(store.settled);
  settled.delete(run.runId);
  settled.set(run.runId, run);
  let failures = store.failures;
  let starters = store.starters;
  while (settled.size > SETTLED_CAP) {
    const evicted = settled.keys().next().value!;
    settled.delete(evicted);
    if (inHistory(store, evicted)) continue;
    failures = mapWithout(failures, evicted);
    starters = mapWithout(starters, evicted);
  }
  return { ...store, settled, failures, starters };
}

/** A copy of `map` without `key` — or `map` itself when the key was never there, so a caller can
 *  cheaply tell "nothing changed". */
function mapWithout<K, V>(map: Map<K, V>, key: K): Map<K, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

/** `map` without the entries `keep` refuses — or `map` itself when it keeps them all. */
function keepWhere<K, V>(map: Map<K, V>, keep: (entry: V) => boolean): Map<K, V> {
  let next = map;
  for (const [key, entry] of map) {
    if (keep(entry)) continue;
    if (next === map) next = new Map(map);
    next.delete(key);
  }
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
  const id = store.selectedRunId;
  if (id && (store.runs.has(id) || store.settled.has(id) || store.opened.has(id) || inHistory(store, id))) return store;
  const next = store.runs.keys().next();
  return { ...store, selectedRunId: next.done ? null : next.value };
}

/** The run the page is currently showing, live or settled — whichever half still holds it. */
export function selectedRun(store: Store): ObservedRun | null {
  if (store.selectedRunId === null) return null;
  const id = store.selectedRunId;
  return (
    store.runs.get(id) ?? store.settled.get(id) ?? (inHistory(store, id) ? store.opened.get(id) : undefined) ?? null
  );
}

/** A run row of the rail, from a run the page holds. */
function railRun(run: ObservedRun, settled: boolean): RailRun {
  return {
    runId: run.runId,
    status: run.status,
    settled,
    ...(run.dispatchedBy ? { dispatchedBy: run.dispatchedBy } : {}),
  };
}

/** The selected workflow's run list as the rail draws it: live runs first, then the ended runs —
 *  those this page watched end (newest first), then those `GET /runs` lists that the page did not
 *  watch (ADR-0032). One ordered list keeps the renderer from having to know there are three
 *  sources behind it. An ended row has the listing's status and reason when the listing has it. */
export function runList(store: Store): RailRun[] {
  const listed = new Map(listedEnded(store).map((r) => [r.runId, r]));
  const ended = (run: ObservedRun): RailRun => {
    const summary = listed.get(run.runId);
    return summary ? summaryRow(summary, run.dispatchedBy) : railRun(run, true);
  };
  const watched = [...store.settled.values()].reverse();
  const seen = new Set(watched.map((r) => r.runId));
  return [
    ...[...store.runs.values()].map((run) => railRun(run, false)),
    ...watched.filter((run) => !store.runs.has(run.runId)).map(ended),
    ...[...listed.values()].filter((r) => !seen.has(r.runId) && !store.runs.has(r.runId)).map((r) => summaryRow(r)),
  ];
}

/** An ended run's rail row, from its `GET /runs` summary. */
function summaryRow(summary: RunSummaryView, dispatchedBy = summary.dispatchedBy): RailRun {
  return {
    runId: summary.runId,
    status: summary.status,
    settled: true,
    ...(summary.reason !== undefined ? { reason: summary.reason } : {}),
    ...(dispatchedBy ? { dispatchedBy } : {}),
  };
}

/** One workflow's rail rows: the feed's view (and the ended runs) for the selection, the REST
 *  snapshot for the rest. Same shape either way, so the painter draws a run row without knowing
 *  which side fed it. */
export function fleetRuns(store: Store, workflow: string): RailRun[] {
  if (workflow === store.workflow) return runList(store);
  return (store.fleet.get(workflow) ?? []).map((run) => railRun(run, false));
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
 * A run that binds a Chart draws its own Machine, the Chart compiled into the Open body, and so does
 * a run on an older Assembly or a run that is not live (`own`), so their doc is per run id; every
 * other selection draws the
 * Workflow's Machine, shared by all its runs. The
 * Workflow name rides the route as one encoded segment (`<wrapper>%2F<name>` for a named Chart).
 */
export function machineDocSource(
  workflow: string,
  run: Pick<ObservedRun, "runId" | "bound" | "chartHashes"> | null,
  own = false,
  current: string | null = null,
): { key: string; path: string } {
  const base = `/workflows/${encodeURIComponent(workflow)}`;
  // A run on an older Assembly, or an ended run, is drawn on its own Machine too (ADR-0069): the
  // current Machine's states are not the states it moves through, and an ended run's status binds
  // no Chart any more.
  if (run && (run.bound === true || own)) {
    // The run id and the Charts it binds now: a second Chart in the run's life is a new doc.
    const charts = run.chartHashes?.length ? `:${run.chartHashes.join(",")}` : "";
    return { key: `run:${run.runId}${charts}`, path: `${base}/runs/${encodeURIComponent(run.runId)}/machine` };
  }
  // The current Assembly is in the key: after a publish, the Workflow's Machine is a new doc.
  return { key: `workflow:${workflow}@${current ?? ""}`, path: `${base}/machine` };
}

/** The Assembly hash that `runId` holds, when it is not the current one (ADR-0069): from
 *  `GET /assembly` for a live run, and from the `GET /runs` summary for an ended one. Null when the
 *  run is on the current Assembly, or the page does not know the run's Assembly. */
export function olderAssembly(store: Store, runId: string): string | null {
  const current = store.assembly.current;
  if (current === null) return null;
  const hash = heldAssembly(store, runId);
  return hash !== undefined && hash !== current ? hash : null;
}

/** The Assembly hash that `runId` holds, as far as the page knows: from `GET /assembly` (kept for a
 *  run this page watched end), else from the `GET /runs` summary. */
export function heldAssembly(store: Store, runId: string): string | undefined {
  return store.assembly.held.get(runId) ?? listedEnded(store).find((r) => r.runId === runId)?.assembly;
}

/** The mark of a run on an older Assembly, as the rail and the Machine pane show it (ADR-0032):
 *  "older Assembly · <short hash>". Null for a run on the current one. */
export function olderAssemblyMark(store: Store, runId: string): string | null {
  const hash = olderAssembly(store, runId);
  return hash === null ? null : `older Assembly · ${hash.slice(0, 8)}`;
}

/** Why the SELECTED run is `drifted` (ADR-0030): it has no Machine to draw, so the pane shows this
 *  in place of the graph. Null for every other run. */
export function selectedRunDrift(store: Store): string | null {
  const id = store.selectedRunId;
  if (id === null || store.runs.has(id)) return null;
  const summary = listedEnded(store).find((r) => r.runId === id);
  const status = summary?.status ?? store.settled.get(id)?.status ?? store.opened.get(id)?.status;
  if (status !== "drifted") return null;
  return summary?.reason ?? "this run's Machine cannot be read";
}

/** The doc that the center pane draws for the selection: the selected run's own Machine when it
 *  binds a Chart or is on an older Assembly, else the Workflow's (ADR-0069, ADR-0070). Null with no
 *  selected Workflow. */
export function selectedDocSource(store: Store): { key: string; path: string } | null {
  if (!store.workflow) return null;
  const run = selectedRun(store);
  const id = store.selectedRunId;
  // A run that is not live is drawn on the Machine its terminal write kept (ADR-0069): its status
  // binds no Chart any more, and its Assembly can be gone. So is a run on an older Assembly.
  const own = id !== null && (!store.runs.has(id) || olderAssembly(store, id) !== null);
  const subject = run ?? (own && id !== null ? { runId: id } : null);
  return machineDocSource(store.workflow, subject, own, store.assembly.current);
}

/** The fleet row's badge for a dispatched run (ADR-0071): `↳ <run8>`, the caller's run id cut as
 *  the row cuts its own. Null for a run nobody dispatched. */
export function dispatchBadge(run: ObservedRun | RailRun): string | null {
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

/** The SELECTED run's outstanding picks, each with since when it is outstanding (ADR-0024) — empty
 *  in observer mode. */
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
 *  inbox view is filtered. Only gates that the Caller may answer are in the inbox, so the badge
 *  counts only those. */
export function gateCount(store: Store): number {
  let n = 0;
  for (const entry of store.gates.values()) n += entry.gates.length;
  return n;
}

// ---- The Caller (ADR-0032, ADR-0078) ------------------------------------------------------------

/** Whether a grant opens `workflow`: for `answer`, at least one Gate of it (ADR-0078). A Chart
 *  wrapper's name opens each of its named Charts (`plan` opens `plan/weekly`), because a named Chart
 *  runs its wrapper's Machine (ADR-0070). The same rule as `grantOpens` in tokens.ts, which is what
 *  the server checks. The server lists only the Gates of a run that the Caller may answer, so the
 *  Console does not check the Gate's name. */
function grantOpens(grant: AnswerGrant | undefined, workflow: string): boolean {
  if (grant === undefined) return false;
  if (grant === "all") return true;
  const cut = workflow.indexOf("/");
  return grant.some((item) => {
    const name = typeof item === "string" ? item : item.workflow;
    return name === workflow || (cut > 0 && name === workflow.slice(0, cut));
  });
}

/** One item of a grant as the nav's title says it: a Workflow name, or `deploy (approve, ship)`
 *  for an item that names single Gates. */
function grantItem(item: string | { workflow: string; gates: readonly string[] }): string {
  return typeof item === "string" ? item : `${item.workflow} (${item.gates.join(", ")})`;
}

/**
 * Whether the page's Caller has `scope` for `workflow` — what decides that a control renders
 * (ADR-0032): the start button with `start`, the Gate cards with `answer`, cancel with `cancel`, a
 * run's full state with `read`, the Steering box with `steer`. False with no live credential. With
 * no `workflow`, whether the scope opens at least one Workflow. A hidden control is so that a
 * person does not meet a 403, never a guard: the server checks each request.
 */
export function may(store: Store, scope: ScopeName, workflow?: string): boolean {
  if (store.token !== "live" || !store.caller) return false;
  const grant = store.caller.may[scope];
  if (workflow === undefined) return grant !== undefined && (grant === "all" || grant.length > 0);
  return grantOpens(grant, workflow);
}

/** Who the page acts as, as the nav shows it (ADR-0032): the name that jr2 shows (a JWT's `email`),
 *  else `<via>/<name>`, and the party it says it acts for. Null with no live credential. */
export function callerLabel(store: Store): string | null {
  const caller = store.token === "live" ? store.caller : null;
  if (!caller) return null;
  const who = caller.shown ?? `${caller.via}/${caller.name}`;
  return caller.onBehalfOf !== undefined ? `${who} for ${caller.onBehalfOf}` : who;
}

/** The scopes of the page's Caller, one line for the nav's title: `start: all · answer: a, b`. */
export function callerScopes(caller: CallerView | null): string {
  if (!caller) return "";
  const lines = (["start", "answer", "cancel", "read", "steer"] as const).flatMap((scope) => {
    const grant = caller.may[scope];
    if (grant === undefined || (grant !== "all" && grant.length === 0)) return [];
    return [`${scope}: ${grant === "all" ? "all" : grant.map(grantItem).join(", ")}`];
  });
  return lines.length ? lines.join(" · ") : "no scope";
}

/** The SELECTED run's starter as the Machine pane's strip says it (ADR-0078): `started by
 *  token/ci`, `started by run <run8> (<slot>)`, `started by jr2 (boot)`. Null when the page does
 *  not know it: no live credential with `read`, or a run from an older Orchestrator. */
export function selectedRunStarter(store: Store): string | null {
  if (store.selectedRunId === null) return null;
  const by = store.starters.get(store.selectedRunId);
  if (!by) return null;
  if (by.kind === "run") return `started by run ${by.run.slice(0, 8)} (${by.slot})`;
  if (by.kind === "jr2") return `started by jr2 (${by.why})`;
  const shown = by.shown !== undefined ? ` (${by.shown})` : "";
  const behalf = by.onBehalfOf !== undefined ? ` on behalf of ${by.onBehalfOf}` : "";
  return `started by ${by.via}/${by.name}${shown}${behalf}`;
}

// ---- The kept conversations (ADR-0023, ADR-0032) ------------------------------------------------

/** One tab of the bottom drawer: an Agent slot of the selected run, a dot when its Turn is open,
 *  and whether a Steering message can go to it. */
export type SlotTab = { slot: string; open: boolean; steerable: boolean };

/** A conversation's slot: the ledger's slot, else the Agent's name. */
function slotOf(row: ConversationRow): string {
  return row.slot ?? row.agent;
}

/** The bottom drawer's tabs: each Agent slot of the selected run, in the order its first
 *  conversation began, then the slots that `GET /runs/:id/agents` names and no conversation has
 *  yet. */
export function slotTabs(store: Store): SlotTab[] {
  const talk = store.talk;
  if (!talk) return [];
  const tabs = new Map<string, SlotTab>();
  for (const row of talk.rows) {
    const slot = slotOf(row);
    const tab = tabs.get(slot) ?? { slot, open: false, steerable: false };
    tab.open ||= row.open;
    tabs.set(slot, tab);
  }
  for (const line of talk.agents) {
    const tab = tabs.get(line.agent) ?? { slot: line.agent, open: false, steerable: false };
    tab.open ||= line.open;
    tab.steerable = line.steerable;
    tabs.set(line.agent, tab);
  }
  return [...tabs.values()];
}

/** The slot that the bottom drawer shows: the one the person chose while the run has it, else the
 *  first slot with an open Turn, else the first slot. Null when the run has none. */
export function activeSlot(store: Store): string | null {
  const tabs = slotTabs(store);
  const chosen = store.bottom.slot;
  if (chosen !== null && tabs.some((t) => t.slot === chosen)) return chosen;
  return (tabs.find((t) => t.open) ?? tabs[0])?.slot ?? null;
}

/** One conversation of a slot as the drawer shows it: its row, the entries read so far, and how
 *  its stream ended, if it did. */
export type SlotConversation = {
  row: ConversationRow;
  entries: ConversationEntry[];
  ended?: { cut: boolean; swept?: string };
};

/** The conversations of `slot`, the first first: a slot whose conversation began again (a new
 *  conversation after a fault, ADR-0057) has more than one. */
export function slotConversations(store: Store, slot: string | null): SlotConversation[] {
  const talk = store.talk;
  if (!talk || slot === null) return [];
  return talk.rows
    .filter((row) => slotOf(row) === slot)
    .map((row) => {
      const ended = talk.ended.get(row.instanceId);
      return { row, entries: talk.entries.get(row.instanceId) ?? [], ...(ended ? { ended } : {}) };
    });
}
