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
import { repoIdentity } from "../src/repo-identity.ts";
import type { KubectlExec } from "../src/sandbox-kubectl.ts";

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

/** A kubectl that records what the boot asked of the cluster and answers as an empty namespace
 * would — the seam behind both data-plane ports, so no test here reaches a real cluster. */
function fakeKubectl(fail?: (args: string[]) => string | undefined) {
  const calls: string[][] = [];
  const exec: KubectlExec = async (args) => {
    calls.push(args);
    const refusal = fail?.(args);
    if (refusal) throw new Error(refusal);
    if (args[0] === "get") return { stdout: JSON.stringify({ items: [] }), stderr: "" };
    return { stdout: "ok", stderr: "" };
  };
  return { exec, calls };
}

/** The first recorded call matching `want` — the boot's Repo pass runs after serving, unawaited. */
async function until(calls: string[][], want: (args: string[]) => boolean): Promise<string[]> {
  for (let i = 0; i < 200; i++) {
    const hit = calls.find(want);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the boot never made the call");
}

/** The announce lines after the first — the boot's Repo lines arrive after serving. */
async function announcedRepos(lines: string[], count: number): Promise<Array<Record<string, unknown>>> {
  for (let i = 0; i < 200 && lines.length < 1 + count; i++) await new Promise((r) => setTimeout(r, 10));
  return lines.slice(1).map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("a registered Machine composing a Sandbox + J2_NAMESPACE → the data plane is wired (ADR-0051)", async () => {
  // The switch is read off the WALK, not off config: nothing in j2.config.ts says "this instance
  // has Workspaces". Deployed (J2_NAMESPACE set), the kubectl backend is built and the instance
  // reports a data plane. The blast pattern ADR-0038 chose still holds: no image map is mounted
  // here, and the boot serves anyway — only a provision would fail.
  const dir = await mkWorkspaceInstance();
  const kubectl = fakeKubectl();
  const inst = await serverMain({
    dir,
    env: { PORT: "0", HOST: "127.0.0.1", J2_INSTANCE_TOKEN: "tok", J2_SIGNING_KEY: KEY_B64, J2_NAMESPACE: "ws" },
    announce: () => {},
    exec: kubectl.exec,
  });
  try {
    const repos = (await (await fetch(`${inst.url}/repos`, authed)).json()) as { dataPlane: boolean; repos: unknown[] };
    assert.equal(repos.dataPlane, true);
    // …and the Repos are READ THROUGH to the cluster, per request (ADR-0048/0051).
    assert.deepEqual(repos.repos, []);
    assert.ok(
      kubectl.calls.some((a) => a[0] === "get" && a[1] === "repos.core.j2.dev" && a.includes("ws")),
      "GET /repos asked the namespace's Repo resources",
    );
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the boot creates one bound Repo resource per identity its Machines bind, and announces each (ADR-0051)", async () => {
  // "The Orchestrator creates Repo CRs; it does not sync them": statically known repositories are
  // warm before a run can ask. After serving, never awaited — one line per Repo in ADR-0048's
  // shape, so a human tailing pod logs sees what the cluster was told.
  const dir = await mkWorkspaceInstance();
  const lines: string[] = [];
  const kubectl = fakeKubectl();
  const inst = await serverMain({
    dir,
    env: { PORT: "0", HOST: "127.0.0.1", J2_INSTANCE_TOKEN: "tok", J2_SIGNING_KEY: KEY_B64, J2_NAMESPACE: "ws" },
    announce: (line) => lines.push(line),
    exec: kubectl.exec,
  });
  try {
    const { key, identity } = repoIdentity("https://example.test/app.git");
    assert.deepEqual(await announcedRepos(lines, 1), [{ repo: key, url: "https://example.test/app.git", bound: true }]);
    const create = kubectl.calls.find((a) => a[0] === "create")!;
    assert.ok(create, "kubectl create of the resource");
    assert.ok(create.includes("--namespace") && create.includes("ws"), "in the instance's namespace");
    // The label `j2 gc` honors, then the reconcile that drops it from what nothing binds any more.
    const reconcile = kubectl.calls.find(
      (a) => a[0] === "get" && a[1] === "repos.core.j2.dev" && a.includes("j2.dev/bound=true"),
    );
    assert.ok(reconcile, "reconcileBound read the bound resources");
    assert.ok(
      kubectl.calls.indexOf(create) < kubectl.calls.indexOf(reconcile!),
      "ensure first, then reconcile — a resource this boot binds is never unlabeled",
    );
    assert.equal(identity, "example.test/app");
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a boot finding its bound Repo already there RESTATES the Machine's spec — the boot is the one writer (ADR-0051)", async () => {
  // A redeploy: the resource stands from the last boot. The boot binds — one merge patch carrying
  // the walk's url — where a provision would only move the clock; so a url or credential moved in
  // j2.config.ts reaches the cache at the next `j2 up`, and never from a run.
  const dir = await mkWorkspaceInstance();
  const lines: string[] = [];
  const kubectl = fakeKubectl((args) =>
    args[0] === "create" ? "Error from server (AlreadyExists): repos.core.j2.dev already exists" : undefined,
  );
  const inst = await serverMain({
    dir,
    env: { PORT: "0", HOST: "127.0.0.1", J2_INSTANCE_TOKEN: "tok", J2_SIGNING_KEY: KEY_B64, J2_NAMESPACE: "ws" },
    announce: (line) => lines.push(line),
    exec: kubectl.exec,
  });
  try {
    const { key } = repoIdentity("https://example.test/app.git");
    assert.deepEqual(await announcedRepos(lines, 1), [{ repo: key, url: "https://example.test/app.git", bound: true }]);
    const patch = kubectl.calls.find((a) => a[0] === "patch" && a[1] === "repos.core.j2.dev" && a[2] === key);
    assert.ok(patch, "the boot patched the existing resource");
    const body = JSON.parse(patch!.at(-1)!) as { spec?: { url?: string }; metadata?: { labels?: unknown } };
    assert.equal(body.spec?.url, "https://example.test/app.git");
    assert.deepEqual(body.metadata?.labels, { "j2.dev/bound": "true" });
  } finally {
    await inst.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Repo the cluster refuses is announced as an error, and the process serves regardless (ADR-0048)", async () => {
  const dir = await mkWorkspaceInstance();
  const lines: string[] = [];
  const kubectl = fakeKubectl((args) =>
    args[0] === "create" ? "Error from server (Forbidden): repos.core.j2.dev is forbidden" : undefined,
  );
  const inst = await serverMain({
    dir,
    env: { PORT: "0", HOST: "127.0.0.1", J2_INSTANCE_TOKEN: "tok", J2_SIGNING_KEY: KEY_B64, J2_NAMESPACE: "ws" },
    announce: (line) => lines.push(line),
    exec: kubectl.exec,
  });
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
  const kubectl = fakeKubectl();
  const inst = await serverMain({
    dir: fixtureDir,
    env: { PORT: "0", HOST: "127.0.0.1", J2_INSTANCE_TOKEN: "tok", J2_SIGNING_KEY: KEY_B64, J2_NAMESPACE: "echo" },
    announce: () => {},
    exec: kubectl.exec,
  });
  try {
    const repos = (await (await fetch(`${inst.url}/repos`, authed)).json()) as { dataPlane: boolean; repos: unknown[] };
    assert.deepEqual(repos, { dataPlane: false, repos: [] });
    // …and `GET /repos` answered that WITHOUT reading the cluster: no data plane, no read-through.
    assert.deepEqual(
      kubectl.calls.filter((a) => a[0] === "get" && !a.includes("j2.dev/bound=true")),
      [],
    );
  } finally {
    await inst.close();
  }
});

test("an Instance that stopped composing a Sandbox unlabels the Repos its last deploy bound (ADR-0051)", async () => {
  // The last `workspace()` dropped from the Machines: nothing binds the Repos the previous deploys
  // labeled, and no cache agent is converged for them any more (`j2 up` deletes the DaemonSet).
  // The boot still reconciles, because the bound label is `j2 gc`'s only "keep this" — left on,
  // the resources are uncollectable forever and nothing ever evicts the node caches behind them.
  const bound = { items: [{ metadata: { name: "app-11111111", labels: { "j2.dev/bound": "true" } } }] };
  const kubectl = fakeKubectl();
  const exec: KubectlExec = async (args, opts) =>
    args[0] === "get" && args.includes("j2.dev/bound=true")
      ? { stdout: JSON.stringify(bound), stderr: "" }
      : kubectl.exec(args, opts);
  const inst = await serverMain({
    dir: fixtureDir,
    env: { PORT: "0", HOST: "127.0.0.1", J2_INSTANCE_TOKEN: "tok", J2_SIGNING_KEY: KEY_B64, J2_NAMESPACE: "echo" },
    announce: () => {},
    exec,
  });
  try {
    const label = await until(kubectl.calls, (a) => a[0] === "label");
    assert.deepEqual(label.slice(0, 3), ["label", "repos.core.j2.dev", "app-11111111"]);
    assert.ok(label.includes("j2.dev/bound-"), "kubectl's spelling for removing the label");
    assert.ok(label.includes("--namespace") && label.includes("echo"), "in the instance's namespace");
    // The walk binds nothing, so the reconcile is the whole pass: no resource is created or stated.
    assert.deepEqual(
      kubectl.calls.filter((a) => a[0] === "create" || a[0] === "patch"),
      [],
    );
  } finally {
    await inst.close();
  }
});
