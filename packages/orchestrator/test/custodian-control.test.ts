// The control process of a Custodian pod (ADR-0084), against a fake API (the Secrets it may get) and
// a fake Envoy admin that reads the LDS and CDS files as Envoy does: on each move of a file, and
// with a listener it refuses kept out while the old one stays active. Socket-free (ADR-0010): the
// state folder is a temp folder, and the API is called through its `fetch`.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  custodianControl,
  neighbourResolved,
  resolverTables,
  type CustodianControl,
} from "../src/custodian-control.ts";
import { rulesChainName } from "../src/custodian-rules.ts";
import { readSlotSecret, slotSecretData, SLOT_SPEC_KEY, type SlotSpec } from "../src/custodian-slot.ts";
import { DIAL_TOKEN_HEADER, JR2_CUSTODIAN_NAME, slotFolder, CUSTODIAN_STATE } from "../src/custodian.ts";
import { CONTROL_TOKEN_NAME, leafStem, SANDBOX_TOKEN_NAME } from "../src/held-secrets.ts";
import { KubeError } from "../src/kube-client.ts";
import { emptyPlaceholders, withPlaceholders } from "../src/placeholders.ts";
import { INSTANCE_MANIFEST, RANGES, SANDBOX_MANIFEST } from "./_custodian-slots.ts";

const NS = "jr2-test";
const DIAL = "dial-token-of-the-instance";
/** Every value, Stand-in and token of the fixtures: no log line may hold one. */
const SECRET_TEXTS: string[] = [DIAL];

const roots: string[] = [];
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

// ---- the fake API ---------------------------------------------------------------------------------

type FakeApi = {
  secrets: Map<string, Record<string, string>>;
  /** Names whose get fails as if the API did not answer. */
  failing: Set<string>;
  gets: string[];
  kube: Parameters<typeof custodianControl>[0]["kube"];
};

function fakeApi(): FakeApi {
  const secrets = new Map<string, Record<string, string>>();
  const failing = new Set<string>();
  const gets: string[] = [];
  return {
    secrets,
    failing,
    gets,
    kube: {
      get: async <T>(kind: { plural: string }, namespace: string, name: string) => {
        assert.equal(kind.plural, "secrets", "the Custodian reads Secrets alone");
        assert.equal(namespace, NS);
        gets.push(name);
        if (failing.has(name)) throw new KubeError(503, "ServiceUnavailable", "the API did not answer");
        const data = secrets.get(name);
        return (data === undefined ? undefined : { metadata: { name }, data }) as T | undefined;
      },
    },
  };
}

const b64 = (text: string): string => Buffer.from(text).toString("base64");
const b64data = (data: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)]));

/** The slot Secret of a Harness pod, as the Orchestrator writes it, with its Stand-ins, tokens and
 * leaves; each one is added to `SECRET_TEXTS`. */
function slotSecret(slot: number, spec: SlotSpec): Record<string, string> {
  const files = new Map<string, string>();
  const secret = (path: string, text: string) => {
    files.set(path, text);
    SECRET_TEXTS.push(text);
  };
  secret(`values/${CONTROL_TOKEN_NAME}`, `control-token-of-slot-${slot}`);
  secret(`values/${CONTROL_TOKEN_NAME}.standin`, `control-standin-of-slot-${slot}`);
  if ("sandbox" in spec.owner) secret(`values/${SANDBOX_TOKEN_NAME}`, `fetch-token-of-slot-${slot}`);
  for (const s of spec.manifest.secrets) secret(`values/${s.name}.standin`, `jr2-held-${s.name}.standin-of-${slot}`);
  const intercepted = [
    { host: JR2_CUSTODIAN_NAME, port: 443 },
    ...spec.manifest.egress.filter((e) => e.intercept && e.port !== 80),
  ];
  for (const { host, port } of intercepted) {
    files.set(`tls/${leafStem(host, port)}.crt`, `CERT ${host}:${port}`);
    secret(`tls/${leafStem(host, port)}.key`, `KEY-of-${slot}-${host}:${port}`);
  }
  return b64data(slotSecretData(spec, files));
}

const sandboxSpec = (): SlotSpec => ({
  version: 1,
  owner: { sandbox: "ws-3" },
  manifest: SANDBOX_MANIFEST,
  placeholders: withPlaceholders(emptyPlaceholders(RANGES.placeholders), SANDBOX_MANIFEST.egress),
  heldPod: "ws-3",
});
const instanceSpec = (): SlotSpec => ({
  version: 1,
  owner: { pod: "instance" },
  manifest: INSTANCE_MANIFEST,
  placeholders: withPlaceholders(emptyPlaceholders(RANGES.placeholders), INSTANCE_MANIFEST.egress),
  heldPod: "instance",
});

/** An Instance with slot 0 (the Instance Harness) and slot 3 (a Sandbox), each with its values. */
function instance(api: FakeApi): void {
  const values = {
    anthropic: "sk-ant-REAL-VALUE-0001",
    local: "local-REAL-VALUE-0002",
    gh: "ghp_REAL_VALUE_0003\n",
    provider: "provider-REAL-VALUE-0004",
  };
  SECRET_TEXTS.push(...Object.values(values).map((v) => v.trim()));
  api.secrets.set("jr2-custodian-dial", b64data({ token: DIAL }));
  api.secrets.set("jr2-custodian-slot-0", slotSecret(0, instanceSpec()));
  api.secrets.set("jr2-custodian-slot-3", slotSecret(3, sandboxSpec()));
  api.secrets.set("jr2-held-secrets-ws-3", b64data({ ANTHROPIC_API_KEY: values.anthropic, LOCAL_KEY: values.local }));
  api.secrets.set("gh", b64data({ token: values.gh }));
  api.secrets.set("jr2-held-secrets-instance", b64data({ JR2_PROVIDER_API_KEY: values.provider }));
}

// ---- the fake Envoy ----------------------------------------------------------------------------------

type Listener = { name: string; filter_chains: Array<{ name: string }> };

type FakeEnvoy = {
  admin: (path: string) => Promise<string>;
  active: Map<string, Listener>;
  /** Envoy refuses a listener for which this is true, and keeps the old one active. */
  refuse: (l: Listener) => boolean;
  /** Envoy is not running: its admin does not answer. */
  down: boolean;
  /** Envoy's container starts again: it reads both files afresh. */
  restart: () => void;
};

function fakeEnvoy(root: string): FakeEnvoy {
  const lds = join(root, "xds", "lds.json");
  const cds = join(root, "xds", "cds.json");
  let seen = -1;
  const errors = new Map<string, unknown>();
  const envoy: FakeEnvoy = {
    active: new Map(),
    refuse: () => false,
    down: false,
    restart: () => {
      envoy.active.clear();
      errors.clear();
      seen = -1;
    },
    admin: async (path) => {
      if (envoy.down) throw new Error("connect ECONNREFUSED 127.0.0.1:15000");
      // A move of the file is what Envoy reads (`watched_directory`): a new inode.
      if (existsSync(lds) && statSync(lds).ino !== seen) {
        seen = statSync(lds).ino;
        const resources = (JSON.parse(readFileSync(lds, "utf8")) as { resources: Listener[] }).resources;
        for (const name of [...envoy.active.keys()]) {
          if (!resources.some((r) => r.name === name)) envoy.active.delete(name);
        }
        for (const l of resources) {
          if (envoy.refuse(l)) errors.set(l.name, l);
          else {
            envoy.active.set(l.name, l);
            errors.delete(l.name);
          }
        }
      }
      const url = new URL(path, "http://admin");
      if (url.pathname === "/stats") {
        const version = existsSync(cds)
          ? (JSON.parse(readFileSync(cds, "utf8")) as { version_info: string }).version_info
          : "";
        return `cluster_manager.cds.version_text: "${version}"\n`;
      }
      assert.equal(url.pathname, "/config_dump");
      assert.equal(url.searchParams.get("resource"), "dynamic_listeners");
      const regex = new RegExp(url.searchParams.get("name_regex")!);
      const names = new Set([...envoy.active.keys(), ...errors.keys()].filter((n) => regex.test(n)));
      return JSON.stringify({
        configs: [...names].map((name) => ({
          name,
          ...(envoy.active.has(name) ? { active_state: { listener: envoy.active.get(name) } } : {}),
          ...(errors.has(name) ? { error_state: { failed_configuration: errors.get(name), details: "refused" } } : {}),
        })),
      });
    },
  };
  return envoy;
}

// ---- the rig -------------------------------------------------------------------------------------

async function rig(opts: { root?: string; api?: FakeApi; envoy?: FakeEnvoy } = {}) {
  const root = opts.root ?? (await mkdtemp(join(tmpdir(), "custodian-control-")));
  roots.push(root);
  const api = opts.api ?? fakeApi();
  const envoy = opts.envoy ?? fakeEnvoy(root);
  const lines: string[] = [];
  const resolver = resolverTables();
  const present = new Set<number>();
  const control = custodianControl({
    kube: api.kube,
    namespace: NS,
    ranges: RANGES,
    range: 0,
    admin: envoy.admin,
    root,
    resolver,
    present: async (slot) => present.has(slot),
    log: (line) => lines.push(line),
    liveTimeoutMs: 1_000,
  });
  return { root, api, envoy, lines, resolver, present, control };
}

const at = (root: string, path: string) => join(root, path.slice(CUSTODIAN_STATE.length + 1));
const lds = (root: string) =>
  JSON.parse(readFileSync(join(root, "xds", "lds.json"), "utf8")) as { resources: Listener[] };

function call(control: CustodianControl, method: string, path: string, token?: string): Promise<Response> {
  return control.fetch(
    new Request(`http://custodian:18081${path}`, { method, headers: token ? { [DIAL_TOKEN_HEADER]: token } : {} }),
  );
}

function assertNoSecret(lines: string[]): void {
  for (const line of lines) {
    for (const text of SECRET_TEXTS) assert.ok(!line.includes(text), `a log line holds a secret: ${line}`);
  }
}

// ---- the claims -----------------------------------------------------------------------------------

test("a slot Secret becomes the slot's files in the state folder, then live rules: Envoy shows the version's chain, and the resolver table is of that version", async () => {
  const { root, api, envoy, lines, resolver, control } = await rig();
  instance(api);
  await control.syncAll();

  assert.equal(control.ready(), true);
  for (const slot of [0, 3]) {
    const s = control.status(slot);
    assert.equal(s.live, true, JSON.stringify(s));
    assert.equal(resolver.get(slot)?.version, s.version);
    const active = envoy.active.get(`slot-${slot}`)!;
    assert.ok(active.filter_chains.some((c) => c.name.split(" ").includes(rulesChainName(s.version!))));
  }
  assert.deepEqual(control.status(5), { slot: 5, version: null, live: false });
  assert.deepEqual(
    lds(root).resources.map((l) => l.name),
    ["slot-0", "slot-3"],
  );

  // The files: values from their own Secrets, the slot Secret's Stand-ins, tokens and leaves.
  const folder = at(root, slotFolder(3));
  assert.equal(await readFile(join(folder, "values", "ANTHROPIC_API_KEY"), "utf8"), "sk-ant-REAL-VALUE-0001");
  assert.equal(await readFile(join(folder, "values", "GH_TOKEN"), "utf8"), "ghp_REAL_VALUE_0003\n");
  assert.equal(await readFile(join(folder, "values", "GH_TOKEN.standin"), "utf8"), "jr2-held-GH_TOKEN.standin-of-3");
  assert.equal(await readFile(join(folder, "values", SANDBOX_TOKEN_NAME), "utf8"), "fetch-token-of-slot-3");
  const stem = leafStem("api.anthropic.com", 443);
  assert.equal(await readFile(join(folder, "tls", `${stem}.key`), "utf8"), "KEY-of-3-api.anthropic.com:443");
  const tables = (await readdir(folder)).filter((f) => f.endsWith(".lua"));
  assert.equal(tables.length, 1);
  assert.ok((await readFile(join(folder, tables[0]!), "utf8")).includes('sandbox = "ws-3"'));
  assert.equal(await readFile(join(root, "dial-token"), "utf8"), DIAL);

  // The CDS file holds the address clusters of slot 3.
  const cds = JSON.parse(readFileSync(join(root, "xds", "cds.json"), "utf8")) as { resources: Array<{ name: string }> };
  assert.ok(cds.resources.some((c) => c.name === "tls|10.0.0.7|8443"));

  assert.ok(
    lines.some((l) => /^jr2\.custodian ready slot=3 sandbox=ws-3 version=[0-9a-f]{16} /.test(l)),
    lines.join("\n"),
  );
  assert.ok(
    lines.some(
      (l) => l.startsWith("jr2.custodian ready slot=0 pod=instance ") && l.includes("secrets=JR2_PROVIDER_API_KEY"),
    ),
  );
  // Each Secret it read is one of the names the Custodian may get.
  assert.ok(
    api.gets.every((n) => /^(jr2-custodian-slot-\d+|jr2-custodian-dial|jr2-held-secrets-.+|gh)$/.test(n)),
    api.gets.join(),
  );
  assertNoSecret(lines);
});

test("a changed value is taken live: a new Lua table, the new value, the old table gone; a slot that did not change is not written again", async () => {
  const { root, api, control } = await rig();
  instance(api);
  await control.syncAll();
  const before = control.status(3).version;
  const zero = control.status(0).version;
  const slot0Lua = (await readdir(at(root, slotFolder(0)))).find((f) => f.endsWith(".lua"));
  const ldsIno = statSync(join(root, "xds", "lds.json")).ino;

  await control.syncAll();
  assert.equal(statSync(join(root, "xds", "lds.json")).ino, ldsIno, "nothing changed, so nothing is written");

  api.secrets.set("gh", b64data({ token: "ghp_ROTATED_VALUE_0005" }));
  SECRET_TEXTS.push("ghp_ROTATED_VALUE_0005");
  await control.syncAll();
  const s = control.status(3);
  assert.equal(s.live, true);
  assert.notEqual(s.version, before);
  assert.equal(control.status(0).version, zero);
  assert.equal(
    (await readdir(at(root, slotFolder(0)))).find((f) => f.endsWith(".lua")),
    slot0Lua,
  );
  const folder = at(root, slotFolder(3));
  assert.equal(await readFile(join(folder, "values", "GH_TOKEN"), "utf8"), "ghp_ROTATED_VALUE_0005");
  assert.equal((await readdir(folder)).filter((f) => f.endsWith(".lua")).length, 1, "the old Lua table is removed");
});

test("a deleted slot Secret removes the slot: its listener, its resolver table and its folder go, and it reaches nothing", async () => {
  const { root, api, envoy, lines, resolver, control } = await rig();
  instance(api);
  await control.syncAll();
  api.secrets.delete("jr2-custodian-slot-3");
  await control.syncAll();

  assert.deepEqual(control.status(3), { slot: 3, version: null, live: false });
  assert.equal(envoy.active.has("slot-3"), false);
  assert.equal(resolver.get(3), undefined);
  assert.equal(existsSync(at(root, slotFolder(3))), false);
  assert.deepEqual(
    lds(root).resources.map((l) => l.name),
    ["slot-0"],
  );
  assert.equal(control.status(0).live, true);
  assert.ok(lines.includes("jr2.custodian removed slot=3 sandbox=ws-3"));
});

test("a restart reads every slot: a new control process over the same folder is live for each slot before it is ready, and Envoy's own restart is written again", async () => {
  const first = await rig();
  instance(first.api);
  await first.control.syncAll();
  const versions = [0, 3].map((s) => first.control.status(s).version);

  // The control container starts again: nothing in memory, the folder and Envoy as they were.
  const second = await rig({ root: first.root, api: first.api, envoy: first.envoy });
  assert.equal(second.control.ready(), false);
  assert.equal((await call(second.control, "GET", "/healthz")).status, 503);
  await second.control.syncAll();
  assert.equal(second.control.ready(), true);
  assert.equal((await call(second.control, "GET", "/healthz")).status, 200);
  assert.deepEqual(
    [0, 3].map((s) => second.control.status(s)),
    [0, 3].map((s, i) => ({ slot: s, version: versions[i], live: true })),
  );

  // Envoy started again and lost slot 3 (it read an older file): the next sync writes it again.
  first.envoy.active.delete("slot-3");
  await second.control.syncAll();
  assert.ok(first.envoy.active.has("slot-3"));

  // While Envoy does not answer, a sync does not make a slot live, and the pod is not ready.
  const third = await rig({ root: first.root, api: first.api, envoy: first.envoy });
  first.envoy.down = true;
  await third.control.syncAll();
  assert.equal(third.control.ready(), false);
  assert.equal(third.control.status(3).live, false);
  assert.match(third.control.status(3).error ?? "", /did not take/);
  first.envoy.down = false;
  first.envoy.restart();
  await third.control.syncAll();
  assert.equal(third.control.ready(), true);
  assert.equal(third.control.status(3).live, true);
  assertNoSecret([...first.lines, ...second.lines, ...third.lines]);
});

test("a slot whose listener Envoy refuses is written out and is not live; the version is not tried again; the other slots are live", async () => {
  const { api, envoy, lines, control } = await rig();
  instance(api);
  await control.syncAll();
  // A value that Envoy's program refuses (ADR-0059): the new listener is refused, the old one stays.
  envoy.refuse = (l) => l.name === "slot-3";
  api.secrets.set("gh", b64data({ token: "ghp_REFUSED_VALUE_0006" }));
  SECRET_TEXTS.push("ghp_REFUSED_VALUE_0006");
  await control.syncAll();

  const s = control.status(3);
  assert.equal(s.live, false);
  assert.match(s.error ?? "", /refused/);
  assert.equal(envoy.active.has("slot-3"), false, "the old rules do not stay active");
  assert.equal(control.status(0).live, true);
  assert.equal(control.ready(), true, "a refused slot does not hold the pod back");
  assert.ok(lines.some((l) => l.startsWith("jr2.custodian refuse slot=3 sandbox=ws-3 ") && l.endsWith("reason=envoy")));

  const count = lines.length;
  await control.syncAll();
  assert.equal(lines.length, count, "the same version is not tried again");

  envoy.refuse = () => false;
  api.secrets.set("gh", b64data({ token: "ghp_FIXED_VALUE_0007" }));
  SECRET_TEXTS.push("ghp_FIXED_VALUE_0007");
  await control.syncAll();
  assert.equal(control.status(3).live, true);
  assertNoSecret(lines);
});

test("rules that cannot be made remove the slot with a reason: a missing value, a malformed slot Secret, a rule the Fence cannot carry", async () => {
  const { api, envoy, lines, control } = await rig();
  instance(api);
  await control.syncAll();

  api.secrets.set("jr2-held-secrets-ws-3", b64data({ ANTHROPIC_API_KEY: "sk-ant-REAL-VALUE-0001" }));
  await control.syncAll();
  assert.equal(envoy.active.has("slot-3"), false);
  assert.match(
    control.status(3).error ?? "",
    /value of LOCAL_KEY is missing: no key LOCAL_KEY in the Secret jr2-held-secrets-ws-3/,
  );
  assert.ok(
    lines.some((l) => l.startsWith("jr2.custodian refuse slot=3 sandbox=ws-3 reason=rules why=the value of LOCAL_KEY")),
  );

  api.secrets.set(
    "jr2-held-secrets-ws-3",
    b64data({ ANTHROPIC_API_KEY: "sk-ant-REAL-VALUE-0001", LOCAL_KEY: "local-REAL-VALUE-0002" }),
  );
  api.secrets.set("jr2-custodian-slot-4", { [SLOT_SPEC_KEY]: b64("{") });
  const bad = sandboxSpec();
  bad.manifest = { ...bad.manifest, egress: [...bad.manifest.egress, { ...bad.manifest.egress[0]! }] };
  api.secrets.set("jr2-custodian-slot-5", slotSecret(5, { ...bad, owner: { sandbox: "ws-5" } }));
  await control.syncAll();
  assert.match(control.status(4).error ?? "", /slot\.json is not JSON/);
  assert.match(control.status(5).error ?? "", /in the manifest twice/);
  assert.equal(envoy.active.has("slot-5"), false);
  assert.equal(control.status(0).live, true);
  assert.equal(control.status(3).live, true, "the value is back, and so are the slot's rules");
  assertNoSecret(lines);
});

test("a slot Secret that cannot be read now keeps the rules the slot has, and says it is not known to be live", async () => {
  const { api, envoy, control } = await rig();
  instance(api);
  await control.syncAll();
  const version = control.status(3).version;
  api.failing.add("gh");
  await control.syncAll();
  assert.ok(envoy.active.get("slot-3")!.filter_chains.some((c) => c.name.includes(rulesChainName(version!))));
  assert.equal(control.status(3).live, false);
  assert.match(control.status(3).error ?? "", /the Secret gh cannot be read: KubeError:503/);
  api.failing.clear();
  await control.syncAll();
  assert.deepEqual(control.status(3), { slot: 3, version, live: true });
});

test("the API takes the dial token alone: no token or another gets 401; GET states the slot and whether a pod is there; POST syncs the slot now", async () => {
  const { root, api, lines, present, control } = await rig();
  instance(api);
  await control.syncAll();

  for (const token of [undefined, "another-token", `${DIAL}x`]) {
    for (const method of ["GET", "POST"]) {
      const res = await call(control, method, "/slots/3", token);
      assert.equal(res.status, 401);
      assert.match(await res.text(), /dial token/);
    }
  }
  assert.ok(lines.includes("jr2.custodian control action=refuse slot=3 reason=dial"));
  assert.equal((await call(control, "GET", "/slots/128", DIAL)).status, 404);
  assert.equal((await call(control, "GET", "/slots/03", DIAL)).status, 404);
  assert.equal((await call(control, "GET", "/other", DIAL)).status, 404);
  assert.equal((await call(control, "DELETE", "/slots/3", DIAL)).status, 405);

  present.add(3);
  const got = await call(control, "GET", "/slots/3", DIAL);
  assert.equal(got.status, 200);
  assert.deepEqual(await got.json(), { ...control.status(3), present: true });
  assert.deepEqual(await (await call(control, "GET", "/slots/7", DIAL)).json(), {
    slot: 7,
    version: null,
    live: false,
    present: false,
  });

  // A new slot is live when POST answers: no wait for the next resync.
  api.secrets.set("jr2-custodian-slot-7", slotSecret(7, { ...sandboxSpec(), owner: { sandbox: "ws-7" } }));
  const posted = (await (await call(control, "POST", "/slots/7", DIAL)).json()) as { live: boolean; version: string };
  assert.equal(posted.live, true);
  assert.match(posted.version, /^[0-9a-f]{16}$/);
  assert.deepEqual(
    lds(root).resources.map((l) => l.name),
    ["slot-0", "slot-3", "slot-7"],
  );
  assertNoSecret(lines);
});

test("the slot Secret's format: a spec and the files of values/ and tls/ alone, with a reason that names a key", () => {
  const files = new Map([
    ["values/JR2_CONTROL_TOKEN", "t"],
    ["tls/abc.crt", "c"],
  ]);
  const data = b64data(slotSecretData(sandboxSpec(), files));
  assert.deepEqual(Object.keys(data).sort(), ["slot.json", "tls.abc.crt", "values.JR2_CONTROL_TOKEN"]);
  const back = readSlotSecret(data);
  assert.deepEqual(back.spec, sandboxSpec());
  assert.deepEqual([...back.files.keys()].sort(), ["tls/abc.crt", "values/JR2_CONTROL_TOKEN"]);

  assert.throws(() => slotSecretData(sandboxSpec(), new Map([["../x", "v"]])), /values\/ and tls\/ alone/);
  assert.throws(() => slotSecretData(sandboxSpec(), new Map([["values/..", "v"]])), /not a file name/);
  assert.throws(() => readSlotSecret({ ...data, "values...": b64("v") }), /key values\.\.\. is not a file/);
  assert.throws(() => readSlotSecret({ ...data, "other.x": b64("v") }), /key other\.x is not a file/);
  assert.throws(() => readSlotSecret({ "values.x": b64("v") }), /has no slot\.json/);
  const owner = { ...sandboxSpec(), owner: { sandbox: "Not A Name" } };
  assert.throws(() => readSlotSecret({ [SLOT_SPEC_KEY]: b64(JSON.stringify(owner)) }), /not a slot spec: owner/);
});

test("present: the neighbour table says a slot's address was resolved on its own interface", () => {
  const table = [
    "IP address       HW type     Flags       HW address            Mask     Device",
    "198.19.0.5       0x1         0x2         02:00:00:00:00:05     *        v3",
    "198.19.0.6       0x1         0x0         00:00:00:00:00:00     *        v4",
    "198.19.0.7       0x1         0x2         02:00:00:00:00:07     *        eth0",
  ].join("\n");
  assert.equal(neighbourResolved(table, "198.19.0.5", "v3"), true);
  assert.equal(neighbourResolved(table, "198.19.0.6", "v4"), false, "an address that was asked for and never answered");
  assert.equal(neighbourResolved(table, "198.19.0.7", "v5"), false, "on another interface");
  assert.equal(neighbourResolved(table, "198.19.0.9", "v7"), false);
});
