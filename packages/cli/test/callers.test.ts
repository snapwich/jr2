// The CLI's half of the Callers (ADR-0078): the kube user it says it acts for, the header that
// carries it, `jr2 whoami`, `jr2 caller token|rotate` over a fake cluster, the objects `jr2 up`
// writes for the named tokens, and the `started by:` walk of `jr2 status`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { JR2Client, type RunStatus } from "../src/client.ts";
import { cancelledByActivity, startedByActivity } from "../src/commands/status.ts";
import { callerDigestsJson, callerTokenObjects, CALLER_TOKEN_KEY, LABEL_CALLER_TOKEN } from "../src/deploy.ts";
import { planCallerTokens } from "../src/caller-tokens.ts";
import { resolveTarget } from "../src/instance.ts";
import type { KubeAdmin, KubeObject, KubePort } from "../src/kube.ts";
import type { Io } from "../src/output.ts";
import { linkKit } from "./_kit.ts";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

async function mkInstance(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jr2-cli-callers-"));
  await writeFile(join(root, "jr2.config.ts"), `export default { name: "myinst" };\n`);
  await linkKit(root);
  return root;
}

function mkIo(over: Partial<Io>): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, cwd: "/", out, err, ...over };
}

/** A kube port of a cluster that hosts the instance, whose user is `user`. */
function kubeAs(user: string | undefined, secrets: Record<string, string> = {}): KubePort {
  return {
    currentContext: async () => "kind-test",
    readSecret: async ({ name, key }) => secrets[`${name}/${key}`] ?? (name === "jr2-instance" ? "tok" : undefined),
    portForward: async () => ({ url: "http://fwd.test", close: () => {} }),
    selfSubject: async () => user,
  };
}

/** A fake cluster for the admin verbs: the Secrets by name, and what was applied. */
class SecretCluster {
  secrets = new Map<string, KubeObject & { data?: Record<string, string> }>();
  applied: Array<Record<string, any>> = [];
  context = async () => "kind-test";
  put(name: string, value: string): void {
    this.secrets.set(name, {
      metadata: { name: `jr2-caller-${name}`, labels: { [LABEL_CALLER_TOKEN]: name } },
      data: { [CALLER_TOKEN_KEY]: Buffer.from(value).toString("base64") },
    });
  }
  listJson = async <T>(opts: { kind: string; selector?: string }): Promise<T[]> => {
    assert.equal(opts.kind, "secret");
    assert.equal(opts.selector, LABEL_CALLER_TOKEN);
    return [...this.secrets.values()] as T[];
  };
  apply = async (opts: { manifest: string }): Promise<void> => {
    const doc = JSON.parse(opts.manifest) as Record<string, any>;
    this.applied.push(doc);
    const name = doc.metadata.labels[LABEL_CALLER_TOKEN] as string | undefined;
    if (name) this.put(name, doc.stringData[CALLER_TOKEN_KEY]);
  };
  get admin(): KubeAdmin {
    return this as unknown as KubeAdmin;
  }
}

// --- the kube user, and the header that carries it --------------------------------------------

test("on a kube context the target carries the kube user as onBehalfOf; with --url it carries none", async () => {
  const root = await mkInstance();
  try {
    const kube = await resolveTarget(mkIo({ cwd: root, kube: kubeAs("kubernetes-admin") }), {});
    assert.equal(kube.onBehalfOf, "kubernetes-admin");
    const url = await resolveTarget(mkIo({ env: { JR2_URL: "http://x", JR2_TOKEN: "jr2c_x" } }), {});
    assert.equal(url.onBehalfOf, undefined);
    assert.equal(url.token, "jr2c_x");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a kube user the server does not give, or that a header cannot carry, is no claim; a long one is cut", async () => {
  const root = await mkInstance();
  try {
    for (const [user, want] of [
      [undefined, undefined],
      ["ünïcode", undefined],
      ["x".repeat(300), "x".repeat(256)],
    ] as const) {
      const target = await resolveTarget(mkIo({ cwd: root, kube: kubeAs(user) }), {});
      assert.equal(target.onBehalfOf, want);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the client sends jr2-on-behalf-of beside the bearer, and never without one", async () => {
  const seen: Array<Record<string, string>> = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return Response.json({ runs: [] });
  };
  await new JR2Client("http://o", fetch, "tok", "alice").runs();
  await new JR2Client("http://o", fetch, undefined, "alice").runs();
  assert.equal(seen[0]!["jr2-on-behalf-of"], "alice");
  assert.equal(seen[0]!.authorization, "Bearer tok");
  assert.equal(seen[1]!["jr2-on-behalf-of"], undefined);
});

test("jr2 whoami prints GET /whoami's Caller as the result, sent on behalf of the kube user", async () => {
  const root = await mkInstance();
  try {
    let asked: Record<string, string> = {};
    const io = mkIo({
      cwd: root,
      kube: kubeAs("kubernetes-admin"),
      fetch: async (url, init) => {
        assert.equal(url, "http://fwd.test/whoami");
        asked = Object.fromEntries(new Headers(init?.headers).entries());
        return Response.json({
          via: "token",
          name: "instance",
          may: { read: "all" },
          onBehalfOf: asked["jr2-on-behalf-of"],
        });
      },
    });
    assert.equal(await main(["whoami"], io), 0);
    assert.equal(asked.authorization, "Bearer tok");
    assert.deepEqual(JSON.parse(io.out.join("")), {
      via: "token",
      name: "instance",
      may: { read: "all" },
      onBehalfOf: "kubernetes-admin",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- jr2 caller token | rotate ------------------------------------------------------------------

test("jr2 caller token prints the value alone on stdout, read from its Secret", async () => {
  const root = await mkInstance();
  try {
    const io = mkIo({ cwd: root, kube: kubeAs(undefined, { "jr2-caller-ci/token": "jr2c_abc" }) });
    assert.equal(await main(["caller", "token", "ci"], io), 0);
    assert.deepEqual(io.out, ["jr2c_abc\n"]);

    const missing = mkIo({ cwd: root, kube: kubeAs(undefined) });
    assert.equal(await main(["caller", "token", "nope"], missing), 1);
    assert.match(missing.err.join(""), /no Caller token "nope" here .*callers\.tokens.*jr2 up/);
    assert.deepEqual(missing.out, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("jr2 caller with no subcommand or no name is a usage error", async () => {
  const root = await mkInstance();
  try {
    assert.equal(await main(["caller"], mkIo({ cwd: root })), 2);
    assert.equal(await main(["caller", "token"], mkIo({ cwd: root })), 2);
    assert.equal(await main(["caller", "rotate"], mkIo({ cwd: root })), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("jr2 caller rotate writes a new value, then the digests of every token, and prints no value", async () => {
  const root = await mkInstance();
  try {
    const cluster = new SecretCluster();
    cluster.put("ci", "jr2c_old");
    cluster.put("bridge", "jr2c_bridge");
    const io = mkIo({ cwd: root, kubeAdmin: cluster.admin });
    assert.equal(await main(["caller", "rotate", "ci"], io), 0);
    assert.deepEqual(io.out, [], "rotate prints no value");

    const [value, digests] = cluster.applied;
    assert.equal(value!.metadata.name, "jr2-caller-ci", "the value goes first");
    assert.equal(value!.metadata.namespace, "myinst");
    assert.equal(value!.metadata.labels["jr2.dev/instance"], "myinst");
    const fresh = value!.stringData.token as string;
    assert.match(fresh, /^jr2c_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(fresh, "jr2c_old");
    assert.equal(digests!.metadata.name, "jr2-caller-digests");
    assert.deepEqual(JSON.parse(digests!.stringData["digests.json"]), {
      bridge: sha256("jr2c_bridge"),
      ci: sha256(fresh),
    });
    assert.match(io.err.join(""), /rotated — the old value stops working .* about a minute/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("jr2 caller rotate refuses a name with no token Secret, and writes nothing", async () => {
  const root = await mkInstance();
  try {
    const cluster = new SecretCluster();
    cluster.put("ci", "jr2c_old");
    const io = mkIo({ cwd: root, kubeAdmin: cluster.admin });
    assert.equal(await main(["caller", "rotate", "nope"], io), 1);
    assert.match(io.err.join(""), /no Caller token "nope" in namespace "myinst" .*\(tokens here: ci\)/);
    assert.deepEqual(cluster.applied, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- what jr2 up writes ---------------------------------------------------------------------------

test("planCallerTokens keeps a stored value, makes one for a new name, and names the undeclared", async () => {
  const cluster = new SecretCluster();
  cluster.put("ci", "jr2c_kept");
  cluster.put("gone", "jr2c_gone");
  const plan = await planCallerTokens(cluster.admin, ["ci", "bridge"], "myinst", {});
  assert.equal(plan.values.ci, "jr2c_kept");
  assert.match(plan.values.bridge!, /^jr2c_/);
  assert.deepEqual(plan.made, ["bridge"]);
  assert.deepEqual(plan.undeclared, ["gone"]);
});

test("the token objects: one Secret per value, and the digests Secret holds sha-256 hex and no value", () => {
  const meta = (name: string, extra: Record<string, string> = {}) => ({ name, labels: extra });
  const objects = callerTokenObjects({ ci: "jr2c_a", bridge: "jr2c_b" }, meta) as Array<Record<string, any>>;
  assert.deepEqual(
    objects.map((o) => o.metadata.name),
    ["jr2-caller-bridge", "jr2-caller-ci", "jr2-caller-digests"],
  );
  assert.equal(objects[1]!.stringData.token, "jr2c_a");
  assert.equal(objects[1]!.metadata.labels[LABEL_CALLER_TOKEN], "ci");
  const digests = objects[2]!.stringData["digests.json"] as string;
  assert.equal(digests, callerDigestsJson({ ci: "jr2c_a", bridge: "jr2c_b" }));
  assert.deepEqual(JSON.parse(digests), { bridge: sha256("jr2c_b"), ci: sha256("jr2c_a") });
  assert.doesNotMatch(digests, /jr2c_/);
  // With no token, the digests Secret is still written, empty, so the mount always has it.
  assert.deepEqual(
    (callerTokenObjects({}, meta) as Array<Record<string, any>>).map((o) => [o.metadata.name, o.stringData]),
    [["jr2-caller-digests", { "digests.json": "{}" }]],
  );
});

// --- jr2 status: who started the run --------------------------------------------------------------

test("started by: a Caller is named with the name shown and its claim", async () => {
  const none = { read: async () => assert.fail("no read for a run a Caller started") };
  assert.equal(
    await startedByActivity(none, {
      startedBy: { kind: "caller", via: "jwt", name: "u-1", shown: "a@x.io", onBehalfOf: "alice" },
    }),
    "started by: jwt/u-1 (a@x.io) on behalf of alice",
  );
  assert.equal(await startedByActivity(none, { startedBy: { kind: "jr2", why: "boot" } }), "started by: jr2 (boot)");
  assert.equal(await startedByActivity(none, {}), undefined);
  assert.equal(cancelledByActivity({ cancelledBy: { via: "token", name: "ci" } }), "cancelled by: token/ci");
});

test("started by: a dispatched run is walked up its chain to the first Caller, naming the runs between", async () => {
  const runs: Record<string, Partial<RunStatus>> = {
    parent: { startedBy: { kind: "run", run: "root", slot: "fan" } },
    root: { startedBy: { kind: "caller", via: "token", name: "instance", onBehalfOf: "kubernetes-admin" } },
  };
  const read = async (id: string) => runs[id] as RunStatus | undefined;
  assert.equal(
    await startedByActivity({ read }, { startedBy: { kind: "run", run: "parent", slot: "child" } }),
    "started by: token/instance on behalf of kubernetes-admin, through run parent (child) ← run root (fan)",
  );
  // A run of the chain that is gone, or that the Caller may not read, ends the walk and says so.
  assert.equal(
    await startedByActivity({ read }, { startedBy: { kind: "run", run: "gone", slot: "s" } }),
    "started by: not known — run gone (s) is no longer known",
  );
  const refused = async () => {
    throw new Error('the Caller token/ci needs the "read" scope for Workflow "deploy"');
  };
  assert.match(
    (await startedByActivity({ read: refused }, { startedBy: { kind: "run", run: "p", slot: "s" } }))!,
    /^started by: not read — run p \(s\): the Caller token\/ci needs the "read" scope/,
  );
});

test("started by: a chain that loops is cut, never walked without end", async () => {
  const read = async () => ({ startedBy: { kind: "run", run: "loop", slot: "s" } }) as RunStatus;
  assert.match(
    (await startedByActivity({ read }, { startedBy: { kind: "run", run: "loop", slot: "s" } }))!,
    /^started by: not read — the chain is longer than 16 runs/,
  );
});
