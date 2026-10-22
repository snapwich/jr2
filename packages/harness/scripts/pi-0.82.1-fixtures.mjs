// The replay fixtures of the pi 1.x migration: pi-agent-core 0.82.1's OWN code, run over
// a corpus of inputs, so the jr2 ports (`compaction-summary.ts`, `file-tools.ts`, `bash-tool.ts`) are
// tested against the original and not only against cases a person thought of.
//
//   node packages/harness/scripts/pi-0.82.1-fixtures.mjs <out-dir>
//
// Run it in a tree where pi-agent-core 0.82.1 is installed (a checkout of fdc8ce7). It writes
// compaction.json, file-tools.json and bash.json. Each holds the inputs, in the shape the jr2 port
// reads, and what 0.82.1 answered. Machine-specific values are written as stand-ins: the temporary
// directory as `<dir>`, a full-output path as `<full-output>`.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compact,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  InMemorySessionRepo,
  prepareCompaction,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

const out = process.argv[2];
if (!out) throw new Error("usage: pi-0.82.1-fixtures.mjs <out-dir>");
mkdirSync(out, { recursive: true });
const write = (name, value) => writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`);

// ─── Compaction ──────────────────────────────────────────────────────────────

const usage = (input) => ({
  input,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const user = (text) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
});
const assistant = (content, opts = {}) => ({
  type: "message",
  message: {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "fake",
    model: "model-x",
    usage: usage(opts.input ?? 1000),
    stopReason: opts.stopReason ?? (content.some((b) => b.type === "toolCall") ? "toolUse" : "stop"),
    ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
    timestamp: 2,
  },
});
const text = (t) => ({ type: "text", text: t });
const thinking = (t) => ({ type: "thinking", thinking: t });
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, name, t, isError = false) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: t }],
    isError,
    timestamp: 3,
  },
});
const image = (id, name) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [text("Read image file [image/png]"), { type: "image", data: "AAAA", mimeType: "image/png" }],
    isError: false,
    timestamp: 3,
  },
});
const submission = { type: "submission" };
const cut = (summary, firstKept, details = { readFiles: [], modifiedFiles: [] }) => ({
  type: "compaction",
  summary,
  firstKept,
  tokensBefore: 190000,
  details,
  usage: usage(500),
  timestamp: 4,
});

const model = (over = {}) => ({
  id: "model-x",
  name: "model-x",
  api: "openai-completions",
  provider: "fake",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
  ...over,
});

const longResult = "y".repeat(2500);
const oneTurn = [
  submission,
  user("Find the flag."),
  assistant([text("Looking."), call("c1", "read", { path: "src/a.ts" })]),
  result("c1", "read", "export const a = 1;"),
  assistant([thinking("The flag is near."), call("c2", "bash", { command: "grep -rn flag ." })]),
  result("c2", "bash", longResult),
  assistant([call("c3", "write", { path: "out/flag.txt", content: "found" })]),
  result("c3", "write", "Successfully wrote 5 bytes to out/flag.txt"),
  assistant([text("Done looking.")]),
];
const twoSubmissions = [
  submission,
  user("First task."),
  assistant([call("c1", "edit", { path: "b.md", edits: [{ oldText: "x", newText: "y" }] })]),
  result("c1", "edit", "Successfully replaced 1 block(s) in b.md."),
  assistant([text("First done.")]),
  submission,
  user("Second task, with a long prompt that is longer than the budget the cut keeps."),
];

const compactionCases = [
  { name: "a split turn inside one Submission", entries: oneTurn, keepRecentTokens: 12 },
  {
    name: "a cut at a Submission's prompt (the mark before it makes a split turn)",
    entries: twoSubmissions,
    keepRecentTokens: 12,
  },
  { name: "a budget that keeps everything", entries: oneTurn, keepRecentTokens: 1_000_000 },
  {
    name: "history before a split turn: two summaries",
    entries: [
      ...twoSubmissions,
      assistant([call("c9", "bash", { command: "ls" })]),
      result("c9", "bash", "a\nb"),
      assistant([text("Listed.")]),
    ],
    keepRecentTokens: 8,
  },
  {
    name: "a second cut: the update prompt, the previous summary and its file lists",
    entries: [
      ...oneTurn,
      cut("## Goal\nThe first summary.", 6, { readFiles: ["src/a.ts"], modifiedFiles: ["out/flag.txt"] }),
      assistant([call("c4", "read", { path: "src/c.ts" })]),
      result("c4", "read", "export const c = 3;"),
      assistant([text("Read c.")]),
    ],
    keepRecentTokens: 8,
  },
  {
    name: "a second cut that reaches the first cut's kept tail",
    entries: [...oneTurn, cut("## Goal\nThe first summary.", 4), assistant([text("After the cut.")])],
    keepRecentTokens: 4,
  },
  { name: "thinking high: the summary request reasons", entries: oneTurn, keepRecentTokens: 12, thinkingLevel: "high" },
  { name: "a model that states no maxTokens", entries: oneTurn, keepRecentTokens: 12, model: { maxTokens: 0 } },
  {
    name: "a model that does not reason: no reasoning at high",
    entries: oneTurn,
    keepRecentTokens: 12,
    thinkingLevel: "high",
    model: { reasoning: false },
  },
  {
    name: "an aborted message and a cut pick: the plain role mapping",
    entries: [
      submission,
      user("Pick."),
      assistant([text("I will pick."), call("p1", "mcp__jr2__review_verdict", { verdict: "approved" })], {
        stopReason: "aborted",
      }),
      assistant([text("")], { stopReason: "error", errorMessage: "boom", input: 0 }),
      submission,
      user("Again."),
      assistant([call("p2", "mcp__jr2__review_verdict", { verdict: "approved" })]),
      assistant([text("Waiting.")]),
    ],
    keepRecentTokens: 4,
  },
  {
    name: "images count 4800 characters",
    entries: [
      submission,
      user("Look."),
      assistant([call("i1", "read", { path: "a.png" })]),
      image("i1", "read"),
      assistant([text("Seen.")]),
    ],
    keepRecentTokens: 4,
  },
  { name: "the summary call fails", entries: oneTurn, keepRecentTokens: 1_000_000, fail: "error" },
  { name: "the turn prefix call fails", entries: oneTurn, keepRecentTokens: 12, fail: "error" },
  {
    name: "the summary call is aborted with no message",
    entries: oneTurn,
    keepRecentTokens: 1_000_000,
    fail: "aborted",
  },
];

async function compactionCase(c) {
  // 0.82.1's session over the same entries: a Submission's mark is the tool-set entry pi wrote there.
  const session = await new InMemorySessionRepo().create();
  const ids = [];
  for (const entry of c.entries) {
    if (entry.type === "message") ids.push(await session.appendMessage(entry.message));
    else if (entry.type === "submission") ids.push(await session.appendActiveToolsChange(["read"]));
    else
      ids.push(
        await session.appendCompaction(
          entry.summary,
          ids[entry.firstKept],
          entry.tokensBefore,
          entry.details,
          false,
          entry.usage,
        ),
      );
  }
  const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: c.keepRecentTokens };
  const prepared = prepareCompaction(await session.getBranch(), settings);
  if (!prepared.ok) return { error: prepared.error.message };
  if (!prepared.value) return { prepared: null };
  const requests = [];
  let n = 0;
  const models = {
    completeSimple: async (m, context, options) => {
      n += 1;
      const { signal: _signal, sessionId: _sessionId, ...rest } = options;
      requests.push({
        systemPrompt: context.systemPrompt,
        messages: context.messages.map(({ timestamp: _t, ...m }) => m),
        options: rest,
      });
      const failing = c.fail && (c.name.includes("prefix") ? n === 1 : true);
      return {
        role: "assistant",
        content: [text(failing ? "" : `SUMMARY ${n}`)],
        api: m.api,
        provider: m.provider,
        model: m.id,
        usage: usage(100 * n),
        stopReason: failing ? c.fail : "stop",
        ...(failing && c.fail === "error" ? { errorMessage: "400 scripted summary failure" } : {}),
        timestamp: 5,
      };
    },
  };
  const firstKept = ids.indexOf(prepared.value.firstKeptEntryId);
  const done = await compact(
    prepared.value,
    models,
    model(c.model),
    undefined,
    undefined,
    c.thinkingLevel ?? "off",
    undefined,
  );
  const answer = done.ok
    ? {
        summary: done.value.summary,
        firstKept,
        tokensBefore: done.value.tokensBefore,
        details: done.value.details,
        usage: done.value.usage,
      }
    : { error: done.error.message };
  return {
    prepared: { firstKept, isSplitTurn: prepared.value.isSplitTurn, tokensBefore: prepared.value.tokensBefore },
    requests,
    ...answer,
  };
}

const compaction = [];
for (const c of compactionCases) {
  compaction.push({ ...c, model: model(c.model), output: await compactionCase(c) });
}
write("compaction.json", compaction);

// ─── The file tools ──────────────────────────────────────────────────────────

const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);
const bmp = Buffer.alloc(58);
bmp.write("BM", 0, "ascii");
bmp.writeUInt32LE(58, 2);
bmp.writeUInt32LE(54, 10);
bmp.writeUInt32LE(40, 14);
bmp.writeUInt16LE(1, 26);
bmp.writeUInt16LE(24, 28);
const lines = (n, width = 3) => Array.from({ length: n }, (_, i) => String(i + 1).padStart(width, "0")).join("\n");

const fileCases = [
  { name: "read a whole file", files: { "a.txt": "one\ntwo\nthree\n" }, tool: "read", args: { path: "a.txt" } },
  {
    name: "read with offset and limit",
    files: { "a.txt": lines(10) },
    tool: "read",
    args: { path: "a.txt", offset: 3, limit: 4 },
  },
  {
    name: "read to the end from an offset",
    files: { "a.txt": lines(10) },
    tool: "read",
    args: { path: "a.txt", offset: 8 },
  },
  { name: "read more than 2000 lines", files: { "a.txt": lines(2500, 4) }, tool: "read", args: { path: "a.txt" } },
  { name: "read more than 50 KB", files: { "a.txt": lines(1500, 60) }, tool: "read", args: { path: "a.txt" } },
  {
    name: "read a first line over 50 KB",
    files: { "a.txt": `${"x".repeat(60000)}\nnext` },
    tool: "read",
    args: { path: "a.txt" },
  },
  {
    name: "read a first line over 50 KB at an offset",
    files: { "a.txt": `short\n${"é".repeat(30000)}` },
    tool: "read",
    args: { path: "a.txt", offset: 2 },
  },
  {
    name: "read an offset past the end",
    files: { "a.txt": "one\ntwo" },
    tool: "read",
    args: { path: "a.txt", offset: 9 },
  },
  { name: "read a PNG", files: { "a.png": { base64: png.toString("base64") } }, tool: "read", args: { path: "a.png" } },
  { name: "read a BMP", files: { "a.bmp": { base64: bmp.toString("base64") } }, tool: "read", args: { path: "a.bmp" } },
  { name: "read a missing file", files: {}, tool: "read", args: { path: "missing.txt" } },
  { name: "read a directory", files: { "d/a.txt": "x" }, tool: "read", args: { path: "d" } },
  { name: "read a path with @", files: { "a.txt": "at" }, tool: "read", args: { path: "@a.txt" } },
  {
    name: "read a path with a no-break space",
    files: { "a b.txt": "spaced" },
    tool: "read",
    args: { path: "a b.txt" },
  },
  {
    name: "read a path under ~",
    files: { "home.txt": "home" },
    tool: "read",
    args: { path: "~/home.txt" },
    home: true,
  },
  { name: "read a file:// URL", files: { "url.txt": "url" }, tool: "read", args: { path: "file://<dir>/url.txt" } },
  { name: "read a file with a BOM", files: { "bom.txt": "﻿bom text" }, tool: "read", args: { path: "bom.txt" } },
  {
    name: "read a macOS screenshot name",
    files: { "Shot 9.41.22 AM.png.txt": "shot" },
    tool: "read",
    args: { path: "Shot 9.41.22 AM.png.txt" },
  },
  { name: "write a new nested path", files: {}, tool: "write", args: { path: "n/e/s/t.txt", content: "nested\n" } },
  {
    name: "write over a file",
    files: { "a.txt": "old" },
    tool: "write",
    args: { path: "a.txt", content: "new content" },
  },
  { name: "write a path with @", files: {}, tool: "write", args: { path: "@w.txt", content: "w" } },
  {
    name: "edit one block",
    files: { "a.txt": "one\ntwo\nthree\n" },
    tool: "edit",
    args: { path: "a.txt", edits: [{ oldText: "two", newText: "TWO" }] },
  },
  {
    name: "edit two blocks",
    files: { "a.txt": "one\ntwo\nthree\n" },
    tool: "edit",
    args: {
      path: "a.txt",
      edits: [
        { oldText: "one", newText: "1" },
        { oldText: "three", newText: "3" },
      ],
    },
  },
  {
    name: "edit no match",
    files: { "a.txt": "one\n" },
    tool: "edit",
    args: { path: "a.txt", edits: [{ oldText: "nine", newText: "9" }] },
  },
  {
    name: "edit no match among two",
    files: { "a.txt": "one\n" },
    tool: "edit",
    args: {
      path: "a.txt",
      edits: [
        { oldText: "one", newText: "1" },
        { oldText: "nine", newText: "9" },
      ],
    },
  },
  {
    name: "edit a duplicate",
    files: { "a.txt": "x\nx\n" },
    tool: "edit",
    args: { path: "a.txt", edits: [{ oldText: "x", newText: "y" }] },
  },
  {
    name: "edit a duplicate among two",
    files: { "a.txt": "x\nx\nz\n" },
    tool: "edit",
    args: {
      path: "a.txt",
      edits: [
        { oldText: "z", newText: "Z" },
        { oldText: "x", newText: "y" },
      ],
    },
  },
  {
    name: "edit overlapping blocks",
    files: { "a.txt": "abcdef\n" },
    tool: "edit",
    args: {
      path: "a.txt",
      edits: [
        { oldText: "abcd", newText: "1" },
        { oldText: "cdef", newText: "2" },
      ],
    },
  },
  {
    name: "edit an empty oldText",
    files: { "a.txt": "a\n" },
    tool: "edit",
    args: { path: "a.txt", edits: [{ oldText: "", newText: "b" }] },
  },
  {
    name: "edit an empty oldText among two",
    files: { "a.txt": "a\n" },
    tool: "edit",
    args: {
      path: "a.txt",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "", newText: "c" },
      ],
    },
  },
  {
    name: "edit to the same text",
    files: { "a.txt": "a\n" },
    tool: "edit",
    args: { path: "a.txt", edits: [{ oldText: "a", newText: "a" }] },
  },
  {
    name: "edit a CRLF file",
    files: { "a.txt": "one\r\ntwo\r\nthree\r\n" },
    tool: "edit",
    args: { path: "a.txt", edits: [{ oldText: "two\nthree", newText: "2\n3" }] },
  },
  {
    name: "edit a file with a BOM",
    files: { "a.txt": "﻿one\ntwo\n" },
    tool: "edit",
    args: { path: "a.txt", edits: [{ oldText: "one", newText: "1" }] },
  },
  {
    name: "edit by the fuzzy match",
    files: { "a.txt": "const a = “quoted”;   \nconst b = 1 – 2;\nkeep this\n" },
    tool: "edit",
    args: {
      path: "a.txt",
      edits: [{ oldText: 'const a = "quoted";\nconst b = 1 - 2;', newText: "const a = 'q';\nconst b = -1;" }],
    },
  },
  {
    name: "edit in the legacy form",
    files: { "a.txt": "one\n" },
    tool: "edit",
    args: { path: "a.txt", oldText: "one", newText: "1" },
  },
  {
    name: "edit with edits as a JSON string",
    files: { "a.txt": "one\n" },
    tool: "edit",
    args: { path: "a.txt", edits: '[{"oldText":"one","newText":"1"}]' },
  },
  {
    name: "edit with an empty edits array",
    files: { "a.txt": "one\n" },
    tool: "edit",
    args: { path: "a.txt", edits: [] },
  },
  {
    name: "edit a missing file",
    files: {},
    tool: "edit",
    args: { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] },
  },
  {
    name: "edit a directory",
    files: { "d/a.txt": "x" },
    tool: "edit",
    args: { path: "d", edits: [{ oldText: "a", newText: "b" }] },
  },
];

function snapshot(dir) {
  const files = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel ? `${rel}/${name}` : name;
      if (statSync(join(dir, path)).isDirectory()) walk(path);
      else files[path] = readFileSync(join(dir, path), "utf8");
    }
  };
  walk("");
  return files;
}

const tools = { read: createReadTool(), write: createWriteTool(), edit: createEditTool() };
const fileTools = [];
for (const c of fileCases) {
  const dir = mkdtempSync(join(tmpdir(), "pi-fixture-"));
  const savedHome = process.env.HOME;
  if (c.home) process.env.HOME = dir;
  for (const [name, content] of Object.entries(c.files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), typeof content === "string" ? content : Buffer.from(content.base64, "base64"));
  }
  const tool = tools[c.tool];
  const raw = JSON.parse(JSON.stringify(c.args).replaceAll("<dir>", dir));
  const args = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
  let output;
  try {
    const answer = await tool.execute("call-1", args, undefined, undefined, {
      env: new NodeExecutionEnv({ cwd: dir }),
    });
    output = { content: answer.content };
  } catch (err) {
    output = { error: err instanceof Error ? err.message : String(err) };
  }
  output = JSON.parse(JSON.stringify(output).replaceAll(dir, "<dir>"));
  // `write` and `edit` change files: what is on disk after the call is part of the answer.
  fileTools.push({ ...c, output: c.tool === "read" ? output : { ...output, files: snapshot(dir) } });
  if (c.home) process.env.HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
}
write("file-tools.json", fileTools);

// ─── bash ────────────────────────────────────────────────────────────────────

const bashCases = [
  { name: "no output", command: "true" },
  { name: "output with no newline at the end", command: "printf 'no newline'" },
  { name: "control characters and carriage returns", command: "printf 'a\\000b\\007c\\td\\r\\ne\\033[0m\\n'" },
  { name: "U+FFF9 to U+FFFB", command: "printf 'x\\357\\277\\271y\\357\\277\\273z\\n'" },
  { name: "more than 2000 lines", command: "seq 1 2500" },
  { name: "more than 50 KB in short lines", command: "for i in $(seq 1 1200); do printf '%060d\\n' $i; done" },
  { name: "one line over 50 KB", command: "head -c 60000 /dev/zero | tr '\\0' 'x'" },
  { name: "one multi-byte line over 50 KB", command: "for i in $(seq 1 30000); do printf '\\303\\251'; done" },
  { name: "a non-zero exit", command: "echo partial; exit 3" },
  { name: "a non-zero exit with no output", command: "exit 4" },
];

const bash = createBashTool();
const bashOut = [];
for (const c of bashCases) {
  const dir = mkdtempSync(join(tmpdir(), "pi-fixture-"));
  let output;
  try {
    const answer = await bash.execute("call-1", { command: c.command }, undefined, undefined, {
      env: new NodeExecutionEnv({ cwd: dir }),
    });
    output = { text: answer.content[0].text };
  } catch (err) {
    output = { error: err instanceof Error ? err.message : String(err) };
  }
  const message = output.text ?? output.error;
  const full = /Full output: (\S+?)\]/.exec(message);
  if (full) {
    output.fullOutputBytes = statSync(full[1]).size;
    for (const key of ["text", "error"]) if (output[key]) output[key] = output[key].replace(full[1], "<full-output>");
  }
  bashOut.push({ ...c, output });
  rmSync(dir, { recursive: true, force: true });
}
write("bash.json", bashOut);
console.log(
  `wrote ${compaction.length} compaction, ${fileTools.length} file-tool and ${bashOut.length} bash cases to ${out}`,
);
