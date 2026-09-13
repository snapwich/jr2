// Server-entrypoint tests (ADR-0019/0010): the process the instance image runs, and the e2e tier's
// per-scenario fixture. `serverMain` is the testable core — the `bin/server.ts` shebang only wires
// process env/cwd/signals onto it. Driven in-process on an ephemeral port, like instance.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serverMain } from "../src/server.ts";

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

/** An instance folder whose one workflow is a `workspace()` — a registered Machine that composes
 * a Sandbox, which is the data-plane switch (ADR-0051). The body is trivial and no run needs to
 * reach a cluster: what the boot decides off this Machine is the claim. Imported by absolute path,
 * like the bootstrap fixture: a temp folder resolves no bare `@j2/orchestrator`. */
async function mkWorkspaceInstance(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "j2-server-ws-"));
  await writeFile(join(dir, "j2.config.ts"), `export default { name: "ws" };\n`);
  await mkdir(join(dir, "workflows"), { recursive: true });
  const src = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts")).href;
  await writeFile(
    join(dir, "workflows", "ws.ts"),
    `import { setup } from ${JSON.stringify(import.meta.resolve("xstate"))};\n` +
      `import { workspace } from ${JSON.stringify(src)};\n` +
      `const body = setup({}).createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      `export const machine = workspace(body, { repos: { app: "https://example.test/app.git" }, spec: () => ({ branch: "b" }) });\n`,
  );
  return dir;
}

const authed = { headers: { authorization: "Bearer tok" } };

test("a registered Machine composing a Sandbox + J2_NAMESPACE → the data plane is wired (ADR-0051)", async () => {
  // The switch is read off the WALK, not off config: nothing in j2.config.ts says "this instance
  // has Workspaces". Deployed (J2_NAMESPACE set), the kubectl backend is built and the instance
  // reports a data plane. The blast pattern ADR-0038 chose still holds: no image map is mounted
  // here, and the boot serves anyway — only a provision would fail.
  const dir = await mkWorkspaceInstance();
  const inst = await serverMain({
    dir,
    env: { PORT: "0", HOST: "127.0.0.1", J2_INSTANCE_TOKEN: "tok", J2_SIGNING_KEY: KEY_B64, J2_NAMESPACE: "ws" },
    announce: () => {},
  });
  try {
    const repos = (await (await fetch(`${inst.url}/repos`, authed)).json()) as { dataPlane: boolean };
    assert.equal(repos.dataPlane, true);
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the same Machine with NO namespace → no port, and a workspace() run faults 'no Sandbox backend'", async () => {
  // A Workspace is always a real Sandbox (ADR-0012): a host-booted process has no cluster to drive,
  // so the switch stays off and the run says exactly why — durably, on the run, naming `j2 up`.
  const dir = await mkWorkspaceInstance();
  const inst = await serverMain({
    dir,
    env: { PORT: "0", HOST: "127.0.0.1", J2_INSTANCE_TOKEN: "tok", J2_SIGNING_KEY: KEY_B64 },
    announce: () => {},
  });
  try {
    const repos = (await (await fetch(`${inst.url}/repos`, authed)).json()) as { dataPlane: boolean };
    assert.equal(repos.dataPlane, false);
    const started = (await (
      await fetch(`${inst.url}/workflows/ws/runs`, {
        method: "POST",
        headers: { ...authed.headers, "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as { runId: string };
    let final: { status: string; fault?: string } | undefined;
    for (let i = 0; i < 200 && final?.status !== "error"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      final = (await (await fetch(`${inst.url}/runs/${started.runId}`, authed)).json()) as typeof final;
    }
    assert.equal(final?.status, "error");
    assert.match(final?.fault ?? "", /no Sandbox backend/);
    assert.match(final?.fault ?? "", /J2_NAMESPACE unset/);
    assert.match(final?.fault ?? "", /`j2 up`/);
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("no registered Machine composes a Sandbox → no data plane, even deployed", async () => {
  const inst = await serverMain({
    dir: fixtureDir,
    env: { PORT: "0", HOST: "127.0.0.1", J2_INSTANCE_TOKEN: "tok", J2_SIGNING_KEY: KEY_B64, J2_NAMESPACE: "echo" },
    announce: () => {},
  });
  try {
    const repos = (await (await fetch(`${inst.url}/repos`, authed)).json()) as { dataPlane: boolean; repos: unknown[] };
    assert.deepEqual(repos, { dataPlane: false, repos: [] });
  } finally {
    await inst.close();
  }
});
