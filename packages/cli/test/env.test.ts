// `.env` loading (ADR-0019): the parse grammar, the walk up to `j2.config.ts`, and the precedence
// rule that makes the file a DEFAULT layer — a var already in the environment always wins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotenv, parseDotenv } from "../src/env.ts";
import type { Io } from "../src/output.ts";

/** An instance folder with a `.env`, plus a nested subdir to run the CLI from. */
async function mkInstance(dotenv: string): Promise<{ root: string; nested: string }> {
  const root = await mkdtemp(join(tmpdir(), "j2-env-"));
  await writeFile(join(root, "j2.config.ts"), "export default {};\n");
  await writeFile(join(root, ".env"), dotenv);
  const nested = join(root, "workflows", "deep");
  await mkdir(nested, { recursive: true });
  return { root, nested };
}

function mkIo(over: Partial<Io>): { io: Io; err: () => string } {
  const err: string[] = [];
  const io: Io = { stdout: () => {}, stderr: (s) => err.push(s), env: {}, cwd: "/", ...over };
  return { io, err: () => err.join("") };
}

test("parses bare, quoted, exported, and commented assignments", () => {
  const parsed = parseDotenv(
    [
      "# a comment",
      "",
      "VLLM_BASE_URL=http://10.0.0.5:8000/v1   # reachable from pods",
      "export J2_MODEL=vllm/Qwen/Qwen3-32B",
      `SINGLE='raw $notinterpolated #nothash'`,
      `DOUBLE="line\\none"`,
      "  SPACED  =  padded  ",
      "EMPTY=",
      "not a key at all",
    ].join("\n"),
  );

  assert.deepEqual(parsed, {
    VLLM_BASE_URL: "http://10.0.0.5:8000/v1",
    J2_MODEL: "vllm/Qwen/Qwen3-32B",
    SINGLE: "raw $notinterpolated #nothash",
    DOUBLE: "line\none",
    SPACED: "padded",
    EMPTY: "",
  });
});

test("a quoted value may span lines (deploy keys)", () => {
  const parsed = parseDotenv('KEY="-----BEGIN-----\nabc\n-----END-----"\nAFTER=1\n');
  assert.equal(parsed.KEY, "-----BEGIN-----\nabc\n-----END-----");
  assert.equal(parsed.AFTER, "1", "parsing resumes after the closing quote");
});

test("loads from the instance root when run in a subdirectory", async () => {
  const { nested } = await mkInstance("VLLM_BASE_URL=http://10.0.0.5:8000/v1\n");
  const { io, err } = mkIo({ cwd: nested, env: {} });

  loadDotenv(io);

  assert.equal(io.env.VLLM_BASE_URL, "http://10.0.0.5:8000/v1");
  assert.match(err(), /→ \.env: VLLM_BASE_URL/, "applied keys are announced on stderr");
});

test("the real environment wins over the file", async () => {
  const { root } = await mkInstance("J2_MODEL=from-file\nOTHER=from-file\n");
  const { io } = mkIo({ cwd: root, env: { J2_MODEL: "from-shell" } });

  loadDotenv(io);

  assert.equal(io.env.J2_MODEL, "from-shell");
  assert.equal(io.env.OTHER, "from-file");
});

test("outside an instance, or with no .env, it is a no-op", async () => {
  const bare = await mkdtemp(join(tmpdir(), "j2-noenv-"));
  const { io, err } = mkIo({ cwd: bare, env: {} });
  loadDotenv(io);
  assert.deepEqual(io.env, {});

  await writeFile(join(bare, "j2.config.ts"), "export default {};\n"); // instance, but no .env
  loadDotenv(io);
  assert.deepEqual(io.env, {});
  assert.equal(err(), "", "silence when there is nothing to apply");
});
