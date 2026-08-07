// The j2 Console — one shell, master–detail (ADR-0032). The left rail is the FLEET (every
// registered workflow, each expandable to its runs); the center is the selected workflow's Machine,
// fetched from GET /workflows/:name/machine, laid out with elkjs (loaded as a UMD script ->
// window.ELK), rendered as nested SVG (canvas.ts) and live-highlighted by the selected run; the
// right drawer is Attention (the gate inbox) and Activity (the emit log).
//
// The ADDRESS carries the selection: `/` and `/workflows/:name` serve these same bytes, the path
// says which workflow is selected, pushState moves it on click and popstate restores it. ONE
// EventSource, ever, and it belongs to the SELECTION (GET /workflows/:name/events — ADR-0022);
// the rest of the fleet is REST snapshots on an interval and on tab focus. Selecting a RUN is a
// local act: it re-renders from state already in hand and touches no socket. `onerror` means
// "retrying", never "give up" — EventSource reconnects on its own, and the level-triggered feed
// makes reattach convergent with no cursor (store.ts folds every frame idempotently).
//
// The page as SERVED is ADR-0014's observer: open structure and observation, no credential in the
// bytes. Control is EARNED per tab: the human types the Instance token into the nav (sessionStorage
// — survives a reload, dies with the tab, never a cookie), and only then does the page speak on the
// guarded surface: POST /workflows/:name/runs (start), GET /runs/:id (gate discovery, re-fetched on
// each frame), POST /runs/:id/gates/:gate/events (delivery). Any later 401 drops the whole page
// back to observer mode. That is ADR-0032 end to end — the bands themselves never moved.
//
// STORE-FIRST, VDOM-PAINTED (ADR-0034): everything the page believes lives in the pure reducer
// (store.ts) and arrives there as frames — wire frames and page facts alike. `dispatch` is the one
// door: fold the frame, render the App from the top, and let Preact's diff do what main.js's
// hand-rolled memo()/paint() machinery did. This file is the BOOTSTRAP and owns only working
// state — the machine-doc cache, the input-schema cache, the fetch serials, the zoom readout; the
// diagram's own working state (fold set, viewport, what is shown) lives in canvas.ts.

import { h, render } from "preact";
import { applyFrame, emptyStore, type Frame, type GateCard, type ObservedRun, type Store } from "./store.ts";
import { zoomFit, zoomIn, zoomOut, zoomReset, type MachineDoc } from "./canvas.ts";
import { App, type AppApi, type MachineView } from "./components/app.ts";

let store: Store = emptyStore();
/** The center pane's working state — see {@link MachineView}; the doc counterpart of old `shown`. */
let view: MachineView = { doc: null, placeholder: null, note: null };
/** The nav's zoom readout — canvas.ts reports through `api.onScale`; a render carries it. */
let zoomPct = 100;

const root = document.getElementById("root")!;

/** One render from the top, whatever moved — store or working state; the vdom diffs the rest. */
function rerender(): void {
  render(h(App, { store, view, zoomPct, initialToken, schemas: inputSchemas, api }), root);
}

/** Fold one frame and re-render. Every state change in this file goes through here — a page that
 *  writes anywhere else holds a private belief, which is the bug class store.ts exists to end. */
function dispatch(frame: Frame): void {
  store = applyFrame(store, frame);
  rerender();
}

// ---- The token (ADR-0032) -----------------------------------------------------------------------
// The VALUE lives here (sessionStorage) and rides only in Authorization headers; the store holds
// its STATE. Entry is validated with the cheapest guarded read (`GET /runs`), whose response also
// happens to be the full run list — which seeds the gate inbox without waiting for a frame.

const TOKEN_KEY = "j2.console.token";
const token = (): string => sessionStorage.getItem(TOKEN_KEY) ?? "";
/** Seeds the (uncontrolled) nav input once; every later read goes to sessionStorage. */
const initialToken = token();

/** A guarded fetch. The ONE place a 401 is turned into observer mode — every control widget calls
 *  through here, so none of them needs its own fallback story. */
async function gfetch(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response | null> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token()}` },
  });
  if (res.status === 401) {
    dispatch({ kind: "token", state: "invalid" });
    return null;
  }
  return res;
}

/** Which token entry is CURRENT. Two quick edits launch two unsequenced validations, and without
 *  this the older response could dispatch last and leave the badge (and inbox seed) speaking for a
 *  token the reader already replaced. Bumped by every entry AND by clearing, so an in-flight
 *  validation can never overwrite "none". */
let tokenSerial = 0;

async function validateToken(): Promise<void> {
  const serial = ++tokenSerial;
  dispatch({ kind: "token", state: "checking" });
  let res: Response | null;
  try {
    res = await fetch("/runs", { headers: { authorization: `Bearer ${token()}` } });
  } catch {
    res = null; // network trouble reads as invalid; re-entering the token retries
  }
  if (serial !== tokenSerial) return; // a newer entry owns the badge — this answer is nobody's
  if (!res?.ok) return dispatch({ kind: "token", state: "invalid" });
  dispatch({ kind: "token", state: "live" });
  const runs = (await res.json()) as Array<{ runId: string; workflow: string }>;
  if (serial !== tokenSerial) return;
  for (const r of runs) void refreshGates(r.runId, r.workflow);
}

function setToken(value: string): void {
  if (!value) {
    tokenSerial++; // strand any in-flight validation of the token this just cleared
    sessionStorage.removeItem(TOKEN_KEY);
    dispatch({ kind: "token", state: "none" });
    return;
  }
  sessionStorage.setItem(TOKEN_KEY, value);
  void validateToken();
}

// ---- Gate discovery (frame-triggered — ADR-0032) ------------------------------------------------

/** Per-run re-fetch serials — fetch bookkeeping like `docs`, not belief. The browser runs these
 *  requests on parallel connections, so answers can land out of ORDER: a re-fetch triggered by the
 *  delivery's own transition frame (gates now empty) can resolve before the one an earlier frame
 *  launched (gate still open), and folding the straggler would resurrect a card the server already
 *  emptied — pinning the ⚑ and inviting a second delivery until the run's next frame, which a run
 *  parked in a long agent step may not land for minutes. Only the latest-STARTED re-fetch may
 *  speak for a run; superseded answers are dropped before they reach the store. */
const gateFetchSerial = new Map<string, number>();

/** Re-read one run's open gates off the guarded surface and fold the WHOLE answer in. Called on
 *  every frame that touches the run — that is the synchronization: a gate opens with a state entry
 *  and closes with its exit, and every entry/exit lands a frame. A delivery's success is the next
 *  re-fetch coming back empty; nothing here concludes anything on its own. */
async function refreshGates(runId: string, workflow: string): Promise<void> {
  if (store.token !== "live") return; // observer mode: the inbox does not exist
  const serial = (gateFetchSerial.get(runId) ?? 0) + 1;
  gateFetchSerial.set(runId, serial);
  const res = await gfetch(`/runs/${encodeURIComponent(runId)}`);
  if (!res) return; // 401 already dropped the page to observer
  const gates = res.ok ? (((await res.json()) as { gates?: GateCard[] }).gates ?? []) : []; // !ok: settled + evicted
  if (gateFetchSerial.get(runId) !== serial) return; // superseded — a newer re-fetch owns the answer
  dispatch({ kind: "gates", runId, workflow, gates });
}

// ---- The two writes (start-run + gate delivery — ADR-0033) --------------------------------------
// Both resolve to an inline error string for the shared form to render, or null when the write
// landed — the components never see a Response.

async function startRun(name: string, body: Record<string, unknown>): Promise<string | null> {
  const res = await gfetch(`/workflows/${encodeURIComponent(name)}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res) return "unauthorized — the page dropped to observer";
  if (!res.ok) return ((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`;
  dispatch({ kind: "startForm", workflow: null });
  // The run ANNOUNCES itself: the feed if this workflow is selected, the next snapshot if not —
  // but a reader who just started a run should not wait 10s to see it in the rail.
  if (name !== store.workflow) void snapshotWorkflow(name);
  return null;
}

async function deliverGate(
  runId: string,
  gate: string,
  event: string,
  body: Record<string, unknown>,
): Promise<string | null> {
  const res = await gfetch(`/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gate)}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: event, ...body }),
  });
  if (!res) return "unauthorized — the page dropped to observer";
  if (!res.ok) return ((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`;
  // Deliberately NO local bookkeeping: the delivery moves the Machine, the move lands a frame, the
  // frame triggers the re-fetch, and the re-fetch empties the card (ADR-0032).
  return null;
}

// ---- Start-run schemas (ADR-0033) ---------------------------------------------------------------

/** The workflow-detail input schemas (`GET /workflows/:name` JSON — ADR-0033), fetched when a
 *  start form first opens. `null` is a real answer (no declared input → raw JSON textarea). */
const inputSchemas = new Map<string, unknown>();

async function toggleStartForm(name: string): Promise<void> {
  if (store.startFormFor === name) return dispatch({ kind: "startForm", workflow: null });
  dispatch({ kind: "startForm", workflow: name });
  if (!inputSchemas.has(name)) {
    const res = await fetch(`/workflows/${encodeURIComponent(name)}`, { headers: { accept: "application/json" } });
    inputSchemas.set(name, res.ok ? (((await res.json()) as { input?: unknown }).input ?? null) : null);
    rerender(); // the form was rendered as "loading" — now the schema is in hand
  }
}

// ---- Selection: the address, the feed, the diagram ----------------------------------------------

/** The workflow the address names — `/workflows/:name`, or null at `/`. */
function workflowFromPath(): string | null {
  const match = /^\/workflows\/([^/]+)\/?$/.exec(location.pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

let feed: EventSource | null = null; // the ONE EventSource — the selection's, closed only by a new selection

/**
 * Move the selection: address, store, feed, diagram, in that order. `push` is a click (writes
 * history) — but only a click that MOVES: re-clicking the selection would otherwise push a
 * duplicate entry and make the next Back press appear to do nothing. Popstate and boot restore
 * without writing. `runId` rides along when a run row or an inbox card was the click —
 * unvalidated, the feed's first frame confirms or moves on.
 */
async function selectWorkflow(
  name: string | null,
  { push = false, runId = null }: { push?: boolean; runId?: string | null } = {},
): Promise<void> {
  const moved = name !== store.workflow;
  if (push && moved) history.pushState({}, "", name ? `/workflows/${encodeURIComponent(name)}` : "/");
  document.title = name ? `j2 · ${name}` : "j2 · Console";
  dispatch({ kind: "select", workflow: name });
  if (runId) dispatch({ kind: "selectRun", runId });
  if (!moved && view.doc) return; // re-selecting the selection (a popstate re-fire): nothing to do
  feed?.close();
  feed = null;
  // Forget the old diagram NOW: the new feed's frames start landing before the new doc is in hand,
  // and they must not re-layout (or highlight) the machine the reader just left — the render below
  // reaches the canvas effect, which clears it.
  view = { doc: null, placeholder: name ? null : "select a workflow from the fleet", note: null };
  rerender();
  if (!name) return;
  connectFeed(name);
  await loadMachine(name);
}

/** The selected workflow's Machine docs, kept across navigations — structure does not change under
 *  a running orchestrator, so going back to a workflow is instant. Misses are NOT cached: a name
 *  can be registered after this page loaded, and re-selecting it should find it. */
const docs = new Map<string, MachineDoc>();

async function loadMachine(name: string): Promise<void> {
  let doc: MachineDoc | null | undefined = docs.get(name);
  if (doc === undefined) {
    const res = await fetch(`/workflows/${encodeURIComponent(name)}/machine`);
    doc = res.ok ? ((await res.json()) as MachineDoc) : null;
    if (doc) docs.set(name, doc);
  }
  if (store.workflow !== name) return; // the reader moved on while the fetch was out
  if (!doc) {
    view = { doc: null, placeholder: null, note: { text: `no workflow "${name}"`, notice: false } };
    rerender();
    return;
  }
  // Nothing live yet: every child machine renders once, as a dimmed template (the canvas effect
  // picks the doc up from here). The first status frame of a run with children swaps those for
  // one subgraph per instance.
  view = { doc, placeholder: null, note: opaqueNotice(doc) };
  rerender();
}

/** Say so when the diagram is knowingly incomplete: a child spawned inside an `enqueueActions`
 *  closure cannot be found by the static walk, so those states may be missing children entirely.
 *  Computed server-side (`MachineDoc.opaqueStates`) and surfaced HERE, where the reader is. */
function opaqueNotice(doc: MachineDoc): MachineView["note"] {
  const opaque = doc.opaqueStates ?? [];
  if (!opaque.length) return null;
  return {
    notice: true,
    text: `${opaque.join(", ")} ${opaque.length === 1 ? "runs" : "run"} an enqueueActions closure — any child machine spawned inside one is NOT shown in this diagram (keep \`spawnChild\` a top-level action to see it).`,
  };
}

/**
 * The selection's feed. Opened by `selectWorkflow`, closed only by the next one.
 *
 * `onerror` only reports: EventSource reconnects on its own, and closing here (as this page used
 * to) is what made a single blip permanent. There is nothing to re-sync afterwards — the reattached
 * feed opens with the whole live set, which folds in idempotently.
 *
 * Each run-touching frame ALSO triggers that run's gate re-fetch (ADR-0032): a gate opens with a
 * state entry and closes with its exit, and every entry/exit lands a frame here.
 */
function connectFeed(name: string): void {
  feed = new EventSource(`/workflows/${encodeURIComponent(name)}/events`);
  feed.addEventListener("runs", (e) => {
    const runs = JSON.parse((e as MessageEvent<string>).data) as ObservedRun[];
    dispatch({ kind: "runs", runs });
    for (const r of runs) void refreshGates(r.runId, name);
  });
  feed.addEventListener("status", (e) => {
    const status = JSON.parse((e as MessageEvent<string>).data) as ObservedRun;
    dispatch({ kind: "status", status });
    void refreshGates(status.runId, name);
  });
  feed.addEventListener("gone", (e) => {
    const { runId } = JSON.parse((e as MessageEvent<string>).data) as { runId: string };
    dispatch({ kind: "gone", runId });
    // The reducer already dropped the card (a gate exists only while its state is entered —
    // ADR-0011); the re-fetch is the same frame-triggered discipline as `runs`/`status`, and its
    // 404 converges on the same empty answer.
    void refreshGates(runId, name);
  });
  feed.addEventListener("emit", (e) => {
    const { runId, type } = JSON.parse((e as MessageEvent<string>).data) as { runId: string; type: string };
    dispatch({ kind: "emit", runId, type });
  });
  feed.onopen = () => dispatch({ kind: "connection", state: "live" });
  feed.onerror = () => dispatch({ kind: "connection", state: "retrying" });
}

// ---- Fleet snapshots ----------------------------------------------------------------------------
// The unselected workflows have no feed — never more than one EventSource. They get REST snapshots
// (`GET /workflows/:name/runs`) on an interval and on tab focus, folded through the same reducer
// (each snapshot also re-triggers its runs' gate re-fetches, so the inbox is fleet-wide).

const SNAPSHOT_MS = 10_000;

async function snapshotWorkflow(name: string): Promise<void> {
  try {
    const res = await fetch(`/workflows/${encodeURIComponent(name)}/runs`);
    if (!res.ok) return;
    const runs = (await res.json()) as ObservedRun[];
    dispatch({ kind: "fleet", workflow: name, runs });
    for (const r of runs) void refreshGates(r.runId, name);
  } catch {
    // transient — the next tick tries again
  }
}

async function snapshotFleet(): Promise<void> {
  try {
    const res = await fetch("/workflows");
    if (res.ok) dispatch({ kind: "workflows", workflows: (await res.json()) as string[] });
  } catch {
    // transient — the next tick tries again
  }
  for (const name of store.workflows) {
    if (name === store.workflow) continue; // the selection's feed is fresher than any snapshot
    await snapshotWorkflow(name);
  }
}

// ---- Boot ---------------------------------------------------------------------------------------

/** Every write path the components may take, in one object — handed to the App on every render. */
const api: AppApi = {
  dispatch,
  selectWorkflow,
  toggleStartForm,
  startRun,
  deliverGate,
  setToken,
  onScale: (pct) => {
    if (pct === zoomPct) return;
    zoomPct = pct;
    rerender();
  },
  zoomIn,
  zoomOut,
  zoomReset,
  zoomFit,
};

async function boot(): Promise<void> {
  addEventListener("popstate", () => void selectWorkflow(workflowFromPath(), { push: false }));
  addEventListener("focus", () => void snapshotFleet());
  setInterval(() => void snapshotFleet(), SNAPSHOT_MS);
  rerender(); // the shell first — the fetches below fill it in

  // The fleet first (the rail names everything), then the token (unlock is async and must not gate
  // observation), then the selection the address carries — deep links work on load.
  try {
    const res = await fetch("/workflows");
    if (res.ok) dispatch({ kind: "workflows", workflows: (await res.json()) as string[] });
  } catch {
    // the interval retries; the rail says "no workflows registered" until then
  }
  if (token()) void validateToken();
  await selectWorkflow(workflowFromPath(), { push: false });
  void snapshotFleet();
}

boot().catch((err: unknown) => {
  view = { doc: null, placeholder: null, note: { text: String(err), notice: false } };
  rerender();
});
