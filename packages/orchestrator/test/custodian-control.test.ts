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
import { custodianControl, neighbourSays, resolverTables, type CustodianControl } from "../src/custodian-control.ts";
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
  /** Names that the Role does not list: the API answers 403. */
  forbidden: Set<string>;
  gets: string[];
  kube: Parameters<typeof custodianControl>[0]["kube"];
};

function fakeApi(): FakeApi {
  const secrets = new Map<string, Record<string, string>>();
  const failing = new Set<string>();
  const forbidden = new Set<string>();
  const gets: string[] = [];
  return {
    secrets,
    failing,
    forbidden,
    gets,
    kube: {
      get: async <T>(kind: { plural: string }, namespace: string, name: string) => {
        assert.equal(kind.plural, "secrets", "the Custodian reads Secrets alone");
        assert.equal(namespace, NS);
        gets.push(name);
        if (failing.has(name)) throw new KubeError(503, "ServiceUnavailable", "the API did not answer");
        if (forbidden.has(name)) throw new KubeError(403, "Forbidden", "the Role does not list this name");
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

async function rig(opts: { root?: string; api?: FakeApi; envoy?: FakeEnvoy; liveTimeoutMs?: number } = {}) {
  const root = opts.root ?? (await mkdtemp(join(tmpdir(), "custodian-control-")));
  roots.push(root);
  const api = opts.api ?? fakeApi();
  const envoy = opts.envoy ?? fakeEnvoy(root);
  const lines: string[] = [];
  const resolver = resolverTables();
  const present = new Set<number>();
  /** The slots whose check of the VLAN throws, as when the pod's own output to the address fails. */
  const blind = new Set<number>();
  const control = custodianControl({
    kube: api.kube,
    namespace: NS,
    ranges: RANGES,
    range: 0,
    admin: envoy.admin,
    root,
    resolver,
    present: async (slot) => {
      if (blind.has(slot)) throw new Error("connect ENETUNREACH");
      return present.has(slot);
    },
    log: (line) => lines.push(line),
    liveTimeoutMs: opts.liveTimeoutMs ?? 1_000,
  });
  return { root, api, envoy, lines, resolver, present, blind, control };
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
  assert.deepEqual(control.status(5), { slot: 5, version: null, live: false, active: null });
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

  assert.deepEqual(control.status(3), { slot: 3, version: null, live: false, active: null });
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
    [0, 3].map((s, i) => ({ slot: s, version: versions[i], live: true, active: versions[i] })),
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

test("a slot whose listener Envoy refuses is written out and is not live, and its resolver table goes; the version is not tried again; the other slots are live", async () => {
  const { api, envoy, lines, resolver, control } = await rig();
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
  assert.equal(resolver.get(3), undefined, "the slot's names stop answering with its listener");
  assert.equal(s.active, null);
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

  // Refused again, then the Secret is deleted: no table of the slot is left.
  envoy.refuse = (l) => l.name === "slot-3";
  api.secrets.set("gh", b64data({ token: "ghp_REFUSED_VALUE_0008" }));
  SECRET_TEXTS.push("ghp_REFUSED_VALUE_0008");
  await control.syncAll();
  assert.equal(resolver.get(3), undefined);
  api.secrets.delete("jr2-custodian-slot-3");
  await control.syncAll();
  assert.equal(resolver.get(3), undefined);
  assert.deepEqual(control.status(3), { slot: 3, version: null, live: false, active: null });
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

test("a slot Secret that cannot be read now keeps the rules the slot has, says it is not known to be live, and states the version that Envoy holds", async () => {
  const { api, envoy, control } = await rig();
  instance(api);
  await control.syncAll();
  const version = control.status(3).version;
  api.failing.add("gh");
  await control.syncAll();
  assert.ok(envoy.active.get("slot-3")!.filter_chains.some((c) => c.name.includes(rulesChainName(version!))));
  assert.equal(control.status(3).live, false);
  assert.equal(control.status(3).active, version);
  assert.match(control.status(3).error ?? "", /the Secret gh cannot be read: KubeError:503/);
  const got = (await (await call(control, "GET", "/slots/3", DIAL)).json()) as { active: string; live: boolean };
  assert.equal(got.active, version);
  assert.equal(got.live, false);

  // The slot Secret itself cannot be read: the same.
  api.failing.add("jr2-custodian-slot-3");
  await control.syncAll();
  assert.equal(control.status(3).active, version);
  assert.ok(envoy.active.has("slot-3"));
  api.failing.clear();
  await control.syncAll();
  assert.deepEqual(control.status(3), { slot: 3, version, live: true, active: version });
});

test("a slot given to another Harness pod while that pod's values cannot be read: the old pod's rules go, and no status hides them", async () => {
  const { api, envoy, lines, resolver, control } = await rig();
  instance(api);
  await control.syncAll();
  assert.equal(control.status(3).live, true);

  // Slot 3 is given again: its Secret now names ws-new, whose literal values the API does not give.
  api.secrets.set(
    "jr2-custodian-slot-3",
    slotSecret(3, { ...sandboxSpec(), owner: { sandbox: "ws-new" }, heldPod: "ws-new" }),
  );
  api.failing.add("jr2-held-secrets-ws-new");
  const posted = (await (await call(control, "POST", "/slots/3", DIAL)).json()) as Record<string, unknown>;
  assert.equal(envoy.active.has("slot-3"), false, "the old pod's listener is gone");
  assert.equal(resolver.get(3), undefined);
  assert.deepEqual(
    { ...posted, error: undefined },
    { slot: 3, version: null, live: false, active: null, error: undefined },
  );
  assert.match(posted.error as string, /the Secret jr2-held-secrets-ws-new cannot be read: KubeError:503/);
  assert.ok(lines.includes("jr2.custodian removed slot=3 sandbox=ws-3"), lines.join("\n"));
  const got = (await (await call(control, "GET", "/slots/3", DIAL)).json()) as { active: unknown };
  assert.equal(got.active, null);

  // The full sync agrees, and the pod is not ready-blocked by others: slot 0 stays live.
  await control.syncAll();
  assert.equal(envoy.active.has("slot-3"), false);
  assert.equal(control.status(0).live, true);
  api.secrets.set("jr2-held-secrets-ws-new", api.secrets.get("jr2-held-secrets-ws-3")!);
  api.failing.clear();
  await control.syncAll();
  assert.equal(control.status(3).live, true);
  assert.ok(lines.some((l) => l.startsWith("jr2.custodian ready slot=3 sandbox=ws-new ")));
  assertNoSecret(lines);
});

test("one bad slot Secret is refused alone: a binding with no source, or a value Secret that the Role does not list (403); the sync goes on, a deleted slot is removed, and a new pod becomes ready", async () => {
  const first = await rig();
  instance(first.api);
  first.api.secrets.set("jr2-custodian-slot-5", slotSecret(5, { ...sandboxSpec(), owner: { sandbox: "ws-5" } }));
  first.api.secrets.set("jr2-held-secrets-ws-5", first.api.secrets.get("jr2-held-secrets-ws-3")!);
  await first.control.syncAll();
  assert.equal(first.control.status(5).live, true);

  const bad = sandboxSpec();
  const [one, ...rest] = bad.manifest.secrets;
  const { source: _gone, ...noSource } = one!;
  bad.manifest = { ...bad.manifest, secrets: [noSource as typeof one, ...rest] as typeof bad.manifest.secrets };
  first.api.secrets.set("jr2-custodian-slot-4", slotSecret(4, { ...bad, owner: { sandbox: "ws-4" } }));
  first.api.secrets.set("jr2-custodian-slot-6", slotSecret(6, { ...sandboxSpec(), owner: { sandbox: "ws-6" } }));
  first.api.forbidden.add("gh");
  first.api.secrets.delete("jr2-custodian-slot-5");
  await first.control.syncAll();

  assert.match(first.control.status(4).error ?? "", /not a slot spec: manifest\.secrets\.0\.source/);
  assert.match(first.control.status(3).error ?? "", /the Secret gh cannot be read: KubeError:403/);
  assert.equal(first.envoy.active.has("slot-3"), false, "a lasting refusal removes the slot");
  assert.equal(first.envoy.active.has("slot-5"), false, "the deleted slot is removed in the same sync");
  assert.equal(first.control.status(0).live, true);
  assert.ok(first.lines.some((l) => l.startsWith("jr2.custodian refuse slot=4 reason=rules why=slot.json is not")));
  assert.ok(
    first.lines.some((l) => l.startsWith("jr2.custodian refuse slot=3 sandbox=ws-3 reason=rules why=the Secret gh")),
  );

  // A new control process over the same Secrets is ready.
  const second = await rig({ api: first.api });
  await second.control.syncAll();
  assert.equal(second.control.ready(), true);
  assert.equal(second.control.status(0).live, true);
  assertNoSecret([...first.lines, ...second.lines]);
});

test("a slot that went while the control process was down: the first sync removes its folder of values, with a line", async () => {
  const first = await rig();
  instance(first.api);
  await first.control.syncAll();
  first.api.secrets.delete("jr2-custodian-slot-3");

  const second = await rig({ root: first.root, api: first.api, envoy: first.envoy });
  await second.control.syncAll();
  assert.equal(existsSync(at(first.root, slotFolder(3))), false);
  assert.equal(existsSync(at(first.root, slotFolder(0))), true);
  assert.equal(first.envoy.active.has("slot-3"), false);
  assert.ok(second.lines.includes("jr2.custodian removed slot=3"), second.lines.join("\n"));
  assertNoSecret(second.lines);
});

test("a check pod's slot names no pod of values: each literal's value is the slot Secret's own values.<NAME>, and a missing one is refused", async () => {
  const { root, api, envoy, lines, control } = await rig();
  instance(api);
  const check: SlotSpec = { ...sandboxSpec(), owner: { pod: "check-1" } };
  delete check.heldPod;
  const data = slotSecret(6, check);
  data["values.ANTHROPIC_API_KEY"] = b64("sk-ant-CHECK-VALUE-0008");
  data["values.LOCAL_KEY"] = b64("local-CHECK-VALUE-0009");
  SECRET_TEXTS.push("sk-ant-CHECK-VALUE-0008", "local-CHECK-VALUE-0009");
  api.secrets.set("jr2-custodian-slot-6", data);
  await control.syncAll();
  assert.equal(control.status(6).live, true, JSON.stringify(control.status(6)));
  const folder = at(root, slotFolder(6));
  assert.equal(await readFile(join(folder, "values", "ANTHROPIC_API_KEY"), "utf8"), "sk-ant-CHECK-VALUE-0008");
  assert.ok(!api.gets.includes("jr2-held-secrets-check-1"));

  delete data["values.LOCAL_KEY"];
  await control.syncAll();
  assert.equal(envoy.active.has("slot-6"), false);
  assert.match(
    control.status(6).error ?? "",
    /value of LOCAL_KEY is missing: no key values\.LOCAL_KEY in the slot Secret/,
  );
  assertNoSecret(lines);
});

test("the dial token: one trailing line end is taken off, as Envoy's role does; a changed token replaces the old one; with no token, the pod is not ready", async () => {
  const { root, api, lines, control } = await rig();
  instance(api);
  api.secrets.delete("jr2-custodian-dial");
  await control.syncAll();
  assert.equal(control.ready(), false, "no dial token: not ready");
  assert.equal((await call(control, "GET", "/healthz")).status, 503);
  assert.ok(lines.includes("jr2.custodian control action=read secret=jr2-custodian-dial error=no-token"));

  api.secrets.set("jr2-custodian-dial", b64data({ token: "\r\n" }));
  await control.syncAll();
  assert.equal(control.ready(), false, "an empty token: not ready");
  assert.ok(lines.includes("jr2.custodian control action=read secret=jr2-custodian-dial error=empty-token"));

  api.secrets.set("jr2-custodian-dial", b64data({ token: `${DIAL}\n` }));
  await control.syncAll();
  assert.equal(control.ready(), true);
  assert.equal(await readFile(join(root, "dial-token"), "utf8"), DIAL);
  assert.equal((await call(control, "GET", "/slots/3", DIAL)).status, 200);

  api.secrets.set("jr2-custodian-dial", b64data({ token: `${DIAL}-2\r\n` }));
  await control.syncAll();
  assert.equal(await readFile(join(root, "dial-token"), "utf8"), `${DIAL}-2`);
  assert.equal((await call(control, "GET", "/slots/3", `${DIAL}-2`)).status, 200);
  assert.equal((await call(control, "GET", "/slots/3", DIAL)).status, 401, "the old token is refused");
  assertNoSecret(lines);
});

test("the slot API answers 503 until the first full sync has ended: Envoy may hold rules that the process does not know yet", async () => {
  const first = await rig();
  instance(first.api);
  await first.control.syncAll();
  const version = first.control.status(3).version;

  // A new control process, while Envoy does not answer: its first sync has read the token and waits.
  const second = await rig({ root: first.root, api: first.api, envoy: first.envoy });
  first.envoy.down = true;
  const syncing = second.control.syncAll();
  await new Promise((r) => setTimeout(r, 200));
  for (const method of ["GET", "POST"]) {
    const res = await call(second.control, method, "/slots/3", DIAL);
    assert.equal(res.status, 503, method);
    assert.match(await res.text(), /first sync/);
  }
  await syncing;
  // Written and not yet seen: the version that Envoy may take is stated.
  const got = (await (await call(second.control, "GET", "/slots/3", DIAL)).json()) as { active: string; live: boolean };
  assert.deepEqual([got.active, got.live], [version, false]);
  first.envoy.down = false;
  await second.control.syncAll();
  assert.equal(second.control.status(3).live, true);
});

test("run ends at once when its signal aborts, also while it waits for an Envoy that does not answer", async () => {
  const { api, envoy, control } = await rig({ liveTimeoutMs: 30_000 });
  instance(api);
  envoy.down = true;
  const stop = new AbortController();
  const running = control.run(stop.signal);
  await new Promise((r) => setTimeout(r, 200));
  const t = performance.now();
  stop.abort();
  await running;
  assert.ok(performance.now() - t < 1_000, `run ended ${Math.round(performance.now() - t)} ms after the abort`);
});

test("a VLAN range that has no VLANs is refused at start", async () => {
  const api = fakeApi();
  assert.throws(
    () => custodianControl({ kube: api.kube, namespace: NS, ranges: RANGES, range: 31, admin: async () => "" }),
    /VLAN range 31 is not 0 … 30/,
  );
});

test("the API takes the dial token alone: no token or another gets 401; GET states the slot and whether a pod is there; POST syncs the slot now", async () => {
  const { root, api, lines, present, blind, control } = await rig();
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
    active: null,
    present: false,
  });
  // A check that fails says nothing of the VLAN: no `present`, never `false`.
  blind.add(7);
  assert.deepEqual(await (await call(control, "GET", "/slots/7", DIAL)).json(), {
    slot: 7,
    version: null,
    live: false,
    active: null,
  });
  blind.delete(7);

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

test("present: the neighbour table says a slot's address was resolved, or asked for with no answer, on its own interface", () => {
  const table = [
    "IP address       HW type     Flags       HW address            Mask     Device",
    "198.19.0.5       0x1         0x2         02:00:00:00:00:05     *        v3",
    "198.19.0.6       0x1         0x0         00:00:00:00:00:00     *        v4",
    "198.19.0.7       0x1         0x2         02:00:00:00:00:07     *        eth0",
    "198.19.0.8       0x1         0x4         02:00:00:00:00:08     *        v6",
  ].join("\n");
  assert.equal(neighbourSays(table, "198.19.0.5", "v3"), true);
  assert.equal(neighbourSays(table, "198.19.0.6", "v4"), false, "an address that was asked for and never answered");
  assert.equal(neighbourSays(table, "198.19.0.7", "v5"), undefined, "on another interface: nothing of v5");
  assert.equal(neighbourSays(table, "198.19.0.9", "v7"), undefined, "no entry: no ARP request went out");
  assert.equal(neighbourSays(table, "198.19.0.8", "v6"), undefined, "other flags say nothing");
});
