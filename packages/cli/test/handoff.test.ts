// The Handoff (ADR-0056): a `jr2` run inside an Instance that resolves its own `@jr2/cli` to a
// different copy runs THAT copy's binary — same argv, same stdio, its exit code — and otherwise
// runs itself. The decision is unit-tested on `handoffTarget`; the real `bin/jr2.js` is then
// spawned once against a fake local kit to prove the launcher does what the decision says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { handoffTarget } from "../src/handoff.ts";
import { CLI_ROOT } from "../src/kit-version.ts";
import { fakeKit } from "./_kit.ts";

const BIN = fileURLToPath(new URL("../bin/jr2.js", import.meta.url));
const exec = promisify(execFile);

async function mkInstance(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jr2-handoff-"));
  await writeFile(join(root, "jr2.config.ts"), "export default {};\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "inst", version: "0.0.0" }));
  return root;
}

test("no Instance → no handoff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jr2-noinst-"));
  try {
    assert.equal(handoffTarget(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an Instance with no local @jr2/cli → no handoff (the running copy runs)", async () => {
  const root = await mkInstance();
  try {
    assert.equal(handoffTarget(root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an Instance that resolves the running copy itself → no handoff", async () => {
  const root = await mkInstance();
  try {
    const { mkdir, symlink } = await import("node:fs/promises");
    await mkdir(join(root, "node_modules", "@jr2"), { recursive: true });
    await symlink(CLI_ROOT, join(root, "node_modules", "@jr2", "cli"));
    assert.equal(handoffTarget(root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an Instance with ANOTHER @jr2/cli → hand off to its bin, from any depth", async () => {
  const root = await mkInstance();
  try {
    const dir = await fakeKit(root, "@jr2/cli", "9.9.9", "process.exitCode = 0;\n");
    const { mkdir, realpath } = await import("node:fs/promises");
    const deep = join(root, "workflows", "nested");
    await mkdir(deep, { recursive: true });
    assert.equal(handoffTarget(deep), join(await realpath(dir), "bin", "jr2.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the launcher runs the local bin with the same argv and returns its exit code", async () => {
  const root = await mkInstance();
  try {
    const record = join(root, "argv.json");
    await fakeKit(
      root,
      "@jr2/cli",
      "9.9.9",
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n` +
        `process.exitCode = 7;\n`,
    );
    type Exit = { code?: number; stdout: string; stderr: string };
    const r: Exit = await exec(process.execPath, [BIN, "runs", "--namespace", "x"], { cwd: root }).catch(
      (e: Exit) => e,
    );
    assert.equal(r.code, 7, `the local bin's exit code came back (stderr: ${r.stderr})`);
    assert.deepEqual(JSON.parse(await readFile(record, "utf8")), ["runs", "--namespace", "x"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("outside any Instance the launcher runs itself", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jr2-noinst-"));
  try {
    const r = await exec(process.execPath, [BIN, "--help"], { cwd: dir });
    assert.match(r.stderr, /usage: jr2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
