// The conversation printer (ADR-0023): the retired shim's rendering rules, exactly — prompts,
// assistant text, thinking, and tool calls with TRUNCATED inputs print; a tool's RESULT never
// does; a line is atomic, so only completed messages (`message_end`) print.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentHarnessEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { attachPrinter, renderMessage, renderToolInput } from "../src/printer.ts";

function user(content: unknown): AgentMessage {
  return { role: "user", content, timestamp: 0 } as AgentMessage;
}

function assistant(content: AssistantMessage["content"]): AgentMessage {
  return { role: "assistant", content, stopReason: "stop", timestamp: 0 } as unknown as AgentMessage;
}

function toolCall(name: string, args: Record<string, unknown>): AssistantMessage["content"][number] {
  return { type: "toolCall", id: "tc-1", name, arguments: args };
}

/** A fake harness: the printer needs only `subscribe`, and tests need `emit`. */
function fakeHarness() {
  const listeners = new Set<(event: AgentHarnessEvent) => void>();
  return {
    subscribe(listener: (event: AgentHarnessEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: AgentHarnessEvent): void {
      for (const listener of listeners) listener(event);
    },
  };
}

function collector() {
  const chunks: string[] = [];
  return { out: { write: (chunk: string) => void chunks.push(chunk) }, text: () => chunks.join("") };
}

test("renderToolInput: read/write/edit render the path alone (path or file_path)", () => {
  assert.equal(renderToolInput("read", { path: "/work/a.ts" }), "/work/a.ts");
  assert.equal(renderToolInput("write", { file_path: "/work/b.ts", content: "x".repeat(999) }), "/work/b.ts");
  assert.equal(renderToolInput("edit", { path: "/work/c.ts", edits: [] }), "/work/c.ts");
});

test("renderToolInput: an ordinary command prints whole — the bound is for outliers", () => {
  const command = `cd /work/repo && git commit -m "${"m".repeat(500)}"`;
  assert.equal(renderToolInput("bash", { command }), command);
  assert.equal(renderToolInput("bash", {}), ""); // no command: empty, not "undefined"
});

test("renderToolInput: bash cuts at 2000 chars, exactly, and says that it cut", () => {
  const command = "x".repeat(1999) + "YZ"; // 2001 chars: the boundary cuts between Y and Z
  assert.equal(renderToolInput("bash", { command }), "x".repeat(1999) + "Y…");
  assert.equal(renderToolInput("bash", { command: "x".repeat(2000) }), "x".repeat(2000)); // at the bound: no mark
});

test("renderToolInput: any other tool renders the JSON input under the same bound", () => {
  const input = { question: "a".repeat(3000) };
  const rendered = renderToolInput("mcp__jr2__ask", input);
  assert.equal(rendered, `${JSON.stringify(input).slice(0, 2000)}…`);
  assert.equal(renderToolInput("mcp__jr2__ask", { question: "short" }), '{"question":"short"}');
  assert.equal(renderToolInput("grep", undefined), "null");
});

test("renderToolInput: the mcp__jr2__ prefix is stripped before the name match", () => {
  assert.equal(renderToolInput("mcp__jr2__read", { path: "/work/d.ts" }), "/work/d.ts");
  assert.equal(renderToolInput("mcp__jr2__bash", { command: "c".repeat(2500) }), `${"c".repeat(2000)}…`);
});

test("renderMessage: a user message is [prompt]; image parts do not print", () => {
  assert.deepEqual(renderMessage(user("do the thing")), ["[prompt] do the thing"]);
  assert.deepEqual(
    renderMessage(
      user([
        { type: "text", text: "look at this" },
        { type: "image", data: "…", mimeType: "image/png" },
      ]),
    ),
    ["[prompt] look at this"],
  );
});

test("renderMessage: assistant blocks render in order — text, thinking, tool call", () => {
  const message = assistant([
    { type: "thinking", thinking: "hm" },
    { type: "text", text: "done" },
    toolCall("mcp__jr2__approve", { verdict: "ship" }),
  ]);
  assert.deepEqual(renderMessage(message), ["[thinking] hm", "[text] done", '[approve] {"verdict":"ship"}']);
});

test("renderMessage: a toolResult message never prints — output is a boundary", () => {
  const result = {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "bash",
    content: [{ type: "text", text: "SECRET-RESULT" }],
    isError: false,
    timestamp: 0,
  } as AgentMessage;
  assert.deepEqual(renderMessage(result), []);
});

test("attachPrinter: completed messages print [agent]-prefixed atomic lines; nothing else does", () => {
  const harness = fakeHarness();
  const { out, text } = collector();
  attachPrinter(harness, "coder", out);

  harness.emit({ type: "message_end", message: user("fix the bug") });
  // Deltas are live progress, never printed — a line is atomic.
  harness.emit({
    type: "message_update",
    message: assistant([{ type: "text", text: "half a thou" }]),
    assistantMessageEvent: {} as never,
  });
  harness.emit({ type: "message_end", message: assistant([{ type: "text", text: "line one\nline two" }]) });
  harness.emit({ type: "message_end", message: assistant([toolCall("bash", { command: "npm test" })]) });
  // A tool's result arrives on two event shapes; neither prints.
  harness.emit({
    type: "tool_execution_end",
    toolCallId: "tc-1",
    toolName: "bash",
    result: "SECRET-RESULT",
    isError: false,
  });
  harness.emit({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "tc-1",
      toolName: "bash",
      content: [{ type: "text", text: "SECRET-RESULT" }],
      isError: false,
      timestamp: 0,
    } as AgentMessage,
  });

  assert.equal(
    text(),
    // A multi-line body carries its label on the first line only — the shim's exact format.
    ["[coder] [prompt] fix the bug", "[coder] [text] line one", "[coder] line two", "[coder] [bash] npm test"]
      .map((line) => line + "\n")
      .join(""),
  );
  assert.ok(!text().includes("SECRET-RESULT"));
  assert.ok(!text().includes("half a thou"));
});

test("attachPrinter: the returned unsubscribe detaches the printer", () => {
  const harness = fakeHarness();
  const { out, text } = collector();
  const unsubscribe = attachPrinter(harness, "coder", out);
  unsubscribe();
  harness.emit({ type: "message_end", message: user("anyone there?") });
  assert.equal(text(), "");
});
