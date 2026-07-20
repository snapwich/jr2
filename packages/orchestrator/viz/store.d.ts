// Types for store.js. The reducer itself is plain .js because the browser loads it unbuilt (this
// package ships no bundler — see http.ts's `/viz/*` assets); this file is what lets the TS test
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

/** One frame off the workflow feed, already parsed (ADR-0022). */
export type Frame =
  | { kind: "runs"; runs: ObservedRun[] }
  | { kind: "status"; status: ObservedRun }
  | { kind: "gone"; runId: string }
  | { kind: "emit"; runId: string; type: string };

export type Store = {
  runs: Map<string, ObservedRun>;
  settled: Map<string, ObservedRun>;
  emits: Array<{ runId: string; type: string }>;
  selectedRunId: string | null;
  connection: "connecting" | "live" | "retrying";
};

export const SETTLED_CAP: number;
export const EMIT_CAP: number;

export function emptyStore(): Store;
export function applyFrame(store: Store, frame: Frame): Store;
export function selectedRun(store: Store): ObservedRun | null;
export function runList(store: Store): Array<{ run: ObservedRun; settled: boolean }>;
