// The shared HTTP client every `j2` verb sits on (ADR-0009). One thin class over the orchestrator's
// REST + SSE surface (`createApp`) — the SAME wire the deployed orchestrator serves, so `j2` against
// the e2e tier's host-booted fixture and against a cluster are one code path. It carries no folder/CLI concerns (those
// live in `instance.ts`); it is just "talk to a base URL".
//
// `fetchImpl` is injectable so tests drive it with a hono `app.request` (no socket) the same way the
// orchestrator's own http tests do; in production it defaults to the global `fetch`.

import type { MachineDoc, RepoStatus } from "@j2/orchestrator";
import { parseSSE } from "./sse.ts";

/** A run's current observable state — mirrors the orchestrator's `RunStatus` (run-host.ts). */
export type RunStatus = {
  runId: string;
  workflow: string;
  instanceId: string;
  status: string;
  value: unknown;
  context: unknown;
  /** Why the host set this status, for statuses the Machine did not choose — `drifted` says the
   * workflow changed shape since the run was saved, and names both fingerprints (ADR-0030). */
  reason?: string;
};

/** One item on a run's observation feed — mirrors the orchestrator's `RunFeedEvent`. */
export type RunFeedEvent =
  | { kind: "status"; status: RunStatus }
  | { kind: "emit"; event: { type: string } & Record<string, unknown> }
  | { kind: "retry"; child: string; attempt: number; reason: string };

/** A run-control event posted to a live run (ADR-0013): CANCEL is the vocabulary that is left. */
export type RunEvent = { type: string };

/** The subset of `fetch` the client uses. `globalThis.fetch` and hono's `app.request` both satisfy it. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const JSON_HEADERS = { "content-type": "application/json" };

/** The prefix-resolution route. Named because `run-id.ts` matches on it to tell "no run by that
 * prefix" apart from "this instance predates the route entirely" (ADR-0009). */
export const RESOLVE_PATH = "/runs/resolve";

/** What an orchestrator says it is (`GET /healthz`). Both fields are optional because an instance
 * deployed before `/healthz` grew them answers a bare `{ ok: true }` — the absence is itself skew
 * evidence, so it must not be an error. */
export type InstanceIdentity = { version?: string; hash?: string };

/**
 * A non-2xx from the orchestrator, with the status code and path KEPT (ADR-0009). The bare `Error`
 * this replaces flattened every failure to a message string, which made "unknown run" and "this
 * instance has no such route" indistinguishable — the difference between a real 404 and version
 * skew. Callers branch on `status`/`path`; `instance` is the best-effort identity probed at throw
 * time, while the transport (a port-forward that the command's `finally` is about to close) is
 * still open.
 */
export class J2HttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly instance?: InstanceIdentity;

  constructor(message: string, status: number, path: string, instance?: InstanceIdentity) {
    super(message);
    this.name = "J2HttpError";
    this.status = status;
    this.path = path;
    this.instance = instance;
  }
}

export class J2Client {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  /** The Instance token (ADR-0013). The run and gate surfaces are authenticated; without it every
   * call below is a 401. Absent only for an unauthenticated surface (a test's in-process app). */
  private readonly token?: string;

  constructor(baseUrl: string, fetchImpl: FetchLike = globalThis.fetch, token?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.token = token;
  }

  /** Request headers: the bearer, plus whatever the call adds. */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { ...extra, authorization: `Bearer ${this.token}` } : extra;
  }

  /** `GET /workflows` — names of the registered workflows. */
  async workflows(): Promise<string[]> {
    return (await this.json(await this.fetchImpl(`${this.baseUrl}/workflows`), "/workflows")) as string[];
  }

  /** `GET /workflows/:name/machine` — the workflow's Machine as the Console's DTO. */
  async machine(workflow: string): Promise<MachineDoc> {
    const res = await this.fetchImpl(`${this.baseUrl}/workflows/${encodeURIComponent(workflow)}/machine`);
    return (await this.json(res, "/workflows/:name/machine")) as MachineDoc;
  }

  /** `POST /workflows/:name/runs` — start a run; unknown workflow → 404 → throws. */
  async start(workflow: string, input: Record<string, unknown> = {}): Promise<{ runId: string; instanceId: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/workflows/${encodeURIComponent(workflow)}/runs`, {
      method: "POST",
      headers: this.headers(JSON_HEADERS),
      body: JSON.stringify(input),
    });
    return (await this.json(res, "/workflows/:name/runs")) as { runId: string; instanceId: string };
  }

  /** `GET /runs` — every live run's status. */
  async list(): Promise<RunStatus[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/runs`, { headers: this.headers() });
    return (await this.json(res, "/runs")) as RunStatus[];
  }

  /** `GET /repos` — whether the instance has a data plane, and every Repo resource as the cluster
   * reports it (ADR-0048/0051): per node, present or not, synced or not, with git's own error. The
   * cache agent keeps retrying on its own, so this is a snapshot of a moving thing. What
   * `j2 status` reports when it is given no run. */
  async repos(): Promise<{ dataPlane: boolean; repos: RepoStatus[] }> {
    const res = await this.fetchImpl(`${this.baseUrl}/repos`, { headers: this.headers() });
    return (await this.json(res, "/repos")) as { dataPlane: boolean; repos: RepoStatus[] };
  }

  /** `GET /runs/resolve?prefix=` — run ids sharing a prefix, live and settled. The wire half of
   * abbreviated run ids; the policy (floor, uuid fast path, ambiguity) lives in `run-id.ts`. */
  async candidates(prefix: string): Promise<{ runIds: string[]; truncated: boolean }> {
    const res = await this.fetchImpl(`${this.baseUrl}/runs/resolve?prefix=${encodeURIComponent(prefix)}`, {
      headers: this.headers(),
    });
    const body = (await this.json(res, RESOLVE_PATH)) as { runIds: string[]; truncated: boolean };
    return { runIds: body.runIds, truncated: body.truncated };
  }

  /** `GET /runs/:runId` (read-through) — terminal runs included; a genuinely unknown run → undefined. */
  async read(runId: string): Promise<RunStatus | undefined> {
    const res = await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return undefined;
    return (await this.json(res, "/runs/:runId")) as RunStatus;
  }

  /** `POST /runs/:runId/gates/:gate/events` — deliver a workflow-defined event to an open gate
   * (ADR-0011). The body is `{ type, ...input }`, validated against the event's schema host-side;
   * an unknown gate (404) or rejected payload (400) surfaces as a throw. */
  async sendToGate(runId: string, gate: string, event: { type: string } & Record<string, unknown>): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gate)}/events`,
      { method: "POST", headers: this.headers(JSON_HEADERS), body: JSON.stringify(event) },
    );
    await this.json(res, "/runs/:runId/gates/:gate/events"); // surface { error }; ignore { ok:true }
  }

  /** `POST /runs/:runId/events` — feed one run-control event into a live run. */
  async send(runId: string, event: RunEvent): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`, {
      method: "POST",
      headers: this.headers(JSON_HEADERS),
      body: JSON.stringify(event),
    });
    await this.json(res, "/runs/:runId/events"); // surface { error }; ignore { ok:true }
  }

  /**
   * `GET /runs/:runId/events` — the SSE feed as an async-iterable of `RunFeedEvent`. The current status
   * is replayed first (attach), then deltas + author `emit`s until the terminal status (or the consumer
   * breaks, which cancels the stream). A settled run streams its final status once and ends.
   */
  async *events(runId: string): AsyncGenerator<RunFeedEvent> {
    const res = await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`, {
      headers: this.headers({ accept: "text/event-stream" }),
    });
    if (res.status === 404) {
      throw new J2HttpError(`no run "${runId}"`, 404, "/runs/:runId/events", await this.identify());
    }
    if (!res.body) return;
    for await (const frame of parseSSE(res.body)) {
      if (frame.event === "emit") {
        yield { kind: "emit", event: JSON.parse(frame.data) as { type: string } & Record<string, unknown> };
      } else if (frame.event === "retry") {
        yield { kind: "retry", ...(JSON.parse(frame.data) as { child: string; attempt: number; reason: string }) };
      } else if (frame.event === "status") {
        yield { kind: "status", status: JSON.parse(frame.data) as RunStatus };
      }
      // Any other frame (a Turn marker — ADR-0023 — or a kind this CLI predates) is skipped, not
      // misread as a status: `j2 logs -f` decides "settled" off `status.status`, and a marker
      // parsed as a status would end the follow mid-run.
    }
  }

  /**
   * `GET /healthz` — what this orchestrator says it is. Unauthenticated (it is the readiness probe),
   * best-effort by contract: an unreachable or older instance answers `undefined`/`{}` rather than
   * throwing, because this is only ever called to EXPLAIN another failure and must never replace it.
   */
  async identify(): Promise<InstanceIdentity | undefined> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/healthz`);
      if (!res.ok) return undefined;
      const body = (await res.json()) as InstanceIdentity;
      return { version: body.version, hash: body.hash };
    } catch {
      return undefined; // the probe is a courtesy; its failure is not the user's error
    }
  }

  /** Parse a JSON response, turning a non-2xx `{ error }` body into a thrown `J2HttpError`. */
  private async json(res: Response, path: string): Promise<unknown> {
    const text = await res.text();
    const body = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const message = (body as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
      // Probe HERE, not at the catch site: by the time the error reaches `cli.ts` the command's
      // `finally` has closed the port-forward, and there is nothing left to ask.
      throw new J2HttpError(message, res.status, path, await this.identify());
    }
    return body;
  }
}
