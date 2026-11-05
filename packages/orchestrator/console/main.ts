// The jr2 Console — one shell, master–detail (ADR-0032). The left rail is the FLEET (every
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
// bytes. Control is EARNED per tab: the person types a Caller's token into the nav, or logs in
// against an issuer the Instance declares (OIDC code + PKCE, login.ts), and the credential lives in
// sessionStorage — survives a reload, dies with the tab, never a cookie. The page asks
// `GET /whoami` what the credential may do, and renders only the controls its scopes open
// (ADR-0078): start (POST /workflows/:name/runs), the Gate cards (GET /runs/:id re-fetched on each
// frame, POST /runs/:id/gates/:gate/events), cancel (POST /runs/:id/events), the Steering box
// (GET /runs/:id/agents, POST /runs/:id/steering). Any later 401 drops the whole page back to
// observer mode. That is ADR-0032 end to end — the bands themselves never moved.
//
// STORE-FIRST, VDOM-PAINTED (ADR-0034): everything the page believes lives in the pure reducer
// (store.ts) and arrives there as frames — wire frames and page facts alike. `dispatch` is the one
// door: fold the frame, render the App from the top, and let Preact's diff do what main.js's
// hand-rolled memo()/paint() machinery did. This file is the BOOTSTRAP and owns only working
// state — the machine-doc cache, the input-schema cache, the fetch serials, the zoom readout; the
// diagram's own working state (fold set, viewport, what is shown) lives in canvas.ts.
//
// A run that binds a Chart (ADR-0070) draws ITS Machine, not the Workflow's: the definition's doc
// has the Open body as one opaque child, and a Chart one cannot watch is a Chart one cannot trust.
// So the doc the center pane draws is chosen per selection (`machineDocSource`): the Workflow's
// Machine, or, when the selected run's observation says `bound`, the run's own from
// `GET /workflows/:name/runs/:runId/machine`, cached per run id. The live child still joins its
// subgraph by `src`, which the per-run doc keeps as the body's slot key.

import { h, render } from "preact";
import {
  applyFrame,
  emptyStore,
  failureReason,
  machineDocSource,
  may,
  selectedRun,
  type CallerView,
  type Frame,
  type GateCard,
  type ObservedRun,
  type Store,
  type HeldLine,
  type StarterView,
  type WaitingLine,
  type WorkflowListing,
} from "./store.ts";
import {
  authorizeUrl,
  credentialOf,
  loginReturn,
  loginScopes,
  pkceChallenge,
  randomValue,
  redirectUri,
  tokenRequestBody,
  type ConsoleConfig,
  type LoginIssuer,
  type PendingLogin,
} from "./login.ts";
import { zoomFit, zoomIn, zoomOut, zoomReset, type MachineDoc } from "./canvas.ts";
import { App, type AgentLine, type AppApi, type MachineView } from "./components/app.ts";

let store: Store = emptyStore();
/** The center pane's working state — see {@link MachineView}; the doc counterpart of old `shown`. */
let view: MachineView = { doc: null, placeholder: null, note: null };
/** The nav's zoom readout — canvas.ts reports through `api.onScale`; a render carries it. */
let zoomPct = 100;
/** The issuers the nav offers a login against (`GET /console/config`), and why the last login
 *  failed, if it did. Working state of the bootstrap, like the zoom: what the page KNOWS of a run
 *  stays in the store. */
let logins: LoginIssuer[] = [];
let loginNote: string | null = null;

const root = document.getElementById("root")!;

/** One render from the top, whatever moved — store or working state; the vdom diffs the rest. */
function rerender(): void {
  render(h(App, { store, view, zoomPct, initialToken, logins, loginNote, schemas: inputSchemas, api }), root);
}

/** Fold one frame and re-render. Every state change in this file goes through here — a page that
 *  writes anywhere else holds a private belief, which is the bug class store.ts exists to end. */
function dispatch(frame: Frame): void {
  store = applyFrame(store, frame);
  rerender();
  // A frame can change which doc the pane draws: a new selection, a run selected, a run that now
  // binds a Chart. The check is a key compare; only a change fetches.
  void syncMachine();
}

// ---- The credential (ADR-0032) ------------------------------------------------------------------
// The VALUE lives here (sessionStorage) and rides only in Authorization headers; the store holds
// its STATE and the Caller it is. Entry is validated with `GET /whoami`, which answers any Caller
// and says what it may do (ADR-0078) — a typed token and a login's JWT alike.

const TOKEN_KEY = "jr2.console.token";
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
  let caller: CallerView | null = null;
  try {
    const res = await fetch("/whoami", { headers: { authorization: `Bearer ${token()}` } });
    if (res.ok) caller = (await res.json()) as CallerView;
  } catch {
    // network trouble reads as invalid; re-entering the token retries
  }
  if (serial !== tokenSerial) return; // a newer entry owns the badge — this answer is nobody's
  if (!caller) return dispatch({ kind: "token", state: "invalid" });
  dispatch({ kind: "caller", caller });
  dispatch({ kind: "token", state: "live" });
  // Seed the inbox and the run details from the runs the page already holds: the frames that
  // carried them came before the credential, so their re-fetches did nothing.
  for (const r of store.runs.values()) void refreshRun(r.runId, r.workflow);
  for (const [workflow, runs] of store.fleet) for (const r of runs) void refreshRun(r.runId, workflow);
}

function setToken(value: string): void {
  loginNote = null;
  if (!value) {
    tokenSerial++; // strand any in-flight validation of the token this just cleared
    sessionStorage.removeItem(TOKEN_KEY);
    dispatch({ kind: "token", state: "none" });
    return;
  }
  sessionStorage.setItem(TOKEN_KEY, value);
  void validateToken();
}

// ---- The login (ADR-0032, ADR-0078) -------------------------------------------------------------
// OIDC, the code flow with PKCE, as a public client: the page goes to the issuer, the issuer comes
// back to `/` with a code, and the page exchanges the code for an ID token, which it then keeps and
// sends as it keeps and sends a typed token. What it holds between the two halves (the verifier,
// the state, where to go back to) is in sessionStorage too, and goes when the return reads it.

const LOGIN_KEY = "jr2.console.login";

/** The issuers that offer a login, off the open route. A failure offers none: a typed token still
 *  works. */
async function loadLogins(): Promise<void> {
  try {
    const res = await fetch("/console/config");
    if (res.ok) logins = ((await res.json()) as ConsoleConfig).login ?? [];
  } catch {
    logins = [];
  }
}

/** Go to the issuer. Its discovery document names where; the page asks it for the scopes it lists. */
async function login(issuer: LoginIssuer): Promise<void> {
  loginNote = null;
  try {
    const res = await fetch(`${issuer.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`the issuer's discovery document answered ${res.status}`);
    const discovery = (await res.json()) as {
      authorization_endpoint?: string;
      token_endpoint?: string;
      scopes_supported?: string[];
    };
    if (!discovery.authorization_endpoint || !discovery.token_endpoint) {
      throw new Error("the issuer's discovery document names no authorization or token endpoint");
    }
    if (!globalThis.crypto?.subtle) throw new Error("a login needs the Console on https or on localhost");
    const pending: PendingLogin = {
      issuer: issuer.issuer,
      clientId: issuer.clientId,
      state: randomValue(),
      verifier: randomValue(),
      tokenEndpoint: discovery.token_endpoint,
      returnTo: location.pathname,
    };
    sessionStorage.setItem(LOGIN_KEY, JSON.stringify(pending));
    location.assign(
      authorizeUrl({
        endpoint: discovery.authorization_endpoint,
        clientId: issuer.clientId,
        redirectUri: redirectUri(location.origin),
        scope: loginScopes(discovery.scopes_supported),
        state: pending.state,
        challenge: await pkceChallenge(pending.verifier),
      }),
    );
  } catch (err) {
    loginNote = `login failed: ${err instanceof Error ? err.message : String(err)}`;
    rerender();
  }
}

/** The return from the issuer, at boot: exchange the code, keep the ID token, and put the address
 *  back where the person logged in from. A return that does not match the pending login (another
 *  tab's, or a forged one) is refused, and nothing is kept. */
async function finishLogin(): Promise<void> {
  const back = loginReturn(location.search);
  if (!back) return;
  const raw = sessionStorage.getItem(LOGIN_KEY);
  sessionStorage.removeItem(LOGIN_KEY);
  let pending: PendingLogin | null = null;
  try {
    pending = raw ? (JSON.parse(raw) as PendingLogin) : null;
  } catch {
    pending = null;
  }
  history.replaceState({}, "", pending?.returnTo ?? "/");
  if (!pending || back.state !== pending.state) {
    loginNote = "login failed: the return does not match a login that this tab started";
    return;
  }
  if ("error" in back) {
    loginNote = `login failed: ${back.error}`;
    return;
  }
  try {
    const res = await fetch(pending.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: tokenRequestBody({
        code: back.code,
        redirectUri: redirectUri(location.origin),
        clientId: pending.clientId,
        verifier: pending.verifier,
      }),
    });
    const jwt = res.ok ? credentialOf(await res.json()) : null;
    if (!jwt) throw new Error(`the issuer's token endpoint answered ${res.status} with no ID token`);
    sessionStorage.setItem(TOKEN_KEY, jwt);
  } catch (err) {
    loginNote = `login failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---- Gate discovery and waits (frame-triggered — ADR-0032, ADR-0064) ----------------------------

/** Per-run re-fetch serials — fetch bookkeeping like `docs`, not belief. The browser runs these
 *  requests on parallel connections, so answers can land out of ORDER: a re-fetch triggered by the
 *  delivery's own transition frame (gates now empty) can resolve before the one an earlier frame
 *  launched (gate still open), and folding the straggler would resurrect a card the server already
 *  emptied — pinning the ⚑ and inviting a second delivery until the run's next frame, which a run
 *  parked in a long agent step may not land for minutes. Only the latest-STARTED re-fetch may
 *  speak for a run; superseded answers are dropped before they reach the store. */
const runFetchSerial = new Map<string, number>();

/** Re-read one run's open gates off the guarded surface and fold the WHOLE answer in. Called on
 *  every frame that touches the run — that is the synchronization: a gate opens with a state entry
 *  and closes with its exit, and every entry/exit lands a frame. A delivery's success is the next
 *  re-fetch coming back empty; nothing here concludes anything on its own. The same answer carries
 *  why the run's Workspaces in `placing` wait (ADR-0064), folded as its own frame by the same rules:
 *  a Workspace enters and leaves `placing` with a frame too. */
async function refreshRun(runId: string, workflow: string): Promise<void> {
  // Observer mode, or a Caller that may neither answer nor read this Workflow: the server would
  // refuse the read, so the page does not make it (ADR-0032).
  if (!may(store, "answer", workflow) && !may(store, "read", workflow)) return;
  const serial = (runFetchSerial.get(runId) ?? 0) + 1;
  runFetchSerial.set(runId, serial);
  const res = await gfetch(`/runs/${encodeURIComponent(runId)}`);
  if (!res) return; // 401 already dropped the page to observer
  // !ok: settled + evicted — no gates, and nothing waits.
  const body = res.ok
    ? ((await res.json()) as {
        status?: string;
        output?: unknown;
        gates?: GateCard[];
        waiting?: WaitingLine[];
        held?: HeldLine[];
        startedBy?: StarterView;
      })
    : {};
  if (runFetchSerial.get(runId) !== serial) return; // superseded — a newer re-fetch owns the answer
  dispatch({ kind: "gates", runId, workflow, gates: body.gates ?? [] });
  dispatch({ kind: "waiting", runId, workflow, waiting: body.waiting ?? [], held: body.held ?? [] });
  // The reason of a run that ended `failed` (ADR-0073). A 404 says nothing about it, so a reason
  // the page has stays.
  if (res.ok) dispatch({ kind: "failure", runId, reason: failureReason(body) });
  // Who started the run (ADR-0078): on the status, so with `read` alone.
  if (res.ok) dispatch({ kind: "starter", runId, startedBy: body.startedBy ?? null });
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

// ---- Cancel and steer (ADR-0002, ADR-0078) ------------------------------------------------------
// Same contract as the two writes above. A cancel lands a frame like any transition; a Steering
// message moves nothing the page can see, so its answer is the only news of it.

async function cancelRun(runId: string): Promise<string | null> {
  const res = await gfetch(`/runs/${encodeURIComponent(runId)}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "CANCEL" }),
  });
  if (!res) return "unauthorized — the page dropped to observer";
  if (!res.ok) return ((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`;
  return null;
}

/** The run's conversation list (`GET /runs/:id/agents`): where a Steering message can go. */
async function steerTargets(runId: string): Promise<AgentLine[] | string> {
  const res = await gfetch(`/runs/${encodeURIComponent(runId)}/agents`);
  if (!res) return "unauthorized — the page dropped to observer";
  if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
  return (await res.json()) as AgentLine[];
}

async function steer(runId: string, agent: string, text: string): Promise<string | null> {
  const res = await gfetch(`/runs/${encodeURIComponent(runId)}/steering`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent, text }),
  });
  if (!res) return "unauthorized — the page dropped to observer";
  if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
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
  document.title = name ? `jr2 · ${name}` : "jr2 · Console";
  // Re-selecting the selection (a popstate re-fire) with its diagram in hand keeps the feed.
  const reconnect = moved || !view.doc;
  if (reconnect) {
    feed?.close();
    feed = null;
    // Forget the old diagram NOW, before the `select` frame: the new feed's frames start landing
    // before the new doc is in hand, and they must not re-layout (or highlight) the machine the
    // reader just left — the render reaches the canvas effect, which clears it.
    view = { doc: null, placeholder: name ? null : "select a workflow from the fleet", note: null };
    shownKey = null;
  }
  dispatch({ kind: "select", workflow: name }); // the dispatch starts the doc's fetch (syncMachine)
  if (runId) dispatch({ kind: "selectRun", runId });
  if (!reconnect || !name) return;
  connectFeed(name);
  await syncMachine();
}

/** Machine docs, kept across navigations and keyed by `machineDocSource`: a Workflow's doc is one
 *  per name (structure does not change under a running orchestrator, so going back is instant), and
 *  a run that binds a Chart has its own per run id (ADR-0070). Misses are NOT cached: a name can be
 *  registered after this page loaded, and re-selecting it should find it. */
const docs = new Map<string, MachineDoc>();

/** The doc key the pane draws or is fetching — so a frame that changes nothing fetches nothing, and
 *  an answer for a key the reader has left is dropped. */
let shownKey: string | null = null;

async function fetchDoc(source: { key: string; path: string }): Promise<MachineDoc | null> {
  const cached = docs.get(source.key);
  if (cached) return cached;
  try {
    const res = await fetch(source.path);
    const doc = res.ok ? ((await res.json()) as MachineDoc) : null;
    if (doc) docs.set(source.key, doc);
    return doc;
  } catch {
    return null; // network trouble reads as a miss; the next selection retries
  }
}

/** Bring the pane's doc in line with the selection: the selected run's bound Machine when it binds
 *  a Chart, else the Workflow's (`machineDocSource`, ADR-0070). */
async function syncMachine(): Promise<void> {
  const name = store.workflow;
  if (!name) return;
  const source = machineDocSource(name, selectedRun(store));
  if (source.key === shownKey) return;
  shownKey = source.key;
  let doc = await fetchDoc(source);
  if (shownKey !== source.key) return; // the reader moved on while the fetch was out
  let note: MachineView["note"] = null;
  if (!doc && source.key.startsWith("run:")) {
    // The run's own Machine could not be read (an Orchestrator older than the route, or the run
    // left the store): draw the Workflow's, and say the Chart's states are not in it.
    doc = await fetchDoc(machineDocSource(name, null));
    if (shownKey !== source.key) return;
    note = {
      text: "this run binds a Chart, and its Machine could not be read: the Chart's states are not shown",
      notice: true,
    };
  }
  if (!doc) {
    view = { doc: null, placeholder: null, note: { text: `no workflow "${name}"`, notice: false } };
    rerender();
    return;
  }
  // Nothing live yet: every child machine renders once, as a dimmed template (the canvas effect
  // picks the doc up from here). The first status frame of a run with children swaps those for
  // one subgraph per instance.
  view = { doc, placeholder: null, note: note ?? notDrawnNotice(doc) ?? opaqueNotice(doc) };
  rerender();
}

/** Say so when a run's doc could not draw a Chart the run binds (ADR-0070, D-B): its Open body then
 *  shows the slot's own subgraph, and the server names why (`MachineDoc.chartsNotDrawn`). */
function notDrawnNotice(doc: MachineDoc): MachineView["note"] {
  const missing = doc.chartsNotDrawn ?? [];
  if (!missing.length) return null;
  return {
    notice: true,
    text: `this run binds a Chart this diagram does not draw — ${missing.map((m) => `body "${m.src}" (${m.path}): ${m.reason}`).join("; ")}`,
  };
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
    for (const r of runs) void refreshRun(r.runId, name);
  });
  feed.addEventListener("status", (e) => {
    const status = JSON.parse((e as MessageEvent<string>).data) as ObservedRun;
    dispatch({ kind: "status", status });
    void refreshRun(status.runId, name);
  });
  feed.addEventListener("gone", (e) => {
    const { runId } = JSON.parse((e as MessageEvent<string>).data) as { runId: string };
    dispatch({ kind: "gone", runId });
    // The reducer already dropped the card (a gate exists only while its state is entered —
    // ADR-0011); the re-fetch is the same frame-triggered discipline as `runs`/`status`, and its
    // 404 converges on the same empty answer.
    void refreshRun(runId, name);
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
    for (const r of runs) void refreshRun(r.runId, name);
  } catch {
    // transient — the next tick tries again
  }
}

async function snapshotFleet(): Promise<void> {
  try {
    const res = await fetch("/workflows");
    if (res.ok) dispatch({ kind: "workflows", workflows: (await res.json()) as WorkflowListing[] });
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
  cancelRun,
  steerTargets,
  steer,
  setToken,
  login: (issuer) => void login(issuer),
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
  // A return from the issuer first: it puts the address back, which the selection below reads.
  await finishLogin();
  rerender(); // the shell first — the fetches below fill it in
  void loadLogins().then(rerender);

  // The fleet first (the rail names everything), then the token (unlock is async and must not gate
  // observation), then the selection the address carries — deep links work on load.
  try {
    const res = await fetch("/workflows");
    if (res.ok) dispatch({ kind: "workflows", workflows: (await res.json()) as WorkflowListing[] });
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
