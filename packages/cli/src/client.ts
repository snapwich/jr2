// The shared HTTP client every `jr2` verb sits on (ADR-0009). One thin class over the orchestrator's
// REST + SSE surface (`createApp`) — the SAME wire the deployed orchestrator serves, so `jr2` against
// the e2e tier's host-booted fixture and against a cluster are one code path. It carries no folder/CLI concerns (those
// live in `instance.ts`); it is just "talk to a base URL".
//
// `fetchImpl` is injectable so tests drive it with a hono `app.request` (no socket) the same way the
// orchestrator's own http tests do; in production it defaults to the global `fetch`.

import type {
  ChildErrorMarker,
  DispatchedBy,
  MachineDoc,
  PlacingMarker,
  RepoStatus,
  RunChild,
  RunWaiting,
} from "@jr2/orchestrator";
import { parseSSE } from "./sse.ts";

/** A run's current observable state — mirrors the orchestrator's `RunStatus` (run-host.ts). */
export type RunStatus = {
  runId: string;
  workflow: string;
  instanceId: string;
  status: string;
  value: unknown;
  context: unknown;
  /** The live child machines beneath the root, context-free — where most of a run is. */
  children?: RunChild[];
  /** Every Workspace waiting for capacity, and why (ADR-0064). Optional: an orchestrator older
   * than ADR-0064 does not send it. */
  waiting?: RunWaiting[];
  /** Why the host set this status, for statuses the Machine did not choose — `drifted` names the
   * Assembly hash and why this Orchestrator cannot read it: not on the volume, published for
   * another Kit version, or does not load (ADR-0030, ADR-0069). */
  reason?: string;
  /** The hash of the Assembly the run started under, and holds while it is live (ADR-0069).
   * Absent for a run no Assembly started. */
  assembly?: string;
  /** The run binds at least one Chart (ADR-0070): its Machine is the Chart wrapper's with each bound
   * Open body's Chart compiled in, which `GET /workflows/:name/runs/:runId/machine` serves.
   * Absent when the run binds none. */
  bound?: true;
  /** The hashes of the Charts the run binds now, distinct and sorted (ADR-0070). */
  chartHashes?: string[];
  /** The run that dispatched this one through a `dispatch` Effect, the caller's slot, its ledger
   * row id (the idempotency key) and this run's depth in the chain (ADR-0071); `instance` names a
   * foreign caller, as opaque text. Absent for a run nobody dispatched. */
  dispatchedBy?: DispatchedBy;
  /** The Machine's output, for a run that is no longer live (ADR-0071): what a `dispatch` with
   * `wait` settles with. Never for a live run. */
  output?: unknown;
  /** The runs this run's `dispatch` Effects started, oldest first: the slot, the run, and when its
   * ledger row was written (ADR-0071). Absent when it started none. */
  dispatched?: Array<{ slot: string; run: string; at: string }>;
};

/** Where a Workflow came from (ADR-0070): a Machine in the Assembly, a Chart file in the Assembly, or
 * a runtime Chart put by `PUT /workflows/:wrapper/charts/:name`. */
export type WorkflowOrigin = "machine" | "file" | "runtime";

/** One entry of `GET /workflows` (ADR-0070) — mirrors the orchestrator's `WorkflowListing`
 * (run-host.ts). A Chart wrapper's entry carries its Open body slot, whether its door takes a Chart
 * one-shot, and its named Charts, inside its entry and not beside it. `unrunnable` is why a
 * Workflow cannot start now (a runtime Chart a publish no longer admits). */
export type WorkflowListing = {
  name: string;
  origin: WorkflowOrigin;
  wrapper?: {
    body: string;
    oneShot: boolean;
    charts: Array<{ name: string; origin: "file" | "runtime"; unrunnable?: string }>;
  };
  unrunnable?: string;
};

/** One item on a run's observation feed — mirrors the orchestrator's `RunFeedEvent`. */
export type RunFeedEvent =
  | { kind: "status"; status: RunStatus }
  | { kind: "emit"; event: { type: string } & Record<string, unknown> }
  | { kind: "retry"; child: string; attempt: number; reason: string }
  | PlacingMarker
  | ChildErrorMarker;

/** A run-control event posted to a live run (ADR-0013): CANCEL is the vocabulary that is left.
 * `keep` leaves a cancelled run's Workspaces instead of destroying them (ADR-0025). */
export type RunEvent = { type: string; keep?: boolean };

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
export class JR2HttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly instance?: InstanceIdentity;
  /** The door's report lines, when the answer carried them: a refused Chart is
   * `422 { error: "refused", report }` (ADR-0070), one line per rule it fails. */
  readonly report?: string[];

  constructor(message: string, status: number, path: string, instance?: InstanceIdentity, report?: string[]) {
    super(message);
    this.name = "JR2HttpError";
    this.status = status;
    this.path = path;
    this.instance = instance;
    if (report) this.report = report;
  }
}

/** The path of a Workflow's routes. The name is ONE path segment, encoded: a named Chart's
 * `<wrapper>/<name>` rides as `<wrapper>%2F<name>` (ADR-0070), which the Orchestrator reads as the
 * same Workflow as `/workflows/<wrapper>/charts/<name>`. */
export function workflowPath(workflow: string): string {
  return `/workflows/${encodeURIComponent(workflow)}`;
}

export class JR2Client {
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

  /** `GET /workflows` — every registered Workflow with its origin, each Chart wrapper's Charts inside
   * its entry (ADR-0070). An orchestrator older than ADR-0070 answers bare names; each reads as a
   * Machine, so the listing has one shape for every caller. */
  async workflows(): Promise<WorkflowListing[]> {
    const body = await this.json(await this.fetchImpl(`${this.baseUrl}/workflows`), "/workflows");
    // An answer that is no listing is not "none registered": say what came back (`jr2 runs` prints
    // `workflows: unknown — ...` for it, never "none registered").
    if (!Array.isArray(body)) throw new Error("GET /workflows: the answer is not a listing");
    return body.map((w: unknown) =>
      typeof w === "string" ? { name: w, origin: "machine" as const } : (w as WorkflowListing),
    );
  }

  /** `GET /workflows/:name/machine` — the workflow's Machine as the Console's DTO. */
  async machine(workflow: string): Promise<MachineDoc> {
    const res = await this.fetchImpl(`${this.baseUrl}${workflowPath(workflow)}/machine`);
    return (await this.json(res, "/workflows/:name/machine")) as MachineDoc;
  }

  /** `GET /workflows/:name/runs/:runId/machine` — the run's bound Machine (ADR-0070): the Chart
   * wrapper's Machine with each bound Open body's Chart compiled in. An unknown run → undefined. */
  async runMachine(workflow: string, runId: string): Promise<MachineDoc | undefined> {
    const res = await this.fetchImpl(
      `${this.baseUrl}${workflowPath(workflow)}/runs/${encodeURIComponent(runId)}/machine`,
    );
    if (res.status === 404) return undefined;
    return (await this.json(res, "/workflows/:name/runs/:runId/machine")) as MachineDoc;
  }

  /** `POST /workflows/:name/runs` — start a run; unknown workflow → 404 → throws. A named Chart's
   * name `<wrapper>/<name>` rides the path as one encoded segment (ADR-0070); a refused Chart in
   * the input → 422 → throws with the door's `report`. */
  async start(workflow: string, input: Record<string, unknown> = {}): Promise<{ runId: string; instanceId: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}${workflowPath(workflow)}/runs`, {
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
   * `jr2 status` reports when it is given no run. */
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
   * an unknown gate (404), a rejected payload (400) or an answer the run would not take now (409,
   * ADR-0013) surfaces as a throw. */
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
   *
   * A feed that ends BEFORE a terminal status is re-attached, never read as the run's end: the
   * server closes a reader that fell behind (a paused pager on `jr2 run | less`), and the feed is
   * level-triggered, so the re-attach opens with where the run stands now (ADR-0022). What falls in
   * the gap is activity — Emits, retries — never state. The one end that IS the run's own without
   * a terminal status is `gone`: the run was stopped and is parked (ADR-0025); the generator ends.
   */
  async *events(runId: string): AsyncGenerator<RunFeedEvent> {
    for (;;) {
      const res = await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`, {
        headers: this.headers({ accept: "text/event-stream" }),
      });
      if (res.status === 404) {
        throw new JR2HttpError(`no run "${runId}"`, 404, "/runs/:runId/events", await this.identify());
      }
      if (!res.body) return;
      let settled = false;
      for await (const frame of parseSSE(res.body)) {
        if (frame.event === "emit") {
          yield { kind: "emit", event: JSON.parse(frame.data) as { type: string } & Record<string, unknown> };
        } else if (frame.event === "retry") {
          yield { kind: "retry", ...(JSON.parse(frame.data) as { child: string; attempt: number; reason: string }) };
        } else if (frame.event === "status") {
          const status = JSON.parse(frame.data) as RunStatus;
          settled = status.status !== "active";
          yield { kind: "status", status };
        } else if (frame.event === "placing" || frame.event === "placed") {
          // A wait for capacity starting and ending (ADR-0064) — activity, never a status.
          yield { ...(JSON.parse(frame.data) as object), kind: frame.event } as PlacingMarker;
        } else if (frame.event === "child-error") {
          // A child's error below an Agent's state, which the Agent's answer does not carry (ADR-0024).
          yield { ...(JSON.parse(frame.data) as object), kind: "child-error" } as ChildErrorMarker;
        } else if (frame.event === "gone") {
          // The run left the live set without settling — stopped, parked for the next boot's
          // restore (ADR-0025). This end is the run's own (ADR-0022): nothing to re-attach to.
          return;
        }
        // Any other frame (a Turn marker — ADR-0023 — or a kind this CLI predates) is skipped, not
        // misread as a status: `jr2 logs -f` decides "settled" off `status.status`, and a marker
        // parsed as a status would end the follow mid-run.
      }
      if (settled) return;
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

  /** Parse a JSON response, turning a non-2xx `{ error }` body into a thrown `JR2HttpError`. */
  private async json(res: Response, path: string): Promise<unknown> {
    const text = await res.text();
    const body = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const { error, report } = (body ?? {}) as { error?: string; report?: unknown };
      const message = error ?? `HTTP ${res.status}`;
      const lines = Array.isArray(report) ? report.map(String) : undefined;
      // Probe HERE, not at the catch site: by the time the error reaches `cli.ts` the command's
      // `finally` has closed the port-forward, and there is nothing left to ask.
      throw new JR2HttpError(message, res.status, path, await this.identify(), lines);
    }
    return body;
  }
}
