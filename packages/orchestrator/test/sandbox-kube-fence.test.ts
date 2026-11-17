// kubeSandbox on the Fence (ADR-0084): the provision takes a slot, writes the CR with the slot's
// attachment and no Custodian container, writes the Sandbox's Fence objects once, waits until the
// Custodian says the rules are live, and answers the slot's address; the attach and the Sandbox
// Effector go through the Custodian pod on the pod's node; a deleted Sandbox's slot waits before it
// is given again. Against the fake API server (_fake-kube.ts), the operator and the Custodian
// played by the test. Socket-free (ADR-0010).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustodianClient } from "../src/custodian-client.ts";
import { FENCE_PLACEHOLDERS, FENCE_SEGMENT } from "../src/egress.ts";
import type { SlotReport } from "../src/fence-slots.ts";
import { EMPTY_HELD, gitPushStandIn, workspaceHeldPod } from "../src/held-secrets.ts";
import { GIT_PUSH_MANIFEST_KEY, gitPushSecretName } from "../src/git-push.ts";
import { effectorManifestKey, sandboxEffectorObjectsOf } from "../src/sandbox-effector.ts";
import { readSlotSecret } from "../src/custodian-slot.ts";
import { kubeClient } from "../src/kube-client.ts";
import { issueCa } from "../src/pki.ts";
import type { PlacementRoute } from "../src/parts.ts";
import type { RepoResources } from "../src/repos.ts";
import { custodianComposition } from "../src/custodian.ts";
import { fenceComposition } from "../src/sandbox-fence.ts";
import { kubeSandbox, sandboxSidecars, type FenceWiring } from "../src/sandbox-kube.ts";
import { watchSandboxes } from "../src/sandbox-watch.ts";
import type { AttachRequest } from "../src/wire.ts";
import { fakeKube } from "./_fake-kube.ts";

const stops: Array<() => void> = [];
after(() => stops.forEach((stop) => stop()));

const RANGES = { segment: FENCE_SEGMENT, placeholders: FENCE_PLACEHOLDERS };
const UPSTREAM = issueCa("upstream roots").cert;

const REFS = { harness: "jr2-harness:h00", custodian: "envoy:c00", sandbox: { default: "jr2-sandbox:d00" } };
const APP_URL = "https://example.test/app.git";

async function mkImages(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-images-"));
  await writeFile(join(dir, "images.json"), JSON.stringify(REFS));
  return join(dir, "images.json");
}

async function mkHeld(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-held-"));
  await writeFile(
    join(dir, `held-${workspaceHeldPod({ workflow: "coding", route: [] })}.json`),
    JSON.stringify(EMPTY_HELD),
  );
  return dir;
}

const repos: RepoResources = {
  bind: async () => {},
  ensure: async () => {},
  reconcileBound: async () => {},
  list: async () => [],
};

/** The Custodian of a test: what each provision asked it, and what its pods say of a slot. */
function custodian(opts: { live?: (slot: number) => Promise<string>; reports?: (slot: number) => SlotReport[] } = {}) {
  const live: number[] = [];
  const asked: number[] = [];
  const client: CustodianClient = {
    dialToken: "dial",
    pods: async () => [{ pod: "c-1", address: "10.0.0.11", node: "w1", ready: true }],
    podOn: async (node) => (node === "w1" ? "10.0.0.11" : undefined),
    reports: async (slot) => {
      asked.push(slot);
      return opts.reports?.(slot) ?? [{ pod: "c-1", status: { active: null, present: false } }];
    },
    makeLive: async (slot) => {
      live.push(slot);
      return opts.live ? opts.live(slot) : "v1";
    },
  };
  return { client, live, asked };
}

/** The fake API with the operator played: an applied CR is placed on node w1, then Ready. */
function cluster(c: CustodianClient, fenceOpts: Partial<FenceWiring> = {}) {
  const api = fakeKube();
  const client = kubeClient({ baseUrl: "https://kube.test", fetch: api.fetch, token: async () => api.token });
  const watch = watchSandboxes(client, { namespace: "default", backoffMs: 5 });
  stops.push(() => watch.stop());
  api.onWrite((plural, obj, call) => {
    if (plural !== "sandboxes" || call.contentType !== "application/apply-patch+yaml") return;
    const name = obj.metadata.name;
    setTimeout(() => {
      api.setStatus("sandboxes", name, {
        phase: "Ready",
        endpoint: `http://${name}.default.svc:8080`,
        node: "w1",
        conditions: [{ type: "Scheduled", status: "True" }],
      });
    }, 1);
  });
  const attaches: Array<{ url: string }> = [];
  const harnessFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    attaches.push({ url: String(input) });
    const body = JSON.parse(String(init.body)) as AttachRequest;
    return Response.json({
      repos: Object.fromEntries(body.slots.map((s) => [s.slot, `/work/${s.slot}`])),
      bases: Object.fromEntries(body.slots.map((s) => [s.slot, "main"])),
    });
  }) as typeof fetch;
  const fence: FenceWiring = {
    range: 2,
    ranges: RANGES,
    custodian: c,
    upstream: async () => UPSTREAM,
    caBundle: async () => undefined,
    ...fenceOpts,
  };
  return { api, client, watch, harnessFetch, attaches, fence };
}

async function port(c: CustodianClient, fenceOpts: Partial<FenceWiring> = {}) {
  const k = cluster(c, fenceOpts);
  const p = kubeSandbox({
    imagesPath: await mkImages(),
    heldDir: await mkHeld(),
    signingKey: Buffer.from("k"),
    repos,
    client: k.client,
    watch: k.watch,
    harnessFetch: k.harnessFetch,
    fence: k.fence,
  });
  const provision = async (name: string) => {
    await p.place(
      {
        name,
        runId: "run-1",
        workflow: "coding",
        path: "ws",
        route: [] as PlacementRoute,
        repos: [{ slot: "app", url: APP_URL, perRun: false }],
      },
      { onWait: () => {} },
    );
    return p.provision(name);
  };
  return { ...k, port: p, provision };
}

const applies = (api: ReturnType<typeof fakeKube>, target: string) =>
  api.writes.filter((c) => c.contentType === "application/apply-patch+yaml" && c.target === target);

test("a provision on the Fence: slot, CR on the slot's attachment, objects once, live, then the slot's address", async () => {
  const c = custodian();
  const k = await port(c.client);
  const { endpoint } = await k.provision("ws-a");
  // The first slot that the Orchestrator gives is 3; range 2 makes it VLAN 261, 198.19.1.5.
  assert.equal(endpoint, "http://198.19.1.5:8080");
  assert.deepEqual(c.live, [3]);

  const cr = applies(k.api, "sandboxes/ws-a")[0]!.body;
  assert.deepEqual(cr.spec.network, { attachment: "jr2-fence-3", nameserver: "198.19.0.1" });
  // No Custodian container, and no proxy variable: the Custodian is outside the pod.
  assert.deepEqual(cr.spec.sidecars, []);
  const env = cr.spec.env.map((e: { name: string }) => e.name);
  assert.ok(env.includes("JR2_CUSTODIAN_URL"));
  assert.ok(!env.some((n: string) => /proxy/i.test(n)), "no proxy variable");
  assert.ok(!env.includes("JR2_CUSTODIAN_SOCKET"));

  // The Fence objects, owned by the CR, and the CR marked; no token Secret, no Custodian
  // ConfigMap, no Effector Service of the in-pod Custodian.
  const order = k.api.writes.map((w) => `${w.method} ${w.target}`);
  assert.deepEqual(order, [
    "PATCH sandboxes/ws-a",
    "PATCH secrets/jr2-custodian-slot-3",
    "PATCH secrets/ws-a-standins",
    "POST configmaps",
    "PATCH sandboxes/ws-a",
  ]);
  const uid = k.api.object("sandboxes", "ws-a").metadata.uid;
  for (const [plural, name] of [
    ["secrets", "jr2-custodian-slot-3"],
    ["secrets", "ws-a-standins"],
    ["configmaps", "ws-a-trust"],
  ] as const) {
    assert.equal(k.api.object(plural, name).metadata.ownerReferences[0].uid, uid, name);
  }
  assert.ok(k.api.object("configmaps", "ws-a-trust").data["bundle.crt"].startsWith(UPSTREAM));
  assert.equal(k.api.object("sandboxes", "ws-a").metadata.annotations["jr2.dev/fence-objects"], "written");

  // The attach dials the slot's address; the route to it is `fenceRouted`'s.
  await k.port.attach({ name: "ws-a", repos: [{ slot: "app", url: APP_URL }] });
  assert.equal(k.attaches[0]!.url, "http://198.19.1.5:8080/attach");
  // The node of the slot is the Sandbox's `status.node`; the Effector is at the slot's address.
  assert.equal(await k.port.fenceNode(3), "w1");
  assert.equal(await k.port.fenceNode(4), undefined);
  assert.equal(await k.port.fenceEffector("ws-a"), "198.19.1.5:8082");
});

test("a second provision of a Sandbox keeps its slot and writes no Fence object again: the pod trusts that CA", async () => {
  const c = custodian();
  const k = await port(c.client);
  await k.provision("ws-b");
  const trust = k.api.object("configmaps", "ws-b-trust").data["extra.crt"];
  const before = k.api.writes.length;
  // An Orchestrator restarted mid-provision places the Sandbox again.
  await k.provision("ws-b");
  const again = k.api.writes.slice(before).map((w) => `${w.method} ${w.target}`);
  assert.deepEqual(again, ["PATCH sandboxes/ws-b"]);
  assert.equal(k.api.object("configmaps", "ws-b-trust").data["extra.crt"], trust);
  assert.deepEqual(c.live, [3, 3]);
});

test("a new port (an Orchestrator that started again) gives each Sandbox the slot its CR names", async () => {
  const c = custodian();
  const k = await port(c.client);
  await k.provision("ws-c");
  await k.provision("ws-d");
  const restarted = kubeSandbox({
    imagesPath: await mkImages(),
    heldDir: await mkHeld(),
    signingKey: Buffer.from("k"),
    repos,
    client: k.client,
    watch: k.watch,
    harnessFetch: k.harnessFetch,
    fence: k.fence,
  });
  assert.deepEqual(await restarted.provision("ws-d"), { endpoint: "http://198.19.1.6:8080" });
  assert.equal(await restarted.fenceNode(3), "w1");
});

test("a trust ConfigMap with no mark on the CR is of a write that did not finish: the provision fails", async () => {
  const c = custodian();
  const k = await port(c.client);
  k.api.seed("configmaps", { metadata: { name: "ws-e-trust", namespace: "default" }, data: {} } as never);
  await assert.rejects(k.provision("ws-e"), /its trust ConfigMap is of an earlier provision that did not finish/);
  assert.deepEqual(c.live, [], "no rules made live for a pod that cannot trust them");
});

test("a provision fails when the Custodian does not make the rules live", async () => {
  const c = custodian({
    live: async (slot) => {
      throw new Error(`the Custodian did not make the rules of Fence slot ${slot} live in 60 s (ADR-0084): …`);
    },
  });
  const k = await port(c.client);
  await assert.rejects(k.provision("ws-f"), /did not make the rules of Fence slot 3 live/);
});

test("delete a Sandbox and provision at once: the new one gets another slot, and the old one waits", async () => {
  const c = custodian();
  const k = await port(c.client);
  await k.provision("ws-g");
  await k.port.destroy("ws-g");
  const { endpoint } = await k.provision("ws-h");
  assert.equal(endpoint, "http://198.19.1.6:8080", "slot 4, not the slot 3 of a Sandbox that just went");
  assert.equal(applies(k.api, "sandboxes/ws-h")[0]!.body.spec.network.attachment, "jr2-fence-4");
});

test("the Sandbox's slot Secret and objects are not written for a Sandbox refused before a slot", async () => {
  const c = custodian();
  const k = await port(c.client);
  await assert.rejects(
    k.port.place(
      {
        name: "ws-i",
        runId: "r",
        workflow: "coding",
        path: "ws",
        route: [],
        repos: [{ slot: "app", url: "https://elsewhere.test/x.git", perRun: true }],
      },
      { onWait: () => {} },
    ),
    /no git.credentials entry matches/,
  );
  assert.deepEqual(c.asked, [], "no slot was asked for");
  assert.deepEqual(k.api.writes, []);
});

test("a deployed Orchestrator with no Fence refuses a provision, names `jr2 up`, and writes nothing", async () => {
  const k = cluster(custodian().client);
  const p = kubeSandbox({
    imagesPath: await mkImages(),
    heldDir: await mkHeld(),
    signingKey: Buffer.from("k"),
    repos,
    client: k.client,
    watch: k.watch,
    harnessFetch: k.harnessFetch,
    requireFence: true,
  });
  await assert.rejects(
    p.place(
      {
        name: "ws-off",
        runId: "run-1",
        workflow: "coding",
        path: "ws",
        route: [] as PlacementRoute,
        repos: [{ slot: "app", url: APP_URL, perRun: false }],
      },
      { onWait: () => {} },
    ),
    /Sandbox "ws-off" cannot be provisioned: this Orchestrator has no Fence \(ADR-0084\).*run `jr2 up` again/,
  );
  assert.deepEqual(k.api.writes, []);
});

test("sandboxSidecars: the in-pod Custodian when the composition has one, never on the Fence", () => {
  const manifest = EMPTY_HELD;
  const fence = fenceComposition(manifest, { sandbox: "ws-x", slot: 9, ranges: RANGES });
  const user = { name: "user" };
  const effector = { name: "effector" };
  assert.deepEqual(sandboxSidecars(fence, user, effector), [user, effector]);
  assert.deepEqual(sandboxSidecars(fence), []);
  const inPod = custodianComposition(manifest, {
    image: "envoy:c00",
    pod: "ws-x",
    config: "ws-x-custodian",
    credentials: { secret: "ws-x-token" },
    sandbox: "ws-x",
    caBundle: false,
    resources: { requests: { cpu: "100m", memory: "64Mi" }, limits: { cpu: "100m", memory: "64Mi" } },
  });
  assert.deepEqual(
    sandboxSidecars(inPod, user, effector).map((s) => s.name),
    ["custodian", "user", "effector"],
  );
});

test("a push over https on the Fence: the slot binds the entry's token toward the url's host, with the entry's Stand-in (ADR-0068)", async () => {
  const c = custodian();
  const k = cluster(c.client);
  const heldDir = await mkHeld();
  const pod = workspaceHeldPod({ workflow: "coding", route: [] });
  const plan = {
    placement: "sandbox" as const,
    pod,
    label: "coding",
    secrets: [],
    values: {},
    custodian: [],
    custodianValues: {},
    targets: [],
    pushes: [{ slot: "app", sign: false }],
    commands: false,
    effects: ["coding/publish"],
  };
  await writeFile(join(heldDir, effectorManifestKey(pod)), JSON.stringify(sandboxEffectorObjectsOf(plan).manifest));
  const secret = gitPushSecretName("*");
  await writeFile(
    join(heldDir, GIT_PUSH_MANIFEST_KEY),
    JSON.stringify({ version: 1, entries: [{ match: "*", order: 0, secret, push: ["token"] }] }),
  );
  const p = kubeSandbox({
    imagesPath: await mkImages(),
    heldDir,
    signingKey: Buffer.from("k"),
    repos,
    client: k.client,
    watch: k.watch,
    harnessFetch: k.harnessFetch,
    fence: k.fence,
    credentials: [{ match: "*", token: "T" }],
  });
  await p.place(
    {
      name: "ws-push",
      runId: "run-1",
      workflow: "coding",
      path: "ws",
      route: [] as PlacementRoute,
      repos: [{ slot: "app", url: "https://git.example.test:8443/acme/app.git", perRun: true }],
    },
    { onWait: () => {} },
  );
  const data = k.api.object("secrets", "jr2-custodian-slot-3").data as Record<string, string>;
  const { spec } = readSlotSecret(data);
  const binding = spec.manifest.secrets.find((s) => s.push);
  assert.deepEqual(
    [binding?.source, binding?.hosts.map((h) => `${h.host}:${h.port}`), binding?.basic, binding?.holder],
    [{ kind: "secret", secret, key: "token" }, ["git.example.test:8443"], true, "effector"],
  );
  assert.deepEqual(
    spec.manifest.egress.find((r) => r.host === "git.example.test"),
    { host: "git.example.test", port: 8443, match: "name", intercept: true, from: ["effector"] },
  );
  assert.equal(
    Buffer.from(data[`values.${binding!.name}.standin`]!, "base64").toString(),
    gitPushStandIn(Buffer.from("k"), secret),
    "the entry's Stand-in, which its push Secret holds as `password`",
  );
  // The operator projects the entry's Secret into the Effector; the CR names it.
  const cr = applies(k.api, "sandboxes/ws-push")[0]!.body;
  assert.deepEqual(cr.spec.gitCredentials, [{ name: secret }]);
});
