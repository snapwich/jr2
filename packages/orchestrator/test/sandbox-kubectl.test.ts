// kubectlSandbox — the CR/exec/forward MAPPING, against fake process seams (the cluster itself
// is the kind e2e tier's job). What matters here: the CR carries the run labels + RO repos
// mount, Ready gates provisioning, the attach script is the idempotent ADR-0004 sequence, and
// the port-forward reach keeps endpoints deterministic (restart-stable) and healed by exists().

import { test } from "node:test";
import assert from "node:assert/strict";
import { attachScript, forwardPort, kubectlSandbox } from "../src/sandbox-kubectl.ts";
import type { KubectlExec, KubectlProc, KubectlSpawn } from "../src/sandbox-kubectl.ts";

type Call = { args: string[]; input?: string };

/** Script kubectl by verb: each handler sees the full argv and returns stdout (or throws). */
function fakeExec(handlers: Record<string, (call: Call) => string>) {
  const calls: Call[] = [];
  const exec: KubectlExec = async (args, opts) => {
    const call = { args, input: opts?.input };
    calls.push(call);
    const handler = handlers[args[0]!];
    if (!handler) throw new Error(`unexpected kubectl ${args[0]}`);
    return { stdout: handler(call), stderr: "" };
  };
  return { exec, calls };
}

function fakeSpawn() {
  const spawned: string[][] = [];
  let exitCb: (() => void) | undefined;
  const spawn: KubectlSpawn = (args) => {
    spawned.push(args);
    const proc: KubectlProc = {
      onLine: (cb) => queueMicrotask(() => cb("Forwarding from 127.0.0.1:whatever")),
      onExit: (cb) => (exitCb = cb),
      kill: () => exitCb?.(),
    };
    return proc;
  };
  return { spawn, spawned };
}

const readyStatus = JSON.stringify({ status: { phase: "Ready", endpoint: "http://sb-1.default.svc:8080" } });

test("provision applies the labeled CR with the RO repos mount, gates on Ready", async () => {
  let gets = 0;
  const { exec, calls } = fakeExec({
    apply: () => "applied",
    get: () => (++gets < 3 ? JSON.stringify({ status: { phase: "Pending" } }) : readyStatus),
  });
  const port = kubectlSandbox({ image: "j2/harness:dev", reach: "endpoint", pollMs: 1, exec });

  const { endpoint } = await port.provision({ name: "sb-1", runId: "run-9", workflow: "coding" });
  assert.equal(endpoint, "http://sb-1.default.svc:8080");
  assert.equal(gets, 3, "polled until phase Ready");

  const applied = JSON.parse(calls[0]!.input!) as {
    metadata: { name: string; labels: Record<string, string> };
    spec: { image: string; volumes: unknown[]; volumeMounts: Array<{ mountPath: string; readOnly: boolean }> };
  };
  assert.equal(applied.metadata.name, "sb-1");
  assert.deepEqual(applied.metadata.labels, { "j2.dev/run": "run-9", "j2.dev/workflow": "coding" });
  assert.equal(applied.spec.image, "j2/harness:dev");
  assert.deepEqual(applied.spec.volumeMounts, [{ name: "repos", mountPath: "/repos", readOnly: true }]);
});

test("port-forward reach: deterministic local endpoint, healed by exists(), dropped by destroy()", async () => {
  const { exec } = fakeExec({ apply: () => "ok", get: () => readyStatus, delete: () => "deleted" });
  const { spawn, spawned } = fakeSpawn();
  const port = kubectlSandbox({ image: "img", pollMs: 1, exec, spawn });

  const { endpoint } = await port.provision({ name: "sb-2", runId: "r", workflow: "w" });
  assert.equal(endpoint, `http://127.0.0.1:${forwardPort("sb-2")}`);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0]!.slice(0, 2), ["port-forward", "pod/sb-2"]);
  assert.ok(spawned[0]!.includes(`${forwardPort("sb-2")}:8080`));

  // Same process, forward alive → exists() reuses it; after destroy() a fresh exists() re-spawns
  // (the restart-heal path the workspace reconcile probe drives — ADR-0012 "same endpoint").
  assert.equal(await port.exists("sb-2"), true);
  assert.equal(spawned.length, 1);
  await port.destroy("sb-2");
  assert.equal(await port.exists("sb-2"), true);
  assert.equal(spawned.length, 2);
});

test("exists(): NotFound is false; any other kubectl failure THROWS (probe failure is not 'no')", async () => {
  const notFound = fakeExec({
    get: () => {
      throw new Error(`Error from server (NotFound): sandboxes.core.j2.dev "gone" not found`);
    },
  });
  const port = kubectlSandbox({ image: "img", reach: "endpoint", exec: notFound.exec });
  assert.equal(await port.exists("gone"), false);

  const down = fakeExec({
    get: () => {
      throw new Error("The connection to the server localhost:6443 was refused");
    },
  });
  const flaky = kubectlSandbox({ image: "img", reach: "endpoint", exec: down.exec });
  await assert.rejects(() => flaky.exists("sb"), /refused/);
});

test("attach execs the idempotent ADR-0004 script in the harness container", async () => {
  const { exec, calls } = fakeExec({ exec: () => "" });
  const port = kubectlSandbox({ image: "img", reach: "endpoint", exec });

  const spec = {
    repos: [
      { name: "app", baseRef: "main" },
      { name: "infra", baseRef: "v2" },
    ],
    branch: "feat/login",
  };
  const { workdir, repos } = await port.attach({ name: "sb-3", spec });
  assert.equal(workdir, "/work/app/feat-login");
  assert.deepEqual(repos, { app: "/work/app/feat-login", infra: "/work/infra/feat-login" });

  const argv = calls[0]!.args;
  assert.deepEqual(argv.slice(0, 2), ["exec", "pod/sb-3"]);
  assert.ok(argv.includes("harness"), "targets the harness container");
  const script = argv[argv.length - 1]!;
  assert.match(script, /git clone --shared --no-checkout '\/repos\/app\/default' '\/work\/app\/default'/);
  assert.match(script, /worktree add '\/work\/infra\/feat-login' -b 'feat\/login' 'v2'/);
  assert.match(script, /\[ -d '\/work\/app\/default\/\.git' \] \|\|/, "clone is guarded (idempotent re-run)");
});

test("attachScript quotes hostile refs and rejects an empty repo list", () => {
  const { script } = attachScript(
    { repos: [{ name: "app", baseRef: "main; rm -rf /" }], branch: "b" },
    { reposMount: "/repos", workRoot: "/work" },
  );
  assert.match(script, /-b 'b' 'main; rm -rf \/'/, "ref rides inside single quotes, never bare");
  assert.throws(
    () => attachScript({ repos: [], branch: "b" }, { reposMount: "/repos", workRoot: "/work" }),
    /no repos/,
  );
});
