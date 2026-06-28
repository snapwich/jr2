// The control plane: builds a per-run MCP server from the shared callback toolset and turns
// incoming tool calls into `ControlEvent`s (ADR-0002/0006). Holds `request_approval` calls
// open until the Machine answers via `resolveApproval`, and serves `check_inbox` polls from
// the per-instance inbox fed by `enqueueInbox`.
//
// One MCP endpoint per run (addressing.ts): each `server(instanceId)` builds a fresh McpServer
// whose tool handlers are closed over that instance id, so every up-event carries the run it
// came from. The callback toolset is the single source of truth — we register EVERY tool in
// CALLBACK_TOOLS, using each tool's zod input object's `.shape` as the raw shape the SDK wants.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CALLBACK_TOOLS } from "@j2/agent-protocol";
import type { ControlEvent } from "@j2/agent-protocol";

export class ControlPlane {
  /** instanceId → the resolver of its single outstanding `request_approval` call. */
  private readonly pendingApprovals = new Map<string, (decision: string) => void>();
  /** instanceId → queued down-channel messages drained on the next `check_inbox` poll. */
  private readonly inboxes = new Map<string, string[]>();
  /** Sink the mapped up-events are pushed to. */
  private readonly onEvent: (e: ControlEvent) => void;

  constructor(onEvent: (e: ControlEvent) => void) {
    this.onEvent = onEvent;
  }

  /** Build the MCP server that hosts the callback toolset for one run's instance id. */
  server(instanceId: string): McpServer {
    const server = new McpServer({ name: "j2-control-plane", version: "0.0.0" });

    for (const tool of Object.values(CALLBACK_TOOLS)) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.input.shape,
          outputSchema: tool.output.shape,
        },
        // The SDK has already validated `args` against `tool.input` by the time we run.
        (args: Record<string, unknown>): CallToolResult | Promise<CallToolResult> =>
          this.handle(instanceId, tool.name, args),
      );
    }

    return server;
  }

  /** Answer a held `request_approval` call for the given instance with the Machine's decision. */
  resolveApproval(instanceId: string, decision: string): void {
    const resolve = this.pendingApprovals.get(instanceId);
    if (!resolve) {
      throw new Error(`no pending approval for instance "${instanceId}"`);
    }
    this.pendingApprovals.delete(instanceId);
    resolve(decision);
  }

  /** Queue a down-channel message the Agent will pull on its next `check_inbox` poll. */
  enqueueInbox(instanceId: string, msg: string): void {
    const queue = this.inboxes.get(instanceId);
    if (queue) {
      queue.push(msg);
    } else {
      this.inboxes.set(instanceId, [msg]);
    }
  }

  /** Translate one tool call into its up-event / deferred-result / poll-drain behavior. */
  private handle(
    instanceId: string,
    name: string,
    args: Record<string, unknown>,
  ): CallToolResult | Promise<CallToolResult> {
    switch (name) {
      case "done": {
        this.onEvent({
          type: "agent.done",
          instanceId,
          summary: args.summary as string | undefined,
        });
        return ack();
      }
      case "request_review": {
        this.onEvent({
          type: "agent.requestReview",
          instanceId,
          summary: args.summary as string,
        });
        return ack();
      }
      case "report_blocked": {
        this.onEvent({
          type: "agent.reportBlocked",
          instanceId,
          reason: args.reason as string,
        });
        return ack();
      }
      case "request_approval": {
        this.onEvent({
          type: "agent.requestApproval",
          instanceId,
          action: args.action as string,
          reason: args.reason as string | undefined,
        });
        // Deferred: hold the tool result open until `resolveApproval` answers for this instance.
        if (this.pendingApprovals.has(instanceId)) {
          throw new Error(`approval already pending for instance "${instanceId}"`);
        }
        return new Promise<CallToolResult>((resolve) => {
          this.pendingApprovals.set(instanceId, (decision) => resolve(structured({ decision })));
        });
      }
      case "check_inbox": {
        const messages = this.inboxes.get(instanceId) ?? [];
        this.inboxes.set(instanceId, []);
        return structured({ messages });
      }
      default:
        throw new Error(`unknown callback tool "${name}"`);
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

/** The shared `{ ok: true }` acknowledgement result for fire-and-ack tools. */
function ack(): CallToolResult {
  return structured({ ok: true });
}
