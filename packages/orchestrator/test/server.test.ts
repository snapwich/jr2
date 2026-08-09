// Server-entrypoint tests (ADR-0019/0010): the process the instance image runs, and the e2e tier's
// per-scenario fixture. `serverMain` is the testable core — the `bin/server.ts` shebang only wires
// process env/cwd/signals onto it. Driven in-process on an ephemeral port, like instance.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serverMain } from "../src/server.ts";

const execFileAsync = promisify(execFile);

// The same fixture instance folder instance.test.ts serves (holds `workflows/echo.ts`).
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "instance");
const KEY_B64 = Buffer.alloc(32, 7).toString("base64");

test("boots the instance from env and announces its address as one JSON line", async () => {
  const lines: string[] = [];
  const inst = await serverMain({
    dir: fixtureDir,
    env: { PORT: "0", HOST: "127.0.0.1", J2_INSTANCE_TOKEN: "tok", J2_SIGNING_KEY: KEY_B64 },
    announce: (line) => lines.push(line),
  });
  try {
    // The announcement is the fixture's (and an operator's) discovery seam: parseable, first line.
    const parsed = JSON.parse(lines[0]!) as { url: string; workflows: string[] };
    assert.equal(parsed.url, inst.url);
    assert.deepEqual(parsed.workflows, ["echo"]);

    // It serves, authenticated with the supplied token (the deployed Secret's credential).
    const res = await fetch(`${inst.url}/runs`, { headers: { authorization: "Bearer tok" } });
    assert.equal(res.status, 200);
  } finally {
    await inst.close();
  }
});

test("J2_SIGNING_KEY from env keeps the key out of the pod filesystem", async () => {
  // A dir with no `.j2/secret`: with the env key supplied, none may be minted onto disk — the key
  // must live in the Secret so Sandbox tokens survive a pod restart (ADR-0013/0019).
  const dir = await mkdtemp(join(tmpdir(), "j2-server-"));
  const inst = await serverMain({
    dir,
    env: { PORT: "0", HOST: "127.0.0.1", J2_SIGNING_KEY: KEY_B64 },
    announce: () => {},
  });
  try {
    await assert.rejects(access(join(dir, ".j2", "secret")), "signing key must not be written to disk");
  } finally {
    await inst.close();
  }
});

test("a repos-ful instance boots and serves with NO image map mounted — only a provision fails", async () => {
  // The blast pattern ADR-0038 chose (images.ts reads the map per provision, never at boot): an
  // Orchestrator whose `j2-images` ConfigMap has not propagated yet still comes up and serves.
  // A boot-time read would turn one kubelet propagation window into a CrashLoopBackOff.
  const dir = await mkdtemp(join(tmpdir(), "j2-server-repos-"));
  const origin = join(dir, "origin.git");
  await execFileAsync("git", ["init", "--bare", "-q", origin]);
  await writeFile(
    join(dir, "j2.config.ts"),
    `export default { repos: [{ name: "app", url: ${JSON.stringify(origin)} }] };\n`,
  );

  const lines: string[] = [];
  const inst = await serverMain({
    dir,
    env: {
      PORT: "0",
      HOST: "127.0.0.1",
      J2_INSTANCE_TOKEN: "tok",
      J2_SIGNING_KEY: KEY_B64,
      J2_REPOS_DIR: join(dir, "repos"),
    },
    announce: (line) => lines.push(line),
  });
  try {
    // The data-plane switch flipped (a Sandbox backend is wired) and the process is serving.
    assert.ok(
      lines.some((l) => l.includes('"repo":"app"')),
      "the boot reconcile ran",
    );
    const res = await fetch(`${inst.url}/runs`, { headers: { authorization: "Bearer tok" } });
    assert.equal(res.status, 200);
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});
