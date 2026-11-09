// The Forward (ADR-0056): a `jr2` run inside an Instance that resolves its own `@jr2/cli` to a
// different copy runs THAT copy's binary — same argv, same stdio, its exit code — and otherwise
// runs itself. The decision is unit-tested on `forwardTarget`; the real `bin/jr2.js` is then
// spawned once against a fake local kit to prove the launcher does what the decision says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FORWARD_ENV, forwardedFrom, forwardTarget } from "../src/forward.ts";
import { CLI_ROOT, CLI_VERSION } from "../src/kit-version.ts";
import { fakeKit } from "./_kit.ts";

const BIN = fileURLToPath(new URL("../bin/jr2.js", import.meta.url));
const exec = promisify(execFile);

async function mkInstance(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jr2-forward-"));
  await writeFile(join(root, "jr2.config.ts"), "export default {};\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "inst", version: "0.0.0" }));
  return root;
}

test("no Instance → no Forward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jr2-noinst-"));
  try {
    assert.equal(forwardTarget(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an Instance with no local @jr2/cli → no Forward (the running copy runs)", async () => {
  const root = await mkInstance();
  try {
    assert.equal(forwardTarget(root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an Instance that resolves the running copy itself → no Forward", async () => {
  const root = await mkInstance();
  try {
    const { mkdir, symlink } = await import("node:fs/promises");
    await mkdir(join(root, "node_modules", "@jr2"), { recursive: true });
    await symlink(CLI_ROOT, join(root, "node_modules", "@jr2", "cli"));
    assert.equal(forwardTarget(root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an Instance with ANOTHER @jr2/cli → forward to its bin, from any depth", async () => {
  const root = await mkInstance();
  try {
    const dir = await fakeKit(root, "@jr2/cli", "9.9.9", "process.exitCode = 0;\n");
    const { mkdir, realpath } = await import("node:fs/promises");
    const deep = join(root, "workflows", "nested");
    await mkdir(deep, { recursive: true });
    assert.equal(forwardTarget(deep), join(await realpath(dir), "bin", "jr2.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the launcher runs the local bin with the same argv, names itself in the env, and returns its exit code", async () => {
  const root = await mkInstance();
  try {
    const record = join(root, "argv.json");
    await fakeKit(
      root,
      "@jr2/cli",
      "9.9.9",
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), from: process.env.${FORWARD_ENV} }));\n` +
        `process.exitCode = 7;\n`,
    );
    type Exit = { code?: number; stdout: string; stderr: string };
    const r: Exit = await exec(process.execPath, [BIN, "runs", "--namespace", "x"], { cwd: root }).catch(
      (e: Exit) => e,
    );
    assert.equal(r.code, 7, `the local bin's exit code came back (stderr: ${r.stderr})`);
    const recorded = JSON.parse(await readFile(record, "utf8")) as { argv: string[]; from: string };
    assert.deepEqual(recorded.argv, ["runs", "--namespace", "x"]);
    // ADR-0056: the one env var, so `jr2 version` can print the global that forwarded.
    assert.deepEqual(forwardedFrom({ [FORWARD_ENV]: recorded.from }), { version: CLI_VERSION, path: CLI_ROOT });
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

test("a global of any published version names itself to this copy: the variable is JR2_HANDOFF_FROM", () => {
  // v0.1.4 to v0.7.0 set this name, and a global cannot be updated once it ships (ADR-0056). A
  // new name would drop the `global` line for every user who upgrades the Instance and keeps the
  // global, and a newer global that forwards into an older Instance would drop it too.
  assert.equal(FORWARD_ENV, "JR2_HANDOFF_FROM");
  assert.deepEqual(forwardedFrom({ JR2_HANDOFF_FROM: "0.7.0 /opt/g/node_modules/@jr2/cli" }), {
    version: "0.7.0",
    path: "/opt/g/node_modules/@jr2/cli",
  });
});

test("forwardedFrom reads `<version> <path>` and nothing else", () => {
  assert.equal(forwardedFrom({}), undefined, "no Forward, or a global that predates the variable");
  assert.equal(forwardedFrom({ [FORWARD_ENV]: "" }), undefined);
  assert.equal(forwardedFrom({ [FORWARD_ENV]: "0.1.1" }), undefined, "half a value is no value");
  assert.deepEqual(forwardedFrom({ [FORWARD_ENV]: "0.1.1 /opt/x/node_modules/@jr2/cli" }), {
    version: "0.1.1",
    path: "/opt/x/node_modules/@jr2/cli",
  });
  assert.deepEqual(forwardedFrom({ [FORWARD_ENV]: "0.1.1 /a path/with spaces" }), {
    version: "0.1.1",
    path: "/a path/with spaces",
  });
});
