// Types for store.js. The reducer itself is plain .js because the browser loads it unbuilt (this
// package ships no bundler — see http.ts's `/assets/*` routes); this file is what lets the TS test
// suite hold it to a contract.

/** A run as the OPEN observation band reports it (ADR-0014): identity and where it is, nothing of
 *  what it is carrying. Mirrors `RunObservation` in run-host.ts. */
export type ObservedRun = {
  runId: string;
  workflow: string;
  status: string;
  value: unknown;
  children: Array<Record<string, unknown>>;
};

/** One open gate as `GET /runs/:id` reports it — mirrors `GateView` in run-host.ts. */
export type GateCard = {
  gate: string;
  path: string[];
  accepts: Array<{ name: string; description?: string; input: unknown }>;
  meta?: Record<string, unknown>;
};

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
  | { kind: "workflows"; workflows: string[] }
  | { kind: "select"; workflow: string | null }
  | { kind: "selectRun"; runId: string | null }
  | { kind: "selectNode"; nodeId: string | null }
  | { kind: "fleet"; workflow: string; runs: ObservedRun[] }
  | { kind: "toggleWorkflow"; workflow: string }
  | { kind: "token"; state: TokenState }
  | { kind: "gates"; runId: string; workflow: string; gates: GateCard[] }
  | { kind: "inboxScope"; all: boolean }
  | { kind: "startForm"; workflow: string | null };

export type Store = {
  runs: Map<string, ObservedRun>;
  settled: Map<string, ObservedRun>;
  emits: Array<{ runId: string; type: string }>;
  selectedRunId: string | null;
  selectedNodeId: string | null;
  connection: "connecting" | "live" | "retrying";
  workflow: string | null;
  workflows: string[];
  fleet: Map<string, ObservedRun[]>;
  expanded: Set<string>;
  token: TokenState;
  gates: Map<string, { workflow: string; gates: GateCard[] }>;
  inboxAll: boolean;
  startFormFor: string | null;
};

export const SETTLED_CAP: number;
export const EMIT_CAP: number;

export function emptyStore(): Store;
export function applyFrame(store: Store, frame: Frame): Store;
export function selectedRun(store: Store): ObservedRun | null;
export function runList(store: Store): Array<{ run: ObservedRun; settled: boolean }>;
export function fleetRuns(store: Store, workflow: string): Array<{ run: ObservedRun; settled: boolean }>;
export function visibleGates(store: Store): Array<{ runId: string; workflow: string; gates: GateCard[] }>;
export function selectedRunGates(store: Store): GateCard[];
export function gateCount(store: Store): number;
