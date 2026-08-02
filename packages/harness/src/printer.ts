// The Harness prints the conversation, and `kubectl logs` reads it (ADR-0023) — over pi's
// in-process event stream (ADR-0027; the retired shim needed a loopback SSE client). Reasoning
// only: prompts, assistant text, thinking, and tool calls with TRUNCATED inputs. A tool's RESULT
// is never read: that is a boundary (ADR-0023, and the ADR-0014 exception it takes), not an
// unfinished implementation. Truncation is load-bearing too — kubelet rotates at 10Mi and drops
// the remainder, so an untruncated turn loses its own beginning.

import type { AgentHarnessEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

/** What the printer needs from an AgentHarness: the in-process event stream. */
export type PrinterSource = {
  subscribe(listener: (event: AgentHarnessEvent) => void): () => void;
};

/** Where the lines go — `process.stdout` (the pod log) unless a test collects them. */
export type PrinterOut = { write(chunk: string): void };

/** Menu tools surface to the model as `mcp__j2__<name>` (ADR-0013); the log shows the bare name. */
function bareToolName(toolName: string): string {
  return toolName.replace(/^mcp__[^_]*__/, "");
}

/**
 * One bound for every input, set high enough that an ordinary call prints whole: a command, a
 * review summary, a patch hunk. Only the outliers cut, and the 10Mi budget still holds — an Agent
 * makes hundreds of calls per run, not thousands of them at 2 KiB each.
 */
const MAX_INPUT = 2000;

/** Cut is visible: a bare prefix reads as a bug, `…` reads as the bound doing its job. */
function bound(text: string): string {
  return text.length > MAX_INPUT ? `${text.slice(0, MAX_INPUT)}…` : text;
}

/** A path for Write/Edit/Read (whole — a path is already short), the command for Bash, else JSON. */
export function renderToolInput(toolName: string, input: unknown): string {
  const arg = (input ?? {}) as Record<string, unknown>;
  const bare = bareToolName(toolName);
  const path = arg.file_path ?? arg.path;
  if (/^(write|edit|read)$/i.test(bare) && typeof path === "string") return path;
  if (/^bash$/i.test(bare)) return bound(String(arg.command ?? ""));
  return bound(JSON.stringify(input ?? null));
}

/** One completed message → its labelled line bodies (a body may span lines), or none for what
 * does not print. Deltas are best-effort live progress; a completed message is authoritative, and
 * a log line is atomic — so content prints once, at `message_end`. */
export function renderMessage(message: AgentMessage): string[] {
  const role = (message as { role?: string }).role;
  if (role === "user") {
    const content = (message as UserMessage).content;
    if (typeof content === "string") return [`[prompt] ${content}`];
    // `image` parts are content, not reasoning.
    return content.filter((part) => part.type === "text").map((part) => `[prompt] ${part.text}`);
  }
  if (role === "assistant") {
    return (message as AssistantMessage).content.map((block) => {
      if (block.type === "text") return `[text] ${block.text}`;
      if (block.type === "thinking") return `[thinking] ${block.thinking}`;
      return `[${bareToolName(block.name)}] ${renderToolInput(block.name, block.arguments)}`;
    });
  }
  return []; // `toolResult` (and anything custom): output, never printed.
}

/**
 * Subscribe the conversation printer to a harness's event stream. Every line carries the Agent
 * name alone — the minted iid mostly restates it (ADR-0015), and per-conversation diagnostics
 * live elsewhere. Returns the unsubscribe.
 */
export function attachPrinter(harness: PrinterSource, agentName: string, out: PrinterOut = process.stdout): () => void {
  return harness.subscribe((event) => {
    if (event.type !== "message_end") return;
    for (const body of renderMessage(event.message)) {
      for (const line of body.split("\n")) out.write(`[${agentName}] ${line}\n`);
    }
  });
}
