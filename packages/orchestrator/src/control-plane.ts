// The MCP dialect adapter (ADR-0011): serves each agent instance's registered event surface as
// an MCP toolset. This is one of the two adapters over the shared registration table — lookup,
// schema validation, and delivery are the TABLE's; this module only translates them onto the
// MCP wire and implements the per-semantics call behavior:
//
//   - `ack`      deliver the event, acknowledge immediately;
//   - `deferred` deliver the event, hold the tool result open until the Machine answers
//                (`answerRun`) — the solicited down-channel;
//   - `poll`     drain the instance's inbox (cooperative steer checkpoint); delivers nothing.
//
// `server(instanceId)` builds a FRESH McpServer from the table's LIVE registration, so
// `tools/list` serves exactly what the current state accepts — a transition swaps registrations,
// which swaps the served toolset (ADR-0006's dynamic advertisement, for free). A call for an
// unregistered iid (settled run, exited state) finds no server: the one catch point.
//
// Deferred holds and inboxes live HERE (keyed by iid), not on per-request servers: the HTTP
// layer builds a server per request (stateless), and a held `request_approval` must survive on
// its own open POST stream while a sibling request drains the same inbox.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { EventDef } from "@j2/agent-protocol";
import { mcpAddress, type Registration, type RegistrationTable } from "./registration.ts";

export class ControlPlane {
  private readonly table: RegistrationTable;
  /** instanceId → the resolver of its single outstanding deferred call (+ its run, for answer-by-run). */
  private readonly pending = new Map<string, { runId: string; resolve: (payload: Record<string, unknown>) => void }>();
  /** instanceId → queued down-channel messages drained on the next `poll` call. */
  private readonly inboxes = new Map<string, string[]>();

  constructor(table: RegistrationTable) {
    this.table = table;
  }

  /** Build an MCP server over the instance's LIVE registration; undefined when there is none. */
  server(instanceId: string): McpServer | undefined {
    const reg = this.table.lookup(mcpAddress(instanceId));
    if (!reg) return undefined;

    const server = new McpServer({ name: "j2-control-plane", version: "0.0.0" });
    for (const def of reg.defs.values()) {
      server.registerTool(
        def.name,
        {
          description: def.description,
          inputSchema: def.input.shape,
          ...(def.output instanceof z.ZodObject ? { outputSchema: def.output.shape } : {}),
        },
        // The SDK has validated `args` against `def.input`; the table validates again on deliver
        // (one shared behavior for both dialects — cheap, and the MCP path is not special).
        (args: Record<string, unknown>): CallToolResult | Promise<CallToolResult> => this.handle(reg, def, args),
      );
    }
    return server;
  }

  /** Answer the run's outstanding deferred call with the Machine's payload (ADR-0009 APPROVE). */
  answerRun(runId: string, payload: Record<string, unknown>): void {
    const held = [...this.pending.entries()].filter(([, p]) => p.runId === runId);
    if (held.length === 0) throw new Error(`no pending deferred call on run "${runId}"`);
    if (held.length > 1) {
      throw new Error(`run "${runId}" holds ${held.length} pending deferred calls — answer by instance instead`);
    }
    const [instanceId, entry] = held[0] as [string, { runId: string; resolve: (p: Record<string, unknown>) => void }];
    this.pending.delete(instanceId);
    entry.resolve(payload);
  }

  /** Queue a down-channel message for the run's live agent; drained on its next `poll` call. */
  steerRun(runId: string, msg: string): void {
    const agents = this.table.byRun(runId).filter((r) => r.kind === "agent");
    if (agents.length === 0) throw new Error(`no live agent surface on run "${runId}" to steer`);
    if (agents.length > 1) {
      throw new Error(`run "${runId}" has ${agents.length} live agent surfaces — steer by instance instead`);
    }
    const id = (agents[0] as Registration).id;
    const queue = this.inboxes.get(id);
    if (queue) queue.push(msg);
    else this.inboxes.set(id, [msg]);
  }

  /** Per-semantics call behavior; the delivery itself is the shared table's. */
  private handle(
    reg: Registration,
    def: EventDef,
    args: Record<string, unknown>,
  ): CallToolResult | Promise<CallToolResult> {
    switch (def.semantics) {
      case "ack": {
        this.table.deliver(reg.address, def.name, args);
        return structured({ ok: true });
      }
      case "deferred": {
        if (this.pending.has(reg.id)) {
          throw new Error(`a deferred call is already pending for instance "${reg.id}"`);
        }
        this.table.deliver(reg.address, def.name, args);
        return new Promise<CallToolResult>((resolve) => {
          this.pending.set(reg.id, { runId: reg.runId, resolve: (payload) => resolve(structured(payload)) });
        });
      }
      case "poll": {
        const messages = this.inboxes.get(reg.id) ?? [];
        this.inboxes.set(reg.id, []);
        return structured({ messages });
      }
    }
  }
}

/** A well-formed CallToolResult carrying `payload` as both structured and text content. */
function structured(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
