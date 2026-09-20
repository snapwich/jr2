// Instance addressing (ADR-0009/0019): the folder walk to `jr2.config.ts`, and how `resolveTarget`
// finds the deployed orchestrator — `--url` / `JR2_URL` short-circuits everything; otherwise the
// current kube context + the instance's namespace, over an injectable kube port (port-forward +
// Secret read), with the target printed on stderr so ambient-context drift stays visible.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveRoot, resolveTarget } from "../src/instance.ts";
import type { KubePort } from "../src/kube.ts";
import type { Io } from "../src/output.ts";

/** A minimal Io for the pure path-resolution code (no streams/fetch exercised). */
function mkIo(over: Partial<Io>): Io {
  return { stdout: () => {}, stderr: () => {}, env: {}, cwd: "/", ...over };
}

/** A kube port that answers like a cluster hosting the instance; records what it was asked. */
function fakeKube(asked: Array<Record<string, unknown>>): KubePort {
  return {
    currentContext: async () => "kind-test",
    readSecret: async (opts) => {
      asked.push({ readSecret: opts });
      return "tok-in-secret";
    },
    portForward: async (opts) => {
      asked.push({ portForward: opts });
      return { url: "http://127.0.0.1:55555", close: () => asked.push({ closed: true }) };
    },
  };
}

/** A kube port that must never be consulted (the `--url` escape hatch skips the cluster). */
const untouchableKube: KubePort = {
  currentContext: async () => assert.fail("kube consulted despite --url"),
  readSecret: async () => assert.fail("kube consulted despite --url"),
  portForward: async () => assert.fail("kube consulted despite --url"),
};

async function mkInstance(config = "export default {};\n"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jr2-cli-inst-"));
  await writeFile(join(root, "jr2.config.ts"), config);
  return root;
}

test("resolveRoot walks up to the dir holding jr2.config.ts", async () => {
  const root = await mkInstance();
  try {
    const deep = join(root, "a", "b", "c");
    await mkdir(deep, { recursive: true });
    assert.equal(resolveRoot(deep), root);
    assert.equal(resolveRoot(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveRoot throws when not inside an instance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jr2-cli-noinst-"));
  try {
    assert.throws(() => resolveRoot(dir), /no jr2\.config\.ts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--url / JR2_URL short-circuit: no folder walk, no kube, JR2_TOKEN as credential", async () => {
  const io = mkIo({ cwd: "/", env: { JR2_URL: "http://env", JR2_TOKEN: "t" }, kube: untouchableKube });
  const viaEnv = await resolveTarget(io, {});
  assert.equal(viaEnv.url, "http://env");
  assert.equal(viaEnv.token, "t");

  const viaFlag = await resolveTarget(io, { url: "http://flag" });
  assert.equal(viaFlag.url, "http://flag");
});

test("kube path: port-forwards the Service in the instance's namespace, token from its Secret", async () => {
  const root = await mkInstance(`export default { name: "myinst" };\n`);
  const asked: Array<Record<string, unknown>> = [];
  const preamble: string[] = [];
  try {
    const io = mkIo({ cwd: root, env: {}, kube: fakeKube(asked), stderr: (s) => preamble.push(s) });
    const target = await resolveTarget(io, {});
    assert.equal(target.url, "http://127.0.0.1:55555");
    assert.equal(target.token, "tok-in-secret");

    // namespace defaults to config.name (ADR-0019: namespace is identity).
    assert.deepEqual(asked[0], {
      readSecret: { namespace: "myinst", name: "jr2-instance", key: "JR2_INSTANCE_TOKEN" },
    });
    assert.deepEqual(asked[1], { portForward: { namespace: "myinst", service: "jr2-orchestrator", port: 4000 } });

    // The run-verb preamble: the target context is visible on stderr (ADR-0019).
    assert.match(preamble.join(""), /kind-test/);
    assert.match(preamble.join(""), /myinst/);

    target.close?.();
    assert.deepEqual(asked.at(-1), { closed: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("namespace precedence: -n flag > config.name > folder name; --context is passed through", async () => {
  const root = await mkInstance(); // config with no name → folder name is the namespace
  const asked: Array<Record<string, unknown>> = [];
  try {
    const io = mkIo({ cwd: root, env: {}, kube: fakeKube(asked) });
    await resolveTarget(io, {});
    assert.equal((asked[0] as { readSecret: { namespace: string } }).readSecret.namespace, basename(root));

    asked.length = 0;
    await resolveTarget(io, { namespace: "flagns", context: "other-ctx" });
    assert.deepEqual(asked[0], {
      readSecret: { namespace: "flagns", name: "jr2-instance", key: "JR2_INSTANCE_TOKEN", context: "other-ctx" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cluster with no instance errors with 'not deployed here'", async () => {
  const root = await mkInstance();
  try {
    const io = mkIo({
      cwd: root,
      env: {},
      kube: {
        currentContext: async () => "kind-test",
        readSecret: async () => undefined,
        portForward: async () => assert.fail("no forward without a Secret"),
      },
    });
    await assert.rejects(() => resolveTarget(io, {}), /not deployed here — right context\?/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
