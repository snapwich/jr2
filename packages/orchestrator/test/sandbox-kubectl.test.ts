// kubectlSandbox — the CR/exec MAPPING, against a fake process seam (the cluster itself is the
// kind e2e tier's job). What matters here: the CR carries the run labels + RO repos mount, Ready
// gates provisioning (returning the CR's own svc-DNS endpoint), and the attach script is the
// idempotent ADR-0004 sequence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { attachScript, kubectlSandbox } from "../src/sandbox-kubectl.ts";
import type { KubectlExec } from "../src/sandbox-kubectl.ts";

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

const readyStatus = JSON.stringify({ status: { phase: "Ready", endpoint: "http://sb-1.default.svc:8080" } });

test("provision applies the labeled CR with the RO repos mount, gates on Ready", async () => {
  let gets = 0;
  const { exec, calls } = fakeExec({
    apply: () => "applied",
    get: () => (++gets < 3 ? JSON.stringify({ status: { phase: "Pending" } }) : readyStatus),
  });
  const port = kubectlSandbox({ image: "j2/harness:dev", pollMs: 1, exec });

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
  // The repos volume is RO; the worktree root is a writable POD volume. Proven necessary on kind:
  // the operator runs the Harness as an unprivileged uid, so a work dir owned by the image (or
  // absent) makes every `attach` fail with "mkdir /work: permission denied" — and ADR-0005 has the
  // User Container sharing these worktrees, which only a pod volume can do.
  assert.deepEqual(applied.spec.volumeMounts, [
    { name: "repos", mountPath: "/repos", readOnly: true },
    { name: "work", mountPath: "/work" },
  ]);
  assert.deepEqual(applied.spec.volumes, [
    // The in-cluster source volume (ADR-0004/0019): the PVC the boot reconcile writes — no
    // hostPath, nothing kind-special.
    { name: "repos", persistentVolumeClaim: { claimName: "j2-repos", readOnly: true } },
    { name: "work", emptyDir: {} },
  ]);
});

test("env/envFrom pass through to the HARNESS container spec; mechanism env rides after them", async () => {
  const { exec, calls } = fakeExec({ apply: () => "ok", get: () => readyStatus });
  const port = kubectlSandbox({
    image: "img",

    pollMs: 1,
    exec,
    env: [{ name: "FLUE_LOG", value: "debug" }],
    envFrom: [{ secretRef: { name: "anthropic" } }],
  });
  await port.provision({ name: "sb-env", runId: "r", workflow: "w" });

  const applied = JSON.parse(calls[0]!.input!) as {
    spec: { env?: Array<{ name: string }>; envFrom?: unknown[]; sidecars?: unknown[] };
  };
  assert.deepEqual(applied.spec.env, [{ name: "FLUE_LOG", value: "debug" }]);
  assert.deepEqual(applied.spec.envFrom, [{ secretRef: { name: "anthropic" } }]);
  // No Adapter configured here → no sidecar, and no J2_ADAPTER_URL in the harness env.
  assert.equal(applied.spec.sidecars, undefined);
});

test("with an Adapter, user env precedes J2_ADAPTER_URL and envFrom never reaches the Adapter", async () => {
  const { exec, calls } = fakeExec({ apply: () => "ok", get: () => readyStatus, patch: () => "ok" });
  const port = kubectlSandbox({
    image: "img",
    adapterImage: "j2/adapter:dev",
    orchestratorUrl: "http://host:1234",
    signingKey: Buffer.from("k"),

    pollMs: 1,
    exec,
    env: [{ name: "FLUE_LOG", value: "debug" }],
    envFrom: [{ secretRef: { name: "anthropic" } }],
  });
  await port.provision({ name: "sb-env2", runId: "r", workflow: "w" });

  const crApply = calls.find((c) => c.args[0] === "apply" && c.input!.includes('"kind":"Sandbox"'))!;
  const applied = JSON.parse(crApply.input!) as {
    spec: {
      env: Array<{ name: string }>;
      envFrom: unknown[];
      sidecars: Array<{ name: string; envFrom: unknown[] }>;
    };
  };
  assert.deepEqual(
    applied.spec.env.map((e) => e.name),
    ["FLUE_LOG", "J2_ADAPTER_URL"],
  );
  assert.deepEqual(applied.spec.envFrom, [{ secretRef: { name: "anthropic" } }]);
  // The Adapter's envFrom stays exactly its token Secret (ADR-0013 asymmetry).
  assert.deepEqual(applied.spec.sidecars[0]!.envFrom, [{ secretRef: { name: "sb-env2-token" } }]);
});

test("caBundle: the j2-ca ConfigMap mounts into the HARNESS container with NODE_EXTRA_CA_CERTS; absent → nothing", async () => {
  const withCa = fakeExec({ apply: () => "ok", get: () => readyStatus });
  await kubectlSandbox({ image: "img", pollMs: 1, exec: withCa.exec, caBundle: true }).provision({
    name: "sb-ca",
    runId: "r",
    workflow: "w",
  });
  const applied = JSON.parse(withCa.calls[0]!.input!) as {
    spec: {
      env: Array<{ name: string; value: string }>;
      volumes: Array<{ name: string }>;
      volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
    };
  };
  assert.deepEqual(applied.spec.env, [{ name: "NODE_EXTRA_CA_CERTS", value: "/etc/j2/ca/ca.crt" }]);
  assert.deepEqual(applied.spec.volumes.at(-1), { name: "ca", configMap: { name: "j2-ca" } });
  // CR-level volumeMounts land on the HARNESS container only (operator contract) — the ADR-0020
  // asymmetry: the Adapter and User Container never inherit the trust path.
  assert.deepEqual(applied.spec.volumeMounts.at(-1), { name: "ca", mountPath: "/etc/j2/ca", readOnly: true });

  const without = fakeExec({ apply: () => "ok", get: () => readyStatus });
  await kubectlSandbox({ image: "img", pollMs: 1, exec: without.exec }).provision({
    name: "sb-noca",
    runId: "r",
    workflow: "w",
  });
  const bare = JSON.parse(without.calls[0]!.input!) as { spec: { env?: unknown; volumes: Array<{ name: string }> } };
  assert.equal(bare.spec.env, undefined);
  assert.ok(!bare.spec.volumes.some((v) => v.name === "ca"));
});

test("userImage: a third container sharing /work (+ RO /repos), no command, no user env", async () => {
  const { exec, calls } = fakeExec({ apply: () => "ok", get: () => readyStatus, patch: () => "ok" });
  const port = kubectlSandbox({
    image: "img",
    adapterImage: "j2/adapter:dev",
    userImage: "me/dotfiles:latest",
    orchestratorUrl: "http://host:1234",
    signingKey: Buffer.from("k"),

    pollMs: 1,
    exec,
    env: [{ name: "FLUE_LOG", value: "debug" }],
    envFrom: [{ secretRef: { name: "anthropic" } }],
  });
  await port.provision({ name: "sb-user", runId: "r", workflow: "w" });

  const crApply = calls.find((c) => c.args[0] === "apply" && c.input!.includes('"kind":"Sandbox"'))!;
  const applied = JSON.parse(crApply.input!) as {
    spec: {
      sidecars: Array<{
        name: string;
        image: string;
        command?: unknown;
        env?: unknown;
        envFrom?: unknown;
        volumeMounts?: unknown;
      }>;
    };
  };
  // Adapter first, User Container after — both opaque fragments on the same list (ADR-0001).
  assert.deepEqual(
    applied.spec.sidecars.map((s) => s.name),
    ["adapter", "user"],
  );
  const user = applied.spec.sidecars[1]!;
  assert.equal(user.image, "me/dotfiles:latest");
  // The worktrees are the point; RO /repos rides along for the --shared clones' objects.
  assert.deepEqual(user.volumeMounts, [
    { name: "work", mountPath: "/work" },
    { name: "repos", mountPath: "/repos", readOnly: true },
  ]);
  // j2 does not own the image: no injected command (its entrypoint must block), and none of the
  // Harness's env/envFrom — a human shell must not inherit the agent's model keys (ADR-0005/0013).
  assert.equal(user.command, undefined);
  assert.equal(user.env, undefined);
  assert.equal(user.envFrom, undefined);
});

test("userImage without an Adapter still lands as the only sidecar", async () => {
  const { exec, calls } = fakeExec({ apply: () => "ok", get: () => readyStatus });
  const port = kubectlSandbox({ image: "img", userImage: "me/tools:1", pollMs: 1, exec });
  await port.provision({ name: "sb-user2", runId: "r", workflow: "w" });

  const applied = JSON.parse(calls[0]!.input!) as { spec: { sidecars: Array<{ name: string }> } };
  assert.deepEqual(
    applied.spec.sidecars.map((s) => s.name),
    ["user"],
  );
});

test("keepalive lease: provision starts the annotate loop, exists() resumes it, destroy() stops it", async () => {
  const { exec, calls } = fakeExec({
    apply: () => "ok",
    get: () => readyStatus,
    delete: () => "deleted",
    annotate: () => "annotated",
  });
  const port = kubectlSandbox({ image: "img", pollMs: 1, heartbeatMs: 5, exec });

  await port.provision({ name: "sb-hb", runId: "r", workflow: "w" });
  const annotates = () => calls.filter((c) => c.args[0] === "annotate");
  // The first stamp is immediate (a restored Sandbox may be near its deadline)…
  assert.ok(annotates().length >= 1, "provision stamps a keepalive immediately");
  const first = annotates()[0]!.args;
  assert.deepEqual(first.slice(0, 3), ["annotate", "sandbox", "sb-hb"]);
  const kv = first.find((a) => a.startsWith("j2.dev/keepalive="))!;
  assert.ok(!Number.isNaN(Date.parse(kv.slice("j2.dev/keepalive=".length))), "value is a parseable timestamp");
  assert.ok(first.includes("--overwrite"), "re-stamps the existing annotation");
  // …then the interval keeps beating.
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(annotates().length >= 2, "heartbeat repeats on the interval");

  await port.destroy("sb-hb");
  const atDestroy = annotates().length;
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(annotates().length, atDestroy, "destroy() stops the lease");

  // A fresh process restoring this Sandbox resumes the lease from exists() (ADR-0012 probe).
  const restored = fakeExec({ get: () => readyStatus, annotate: () => "annotated", delete: () => "deleted" });
  const port2 = kubectlSandbox({ image: "img", heartbeatMs: 5, exec: restored.exec });
  assert.equal(await port2.exists("sb-hb"), true);
  await new Promise((r) => setTimeout(r, 1));
  assert.ok(
    restored.calls.some((c) => c.args[0] === "annotate"),
    "exists() restarts heartbeating for a restored Sandbox",
  );
  await port2.destroy("sb-hb");
});

test("release(runId): stops that run's leases by label WITHOUT deleting — the faulted-run path", async () => {
  const { exec, calls } = fakeExec({
    apply: () => "ok",
    annotate: () => "annotated",
    get: (call) => (call.args.includes("-l") ? "sb-rel-1 sb-rel-2" : readyStatus),
  });
  const port = kubectlSandbox({ image: "img", pollMs: 1, heartbeatMs: 5, exec });
  await port.provision({ name: "sb-rel-1", runId: "run-rel", workflow: "w" });
  await port.provision({ name: "sb-rel-2", runId: "run-rel", workflow: "w" });

  await port.release!("run-rel");
  const label = calls.find((c) => c.args[0] === "get" && c.args.includes("-l"))!;
  assert.ok(label.args.includes("j2.dev/run=run-rel"), "names come from the run label, not process memory");

  const settled = calls.filter((c) => c.args[0] === "annotate").length;
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(calls.filter((c) => c.args[0] === "annotate").length, settled, "no further beats after release");
  assert.ok(!calls.some((c) => c.args[0] === "delete"), "release never deletes — the pod stays inspectable");
});

test("keepalive lease: a NotFound annotate stops that Sandbox's loop", async () => {
  let annotateCalls = 0;
  const { exec } = fakeExec({
    apply: () => "ok",
    get: () => readyStatus,
    annotate: () => {
      annotateCalls++;
      throw new Error(`Error from server (NotFound): sandboxes.core.j2.dev "sb-gone" not found`);
    },
  });
  const port = kubectlSandbox({ image: "img", pollMs: 1, heartbeatMs: 5, exec });
  await port.provision({ name: "sb-gone", runId: "r", workflow: "w" });
  await new Promise((r) => setTimeout(r, 25));
  const settled = annotateCalls;
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(annotateCalls, settled, "no further beats once the Sandbox is gone");
});

test("exists(): NotFound is false; any other kubectl failure THROWS (probe failure is not 'no')", async () => {
  const notFound = fakeExec({
    get: () => {
      throw new Error(`Error from server (NotFound): sandboxes.core.j2.dev "gone" not found`);
    },
  });
  const port = kubectlSandbox({ image: "img", exec: notFound.exec });
  assert.equal(await port.exists("gone"), false);

  const down = fakeExec({
    get: () => {
      throw new Error("The connection to the server localhost:6443 was refused");
    },
  });
  const flaky = kubectlSandbox({ image: "img", exec: down.exec });
  await assert.rejects(() => flaky.exists("sb"), /refused/);
});

test("attach execs the idempotent ADR-0004 script in the harness container", async () => {
  const { exec, calls } = fakeExec({ exec: () => "" });
  const port = kubectlSandbox({ image: "img", exec });

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
  // The clone SOURCE is the RO volume the orchestrator's uid wrote — git's dubious-ownership
  // guard refuses it without this (safe.directory is honored from global config only, never -c).
  assert.match(script, /^git config --global safe\.directory '\*'/, "trusts the pod's j2-owned paths first");
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
