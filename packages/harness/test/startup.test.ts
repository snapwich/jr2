// The process conditioning the Harness does for itself (ADR-0037, ADR-0005). Every claim here is
// invisible in a Dockerfile now: a Sandbox runs the USER'S image, so the umask, the PATH append,
// and the HOME default exist only because this code runs — and a Working tool child inherits them
// from the process, never from an `ENV`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_HOME, prepareProcess, RUNTIME_BIN, WORK_UMASK } from "../src/startup.ts";

/** A umask sink, so the suite never moves the real process's mask under the other tests. */
function rig(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; masks: number[] } {
  const masks: number[] = [];
  prepareProcess(env, (mask) => masks.push(mask));
  return { env, masks };
}

test("umask 002: what the Agent writes on /work is group-writable for the work group", () => {
  const { masks } = rig({});
  assert.deepEqual(masks, [WORK_UMASK]);
  assert.equal(WORK_UMASK, 0o002);
});

test("PATH APPENDS /opt/jr2/bin — the image's own toolchain still wins", () => {
  const { env } = rig({ PATH: "/usr/local/bin:/usr/bin" });
  assert.equal(env.PATH, `/usr/local/bin:/usr/bin:${RUNTIME_BIN}`);
});

test("PATH: the append does not accumulate — the stock image carries it as ENV too", () => {
  const { env } = rig({ PATH: `/usr/bin:${RUNTIME_BIN}` });
  assert.equal(env.PATH, `/usr/bin:${RUNTIME_BIN}`);
});

test("PATH: an image that cleared PATH gets a POSIX base under the append, never jr2's bin alone", () => {
  const { env } = rig({});
  const entries = (env.PATH ?? "").split(":");
  assert.ok(entries.includes("/usr/bin"), "the toolchain a bare PATH would have deleted");
  assert.equal(entries.at(-1), RUNTIME_BIN, "jr2's bin stays the fallback, never the first hit");
});

test("PATH: an empty entry — which means the cwd, and the cwd is agent-authored — is dropped", () => {
  const { env } = rig({ PATH: "/usr/bin::" });
  assert.equal(env.PATH, `/usr/bin:${RUNTIME_BIN}`);
});

test("HOME: an image's own HOME is left alone — the exec'ing human lands where its author built", () => {
  const { env } = rig({ HOME: "/home/dev" });
  assert.equal(env.HOME, "/home/dev");
});

test("HOME: unset or empty falls back to the operator's no-USER home", () => {
  assert.equal(rig({}).env.HOME, FALLBACK_HOME);
  assert.equal(rig({ HOME: "" }).env.HOME, FALLBACK_HOME);
});
