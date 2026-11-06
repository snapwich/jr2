// The run listing (ADR-0009): what `GET /runs` reads of its query, the summary of one run, and the
// cursor of a page. The live runs come from the host's registry and the ended runs from the store's
// listing columns (`SnapshotStore.ended`); `RunHost.history` joins the two halves in one order,
// newest start first, so a page is the same whichever half its runs are in.

import type { RunStarter } from "./callers.ts";
import { periodMs } from "./duration.ts";
import type { DispatchedBy } from "./registration.ts";

/**
 * One run as `GET /runs` lists it (ADR-0009): a summary, not the whole `RunStatus`. `status` is
 * `active` for a live run, else the store's word for how it ended. `reason` says why, where the
 * Machine did not: the host's reason (`drifted`, `lost`, ADR-0030), the Failure's reason
 * (`failed`, ADR-0073) or the fault (`error`). `endedAt` is the terminal write of an ended run.
 * `openGates` counts the Gates open now, so it is 0 for an ended run. `placing` names the child
 * paths of the Workspaces that wait for capacity (ADR-0064), and `dispatchedBy` the run that
 * started this one (ADR-0071).
 */
export type RunSummary = {
  runId: string;
  workflow: string;
  status: string;
  reason?: string;
  startedBy?: RunStarter;
  startedAt: string;
  endedAt?: string;
  assembly?: string;
  openGates: number;
  placing?: string[];
  dispatchedBy?: DispatchedBy;
  /** The space guard deleted the run's kept conversations (ADR-0065); the row stays. */
  swept?: "conversation swept: no space";
};

/** A page of the listing: the runs, and the cursor of the next page when there is one. */
export type RunPage = { runs: RunSummary[]; next?: string };

/** The statuses of an ended run, as the store writes them (ADR-0065, ADR-0025, ADR-0030, ADR-0073). */
export const ENDED_STATUSES: readonly string[] = ["done", "failed", "error", "cancelled", "stopped", "lost", "drifted"];

/** The status of a live run: the Machine's own word. */
export const LIVE_STATUS = "active";

/** How many runs a page holds when the query names no `limit`, and the most it can name. */
export const RUNS_PAGE_DEFAULT = 50;
export const RUNS_PAGE_MAX = 500;

/** The query of `GET /runs`, read. `ended` is the ended statuses to list, or `undefined` for none. */
export type RunListQuery = {
  live: boolean;
  ended?: readonly string[];
  workflow?: string;
  since?: string;
  after?: { startedAt: string; runId: string };
  limit: number;
};

/** An ISO-8601 date, or a date and time with an optional zone. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Read the query of `GET /runs`, or the refusal's text. `status` is `live` (the default), `ended`,
 * `all`, or a comma list of statuses and the two words; `since` is a duration back from `now`
 * (`"2h"`, `"7d"`) or an ISO-8601 time; `cursor` is a page's `next`; `limit` is 1 to
 * {@link RUNS_PAGE_MAX}.
 */
export function parseRunListQuery(
  q: { status?: string; workflow?: string; since?: string; cursor?: string; limit?: string },
  now: number,
): RunListQuery | { error: string } {
  let live = false;
  const ended = new Set<string>();
  for (const word of (q.status ?? "live").split(",").map((w) => w.trim())) {
    if (word === "live" || word === LIVE_STATUS) live = true;
    else if (word === "ended") for (const s of ENDED_STATUSES) ended.add(s);
    else if (word === "all") {
      live = true;
      for (const s of ENDED_STATUSES) ended.add(s);
    } else if (ENDED_STATUSES.includes(word)) ended.add(word);
    else {
      return {
        error: `status "${word}" is not one jr2 lists — use live, ended, all, or a comma list of ${[LIVE_STATUS, ...ENDED_STATUSES].join(", ")}`,
      };
    }
  }
  let since: string | undefined;
  if (q.since !== undefined) {
    const back = periodMs(q.since);
    // Only an ISO-8601 shape reaches `Date.parse`: it reads other text leniently, so `7` would be
    // a time in 2001 and list the whole history.
    const at = back !== undefined ? now - back : ISO_TIME.test(q.since) ? Date.parse(q.since) : Number.NaN;
    if (!Number.isFinite(at)) {
      return { error: `since "${q.since}" is not a duration (such as 2h or 7d) or an ISO-8601 time` };
    }
    // A duration longer than the clock goes back lists every run, as the sweep's `Math.max(0, …)`:
    // a time before 1970 is outside what `Date` can print at its far end.
    since = new Date(Math.max(at, 0)).toISOString();
  }
  let after: RunListQuery["after"];
  if (q.cursor !== undefined) {
    after = decodeCursor(q.cursor);
    if (!after) return { error: "cursor is not one that GET /runs gave — use the next of the page before" };
  }
  let limit = RUNS_PAGE_DEFAULT;
  if (q.limit !== undefined) {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > RUNS_PAGE_MAX) {
      return { error: `limit is a whole number from 1 to ${RUNS_PAGE_MAX}` };
    }
  }
  return {
    live,
    ...(ended.size ? { ended: [...ended] } : {}),
    ...(q.workflow !== undefined && q.workflow !== "" ? { workflow: q.workflow } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(after ? { after } : {}),
    limit,
  };
}

/** The cursor after `run`: its start and its id, which order the listing. Opaque to a reader. */
export function encodeCursor(run: { startedAt: string; runId: string }): string {
  return Buffer.from(JSON.stringify([run.startedAt, run.runId])).toString("base64url");
}

/** A cursor read back, or undefined when it is not one that {@link encodeCursor} made. */
export function decodeCursor(cursor: string): { startedAt: string; runId: string } | undefined {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const [startedAt, runId] = value as unknown[];
    if (typeof startedAt !== "string" || typeof runId !== "string") return undefined;
    if (!Number.isFinite(Date.parse(startedAt))) return undefined;
    return { startedAt, runId };
  } catch {
    return undefined;
  }
}

/** The listing's order: the newest start first, then the larger run id. */
export function newestFirst(a: RunSummary, b: RunSummary): number {
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
  return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0;
}

/** Whether `run` comes after the cursor `after` in the order. */
export function isAfter(
  run: { startedAt: string; runId: string },
  after: { startedAt: string; runId: string },
): boolean {
  return run.startedAt < after.startedAt || (run.startedAt === after.startedAt && run.runId < after.runId);
}

/** The child paths of every Workspace in `placing` (ADR-0064), at any depth, off the state values
 * alone. The root in `placing` is the empty path. */
export function placingOf(value: unknown, children: readonly PlacingChild[]): string[] {
  return [...(value === "placing" ? [""] : []), ...placingIn(children, [])];
}

/** The part of a `RunChild` that {@link placingOf} reads. */
export type PlacingChild = { id: string; value: unknown; children: readonly PlacingChild[] };

function placingIn(children: readonly PlacingChild[], path: string[]): string[] {
  return children.flatMap((child) => {
    const here = [...path, child.id];
    return [...(child.value === "placing" ? [here.join("/")] : []), ...placingIn(child.children, here)];
  });
}
