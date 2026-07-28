// The Adapter (ADR-0013): the j2-owned sidecar that serves the current turn's tool menu to the
// Agent over MCP on `localhost`, and forwards the Agent's picks to the Orchestrator.
//
// It is a separate container from the Harness, and THAT IS THE WHOLE POINT. `local()` tools give
// the Agent code execution in the Harness container, so a credential there is a credential the
// Agent holds — and an Agent that can reach the delivery API can deliver `approve` to its own
// human-review Gate. Split them, and the Agent is confined to a `localhost` menu the Machine set
// for the turn it is already in. This is what makes ADR-0006's "the Agent never steers the
// workflow" ENFORCED rather than advertised.
//
// It is a translator, and holds no state of its own:
//
//   tools/list            → GET  {orchestrator}/agents/:iid/surface   → the invoking state's events
//   tools/call <name>     → POST {orchestrator}/agents/:iid/events    → validate + deliver
//
// The iid comes from the URL the Agent connects to (`/mcp/:iid`), and flue's Harness names it: a
// `defineAgent` initializer re-runs on every submission with `{ id, env }`, where `id` IS the agent
// instance id, so the persona connects to `${env.J2_ADAPTER_URL}/mcp/${id}` per turn. The Adapter
// therefore never has to LEARN which turn is live — no push channel, no long-poll, no
// sandbox→turn index, no second inbound port on the pod. It asks, per connection, and the answer
// is the turn. (This is also why `list_changed` is unnecessary: flue re-lists on every submission,
// and a j2 menu only ever changes at a turn boundary.)
//
// Every request it makes carries the Sandbox token — from the Secret the CR mounts into THIS
// container's env, and nowhere else in the pod.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** One event on an agent's live surface, as the Orchestrator serves it. */
export type SurfaceEvent = {
  name: string;
  description?: string;
  /** The event's input schema, as JSON Schema — this becomes the MCP tool's input schema. */
  input: unknown;
  semantics: "ack" | "deferred" | "poll";
};

/** `GET /agents/:iid/surface` — the turn's menu. */
export type Surface = { instanceId: string; runId: string; sandbox?: string; accepts: SurfaceEvent[] };

/**
 * `POST /agents/:iid/events` — the answer to one pick, and the Agent's only way to learn what
 * became of it (ADR-0024). `turnComplete` says the state that asked for this turn has stopped
 * waiting; it is a hint that fails conservatively, not the thing that ends the turn.
 */
export type DeliveryReceipt = {
  delivered: boolean;
  event: string;
  turnComplete: boolean;
  deliveryId: string;
};

/** No live registration for this iid: the state exited, or the run settled. Not a menu — an end. */
export class NoSurfaceError extends Error {}

export type OrchestratorOptions = {
  /** Base URL of the Orchestrator, reachable FROM THE POD (`j2 cluster up` records it; Service DNS
   * when deployed). The Agent never makes this call and is never told this address. */
  url: string;
  /** The Sandbox token (`J2_SANDBOX_TOKEN`), from the Secret mounted into this container alone. */
  token: string;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch;
};

/** The Orchestrator, as the Adapter uses it: read this turn's surface, deliver this turn's pick. */
export class OrchestratorClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: OrchestratorOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  async surface(instanceId: string): Promise<Surface> {
    const res = await this.fetchImpl(`${this.url}/agents/${encodeURIComponent(instanceId)}/surface`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (res.status === 404) throw new NoSurfaceError(`no live surface for agent "${instanceId}"`);
    return (await this.ok(res)) as Surface;
  }

  async deliver(instanceId: string, event: Record<string, unknown>): Promise<DeliveryReceipt> {
    const res = await this.fetchImpl(`${this.url}/agents/${encodeURIComponent(instanceId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify(event),
    });
    if (res.status === 404) throw new NoSurfaceError(`no live surface for agent "${instanceId}"`);
    return (await this.ok(res)) as DeliveryReceipt;
  }

  /** A non-2xx `{ error }` becomes a throw — including 401/403, which must be LOUD: a silently
   * swallowed auth failure would look to the Agent exactly like a Machine that ignored it. */
  private async ok(res: Response): Promise<unknown> {
    const text = await res.text();
    const body = text ? (JSON.parse(text) as { error?: string }) : undefined;
    if (!res.ok) throw new Error(body?.error ?? `orchestrator answered HTTP ${res.status}`);
    return body;
  }
}

/**
 * Build the MCP server for ONE agent turn, from that turn's live surface.
 *
 * Every tool here is an event the invoking state declared it accepts — nothing more, and nothing
 * that outlives the state. The Agent cannot call what the Machine did not offer, and the
 * Orchestrator re-validates the payload on delivery anyway (the registration table owns that; the
 * Adapter is a translator, not a gatekeeper).
 */
export async function serverForTurn(client: OrchestratorClient, instanceId: string): Promise<McpServer> {
  const surface = await client.surface(instanceId);
  const server = new McpServer({ name: "j2-adapter", version: "0.0.0" });

  for (const event of surface.accepts) {
    if (event.semantics !== "ack") {
      // ADR-0013: `deferred`/`poll` are reserved in the model and have room on the wire, but nothing
      // answers a held call yet. Registering one as a plain tool would promise the Agent a result
      // that never comes, so refuse the whole turn rather than serve a lying contract.
      throw new Error(
        `event "${event.name}" is \`${event.semantics}\`, which the Adapter does not implement ` +
          `(ADR-0013: reserved, not built — an Agent must not be handed a tool whose contract is a lie)`,
      );
    }
    server.registerTool(
      event.name,
      { description: event.description, inputSchema: jsonSchemaToShape(event.input) },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const receipt = await client.deliver(instanceId, { type: event.name, ...args });
        return {
          content: [{ type: "text", text: receiptProse(receipt) }],
          structuredContent: receipt as unknown as Record<string, unknown>,
        };
      },
    );
  }
  return server;
}

/**
 * The receipt in WORDS (ADR-0024), because a model reads text before `structuredContent`. What the
 * Agent used to get back was a UUID, printed twice, against instructions that say it must finish by
 * calling the tool and never say when finishing is finished — so it called again. Say the three
 * things it needs: the pick arrived, the workflow consumed it, the turn is over.
 */
function receiptProse(receipt: DeliveryReceipt): string {
  const delivered = `Delivered "${receipt.event}" to the workflow (delivery ${receipt.deliveryId}).`;
  return receipt.turnComplete
    ? `${delivered} The workflow consumed it and moved on: your turn is over. Stop here — do not call this or any other tool again.`
    : `${delivered} The workflow is still in the state that asked for this turn, so it is not over yet.`;
}

/**
 * Rebuild a zod shape from the def's JSON Schema, because that is the only currency the two ends
 * share: the Orchestrator serves JSON Schema (a zod object cannot cross HTTP), and the MCP SDK's
 * `registerTool` wants a zod shape. Deliberately shallow — the Adapter does NOT re-validate, the
 * registration table does (once, for both dialects). What this shape is for is the tool's ADVERTISED
 * signature: the Agent's model reads it to know which arguments the tool takes.
 */
function jsonSchemaToShape(schema: unknown): Record<string, z.ZodType> {
  const doc = schema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  const required = new Set(doc?.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [name, prop] of Object.entries(doc?.properties ?? {})) {
    const base = leaf(prop?.type);
    shape[name] = required.has(name) ? base : base.optional();
  }
  return shape;
}

/** One JSON-Schema scalar as a zod type; anything richer degrades to `unknown` (see above). */
function leaf(type: string | undefined): z.ZodType {
  switch (type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object":
      return z.object({}).loose();
    default:
      return z.unknown();
  }
}
