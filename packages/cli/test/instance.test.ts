// Instance addressing (ADR-0009): the folder walk to `j2.config.ts`, reading `.j2/dev.json`, and the
// `--url` > `J2_URL` > dev.json precedence `resolveBaseUrl` enforces. Pure fs + string logic — driven
// against throwaway tmp dirs, no orchestrator needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDevJson, resolveBaseUrl, resolveRoot } from "../src/instance.ts";
import type { Io } from "../src/output.ts";

/** A minimal Io for the pure path-resolution code (no streams/fetch exercised). */
function mkIo(over: Partial<Io>): Io {
  return { stdout: () => {}, stderr: () => {}, env: {}, cwd: "/", ...over };
}

test("resolveRoot walks up to the dir holding j2.config.ts", async () => {
  const root = await mkdtemp(join(tmpdir(), "j2-cli-root-"));
  try {
    await writeFile(join(root, "j2.config.ts"), "export default {};\n");
    const deep = join(root, "a", "b", "c");
    await mkdir(deep, { recursive: true });
    assert.equal(resolveRoot(deep), root);
    assert.equal(resolveRoot(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveRoot throws when not inside an instance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "j2-cli-noinst-"));
  try {
    assert.throws(() => resolveRoot(dir), /no j2\.config\.ts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readDevJson reads .j2/dev.json, undefined when absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "j2-cli-dev-"));
  try {
    await mkdir(join(root, ".j2"), { recursive: true });
    await writeFile(join(root, ".j2", "dev.json"), JSON.stringify({ url: "http://x:1", pid: 7 }));
    assert.deepEqual(readDevJson(root), { url: "http://x:1", pid: 7 });
    assert.equal(readDevJson(join(root, "missing")), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveBaseUrl precedence: --url > J2_URL > dev.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "j2-cli-base-"));
  try {
    await writeFile(join(root, "j2.config.ts"), "export default {};\n");
    await mkdir(join(root, ".j2"), { recursive: true });
    await writeFile(join(root, ".j2", "dev.json"), JSON.stringify({ url: "http://dev", pid: 1 }));

    assert.equal(
      resolveBaseUrl(mkIo({ cwd: root, env: { J2_URL: "http://env" } }), { url: "http://flag" }),
      "http://flag",
    );
    assert.equal(resolveBaseUrl(mkIo({ cwd: root, env: { J2_URL: "http://env" } }), {}), "http://env");
    assert.equal(resolveBaseUrl(mkIo({ cwd: root, env: {} }), {}), "http://dev");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveBaseUrl throws when an instance has no running orchestrator", async () => {
  const root = await mkdtemp(join(tmpdir(), "j2-cli-nodev-"));
  try {
    await writeFile(join(root, "j2.config.ts"), "export default {};\n");
    assert.throws(() => resolveBaseUrl(mkIo({ cwd: root, env: {} }), {}), /no running orchestrator/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
