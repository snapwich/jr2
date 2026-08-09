// The Harness prints the conversation, and `kubectl logs` reads it (ADR-0023) — over pi's
// in-process event stream (ADR-0027; the retired shim needed a loopback SSE client). Reasoning
// only: prompts, assistant text, thinking, and tool calls with TRUNCATED inputs. A tool's RESULT
// is never read: that is a boundary (ADR-0023, and the ADR-0014 exception it takes), not an
// unfinished implementation. Truncation is load-bearing too — kubelet rotates at 10Mi and drops
// the remainder, so an untruncated turn loses its own beginning.

import type { AgentHarnessEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { EchoEvent } from "./wire.ts";

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
 * The Compaction line (ADR-0036) — the one mechanic a reader must see. A turn that summarized 120
 * tool calls away is not an agent that forgot what it read at step 20, and without this line the
 * two are indistinguishable in the pod log. Facts only, and only here: pi emits `session_compact`
 * from its idle-guarded `compact()` alone, which a mid-turn cut cannot call, so this renderer has
 * a CALLER (`turn.ts`) instead of a subscription — the `renderEchoEvent` shape. The cut itself is
 * pi's compaction entry; this is its projection, never the record.
 *
 * The two numbers are measured differently on purpose (`compaction.ts` says why): before is the
 * provider's own count, after is an estimate of what remains.
 */
export function renderCompaction(tokensBefore: number, tokensAfter: number, contextWindow: number): string {
  return `[compacted] context ${tokensBefore} → ~${tokensAfter} tokens (window ${contextWindow})`;
}

/** A conversation line's one shape: the Agent name, then a labelled body that may span lines.
 * Every writer goes through here, so the format has exactly one definition. */
export function printLines(out: PrinterOut, agentName: string, bodies: string[]): void {
  for (const body of bodies) {
    for (const line of body.split("\n")) out.write(`[${agentName}] ${line}\n`);
  }
}

/**
 * Subscribe the conversation printer to a harness's event stream. Every line carries the Agent
 * name alone — the minted iid mostly restates it (ADR-0015), and per-conversation diagnostics
 * live elsewhere. Returns the unsubscribe.
 */
export function attachPrinter(harness: PrinterSource, agentName: string, out: PrinterOut = process.stdout): () => void {
  return harness.subscribe((event) => {
    if (event.type !== "message_end") return;
    printLines(out, agentName, renderMessage(event.message));
  });
}

// ---- The run narrative (ADR-0023's echo) -------------------------------------------------------

/** An xstate state value, compact: a leaf is its key, nesting joins with `.`, parallel regions
 * with `, ` — `working.reviewing`, not a JSON tree. The narrative says where the run IS. */
function compactValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, child]) => `${key}.${compactValue(child)}`)
      .join(", ");
  }
  return JSON.stringify(value ?? null);
}

/** A payload beside its label, or nothing for an empty one — `approve` says it alone. */
function payloadSuffix(payload: Record<string, unknown> | undefined): string {
  if (!payload || Object.keys(payload).length === 0) return "";
  return ` ${bound(JSON.stringify(payload))}`;
}

/** Where the run stands, root + child machines on one line: a root's value alone says almost
 * nothing (the work happens in children), so each child appends as `id: value` — e.g.
 * `running · body: reviewing`. */
function compactStatus(value: unknown, children: unknown): string {
  const parts = [compactValue(value)];
  for (const child of Array.isArray(children) ? children : []) {
    const c = (child ?? {}) as { id?: unknown; value?: unknown; children?: unknown };
    if (typeof c.id !== "string") continue;
    parts.push(`${c.id}: ${compactStatus(c.value, c.children)}`);
  }
  return parts.join(" · ");
}

/**
 * One structured feed event → its narrative lines, in the conversation's own idiom: a label per
 * line, no ANSI, payloads under the same bound as tool inputs. Run-scoped events carry the `run`
 * label; Turn markers carry the Agent's name, so a remote decisioner's admission and pick read
 * exactly like a local turn's lines. Taken defensively (the payload is wire data): an event this
 * renderer does not recognize prints nothing — the log is a courtesy view, never a validator.
 */
export function renderEchoEvent(event: EchoEvent | unknown): string[] {
  const e = (event ?? {}) as Partial<Record<string, unknown>>;
  const label = (name: string, body: string): string[] => body.split("\n").map((line) => `[${name}] ${line}`);
  if (e.kind === "status") {
    // Terminal statuses (`done`, `error`, `cancelled`) ARE the narrative line; while the run is
    // active, where it stands is.
    const body = e.status === "active" && e.value !== undefined ? compactStatus(e.value, e.children) : String(e.status);
    return label("run", `[status] ${body}`);
  }
  if (e.kind === "emit") {
    const { type, ...payload } = (e.event ?? {}) as { type?: unknown } & Record<string, unknown>;
    if (typeof type !== "string" || !type) return [];
    return label("run", `[emit] ${type}${payloadSuffix(payload)}`);
  }
  if (e.kind === "admission" && typeof e.agent === "string") {
    return label(e.agent, `[admitted] ${bound(String(e.prompt ?? ""))}`);
  }
  if (e.kind === "pick" && typeof e.agent === "string" && typeof e.event === "string") {
    return label(e.agent, `[pick] ${e.event}${payloadSuffix(e.payload as Record<string, unknown> | undefined)}`);
  }
  return [];
}
