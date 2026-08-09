// kubectlSandbox — the CR/exec MAPPING, against a fake process seam (the cluster itself is the
// kind e2e tier's job). What matters here: the CR carries the run labels + RO repos mount, Ready
// gates provisioning (returning the CR's own svc-DNS endpoint), the attach script is the
// idempotent ADR-0004 sequence, and — since ADR-0037/0038 — `spec.image` is RESOLVED from the
// mounted image map on every provision rather than pinned at construction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Every provision now applies a token Secret first (the Adapter is unconditional — ADR-0013), so
 * "the CR" is the apply whose body is a Sandbox, never simply the first call. */
const crOf = (calls: Call[]): any =>
  JSON.parse(calls.find((c) => c.args[0] === "apply" && c.input!.includes('"kind":"Sandbox"'))!.input!);

/** The mounted `j2-images` map (ADR-0038) as a real file — the port reads it per provision. */
async function mkImages(refs: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "j2-images-"));
  const path = join(dir, "images.json");
  await writeFile(path, JSON.stringify(refs));
  return path;
}

const REFS = {
  harness: "j2-harness:h00",
  adapter: "j2-adapter:a00",
  sandbox: { default: "j2-workspace-inst-default:d00", rust: "j2-workspace-inst-rust:r00" },
};

/** Everything a provision needs beyond the images map: the Adapter is always injected now, so its
 * token Secret (and therefore a signing key and a route home) is no longer optional. */
const provisionable = { signingKey: Buffer.from("k"), orchestratorUrl: "http://host:1234", pollMs: 1 };

const readyStatus = JSON.stringify({
  status: { phase: "Ready", endpoint: "http://sb-1.default.svc:8080", podUID: "pod-uid-1" },
});

test("provision applies the labeled CR with the RO repos mount, gates on Ready", async () => {
  let gets = 0;
  const { exec, calls } = fakeExec({
    apply: () => "applied",
    patch: () => "ok",
    get: () => (++gets < 3 ? JSON.stringify({ status: { phase: "Pending" } }) : readyStatus),
  });
  const port = kubectlSandbox({ imagesPath: await mkImages(REFS), ...provisionable, exec });

  const { endpoint } = await port.provision({ name: "sb-1", runId: "run-9", workflow: "coding" });
  assert.equal(endpoint, "http://sb-1.default.svc:8080");
  assert.equal(gets, 3, "polled until phase Ready");

  const applied = crOf(calls);
  assert.equal(applied.metadata.name, "sb-1");
  assert.deepEqual(applied.metadata.labels, { "j2.dev/run": "run-9", "j2.dev/workflow": "coding" });
  // No name on the spec → `images/default` (ADR-0037's middle leg), resolved from the map.
  assert.equal(applied.spec.image, "j2-workspace-inst-default:d00");
  // The repos volume is RO; the worktree root is a writable POD volume. Proven necessary on kind:
  // the operator runs the Harness as an unprivileged uid, so a work dir owned by the image (or
  // absent) makes every `attach` fail with "mkdir /work: permission denied" — and `/work` is the
  // wrap's WORKDIR (ADR-0037), where a human's `kubectl exec` lands on the same worktrees.
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

test("the Sandbox Image chain: spec name → images/default → the stock Harness", async () => {
  const provisionWith = async (refs: unknown, image?: string): Promise<string> => {
    const { exec, calls } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
    const port = kubectlSandbox({ imagesPath: await mkImages(refs), ...provisionable, exec });
    await port.provision({ name: "sb", runId: "r", workflow: "w", ...(image ? { image } : {}) });
    return crOf(calls).spec.image;
  };

  assert.equal(await provisionWith(REFS, "rust"), "j2-workspace-inst-rust:r00", "the spec's name wins");
  assert.equal(await provisionWith(REFS), "j2-workspace-inst-default:d00", "no name → images/default");
  // The last leg comes out of the MAP, not a `j2-harness:<kitversion>` literal: in a kit checkout
  // the Harness is a content-addressed tag (ADR-0038) and a literal would name nothing built.
  assert.equal(
    await provisionWith({ harness: "j2-harness:h00", adapter: "j2-adapter:a00", sandbox: {} }),
    "j2-harness:h00",
    "no images/default → the stock Harness",
  );
});

test("an unknown image name fails the provision with NOTHING applied, listing what was discovered", async () => {
  const { exec, calls } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  const port = kubectlSandbox({ imagesPath: await mkImages(REFS), ...provisionable, exec });

  await assert.rejects(
    () => port.provision({ name: "sb", runId: "r", workflow: "w", image: "golang" }),
    (err: Error) => {
      assert.match(err.message, /no Sandbox Image named "golang"/);
      assert.match(err.message, /"default", "rust"/, "the error lists what the converge built");
      return true;
    },
  );
  // Read-first is what buys this: no token Secret, no CR, nothing for anyone to clean up.
  assert.deepEqual(calls, []);
});

test("the map is re-read PER provision, so a converge reaches the next Sandbox without a roll", async () => {
  // The whole reason the refs arrive as a mounted ConfigMap rather than Deployment env (ADR-0038):
  // a rebuilt image must reach FUTURE Sandboxes without bouncing every live run through restore.
  const imagesPath = await mkImages(REFS);
  const { exec, calls } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  const port = kubectlSandbox({ imagesPath, ...provisionable, exec });

  await port.provision({ name: "sb-a", runId: "r", workflow: "w" });
  await writeFile(imagesPath, JSON.stringify({ ...REFS, sandbox: { default: "j2-workspace-inst-default:d99" } }));
  await port.provision({ name: "sb-b", runId: "r", workflow: "w" });

  const images = calls
    .filter((c) => c.args[0] === "apply" && c.input!.includes('"kind":"Sandbox"'))
    .map((c) => (JSON.parse(c.input!) as { spec: { image: string } }).spec.image);
  assert.deepEqual(images, ["j2-workspace-inst-default:d00", "j2-workspace-inst-default:d99"]);
});

test("an absent or malformed image map fails the provision pointing at `j2 up`, never a published tag", async () => {
  const { exec } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  const missing = kubectlSandbox({ imagesPath: "/nonexistent/j2/images.json", ...provisionable, exec });
  await assert.rejects(
    () => missing.provision({ name: "sb", runId: "r", workflow: "w" }),
    (err: Error) => {
      assert.match(err.message, /\/nonexistent\/j2\/images\.json/, "names the path");
      assert.match(err.message, /j2 up/, "names the fix");
      return true;
    },
  );

  // A map with no `adapter` is loud, not a pod with no route home: an Agent whose Adapter is
  // missing parks its Machine forever on a tool call it cannot make (ADR-0013).
  const noAdapter = kubectlSandbox({
    imagesPath: await mkImages({ harness: "j2-harness:h00", sandbox: {} }),
    ...provisionable,
    exec,
  });
  await assert.rejects(() => noAdapter.provision({ name: "sb", runId: "r", workflow: "w" }), /no `adapter` ref/);
});

test("env/envFrom pass through to the HARNESS container spec; mechanism env rides after them", async () => {
  const { exec, calls } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  const port = kubectlSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    exec,
    env: [{ name: "FLUE_LOG", value: "debug" }],
    envFrom: [{ secretRef: { name: "anthropic" } }],
  });
  await port.provision({ name: "sb-env", runId: "r", workflow: "w" });

  const applied = crOf(calls);
  assert.deepEqual(
    applied.spec.env.map((e: { name: string }) => e.name),
    ["FLUE_LOG", "J2_ADAPTER_URL"],
  );
  assert.deepEqual(applied.spec.envFrom, [{ secretRef: { name: "anthropic" } }]);
});

test("the Adapter is UNCONDITIONAL and is the pod's only credential holder", async () => {
  const { exec, calls } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  const port = kubectlSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    exec,
    envFrom: [{ secretRef: { name: "anthropic" } }],
  });
  await port.provision({ name: "sb-env2", runId: "r", workflow: "w" });

  const applied = crOf(calls);
  // One sidecar, always. With the ref in the map there is no "no adapter configured" state left to
  // branch on — and the User Container is gone (ADR-0037), so this list is exactly the Adapter.
  assert.deepEqual(
    applied.spec.sidecars.map((s: { name: string; image: string }) => [s.name, s.image]),
    [["adapter", "j2-adapter:a00"]],
  );
  // The Adapter's envFrom stays exactly its token Secret (ADR-0013 asymmetry).
  assert.deepEqual(applied.spec.sidecars[0].envFrom, [{ secretRef: { name: "sb-env2-token" } }]);
  const secret = JSON.parse(calls.find((c) => c.args[0] === "apply" && c.input!.includes('"kind":"Secret"'))!.input!);
  assert.equal(secret.metadata.name, "sb-env2-token");
});

test("caBundle: the j2-ca ConfigMap mounts into the HARNESS container with NODE_EXTRA_CA_CERTS; absent → nothing", async () => {
  const imagesPath = await mkImages(REFS);
  const withCa = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  await kubectlSandbox({ imagesPath, ...provisionable, exec: withCa.exec, caBundle: true }).provision({
    name: "sb-ca",
    runId: "r",
    workflow: "w",
  });
  const applied = crOf(withCa.calls);
  assert.deepEqual(applied.spec.env, [
    { name: "J2_ADAPTER_URL", value: "http://127.0.0.1:8081" },
    { name: "NODE_EXTRA_CA_CERTS", value: "/etc/j2/ca/ca.crt" },
  ]);
  assert.deepEqual(applied.spec.volumes.at(-1), { name: "ca", configMap: { name: "j2-ca" } });
  // CR-level volumeMounts land on the HARNESS container only (operator contract) — the ADR-0020
  // asymmetry: the Adapter never inherits the trust path.
  assert.deepEqual(applied.spec.volumeMounts.at(-1), { name: "ca", mountPath: "/etc/j2/ca", readOnly: true });

  const without = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  await kubectlSandbox({ imagesPath, ...provisionable, exec: without.exec }).provision({
    name: "sb-noca",
    runId: "r",
    workflow: "w",
  });
  const bare = crOf(without.calls);
  assert.ok(!bare.spec.volumes.some((v: { name: string }) => v.name === "ca"));
});

test("provision reports the pod identity the lease will hold the workspace to", async () => {
  const { exec } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  const port = kubectlSandbox({ imagesPath: await mkImages(REFS), ...provisionable, exec });

  assert.deepEqual(await port.provision({ name: "sb-1", runId: "r", workflow: "w" }), {
    endpoint: "http://sb-1.default.svc:8080",
    identity: "pod-uid-1",
  });
});

test("renew(): one call stamps the lease AND reads back continuity", async () => {
  const { exec, calls } = fakeExec({ annotate: () => readyStatus });
  const port = kubectlSandbox({ exec });

  assert.deepEqual(await port.renew("sb-1"), { present: true, identity: "pod-uid-1" });

  // Exactly one round trip — the whole point of folding the read into the write.
  assert.equal(calls.length, 1);
  const args = calls[0]!.args;
  assert.deepEqual(args.slice(0, 3), ["annotate", "sandbox", "sb-1"]);
  const kv = args.find((a) => a.startsWith("j2.dev/keepalive="))!;
  assert.ok(!Number.isNaN(Date.parse(kv.slice("j2.dev/keepalive=".length))), "value is a parseable timestamp");
  assert.ok(args.includes("--overwrite"), "re-stamps the existing annotation");
  assert.deepEqual(args.slice(-2), ["-o", "json"], "prints the patched object, status included");
});

test("renew(): a replacement pod is reported as a NEW identity under the same name", async () => {
  // What an eviction looks like from here: the CR answers, the name is unchanged, the endpoint
  // is unchanged — and the pod behind it is a different pod with an empty `work` volume.
  const { exec } = fakeExec({
    annotate: () =>
      JSON.stringify({ status: { phase: "Ready", endpoint: "http://sb-1.default.svc:8080", podUID: "pod-uid-2" } }),
  });
  const port = kubectlSandbox({ exec });

  assert.deepEqual(await port.renew("sb-1"), { present: true, identity: "pod-uid-2" });
});

test("renew(): NotFound is absent; any other kubectl failure THROWS (unknown is never loss)", async () => {
  const notFound = fakeExec({
    annotate: () => {
      throw new Error(`Error from server (NotFound): sandboxes.core.j2.dev "gone" not found`);
    },
  });
  assert.deepEqual(await kubectlSandbox({ exec: notFound.exec }).renew("gone"), { present: false });

  const down = fakeExec({
    annotate: () => {
      throw new Error("The connection to the server localhost:6443 was refused");
    },
  });
  // Rejecting is load-bearing: resolving `{present: false}` here would settle every live run
  // in the namespace the first time the API server hiccuped.
  await assert.rejects(() => kubectlSandbox({ exec: down.exec }).renew("sb"), /refused/);
});

test("renew(): an operator that publishes no podUID degrades to presence-only continuity", async () => {
  const { exec } = fakeExec({
    annotate: () => JSON.stringify({ status: { phase: "Ready", endpoint: "http://sb-1.default.svc:8080" } }),
  });
  assert.deepEqual(await kubectlSandbox({ exec }).renew("sb-1"), {
    present: true,
    identity: undefined,
  });
});

test("attach execs the idempotent ADR-0004 script in the harness container", async () => {
  const { exec, calls } = fakeExec({ exec: () => "" });
  const port = kubectlSandbox({ exec });

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
  // Still `harness`, and still right after ADR-0037: the wrapped Sandbox Image IS that container.
  assert.ok(argv.includes("harness"), "targets the harness container");
  const script = argv[argv.length - 1]!;
  assert.match(script, /git clone --shared --no-checkout '\/repos\/app\/default' '\/work\/app\/default'/);
  assert.match(script, /worktree add '\/work\/infra\/feat-login' -b 'feat\/login' 'v2'/);
  assert.match(script, /\[ -d '\/work\/app\/default\/\.git' \] \|\|/, "clone is guarded (idempotent re-run)");
  // The clone SOURCE is the RO volume the orchestrator's uid wrote — git's dubious-ownership
  // guard refuses it without this (safe.directory is honored from global config only, never -c).
  assert.match(script, /^git config --global safe\.directory '\*'/, "trusts the pod's j2-owned paths first");
});

test("attachScript with a reviewSha adds the detached review worktree beside every branch worktree", () => {
  // ADR-0028: the reviewer's seat — `<branchDir>-review`, DETACHED at the sha under review, so a
  // rogue write cannot move the branch and a rogue commit evaporates with the checkout.
  const { script, review } = attachScript(
    {
      repos: [
        { name: "app", baseRef: "main" },
        { name: "infra", baseRef: "v2" },
      ],
      branch: "feat/login",
      reviewSha: "abc123",
    },
    { reposMount: "/repos", workRoot: "/work" },
  );
  assert.deepEqual(review, { app: "/work/app/feat-login-review", infra: "/work/infra/feat-login-review" });
  assert.match(script, /worktree add --detach '\/work\/app\/feat-login-review' 'abc123'/);
  assert.match(script, /worktree add --detach '\/work\/infra\/feat-login-review' 'abc123'/);
  assert.match(
    script,
    /\[ -d '\/work\/app\/feat-login-review' \] \|\| git -C '\/work\/app\/default' worktree add --detach/,
    "the add is guarded (idempotent re-run)",
  );
  // Forced checkout AND clean on EVERY attach: a previous round's rogue edits (tracked) and
  // leftovers (untracked) must not survive into this round's review worktree.
  assert.match(script, /git -C '\/work\/app\/feat-login-review' checkout --detach -f 'abc123'/);
  assert.match(script, /git -C '\/work\/app\/feat-login-review' clean -fd/);
});

test("attachScript without a reviewSha emits no review worktree", () => {
  const { script, review } = attachScript(
    { repos: [{ name: "app", baseRef: "main" }], branch: "b" },
    { reposMount: "/repos", workRoot: "/work" },
  );
  assert.equal(review, undefined);
  assert.doesNotMatch(script, /--detach/);
  assert.doesNotMatch(script, /-review/);
});

test("attachScript quotes hostile refs and rejects an empty repo list", () => {
  const { script } = attachScript(
    { repos: [{ name: "app", baseRef: "main; rm -rf /" }], branch: "b" },
    { reposMount: "/repos", workRoot: "/work" },
  );
  assert.match(script, /-b 'b' 'main; rm -rf \/'/, "ref rides inside single quotes, never bare");
  const reviewed = attachScript(
    { repos: [{ name: "app", baseRef: "main" }], branch: "b", reviewSha: "$(reboot)" },
    { reposMount: "/repos", workRoot: "/work" },
  );
  assert.match(reviewed.script, /worktree add --detach '\/work\/app\/b-review' '\$\(reboot\)'/, "the sha too");
  assert.throws(
    () => attachScript({ repos: [], branch: "b" }, { reposMount: "/repos", workRoot: "/work" }),
    /no repos/,
  );
});
