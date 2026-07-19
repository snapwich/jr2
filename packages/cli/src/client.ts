// The shared HTTP client every `j2` verb sits on (ADR-0009). One thin class over the orchestrator's
// REST + SSE surface (`createApp`) — the SAME wire the deployed orchestrator serves, so `j2` against a
// `j2 dev` process and against a cluster are one code path. It carries no folder/CLI concerns (those
// live in `instance.ts`); it is just "talk to a base URL".
//
// `fetchImpl` is injectable so tests drive it with a hono `app.request` (no socket) the same way the
// orchestrator's own http tests do; in production it defaults to the global `fetch`.

import type { MachineDoc } from "@j2/orchestrator";
import { parseSSE } from "./sse.ts";

/** A run's current observable state — mirrors the orchestrator's `RunStatus` (run-host.ts). */
export type RunStatus = {
  runId: string;
  workflow: string;
  instanceId: string;
  status: string;
  value: unknown;
  context: unknown;
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
    return (await this.json(await this.fetchImpl(`${this.baseUrl}/workflows`))) as string[];
  }

  /** `GET /workflows/:name/machine` — the workflow's Machine as the visualizer DTO. */
  async machine(workflow: string): Promise<MachineDoc> {
    const res = await this.fetchImpl(`${this.baseUrl}/workflows/${encodeURIComponent(workflow)}/machine`);
    return (await this.json(res)) as MachineDoc;
  }

  /** `POST /workflows/:name/runs` — start a run; unknown workflow → 404 → throws. */
  async start(workflow: string, input: Record<string, unknown> = {}): Promise<{ runId: string; instanceId: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/workflows/${encodeURIComponent(workflow)}/runs`, {
      method: "POST",
      headers: this.headers(JSON_HEADERS),
      body: JSON.stringify(input),
    });
    return (await this.json(res)) as { runId: string; instanceId: string };
  }

  /** `GET /runs` — every live run's status. */
  async list(): Promise<RunStatus[]> {
    return (await this.json(await this.fetchImpl(`${this.baseUrl}/runs`, { headers: this.headers() }))) as RunStatus[];
  }

  /** `GET /runs/:runId` (read-through) — terminal runs included; a genuinely unknown run → undefined. */
  async read(runId: string): Promise<RunStatus | undefined> {
    const res = await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return undefined;
    return (await this.json(res)) as RunStatus;
  }

  /** `POST /runs/:runId/gates/:gate/events` — deliver a workflow-defined event to an open gate
   * (ADR-0011). The body is `{ type, ...input }`, validated against the event's schema host-side;
   * an unknown gate (404) or rejected payload (400) surfaces as a throw. */
  async sendToGate(runId: string, gate: string, event: { type: string } & Record<string, unknown>): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gate)}/events`,
      { method: "POST", headers: this.headers(JSON_HEADERS), body: JSON.stringify(event) },
    );
    await this.json(res); // surface { error } as a throw; ignore the { ok:true } body
  }

  /** `POST /runs/:runId/events` — feed one run-control event into a live run. */
  async send(runId: string, event: RunEvent): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`, {
      method: "POST",
      headers: this.headers(JSON_HEADERS),
      body: JSON.stringify(event),
    });
    await this.json(res); // surface { error } as a throw; ignore the { ok:true } body
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
    if (res.status === 404) throw new Error(`no run "${runId}"`);
    if (!res.body) return;
    for await (const frame of parseSSE(res.body)) {
      if (frame.event === "emit") {
        yield { kind: "emit", event: JSON.parse(frame.data) as { type: string } & Record<string, unknown> };
      } else if (frame.event === "retry") {
        yield { kind: "retry", ...(JSON.parse(frame.data) as { child: string; attempt: number; reason: string }) };
      } else {
        yield { kind: "status", status: JSON.parse(frame.data) as RunStatus };
      }
    }
  }

  /** Parse a JSON response, turning a non-2xx `{ error }` body into a thrown Error. */
  private async json(res: Response): Promise<unknown> {
    const text = await res.text();
    const body = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const message = (body as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
      throw new Error(message);
    }
    return body;
  }
}
