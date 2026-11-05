// The Console shell (ADR-0032): nav over a master–detail main — the fleet rail on the left, the
// selected workflow's Machine in the center, the Attention/Activity drawer on the right. One pure
// render over the store plus the bootstrap's working state; Preact's diff replaces main.js's
// hand-rolled memo()/paint() machinery (ADR-0034). Which drawer tab the reader chose is view state
// like the zoom — component state, never the store's.

import { Fragment, h, type JSX } from "preact";
import { useState } from "preact/hooks";
import {
  may,
  selectedRun,
  selectedRunFailure,
  selectedRunStarter,
  selectedRunGates,
  selectedRunHeld,
  selectedRunWaiting,
  type Frame,
  type Store,
} from "../store.ts";
import type { MachineDoc } from "../canvas.ts";
import type { LoginIssuer } from "../login.ts";
import { Nav } from "./nav.ts";
import { Fleet } from "./fleet.ts";
import { Drawer, type DrawerTab } from "./drawer.ts";
import { MachinePane } from "./machine-pane.ts";

/**
 * What the bootstrap (main.ts) hands the components: every write path in one object, so no
 * component ever reaches a fetch, the history API, or the canvas on its own. `dispatch` stays the
 * store's one door (ADR-0032 store-first); the rest wrap the guarded surface and the viewport.
 */
export type AppApi = {
  /** Fold one frame into the store and re-render — the ONLY way belief changes. */
  dispatch(frame: Frame): void;
  /** Move the selection: address, store, feed, diagram — `push` on a click that moves. */
  selectWorkflow(name: string | null, opts?: { push?: boolean; runId?: string | null }): Promise<void>;
  toggleStartForm(name: string): Promise<void>;
  /** POST the start body; resolves to an inline error string, or null when the run started. */
  startRun(name: string, body: Record<string, unknown>): Promise<string | null>;
  /** POST one gate event; same contract as {@link AppApi.startRun}. */
  deliverGate(runId: string, gate: string, event: string, body: Record<string, unknown>): Promise<string | null>;
  /** POST CANCEL to a run (ADR-0002); same contract as {@link AppApi.startRun}. */
  cancelRun(runId: string): Promise<string | null>;
  /** The run's conversation list (`GET /runs/:id/agents`), or the refusal's text. */
  steerTargets(runId: string): Promise<AgentLine[] | string>;
  /** POST one Steering message to an Agent slot of a run; same contract as {@link AppApi.startRun}. */
  steer(runId: string, agent: string, text: string): Promise<string | null>;
  /** Keep a typed credential (empty clears it) and ask `GET /whoami` what it may do. */
  setToken(value: string): void;
  /** Go to an issuer to log in (OIDC code + PKCE, ADR-0032). */
  login(issuer: LoginIssuer): void;
  /** The canvas reports its zoom readout through here (nav renders it). */
  onScale(pct: number): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  zoomFit(): void;
};

/** One Agent slot of a run, as `GET /runs/:id/agents` lists it (ADR-0002): whether it has an open
 *  Turn, and whether a Caller may steer it. */
export type AgentLine = { agent: string; open: boolean; steerable: boolean };

/** The center pane's working state — the machine doc in hand (or why there is none). Fetch
 *  bookkeeping like main.ts's doc cache, deliberately NOT store belief: the doc is structure the
 *  server serves, and `dispatch` stays the only door into what the page believes. */
export type MachineView = {
  doc: MachineDoc | null;
  /** `/` — nothing selected; the canvas says what to do instead. */
  placeholder: string | null;
  /** An error ("no workflow"), or — with `notice` — a caveat about the diagram (opaque states). */
  note: { text: string; notice: boolean } | null;
};

export function App(props: {
  store: Store;
  view: MachineView;
  zoomPct: number;
  initialToken: string;
  logins: readonly LoginIssuer[];
  loginNote: string | null;
  schemas: ReadonlyMap<string, unknown>;
  api: AppApi;
}): JSX.Element {
  const { store, view, zoomPct, initialToken, logins, loginNote, schemas, api } = props;
  const run = selectedRun(store);
  // A settled run takes no cancel and no Steering message; a live one, as its Caller's scopes allow.
  const live = run !== null && store.runs.has(run.runId);
  const [chosenTab, setChosenTab] = useState<DrawerTab>("attention");
  return h(
    Fragment,
    null,
    h(Nav, {
      store,
      machineId: view.doc?.id ?? null,
      zoomPct,
      initialToken,
      logins,
      loginNote,
      onChooseTab: setChosenTab,
      api,
    }),
    h(
      "main",
      null,
      h(Fleet, { store, schemas, api }),
      h(MachinePane, {
        view,
        run,
        selectedNodeId: store.selectedNodeId,
        gates: selectedRunGates(store),
        waiting: selectedRunWaiting(store),
        held: selectedRunHeld(store),
        failure: selectedRunFailure(store),
        starter: selectedRunStarter(store),
        canCancel: live && may(store, "cancel", run.workflow),
        canSteer: live && may(store, "steer", run.workflow),
        api,
      }),
      h(Drawer, { store, chosenTab, onChooseTab: setChosenTab, api }),
    ),
  );
}
