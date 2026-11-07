// The replay fixtures of the pi 1.x migration: pi-agent-core 0.82.1's OWN code, run over
// a corpus of inputs, so the jr2 ports (`file-tools.ts`, `bash-tool.ts`) are
// tested against the original and not only against cases a person thought of.
//
//   node packages/harness/scripts/pi-0.82.1-fixtures.mjs <out-dir>
//
// Run it in a tree where pi-agent-core 0.82.1 is installed (a checkout of fdc8ce7). It writes
// file-tools.json and bash.json. Each holds the inputs, in the shape the jr2 port
// reads, and what 0.82.1 answered. Machine-specific values are written as stand-ins: the temporary
// directory as `<dir>`, a full-output path as `<full-output>`.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

const out = process.argv[2];
if (!out) throw new Error("usage: pi-0.82.1-fixtures.mjs <out-dir>");
mkdirSync(out, { recursive: true });
const write = (name, value) => writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`);

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
console.log(`wrote ${fileTools.length} file-tool and ${bashOut.length} bash cases to ${out}`);
