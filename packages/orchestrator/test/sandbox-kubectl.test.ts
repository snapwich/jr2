// kubectlSandbox — the CR/exec MAPPING, against a fake process seam (the cluster itself is the
// kind e2e tier's job). What matters here: the CR carries the run labels + RO repos mount, Ready
// gates provisioning (returning the CR's own svc-DNS endpoint), the attach script is the
// idempotent ADR-0004 sequence, and — since ADR-0037/0038/0049 — `spec.image` is RESOLVED from the
// mounted image map on every provision rather than pinned at construction, by the CONTENT DIGEST of
// the `file:` context the `workspace()` named.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { imageContextDigest } from "../src/images.ts";
import { attachScript, kubectlSandbox, rootImageFault } from "../src/sandbox-kubectl.ts";
import type { KubectlExec } from "../src/sandbox-kubectl.ts";

type Call = { args: string[]; input?: string };

/** Script kubectl by verb: each handler sees the full argv and returns stdout (or throws). */
function fakeExec(handlers: Record<string, (call: Call) => string>) {
  const calls: Call[] = [];
  const exec: KubectlExec = async (args, opts) => {
    const call = { args, input: opts?.input };
    calls.push(call);
    // A `get` is not one question any more: the provision loop reads the POD as well as the CR,
    // for a fault the Sandbox's phase cannot express. An unregistered pod read answers NotFound —
    // the shape every provision has for its first moment, and what every test not about the fault
    // wants, since the port must read "absent" as "too early", never as "healthy".
    const key = args[0] === "get" && args[1] === "pod" ? "get pod" : args[0]!;
    const handler = handlers[key];
    if (!handler) {
      if (key === "get pod") throw new Error(`pods "${args[2]}" not found`);
      throw new Error(`unexpected kubectl ${args[0]}`);
    }
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

/** A docker context on disk and the map key it hashes to. Since ADR-0049 an image is a `file:` URL
 * and the map is keyed by content digest, so a fixture image has to be a real directory — which is
 * the point: the port computes the key the same way `j2 up` did, with no path table between them. */
async function mkContext(from: string): Promise<{ url: string; key: string }> {
  const dir = await mkdtemp(join(tmpdir(), "j2-ctx-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Dockerfile"), `FROM ${from}\n`);
  return { url: pathToFileURL(dir).href, key: await imageContextDigest(dir) };
}

const RUST = await mkContext("rust:1");
const BARE = await mkContext("node:24-slim");
const DEV = await mkContext("debian:12");
const GOLANG = await mkContext("golang:1.23");

const REFS = {
  harness: "j2-harness:h00",
  adapter: "j2-adapter:a00",
  sandbox: { default: "j2-sandbox-inst-default:d00", [RUST.key]: "j2-sandbox-inst-rust:r00" },
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
  assert.equal(applied.spec.image, "j2-sandbox-inst-default:d00");
  // The repos volume is RO; the worktree root is a writable POD volume. Proven necessary on kind:
  // every j2-owned seat runs as an unprivileged uid, so a work dir owned by the image (or absent)
  // makes every `attach` fail with "mkdir /work: permission denied" — and `/work` is what all
  // three containers share (ADR-0005), so a human's `kubectl exec` sees the Agent's own files.
  assert.deepEqual(applied.spec.volumeMounts, [
    { name: "repos", mountPath: "/repos", readOnly: true },
    { name: "work", mountPath: "/work" },
    // j2's runtime, read-only in the container where the Agent has code execution.
    { name: "runtime", mountPath: "/opt/j2", readOnly: true },
  ]);
  assert.deepEqual(applied.spec.volumes, [
    // The in-cluster source volume (ADR-0004/0019): the PVC the boot reconcile writes — no
    // hostPath, nothing kind-special.
    { name: "repos", persistentVolumeClaim: { claimName: "j2-repos", readOnly: true } },
    { name: "work", emptyDir: {} },
    { name: "runtime", emptyDir: {} },
  ]);
});

test("the Harness arrives at POD time: an /opt/j2 volume, an init copy, and a command override", async () => {
  // ADR-0037's whole mechanism, in one CR. There is NO build-time wrap: the primary container runs
  // the user's image byte-for-byte, and everything j2 needs from it arrives beside it.
  const { exec, calls } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  const port = kubectlSandbox({ imagesPath: await mkImages(REFS), ...provisionable, exec });
  await port.provision({ name: "sb-inj", runId: "r", workflow: "w", image: RUST.url });

  const applied = crOf(calls);
  // The one thing j2 takes from the image. A container has one command and it must be the
  // Harness's, or the operator's Ready probe and restart semantics are lies.
  assert.deepEqual(applied.spec.command, ["/opt/j2/bin/node", "/opt/j2/src/main.ts"]);

  const [runtime, preflight] = applied.spec.initContainers;
  // Populate first, prove second — the preflight mounts what the copy wrote.
  assert.equal(runtime.name, "runtime");
  assert.equal(runtime.image, "j2-harness:h00", "the runtime rides the KIT's image, not the user's");
  assert.deepEqual(runtime.command, ["/opt/j2/bin/init-copy", "/mnt/j2"]);
  assert.deepEqual(
    runtime.volumeMounts,
    [{ name: "runtime", mountPath: "/mnt/j2" }],
    "never /opt/j2: it is the source",
  );

  // The probe runs in the USER'S image — that is what proves a registry ref, whose first
  // appearance is this provision, before the Harness container starts rather than mid-turn.
  assert.equal(preflight.name, "preflight");
  assert.equal(preflight.image, "j2-sandbox-inst-rust:r00");
  assert.deepEqual(preflight.volumeMounts, [{ name: "runtime", mountPath: "/opt/j2", readOnly: true }]);
  const script = preflight.command.at(-1);
  assert.match(script, /git config --global safe\.directory "\*"/, "git on PATH and a writable HOME");
  assert.match(script, /\/opt\/j2\/bin\/node -e ""/, "the glibc floor — where musl dies");
  assert.match(script, /\brg --version/, "UNQUALIFIED: it proves rg resolves through PATH");
  assert.match(script, /export PATH="\$PATH:\/opt\/j2\/bin"/, "APPENDED, never prepended");
  assert.match(script, /ADR-0037/, "the failure names the fix, not `node did not execute`");

  // Both j2-owned init steps carry the hardened context themselves: the operator schedules init
  // containers verbatim (ADR-0001), so nothing else would supply one.
  for (const c of applied.spec.initContainers) {
    assert.equal(c.securityContext.runAsNonRoot, true, `${c.name} runs non-root`);
    assert.deepEqual(c.securityContext.capabilities, { drop: ["ALL"] });
  }
});

test("a registry ref is deployed-never-built: it passes through verbatim, in either seat", async () => {
  // ADR-0037's second origin. j2 never built it, so j2 has no ref to look up — and never labels,
  // sweeps, or preflights it at converge. Its pull is the cluster's own.
  const { exec, calls } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  const port = kubectlSandbox({ imagesPath: await mkImages(REFS), ...provisionable, exec });
  await port.provision({
    name: "sb-ref",
    runId: "r",
    workflow: "w",
    image: "ghcr.io/acme/toolchain:2024-11",
    user: "ghcr.io/acme/sshd:1",
  });

  const applied = crOf(calls);
  assert.equal(applied.spec.image, "ghcr.io/acme/toolchain:2024-11");
  // The preflight still runs against it — that is the whole point: a ref's first appearance is a
  // provision, so this is the only moment the floor can be proven at all.
  assert.equal(applied.spec.initContainers[1].image, "ghcr.io/acme/toolchain:2024-11");
  assert.equal(applied.spec.sidecars[1].image, "ghcr.io/acme/sshd:1");
});

test("the User Container is the zero-contract seat: own entrypoint, /work, and NOTHING else", async () => {
  const { exec, calls } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  const port = kubectlSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    exec,
    caBundle: true,
    env: [{ name: "MODEL", value: "x" }],
    envFrom: [{ secretRef: { name: "anthropic" } }],
  });
  await port.provision({ name: "sb-user", runId: "r", workflow: "w", user: RUST.url });

  const applied = crOf(calls);
  const user = applied.spec.sidecars.find((s: { name: string }) => s.name === "user");
  // Everything j2 could have forwarded and deliberately did not (ADR-0005): every key would be a
  // crack in "j2 puts nothing in it". No command, so the image's own entrypoint runs untouched.
  assert.deepEqual(user, {
    name: "user",
    image: "j2-sandbox-inst-rust:r00",
    // Both halves of the one exception: the worktrees, and the RO source their `--shared` clones
    // resolve objects from (ADR-0004) — /work without /repos is a checkout with every borrowed
    // object missing. No env: safe.directory stays the image's own line (ADR-0005).
    volumeMounts: [
      { name: "work", mountPath: "/work" },
      { name: "repos", mountPath: "/repos", readOnly: true },
    ],
  });
  // And no securityContext, which is how the operator reads the exemption: root is allowed here.
  assert.ok(!("securityContext" in user), "the seat j2 does not own is not hardened by j2");

  // Absent → two containers, exactly as before the seat existed.
  const { exec: e2, calls: c2 } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  await kubectlSandbox({ imagesPath: await mkImages(REFS), ...provisionable, exec: e2 }).provision({
    name: "sb-nouser",
    runId: "r",
    workflow: "w",
  });
  assert.deepEqual(
    crOf(c2).spec.sidecars.map((s: { name: string }) => s.name),
    ["adapter"],
    "no default User Container — the seat's identity is what j2 does not own",
  );
});

test("an image that declares no USER gets ADR-0037's fallback seat, in BOTH places it runs", async () => {
  // The recorded `""` is what the converge's `docker inspect` saw (images.ts) — a fact a provision
  // cannot ask for itself. j2 supplies a uid ONLY here: everywhere else the image's own USER
  // decides its seat (ADR-0005), and this is the one case where the image chose nothing and the
  // alternative is root, which the hardened context refuses.
  const bare = {
    ...REFS,
    sandbox: { ...REFS.sandbox, [BARE.key]: "j2-sandbox-inst-bare:b00" },
    sandboxUser: { [BARE.key]: "" },
  };
  const { exec, calls } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  await kubectlSandbox({ imagesPath: await mkImages(bare), ...provisionable, exec }).provision({
    name: "sb-bare",
    runId: "r",
    workflow: "w",
    image: BARE.url,
  });

  const applied = crOf(calls);
  assert.equal(applied.spec.securityContext.runAsUser, 1000);
  assert.equal(applied.spec.securityContext.runAsNonRoot, true, "the fallback is a uid, not a loosening");
  // A writable HOME is part of ADR-0037's floor, and uid 1000 on a stranger's base has no home at
  // all — so j2 supplies one as a pod volume rather than expecting a layer for it.
  assert.deepEqual(applied.spec.env[0], { name: "HOME", value: "/home/j2" });
  assert.ok(applied.spec.volumes.some((v: { name: string }) => v.name === "home"));
  assert.deepEqual(applied.spec.volumeMounts.at(-1), { name: "home", mountPath: "/home/j2" });

  // The probe runs in the SAME seat, or it proved a different uid's $HOME and proved nothing.
  const preflight = applied.spec.initContainers[1];
  assert.equal(preflight.securityContext.runAsUser, 1000);
  assert.deepEqual(preflight.env, [{ name: "HOME", value: "/home/j2" }]);
  assert.deepEqual(preflight.volumeMounts.at(-1), { name: "home", mountPath: "/home/j2" });

  // And an image that DID declare one keeps its own environment, dotfiles included: no uid, no
  // HOME, no home volume anywhere in the CR.
  const { exec: e2, calls: c2 } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  await kubectlSandbox({ imagesPath: await mkImages(REFS), ...provisionable, exec: e2 }).provision({
    name: "sb-own",
    runId: "r",
    workflow: "w",
    image: RUST.url,
  });
  const own = crOf(c2);
  assert.equal(own.spec.securityContext.runAsUser, undefined, "j2 sets runAsUser nowhere else");
  assert.ok(!own.spec.env.some((e: { name: string }) => e.name === "HOME"));
  assert.ok(!own.spec.volumes.some((v: { name: string }) => v.name === "home"));
});

test("the pod carries the work group: fsGroup = spec.workGroup ?? 2000", async () => {
  // ADR-0005's ownership half of cross-uid sharing on `/work` (the attach's default ACL is the
  // writability half). The override exists for the image whose sessions already hold a gid of
  // their own — pointing the work group at it costs no rebuild.
  const fsGroupFor = async (workGroup?: number): Promise<number> => {
    const { exec, calls } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
    const port = kubectlSandbox({ imagesPath: await mkImages(REFS), ...provisionable, exec });
    await port.provision({ name: "sb", runId: "r", workflow: "w", ...(workGroup !== undefined ? { workGroup } : {}) });
    return crOf(calls).spec.fsGroup;
  };

  assert.equal(await fsGroupFor(), 2000, "the default is convention, never a config key");
  assert.equal(await fsGroupFor(4000), 4000);
});

test("the Sandbox Image chain: the wrapper's context → images/default → the stock Harness", async () => {
  const provisionWith = async (refs: unknown, image?: string): Promise<string> => {
    const { exec, calls } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
    const port = kubectlSandbox({ imagesPath: await mkImages(refs), ...provisionable, exec });
    await port.provision({ name: "sb", runId: "r", workflow: "w", ...(image ? { image } : {}) });
    return crOf(calls).spec.image;
  };

  assert.equal(await provisionWith(REFS, RUST.url), "j2-sandbox-inst-rust:r00", "the wrapper's context wins");
  assert.equal(await provisionWith(REFS), "j2-sandbox-inst-default:d00", "no image → images/default");
  // The last leg comes out of the MAP, not a `j2-harness:<kitversion>` literal: in a kit checkout
  // the Harness is a content-addressed tag (ADR-0038) and a literal would name nothing built.
  assert.equal(
    await provisionWith({ harness: "j2-harness:h00", adapter: "j2-adapter:a00", sandbox: {} }),
    "j2-harness:h00",
    "no images/default → the stock Harness",
  );
});

test("a context this converge did not build fails the provision with NOTHING applied", async () => {
  // The stale-deployment case (ADR-0049): the Orchestrator's bundle holds a context whose digest is
  // in no map, because the last `j2 up` predates the Machine edit that named it.
  const { exec, calls } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  const port = kubectlSandbox({ imagesPath: await mkImages(REFS), ...provisionable, exec });

  await assert.rejects(
    () => port.provision({ name: "sb", runId: "r", workflow: "w", image: GOLANG.url }),
    (err: Error) => {
      assert.match(err.message, /no Sandbox Image for file:/);
      assert.match(err.message, /j2 up/, "the error names the fix");
      return true;
    },
  );
  // Read-first is what buys this: no token Secret, no CR, nothing for anyone to clean up.
  assert.deepEqual(calls, []);
});

test("a recorded USER the kubelet would refuse fails the provision by NAME, not by timeout", async () => {
  // The failure this replaces is the worst-shaped one j2 has: `runAsNonRoot` with no `runAsUser`
  // makes the kubelet resolve the image's USER itself, a non-numeric or root one is
  // CreateContainerConfigError on the `preflight` init container, and a container that never
  // starts has no logs — so the timeout hint dead-ends and 120s burn before anything is said. The
  // converge already recorded the string, so the read-first provision can say it up front.
  const { exec, calls } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  const named = {
    ...REFS,
    sandbox: { ...REFS.sandbox, [DEV.key]: "j2-sandbox-inst-dev:v00" },
    sandboxUser: { [DEV.key]: "dev" },
  };
  const port = kubectlSandbox({ imagesPath: await mkImages(named), ...provisionable, exec });

  await assert.rejects(
    () => port.provision({ name: "sb", runId: "r", workflow: "w", image: DEV.url }),
    (err: Error) => {
      assert.match(err.message, /`USER dev`/);
      assert.match(err.message, /USER 1000/, "the message names the one-line fix in the caller's Dockerfile");
      return true;
    },
  );
  assert.deepEqual(calls, [], "nothing applied: no token Secret, no CR, nothing to clean up");

  // Root is the same refusal for the other reason, and `uid:gid` is judged on the uid half only.
  const rooted = kubectlSandbox({
    imagesPath: await mkImages({ ...named, sandboxUser: { [DEV.key]: "0" } }),
    ...provisionable,
    exec,
  });
  await assert.rejects(() => rooted.provision({ name: "sb", runId: "r", workflow: "w", image: DEV.url }), /`USER 0`/);

  const paired = kubectlSandbox({
    imagesPath: await mkImages({ ...named, sandboxUser: { [DEV.key]: "1000:2000" } }),
    ...provisionable,
    exec,
  });
  await paired.provision({ name: "sb", runId: "r", workflow: "w", image: DEV.url });
});

/** A pod whose named container sits in `waiting`, as `kubectl get pod -o json` prints it. */
const waitingPod = (container: string, reason: string, message: string, seat = "initContainerStatuses") =>
  JSON.stringify({
    status: {
      [seat]: [
        { name: "runtime", state: { terminated: { exitCode: 0 } } },
        { name: container, state: { waiting: { reason, message } } },
      ],
    },
  });

/** The kubelet's actual wording for the fault, which is the only evidence this case ever leaves. */
const RUNS_AS_ROOT = "container has runAsNonRoot and image will run as root";

test("a BROUGHT ref that runs as root fails the provision by name, not as the preflight's timeout", async () => {
  // The one seat-fault a converge cannot see coming (ADR-0037): a registry ref is never built and
  // never inspected, so nothing recorded its `USER` and `resolveSandboxImage` reports no
  // `refusedUser` to judge it by. The
  // kubelet refuses it against the hardened seat, the `preflight` init container never STARTS, and
  // a container that never started has no logs — so the pod is the only witness, and without this
  // read the 120s timeout blames a probe that never ran.
  const { exec } = fakeExec({
    apply: () => "ok",
    patch: () => "ok",
    get: () => JSON.stringify({ status: { phase: "Pending" } }),
    "get pod": () => waitingPod("preflight", "CreateContainerConfigError", RUNS_AS_ROOT),
  });
  const port = kubectlSandbox({ imagesPath: await mkImages(REFS), ...provisionable, exec });

  await assert.rejects(
    () => port.provision({ name: "sb-root", runId: "r", workflow: "w", image: "ghcr.io/acme/toolchain:2024-11" }),
    (err: Error) => {
      assert.match(err.message, /runs as ROOT/);
      assert.match(err.message, /`USER <uid>`/, "the fix is a line in the image, not a j2 setting");
      assert.match(err.message, /USER 1000/);
      assert.match(err.message, /numeric/, "…and numeric, because the kubelet cannot resolve a name");
      assert.match(err.message, /brought registry ref/, "…and it says WHY j2 supplied no uid itself");
      assert.match(err.message, /preflight/, "the container the kubelet named is quoted back");
      assert.ok(!/never reached Ready/.test(err.message), "it replaces the timeout, it does not follow it");
      return true;
    },
  );
});

test("only THAT waiting shape is the root fault; every other pod passes through", async () => {
  // CreateContainerConfigError is also what an absent Secret key produces, and that has a different
  // fix — so the reason alone must not be enough. A name with no evidence behind it is worse than
  // the timeout it replaces, because it sends the reader to edit the wrong file.
  assert.equal(
    rootImageFault(JSON.parse(waitingPod("harness", "CreateContainerConfigError", `secret "j2-sb" not found`))),
    undefined,
  );
  assert.equal(rootImageFault(JSON.parse(waitingPod("preflight", "PodInitializing", RUNS_AS_ROOT))), undefined);
  assert.equal(
    rootImageFault(JSON.parse(waitingPod("preflight", "ImagePullBackOff", "pull access denied"))),
    undefined,
  );
  assert.equal(rootImageFault({ status: {} }), undefined, "a pod with no statuses yet is not a fault");
  assert.equal(rootImageFault({}), undefined);
  assert.equal(rootImageFault(null), undefined, "…nor is an unreadable answer");

  // The primary containers are read too: the same image sits in the `harness` seat, which is
  // hardened identically, so the fault can surface there when the preflight is not what ran first.
  assert.match(
    rootImageFault(JSON.parse(waitingPod("harness", "CreateContainerConfigError", RUNS_AS_ROOT, "containerStatuses")))!,
    /container "harness"/,
  );

  // And end to end: a pod that is merely slow still reaches Ready, with the pod read costing it
  // nothing but a look.
  let gets = 0;
  const { exec } = fakeExec({
    apply: () => "ok",
    patch: () => "ok",
    get: () => (++gets < 3 ? JSON.stringify({ status: { phase: "Pending" } }) : readyStatus),
    "get pod": () => waitingPod("preflight", "PodInitializing", "waiting to start"),
  });
  const port = kubectlSandbox({ imagesPath: await mkImages(REFS), ...provisionable, exec });
  const { endpoint } = await port.provision({ name: "sb-slow", runId: "r", workflow: "w" });
  assert.equal(endpoint, "http://sb-1.default.svc:8080");
});

test("the map is re-read PER provision, so a converge reaches the next Sandbox without a roll", async () => {
  // The whole reason the refs arrive as a mounted ConfigMap rather than Deployment env (ADR-0038):
  // a rebuilt image must reach FUTURE Sandboxes without bouncing every live run through restore.
  const imagesPath = await mkImages(REFS);
  const { exec, calls } = fakeExec({ apply: () => "ok", patch: () => "ok", get: () => readyStatus });
  const port = kubectlSandbox({ imagesPath, ...provisionable, exec });

  await port.provision({ name: "sb-a", runId: "r", workflow: "w" });
  await writeFile(imagesPath, JSON.stringify({ ...REFS, sandbox: { default: "j2-sandbox-inst-default:d99" } }));
  await port.provision({ name: "sb-b", runId: "r", workflow: "w" });

  const images = calls
    .filter((c) => c.args[0] === "apply" && c.input!.includes('"kind":"Sandbox"'))
    .map((c) => (JSON.parse(c.input!) as { spec: { image: string } }).spec.image);
  assert.deepEqual(images, ["j2-sandbox-inst-default:d00", "j2-sandbox-inst-default:d99"]);
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
  // With the ref in the map there is no "no adapter configured" state left to branch on, and no
  // User Container was named — so this list is exactly the Adapter.
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
  // Still `harness`, and still right after ADR-0037: the primary container IS the Sandbox Image,
  // run unmodified with j2's runtime beside it on a volume — so the agent's own worktrees, tools,
  // and `$HOME` are what this attach touches.
  assert.ok(argv.includes("harness"), "targets the harness container");
  const script = argv[argv.length - 1]!;
  assert.match(script, /git clone --shared --no-checkout '\/repos\/app\/default' '\/work\/app\/default'/);
  assert.match(script, /worktree add '\/work\/infra\/feat-login' -b 'feat\/login' 'v2'/);
  // The fetch/push split (ADR-0005): push goes to the REAL remote, read off the volume checkout's
  // own origin url — guarded, so an adopted checkout without one keeps volume-push.
  assert.match(script, /config remote\.origin\.url \|\| true/);
  assert.match(script, /git -C '\/work\/app\/default' remote set-url --push origin "\$url"/);
  // No baseRef → the repo's OWN default branch, via the clone's origin/HEAD — never a hardcoded
  // guess like `main` against a `master` repo.
  const defaulted = await port.attach({
    name: "sb-3",
    spec: { repos: [{ name: "app" }], branch: "feat/login" },
  });
  assert.equal(defaulted.workdir, "/work/app/feat-login");
  const defaultedScript = calls[calls.length - 1]!.args.at(-1)!;
  assert.match(defaultedScript, /worktree add '\/work\/app\/feat-login' -b 'feat\/login' 'origin\/HEAD'/);
  assert.match(script, /\[ -d '\/work\/app\/default\/\.git' \] \|\|/, "clone is guarded (idempotent re-run)");
  // The attach execs in — it is NOT a child of the Harness process — so it must set the work
  // group's umask itself or every dir it creates is 755 and the User Container seat can never
  // CREATE a file in the worktree (ADR-0005's cross-uid write promise).
  assert.match(script, /^umask 002\n/, "the exec'd attach carries its own umask");
  // The clone SOURCE is the RO volume the orchestrator's uid wrote — git's dubious-ownership
  // guard refuses it without this (safe.directory is honored from global config only, never -c).
  assert.match(script, /^umask 002\ngit config --global safe\.directory '\*'/, "trusts the pod's j2-owned paths first");
  // ADR-0005's default ACL: stamped on the repo root AFTER the mkdir that makes it and BEFORE the
  // clone that fills it — inheritance happens at creation, never retroactively. This ordering is
  // the whole cross-uid promise ("zero umask lines in any image"), so it is pinned per repo.
  assert.match(script, /mkdir -p '\/work\/app'\n\/opt\/j2\/bin\/work-acl '\/work\/app'\n\[ -d '\/work\/app\/default/);
  assert.match(script, /mkdir -p '\/work\/infra'\n\/opt\/j2\/bin\/work-acl '\/work\/infra'\n/);
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

test("attach refuses a repo whose sync has not succeeded, naming it and git's own error (ADR-0048)", async () => {
  // The moment the degradation bites: the attach clones `/repos/<name>/default`, so a repo the
  // reconcile could not sync is a checkout that is absent or stale. The run that needs it is the
  // one that hears about it — not the boot, which serves everything else correctly.
  const { exec, calls } = fakeExec({ exec: () => "" });
  const port = kubectlSandbox({
    exec,
    repoError: (name) => (name === "app" ? "git clone failed: Permission denied (publickey)." : undefined),
  });

  await assert.rejects(
    () =>
      port.attach({
        name: "sb-4",
        spec: {
          repos: [
            { name: "app", baseRef: "main" },
            { name: "infra", baseRef: "main" },
          ],
          branch: "feat/login",
        },
      }),
    (err: Error) => {
      assert.match(err.message, /repo "app"/, "names the repo");
      assert.match(err.message, /Permission denied \(publickey\)\./, "carries git's own error");
      assert.match(err.message, /j2 status/, "points at where every unsynced repo is listed");
      assert.ok(!err.message.includes('repo "infra"'), "the synced repo is not implicated");
      return true;
    },
  );
  assert.equal(calls.length, 0, "nothing is exec'd into the pod on a repo that cannot be there");
});

test("attach proceeds when every spec repo has synced — and when no reconcile is wired at all", async () => {
  const spec = { repos: [{ name: "app", baseRef: "main" }], branch: "feat/login" };
  const synced = fakeExec({ exec: () => "" });
  await kubectlSandbox({ exec: synced.exec, repoError: () => undefined }).attach({ name: "sb-5", spec });
  assert.equal(synced.calls.length, 1);

  // "Nothing known" asserts nothing: a port built without the seam attaches exactly as before.
  const bare = fakeExec({ exec: () => "" });
  await kubectlSandbox({ exec: bare.exec }).attach({ name: "sb-6", spec });
  assert.equal(bare.calls.length, 1);
});

test("attach waits for a late answer: a run that starts mid-clone does not race the reconcile", async () => {
  // The boot no longer waits for the first reconcile pass (ADR-0048), so the wait moved to the one
  // caller that needs it. Racing it instead would clone from a `default/` that does not exist yet.
  const { exec, calls } = fakeExec({ exec: () => "" });
  let synced!: () => void;
  const firstPass = new Promise<void>((resolve) => (synced = resolve));
  const port = kubectlSandbox({
    exec,
    repoError: async () => {
      await firstPass;
      return undefined;
    },
  });

  const attaching = port.attach({ name: "sb-7", spec: { repos: [{ name: "app", baseRef: "main" }], branch: "b" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0, "nothing is exec'd into the pod while the checkout is still being made");
  synced();
  await attaching;
  assert.equal(calls.length, 1, "…and the attach proceeds the moment the repo is there");
});
