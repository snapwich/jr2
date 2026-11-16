// The Fence's objects that `jr2 up` writes (ADR-0084): the claim of a VLAN range, the attachments,
// and the uplink script, which runs here under `sh` with an `ip` and an `nft` that record what they
// are given.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { custodianXds, fenceRangesOf, FENCE_LAST_RANGE } from "@jr2/orchestrator/internal";
import {
  claimRange,
  FENCE_CLAIM_NAMESPACE,
  otherHolders,
  fenceAttachments,
  rangeClaimObject,
  releaseRanges,
  slotAttachment,
  trunkAttachment,
  UPLINK_SCRIPT,
  uplinkArgs,
  type ClaimKube,
} from "../src/fence.ts";
import { OPERATOR_NAMESPACE } from "../src/deploy.ts";
import type { KubeAdmin, KubeObject } from "../src/kube.ts";

const exec = promisify(execFile);
const roots: string[] = [];
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

type Claim = KubeObject & {
  metadata: { resourceVersion?: string; uid?: string };
  spec?: { holderIdentity?: string };
};

/** A cluster of range claims and namespaces. `alive` is each namespace that a read by name finds
 * (a Terminating one is found too). `claimsNamespace` says whether `jr2-system` is there. Each
 * write is recorded. */
function claimsKube(opts: { claims?: Array<[number, string]>; alive?: string[]; claimsNamespace?: boolean } = {}) {
  const claims = new Map<string, Claim>();
  const withUid = (o: Claim): Claim => ({ ...o, metadata: { ...o.metadata, uid: `uid-${o.metadata.name}` } });
  for (const [range, holder] of opts.claims ?? []) {
    const o = withUid(rangeClaimObject(range, holder, "7") as Claim);
    claims.set(o.metadata.name, o);
  }
  const alive = new Set(opts.alive ?? []);
  const log = { created: [] as string[], replaced: [] as string[], deleted: [] as string[], namespaces: 0 };
  /** Called before each create of a claim: a converge of another Instance that comes first. */
  let race: ((name: string) => void) | undefined;
  /** Called before each replace and each conditional delete of a claim: another converge that
   * comes first. */
  let raceWrite: ((name: string) => void) | undefined;
  const kube: ClaimKube & Pick<KubeAdmin, "deleteIf"> = {
    async listJson<T>(o: { kind: string; selector?: string; fieldSelector?: string; namespace?: string }) {
      if (o.kind === "namespace") {
        const name = /^metadata\.name=(.+)$/.exec(o.fieldSelector ?? "")?.[1];
        return (name !== undefined && alive.has(name) ? [{ metadata: { name } }] : []) as T[];
      }
      assert.equal(o.kind, "lease");
      assert.equal(o.namespace, FENCE_CLAIM_NAMESPACE);
      const [key, value] = (o.selector ?? "").split("=");
      return [...claims.values()].filter((c) => {
        const labels = c.metadata.labels ?? {};
        return key! in labels && (value === undefined || labels[key!] === value);
      }) as T[];
    },
    async getJson<T>(o: { kind: string; name: string }) {
      if (o.kind === "namespace") {
        assert.equal(o.name, FENCE_CLAIM_NAMESPACE);
        return (opts.claimsNamespace ? { metadata: { name: o.name } } : undefined) as T | undefined;
      }
      return claims.get(o.name) as T | undefined;
    },
    async create(o: { manifest: string }) {
      const obj = JSON.parse(o.manifest) as Claim;
      if (obj.kind === "Namespace") {
        log.namespaces++;
        return "exists";
      }
      race?.(obj.metadata.name);
      if (claims.has(obj.metadata.name)) return "exists";
      claims.set(obj.metadata.name, withUid({ ...obj, metadata: { ...obj.metadata, resourceVersion: "1" } }));
      log.created.push(obj.metadata.name);
      return "created";
    },
    async replace(o: { manifest: string }) {
      const obj = JSON.parse(o.manifest) as Claim;
      raceWrite?.(obj.metadata.name);
      const have = claims.get(obj.metadata.name);
      if (!have || have.metadata.resourceVersion !== obj.metadata.resourceVersion) return "changed";
      claims.set(obj.metadata.name, {
        ...obj,
        metadata: { ...obj.metadata, resourceVersion: "8", uid: have.metadata.uid! },
      });
      log.replaced.push(obj.metadata.name);
      return "replaced";
    },
    async deleteIf(o: { apiPath: string; uid: string; resourceVersion: string }) {
      const name = /^\/apis\/coordination\.k8s\.io\/v1\/namespaces\/jr2-system\/leases\/([^/]+)$/.exec(o.apiPath)?.[1];
      assert.ok(name, o.apiPath);
      raceWrite?.(name);
      const have = claims.get(name);
      if (!have || have.metadata.uid !== o.uid || have.metadata.resourceVersion !== o.resourceVersion) return "changed";
      claims.delete(name);
      log.deleted.push(name);
      return "deleted";
    },
  };
  return {
    kube,
    claims,
    log,
    alive,
    setRace: (fn: (name: string) => void) => {
      race = fn;
    },
    setRaceWrite: (fn: (name: string) => void) => {
      raceWrite = fn;
    },
  };
}

const holder = (c: Claim | undefined) => c?.spec?.holderIdentity;
const lines: string[] = [];
const log = (line: string) => void lines.push(line);

test("the claims are in the operator's namespace, and a claim names its range and its holder", () => {
  assert.equal(FENCE_CLAIM_NAMESPACE, OPERATOR_NAMESPACE);
  assert.deepEqual(rangeClaimObject(4, "team-a"), {
    apiVersion: "coordination.k8s.io/v1",
    kind: "Lease",
    metadata: {
      name: "jr2-fence-range-4",
      namespace: "jr2-system",
      labels: {
        "app.kubernetes.io/managed-by": "jr2",
        "jr2.dev/fence-range": "4",
        "jr2.dev/fence-holder": "team-a",
      },
    },
    spec: { holderIdentity: "team-a" },
  });
  assert.equal(FENCE_LAST_RANGE, 30, "31 ranges of 128 VLANs: the last slot of range 30 is VLAN 3970");
});

test("a new Instance creates the lowest free range, and a converge again keeps the range it holds", async () => {
  const c = claimsKube({ claims: [[0, "a"]], alive: ["a"] });
  assert.equal(await claimRange(c.kube, { namespace: "b", log }), 1);
  assert.deepEqual(c.log.created, ["jr2-fence-range-1"]);
  assert.equal(c.log.namespaces, 1, "it makes sure the claims' namespace exists");
  // When `jr2-system` is there, the claim creates no namespace: a user who may write claims there
  // and may not create a namespace gets Forbidden from a create, also when the namespace exists.
  const there = claimsKube({ claimsNamespace: true });
  assert.equal(await claimRange(there.kube, { namespace: "b", log }), 0);
  assert.equal(there.log.namespaces, 0);
  assert.equal(holder(c.claims.get("jr2-fence-range-1")), "b");
  assert.equal(await claimRange(c.kube, { namespace: "b", log }), 1);
  assert.equal(await claimRange(c.kube, { namespace: "a", log }), 0);
  assert.deepEqual(c.log.created, ["jr2-fence-range-1"], "no second claim");
});

test("a claim whose holder's namespace is NotFound is taken again at the version read; a Terminating one is kept", async () => {
  // `gone` holds 0 and its namespace is NotFound; `ending` holds 1 and is Terminating, which a read by
  // name still finds.
  const c = claimsKube({
    claims: [
      [0, "gone"],
      [1, "ending"],
    ],
    alive: ["ending"],
  });
  lines.length = 0;
  assert.equal(await claimRange(c.kube, { namespace: "new", log }), 0);
  assert.deepEqual(c.log.replaced, ["jr2-fence-range-0"]);
  assert.equal(holder(c.claims.get("jr2-fence-range-0")), "new");
  assert.match(lines.join("\n"), /took range 0 again: its holder, namespace "gone", is gone/);
  c.alive.add("new");
  assert.equal(await claimRange(c.kube, { namespace: "other", log }), 2, "range 1 of a Terminating namespace stays");
  assert.equal(holder(c.claims.get("jr2-fence-range-1")), "ending");
});

test("two converges at once: a lost create or a lost replace goes on to the next range", async () => {
  const c = claimsKube({ claims: [[1, "gone"]] });
  // Another Instance's create of range 0 comes first, and then its replace of range 1.
  c.setRace((name) => {
    if (name === "jr2-fence-range-0" && !c.claims.has(name)) {
      c.claims.set(name, rangeClaimObject(0, "first", "1") as Claim);
      c.alive.add("first");
      const one = c.claims.get("jr2-fence-range-1")!;
      c.claims.set("jr2-fence-range-1", { ...one, metadata: { ...one.metadata, resourceVersion: "9" } });
    }
  });
  assert.equal(await claimRange(c.kube, { namespace: "second", log }), 2);
  assert.equal(holder(c.claims.get("jr2-fence-range-0")), "first");
  assert.deepEqual(c.log.replaced, [], "the replace at the old version lost");
});

test("a lost replace to a converge of the same namespace keeps that range, and claims no second one", async () => {
  const c = claimsKube({ claims: [[0, "gone"]] });
  // A second `jr2 up` of namespace "a" takes range 0 between this converge's read and its replace.
  c.setRaceWrite((name) => {
    const have = c.claims.get(name)!;
    if (holder(have) === "gone") {
      c.claims.set(name, {
        ...have,
        metadata: { ...have.metadata, resourceVersion: "9" },
        spec: { holderIdentity: "a" },
      });
    }
  });
  assert.equal(await claimRange(c.kube, { namespace: "a", log }), 0);
  assert.deepEqual(c.log.created, [], "no claim of range 1");
  assert.deepEqual(c.log.replaced, []);
});

test("a namespace that holds two claims keeps the lowest and gives back the other", async () => {
  const c = claimsKube({
    claims: [
      [5, "a"],
      [2, "a"],
    ],
    alive: ["a"],
  });
  assert.equal(await claimRange(c.kube, { namespace: "a", log }), 2);
  assert.deepEqual(c.log.deleted, ["jr2-fence-range-5"]);
});

test("with each range held, the claim refuses and names the holders", async () => {
  const all = Array.from({ length: FENCE_LAST_RANGE + 1 }, (_, k) => [k, `ns-${k}`] as [number, string]);
  const c = claimsKube({ claims: all, alive: all.map(([, ns]) => ns) });
  await assert.rejects(claimRange(c.kube, { namespace: "late", log }), (e: Error) => {
    assert.match(e.message, /no VLAN range is free on this cluster: each of the 31 ranges is held/);
    assert.match(e.message, /0 \(ns-0\), 1 \(ns-1\)/);
    assert.match(e.message, /jr2 down/);
    return true;
  });
});

test("a release gives back the namespace's own claims and no other", async () => {
  const c = claimsKube({
    claims: [
      [0, "a"],
      [1, "b"],
      [2, "a"],
    ],
  });
  assert.deepEqual(await releaseRanges(c.kube, { namespace: "a" }), [0, 2]);
  assert.deepEqual([...c.claims.keys()], ["jr2-fence-range-1"]);
  assert.deepEqual(await releaseRanges(c.kube, { namespace: "a" }), []);
});

test("a release deletes only the claim it read: a claim that another Instance took in the meantime stays", async () => {
  const c = claimsKube({ claims: [[3, "gone"]] });
  // Between the release's list and its delete, a converge of "next" takes range 3 (its holder's
  // namespace is NotFound).
  c.setRaceWrite((name) => {
    c.setRaceWrite(() => {});
    const have = c.claims.get(name)!;
    c.claims.set(name, {
      ...have,
      metadata: { ...have.metadata, resourceVersion: "8" },
      spec: { holderIdentity: "next" },
    });
  });
  assert.deepEqual(await releaseRanges(c.kube, { namespace: "gone" }), []);
  assert.equal(holder(c.claims.get("jr2-fence-range-3")), "next", "the new holder's claim stays");
  assert.deepEqual(c.log.deleted, []);
  // A claim that changed and is still the namespace's (a label written, say) is read again and goes.
  const d = claimsKube({ claims: [[4, "gone"]] });
  d.setRaceWrite((name) => {
    d.setRaceWrite(() => {});
    const have = d.claims.get(name)!;
    d.claims.set(name, { ...have, metadata: { ...have.metadata, resourceVersion: "8" } });
  });
  assert.deepEqual(await releaseRanges(d.kube, { namespace: "gone" }), [4]);
});

test("the holders that jr2 down --all must not strand: other namespaces with a claim that are still there", async () => {
  const c = claimsKube({
    claims: [
      [0, "me"],
      [1, "b"],
      [2, "gone"],
      [3, "a"],
    ],
    alive: ["me", "a", "b"],
  });
  assert.deepEqual(await otherHolders(c.kube, { namespace: "me" }), ["a", "b"]);
  const alone = claimsKube({
    claims: [
      [0, "me"],
      [2, "gone"],
    ],
    alive: ["me"],
  });
  assert.deepEqual(await otherHolders(alone.kube, { namespace: "me" }), []);
});

test("a slot's attachment: an isolated access port of its VLAN, with its fixed MAC, its address and one route to the uplink", () => {
  const nad = slotAttachment({
    namespace: "ns",
    labels: { l: "1" },
    range: 3,
    slot: 5,
    ranges: fenceRangesOf(undefined),
  });
  assert.equal((nad.metadata as { name: string }).name, "jr2-fence-5");
  const config = JSON.parse((nad.spec as { config: string }).config);
  assert.equal(config.name, "jr2-fence-5");
  const [bridge] = config.plugins;
  // VLAN 2 + 128·3 + 5 = 391 = 0x187; the address is the segment's base plus the VLAN.
  assert.equal(bridge.type, "bridge");
  assert.equal(bridge.bridge, "jr2fence0");
  assert.equal(bridge.vlan, 391);
  assert.equal(bridge.portIsolation, true);
  assert.equal(bridge.ipMasq, false);
  assert.equal(bridge.isGateway, false);
  assert.deepEqual(bridge.args, { cni: { mac: "02:00:c6:13:01:87" } });
  assert.deepEqual(bridge.ipam, {
    type: "static",
    addresses: [{ address: "198.19.1.135/20", gateway: "198.19.0.1" }],
    routes: [{ dst: "0.0.0.0/0", gw: "198.19.0.1" }],
  });
  // A moved segment moves the address, its prefix length and the uplink's address.
  const moved = slotAttachment({
    namespace: "ns",
    labels: {},
    range: 0,
    slot: 0,
    ranges: fenceRangesOf({ segment: "100.64.0.0/16" }),
  });
  assert.deepEqual(JSON.parse((moved.spec as { config: string }).config).plugins[0].ipam.addresses, [
    { address: "100.64.0.2/16", gateway: "100.64.0.1" },
  ]);
});

test("the trunk's attachment: a tagged member of each VLAN of the range, and of VLAN 1 never", () => {
  const nad = trunkAttachment({ namespace: "ns", labels: {}, range: 2 });
  const [bridge, tuning] = JSON.parse((nad.spec as { config: string }).config).plugins;
  assert.equal(bridge.vlan, 258, "the first VLAN of the range, so the plugin adds no VLAN 1");
  assert.equal(bridge.preserveDefaultVlan, false);
  assert.deepEqual(bridge.vlanTrunk, [{ minID: 258, maxID: 385 }]);
  assert.equal(bridge.portIsolation, false, "the trunk reaches each isolated slot port");
  assert.equal(tuning.type, "tuning");
  assert.equal(tuning.sysctl["net.ipv4.conf.all.forwarding"], "0");
  assert.equal(tuning.sysctl["net.ipv6.conf.default.disable_ipv6"], "1");
  const all = fenceAttachments({ namespace: "ns", labels: {}, range: 2, ranges: fenceRangesOf(undefined) });
  assert.equal(all.length, 129);
  assert.equal(new Set(all.map((n) => (n.metadata as { name: string }).name)).size, 129);
});

test("the uplink script makes the range's VLAN interfaces and the static rule set, and writes Envoy's two files once", async () => {
  const root = await mkdtemp(join(tmpdir(), "jr2-uplink-"));
  roots.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  await mkdir(bin);
  await mkdir(state);
  // `ip -batch -` and `nft -f -` read their commands on stdin; these keep them.
  // The first `ip` call deletes the interfaces of a run before (none here: each delete fails, and the
  // script goes on); the second makes them.
  await writeFile(
    join(bin, "ip"),
    `#!/bin/sh\ncase "$*" in\n"-force -batch -") cat > "${root}/ip-stale.txt"; exit 1;;\n"-batch -") cat > "${root}/ip.txt";;\n*) exit 9;;\nesac\n`,
  );
  await writeFile(join(bin, "nft"), `#!/bin/sh\n[ "$*" = "-f -" ] || exit 9\ncat > "${root}/nft.txt"\n`);
  await chmod(join(bin, "ip"), 0o755);
  await chmod(join(bin, "nft"), 0o755);
  const group = process.getgid!();
  const args = uplinkArgs({ range: 3, ranges: fenceRangesOf(undefined), state, group });
  const empty = custodianXds([]);
  assert.deepEqual(args, [
    "uplink",
    "3",
    "198.19.0.0/20",
    state,
    String(group),
    JSON.stringify(empty.lds),
    JSON.stringify(empty.cds),
  ]);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const { stdout } = await exec("sh", ["-c", UPLINK_SCRIPT, ...args], { env });
  assert.equal(stdout, "jr2.custodian uplink range=3 vlans=386-513 slots=128\n");

  const ip = (await readFile(join(root, "ip.txt"), "utf8")).trim().split("\n");
  assert.equal(ip[0], "link set net1 up");
  assert.equal(ip.length, 1 + 4 * 128);
  assert.deepEqual(ip.slice(1, 5), [
    "link add link net1 name v0 address 02:00:c6:12:01:82 type vlan id 386",
    "addr add 198.19.0.1/32 dev v0",
    "link set v0 up",
    "route add 198.19.1.130/32 dev v0",
  ]);
  assert.equal(ip.at(-4), "link add link net1 name v127 address 02:00:c6:12:02:01 type vlan id 513");
  assert.equal(ip.at(-1), "route add 198.19.2.1/32 dev v127");

  const stale = (await readFile(join(root, "ip-stale.txt"), "utf8")).trim().split("\n");
  assert.equal(stale.length, 128);
  assert.equal(stale[0], "link del v0");
  assert.equal(stale.at(-1), "link del v127");

  const nft = await readFile(join(root, "nft.txt"), "utf8");
  // Each table goes first (its declaration makes it if it is not there), so a run again in the same
  // network namespace loads the same rule set, not a second copy of it.
  assert.match(
    nft,
    /^table netdev jr2_uplink_l2\ndelete table netdev jr2_uplink_l2\ntable inet jr2_uplink\ndelete table inet jr2_uplink\ntable arp jr2_uplink\ndelete table arp jr2_uplink\n/,
  );
  assert.match(nft, /elements = \{ "v0" \. 198\.19\.1\.130, "v1" \. 198\.19\.1\.131, /);
  assert.match(nft, /"v127" \. 198\.19\.2\.1 \}/);
  assert.match(nft, /elements = \{ "v0" : 20000, "v1" : 20001, .*"v127" : 20127 \}/);
  assert.match(nft, /elements = \{ "v0" : 25000, .*"v127" : 25127 \}/);
  assert.match(nft, /iifname "eth0" tcp dport \{ 15021, 18080, 18081 \} accept/);
  assert.match(nft, /type filter hook forward priority 0; policy drop;/);
  assert.match(nft, /chain input \{\n\s+type filter hook input priority 0; policy drop;/);
  assert.equal((nft.match(/elements = \{ "v0" \. /g) ?? []).length, 2, "the identity in the inet and the arp table");
  assert.doesNotMatch(nft, /\$/, "each shell word was expanded");

  assert.equal(await readFile(join(state, "xds", "lds.json"), "utf8"), JSON.stringify(empty.lds));
  assert.equal(await readFile(join(state, "xds", "cds.json"), "utf8"), JSON.stringify(empty.cds));
  // A second run (the pod's network namespace made again) leaves files that are there.
  await writeFile(join(state, "xds", "lds.json"), "kept");
  await exec("sh", ["-c", UPLINK_SCRIPT, ...args], { env });
  assert.equal(await readFile(join(state, "xds", "lds.json"), "utf8"), "kept");
});

test("the uplink refuses a range outside 0 … 30", () => {
  assert.throws(
    () => uplinkArgs({ range: 31, ranges: fenceRangesOf(undefined), state: "/s", group: 1 }),
    /VLAN range 31/,
  );
});
