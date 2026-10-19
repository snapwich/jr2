// Server-entrypoint tests (ADR-0019/0010): the process the Orchestrator Kit image runs, and the e2e tier's
// per-scenario fixture. `serverMain` is the testable core — the `bin/server.ts` shebang only wires
// process env/cwd/signals onto it. Driven in-process on an ephemeral port, like instance.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { serverMain } from "../src/server.ts";
import { repoIdentity } from "../src/repo-identity.ts";
import { kubeClient } from "../src/kube-client.ts";
import { fakeKube, type FakeCall, type FakeKube } from "./_fake-kube.ts";
import { packAssembly } from "../src/assembly-tar.ts";
import { KIT_VERSION } from "../src/config.ts";
import { assemblyHash } from "../src/content-hash.ts";
import { EMPTY_HELD, workspaceHeldPod } from "../src/held-secrets.ts";
import { kubeRepos } from "../src/repos.ts";
import { kubeSandbox } from "../src/sandbox-kube.ts";
import { watchSandboxes } from "../src/sandbox-watch.ts";
import { FIXTURE_ASSEMBLY, publishTree, scratchInstance } from "./_assembly.ts";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");

/** `serverMain` on `dir`, with the env every test here shares plus `env`. */
function boot(
  dir: string,
  env: Record<string, string> = {},
  more: { announce?: (line: string) => void; kube?: ReturnType<typeof kubeClient> } = {},
) {
  return serverMain({
    dir,
    env: { PORT: "0", HOST: "127.0.0.1", JR2_INSTANCE_TOKEN: "tok", JR2_SIGNING_KEY: KEY_B64, ...env },
    announce: more.announce ?? (() => {}),
    ...(more.kube ? { kube: more.kube } : {}),
  });
}

test("boots the instance from env and announces its address and its current Assembly as one JSON line", async () => {
  // The Workflows come through the door (ADR-0069): the first boot has none, a publish brings
  // `echo`, and the next boot serves it from `current`.
  const dir = await scratchInstance("server");
  const first = await boot(dir);
  const hash = await publishTree(first, dir, FIXTURE_ASSEMBLY);
  await first.close();

  const lines: string[] = [];
  const inst = await boot(dir, {}, { announce: (line) => lines.push(line) });
  try {
    // The announcement is the fixture's (and an operator's) discovery seam: parseable, first line.
    const parsed = JSON.parse(lines[0]!) as { url: string; workflows: string[]; assembly: string };
    assert.equal(parsed.url, inst.url);
    assert.deepEqual(parsed.workflows, ["echo"]);
    assert.equal(parsed.assembly, hash);

    // It serves, authenticated with the supplied token (the deployed Secret's credential).
    const res = await fetch(`${inst.url}/runs`, { headers: { authorization: "Bearer tok" } });
    assert.equal(res.status, 200);
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the announce line names the runs the boot did not resume and the Assemblies it collected, and no `waiting` (ADR-0030, ADR-0069)", async () => {
  // A run parked under A; B published; then the volume loses A. The boot restores the run inside
  // A, which is gone, so the run is drifted naming A. B, current, is kept, and a tree with no
  // record is collected.
  const dir = await scratchInstance("server-drift");
  const first = await boot(dir);
  const a = await publishTree(first, dir, {
    "workflows/task.ts":
      `import { setup } from "xstate";\n` +
      `export const machine = setup({}).createMachine({ id: "task", initial: "coding", states: { coding: {} } });\n`,
  });
  const { runId } = await first.host.start("task");
  const b = await publishTree(first, dir, FIXTURE_ASSEMBLY);
  await first.close();
  const store = join(dir, ".jr2", "assemblies");
  await rm(join(store, a), { recursive: true });
  await rm(join(store, `${a}.json`));
  await mkdir(join(store, "aaaaaaaaaaaa"), { recursive: true });

  const lines: string[] = [];
  const inst = await boot(dir, {}, { announce: (line) => lines.push(line) });
  try {
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.assembly, b);
    assert.deepEqual(parsed.drifted, [runId]);
    assert.deepEqual(parsed.collected, ["aaaaaaaaaaaa"]);
    assert.equal("waiting" in parsed, false);
    assert.match((await inst.host.read(runId))?.reason ?? "", new RegExp(`Assembly ${a} is not on the volume`));
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("JR2_SIGNING_KEY from env keeps the key out of the pod filesystem", async () => {
  // A dir with no `.jr2/secret`: with the env key supplied, none may be minted onto disk — the key
  // must live in the Secret so Sandbox tokens survive a pod restart (ADR-0013/0019).
  const dir = await mkdtemp(join(tmpdir(), "jr2-server-"));
  const inst = await serverMain({
    dir,
    env: { PORT: "0", HOST: "127.0.0.1", JR2_SIGNING_KEY: KEY_B64 },
    announce: () => {},
  });
  try {
    await assert.rejects(access(join(dir, ".jr2", "secret")), "signing key must not be written to disk");
  } finally {
    await inst.close();
  }
});

/** An Assembly tree whose one workflow is a `workspace()` — a registered Machine that composes
 * a Sandbox (ADR-0051). The body is trivial and no run needs to reach a cluster: what the process
 * decides off this Machine is the claim. Imported by absolute path: a temp folder resolves no bare
 * `@jr2/orchestrator`. */
async function mkWorkspaceAssembly(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-server-ws-"));
  await writeFile(join(dir, "jr2.config.ts"), `export default { name: "ws" };\n`);
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

/** The fake API server (ADR-0063) behind every data-plane port, answering as an empty namespace
 * would — so no test here reaches a real cluster — and the client the boot is handed over it. */
function fakeCluster(): { api: FakeKube; kube: ReturnType<typeof kubeClient> } {
  const api = fakeKube();
  return { api, kube: kubeClient({ baseUrl: "https://kube.test", fetch: api.fetch, token: async () => api.token }) };
}

/** The first recorded call matching `want` — the boot's Repo pass runs after serving, unawaited. */
async function until(api: FakeKube, want: (call: FakeCall) => boolean): Promise<FakeCall> {
  for (let i = 0; i < 200; i++) {
    const hit = api.calls.find(want);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the boot never made the call");
}

/** Boot an empty deployed instance on `kube`, then publish `src` (ADR-0069): the Repo pass and the
 * Sandbox watch follow the publish. */
async function bootPublished(
  src: string,
  kube: ReturnType<typeof kubeClient>,
  announce: (line: string) => void = () => {},
  env: Record<string, string> = { JR2_NAMESPACE: "ws" },
) {
  const dir = await mkdtemp(join(tmpdir(), "jr2-server-inst-"));
  const inst = await boot(dir, env, { announce, kube });
  await publishTree(inst, dir, src);
  return { inst, dir };
}

/** The announce lines after the first — the Repo lines arrive after serving. */
async function announcedRepos(lines: string[], count: number): Promise<Array<Record<string, unknown>>> {
  for (let i = 0; i < 200 && lines.length < 1 + count; i++) await new Promise((r) => setTimeout(r, 10));
  return lines.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("a published Machine composing a Sandbox + JR2_NAMESPACE → the data plane serves it (ADR-0051)", async () => {
  // Deployed (JR2_NAMESPACE set), the cluster backend is built and the instance reports a data
  // plane. The blast pattern ADR-0038 chose still holds: no image map is mounted here, and the
  // process serves anyway — only a provision would fail.
  const src = await mkWorkspaceAssembly();
  const { api, kube } = fakeCluster();
  const { inst, dir } = await bootPublished(src, kube);
  try {
    const repos = (await (await fetch(`${inst.url}/repos`, authed)).json()) as { dataPlane: boolean; repos: unknown[] };
    assert.equal(repos.dataPlane, true);
    // …and the Repos are READ THROUGH to the cluster, per request (ADR-0048/0051): whatever it
    // holds — the boot's own bind may already have landed.
    assert.ok(Array.isArray(repos.repos));
    assert.ok(
      api.calls.some(
        (c) => c.method === "GET" && c.target === "repos" && c.namespace === "ws" && !c.query.labelSelector,
      ),
      "GET /repos asked the namespace's Repo resources",
    );
    // The one watch is up once the Assembly composes a Sandbox (ADR-0063).
    await until(api, (c) => c.target === "sandboxes" && c.query.watch === "true" && c.namespace === "ws");
    // And the pod's route out is wired to the same cluster (ADR-0053): the ask reads the Sandbox
    // first, to see whether the pod mounts the Repo at all. There is none, so it is refused —
    // what matters here is that the port is THERE.
    const ask = await fetch(`${inst.url}/sandboxes/sb-1/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: JSON.stringify({ identity: "github.com/acme/app" }),
    });
    assert.equal(ask.status, 404);
    assert.ok(
      api.calls.some((c) => c.method === "GET" && c.target === "sandboxes/sb-1" && c.namespace === "ws"),
      "the ask read the Sandbox in the namespace",
    );
  } finally {
    await inst.close();
    for (const d of [dir, src]) await rm(d, { recursive: true, force: true });
  }
});

test("the boot creates one bound Repo resource per identity its Machines bind, and announces each (ADR-0051)", async () => {
  // "The Orchestrator creates Repo CRs; it does not sync them": statically known repositories are
  // known (probed) before a run can ask. After serving, never awaited — one line per Repo in ADR-0048's
  // shape, so a human tailing pod logs sees what the cluster was told.
  const src = await mkWorkspaceAssembly();
  const lines: string[] = [];
  const { api, kube } = fakeCluster();
  const { inst, dir } = await bootPublished(src, kube, (line) => lines.push(line));
  try {
    const { key, identity } = repoIdentity("https://example.test/app.git");
    assert.deepEqual(await announcedRepos(lines, 1), [{ repo: key, url: "https://example.test/app.git", bound: true }]);
    const create = api.calls.find((c) => c.method === "POST" && c.target === "repos")!;
    assert.ok(create, "a create of the resource");
    assert.equal(create.namespace, "ws", "in the instance's namespace");
    // The label `jr2 gc` honors, then the reconcile that drops it from what nothing binds any more.
    const reconcile = await until(api, (c) => c.target === "repos" && c.query.labelSelector === "jr2.dev/bound=true");
    assert.ok(
      api.calls.indexOf(create) < api.calls.indexOf(reconcile),
      "ensure first, then reconcile — a resource this boot binds is never unlabeled",
    );
    assert.equal(identity, "example.test/app");
  } finally {
    await inst.close();
    for (const d of [dir, src]) await rm(d, { recursive: true, force: true });
  }
});

test("a boot finding its bound Repo already there RESTATES the Machine's spec — the boot is the one writer (ADR-0051)", async () => {
  // A redeploy: the resource stands from the last boot. The boot binds — one merge patch carrying
  // the walk's url — where a provision would only move the clock; so a url or credential moved in
  // jr2.config.ts reaches the cache at the next `jr2 up`, and never from a run.
  const src = await mkWorkspaceAssembly();
  const lines: string[] = [];
  const { api, kube } = fakeCluster();
  const { key } = repoIdentity("https://example.test/app.git");
  api.seed("repos", { metadata: { name: key }, spec: { url: "https://old.example/app.git" } } as never);
  const { inst, dir } = await bootPublished(src, kube, (line) => lines.push(line));
  try {
    assert.deepEqual(await announcedRepos(lines, 1), [{ repo: key, url: "https://example.test/app.git", bound: true }]);
    const patch = api.calls.find((c) => c.method === "PATCH" && c.target === `repos/${key}`);
    assert.ok(patch, "the boot patched the existing resource");
    const body = patch!.body as { spec?: { url?: string }; metadata?: { labels?: unknown } };
    assert.equal(body.spec?.url, "https://example.test/app.git");
    assert.deepEqual(body.metadata?.labels, { "jr2.dev/bound": "true" });
  } finally {
    await inst.close();
    for (const d of [dir, src]) await rm(d, { recursive: true, force: true });
  }
});

test("a Repo the cluster refuses is announced as an error, and the process serves regardless (ADR-0048)", async () => {
  const src = await mkWorkspaceAssembly();
  const lines: string[] = [];
  const { api, kube } = fakeCluster();
  api.refuse((c) =>
    c.method === "POST" && c.target === "repos"
      ? api.status(403, "Forbidden", "repos.core.jr2.dev is forbidden")
      : undefined,
  );
  const { inst, dir } = await bootPublished(src, kube, (line) => lines.push(line));
  try {
    const [line] = await announcedRepos(lines, 1);
    assert.equal(line!.repo, repoIdentity("https://example.test/app.git").key);
    assert.match(String(line!.error), /Forbidden/);
    assert.equal(line!.bound, undefined);
    // Serving is not conditional on the cluster: the instance answers, data plane and all.
    const repos = (await (await fetch(`${inst.url}/repos`, authed)).json()) as { dataPlane: boolean };
    assert.equal(repos.dataPlane, true);
  } finally {
    await inst.close();
    for (const d of [dir, src]) await rm(d, { recursive: true, force: true });
  }
});

test("the same Machine with NO namespace → no port, and a workspace() run faults 'no Sandbox backend'", async () => {
  // A Workspace is always a real Sandbox (ADR-0012): a host-booted process has no cluster to drive,
  // so the switch stays off and the run says exactly why — durably, on the run, naming `jr2 up`.
  const src = await mkWorkspaceAssembly();
  const dir = await mkdtemp(join(tmpdir(), "jr2-server-inst-"));
  const inst = await boot(dir);
  try {
    await publishTree(inst, dir, src);
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
    assert.match(final?.fault ?? "", /JR2_NAMESPACE unset/);
    assert.match(final?.fault ?? "", /`jr2 up`/);
  } finally {
    await inst.close();
    for (const d of [dir, src]) await rm(d, { recursive: true, force: true });
  }
});

test("deployed, the data plane is wired even when no registered Machine composes a Sandbox (ADR-0069)", async () => {
  // A publish can bring the first `workspace()`, so the boot no longer decides from the walk.
  // Wiring a client is free: nothing is dialed for Sandboxes until a port first asks, and the
  // Sandbox watch stays unstarted on a cluster that may have no operator.
  const { api, kube } = fakeCluster();
  const dir = await scratchInstance("server");
  const inst = await boot(dir, { JR2_NAMESPACE: "echo" }, { kube });
  try {
    await publishTree(inst, dir, FIXTURE_ASSEMBLY);
    const repos = (await (await fetch(`${inst.url}/repos`, authed)).json()) as { dataPlane: boolean; repos: unknown[] };
    assert.equal(repos.dataPlane, true);
    assert.ok(
      api.calls.some(
        (c) => c.method === "GET" && c.target === "repos" && c.namespace === "echo" && !c.query.labelSelector,
      ),
      "GET /repos read the namespace's Repo resources through",
    );
    assert.deepEqual(
      api.calls.filter((c) => c.target === "sandboxes"),
      [],
      "no Sandbox watch on a process whose Assembly composes no Sandbox",
    );
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deployed on a cluster with no Repo kind, GET /repos answers no Repos, not a 500 (ADR-0069)", async () => {
  // The data plane is wired on every deployed boot, so `GET /repos` asks the cluster even where
  // `operator.manage: false` left no operator, and `jr2 status` reads it.
  const { api, kube } = fakeCluster();
  api.refuse((c) =>
    c.target === "repos" ? api.status(404, "NotFound", "the server could not find the requested resource") : undefined,
  );
  const dir = await mkdtemp(join(tmpdir(), "jr2-server-inst-"));
  const inst = await boot(dir, { JR2_NAMESPACE: "echo" }, { kube });
  try {
    const res = await fetch(`${inst.url}/repos`, authed);
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { dataPlane: true, repos: [] });
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an Instance that stopped composing a Sandbox unlabels the Repos its last deploy bound (ADR-0051)", async () => {
  // The last `workspace()` dropped from the Machines: nothing binds the Repos the previous deploys
  // labeled, and no cache agent is converged for them any more (`jr2 up` deletes the DaemonSet).
  // The publish still reconciles, because the bound label is `jr2 gc`'s only "keep this" — left
  // on, the resources are uncollectable forever and nothing ever evicts the node caches behind them.
  const { api, kube } = fakeCluster();
  api.seed("repos", { metadata: { name: "app-11111111", labels: { "jr2.dev/bound": "true" } } });
  const dir = await scratchInstance("server");
  const inst = await boot(dir, { JR2_NAMESPACE: "echo" }, { kube });
  try {
    // A boot with no current Assembly runs no Repo pass: an empty walk there is "unknown", and an
    // unlabel would let `jr2 gc` evict every Repo until the publish.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(
      api.calls.filter((c) => c.target.startsWith("repos")),
      [],
      "no Repo pass before the first publish",
    );
    await publishTree(inst, dir, FIXTURE_ASSEMBLY);
    const unlabel = await until(api, (c) => c.method === "PATCH");
    assert.equal(unlabel.target, "repos/app-11111111");
    assert.deepEqual(
      unlabel.body,
      { metadata: { labels: { "jr2.dev/bound": null } } },
      "a merge patch's null removes it",
    );
    assert.equal(unlabel.namespace, "echo", "in the instance's namespace");
    // The walk binds nothing, so the reconcile is the whole pass: no resource is created or stated.
    assert.deepEqual(
      api.calls.filter((c) => c.method === "POST"),
      [],
    );
    assert.equal(api.calls.filter((c) => c.method === "PATCH").length, 1);
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Repo passes run in series: a publish's pass never finishes before the boot's (ADR-0051, ADR-0069)", async () => {
  // A boot pass for Assembly A, held up at the cluster, then a publish of B that binds no Repo.
  // Run side by side, A's late reconcile would restate what B stopped binding. In series, B's
  // reconcile runs last and has the last word.
  const src = await mkWorkspaceAssembly();
  const dir = await mkdtemp(join(tmpdir(), "jr2-server-inst-"));
  {
    const first = await boot(dir);
    await publishTree(first, dir, src);
    await first.close();
  }
  const { api, kube } = fakeCluster();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const realFetch = api.fetch;
  let holding = true;
  const slow: typeof api.fetch = async (input, init) => {
    if (holding && String(input).includes("/repos")) await held;
    return realFetch(input, init);
  };
  const slowKube = kubeClient({ baseUrl: "https://kube.test", fetch: slow, token: async () => api.token });
  const lines: string[] = [];
  const inst = await boot(dir, { JR2_NAMESPACE: "ws" }, { kube: slowKube, announce: (l) => lines.push(l) });
  try {
    const empty = await mkdtemp(join(tmpdir(), "jr2-server-empty-"));
    await writeFile(join(empty, "jr2.config.ts"), `export default { name: "ws" };\n`);
    await publishTree(inst, dir, empty);
    holding = false;
    release();
    // The last reconcile is B's: it keeps nothing, so the boot's bound Repo is unlabeled last.
    const { key } = repoIdentity("https://example.test/app.git");
    const unlabel = await until(api, (c) => c.method === "PATCH" && c.target === `repos/${key}` && !c.body?.spec);
    const bind = api.calls.find((c) => c.method === "POST" && c.target === "repos");
    assert.ok(bind, "the boot's pass bound the Repo");
    assert.ok(api.calls.indexOf(bind!) < api.calls.indexOf(unlabel), "the publish's pass ran after the boot's");
    await rm(empty, { recursive: true, force: true });
  } finally {
    release();
    await inst.close();
    for (const d of [dir, src]) await rm(d, { recursive: true, force: true });
  }
});

test("a provision on a cluster with no operator fails naming the fix, at the first Repo write (ADR-0069)", async () => {
  // The data plane is always wired, but the operator serves the Repo and Sandbox kinds. With no
  // operator, the API server answers 404 on the first create of either, and a Workspace that names
  // a Repo reaches the Repo create first. The real Repo port is used, so this is that write.
  const { api, kube } = fakeCluster();
  const missing = () => api.status(404, "NotFound", "the server could not find the requested resource");
  api.refuse((c) =>
    (c.method === "POST" && c.target === "repos") ||
    (c.target.startsWith("sandboxes/") && c.contentType === "application/apply-patch+yaml")
      ? missing()
      : undefined,
  );
  const scratch = await mkdtemp(join(tmpdir(), "jr2-server-noop-"));
  const imagesPath = join(scratch, "images.json");
  await writeFile(imagesPath, JSON.stringify({ harness: "jr2-harness:h", custodian: "envoy:c", sandbox: {} }));
  await writeFile(
    join(scratch, `held-${workspaceHeldPod({ workflow: "w", route: [] })}.json`),
    JSON.stringify(EMPTY_HELD),
  );
  const watch = watchSandboxes(kube, { namespace: "ws", backoffMs: 5, log: () => {} });
  const repos = kubeRepos({
    namespace: "ws",
    credentials: () => [],
    cloneSecrets: async () => new Set(),
    client: kube,
  });
  const port = kubeSandbox({
    watch,
    imagesPath,
    heldDir: scratch,
    signingKey: Buffer.from("k"),
    namespace: "ws",
    client: kube,
    repos,
  });
  const req = (repos: unknown[]) => ({ name: "sb-1", runId: "run-1", workflow: "w", route: [], repos }) as never;
  const pointed =
    /no operator on this cluster — install it, or remove `operator\.manage: false` so `jr2 up` deploys it/;
  try {
    await assert.rejects(
      port.place(req([{ slot: "app", url: "https://example.test/app.git", perRun: false }]), { onWait: () => {} }),
      (err: Error) => {
        assert.match(err.message, pointed);
        assert.match(err.message, /the Repo kind/);
        return true;
      },
    );
    // A Workspace with no Repo reaches the Sandbox create, and says the same.
    await assert.rejects(port.place(req([]), { onWait: () => {} }), (err: Error) => {
      assert.match(err.message, pointed);
      assert.match(err.message, /the Sandbox kind/);
      return true;
    });
  } finally {
    watch.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

/** An Assembly whose one Workflow binds its Repo Slot PER RUN, so the provision checks the url
 * against `git.credentials`, the fence (ADR-0051). `credentials` goes into its `jr2.config.ts`. */
async function mkFencedAssembly(
  credentials: Array<{ match: string }>,
  opts: { waitMs?: number; bound?: boolean } = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-server-fence-"));
  await writeFile(
    join(dir, "jr2.config.ts"),
    `export default ${JSON.stringify({ name: "ws", git: { credentials } })};\n`,
  );
  await mkdir(join(dir, "workflows"), { recursive: true });
  const src = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts")).href;
  await writeFile(
    join(dir, "workflows", "ws.ts"),
    `import { setup } from ${JSON.stringify(import.meta.resolve("xstate"))};\n` +
      `import { workspace } from ${JSON.stringify(src)};\n` +
      `const body = setup({}).createMachine({ id: "body", initial: "done", states: { done: { type: "final" } } });\n` +
      // With `bound`, the Slot is bound statically instead, so the Repo pass binds it (ADR-0051).
      `const ws = workspace(body, { repos: { app: ${opts.bound ? "" : "() => "}"https://example.test/app.git" }, spec: () => ({ branch: "b" }) });\n` +
      // With `waitMs`, the run parks before its Workspace for that long: a timer the restore arms
      // again, so a run saved in one process provisions in the next.
      (opts.waitMs === undefined
        ? `export const machine = ws;\n`
        : `export const machine = setup({ actors: { ws } }).createMachine({ id: "ws", initial: "wait", states: { ` +
          `wait: { after: { ${opts.waitMs}: "work" } }, work: { invoke: { src: "ws" } } } });\n`),
  );
  return dir;
}

/** Start a `ws` run and wait for its fault. */
async function faultOf(url: string): Promise<string> {
  const started = (await (
    await fetch(`${url}/workflows/ws/runs`, {
      method: "POST",
      headers: { ...authed.headers, "content-type": "application/json" },
      body: "{}",
    })
  ).json()) as { runId: string };
  return faultOfRun(url, started.runId);
}

/** Wait for run `runId`'s fault. */
async function faultOfRun(url: string, runId: string): Promise<string> {
  let final: { status: string; fault?: string } | undefined;
  for (let i = 0; i < 400 && final?.status !== "error"; i++) {
    await new Promise((r) => setTimeout(r, 10));
    final = (await (await fetch(`${url}/runs/${runId}`, authed)).json()) as typeof final;
  }
  assert.equal(final?.status, "error");
  return final?.fault ?? "";
}

/** A publish over the HTTP door, as `jr2 up` makes it. */
async function putAssembly(url: string, src: string): Promise<void> {
  const res = await fetch(`${url}/assembly`, {
    method: "PUT",
    headers: {
      authorization: "Bearer pub",
      "content-type": "application/x-tar",
      "jr2-kit-version": KIT_VERSION,
      "jr2-assembly-hash": await assemblyHash(src),
    },
    body: new Uint8Array(await packAssembly(src)),
  });
  assert.equal(res.status, 200, await res.clone().text());
}

/** Boot a deployed instance on `dir` with the fenced Assembly `src` published, start one run that
 * parks before its Workspace, and close: the next boot on `dir` restores the run under `src`. */
async function parkedUnder(
  src: string,
  then?: (url: string) => Promise<void>,
): Promise<{ dir: string; runId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-server-held-"));
  const env = { JR2_NAMESPACE: "ws", JR2_PUBLISH_TOKEN: "pub" };
  const first = await boot(dir, env, { kube: fakeCluster().kube });
  await publishTree(first, dir, src);
  const { runId } = await first.host.start("ws");
  // Saved before the close, or the next boot has nothing to restore.
  const saved = () => {
    const db = new DatabaseSync(join(dir, ".jr2", "state.db"));
    try {
      return db.prepare("SELECT 1 FROM machine_snapshots WHERE run_id = ?").get(runId) !== undefined;
    } finally {
      db.close();
    }
  };
  for (let i = 0; i < 200 && !saved(); i++) await new Promise((r) => setTimeout(r, 5));
  await then?.(first.url);
  // A process exit stops no actors; in one test process the restart is simulated by `stop`.
  await first.host.stop(runId);
  await first.close();
  return { dir, runId };
}

test("after a publish, a provision reads the NEW Assembly's config: the fence moves (ADR-0069)", async () => {
  // Publish an Assembly whose config admits no per-run url: the provision refuses it at the fence.
  // Publish an Assembly whose config admits it: the next provision passes the fence and fails
  // later, at the image map no test mounts. The ports read the config through a getter, so no
  // port was rebuilt and no pod rolled. The second publish crosses the HTTP door, as `jr2 up` does.
  const fenced = await mkFencedAssembly([]);
  const { kube } = fakeCluster();
  const { inst, dir } = await bootPublished(fenced, kube, () => {}, { JR2_NAMESPACE: "ws", JR2_PUBLISH_TOKEN: "pub" });
  const next = await mkFencedAssembly([{ match: "example.test/" }]);
  try {
    assert.equal(inst.publishToken, "pub");
    assert.match(await faultOf(inst.url), /refuses the per-run repo/);

    await putAssembly(inst.url, next);

    const fault = await faultOf(inst.url);
    assert.doesNotMatch(fault, /refuses the per-run repo/);
    assert.match(fault, /no image map/);
  } finally {
    await inst.close();
    for (const d of [dir, fenced, next]) await rm(d, { recursive: true, force: true });
  }
});

test("a run restored under a held Assembly provisions under the CURRENT config: the fence it started under is gone (ADR-0069)", async () => {
  // R starts under A, whose config admits no per-run url, and parks before its Workspace. B, which
  // admits it, is published; then the process restarts. R restores inside A (its Machine), and
  // its provision reads B's config (D3): it passes the fence and fails later, at the image map.
  const fenced = await mkFencedAssembly([], { waitMs: 800 });
  const open = await mkFencedAssembly([{ match: "example.test/" }]);
  const { dir, runId } = await parkedUnder(fenced, (url) => putAssembly(url, open));
  const inst = await boot(dir, { JR2_NAMESPACE: "ws", JR2_PUBLISH_TOKEN: "pub" }, { kube: fakeCluster().kube });
  try {
    assert.deepEqual(inst.restored.reattached, [runId]);
    assert.equal(inst.host.status(runId)?.assembly, await assemblyHash(fenced), "R is under A");
    const fault = await faultOfRun(inst.url, runId);
    assert.doesNotMatch(fault, /refuses the per-run repo/);
    assert.match(fault, /no image map/);
  } finally {
    await inst.close();
    for (const d of [dir, fenced, open]) await rm(d, { recursive: true, force: true });
  }
});

test("with no current Assembly, a held run waits, the read routes answer and `/agents/*` answers 503; the publish restores it inside its Assembly, and it provisions under the published config (ADR-0026, ADR-0069)", async () => {
  // The pointer names a tree that is gone, so no config is bound. R waits: no restore, no
  // provision. `jr2 status` reads `GET /repos` and `GET /assembly` in this window, and both answer,
  // and so does R's feed. A waiting Turn is not over, so the Agents' surface answers 503 (ask
  // again), never 404 (ADR-0026).
  // The publish of B, whose config admits the per-run url A's refused, restores R inside A (its
  // Machine), and R provisions under B's config (D3): it passes the fence and fails later, at the
  // image map no test mounts.
  const fenced = await mkFencedAssembly([], { waitMs: 800 });
  const open = await mkFencedAssembly([{ match: "example.test/" }]);
  const { dir, runId } = await parkedUnder(fenced);
  await writeFile(join(dir, ".jr2", "assemblies", "current"), "0123456789ab\n");
  const lines: string[] = [];
  const env = { JR2_NAMESPACE: "ws", JR2_PUBLISH_TOKEN: "pub" };
  const inst = await boot(dir, env, { kube: fakeCluster().kube, announce: (l) => lines.push(l) });
  try {
    const announced = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(announced.assembly, null);
    assert.deepEqual(announced.waiting, [runId]);
    assert.equal("drifted" in announced, false);
    assert.deepEqual(inst.restored.reattached, []);
    assert.equal(inst.host.status(runId), undefined, "not re-attached: no run runs in the window");

    const repos = await fetch(`${inst.url}/repos`, authed);
    assert.equal(repos.status, 200, await repos.clone().text());
    const view = await fetch(`${inst.url}/assembly`);
    assert.equal(view.status, 200, await view.clone().text());
    const a = await assemblyHash(fenced);
    assert.deepEqual(((await view.json()) as { held: unknown }).held, [
      { hash: a, kitVersion: KIT_VERSION, runs: [runId] },
    ]);
    assert.equal((await fetch(`${inst.url}/healthz`)).status, 200);
    const feed = await fetch(`${inst.url}/runs/${runId}/events`, authed);
    assert.equal(feed.status, 200);
    assert.match(await feed.text(), /event: status/, "the feed reads R from its row");

    // The Agents' surface: a waiting run's registration is not here yet, and that is not "over".
    const agents = async () => [
      (await fetch(`${inst.url}/agents/some-iid/surface`, authed)).status,
      (
        await fetch(`${inst.url}/agents/some-iid/events`, {
          method: "POST",
          headers: { ...authed.headers, "content-type": "application/json" },
          body: JSON.stringify({ type: "done" }),
        })
      ).status,
      (await fetch(`${inst.url}/agents/some-iid/deliveries/d1`, authed)).status,
    ];
    assert.deepEqual(await agents(), [503, 503, 503], "not restored yet: ask again");

    await putAssembly(inst.url, open);
    assert.deepEqual(await agents(), [404, 404, 404], "restored: an iid no run holds is over");
    assert.equal(inst.host.status(runId)?.assembly, a, "R is under A");
    const fault = await faultOfRun(inst.url, runId);
    assert.doesNotMatch(fault, /refuses the per-run repo/);
    assert.doesNotMatch(fault, /no current Assembly/);
    assert.match(fault, /no image map/);
    assert.equal(lines.length, 1, "every run resumed, so the deferred restore announces nothing");
  } finally {
    await inst.close();
    for (const d of [dir, fenced, open]) await rm(d, { recursive: true, force: true });
  }
});

test("the restore a publish runs announces the runs it did not resume, naming the Assembly it landed (ADR-0030, ADR-0069)", async () => {
  // The Kit bump window: A, current, names the old Kit version. The boot leaves R waiting; the
  // publish restores R inside A, which this Kit version cannot load, so R drifts then.
  const dir = await scratchInstance("server-deferred");
  const first = await boot(dir);
  const a = await publishTree(first, dir, {
    "workflows/task.ts":
      `import { setup } from "xstate";\n` +
      `export const machine = setup({}).createMachine({ id: "task", initial: "coding", states: { coding: {} } });\n`,
  });
  const { runId } = await first.host.start("task");
  await first.close();
  const record = join(dir, ".jr2", "assemblies", `${a}.json`);
  await writeFile(record, JSON.stringify({ ...JSON.parse(await readFile(record, "utf8")), kitVersion: "0.0.0-old" }));

  const lines: string[] = [];
  const inst = await boot(dir, {}, { announce: (line) => lines.push(line) });
  try {
    const announced = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(announced.assembly, null);
    assert.deepEqual(announced.waiting, [runId]);
    const b = await publishTree(inst, dir, FIXTURE_ASSEMBLY);
    assert.deepEqual(
      lines.slice(1).map((l) => JSON.parse(l) as unknown),
      [{ assembly: b, drifted: [runId] }],
    );
    assert.match(
      (await inst.host.read(runId))?.reason ?? "",
      new RegExp(`Assembly ${a} was published for Kit version 0\\.0\\.0-old`),
    );
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the Repo pass binds the Repos of every held Assembly, not the current one's alone (ADR-0051, ADR-0069)", async () => {
  // A binds a Repo statically, and R parks under A before its Workspace; B binds none. The publish
  // of B binds A's Repo again, because R holds A, and the reconcile never unlabels it.
  const a = await mkFencedAssembly([], { waitMs: 60_000, bound: true });
  const b = await mkdtemp(join(tmpdir(), "jr2-server-none-"));
  await mkdir(join(b, "workflows"), { recursive: true });
  await writeFile(
    join(b, "workflows", "plain.ts"),
    `import { setup } from ${JSON.stringify(import.meta.resolve("xstate"))};\n` +
      `export const machine = setup({}).createMachine({ id: "plain", initial: "a", states: { a: {} } });\n`,
  );
  const lines: string[] = [];
  const { api, kube } = fakeCluster();
  const { inst, dir } = await bootPublished(a, kube, (l) => lines.push(l), {
    JR2_NAMESPACE: "ws",
    JR2_PUBLISH_TOKEN: "pub",
  });
  const { key } = repoIdentity("https://example.test/app.git");
  const { runId } = await inst.host.start("ws");
  try {
    await putAssembly(inst.url, b);
    const repos = await announcedRepos(lines, 2);
    assert.deepEqual(
      repos.filter((l) => l.repo === key),
      [
        { repo: key, url: "https://example.test/app.git", bound: true },
        { repo: key, url: "https://example.test/app.git", bound: true },
      ],
      "bound by A's publish, and again by B's while R holds A",
    );
    await new Promise((r) => setTimeout(r, 100));
    const unlabels = api.calls.filter(
      (c) =>
        c.method === "PATCH" &&
        JSON.stringify(c.body) === JSON.stringify({ metadata: { labels: { "jr2.dev/bound": null } } }),
    );
    assert.deepEqual(unlabels, [], "the held Repo is never unlabeled");
  } finally {
    await inst.host.stop(runId);
    await inst.close();
    for (const d of [dir, a, b]) await rm(d, { recursive: true, force: true });
  }
});
