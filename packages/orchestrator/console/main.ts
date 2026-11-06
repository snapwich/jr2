// The jr2 Console — one shell, master–detail (ADR-0032). The left rail is the FLEET (every
// registered workflow, each expandable to its runs); the center is the selected workflow's Machine,
// fetched from GET /workflows/:name/machine, laid out with elkjs (loaded as a UMD script ->
// window.ELK), rendered as nested SVG (canvas.ts) and live-highlighted by the selected run; the
// right drawer is Attention (the gate inbox) and Activity (the emit log); the bottom drawer is the
// selected run's kept conversations, one tab for each Agent slot, with the Steering box.
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
// (ADR-0078): start (POST /workflows/:name/runs), the Gate cards (GET /gates read again on each
// frame, POST /runs/:id/gates/:gate/events), cancel (POST /runs/:id/events), the ended runs in the
// rail (GET /runs?status=ended), the conversations (GET /runs/:id/conversations and its routes,
// ADR-0023), the Steering box (GET /runs/:id/agents, POST /runs/:id/steering). Any later 401 drops
// the whole page back to observer mode. That is ADR-0032 end to end — the bands themselves never
// moved.
//
// The guarded streams (a conversation's `/events`) are read with `fetch`, never an EventSource: an
// EventSource cannot send the credential, and the credential never rides a URL or a cookie.
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
// A run on an older Assembly (ADR-0069) draws its own Machine too: the current Machine's states are
// not the ones it moves through. So the doc the center pane draws is chosen per selection
// (`selectedDocSource`): the Workflow's Machine, or the run's own from
// `GET /workflows/:name/runs/:runId/machine`, cached per run id. The live child still joins its
// subgraph by `src`, which the per-run doc keeps as the body's slot key. A `drifted` run has no
// Machine to draw: the pane says why in place of the graph.

import { h, render } from "preact";
import {
  activeSlot,
  applyFrame,
  emptyStore,
  failureReason,
  machineDocSource,
  may,
  selectedDocSource,
  selectedRunDrift,
  slotConversations,
  type CallerView,
  type Frame,
  type InboxGate,
  type ObservedRun,
  type RunSummaryView,
  type Store,
  type HeldLine,
  type StarterView,
  type WaitingLine,
  type WorkflowListing,
} from "./store.ts";
import { readSse, type AgentLine, type ConversationEntry, type ConversationRow } from "./conversation.ts";
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
import { App, type AppApi, type MachineView } from "./components/app.ts";

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
  const before = store;
  store = applyFrame(store, frame);
  rerender();
  // A frame can change which doc the pane draws: a new selection, a run selected, a run that now
  // binds a Chart. The check is a key compare; only a change fetches.
  void syncMachine();
  // A frame can change the selected run, or the slot the bottom drawer shows: read what it needs.
  syncTalk();
  // A new selection: read its details (waits, picks, failure, starter) and, for an ended run opened
  // from the rail, its last status, so the graph lights where it ended.
  if (store.selectedRunId !== before.selectedRunId) readSelected();
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
  // Seed the inbox, the ended runs, the conversations and the run details from what the page
  // already holds: the frames that carried them came before the credential, so they read nothing.
  refreshInbox();
  if (store.workflow) void refreshHistory(store.workflow);
  if (store.selectedRunId) void refreshTalk(store.selectedRunId);
  readSelected();
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

// ---- The Gate inbox (frame-triggered — ADR-0011, ADR-0032) --------------------------------------

/** One read of `key` at a time, and one more after it when something asked meanwhile, with the
 *  arguments of the last ask: a burst of frames that each ask for one run's reads makes two reads,
 *  not one for each frame. Fetch bookkeeping, not belief. */
function coalesced<A extends unknown[]>(
  read: (key: string, ...args: A) => Promise<void>,
): (key: string, ...args: A) => void {
  const asked = new Map<string, A | null>(); // a key in flight: the arguments of the ask after it
  const ask = (key: string, ...args: A): void => {
    if (asked.has(key)) {
      asked.set(key, args);
      return;
    }
    asked.set(key, null);
    read(key, ...args)
      .catch(() => {
        // transient — the next frame reads again
      })
      .finally(() => {
        const again = asked.get(key);
        asked.delete(key);
        if (again) ask(key, ...again);
      });
  };
  return ask;
}

/** The inbox read in flight, and whether a frame asked for another while it was out. Fetch
 *  bookkeeping like `docs`, not belief: a feed frame and a fleet snapshot each ask, so one read at a
 *  time, and one more after it when something asked meanwhile, keeps a burst of frames to two reads.
 *  The read that STARTED last speaks: an answer that a newer read superseded is dropped. */
let inboxReading = false;
let inboxAgain = false;

/** Read `GET /gates`, every open Gate that the Caller may answer, and fold the WHOLE answer in.
 *  Called on every frame that touches a run — that is the synchronization: a Gate opens with a
 *  state entry and closes with its exit, and every entry/exit lands a frame. A delivery's success
 *  is the next read coming back without the card; nothing here concludes anything on its own. */
function refreshInbox(): void {
  // Observer mode, or a Caller with no `answer`: the server would refuse the read (ADR-0032).
  if (!may(store, "answer")) return;
  if (inboxReading) {
    inboxAgain = true;
    return;
  }
  inboxReading = true;
  // The credential this read speaks for: an answer that lands after another Caller went live is
  // the old Caller's, and is dropped (the read that follows speaks for the new one).
  const serial = tokenSerial;
  void (async () => {
    try {
      const res = await gfetch("/gates");
      if (serial !== tokenSerial) inboxAgain = true;
      else if (res?.ok) dispatch({ kind: "inbox", gates: ((await res.json()) as { gates: InboxGate[] }).gates });
    } catch {
      // transient — the next frame reads again
    } finally {
      inboxReading = false;
      if (inboxAgain) {
        inboxAgain = false;
        refreshInbox();
      }
    }
  })();
}

// ---- Run details: waits, picks, failure, starter (frame-triggered — ADR-0064, ADR-0024) ---------

/** Per-run re-fetch serials — fetch bookkeeping like `docs`, not belief. The browser runs these
 *  requests on parallel connections, so answers can land out of ORDER, and an older answer folded
 *  last would bring back a wait the server already cleared. Only the latest-STARTED re-fetch may
 *  speak for a run; superseded answers are dropped before they reach the store. */
const runFetchSerial = new Map<string, number>();

/** Re-read one run's status off the guarded surface: why its Workspaces in `placing` wait
 *  (ADR-0064), its outstanding picks (ADR-0024), its Failure's reason (ADR-0073) and who started it
 *  (ADR-0078), each folded as its own frame. Called for the selected run only, on its selection and
 *  on every frame that touches it: a Workspace enters and leaves `placing` with a frame. For an ended run that the page does not
 *  watch, the same answer is its last status (ADR-0032). */
async function readRun(runId: string, workflow: string): Promise<void> {
  // Observer mode, or a Caller that may not read this Workflow: the server would refuse the read,
  // so the page does not make it (ADR-0032).
  if (!may(store, "read", workflow)) return;
  const serial = (runFetchSerial.get(runId) ?? 0) + 1;
  runFetchSerial.set(runId, serial);
  const res = await gfetch(`/runs/${encodeURIComponent(runId)}`);
  if (!res) return; // 401 already dropped the page to observer
  // !ok: swept — nothing waits.
  const body = res.ok
    ? ((await res.json()) as ObservedRun & {
        output?: unknown;
        waiting?: WaitingLine[];
        held?: HeldLine[];
        startedBy?: StarterView;
      })
    : null;
  if (runFetchSerial.get(runId) !== serial) return; // superseded — a newer re-fetch owns the answer
  dispatch({ kind: "waiting", runId, workflow, waiting: body?.waiting ?? [], held: body?.held ?? [] });
  if (!body) return; // a 404 says nothing of the run's end or its starter, so what the page has stays
  // An ended run: its last status, held with the runs the page watched end (the store keeps it
  // only for a run that is not live and that the rail lists).
  if (body.status !== "active") {
    dispatch({
      kind: "endedStatus",
      status: {
        runId: body.runId,
        workflow: body.workflow,
        status: body.status,
        value: body.value,
        children: body.children ?? [],
        ...(body.bound ? { bound: true as const } : {}),
        ...(body.chartHashes ? { chartHashes: body.chartHashes } : {}),
        ...(body.dispatchedBy ? { dispatchedBy: body.dispatchedBy } : {}),
        ...(body.dispatched ? { dispatched: body.dispatched } : {}),
      },
    });
  }
  // The reason of a run that ended `failed` (ADR-0073), and who started the run (ADR-0078).
  dispatch({ kind: "failure", runId, reason: failureReason(body) });
  dispatch({ kind: "starter", runId, startedBy: body.startedBy ?? null });
}

/** {@link readRun}, one read for each run at a time: status frames come on every save. */
const refreshRun = coalesced(readRun);

/** Read the selected run's details. The Console shows waits, picks, a failure and a starter for the
 *  selected run only, so it reads no other run's. */
function readSelected(): void {
  const id = store.selectedRunId;
  if (!id || !store.workflow) return;
  void refreshRun(id, store.workflow);
}

// ---- The ended runs of the selection (ADR-0009, ADR-0032) ---------------------------------------

/** Serial of the history reads, so an answer for a Workflow the reader left is dropped. */
let historySerial = 0;

/** Read the selected Workflow's ended runs (`GET /runs?status=ended&workflow=`), the first page:
 *  what the rail lists under the live runs. Needs `read`; without it the rail lists live runs only. */
async function refreshHistory(workflow: string): Promise<void> {
  if (!may(store, "read", workflow)) return;
  const serial = ++historySerial;
  try {
    const res = await gfetch(`/runs?status=ended&workflow=${encodeURIComponent(workflow)}`);
    if (!res?.ok || serial !== historySerial) return;
    const { runs } = (await res.json()) as { runs: RunSummaryView[] };
    dispatch({ kind: "history", workflow, runs });
  } catch {
    // transient — the next snapshot reads again
  }
}

// ---- The Assembly (ADR-0069) --------------------------------------------------------------------

/** Read the current Assembly and the one each live run holds (open): what marks a run "older
 *  Assembly". An Orchestrator with no Assembly answers `current: null`, and nothing is marked. */
async function readAssembly(): Promise<void> {
  try {
    const res = await fetch("/assembly");
    if (!res.ok) return;
    const body = (await res.json()) as {
      current: { hash: string } | null;
      held?: Array<{ hash: string; runs: string[] }>;
    };
    dispatch({ kind: "assembly", current: body.current?.hash ?? null, held: body.held ?? [] });
  } catch {
    // transient — the next snapshot reads again
  }
}

/** {@link readAssembly}, one read at a time. */
const assemblyRead = coalesced(() => readAssembly());
function refreshAssembly(): void {
  assemblyRead("assembly");
}

/** The live runs a frame named that the Assembly was read again for: once for each run, so a run
 *  that holds no Assembly does not make a read on each frame. */
const assemblyAsked = new Set<string>();

/** A live run that the page does not know the Assembly of: it started after the last read, maybe
 *  on an Assembly published since. Its Machine is drawn from the Assembly it holds, so read again. */
function heldUnknown(runs: ObservedRun[]): void {
  if (store.assembly.current === null) return; // an Orchestrator with no Assembly marks nothing
  let ask = false;
  for (const r of runs) {
    if (r.status !== "active" || store.assembly.held.has(r.runId) || assemblyAsked.has(r.runId)) continue;
    assemblyAsked.add(r.runId);
    ask = true;
  }
  if (ask) refreshAssembly();
}

// ---- The kept conversations (ADR-0023, ADR-0032) ------------------------------------------------
// The bottom drawer shows the selected run's conversations, one tab for each Agent slot. The list
// is read on each frame of the run; the entries of the shown slot are read when the drawer is open:
// a closed conversation as pages, an open one as a stream that follows the Turn. Fetch bookkeeping,
// not belief: the entries themselves are in the store.

/** The run the conversations were last read for. */
let talkRun: string | null = null;
/** The open streams, by Instance ID. */
const followers = new Map<string, AbortController>();
/** The conversations whose kept pages are read, or are being read. */
const loaded = new Set<string>();
/** The conversations whose stream ended and that the list has not said again are open: a stream
 *  starts again only after a list read after its end, so a stale `open` does not start a loop. */
const ended = new Set<string>();
/** The size of each conversation at the last list read: a closed conversation that grew after the
 *  page read it (a batch the Harness sent late) is read again after what the page holds. */
const rowBytes = new Map<string, number>();
/** Serial of the list reads of the selected run. */
let talkSerial = 0;

/** The entries the Console asks for in one page of a conversation route (`limit`; at most `CONVERSATION_PAGE_MAX` in http.ts). */
const ENTRY_PAGE = 1000;

function stopFollowers(keep: (instanceId: string) => boolean = () => false): void {
  for (const [iid, ctl] of followers) {
    if (keep(iid)) continue;
    ctl.abort();
    followers.delete(iid);
  }
}

/** Bring the reads in line with the selection: another run starts from nothing; the same run reads
 *  what the shown slot needs. Safe to call on every frame — a read starts only once. */
function syncTalk(): void {
  const runId = store.selectedRunId;
  if (runId !== talkRun) {
    stopFollowers();
    loaded.clear();
    ended.clear();
    rowBytes.clear();
    talkRun = runId;
    if (runId) void refreshTalk(runId);
    return;
  }
  if (store.token !== "live") {
    // A credential that went drops the entries (`store.talk`), so the next live one reads each
    // conversation again.
    loaded.clear();
    ended.clear();
    rowBytes.clear();
  }
  if (!runId || !store.bottom.open || store.token !== "live") return stopFollowers();
  const shown = slotConversations(store, activeSlot(store));
  const ids = new Set(shown.map((c) => c.row.instanceId));
  stopFollowers((iid) => ids.has(iid));
  for (const { row, ended: end } of shown) {
    const iid = row.instanceId;
    if (followers.has(iid) || row.swept || end?.cut || end?.swept) continue;
    if (row.open && !ended.has(iid)) void follow(runId, iid);
    else if (!loaded.has(iid)) void loadConversation(runId, iid);
  }
}

/** Read the selected run's conversation list (`read`) and its Agent slots for Steering (`steer`,
 *  live runs only). The answer for a run the reader left is dropped. */
async function readTalk(runId: string): Promise<void> {
  const workflow = store.workflow;
  if (!workflow || store.token !== "live") return;
  const serial = ++talkSerial;
  if (may(store, "read", workflow)) {
    try {
      const res = await gfetch(`/runs/${encodeURIComponent(runId)}/conversations`);
      if (res?.ok && serial === talkSerial && store.selectedRunId === runId) {
        const rows = (await res.json()) as ConversationRow[];
        ended.clear();
        for (const row of rows) {
          const before = rowBytes.get(row.instanceId);
          if (!row.open && before !== undefined && row.bytes > before) loaded.delete(row.instanceId);
          rowBytes.set(row.instanceId, row.bytes);
        }
        dispatch({ kind: "conversations", runId, rows });
      }
    } catch {
      // transient — the next frame reads again
    }
  }
  if (may(store, "steer", workflow) && store.runs.has(runId)) {
    try {
      const res = await gfetch(`/runs/${encodeURIComponent(runId)}/agents`);
      if (res?.ok && store.selectedRunId === runId) {
        dispatch({ kind: "agents", runId, agents: (await res.json()) as AgentLine[] });
      }
    } catch {
      // transient — the next frame reads again
    }
  }
}

/** {@link readTalk}, one read for each run at a time: status frames come on every save. */
const refreshTalk = coalesced(readTalk);

/** The last sequence number the page holds of a conversation, or -1. */
function lastSeq(instanceId: string): number {
  const kept = store.talk?.entries.get(instanceId);
  return kept?.length ? kept[kept.length - 1]!.seq : -1;
}

/** The conversation route of one Instance ID: the ID is one URL-encoded segment. */
function conversationPath(runId: string, instanceId: string): string {
  return `/runs/${encodeURIComponent(runId)}/conversations/${encodeURIComponent(instanceId)}`;
}

/** Read a conversation that is not open, a page at a time, after what the page holds. */
async function loadConversation(runId: string, instanceId: string): Promise<void> {
  loaded.add(instanceId);
  try {
    for (;;) {
      const res = await gfetch(
        `${conversationPath(runId, instanceId)}?after=${lastSeq(instanceId)}&limit=${ENTRY_PAGE}`,
      );
      if (!res?.ok || store.selectedRunId !== runId) return;
      const entries = (await res.json()) as ConversationEntry[];
      dispatch({ kind: "entries", runId, instanceId, entries });
      if (entries.length < ENTRY_PAGE) return;
    }
  } catch {
    loaded.delete(instanceId); // the next sync reads again
  }
}

/** Follow an open conversation (`/events`): what is kept after what the page holds, then each new
 *  entry, until the server ends the stream (the Turn closed, or the conversation was cut or swept)
 *  or the page stops it. Then the list is read again, so the tab's dot and the next Turn are seen. */
async function follow(runId: string, instanceId: string): Promise<void> {
  const ctl = new AbortController();
  followers.set(instanceId, ctl);
  let finished = false;
  try {
    const res = await fetch(`${conversationPath(runId, instanceId)}/events?after=${lastSeq(instanceId)}`, {
      headers: { authorization: `Bearer ${token()}`, accept: "text/event-stream" },
      signal: ctl.signal,
    });
    if (res.status === 401) return dispatch({ kind: "token", state: "invalid" });
    if (!res.ok || !res.body) {
      finished = true;
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const { events, rest } = readSse(buffer + value);
      buffer = rest;
      for (const ev of events) {
        if (ev.event === "entry") {
          dispatch({ kind: "entries", runId, instanceId, entries: [JSON.parse(ev.data) as ConversationEntry] });
        } else if (ev.event === "end") {
          const end = JSON.parse(ev.data) as { cut?: boolean; swept?: string };
          dispatch({ kind: "conversationEnd", runId, instanceId, cut: end.cut === true, swept: end.swept });
        }
      }
    }
    finished = true;
  } catch {
    // aborted by the page, or the connection dropped: the next sync decides again
  } finally {
    if (followers.get(instanceId) === ctl) followers.delete(instanceId);
    if (finished && store.selectedRunId === runId) {
      ended.add(instanceId);
      loaded.add(instanceId);
      void refreshTalk(runId);
    }
  }
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
  refreshInbox(); // a run can open a Gate at its first state
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
  // frame triggers the inbox read, and the read leaves the card out (ADR-0032).
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
  if (moved && name) void refreshHistory(name);
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
  // A drifted run has no Machine that this Orchestrator can read (ADR-0030): say why, and draw none.
  const drift = selectedRunDrift(store);
  if (drift !== null) {
    const key = `drift:${store.selectedRunId}`;
    if (shownKey === key) return;
    shownKey = key;
    view = { doc: null, placeholder: null, note: { text: `drifted: ${drift}`, notice: true } };
    rerender();
    return;
  }
  const source = selectedDocSource(store);
  if (!source || source.key === shownKey) return;
  shownKey = source.key;
  let doc = await fetchDoc(source);
  if (shownKey !== source.key) return; // the reader moved on while the fetch was out
  let note: MachineView["note"] = null;
  if (!doc && source.key.startsWith("run:")) {
    // The run's own Machine could not be read (an Orchestrator older than the route, or the run
    // left the store): draw the Workflow's, and say the run's own states are not in it.
    doc = await fetchDoc(machineDocSource(name, null, false, store.assembly.current));
    if (shownKey !== source.key) return;
    note = {
      text: "this run's own Machine could not be read: this is the current Machine, and the run's states can differ",
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
    heldUnknown(runs);
    refreshInbox();
    readSelected();
    if (store.selectedRunId) void refreshTalk(store.selectedRunId);
  });
  feed.addEventListener("status", (e) => {
    const status = JSON.parse((e as MessageEvent<string>).data) as ObservedRun;
    dispatch({ kind: "status", status });
    heldUnknown([status]);
    refreshInbox();
    if (status.runId === store.selectedRunId) void refreshRun(status.runId, name);
    // A Turn opens and closes with a state entry and exit: the slot's dot and its stream follow.
    if (status.runId === store.selectedRunId) void refreshTalk(status.runId);
  });
  feed.addEventListener("gone", (e) => {
    const { runId } = JSON.parse((e as MessageEvent<string>).data) as { runId: string };
    dispatch({ kind: "gone", runId });
    // The reducer already dropped the card (a gate exists only while its state is entered —
    // ADR-0011); the inbox read is the same frame-triggered discipline as `runs`/`status`. The run
    // is an ended run now: the rail's list of them is read again.
    refreshInbox();
    if (runId === store.selectedRunId) void refreshRun(runId, name);
    void refreshHistory(name);
    if (runId === store.selectedRunId) void refreshTalk(runId);
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
// (`GET /workflows/:name/runs`) on an interval and on tab focus, folded through the same reducer.
// Each round reads the inbox once more (it is fleet-wide), the Assembly, and the selection's ended
// runs and conversations.

const SNAPSHOT_MS = 10_000;

async function snapshotWorkflow(name: string): Promise<void> {
  try {
    const res = await fetch(`/workflows/${encodeURIComponent(name)}/runs`);
    if (!res.ok) return;
    const runs = (await res.json()) as ObservedRun[];
    dispatch({ kind: "fleet", workflow: name, runs });
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
  void refreshAssembly();
  refreshInbox();
  if (store.workflow) void refreshHistory(store.workflow);
  if (store.selectedRunId) void refreshTalk(store.selectedRunId);
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
  void refreshAssembly();
  await selectWorkflow(workflowFromPath(), { push: false });
  void snapshotFleet();
}

boot().catch((err: unknown) => {
  view = { doc: null, placeholder: null, note: { text: String(err), notice: false } };
  rerender();
});
