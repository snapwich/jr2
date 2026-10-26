// When a run is settled, for the e2e and @model steps that poll `jr2 status` (ADR-0073): every
// Run status that is not live. A run is live while `jr2 status` says `active` (the store says
// `live`); each other status is an end — `done`, `failed`, `error`, `cancelled`, `lost`, `drifted`.
// A loop that waits only for `done` or `error` polls a `failed` or `cancelled` run until its
// timeout. Pure, so a unit test pins it without a cluster.

/** The Run statuses of a run that is not settled. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(["active", "live"]);

/** Is a run with this status settled? True for each status that is not live. */
export function isSettled(status: string | undefined): boolean {
  return status !== undefined && !LIVE_STATUSES.has(status);
}
