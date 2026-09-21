// `jr2 version` (ADR-0009 as amended): what is HERE and what is DEPLOYED, side by side, as a report
// — never a refusal. These tests read the report as DATA (`versionReport`) and check the rendering
// only where a line is the claim: the ADR-0056 mismatch that every other verb throws on is a line
// here, the skew verdict names the `jr2 up` consequence, and the halves degrade independently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render, version, versionReport, type VersionReport } from "../src/commands/version.ts";
import { HANDOFF_ENV } from "../src/handoff.ts";
import { CLI_ROOT, CLI_VERSION } from "../src/kit-version.ts";
import type { KubeAdmin, KubeObject, KubePort } from "../src/kube.ts";
import type { Io } from "../src/output.ts";
import { fakeKit, linkKit } from "./_kit.ts";
import { mkHarness } from "./_fixtures.ts";

type Captured = { io: Io; out: () => string; err: () => string };

function mkIo(over: Partial<Io>): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, cwd: "/", ...over };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

async function mkInstance(name = "inst"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jr2-version-"));
  await writeFile(join(root, "jr2.config.ts"), `export default { name: ${JSON.stringify(name)} };\n`);
  await writeFile(join(root, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module" }));
  return root;
}

/** A cluster hosting (or not) the Instance: the Secret says deployed, the objects say what. */
function fakeCluster(opts: {
  deployed: boolean;
  unreachable?: boolean;
  objects?: Record<string, Partial<KubeObject>>;
  healthz?: unknown;
}): { kube: KubePort; admin: KubeAdmin; fetch: Io["fetch"]; closed: () => boolean } {
  let closed = false;
  const store = new Map(Object.entries(opts.objects ?? {}));
  const kube: KubePort = {
    currentContext: async () => "kind-test",
    readSecret: async () => {
      if (opts.unreachable) throw new Error("dial tcp: connection refused");
      return opts.deployed ? "tok" : undefined;
    },
    portForward: async () => ({ url: "http://fwd", close: () => (closed = true) }),
  };
  const admin = {
    context: async () => "kind-test",
    getJson: async <T = KubeObject>(o: { kind: string; name: string; namespace?: string }) =>
      store.get(`${o.namespace ?? ""}/${o.kind}/${o.name}`) as T | undefined,
  } as unknown as KubeAdmin;
  const fetch: Io["fetch"] = (url) =>
    url.endsWith("/healthz") && opts.healthz !== undefined
      ? Promise.resolve(Response.json(opts.healthz))
      : Promise.reject(new Error(`unexpected fetch ${url}`));
  return { kube, admin, fetch, closed: () => closed };
}

test("outside an Instance: the copy that runs, node, and no half to deploy against", async () => {
  const { io, out, err } = mkIo({ cwd: "/" });
  assert.equal(await version(["--json"], io), 0);
  const r = JSON.parse(out().trim()) as VersionReport;
  assert.deepEqual(r.cli, { version: CLI_VERSION, path: CLI_ROOT });
  assert.equal(r.global, undefined, "no handoff happened");
  assert.equal(r.node, process.version);
  assert.equal(r.instance, undefined);
  assert.equal(r.kit, undefined);
  assert.equal(r.deployed, undefined, "no Instance and no --url: nothing to address, and no kube is touched");
  assert.equal(r.skew, "unknown");
  assert.equal(err(), "", "nothing was addressed, so no target line");
  assert.match(render(r), /^instance:\s+none — no jr2\.config\.ts/m);
});

test("the global that handed off is a line, from the one env var (ADR-0056 as amended)", async () => {
  const { io } = mkIo({ cwd: "/", env: { [HANDOFF_ENV]: "0.1.1 /opt/homebrew/lib/node_modules/@jr2/cli" } });
  const r = await versionReport(io, {}, { local: true });
  assert.deepEqual(r.global, { version: "0.1.1", path: "/opt/homebrew/lib/node_modules/@jr2/cli" });
  const table = render(r);
  assert.match(table, /^cli:\s+\S+\s+\S+$/m);
  assert.match(table, /^global:\s+0\.1\.1\s+\/opt\/homebrew\/lib\/node_modules\/@jr2\/cli$/m);
});

test("inside an Instance that resolves this checkout's kit: kit ok, installed mode, no cluster with --local", async () => {
  const root = await mkInstance("my-proj");
  try {
    await linkKit(root);
    const { io, err } = mkIo({ cwd: join(root), kitDir: root });
    const r = await versionReport(io, {}, { local: true });
    assert.equal(r.kit?.check, "ok");
    assert.equal(r.kit?.version, CLI_VERSION, "the Instance's Kit version is the orchestrator it resolves");
    assert.equal(r.kit?.pinned, undefined, "no pin line when the manifest has none to disagree");
    assert.equal(r.kit?.against, undefined);
    assert.equal(r.instance?.name, "my-proj", "the config names the Instance");
    assert.equal(r.instance?.root, root);
    assert.equal(r.instance?.mode, "installed", "kitDir at the Instance: no kit checkout above it");
    assert.equal(r.instance?.kitRegistry, "ghcr.io/snapwich", "installed mode names where Kit images come from");
    assert.equal(r.deployed, undefined, "--local skips the cluster");
    assert.equal(err(), "", "and prints no target");
    assert.match(render(r), new RegExp(`^kit:\\s+${CLI_VERSION.replace(/\\./g, "\\\\.")}\\s+\\S+\\s+ok$`, "m"));
    assert.match(render(r), /^instance:\s+my-proj\s+\S+\s+\(installed kit → ghcr\.io\/snapwich\)$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Kit mismatch is a LINE naming both copies — never the refusal every other Instance verb throws", async () => {
  const root = await mkInstance();
  try {
    await fakeKit(root, "@jr2/orchestrator", "9.9.9");
    const { io, out } = mkIo({ cwd: root, kitDir: root });
    assert.equal(await version(["--local"], io), 0, "exit 0: a report");
    assert.match(out(), /^kit:\s+9\.9\.9\s+\S+\s+MISMATCH — this jr2 runs against \S+ \(\S+\)$/m);
    const r = await versionReport(io, {}, { local: true });
    assert.equal(r.kit?.check, "mismatch");
    assert.equal(r.kit?.version, "9.9.9");
    assert.equal(r.kit?.against?.version, CLI_VERSION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pin that disagrees with what resolves is the 'edited the line, never reinstalled' diagnosis", async () => {
  const root = await mkInstance();
  try {
    await fakeKit(root, "@jr2/orchestrator", "9.9.9");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "inst",
        version: "0.0.0",
        type: "module",
        dependencies: { "@jr2/orchestrator": "9.9.10" },
      }),
    );
    const { io } = mkIo({ cwd: root, kitDir: root });
    const r = await versionReport(io, {}, { local: true });
    assert.equal(r.kit?.pinned, "9.9.10");
    assert.match(render(r), /package\.json pins 9\.9\.10 — reinstall/);

    // Nothing installed at all: the pin is the only fact there is.
    await rm(join(root, "node_modules"), { recursive: true, force: true });
    const bare = await versionReport(io, {}, { local: true });
    assert.equal(bare.kit?.check, "unresolved");
    assert.match(render(bare), /^kit:\s+not installed; package\.json pins 9\.9\.10 — reinstall$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a config that will not load is a line, not a stop", async () => {
  const root = await mkInstance();
  try {
    await writeFile(join(root, "jr2.config.ts"), "throw new Error('boom');\n");
    const { io } = mkIo({ cwd: root, kitDir: root });
    const r = await versionReport(io, {}, { local: true });
    assert.match(r.instance?.configError ?? "", /boom/);
    assert.equal(r.instance?.name, root.split("/").pop(), "the folder names the Instance when the config cannot");
    assert.match(render(r), /^config:\s+failed to load — .*boom/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--url / JR2_URL: the orchestrator line from /healthz alone, and the skew verdict against the Instance's kit", async () => {
  const { app } = await mkHarness();
  const fetch: Io["fetch"] = (url, init) => Promise.resolve(app.request(url, init));

  // Outside an Instance there is no local kit line, so the verdict is unknown even with a live answer.
  const loose = mkIo({ cwd: "/", env: { JR2_URL: "http://test" }, fetch });
  const r1 = await versionReport(loose.io, {}, { local: false });
  assert.deepEqual(r1.deployed?.url, "http://test");
  assert.equal((r1.deployed?.orchestrator as { version?: string }).version, CLI_VERSION);
  assert.equal(r1.skew, "unknown");
  assert.equal(loose.err(), "→ http://test\n", "the target line, as every run verb prints it");

  // Inside one that resolves the same kit: same.
  const root = await mkInstance();
  try {
    await linkKit(root);
    const same = mkIo({ cwd: root, kitDir: root, fetch });
    const r2 = await versionReport(same.io, { url: "http://test" }, { local: false });
    assert.equal(r2.skew, "same");
    assert.doesNotMatch(render(r2), /^skew:/m, "installed mode, same number: nothing to say");

    // An orchestrator that predates the kit: behind, and the way out is `jr2 up`.
    const old = mkIo({
      cwd: root,
      kitDir: root,
      fetch: () => Promise.resolve(Response.json({ ok: true, version: "0.0.1", hash: "abc-arm64" })),
    });
    const r3 = await versionReport(old.io, { url: "http://old" }, { local: false });
    assert.equal(r3.skew, "behind");
    assert.match(render(r3), /^orchestrator:\s+0\.0\.1\s+hash abc-arm64$/m);
    assert.match(
      render(r3),
      new RegExp(
        `^skew:\\s+deployed 0\\.0\\.1 predates this kit ${CLI_VERSION.replace(/\\./g, "\\\\.")} — \`jr2 up\` converges it$`,
        "m",
      ),
    );

    // Newer than the kit: ahead, and `jr2 up` would be a rollback.
    const newer = mkIo({
      cwd: root,
      kitDir: root,
      fetch: () => Promise.resolve(Response.json({ ok: true, version: "99.0.0" })),
    });
    const r4 = await versionReport(newer.io, { url: "http://new" }, { local: false });
    assert.equal(r4.skew, "ahead");
    assert.match(render(r4), /would roll the orchestrator back; the operator is never downgraded/);

    // Unreachable: the reason is the line, and exit stays 0.
    const dead = mkIo({ cwd: root, kitDir: root, fetch: () => Promise.reject(new Error("ECONNREFUSED")) });
    assert.equal(await version(["--url", "http://dead"], dead.io), 0);
    assert.match(dead.out(), /^orchestrator:\s+unreachable — ECONNREFUSED$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the kube path: not deployed, unreachable, and deployed — each a line, the port-forward closed", async () => {
  const root = await mkInstance("proj");
  try {
    await linkKit(root);

    const absent = fakeCluster({ deployed: false });
    const a = mkIo({ cwd: root, kitDir: root, kube: absent.kube, kubeAdmin: absent.admin, fetch: absent.fetch });
    const ra = await versionReport(a.io, {}, { local: false });
    assert.equal(ra.deployed?.context, "kind-test");
    assert.equal(ra.deployed?.namespace, "proj", "the config's name is the namespace");
    assert.match((ra.deployed?.orchestrator as { error: string }).error, /not deployed in proj \(context kind-test\)/);
    assert.equal(a.err(), "→ context kind-test / namespace proj\n");

    const dead = fakeCluster({ deployed: true, unreachable: true });
    const d = mkIo({ cwd: root, kitDir: root, kube: dead.kube, kubeAdmin: dead.admin, fetch: dead.fetch });
    const rd = await versionReport(d.io, { namespace: "other" }, { local: false });
    assert.equal(rd.deployed?.namespace, "other", "-n overrides the config's name");
    assert.match(
      (rd.deployed?.orchestrator as { error: string }).error,
      /cannot reach the cluster — context kind-test/,
    );

    const live = fakeCluster({
      deployed: true,
      healthz: { ok: true, version: "0.0.1", hash: "h1-arm64" },
      objects: {
        "proj/deployment/jr2-orchestrator": {
          metadata: { name: "jr2-orchestrator", labels: { "jr2.dev/content-hash": "h2-arm64" } },
          spec: { template: { spec: { containers: [{ image: "jr2-instance-proj:h2-arm64" }] } } },
        },
        "jr2-system/deployment/jr2-controller-manager": {
          metadata: { name: "jr2-controller-manager", labels: { "jr2.dev/version": "0.0.2" } },
          spec: { template: { spec: { containers: [{ image: "ghcr.io/snapwich/jr2-operator:0.0.2" }] } } },
        },
        "proj/configmap/jr2-images": {
          metadata: { name: "jr2-images" },
          data: {
            "images.json": JSON.stringify({
              harness: "ghcr.io/snapwich/jr2-harness:0.0.1",
              adapter: "ghcr.io/snapwich/jr2-adapter:0.0.1",
              sandbox: { default: "jr2-sandbox-proj-default:abc-arm64" },
            }),
          },
        },
      },
    });
    const l = mkIo({ cwd: root, kitDir: root, kube: live.kube, kubeAdmin: live.admin, fetch: live.fetch });
    assert.equal(await version([], l.io), 0);
    assert.ok(live.closed(), "the port-forward lives only as long as the probe");
    const table = l.out();
    assert.match(
      table,
      /^orchestrator:\s+0\.0\.1\s+hash h1-arm64\s+\(rollout incomplete: deployment records h2-arm64\)\s+jr2-instance-proj:h2-arm64$/m,
      "the pod's own account first; the Deployment's disagreeing record is flagged",
    );
    assert.match(table, /^operator:\s+0\.0\.2\s+ghcr\.io\/snapwich\/jr2-operator:0\.0\.2$/m);
    assert.match(table, /^harness:\s+ghcr\.io\/snapwich\/jr2-harness:0\.0\.1$/m);
    assert.match(table, /^adapter:\s+ghcr\.io\/snapwich\/jr2-adapter:0\.0\.1$/m);
    assert.match(table, /^sandbox default:\s+jr2-sandbox-proj-default:abc-arm64$/m);
    assert.match(table, /^skew:\s+deployed 0\.0\.1 predates this kit/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkout mode says so, and a same-version verdict there points at the hash", async () => {
  const root = await mkInstance();
  try {
    await linkKit(root);
    // `kitDir` unset → detection walks up from the CLI's own module, which IS this checkout.
    const { io } = mkIo({
      cwd: root,
      fetch: () => Promise.resolve(Response.json({ ok: true, version: CLI_VERSION, hash: "abc-arm64" })),
    });
    const r = await versionReport(io, { url: "http://test" }, { local: false });
    assert.equal(r.instance?.mode, "checkout");
    assert.ok(r.instance?.kitCheckout, "the checkout root is named");
    assert.equal(r.instance?.kitRegistry, undefined, "a checkout builds; it pulls from nowhere");
    assert.equal(r.skew, "same");
    assert.match(render(r), /^instance:.*\(kit checkout at \S+\)$/m);
    assert.match(render(r), /^skew:\s+same version; checkout builds are content-addressed/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
