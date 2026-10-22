// The conversation printer (ADR-0023): prompts, assistant text, thinking, tool calls with TRUNCATED
// inputs, and each Menu pick's answer — the text the model read back from the call, under the same
// bound, cut in its middle. A Working tool's RESULT never prints; a line is atomic, so only completed messages
// (`message_end`) print.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { receiptProse } from "../src/menu.ts";
import { menuToolName } from "../src/menu-tools.ts";
import { attachPrinter, renderMessage, renderToolInput } from "../src/printer.ts";

/** A tool's result as pi records it: the text the model reads, and whether it reads as an error. */
function toolResult(toolName: string, text: string, isError = false): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: 0,
  } as AgentMessage;
}

function user(content: unknown): AgentMessage {
  return { role: "user", content, timestamp: 0 } as AgentMessage;
}

function assistant(content: AssistantMessage["content"]): AgentMessage {
  return { role: "assistant", content, stopReason: "stop", timestamp: 0 } as unknown as AgentMessage;
}

function toolCall(name: string, args: Record<string, unknown>): AssistantMessage["content"][number] {
  return { type: "toolCall", id: "tc-1", name, arguments: args as JsonObject };
}

/** A fake `Agent`: the printer needs only `subscribe`, and tests need `emit`. */
function fakeHarness() {
  const listeners = new Set<(event: AgentEvent) => void>();
  return {
    subscribe(listener: (event: AgentEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: AgentEvent): void {
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

test("renderMessage: a Working tool's result never prints — output is a boundary", () => {
  assert.deepEqual(renderMessage(toolResult("bash", "SECRET-RESULT")), []);
  assert.deepEqual(renderMessage(toolResult("read", "SECRET-RESULT", true)), []);
});

test("renderMessage: a Menu pick's answer prints as `[<pick> answer]`, the text the model read", () => {
  const text = 'Delivered "publish" to the workflow (delivery d-1). The workflow took it and moved on.';
  assert.deepEqual(renderMessage(toolResult(menuToolName("publish"), text)), [`[publish answer] ${text}`]);
});

test("renderMessage: a Menu pick the model reads as an error prints as `[<pick> error]`: a refusal, a schema miss", () => {
  const refusal =
    "`mcp__jr2__finish` was NOT delivered: your pick `mcp__jr2__publish` is still running in the workflow.";
  assert.deepEqual(renderMessage(toolResult(menuToolName("finish"), refusal, true)), [`[finish error] ${refusal}`]);
  // A body may span lines, as every printed body may: the label is on its first line only.
  const schema = 'Validation failed for tool "mcp__jr2__publish":\n  - root: must NOT have additional properties';
  assert.deepEqual(renderMessage(toolResult(menuToolName("publish"), schema, true)), [`[publish error] ${schema}`]);
});

test("renderMessage: an answer over the inputs' 2000 chars is cut in its MIDDLE, and the cut says how much it dropped", () => {
  const long = "H" + "a".repeat(999) + "MIDDLE" + "z".repeat(999) + "E";
  assert.deepEqual(renderMessage(toolResult(menuToolName("run_tests"), long)), [
    `[run_tests answer] H${"a".repeat(999)}… [6 characters cut] …${"z".repeat(999)}E`,
  ]);
  const at = "b".repeat(2000);
  assert.deepEqual(renderMessage(toolResult(menuToolName("run_tests"), at)), [`[run_tests answer] ${at}`]);
});

test('renderMessage: a command\'s long output keeps its receipt head and its end with "Allowed now" in the print', () => {
  // A command Effect's default tail is 4096 characters (ADR-0067); its answer is longer than the
  // bound, and the reply's JSON comes before what follows it. The log's copy is cut in the middle,
  // so the receipt, the end of the output and the Allowed picks all print; the model read it whole.
  const tail = `${"ok line\n".repeat(500)}not ok 7 - charges the card\n`;
  const answer = receiptProse(
    {
      delivered: true,
      event: "run_tests",
      deliveryId: "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9",
      turnComplete: false,
      answered: true,
      allowed: ["run_tests", "finish"],
      answer: { kind: "output", actor: "tests", output: { outcome: "exited", code: 1, tail } },
    },
    menuToolName,
  );
  assert.ok(answer.length > 4000, `the answer the model read is long: ${answer.length}`);
  const [line] = renderMessage(toolResult(menuToolName("run_tests"), answer));
  assert.ok(line!.startsWith(`[run_tests answer] ${answer.slice(0, 1000)}… [`), line!.slice(0, 200));
  assert.ok(line!.endsWith(answer.slice(-1000)), line!.slice(-200));
  assert.match(line!, new RegExp(`… \\[${answer.length - 2000} characters cut\\] …`));
  assert.match(line!, /not ok 7 - charges the card/);
  assert.match(line!, /Allowed now: `mcp__jr2__run_tests`, `mcp__jr2__finish`\.$/);
});

test("renderMessage: an answer prints as the model received it — the Effector's scrub marks stay, nothing is added", () => {
  // An Effector scrubs every string before it signs its answer, of the secrets it holds in the forms
  // it sent and in common encodings (ADR-0068). The print scrubs nothing of its own.
  const text = 'Its answer: the output of `comment`: {"outcome":"response","body":"token [secret:jira] echoed"}.';
  assert.deepEqual(renderMessage(toolResult(menuToolName("comment"), text)), [`[comment answer] ${text}`]);
});

test("renderMessage: a `command` Effect's output prints in its answer as the model read it, an echoed value too", () => {
  // The residual ADR-0023 and ADR-0014 state: the command runs in the Agent's container with the
  // Stand-ins its `bash` holds, and the Custodian does not scrub responses (ADR-0059), so a Held
  // value an upstream echoed into the output reaches the log as it reached the model.
  const text =
    'Its answer: the output of `checker`: {"outcome":"exited","code":0,"tail":"upstream said: Bearer ECHOED-VALUE\\n"}.';
  assert.deepEqual(renderMessage(toolResult(menuToolName("check"), text)), [`[check answer] ${text}`]);
});

test("renderMessage: the paragraph after a signed push prints whole in its pick's answer", () => {
  const sha = (c: string): string => c.repeat(40);
  const answer = receiptProse(
    {
      delivered: true,
      event: "publish",
      deliveryId: "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9",
      turnComplete: false,
      answered: true,
      allowed: ["publish", "finish"],
      answer: {
        kind: "output",
        actor: "push",
        output: { outcome: "pushed", published: sha("a"), source: sha("b"), ref: "refs/heads/feature", sync: "synced" },
      },
    },
    menuToolName,
  );
  const [line] = renderMessage(toolResult(menuToolName("publish"), answer));
  assert.equal(line, `[publish answer] ${answer}`, "under the bound: not cut");
  assert.match(line!, /jr2 signed your commits and pushed the signed copies\..*Continue your work on your branch\./);
  assert.match(line!, /Allowed now: `mcp__jr2__publish`, `mcp__jr2__finish`\.$/);
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

test("attachPrinter: a Menu call prints, then its answer under the pick's name, as the model read it", () => {
  const harness = fakeHarness();
  const { out, text } = collector();
  attachPrinter(harness, "coder", out);

  harness.emit({ type: "message_end", message: assistant([toolCall(menuToolName("publish"), {})]) });
  // pi emits a call's result twice: as the execution's end, and as the message the model reads.
  // The message prints, once.
  harness.emit({
    type: "tool_execution_end",
    toolCallId: "tc-1",
    toolName: menuToolName("publish"),
    result: "ignored",
    isError: false,
  });
  harness.emit({ type: "message_end", message: toolResult(menuToolName("publish"), "Delivered.\nAllowed now: none.") });

  assert.equal(
    text(),
    ["[coder] [publish] {}", "[coder] [publish answer] Delivered.", "[coder] Allowed now: none."]
      .map((line) => line + "\n")
      .join(""),
  );
});

test("attachPrinter: the returned unsubscribe detaches the printer", () => {
  const harness = fakeHarness();
  const { out, text } = collector();
  const unsubscribe = attachPrinter(harness, "coder", out);
  unsubscribe();
  harness.emit({ type: "message_end", message: user("anyone there?") });
  assert.equal(text(), "");
});
