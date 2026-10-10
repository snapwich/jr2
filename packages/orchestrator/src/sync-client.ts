// The sync's client (ADR-0067): after a signed push, the Orchestrator asks the Workspace's Harness to
// move the Agent's branch to the signed commits (`POST /sync`), carrying the bundle the Sandbox
// Effector wrote. The bundle travels through here, never through a shared volume: the Worktree is
// read-only on the credentialed side, and nothing the Effector writes is a channel into the Agent's
// container but this one call, which moves one ref. The Harness's answer is a report the next push
// never trusts.

import type { SyncAnswer, SyncRequest } from "./wire.ts";

/** The Harness's sync, as a push drives it. It never throws: a Harness that cannot be reached, or
 * that refuses, answers `not-synced` with the reason — the push's outcome stands either way. */
export interface SyncPort {
  sync(req: SyncRequest, signal: AbortSignal): Promise<SyncAnswer>;
}
export type SyncPortFactory = (endpoint: string, bearer?: string) => SyncPort;

/** How long a sync may take before it answers `not-synced`: its git steps are bounded at 120 s each. */
const SYNC_TIMEOUT_MS = 5 * 60_000;

export function createSyncPort(options: {
  baseUrl: string;
  /** The Workspace's Harness bearer (ADR-0058). */
  token?: string;
  /** Injectable for socket-free tests. Default: global `fetch`. */
  fetch?: typeof fetch;
}): SyncPort {
  const fetchImpl = options.fetch ?? fetch;
  return {
    sync: async (req, signal) => {
      const url = new URL("/sync", options.baseUrl).toString();
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          body: JSON.stringify(req),
          // Bounded: a Harness that never answers is a sync that did not finish, never a push held open.
          signal: AbortSignal.any([signal, AbortSignal.timeout(SYNC_TIMEOUT_MS)]),
        });
        const text = await res.text();
        if (!res.ok) return { sync: "not-synced", reason: `the Harness refused the sync (${res.status}): ${text}` };
        return JSON.parse(text) as SyncAnswer;
      } catch (err) {
        return { sync: "not-synced", reason: `the Harness could not be reached: ${(err as Error).message}` };
      }
    },
  };
}

/** The real factory: the Workspace's Harness, with its bearer. */
export const harnessSyncPort: SyncPortFactory = (endpoint, bearer) =>
  createSyncPort({ baseUrl: endpoint, ...(bearer ? { token: bearer } : {}) });
