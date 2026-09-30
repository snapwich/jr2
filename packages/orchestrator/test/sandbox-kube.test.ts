// kubeSandbox — the CR MAPPING and the waits, against the fake API server (_fake-kube.ts) with
// the operator played by the test (the cluster itself is the kind e2e tier's job). What matters
// here: the CR carries the run labels and names its Repos by cache key (ADR-0051), Ready gates
// provisioning on WATCH EVENTS (ADR-0063) and returns the CR's own svc-DNS endpoint, the attach is
// the Harness's `POST /attach` with the Harness bearer (ADR-0058, ADR-0063), every Repo's resource
// is ensured before the CR names it and the operator's Ready verdict on it is read (a clone that
// failed fails the provision by name; a fetch that failed makes the attach stale), the credentials
// fence refuses a per-run url no entry admits before anything is applied, the lease is a merge
// patch and Continuity is the watch's (ADR-0021), a memory kill is named from the operator's
// status (ADR-0061), and — since ADR-0037/0038/0049 — `spec.image` is RESOLVED from the mounted
// image map on every provision rather than pinned at construction, by the CONTENT DIGEST of the
// `file:` context the `workspace()` named.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EMPTY_HELD, leafStem, standIn, type HeldManifest } from "../src/held-secrets.ts";
import { imageContextDigest } from "../src/images.ts";
import { kubeClient } from "../src/kube-client.ts";
import { repoKey } from "../src/repo-identity.ts";
import { kubeSandbox as kubePort, memoryFaultOf, type KubeSandboxOptions } from "../src/sandbox-kube.ts";
import { watchSandboxes } from "../src/sandbox-watch.ts";
import { harnessToken, harnessTokenDigest } from "../src/tokens.ts";
import type { RepoResources } from "../src/repos.ts";
import type { AttachRequest } from "../src/wire.ts";
import type { Continuity, PlaceRequest, PlacingWait, ProvisionedRepo } from "../src/workspace.ts";
import { fakeKube, type FakeCall } from "./_fake-kube.ts";
import { waitFor } from "./_fixtures.ts";

/** The operator's word that the pod has a node (ADR-0063, ADR-0064). */
const SCHEDULED = { type: "Scheduled", status: "True", reason: "Scheduled" };
/** The status the operator publishes once a Sandbox is serving. */
const READY = { phase: "Ready", endpoint: "http://sb-1.default.svc:8080", podUID: "pod-uid-1" };
/** A pod with a node that is not serving yet — what the Ready budget measures. */
const PENDING = { phase: "Pending" };

/**
 * The port, with `provision` taking the whole request and running the two waits in sequence, as a
 * Workspace does — `placing`, then `provisioning` (ADR-0064) — so a test about what the CR carries
 * or how Ready is judged reads as one call. The tests of the waits themselves use `kubePort`.
 */
function kubeSandbox(opts: KubeSandboxOptions = {}) {
  const port = kubePort(opts);
  return {
    ...port,
    async provision(req: PlaceRequest) {
      await port.place(req, { onWait: () => {} });
      return port.provision(req.name);
    },
  };
}

const stops: Array<() => void> = [];
after(() => stops.forEach((stop) => stop()));

/**
 * A scripted status the way the operator writes it for a pod that has a node: a script that says
 * nothing about scheduling is about what comes AFTER it (the Ready wait, ADR-0064), so it gets
 * `Scheduled=True` — the placing tests script their own `Scheduled`.
 */
function placed(status: object): object {
  const conditions = (status as { conditions?: Array<{ type: string }> }).conditions ?? [];
  if (conditions.some((c) => c.type === "Scheduled")) return status;
  return { ...status, conditions: [...conditions, SCHEDULED] };
}

/**
 * The fake API server with the operator played: every Sandbox APPLIED is answered by each status
 * in `script`, one watch event apiece, in order — `[READY]` unless a test says otherwise, `[]` for
 * an operator that never answers. `exec` is what the port is wired with (the client, the watch,
 * and a fake Harness for the attach); `calls` is every write the port made.
 */
function cluster(script: object[] = [READY], harness?: (req: AttachRequest, auth: string | null) => Response) {
  const api = fakeKube();
  const client = kubeClient({ baseUrl: "https://kube.test", fetch: api.fetch, token: async () => api.token });
  const watch = watchSandboxes(client, { namespace: "default", backoffMs: 5 });
  stops.push(() => watch.stop());
  api.onWrite((plural, obj, call) => {
    if (plural !== "sandboxes" || call.contentType !== "application/apply-patch+yaml") return;
    const name = obj.metadata.name;
    void (async () => {
      for (const status of script) {
        await new Promise((r) => setTimeout(r, 1));
        api.setStatus("sandboxes", name, placed(status));
      }
    })();
  });
  const attaches: Array<{ url: string; body: AttachRequest; auth: string | null }> = [];
  const harnessFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as AttachRequest;
    const auth = new Headers(init.headers).get("authorization");
    attaches.push({ url: String(input), body, auth });
    if (harness) return harness(body, auth);
    const repos = Object.fromEntries(
      body.slots.map((s) => [s.slot, `/work/${s.slot}/${body.branch.replace(/\//g, "-")}`]),
    );
    return Response.json({ repos });
  }) as typeof fetch;
  return { api, calls: api.writes, attaches, exec: { client, watch, harnessFetch } };
}

/** Every provision writes more than its CR — its token Secret after it (the Custodian is
 * unconditional — ADR-0013; owned from birth — ADR-0001), so "the CR" is the apply of a Sandbox,
 * never simply a write. */
const applies = (calls: FakeCall[], plural: string): any[] =>
  calls
    .filter((c) => c.contentType === "application/apply-patch+yaml" && c.target.startsWith(`${plural}/`))
    .map((c) => c.body);
const crOf = (calls: FakeCall[]): any => applies(calls, "sandboxes")[0];

/** The mounted `jr2-images` map (ADR-0038) as a real file — the port reads it per provision. */
async function mkImages(refs: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-images-"));
  const path = join(dir, "images.json");
  await writeFile(path, JSON.stringify(refs));
  return path;
}

/** A docker context on disk and the map key it hashes to. Since ADR-0049 an image is a `file:` URL
 * and the map is keyed by content digest, so a fixture image has to be a real directory — which is
 * the point: the port computes the key the same way `jr2 up` did, with no path table between them. */
async function mkContext(from: string): Promise<{ url: string; key: string }> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-ctx-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Dockerfile"), `FROM ${from}\n`);
  return { url: pathToFileURL(dir).href, key: await imageContextDigest(dir) };
}

const RUST = await mkContext("rust:1");
const BARE = await mkContext("node:24-slim");
const DEV = await mkContext("debian:12");
const GOLANG = await mkContext("golang:1.23");

const REFS = {
  harness: "jr2-harness:h00",
  custodian: "envoy:c00",
  sandbox: { default: "jr2-sandbox-inst-default:d00", [RUST.key]: "jr2-sandbox-inst-rust:r00" },
};

/** How every seat that holds jr2's runtime mounts it (ADR-0037): the harness image's own
 * `/opt/jr2`, by subPath of the image volume, and read-only — an image volume is read-only anyway,
 * and saying so keeps the mount's meaning in the CR rather than in the volume type. */
const RUNTIME_AT_OPT = { name: "runtime", mountPath: "/opt/jr2", subPath: "opt/jr2", readOnly: true };

/** The Repo-resource port (ADR-0051) as a recorder: what a provision asked it to ensure, in order.
 * `bind` is the boot's statement of a spec and refuses: a provision that restated a bound Repo
 * would flip the resource between two Machines' spellings on every run. */
function fakeRepos() {
  const ensured: Array<{ url: string; identity: string; key: string; bound: boolean }> = [];
  const port: RepoResources = {
    async bind(repo) {
      throw new Error(`a provision must not bind ${repo.key}: only the boot states a Repo's spec`);
    },
    async ensure(repo) {
      ensured.push(repo);
    },
    async reconcileBound() {},
    async list() {
      return [];
    },
  };
  return { port, ensured };
}

/** The mounted `jr2-held` manifest (ADR-0059) as a real file — the port reads it per provision. */
async function mkHeld(manifest: HeldManifest): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-held-"));
  const path = join(dir, "held.json");
  await writeFile(path, JSON.stringify(manifest));
  return path;
}

const NOTHING_HELD = await mkHeld(EMPTY_HELD);

/** Everything a provision needs beyond the images map: the Custodian is always composed, so its
 * token Secret (and therefore a signing key) and its manifest are not optional — and every
 * provision names Repos whose resources it must ensure, so neither is the Repo-resource port. */
const provisionable = {
  signingKey: Buffer.from("k"),
  heldPath: NOTHING_HELD,
  repos: fakeRepos().port,
};

/** One bound slot, as every provision that is not about Repos names it (a workspace() always
 * declares at least one — ADR-0051). */
const APP_URL = "https://example.test/app.git";
const APP_KEY = repoKey(APP_URL);
const app: ProvisionedRepo = { slot: "app", url: APP_URL, perRun: false };
const withApp = { repos: [app] };

/** The CPU hints every Harness container carries (ADR-0060): its own `limits.cpu`, whole cpus. */
const CPU_HINTS = ["JR2_CPUS", "OMP_NUM_THREADS", "PYTHON_CPU_COUNT", "GOMAXPROCS"].map((name) => ({
  name,
  valueFrom: { resourceFieldRef: { resource: "limits.cpu", divisor: "1" } },
}));

test("the Instance's `sandbox` placement rides the CR verbatim; absent, the CR says nothing (ADR-0052)", async () => {
  const placement = {
    nodeSelector: { pool: "agents" },
    tolerations: [{ key: "gpu", operator: "Exists" as const, effect: "NoSchedule" as const }],
  };
  const placed = cluster();
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, placement, ...placed.exec });
  await port.provision({ name: "sb-p", runId: "run-1", workflow: "coding", ...withApp });
  const spec = crOf(placed.calls).spec;
  // Raw pod-spec shapes, copied by the operator onto the pod with nothing merged in — its own soft
  // affinity toward nodes holding the caches is a preference, and never meets these requirements.
  assert.deepEqual(spec.nodeSelector, { pool: "agents" });
  assert.deepEqual(spec.tolerations, [{ key: "gpu", operator: "Exists", effect: "NoSchedule" }]);

  const bare = cluster();
  const unplaced = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...bare.exec });
  await unplaced.provision({ name: "sb-u", runId: "run-2", workflow: "coding", ...withApp });
  assert.ok(!("nodeSelector" in crOf(bare.calls).spec), "no key at all — wherever an ordinary pod lands");
  assert.ok(!("tolerations" in crOf(bare.calls).spec));
});

test("provision applies the labeled CR naming its Repos by cache key, gates on Ready", async () => {
  const { exec, calls, api } = cluster([PENDING, PENDING, READY]);
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });

  const { endpoint } = await port.provision({ name: "sb-1", runId: "run-9", workflow: "coding", ...withApp });
  assert.equal(endpoint, "http://sb-1.default.svc:8080");
  // Waited on WATCH EVENTS (ADR-0063): the Sandbox was never read by name, and no Pod ever was.
  assert.deepEqual(
    api.calls.filter((c) => c.method === "GET" && c.target !== "sandboxes"),
    [],
    "no get, no poll — the watch carried every status",
  );
  // Written the ADR-0063 way: server-side apply as field manager jr2, forced.
  const write = calls.find((c) => c.target === "sandboxes/sb-1")!;
  assert.equal(write.contentType, "application/apply-patch+yaml");
  assert.deepEqual(write.query, { fieldManager: "jr2", force: "true" });

  const applied = crOf(calls);
  assert.equal(applied.metadata.name, "sb-1");
  assert.deepEqual(applied.metadata.labels, { "jr2.dev/run": "run-9", "jr2.dev/workflow": "coding" });
  // No `image` on the request (the wrapper named none) → `images/default` (ADR-0037's middle
  // leg), resolved from the map.
  assert.equal(applied.spec.image, "jr2-sandbox-inst-default:d00");
  // The Repos, by cache key (ADR-0051): the operator mounts each node cache read-only at
  // `/repos/<key>` itself, places the pod, and gates Ready on it — so the CR names them and mounts
  // nothing for them. No PVC anywhere: the cache is the node's, not a volume.
  assert.deepEqual(applied.spec.repos, [{ key: APP_KEY, url: APP_URL }]);
  // The worktree root is a writable POD volume. Proven necessary on kind: every jr2-owned seat runs
  // as an unprivileged uid, so a work dir owned by the image (or absent) makes every `attach` fail
  // with "mkdir /work: permission denied" — and `/work` is what all three containers share
  // (ADR-0005), so a human's `kubectl exec` sees the Agent's own files.
  assert.deepEqual(applied.spec.volumeMounts, [
    { name: "work", mountPath: "/work" },
    // jr2's runtime, read-only in the container where the Agent has code execution.
    RUNTIME_AT_OPT,
  ]);
  // Then the Custodian's own two (ADR-0059): what it holds and how it is told to hold it. With
  // nothing held and no CA bundle, the Harness container mounts neither.
  assert.deepEqual(
    applied.spec.volumes.map((v: { name: string }) => v.name),
    ["work", "runtime", "custodian-values", "custodian-config"],
  );
  assert.deepEqual(applied.spec.volumes.slice(0, 2), [
    { name: "work", emptyDir: {} },
    // The KIT's image, mounted as a volume (ADR-0037): no pull policy of its own, so the kubelet
    // treats the ref exactly as it treats the same ref on a container.
    { name: "runtime", image: { reference: "jr2-harness:h00" } },
  ]);
  assert.ok(!JSON.stringify(applied).includes("persistentVolumeClaim"), "no source PVC — the cache is per node");
});

test("two slots spelling one repository are ONE CR entry; two repositories are two", async () => {
  const { exec, calls } = cluster();
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });
  await port.provision({
    name: "sb-two",
    runId: "r",
    workflow: "w",
    repos: [
      { slot: "app", url: "git@github.com:acme/app.git", perRun: false },
      { slot: "same", url: "https://github.com/acme/app", perRun: false },
      { slot: "docs", url: "https://github.com/acme/handbook.git", perRun: false },
    ],
  });
  assert.deepEqual(crOf(calls).spec.repos, [
    // First spelling wins: one cache, however many slots borrow from it.
    { key: repoKey("https://github.com/acme/app"), url: "git@github.com:acme/app.git" },
    { key: repoKey("https://github.com/acme/handbook.git"), url: "https://github.com/acme/handbook.git" },
  ]);
});

test("the Harness arrives at POD time: an /opt/jr2 image volume and a command override", async () => {
  // ADR-0037's whole mechanism, in one CR. There is NO build-time wrap: the primary container runs
  // the user's image byte-for-byte, and everything jr2 needs from it arrives beside it.
  const { exec, calls } = cluster();
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });
  await port.provision({ name: "sb-inj", runId: "r", workflow: "w", image: RUST.url, ...withApp });

  const applied = crOf(calls);
  // The one thing jr2 takes from the image. A container has one command and it must be the
  // Harness's, or the operator's Ready probe and restart semantics are lies.
  // `tini` is PID 1 (ADR-0061): a tree the memory guard kills leaves no zombies.
  assert.deepEqual(applied.spec.command, ["/opt/jr2/bin/tini", "--", "/opt/jr2/bin/node", "/opt/jr2/src/main.ts"]);

  // The runtime rides the KIT's image, mounted — nothing copies it, so no init step populates it.
  const runtime = applied.spec.volumes.find((v: { name: string }) => v.name === "runtime");
  assert.deepEqual(runtime, { name: "runtime", image: { reference: "jr2-harness:h00" } });
  assert.deepEqual(
    applied.spec.initContainers.map((c: { name: string }) => c.name),
    ["preflight"],
    "one init step: the probe",
  );
  const [preflight] = applied.spec.initContainers;

  // The probe runs in the USER'S image — that is what proves a registry ref, whose first
  // appearance is this provision, before the Harness container starts rather than mid-turn.
  assert.equal(preflight.name, "preflight");
  assert.equal(preflight.image, "jr2-sandbox-inst-rust:r00");
  assert.deepEqual(preflight.volumeMounts, [RUNTIME_AT_OPT]);
  const script = preflight.command.at(-1);
  assert.match(script, /git config --global safe\.directory "\*"/, "git on PATH and a writable HOME");
  assert.match(script, /\/opt\/jr2\/bin\/node -e ""/, "the glibc floor — where musl dies");
  assert.match(script, /\brg --version/, "UNQUALIFIED: it proves rg resolves through PATH");
  assert.match(script, /export PATH="\$PATH:\/opt\/jr2\/bin"/, "APPENDED, never prepended");
  assert.match(script, /ADR-0037/, "the failure names the fix, not `node did not execute`");

  // The jr2-owned init step carries the hardened context itself: the operator schedules init
  // containers verbatim (ADR-0001), so nothing else would supply one.
  for (const c of applied.spec.initContainers) {
    assert.equal(c.securityContext.runAsNonRoot, true, `${c.name} runs non-root`);
    assert.deepEqual(c.securityContext.capabilities, { drop: ["ALL"] });
  }
});

test("a registry ref is deployed-never-built: it passes through verbatim, in either seat", async () => {
  // ADR-0037's second origin. jr2 never built it, so jr2 has no ref to look up — and never labels,
  // sweeps, or preflights it at converge. Its pull is the cluster's own.
  const { exec, calls } = cluster();
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });
  await port.provision({
    name: "sb-ref",
    runId: "r",
    workflow: "w",
    image: "ghcr.io/acme/toolchain:2024-11",
    user: "ghcr.io/acme/sshd:1",
    ...withApp,
  });

  const applied = crOf(calls);
  assert.equal(applied.spec.image, "ghcr.io/acme/toolchain:2024-11");
  // The preflight still runs against it — that is the whole point: a ref's first appearance is a
  // provision, so this is the only moment the floor can be proven at all.
  assert.equal(applied.spec.initContainers[0].image, "ghcr.io/acme/toolchain:2024-11");
  assert.equal(applied.spec.sidecars[1].image, "ghcr.io/acme/sshd:1");
});

test("the User Container is the zero-contract seat: own entrypoint, /work, and NOTHING else", async () => {
  const { exec, calls } = cluster();
  const port = kubeSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    ...exec,
    caBundle: true,
    env: [{ name: "MODEL", value: "x" }],
    envFrom: [{ secretRef: { name: "anthropic" } }],
  });
  await port.provision({ name: "sb-user", runId: "r", workflow: "w", user: RUST.url, ...withApp });

  const applied = crOf(calls);
  const user = applied.spec.sidecars.find((s: { name: string }) => s.name === "user");
  // Everything jr2 could have forwarded and deliberately did not (ADR-0005): every key would be a
  // crack in "jr2 puts nothing in it". No command, so the image's own entrypoint runs untouched.
  assert.deepEqual(user, {
    name: "user",
    image: "jr2-sandbox-inst-rust:r00",
    // The one exception and its halves: the worktrees, the RO caches their `--shared` clones
    // resolve objects from (ADR-0004/0051) — /work without /repos/<key> is a checkout with every
    // borrowed object missing — and the runtime volume, because `origin`'s fetch url is a program
    // on it (ADR-0053), so /work without /opt/jr2 is a checkout whose `git fetch` dies. Mounted by
    // the volume NAME the operator defines per key. Still no env: `ext::` names the program by
    // absolute path, and safe.directory stays the image's own line (ADR-0005).
    volumeMounts: [
      { name: "work", mountPath: "/work" },
      RUNTIME_AT_OPT,
      { name: `repo-${APP_KEY}`, mountPath: `/repos/${APP_KEY}`, readOnly: true },
    ],
  });
  // And no securityContext, which is how the operator reads the exemption: root is allowed here.
  assert.ok(!("securityContext" in user), "the seat jr2 does not own is not hardened by jr2");

  // Absent → two containers, exactly as before the seat existed.
  const { exec: e2, calls: c2 } = cluster();
  await kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...e2 }).provision({
    name: "sb-nouser",
    runId: "r",
    workflow: "w",
    ...withApp,
  });
  assert.deepEqual(
    crOf(c2).spec.sidecars.map((s: { name: string }) => s.name),
    ["custodian"],
    "no default User Container — the seat's identity is what jr2 does not own",
  );
});

test("an image that declares no USER gets ADR-0037's fallback seat, in BOTH places it runs", async () => {
  // The recorded `""` is what the converge's `docker inspect` saw (images.ts) — a fact a provision
  // cannot ask for itself. jr2 supplies a uid ONLY here: everywhere else the image's own USER
  // decides its seat (ADR-0005), and this is the one case where the image chose nothing and the
  // alternative is root, which the hardened context refuses.
  const bare = {
    ...REFS,
    sandbox: { ...REFS.sandbox, [BARE.key]: "jr2-sandbox-inst-bare:b00" },
    sandboxUser: { [BARE.key]: "" },
  };
  const { exec, calls } = cluster();
  await kubeSandbox({ imagesPath: await mkImages(bare), ...provisionable, ...exec }).provision({
    name: "sb-bare",
    runId: "r",
    workflow: "w",
    image: BARE.url,
    ...withApp,
  });

  const applied = crOf(calls);
  assert.equal(applied.spec.securityContext.runAsUser, 1000);
  assert.equal(applied.spec.securityContext.runAsNonRoot, true, "the fallback is a uid, not a loosening");
  // A writable HOME is part of ADR-0037's floor, and uid 1000 on a stranger's base has no home at
  // all — so jr2 supplies one as a pod volume rather than expecting a layer for it.
  assert.deepEqual(applied.spec.env[0], { name: "HOME", value: "/home/jr2" });
  assert.ok(applied.spec.volumes.some((v: { name: string }) => v.name === "home"));
  assert.deepEqual(applied.spec.volumeMounts.at(-1), { name: "home", mountPath: "/home/jr2" });

  // The probe runs in the SAME seat, or it proved a different uid's $HOME and proved nothing.
  const preflight = applied.spec.initContainers[0];
  assert.equal(preflight.securityContext.runAsUser, 1000);
  assert.deepEqual(preflight.env, [{ name: "HOME", value: "/home/jr2" }]);
  assert.deepEqual(preflight.volumeMounts.at(-1), { name: "home", mountPath: "/home/jr2" });

  // And an image that DID declare one keeps its own environment, dotfiles included: no uid, no
  // HOME, no home volume anywhere in the CR.
  const { exec: e2, calls: c2 } = cluster();
  await kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...e2 }).provision({
    name: "sb-own",
    runId: "r",
    workflow: "w",
    image: RUST.url,
    ...withApp,
  });
  const own = crOf(c2);
  assert.equal(own.spec.securityContext.runAsUser, undefined, "jr2 sets runAsUser nowhere else");
  assert.ok(!own.spec.env.some((e: { name: string }) => e.name === "HOME"));
  assert.ok(!own.spec.volumes.some((v: { name: string }) => v.name === "home"));
});

test("the pod carries the work group: fsGroup = spec.workGroup ?? 2000", async () => {
  // ADR-0005's ownership half of cross-uid sharing on `/work` (the attach's default ACL is the
  // writability half). The override exists for the image whose sessions already hold a gid of
  // their own — pointing the work group at it costs no rebuild.
  const fsGroupFor = async (workGroup?: number): Promise<number> => {
    const { exec, calls } = cluster();
    const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });
    await port.provision({
      name: "sb",
      runId: "r",
      workflow: "w",
      ...withApp,
      ...(workGroup !== undefined ? { workGroup } : {}),
    });
    return crOf(calls).spec.fsGroup;
  };

  assert.equal(await fsGroupFor(), 2000, "the default is convention, never a config key");
  assert.equal(await fsGroupFor(4000), 4000);
});

test("the Sandbox Image chain: the wrapper's context → images/default → the stock Harness", async () => {
  const provisionWith = async (refs: unknown, image?: string): Promise<string> => {
    const { exec, calls } = cluster();
    const port = kubeSandbox({ imagesPath: await mkImages(refs), ...provisionable, ...exec });
    await port.provision({ name: "sb", runId: "r", workflow: "w", ...withApp, ...(image ? { image } : {}) });
    return crOf(calls).spec.image;
  };

  assert.equal(await provisionWith(REFS, RUST.url), "jr2-sandbox-inst-rust:r00", "the wrapper's context wins");
  assert.equal(await provisionWith(REFS), "jr2-sandbox-inst-default:d00", "no image → images/default");
  // The last leg comes out of the MAP, not a `jr2-harness:<kitversion>` literal: in a kit checkout
  // the Harness is a content-addressed tag (ADR-0038) and a literal would name nothing built.
  assert.equal(
    await provisionWith({ harness: "jr2-harness:h00", custodian: "envoy:c00", sandbox: {} }),
    "jr2-harness:h00",
    "no images/default → the stock Harness",
  );
});

test("a context this converge did not build fails the provision with NOTHING applied", async () => {
  // The stale-deployment case (ADR-0049): the Orchestrator's bundle holds a context whose digest is
  // in no map, because the last `jr2 up` predates the Machine edit that named it.
  const { exec, calls } = cluster();
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });

  await assert.rejects(
    () => port.provision({ name: "sb", runId: "r", workflow: "w", image: GOLANG.url, ...withApp }),
    (err: Error) => {
      assert.match(err.message, /no Sandbox Image for file:/);
      assert.match(err.message, /jr2 up/, "the error names the fix");
      return true;
    },
  );
  // Read-first is what buys this: no token Secret, no CR, nothing for anyone to clean up.
  assert.deepEqual(calls, []);
});

test("a recorded USER the kubelet would refuse fails the provision by NAME, not by timeout", async () => {
  // The failure this replaces is the worst-shaped one jr2 has: `runAsNonRoot` with no `runAsUser`
  // makes the kubelet resolve the image's USER itself, a non-numeric or root one is
  // CreateContainerConfigError on the `preflight` init container, and a container that never
  // starts has no logs — so the timeout hint dead-ends and 120s burn before anything is said. The
  // converge already recorded the string, so the read-first provision can say it up front.
  const { exec, calls } = cluster();
  const named = {
    ...REFS,
    sandbox: { ...REFS.sandbox, [DEV.key]: "jr2-sandbox-inst-dev:v00" },
    sandboxUser: { [DEV.key]: "dev" },
  };
  const port = kubeSandbox({ imagesPath: await mkImages(named), ...provisionable, ...exec });

  await assert.rejects(
    () => port.provision({ name: "sb", runId: "r", workflow: "w", image: DEV.url, ...withApp }),
    (err: Error) => {
      assert.match(err.message, /`USER dev`/);
      assert.match(err.message, /USER 1000/, "the message names the one-line fix in the caller's Dockerfile");
      return true;
    },
  );
  assert.deepEqual(calls, [], "nothing applied: no token Secret, no CR, nothing to clean up");

  // Root is the same refusal for the other reason, and `uid:gid` is judged on the uid half only.
  const rooted = kubeSandbox({
    imagesPath: await mkImages({ ...named, sandboxUser: { [DEV.key]: "0" } }),
    ...provisionable,
    ...exec,
  });
  await assert.rejects(
    () => rooted.provision({ name: "sb", runId: "r", workflow: "w", image: DEV.url, ...withApp }),
    /`USER 0`/,
  );

  const paired = kubeSandbox({
    imagesPath: await mkImages({ ...named, sandboxUser: { [DEV.key]: "1000:2000" } }),
    ...provisionable,
    ...exec,
  });
  await paired.provision({ name: "sb", runId: "r", workflow: "w", image: DEV.url, ...withApp });
});

test("a Harness that keeps dying before Ready fails the provision BY NAME, with the kubelet's reason", async () => {
  // ADR-0063: the operator publishes the Harness container's restarts and last end, so a Harness
  // that dies on start is seen as it happens — not as the rest of a 120s budget.
  const crashing = {
    phase: "Pending",
    harness: { restartCount: 2, lastTerminated: { reason: "Error", exitCode: 1 } },
  };
  const { exec } = cluster([
    PENDING,
    { ...crashing, harness: { restartCount: 1, lastTerminated: { reason: "Error", exitCode: 1 } } },
    crashing,
  ]);
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, readyTimeoutMs: 60_000, ...exec });
  await assert.rejects(
    () => port.provision({ name: "sb-crash", runId: "r", workflow: "w", ...withApp }),
    (err: Error) => {
      assert.match(err.message, /Sandbox "sb-crash" cannot start: its Harness has ended 2 times/);
      assert.match(err.message, /last: Error, exit 1/, "the kubelet's reason and exit code");
      assert.match(err.message, /kubectl logs sb-crash -c harness --previous/, "where the rest is");
      return true;
    },
  );

  // One restart on the way up is a pod that may still come up.
  const once = cluster([
    { phase: "Pending", harness: { restartCount: 1, lastTerminated: { reason: "OOMKilled", exitCode: 137 } } },
    READY,
  ]);
  const port2 = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...once.exec });
  assert.equal(
    (await port2.provision({ name: "sb-once", runId: "r", workflow: "w", ...withApp })).endpoint,
    READY.endpoint,
  );

  // And a memory kill says so, with the fix.
  const oom = cluster([
    { phase: "Pending", harness: { restartCount: 2, lastTerminated: { reason: "OOMKilled", exitCode: 137 } } },
  ]);
  const port3 = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...oom.exec });
  await assert.rejects(
    () => port3.provision({ name: "sb-oom", runId: "r", workflow: "w", ...withApp }),
    /OOMKilled, exit 137.*larger Size/s,
  );
});

test("a brought image that runs as root fails the provision at once, BY NAME, with the USER fix (ADR-0063)", async () => {
  // A registry ref is never inspected (ADR-0037), so a root or non-numeric USER is knowable only
  // from the cluster: the kubelet refuses the preflight with CreateContainerConfigError and it never
  // starts — no log, no termination. The operator publishes the waiting reason; the judge reads it.
  const root = 'container has runAsNonRoot and image will run as root (pod: "sb-root_default", container: preflight)';
  const { exec } = cluster([
    PENDING,
    { phase: "Pending", waiting: [{ container: "preflight", reason: "CreateContainerConfigError", message: root }] },
  ]);
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, readyTimeoutMs: 60_000, ...exec });
  const started = Date.now();
  await assert.rejects(
    () => port.provision({ name: "sb-root", runId: "r", workflow: "w", ...withApp }),
    (err: Error) => {
      assert.match(err.message, /Sandbox "sb-root" cannot start: its image runs as ROOT/);
      assert.match(err.message, /runAsNonRoot and image will run as root/, "the kubelet's words");
      assert.match(err.message, /USER 1000/, "the one-line fix");
      return true;
    },
  );
  assert.ok(Date.now() - started < 5_000, "at once, not the rest of the budget");

  // The same reason for another cause (a missing Secret key) is not the root fault: no false name.
  const other = cluster([
    {
      phase: "Pending",
      waiting: [{ container: "harness", reason: "CreateContainerConfigError", message: 'secret "x" not found' }],
    },
    READY,
  ]);
  const port2 = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...other.exec });
  assert.equal(
    (await port2.provision({ name: "sb-2", runId: "r", workflow: "w", ...withApp })).endpoint,
    READY.endpoint,
  );
});

test("an image name the kubelet cannot use fails at once; a failing pull is named when the budget runs out (ADR-0063)", async () => {
  const bad = cluster([
    {
      phase: "Pending",
      waiting: [
        { container: "preflight", reason: "InvalidImageName", message: 'Failed to apply default image tag "x:"' },
      ],
    },
  ]);
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, readyTimeoutMs: 60_000, ...bad.exec });
  await assert.rejects(
    () => port.provision({ name: "sb-bad", runId: "r", workflow: "w", ...withApp }),
    /Sandbox "sb-bad" cannot start: container "preflight" InvalidImageName: Failed to apply default image tag/,
  );

  // A pull may recover (a registry blip, node credentials); the pod budget decides, and the
  // expiry says what the kubelet was waiting on instead of guessing at the preflight.
  const pull = cluster([
    {
      phase: "Pending",
      waiting: [{ container: "preflight", reason: "ImagePullBackOff", message: "Back-off pulling image" }],
    },
  ]);
  const port2 = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, readyTimeoutMs: 200, ...pull.exec });
  await assert.rejects(
    () => port2.provision({ name: "sb-pull", runId: "r", workflow: "w", ...withApp }),
    /never reached Ready[\s\S]*container "preflight" is waiting: ImagePullBackOff: Back-off pulling image/,
  );
});

// --- placing (ADR-0064) -----------------------------------------------------------------------

const unplaced = (on: "Unschedulable" | "QuotaExceeded", message: string) => ({
  phase: "Pending",
  conditions: [{ type: "Scheduled", status: "False", reason: on, message }],
});
const NO_MEMORY = "0/3 nodes are available: 3 Insufficient memory.";
const NO_QUOTA = 'pods "sb" is forbidden: exceeded quota: jr2, requested: requests.cpu=500m, used: requests.cpu=2';

test("place(): a Sandbox with no node waits with NO deadline, says each reason once, and ends when scheduled", async () => {
  // The operator is played by hand: the pod waits longer than the whole Ready budget, which it
  // must not spend — jr2 cannot tell "full now" from "never fits" (ADR-0064).
  const { exec, api } = cluster([]);
  const port = kubePort({ imagesPath: await mkImages(REFS), ...provisionable, readyTimeoutMs: 100, ...exec });
  const waits: PlacingWait[] = [];
  let placed = false;
  const placing = port
    .place({ name: "sb-wait", runId: "r", workflow: "w", ...withApp }, { onWait: (w) => waits.push(w) })
    .then(() => (placed = true));
  await waitFor(() => api.object("sandboxes", "sb-wait") !== undefined);
  api.setStatus("sandboxes", "sb-wait", unplaced("Unschedulable", NO_MEMORY));
  await waitFor(() => waits.length === 1);
  // The same reason again (the operator writes on any change) is no new wait; a quota's is.
  api.setStatus("sandboxes", "sb-wait", { ...unplaced("Unschedulable", NO_MEMORY), podUID: "p" });
  api.setStatus("sandboxes", "sb-wait", unplaced("QuotaExceeded", NO_QUOTA));
  await waitFor(() => waits.length === 2);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(placed, false, "still waiting, well past the Ready budget");
  assert.deepEqual(waits, [
    { on: "node", message: NO_MEMORY },
    { on: "quota", message: NO_QUOTA },
  ]);

  // Scheduled: the wait ends, and the Ready budget starts only now.
  api.setStatus("sandboxes", "sb-wait", { ...PENDING, conditions: [SCHEDULED] });
  await placing;
  const ready = port.provision("sb-wait");
  setTimeout(() => api.setStatus("sandboxes", "sb-wait", READY), 50);
  assert.deepEqual(await ready, { endpoint: READY.endpoint });
});

test("place(): a Sandbox not yet looked at by the scheduler is no reason — only a False Scheduled is", async () => {
  const { exec } = cluster([
    { phase: "Pending", conditions: [{ type: "Scheduled", status: "Unknown", reason: "SchedulingPending" }] },
    PENDING,
  ]);
  const port = kubePort({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });
  const waits: PlacingWait[] = [];
  await port.place({ name: "sb-fast", runId: "r", workflow: "w", ...withApp }, { onWait: (w) => waits.push(w) });
  assert.deepEqual(waits, []);
});

test("place(): Lost, or deleted, before a node is a failure by name — never a wait (ADR-0021)", async () => {
  const lost = {
    phase: "Lost",
    conditions: [{ type: "Lost", status: "True", reason: "PodDeleted", message: "the pod was deleted" }],
  };
  const { exec } = cluster([unplaced("Unschedulable", NO_MEMORY), lost]);
  const port = kubePort({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });
  await assert.rejects(
    () => port.place({ name: "sb-lost", runId: "r", workflow: "w", ...withApp }, { onWait: () => {} }),
    /Sandbox "sb-lost" is Lost while it waited for a node: PodDeleted: the pod was deleted/,
  );

  const gone = cluster([unplaced("Unschedulable", NO_MEMORY)]);
  const port2 = kubePort({ imagesPath: await mkImages(REFS), ...provisionable, ...gone.exec });
  const waits: PlacingWait[] = [];
  const placing = port2.place(
    { name: "sb-del", runId: "r", workflow: "w", ...withApp },
    { onWait: (w) => waits.push(w) },
  );
  await waitFor(() => waits.length === 1);
  gone.api.remove("sandboxes", "sb-del");
  await assert.rejects(placing, /Sandbox "sb-del" was deleted while it waited for a node/);
});

test("place(): the signal ends the wait, after the write it began has settled", async () => {
  const { exec, api, calls } = cluster([]);
  const port = kubePort({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });
  const controller = new AbortController();
  const placing = port.place(
    { name: "sb-stop", runId: "r", workflow: "w", ...withApp },
    { onWait: () => {}, signal: controller.signal },
  );
  await waitFor(() => api.object("sandboxes", "sb-stop") !== undefined);
  controller.abort(new Error("stopped"));
  await assert.rejects(placing, /stopped/);
  assert.equal(applies(calls, "sandboxes").length, 1, "the CR was written once, before the stop");
});

test("provision(): Lost, or deleted, once placed fails at once, naming the pod's reason (ADR-0021)", async () => {
  const evicted = {
    phase: "Lost",
    conditions: [
      { type: "Ready", status: "False", reason: "Lost" },
      { type: "Lost", status: "True", reason: "Evicted", message: "The node was low on resource: memory." },
    ],
  };
  const { exec } = cluster([PENDING, evicted]);
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });
  await assert.rejects(
    () => port.provision({ name: "sb-ev", runId: "r", workflow: "w", ...withApp }),
    /Sandbox "sb-ev" is Lost while it provisioned: Evicted: The node was low on resource: memory\./,
  );

  const gone = cluster([PENDING]);
  const port2 = kubePort({ imagesPath: await mkImages(REFS), ...provisionable, ...gone.exec });
  await port2.place({ name: "sb-gone", runId: "r", workflow: "w", ...withApp }, { onWait: () => {} });
  const provisioning = port2.provision("sb-gone");
  gone.api.remove("sandboxes", "sb-gone");
  await assert.rejects(provisioning, /Sandbox "sb-gone" was deleted while it provisioned/);
});

test("the map is re-read PER provision, so a converge reaches the next Sandbox without a roll", async () => {
  // The whole reason the refs arrive as a mounted ConfigMap rather than Deployment env (ADR-0038):
  // a rebuilt image must reach FUTURE Sandboxes without bouncing every live run through restore.
  const imagesPath = await mkImages(REFS);
  const { exec, calls } = cluster();
  const port = kubeSandbox({ imagesPath, ...provisionable, ...exec });

  await port.provision({ name: "sb-a", runId: "r", workflow: "w", ...withApp });
  await writeFile(imagesPath, JSON.stringify({ ...REFS, sandbox: { default: "jr2-sandbox-inst-default:d99" } }));
  await port.provision({ name: "sb-b", runId: "r", workflow: "w", ...withApp });

  const images = applies(calls, "sandboxes").map((cr: { spec: { image: string } }) => cr.spec.image);
  assert.deepEqual(images, ["jr2-sandbox-inst-default:d00", "jr2-sandbox-inst-default:d99"]);
});

test("an absent or malformed image map fails the provision pointing at `jr2 up`, never a published tag", async () => {
  const { exec } = cluster();
  const missing = kubeSandbox({ imagesPath: "/nonexistent/jr2/images.json", ...provisionable, ...exec });
  await assert.rejects(
    () => missing.provision({ name: "sb", runId: "r", workflow: "w", ...withApp }),
    (err: Error) => {
      assert.match(err.message, /\/nonexistent\/jr2\/images\.json/, "names the path");
      assert.match(err.message, /jr2 up/, "names the fix");
      return true;
    },
  );

  // A map with no `custodian` is loud, not a pod with no route home: an Agent whose pod has no
  // Custodian parks its Machine forever on a Menu it cannot read (ADR-0013).
  const noCustodian = kubeSandbox({
    imagesPath: await mkImages({ harness: "jr2-harness:h00", sandbox: {} }),
    ...provisionable,
    ...exec,
  });
  await assert.rejects(
    () => noCustodian.provision({ name: "sb", runId: "r", workflow: "w", ...withApp }),
    /no `custodian` ref/,
  );

  // And so is an absent held-secret manifest: composing a Custodian on a guess would hold what the
  // converge did not, or leave out what it did (ADR-0059).
  const noHeld = kubeSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    heldPath: "/nonexistent/jr2/held.json",
    ...exec,
  });
  await assert.rejects(
    () => noHeld.provision({ name: "sb", runId: "r", workflow: "w", ...withApp }),
    /\/nonexistent\/jr2\/held\.json.*jr2 up/s,
  );
});

test("env/envFrom pass through to the HARNESS container spec; mechanism env rides after them", async () => {
  const { exec, calls } = cluster();
  const port = kubeSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    ...exec,
    env: [{ name: "FLUE_LOG", value: "debug" }],
    envFrom: [{ secretRef: { name: "anthropic" } }],
  });
  await port.provision({ name: "sb-env", runId: "r", workflow: "w", ...withApp });

  const applied = crOf(calls);
  assert.deepEqual(
    applied.spec.env.map((e: { name: string }) => e.name),
    [
      "FLUE_LOG",
      "JR2_CUSTODIAN_URL",
      "JR2_SANDBOX_TOKEN",
      // The CPU hints (ADR-0060): mechanism, so after the instance's own.
      "JR2_CPUS",
      "OMP_NUM_THREADS",
      "PYTHON_CPU_COUNT",
      "GOMAXPROCS",
      "JR2_HARNESS_TOKEN_SHA256",
    ],
  );
  assert.deepEqual(applied.spec.envFrom, [{ secretRef: { name: "anthropic" } }]);
});

test("each Sandbox's Harness gets the DIGEST of its own placement's bearer, last — never the bearer (ADR-0058)", async () => {
  const { exec, calls } = cluster();
  const port = kubeSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    ...exec,
    // An instance's `harness.env` naming the same var cannot open the gate: the mechanism's rides last.
    env: [{ name: "JR2_HARNESS_TOKEN_SHA256", value: "attacker-chosen" }],
  });
  await port.provision({ name: "sb-a", runId: "r", workflow: "w", ...withApp });
  await port.provision({ name: "sb-b", runId: "r", workflow: "w", ...withApp });
  const crs = applies(calls, "sandboxes");
  const digestOf = (cr: { spec: { env: Array<{ name: string; value?: string }> } }) =>
    cr.spec.env.filter((e) => e.name === "JR2_HARNESS_TOKEN_SHA256").at(-1)?.value;

  assert.equal(digestOf(crs[0]), harnessTokenDigest(provisionable.signingKey, "sb-a"));
  assert.equal(digestOf(crs[1]), harnessTokenDigest(provisionable.signingKey, "sb-b"));
  assert.notEqual(digestOf(crs[0]), digestOf(crs[1]), "one pod's bearer opens no other pod");
  // The bearer itself appears nowhere in what the pod is given — not in the CR, not in a Secret.
  for (const call of calls) {
    assert.ok(!JSON.stringify(call.body ?? {}).includes(harnessToken(provisionable.signingKey, "sb-a")));
  }
});

test("the Custodian is UNCONDITIONAL and is the pod's only credential holder (ADR-0013, ADR-0059)", async () => {
  const { api, exec, calls } = cluster();
  const port = kubeSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    ...exec,
    envFrom: [{ secretRef: { name: "anthropic" } }],
  });
  await port.provision({ name: "sb-env2", runId: "r", workflow: "w", ...withApp });

  const applied = crOf(calls);
  // No User Container was named — so this list is exactly the Custodian.
  assert.deepEqual(
    applied.spec.sidecars.map((s: { name: string; image: string }) => [s.name, s.image]),
    [["custodian", "envoy:c00"]],
  );
  const custodian = applied.spec.sidecars[0];
  // The token is a FILE in the Custodian, and nothing of it is in any env (ADR-0013 asymmetry):
  // the Custodian's env is its Sandbox's name and nothing else.
  assert.equal(custodian.envFrom, undefined);
  assert.deepEqual(custodian.env, [{ name: "JR2_SANDBOX", value: "sb-env2" }]);
  const values = applied.spec.volumes.find((v: { name: string }) => v.name === "custodian-values");
  assert.deepEqual(values.projected.sources, [
    { secret: { name: "sb-env2-token", items: [{ key: "JR2_SANDBOX_TOKEN", path: "JR2_SANDBOX_TOKEN" }] } },
  ]);
  // The Harness holds the token's Stand-in, never the token.
  assert.ok(
    applied.spec.env.some(
      (e: { name: string; value?: string }) =>
        e.name === "JR2_SANDBOX_TOKEN" && e.value === standIn("JR2_SANDBOX_TOKEN"),
    ),
  );
  assert.ok(
    !applied.spec.volumeMounts.some((m: { name: string }) => m.name.startsWith("custodian-")),
    "the Harness container mounts nothing of the Custodian's",
  );
  const [secret] = applies(calls, "secrets");
  assert.equal(secret.metadata.name, "sb-env2-token");
  // `data`, not `stringData`: a server-side apply owns the fields it names (ADR-0063).
  assert.ok(Buffer.from(secret.data.JR2_SANDBOX_TOKEN, "base64").toString().length > 0);
  assert.equal(secret.stringData, undefined);
  // …and it is the CR's child from birth, by the uid the CR's apply answered with (ADR-0001).
  assert.deepEqual(secret.metadata.ownerReferences, [
    {
      apiVersion: "core.jr2.dev/v1alpha1",
      kind: "Sandbox",
      name: "sb-env2",
      uid: api.object("sandboxes", "sb-env2").metadata.uid,
      controller: true,
      blockOwnerDeletion: false,
    },
  ]);
});

test("the token Secret is written AFTER the CR, owned from birth, and a re-apply writes the same (ADR-0001)", async () => {
  const { api, exec, calls } = cluster();
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });
  await port.provision({ name: "sb-own", runId: "r", workflow: "w", ...withApp });

  const writes = calls.map((c) => c.target);
  const cr = writes.indexOf("sandboxes/sb-own");
  const secret = writes.indexOf("secrets/sb-own-token");
  assert.ok(cr >= 0 && secret > cr, `the CR first, then its Secret: ${writes.join(", ")}`);
  assert.equal(
    calls.filter((c) => c.target.startsWith("secrets/") && c.contentType !== "application/apply-patch+yaml").length,
    0,
    "one write makes the Secret whole: no owner patched on after",
  );

  // An Orchestrator restart re-provisions by name: the CR keeps its uid, so the Secret re-applies
  // the SAME token and the SAME owner — a no-op for the Custodian holding it.
  await port.provision({ name: "sb-own", runId: "r", workflow: "w", ...withApp });
  const [first, again] = applies(calls, "secrets");
  assert.deepEqual(again, first);
  assert.equal(first.metadata.ownerReferences[0].uid, api.object("sandboxes", "sb-own").metadata.uid);
});

test("a CR apply that fails writes no token Secret (ADR-0001)", async () => {
  const { api, exec, calls } = cluster();
  api.refuse((call) =>
    call.target === "sandboxes/sb-refused" ? Response.json({ message: "no" }, { status: 500 }) : undefined,
  );
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });
  await assert.rejects(port.provision({ name: "sb-refused", runId: "r", workflow: "w", ...withApp }));
  assert.deepEqual(applies(calls, "secrets"), [], "no Secret without the CR that owns it");
});

test("a token Secret that fails after its CR fails the provision, and the CR is its caller's to delete (ADR-0001)", async () => {
  const { api, exec } = cluster([]); // no operator: the CR is deleted before it would answer
  api.refuse((call) =>
    call.target === "secrets/sb-orphan-token" ? Response.json({ message: "no" }, { status: 500 }) : undefined,
  );
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });
  await assert.rejects(port.provision({ name: "sb-orphan", runId: "r", workflow: "w", ...withApp }));
  // The CR exists with no token for its Custodian. The provision rejected, so the Workspace deletes
  // it — workspace.ts destroys a Sandbox whose place failed (workspace.test.ts pins that) — and the
  // delete takes it whole.
  assert.ok(api.object("sandboxes", "sb-orphan"));
  await port.destroy("sb-orphan");
  assert.equal(api.object("sandboxes", "sb-orphan"), undefined);
});

test("a held secret: the Harness gets Stand-ins and the proxy, the Custodian alone mounts values and leaves (ADR-0059)", async () => {
  const manifest: HeldManifest = {
    version: 1,
    secrets: [
      {
        name: "ANTHROPIC_API_KEY",
        source: { kind: "literal" },
        hosts: [{ host: "litellm.corp.example", port: 443, leaf: leafStem("litellm.corp.example", 443) }],
        headers: ["x-api-key"],
      },
      {
        name: "OPENAI_API_KEY",
        source: { kind: "secret", secret: "team-keys", key: "openai" },
        hosts: [{ host: "api.openai.com", port: 443, leaf: leafStem("api.openai.com", 443) }],
        headers: ["authorization"],
      },
    ],
  };
  const { exec, calls } = cluster();
  await kubeSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    heldPath: await mkHeld(manifest),
    ...exec,
    caBundle: true,
    env: [{ name: "FLUE_LOG", value: "debug" }],
    // A same-named key in an envFrom Secret loses to the Stand-in: `env` wins over `envFrom`.
    envFrom: [{ secretRef: { name: "stale-keys" } }],
  }).provision({ name: "sb-held", runId: "r", workflow: "w", user: "ghcr.io/acme/sshd:1", ...withApp });
  const applied = crOf(calls);

  assert.deepEqual(
    applied.spec.env.map((e: { name: string; value?: string }) => [e.name, e.value]),
    [
      ["FLUE_LOG", "debug"],
      ["JR2_CUSTODIAN_URL", "http://127.0.0.1:8081"],
      ["JR2_SANDBOX_TOKEN", "jr2-held-JR2_SANDBOX_TOKEN"],
      ["ANTHROPIC_API_KEY", "jr2-held-ANTHROPIC_API_KEY"],
      ["OPENAI_API_KEY", "jr2-held-OPENAI_API_KEY"],
      ["HTTPS_PROXY", "http://127.0.0.1:15001"],
      ["https_proxy", "http://127.0.0.1:15001"],
      ["NO_PROXY", "localhost,127.0.0.1,::1"],
      ["no_proxy", "localhost,127.0.0.1,::1"],
      ["NODE_USE_ENV_PROXY", "1"],
      ["NODE_EXTRA_CA_CERTS", "/etc/jr2/ca/extra.crt"],
      ["SSL_CERT_FILE", "/etc/jr2/ca/bundle.crt"],
      ["REQUESTS_CA_BUNDLE", "/etc/jr2/ca/bundle.crt"],
      ["GIT_SSL_CAINFO", "/etc/jr2/ca/bundle.crt"],
      ...CPU_HINTS.map((h) => [h.name, undefined]),
      ["JR2_HARNESS_TOKEN_SHA256", harnessTokenDigest(provisionable.signingKey, "sb-held")],
    ],
  );
  assert.deepEqual(applied.spec.envFrom, [{ secretRef: { name: "stale-keys" } }]);

  const custodian = applied.spec.sidecars.find((c: { name: string }) => c.name === "custodian");
  assert.deepEqual(
    custodian.volumeMounts.map((m: { name: string; mountPath: string }) => [m.name, m.mountPath]),
    [
      ["custodian-values", "/etc/jr2/custodian/values"],
      ["custodian-config", "/etc/jr2/custodian/config"],
      ["custodian-tls", "/etc/jr2/custodian/tls"],
      ["custodian-trust", "/etc/jr2/ca"],
    ],
  );
  const values = applied.spec.volumes.find((v: { name: string }) => v.name === "custodian-values");
  assert.equal(values.projected.defaultMode, 0o440);
  assert.deepEqual(values.projected.sources.slice(1), [
    { secret: { name: "jr2-held-secrets", items: [{ key: "ANTHROPIC_API_KEY", path: "ANTHROPIC_API_KEY" }] } },
    { secret: { name: "team-keys", items: [{ key: "openai", path: "OPENAI_API_KEY" }] } },
  ]);
  assert.deepEqual(
    applied.spec.volumes.find((v: { name: string }) => v.name === "custodian-trust"),
    {
      name: "custodian-trust",
      configMap: { name: "jr2-ca", items: [{ key: "upstream.crt", path: "upstream.crt" }] },
    },
  );

  // The asymmetry, whole: no container but the Custodian references what it holds — not the
  // Harness (the CR's own mounts), not the User Container.
  const held = new Set(["custodian-values", "custodian-tls", "custodian-config", "custodian-trust"]);
  for (const container of [{ name: "harness", volumeMounts: applied.spec.volumeMounts }, ...applied.spec.sidecars]) {
    if (container.name === "custodian") continue;
    for (const m of container.volumeMounts ?? []) assert.ok(!held.has(m.name), `${container.name} mounts ${m.name}`);
    assert.ok(
      !JSON.stringify(container).includes("jr2-held-secrets") && !JSON.stringify(container).includes("team-keys"),
    );
  }
  assert.ok(!JSON.stringify(applied).includes("jr2-held-ca"), "no pod names the CA's Secret");
  assert.ok(!("shareProcessNamespace" in applied.spec), "the Agent cannot read another container's /proc");
  assert.deepEqual(custodian.securityContext, {
    runAsNonRoot: true,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
  });
  assert.deepEqual(custodian.readinessProbe.httpGet, { path: "/healthz", port: 15021 });
});

test("caBundle, nothing held: the jr2-ca ConfigMap mounts into the HARNESS container with NODE_EXTRA_CA_CERTS; absent → nothing", async () => {
  const imagesPath = await mkImages(REFS);
  const withCa = cluster();
  await kubeSandbox({ imagesPath, ...provisionable, ...withCa.exec, caBundle: true }).provision({
    name: "sb-ca",
    runId: "r",
    workflow: "w",
    ...withApp,
  });
  const applied = crOf(withCa.calls);
  assert.deepEqual(applied.spec.env, [
    { name: "JR2_CUSTODIAN_URL", value: "http://127.0.0.1:8081" },
    { name: "JR2_SANDBOX_TOKEN", value: "jr2-held-JR2_SANDBOX_TOKEN" },
    { name: "NODE_EXTRA_CA_CERTS", value: "/etc/jr2/ca/ca.crt" },
    ...CPU_HINTS,
    { name: "JR2_HARNESS_TOKEN_SHA256", value: harnessTokenDigest(provisionable.signingKey, "sb-ca") },
  ]);
  assert.deepEqual(applied.spec.volumes.at(-1), { name: "ca", configMap: { name: "jr2-ca" } });
  // CR-level volumeMounts land on the HARNESS container only (operator contract). With nothing
  // held, the Custodian verifies no upstream, so it mounts no trust at all.
  assert.deepEqual(applied.spec.volumeMounts.at(-1), { name: "ca", mountPath: "/etc/jr2/ca", readOnly: true });
  const custodian = applied.spec.sidecars.find((c: { name: string }) => c.name === "custodian");
  assert.ok(!custodian.volumeMounts.some((m: { name: string }) => m.name === "ca" || m.name === "custodian-trust"));

  const without = cluster();
  await kubeSandbox({ imagesPath, ...provisionable, ...without.exec }).provision({
    name: "sb-noca",
    runId: "r",
    workflow: "w",
    ...withApp,
  });
  const bare = crOf(without.calls);
  assert.ok(!bare.spec.volumes.some((v: { name: string }) => v.name === "ca"));
});

test("provision resolves with the Harness endpoint, and nothing else (ADR-0021: no pod identity to hold)", async () => {
  const { exec } = cluster();
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });

  assert.deepEqual(await port.provision({ name: "sb-1", runId: "r", workflow: "w", ...withApp }), {
    endpoint: "http://sb-1.default.svc:8080",
  });
});

test("renew() is a merge patch of the keepalive stamp — a write, and nothing is read back (ADR-0021)", async () => {
  const { exec, calls, api } = cluster();
  api.seed("sandboxes", { metadata: { name: "sb-1", labels: { "jr2.dev/run": "r" } }, status: READY } as never);
  const port = kubeSandbox({ ...exec });

  assert.equal(await port.renew("sb-1"), undefined);
  assert.equal(calls.length, 1, "one write per renewal");
  const [patch] = calls;
  assert.equal(patch!.method, "PATCH");
  assert.equal(patch!.target, "sandboxes/sb-1");
  assert.equal(patch!.contentType, "application/merge-patch+json");
  const stamp = patch!.body.metadata.annotations["jr2.dev/keepalive"];
  assert.ok(!Number.isNaN(Date.parse(stamp)), "value is a parseable timestamp");

  // A failure rejects — the lease shrugs it off; loss is the watch's to report, never this.
  await assert.rejects(() => port.renew("gone"), /404/);
});

/** Every Continuity the port reports for one name, in order. */
function heard(port: ReturnType<typeof kubeSandbox>, name: string): Continuity[] {
  const seen: Continuity[] = [];
  port.continuity(name, (c) => seen.push(c));
  return seen;
}

test("continuity(): the watch's first list is the reconcile — present, or gone (ADR-0012, ADR-0021)", async () => {
  const { exec, api } = cluster();
  api.seed("sandboxes", { metadata: { name: "sb-1", labels: { "jr2.dev/run": "r" } }, status: READY } as never);
  const port = kubeSandbox({ ...exec });
  const live = heard(port, "sb-1");
  const gone = heard(port, "sb-reaped-while-we-were-down");
  await waitFor(() => live.length === 1 && gone.length === 1);
  assert.deepEqual(live, [{ present: true }]);
  assert.deepEqual(gone, [{ present: false }]);
});

test("continuity(): Lost is heard within one event, with the pod's reason — and a new podUID is not loss", async () => {
  // What an eviction looks like from here: the CR is there, the name and endpoint unchanged — and
  // the operator says its one pod ended. It judges identity, because it knows which pod it created;
  // nothing here compares UIDs (ADR-0021).
  const { exec, api } = cluster();
  api.seed("sandboxes", { metadata: { name: "sb-1", labels: { "jr2.dev/run": "r" } }, status: READY } as never);
  const port = kubeSandbox({ ...exec });
  const seen = heard(port, "sb-1");
  await waitFor(() => seen.length === 1);
  api.setStatus("sandboxes", "sb-1", { ...READY, podUID: "pod-uid-2" });
  await waitFor(() => seen.length === 2);
  assert.deepEqual(seen[1], { present: true });
  api.lose("sb-1", "NodeShutdown", "Pod was terminated in response to imminent node shutdown.");
  await waitFor(() => seen.length === 3);
  assert.deepEqual(seen[2], {
    present: true,
    lost: { reason: "NodeShutdown", message: "Pod was terminated in response to imminent node shutdown." },
  });
  // A Lost condition the operator left without words still names the loss.
  api.setStatus("sandboxes", "sb-1", { ...READY, phase: "Lost" });
  await waitFor(() => seen.length === 4);
  assert.equal((seen[3] as { lost?: { reason: string } }).lost?.reason, "Lost");
  api.remove("sandboxes", "sb-1");
  await waitFor(() => seen.length === 5);
  assert.deepEqual(seen[4], { present: false });
});

test("continuity(): a dropped watch reports NOTHING — unknown is never loss", async () => {
  const { exec, api } = cluster();
  api.seed("sandboxes", { metadata: { name: "sb-1", labels: { "jr2.dev/run": "r" } }, status: READY } as never);
  let down = false;
  api.refuse((c) => (down && c.method === "GET" ? new Response("unavailable", { status: 503 }) : undefined));
  const port = kubeSandbox({ ...exec });
  const seen = heard(port, "sb-1");
  await waitFor(() => seen.length === 1);
  down = true;
  api.closeWatches();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(seen.length, 1, "the API server went away; the Sandbox did not");
});

test("harnessRestarts(): the Harness container's restarts and last end, off the watch — silent for no Sandbox", async () => {
  const { exec, api } = cluster();
  api.seed("sandboxes", { metadata: { name: "sb-1", labels: { "jr2.dev/run": "r" } }, status: READY } as never);
  const port = kubeSandbox({ ...exec });
  const seen: unknown[] = [];
  const none: unknown[] = [];
  port.harnessRestarts("sb-1", (h) => seen.push(h));
  port.harnessRestarts("jr2-instance-harness", (h) => none.push(h));
  await waitFor(() => seen.length === 1);
  assert.deepEqual(seen[0], { restartCount: 0 });
  const last = { reason: "Error", exitCode: 1, finishedAt: "2026-09-29T10:00:00Z" };
  api.setStatus("sandboxes", "sb-1", { ...READY, harness: { restartCount: 1, lastTerminated: last } });
  await waitFor(() => seen.length === 2);
  assert.deepEqual(seen[1], { restartCount: 1, lastTerminated: last });
  assert.deepEqual(none, [], "the Instance Harness is not a Sandbox: nothing to hear");
});

// --- the memory fault (ADR-0061) ---------------------------------------------------------------

const TURN = new Date("2026-09-28T10:00:00Z");
const killed = (finishedAt: string, reason = "OOMKilled") => ({
  metadata: { name: "sb-1" },
  spec: { resources: { limits: { memory: "1920Mi" } } },
  status: { ...READY, harness: { restartCount: 1, lastTerminated: { reason, exitCode: 137, finishedAt } } },
});

test("memoryFaultOf: OOMKilled since the Turn began → the fixed prefix `memory limit`, with the limit", () => {
  const kill = memoryFaultOf(killed("2026-09-28T10:03:00Z"), TURN)!;
  const { reason } = kill;
  assert.ok(reason.startsWith("memory limit"), reason);
  // The data the next Turn's notice is made of (ADR-0062): the limit, and which kill it was.
  assert.equal(kill.limit, "1920Mi");
  assert.equal(kill.at, "2026-09-28T10:03:00Z");
  assert.match(reason, /^memory limit \(OOMKilled, limit 1920Mi\)/);
  assert.match(reason, /larger Size/);
  // Not a memory kill, not this Turn's, or not a kill at all → nothing to name.
  assert.equal(memoryFaultOf(killed("2026-09-28T10:03:00Z", "Error"), TURN), undefined);
  assert.equal(memoryFaultOf(killed("2026-09-28T09:00:00Z"), TURN), undefined, "an earlier Turn's kill");
  assert.equal(memoryFaultOf({ metadata: { name: "sb-1" }, status: READY }, TURN), undefined);
  assert.equal(memoryFaultOf(undefined, TURN), undefined);
});

test("memoryFault(): waits a moment for the operator's word, which can trail the Harness's restart", async () => {
  const { exec, api } = cluster();
  api.seed("sandboxes", { metadata: { name: "sb-1", labels: { "jr2.dev/run": "r" } }, status: READY } as never);
  const port = kubeSandbox({ ...exec });
  await waitFor(() => api.openWatches === 1);
  const named = port.memoryFault("sb-1", TURN);
  setTimeout(() => api.setStatus("sandboxes", "sb-1", killed("2026-09-28T10:03:00Z").status), 5);
  assert.match((await named)!.reason, /^memory limit \(OOMKilled/);
  // A name the watch does not hold (the Instance Harness is a Deployment) answers at once.
  assert.equal(await port.memoryFault("jr2-instance-harness", TURN), undefined);
});

// --- the credentials fence (ADR-0051) --------------------------------------------------------------

test("a per-run url matching no git.credentials entry is REFUSED before any write", async () => {
  // A per-run url is run input — a ticket field — and otherwise a way to spend the cluster's
  // credential against any host. The refusal names the identity and the list, and costs nothing:
  // no map read, no Secret, no CR.
  const { exec, calls } = cluster();
  const port = kubeSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    ...exec,
    credentials: [{ match: "github.com/ourorg/", token: "GH" }],
  });
  await assert.rejects(
    () =>
      port.provision({
        name: "sb-fence",
        runId: "r",
        workflow: "w",
        repos: [{ slot: "target", url: "https://github.com/nobody/x.git", perRun: true }],
      }),
    (err: Error) => {
      assert.match(err.message, /refuses the per-run repo https:\/\/github\.com\/nobody\/x\.git for slot "target"/);
      assert.match(err.message, /no git\.credentials entry matches "github\.com\/nobody\/x"/);
      assert.match(err.message, /entries: github\.com\/ourorg\//, "the list, so the fix is visible");
      assert.match(err.message, /ADR-0051/);
      return true;
    },
  );
  assert.deepEqual(calls, [], "nothing applied");

  // A url spelled as a git OPTION passes no fence at all: the identity refuses it before the list
  // is consulted, even under an entry whose prefix the smuggled host part would match (ADR-0051).
  const narrowed = kubeSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    ...exec,
    credentials: [{ match: "github.com/ourorg/", token: "GH" }],
  });
  await assert.rejects(
    () =>
      narrowed.provision({
        name: "sb-option",
        runId: "r",
        workflow: "w",
        repos: [{ slot: "target", url: "--upload-pack=sh -c evil #@github.com:ourorg/repo", perRun: true }],
      }),
    /repo url begins with "-", which git reads as an option/,
  );
  await assert.rejects(
    () =>
      narrowed.provision({
        name: "sb-dots",
        runId: "r",
        workflow: "w",
        repos: [{ slot: "target", url: "git@github.com:ourorg/../evil/repo", perRun: true }],
      }),
    /no git\.credentials entry matches "github\.com\/evil\/repo"/,
    "`..` resolves before the prefix is matched",
  );
  assert.deepEqual(calls, [], "nothing applied");

  // No entries at all → every per-run url is refused, and the message says the list is empty.
  const bare = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });
  await assert.rejects(
    () => bare.provision({ name: "sb", runId: "r", workflow: "w", repos: [{ ...app, perRun: true }] }),
    /entries: none/,
  );
});

test("a STATIC binding is admitted without a match; a matching entry — or the wildcard — admits a per-run one", async () => {
  // Code the instance typechecked and deployed is not run input: a bound url clones anonymously
  // (or with whatever its entry says) and the fence has nothing to say about it.
  const mk = async (credentials: Array<{ match: string; token?: string }>) => {
    const { exec, calls } = cluster();
    return { port: kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec, credentials }), calls };
  };
  const none = await mk([]);
  await none.port.provision({
    name: "sb",
    runId: "r",
    workflow: "w",
    repos: [{ slot: "app", url: "https://github.com/nobody/x.git", perRun: false }],
  });
  assert.ok(crOf(none.calls), "applied");

  const org = await mk([{ match: "github.com/ourorg/", token: "GH" }]);
  await org.port.provision({
    name: "sb",
    runId: "r",
    workflow: "w",
    repos: [{ slot: "t", url: "git@github.com:ourorg/app.git", perRun: true }],
  });
  assert.deepEqual(crOf(org.calls).spec.repos, [
    { key: repoKey("https://github.com/ourorg/app"), url: "git@github.com:ourorg/app.git" },
  ]);

  // The scaffold's `*` entry — today's implicit defaults made visible — admits everything.
  const any = await mk([{ match: "*" }]);
  await any.port.provision({
    name: "sb",
    runId: "r",
    workflow: "w",
    repos: [{ slot: "t", url: "https://gitlab.com/a/b.git", perRun: true }],
  });
  assert.ok(crOf(any.calls));
});

// --- the Repo resources and the operator's verdict on them (ADR-0051) -------------------------------

test("provision ENSURES every Repo's resource — per key, identity and boundness resolved — before the Secret and the CR", async () => {
  // The operator holds Ready until every key the CR names exists as a `Repo` resource, and
  // creating them is the provision's job: a per-run url's resource is born here, at its first
  // attach; a bound one is found as the boot stated it — ensured, never bound, so this run's
  // spelling does not rewrite the spec. Ordered after the image resolution (a refused image still
  // costs nothing) and before the token Secret (no Secret for a Sandbox whose Repo could not be
  // recorded).
  const { exec, calls } = cluster();
  const repos = fakeRepos();
  let ensuredBeforeSecret: boolean | undefined;
  repos.port.ensure = async (repo) => {
    repos.ensured.push(repo);
    ensuredBeforeSecret ??= calls.length === 0;
  };
  const port = kubeSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    repos: repos.port,
    ...exec,
    credentials: [{ match: "*" }],
  });
  await port.provision({
    name: "sb-ensure",
    runId: "r",
    workflow: "w",
    repos: [
      { slot: "app", url: "git@github.com:acme/app.git", perRun: false },
      { slot: "same", url: "https://github.com/acme/app", perRun: true },
      { slot: "ticket", url: "https://gitlab.com/x/y.git", perRun: true },
    ],
  });
  assert.deepEqual(repos.ensured, [
    // One resource per KEY, the first spelling's url; bound because a Machine's slot names it,
    // even though the run's slot names it too.
    {
      key: repoKey("git@github.com:acme/app.git"),
      url: "git@github.com:acme/app.git",
      identity: "github.com/acme/app",
      bound: true,
    },
    // The run's alone: unbound, on `jr2 gc`'s clock.
    {
      key: repoKey("https://gitlab.com/x/y.git"),
      url: "https://gitlab.com/x/y.git",
      identity: "gitlab.com/x/y",
      bound: false,
    },
  ]);
  assert.equal(ensuredBeforeSecret, true, "ensured before any write — the Secret and the CR come after");
});

test("a port with NO Repo-resource port refuses to provision, naming what would otherwise happen", async () => {
  // Without it the CR names keys no resource backs, and the operator parks the Sandbox on
  // `RepoMissing` for the whole Ready budget — a hang with a cause nobody printed.
  const { exec, calls } = cluster();
  const { repos: _omitted, ...rest } = provisionable;
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...rest, ...exec });
  await assert.rejects(
    () => port.provision({ name: "sb", runId: "r", workflow: "w", ...withApp }),
    (err: Error) => {
      assert.match(err.message, /no Repo-resource port/);
      assert.match(err.message, /kubeRepos/, "names the fix");
      assert.match(err.message, /ADR-0051/);
      return true;
    },
  );
  assert.deepEqual(calls, [], "nothing applied");
});

/** A Sandbox CR as the operator reports it while holding Ready on a Repo (sandbox_controller.go). */
const heldOn = (reason: string, message: string) => ({
  phase: "Pending",
  conditions: [{ type: "Ready", status: "False", reason, message }],
});

test("Ready held with reason RepoCloneFailed fails the provision BY NAME, not as a timeout", async () => {
  // ADR-0051: absence does not degrade — a clone that fails on a cold node fails that provision
  // pointedly, naming the repository and git's error. The operator's condition carries all three
  // (key, node, error); the port adds what the operator cannot know: the agent keeps retrying,
  // `jr2 status` shows the same line, and where the credential is configured.
  const { exec } = cluster([
    heldOn("RepoPending", `Repo "${APP_KEY}" is not on node kind-worker yet`),
    heldOn("RepoPending", `Repo "${APP_KEY}" is not on node kind-worker yet`),
    heldOn(
      "RepoCloneFailed",
      `Repo "${APP_KEY}" could not be cloned onto node kind-worker: fatal: Authentication failed`,
    ),
  ]);
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, readyTimeoutMs: 60_000, ...exec });
  await assert.rejects(
    () => port.provision({ name: "sb-clone", runId: "r", workflow: "w", ...withApp }),
    (err: Error) => {
      assert.match(err.message, /Sandbox "sb-clone" cannot start/);
      assert.match(
        err.message,
        new RegExp(`Repo "${APP_KEY}" could not be cloned onto node kind-worker: fatal: Authentication failed`),
      );
      assert.match(err.message, /git\.credentials/, "…and where the fix goes");
      assert.match(err.message, /jr2 status/, "…and where the same verdict is readable per node");
      assert.match(err.message, /ADR-0051/);
      assert.ok(!/never reached Ready/.test(err.message), "it replaces the timeout, it does not follow it");
      return true;
    },
  );
});

test("a Sandbox the operator holds on its Repos waits on the REPO budget, not the pod's", async () => {
  // ADR-0051: a Sandbox that lands on a cold node pays one clone there — the image-pull
  // economics — and a clone is not bounded by what a pod takes to come up. The operator holds
  // on a Repo reason only once the pod IS Ready, so from that poll on the wait is the Repo
  // budget's: the pod budget here is long gone before the cache lands, and the provision still
  // returns Ready.
  const pending = heldOn("RepoPending", `Repo "${APP_KEY}" is not on node kind-worker yet`);
  const { exec } = cluster([
    pending,
    { ...pending, conditions: [{ ...pending.conditions[0], message: "fetching" }] },
    READY,
  ]);
  const port = kubeSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    // The pod budget runs out between the first held event and the landing; the Repo budget holds.
    readyTimeoutMs: 1,
    repoTimeoutMs: 60_000,
    ...exec,
  });
  const out = await port.provision({ name: "sb-cold", runId: "r", workflow: "w", ...withApp });
  assert.equal(out.endpoint, "http://sb-1.default.svc:8080");
});

test("the Repo budget runs out BY NAME: the operator's verdict, the node, and where to look — never the preflight", async () => {
  // The pod came up, so the preflight passed; a timeout that pointed at the image would lie. The
  // operator's condition names the Repo and the node, and the port adds that the agent is still
  // at it, that `jr2 status` shows it per node, and that the budget is the port's own.
  const { exec } = cluster([heldOn("RepoPending", `Repo "${APP_KEY}" is not on node kind-worker yet`)]);
  const port = kubeSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    readyTimeoutMs: 60_000,
    repoTimeoutMs: 5,
    ...exec,
  });
  await assert.rejects(
    () => port.provision({ name: "sb-slow", runId: "r", workflow: "w", ...withApp }),
    (err: Error) => {
      assert.match(err.message, /Sandbox "sb-slow" waited \d+m for its Repos and the operator still holds it/);
      assert.match(err.message, new RegExp(`RepoPending: Repo "${APP_KEY}" is not on node kind-worker yet`));
      assert.match(err.message, /jr2 status/);
      assert.match(err.message, /repoTimeoutMs/);
      assert.match(err.message, /ADR-0051/);
      assert.ok(!/never reached Ready|preflight/.test(err.message), "the pod is up; the image is not the question");
      return true;
    },
  );
});

test("a pod that never comes up is still the POD budget's timeout, with the preflight hint", async () => {
  // The Repo budget applies only once the operator has held the Sandbox on a Repo reason, which
  // it reports after the pod is Ready. A placed pod stuck before that — PodNotReady, or no
  // condition at all — runs out the pod budget and gets the image hint, Repo budget untouched.
  const { exec } = cluster([heldOn("PodNotReady", "pod is not yet Ready")]);
  const port = kubeSandbox({
    imagesPath: await mkImages(REFS),
    ...provisionable,
    readyTimeoutMs: 5,
    repoTimeoutMs: 60_000,
    ...exec,
  });
  await assert.rejects(
    () => port.provision({ name: "sb-stuck", runId: "r", workflow: "w", ...withApp }),
    (err: Error) => {
      assert.match(err.message, /never reached Ready \(last phase: Pending\)/);
      assert.match(err.message, /check the preflight/);
      assert.match(err.message, /Ready condition says: PodNotReady: pod is not yet Ready/);
      // The budget starts once the pod is scheduled (ADR-0064), so the scheduler is never the answer.
      assert.doesNotMatch(err.message, /scheduler/);
      return true;
    },
  );
});

test("Ready with ReposFresh=False makes the attach STALE per slot, with git's own error; fresh → no stale", async () => {
  // Freshness degrades, absence does not (ADR-0051): the caches are there but the fetch since
  // this Sandbox asked failed, so the attach proceeds on the objects the node holds and says so.
  // The operator's clause names the KEY; the port keys it back to the slot the body knows.
  const infraUrl = "https://example.test/infra.git";
  const infraKey = repoKey(infraUrl);
  const staleReady = {
    phase: "Ready",
    endpoint: "http://sb-stale.default.svc:8080",
    conditions: [
      { type: "Ready", status: "True", reason: "PodReady" },
      {
        type: "ReposFresh",
        status: "False",
        reason: "FetchFailed",
        message: `Repo "${infraKey}" on node kind-worker is stale: fatal: unable to access 'https://example.test/infra.git/': Could not resolve host`,
      },
    ],
  };
  const { exec } = cluster([staleReady]);
  const port = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec });
  const slots = [
    { slot: "app", url: APP_URL, perRun: false },
    { slot: "infra", url: infraUrl, perRun: false },
  ];
  await port.provision({ name: "sb-stale", runId: "r", workflow: "w", repos: slots });
  const out = await port.attach({ name: "sb-stale", spec: { branch: "b" }, repos: slots });
  assert.deepEqual(out.stale, {
    infra: `Repo "${infraKey}" on node kind-worker is stale: fatal: unable to access 'https://example.test/infra.git/': Could not resolve host`,
  });
  assert.equal(out.repos.app, "/work/app/b", "the attach PROCEEDED — stale is a notice, not a refusal");

  // Fresh (the common case): no `stale` key at all, and a later fresh provision of the same name
  // forgets an earlier verdict.
  const fresh = {
    phase: "Ready",
    endpoint: "http://sb-stale.default.svc:8080",
    conditions: [{ type: "ReposFresh", status: "True", reason: "Fetched", message: "every Repo was fetched" }],
  };
  const { exec: e2 } = cluster([fresh]);
  const port2 = kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...e2 });
  await port2.provision({ name: "sb-stale", runId: "r", workflow: "w", repos: slots });
  assert.equal("stale" in (await port2.attach({ name: "sb-stale", spec: { branch: "b" }, repos: slots })), false);
});

// --- the attach (ADR-0004, ADR-0051, ADR-0063) ------------------------------------------------------

/** A Sandbox the operator already reports Ready, in the store before the port is built. */
function readySandbox(name: string, status: object = READY) {
  const c = cluster([]);
  c.api.seed("sandboxes", { metadata: { name, labels: { "jr2.dev/run": "r" } }, status } as never);
  return c;
}

test("attach is the Harness's POST /attach at the Sandbox's endpoint, with the Harness bearer (ADR-0058, ADR-0063)", async () => {
  const c = readySandbox("sb-3");
  const port = kubeSandbox({ ...provisionable, ...c.exec });
  const repos = [
    { slot: "app", url: APP_URL },
    { slot: "infra", url: "git@github.com:acme/infra.git", ref: "release/2" },
  ];
  const out = await port.attach({ name: "sb-3", spec: { branch: "feat/x", reviewSha: "abc123" }, repos });

  assert.equal(c.attaches.length, 1);
  const [call] = c.attaches;
  // The address is the Sandbox's own, off the watch; no `kubectl exec`, no stream through the API
  // server, no pod read.
  assert.equal(call!.url, "http://sb-1.default.svc:8080/attach");
  assert.equal(call!.auth, `Bearer ${harnessToken(provisionable.signingKey, "sb-3")}`, "the bearer for THIS pod");
  // The identity and cache key are resolved HERE, so the cache the Harness clones from is the one
  // the operator mounted — the Harness never re-derives them (ADR-0051).
  assert.deepEqual(call!.body, {
    slots: [
      { slot: "app", url: APP_URL, identity: "example.test/app", key: APP_KEY },
      {
        slot: "infra",
        url: "git@github.com:acme/infra.git",
        identity: "github.com/acme/infra",
        key: repoKey("git@github.com:acme/infra.git"),
        ref: "release/2",
      },
    ],
    branch: "feat/x",
    reviewSha: "abc123",
  });
  assert.deepEqual(out.repos, { app: "/work/app/feat-x", infra: "/work/infra/feat-x" }, "the Harness's paths");
  assert.deepEqual(c.api.writes, [], "the attach writes nothing to the cluster");
});

test("attach re-sends a request that never reached the Harness — Ready is not routable (ADR-0042)", async () => {
  const c = readySandbox("sb-r");
  let refusals = 2;
  const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
    if (refusals-- > 0) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    return c.exec.harnessFetch(input, init);
  }) as typeof fetch;
  const port = kubeSandbox({ ...provisionable, ...c.exec, harnessFetch: flaky });
  const out = await port.attach({ name: "sb-r", spec: { branch: "b" }, repos: [{ slot: "app", url: APP_URL }] });
  assert.deepEqual(out.repos, { app: "/work/app/b" });

  // A window that closes names the address it never reached.
  const never = kubeSandbox({
    ...provisionable,
    ...c.exec,
    attachWindowMs: 0,
    harnessFetch: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  await assert.rejects(
    () => never.attach({ name: "sb-r", spec: { branch: "b" }, repos: [{ slot: "app", url: APP_URL }] }),
    /never reached its Harness at http:\/\/sb-1\.default\.svc:8080/,
  );
});

test("a failed attach carries the Harness's own words — the slot, the step, git's stderr — and is not re-sent", async () => {
  const c = cluster([], () =>
    Response.json(
      {
        error: "slot \"app\": clone off the node cache failed: fatal: repository '/repos/x' does not exist",
        slot: "app",
      },
      { status: 500 },
    ),
  );
  c.api.seed("sandboxes", { metadata: { name: "sb-f", labels: { "jr2.dev/run": "r" } }, status: READY } as never);
  const port = kubeSandbox({ ...provisionable, ...c.exec });
  await assert.rejects(
    () => port.attach({ name: "sb-f", spec: { branch: "b" }, repos: [{ slot: "app", url: APP_URL }] }),
    /Sandbox "sb-f": the attach failed \(500\): slot "app": clone off the node cache failed: fatal: repository/,
  );
  assert.equal(c.attaches.length, 1, "an answer is an answer: only a request that never arrived is re-sent");
});

test("attach refuses a Sandbox with no endpoint, and an empty slot list", async () => {
  const c = cluster([]);
  const port = kubeSandbox({ ...provisionable, ...c.exec });
  await assert.rejects(
    () => port.attach({ name: "sb-none", spec: { branch: "b" }, repos: [{ slot: "app", url: APP_URL }] }),
    /no endpoint to attach through/,
  );
  const ready = readySandbox("sb-e");
  await assert.rejects(
    () => kubeSandbox({ ...provisionable, ...ready.exec }).attach({ name: "sb-e", spec: { branch: "b" }, repos: [] }),
    /names no Repo Slot/,
  );
});

// --- the Size (ADR-0060) ---------------------------------------------------------------------

test("the CR carries the whole Size: pod-level ceiling, per-container split, requests = limits (ADR-0060)", async () => {
  const { exec, calls } = cluster();
  await kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec }).provision({
    name: "sb-size",
    runId: "r",
    workflow: "w",
    resources: { limits: { memory: "3Gi", cpu: "2" } },
    ...withApp,
  });
  const spec = crOf(calls).spec;
  assert.deepEqual(spec.podResources, {
    requests: { cpu: "2", memory: "3Gi" },
    limits: { cpu: "2", memory: "3Gi" },
  });
  // The Harness container: the rest after the Custodian's slice, and the `/work` disk as a request
  // with no limit — a limit evicts the pod and loses `/work`.
  assert.deepEqual(spec.resources, {
    requests: { cpu: "1950m", memory: "3008Mi", "ephemeral-storage": "10Gi" },
    limits: { cpu: "1950m", memory: "3008Mi" },
  });
  const custodian = spec.sidecars.find((c: { name: string }) => c.name === "custodian");
  assert.deepEqual(custodian.resources, {
    requests: { cpu: "50m", memory: "64Mi" },
    limits: { cpu: "50m", memory: "64Mi" },
  });
  assert.deepEqual(spec.initContainers[0].resources, {
    requests: { cpu: "10m", memory: "32Mi" },
    limits: { memory: "128Mi" },
  });
  // `/dev/shm`: a quarter of the Harness share. The operator mounts it, in the Harness container
  // alone, so the CR composes no volume for it.
  assert.equal(spec.shmSize, "752Mi");
  assert.ok(!spec.volumes.some((v: { name: string }) => v.name === "shm"));
  // Priority: the class `jr2 up` creates, unless the Instance names its own.
  assert.equal(spec.priorityClassName, "jr2-sandbox");
});

test("the chain: a stated Size wins whole, the Instance default serves a Workspace that states none, the kit fills the rest (ADR-0060)", async () => {
  const run = async (resources: unknown, defaultSize?: unknown) => {
    const { exec, calls } = cluster();
    await kubeSandbox({
      imagesPath: await mkImages(REFS),
      ...provisionable,
      ...exec,
      ...(defaultSize ? { defaultSize: defaultSize as never } : {}),
      priorityClassName: "batch-low",
    }).provision({
      name: "sb-chain",
      runId: "r",
      workflow: "w",
      ...(resources ? { resources: resources as never } : {}),
      ...withApp,
    });
    return crOf(calls).spec;
  };
  const kit = await run(undefined);
  assert.deepEqual(kit.podResources.limits, { cpu: "1", memory: "2Gi" }, "the kit default: 2Gi, 1 cpu");
  assert.equal(kit.priorityClassName, "batch-low", "priorityClasses.sandbox names the class");
  const instance = await run(undefined, { limits: { memory: "4Gi", cpu: "2" } });
  assert.deepEqual(instance.podResources.limits, { cpu: "2", memory: "4Gi" });
  const stated = await run({ limits: { memory: "3Gi" } }, { limits: { memory: "4Gi", cpu: "2" } });
  assert.deepEqual(
    stated.podResources.limits,
    { cpu: "1", memory: "3Gi" },
    "a stated Size takes nothing from the Instance: the kit fills its unstated cpu",
  );
});

test("a stated User Container split lands on the user sidecar and comes out of the Harness share (ADR-0060)", async () => {
  const { exec, calls } = cluster();
  await kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec }).provision({
    name: "sb-split",
    runId: "r",
    workflow: "w",
    user: "ghcr.io/acme/sshd:1",
    userResources: { limits: { memory: "512Mi", cpu: "250m" } },
    ...withApp,
  });
  const spec = crOf(calls).spec;
  const user = spec.sidecars.find((c: { name: string }) => c.name === "user");
  assert.deepEqual(user.resources, {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "250m", memory: "512Mi" },
  });
  assert.deepEqual(spec.resources.limits, { cpu: "700m", memory: "1472Mi" });
});

test("a split below the Harness floor fails the provision by name, with NOTHING applied (ADR-0060)", async () => {
  const { exec, calls } = cluster();
  await assert.rejects(
    kubeSandbox({ imagesPath: await mkImages(REFS), ...provisionable, ...exec }).provision({
      name: "sb-tiny",
      runId: "r",
      workflow: "w",
      resources: { limits: { memory: "300Mi" } },
      ...withApp,
    }),
    /Sandbox "sb-tiny" cannot be provisioned: the Size leaves the Harness container .* below its 256Mi floor/,
  );
  assert.deepEqual(calls, [], "no Secret, no CR");
});
