// The control process of a Custodian pod (ADR-0084) against the pinned Envoy: what a fake admin
// cannot show. The process reads slot Secrets from a fake API and writes the state folder that the
// Envoy container reads, as the `control` container does in the pod. It says a slot is live only when
// Envoy's own admin shows the chain of the version of its rules; a refused listener and a removed
// slot are read from the same admin. Envoy's admin is moved off loopback so that the test reaches it.
//
// Opt-in: `just custodian-test` (docker + the pinned image).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import {
  CA_MOUNT,
  CUSTODIAN_POD_ARGS,
  CUSTODIAN_POD_BOOTSTRAP,
  CUSTODIAN_POD_PROGRAM,
  CUSTODIAN_PROGRAM,
  CUSTODIAN_STATE,
  custodianControl,
  custodianPodBootstrap,
  custodianRef,
  custodianXds,
  CUSTODIAN_INBOUND_PORT,
  JR2_CUSTODIAN_NAME,
  leafStem,
  slotSecretData,
  type SlotInputs,
  type SlotSpec,
} from "@jr2/orchestrator/internal";
import { RANGES, THREE_SLOTS } from "./support/custodian-slots.ts";
import { issueCa, issueLeaf, trustBundles } from "../src/held-pki.ts";

const exec = promisify(execFile);
const roots: string[] = [];
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const b64 = (text: string) => Buffer.from(text).toString("base64");
const b64data = (data: Record<string, string>) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)]));

/** The slot Secret of one of the three slots, with real leaves. */
function slotSecret(inputs: SlotInputs, ca: ReturnType<typeof issueCa>): Record<string, string> {
  const files = new Map<string, string>();
  files.set("values/JR2_CONTROL_TOKEN", `control-token-${inputs.slot}`);
  files.set("values/JR2_CONTROL_TOKEN.standin", `control-standin-${inputs.slot}`);
  if ("sandbox" in inputs.owner) files.set("values/JR2_SANDBOX_TOKEN", `fetch-token-${inputs.slot}`);
  for (const s of inputs.manifest.secrets) files.set(`values/${s.name}.standin`, `jr2-held-${s.name}.${inputs.slot}`);
  for (const { host, port } of [
    { host: JR2_CUSTODIAN_NAME, port: 443 },
    ...inputs.manifest.egress.filter((r) => r.intercept && r.port !== 80),
  ]) {
    const leaf = issueLeaf(ca, host);
    files.set(`tls/${leafStem(host, port)}.crt`, leaf.cert);
    files.set(`tls/${leafStem(host, port)}.key`, leaf.key);
  }
  const spec: SlotSpec = {
    version: 1,
    owner: inputs.owner,
    manifest: inputs.manifest,
    placeholders: inputs.placeholders,
    heldPod: `pod-${inputs.slot}`,
  };
  return b64data(slotSecretData(spec, files));
}

test("the control process makes each slot's rules live in the pinned Envoy, takes a changed value live, writes out a slot whose listener Envoy refuses, removes a slot whose Secret is gone, and a restarted Envoy serves each slot again from the files", async () => {
  const root = await mkdtemp(join(tmpdir(), "jr2-custodian-control-"));
  roots.push(root);
  const etc = (path: string) => join(root, "etc", path.slice("/etc/jr2".length));
  const put = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, { mode: 0o644 });
  };
  const ca = issueCa("custodian-control");
  await put(etc(CUSTODIAN_POD_PROGRAM), CUSTODIAN_PROGRAM);
  await put(etc(`${CA_MOUNT}/upstream.crt`), trustBundles(ca.cert).upstream);
  const bootstrap = custodianPodBootstrap({
    orchestrator: { host: "orchestrator.invalid", port: 4000 },
    range: 0,
    ranges: RANGES,
  }) as {
    admin: { address: { socket_address: { address: string } } };
  };
  bootstrap.admin.address.socket_address.address = "0.0.0.0";
  await put(etc(CUSTODIAN_POD_BOOTSTRAP), JSON.stringify(bootstrap));
  await put(join(root, "resolv.conf"), "nameserver 127.0.0.1\n");
  // Envoy does not start without its two files: the pod's init container writes them with no slot,
  // and the control process writes each file after that.
  const empty = custodianXds([]);
  await put(join(root, "state", "xds", "lds.json"), JSON.stringify(empty.lds));
  await put(join(root, "state", "xds", "cds.json"), JSON.stringify(empty.cds));

  // The fake API: the dial token, each slot's Secret, and each pod's literal values.
  const secrets = new Map<string, Record<string, string>>();
  secrets.set("jr2-custodian-dial", b64data({ token: "dial-token" }));
  for (const inputs of THREE_SLOTS) {
    secrets.set(`jr2-custodian-slot-${inputs.slot}`, slotSecret(inputs, ca));
    const literal = inputs.manifest.secrets.filter((s) => s.source.kind === "literal").map((s) => s.name);
    secrets.set(
      `jr2-held-secrets-pod-${inputs.slot}`,
      b64data(Object.fromEntries(literal.map((n) => [n, `value-${n}`]))),
    );
  }
  secrets.set("gh", b64data({ token: "ghp-value-1" }));

  const name = `jr2-custodian-control-${process.pid}-${Date.now() % 100000}`;
  const gid = String(process.getgid?.() ?? 0);
  const start = () =>
    // prettier-ignore
    exec("docker", [
      "run", "-d", "--name", name, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", `65532:${gid}`, "--group-add", gid,
      "-v", `${join(root, "etc")}:/etc/jr2:ro`, "-v", `${join(root, "state")}:${CUSTODIAN_STATE}:ro`,
      "-v", `${join(root, "resolv.conf")}:/etc/resolv.conf:ro`,
      custodianRef(), ...CUSTODIAN_POD_ARGS,
    ]);
  await start();
  try {
    const ip = (
      await exec("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name])
    ).stdout.trim();
    const admin = async (path: string) => {
      const res = await fetch(`http://${ip}:15000${path}`);
      if (!res.ok) throw new Error(`admin ${res.status}`);
      return res.text();
    };
    const lines: string[] = [];
    const control = custodianControl({
      kube: {
        get: async <T>(_kind: unknown, _ns: string, n: string) =>
          (secrets.has(n) ? { metadata: { name: n }, data: secrets.get(n) } : undefined) as T | undefined,
      },
      namespace: "ns",
      ranges: RANGES,
      range: 0,
      admin,
      root: join(root, "state"),
      log: (l) => lines.push(l),
      liveTimeoutMs: 10_000,
    });
    const logs = async () => {
      const r = await exec("docker", ["logs", name], { maxBuffer: 1 << 24 });
      return r.stdout + r.stderr;
    };
    const active = async (slot: number) =>
      (
        JSON.parse(await admin(`/config_dump?resource=dynamic_listeners&name_regex=^slot-${slot}$`)) as {
          configs?: Array<{ active_state?: unknown }>;
        }
      ).configs?.some((c) => c.active_state !== undefined) ?? false;

    // Envoy may not answer yet: the run loop syncs again until each slot is live.
    let t = performance.now();
    for (let i = 0; i < 5 && !control.ready(); i++) await control.syncAll();
    const first = performance.now() - t;
    assert.equal(control.ready(), true, `${lines.join("\n")}\n${await logs()}`);
    for (const slot of [0, 1, 3]) assert.equal(control.status(slot).live, true, JSON.stringify(control.status(slot)));

    // A changed value: a new version, live by Envoy's admin.
    const before = control.status(3).version;
    secrets.set("gh", b64data({ token: "ghp-value-2" }));
    t = performance.now();
    const changed = await control.syncSlot(3);
    const update = performance.now() - t;
    assert.equal(changed.live, true);
    assert.notEqual(changed.version, before);

    // A value that the program refuses: Envoy refuses the listener and keeps the old one; the
    // control process writes the slot out, and the other slots stay live.
    secrets.set("gh", b64data({ token: "ghp-bad\rvalue" }));
    const refused = await control.syncSlot(3);
    assert.equal(refused.live, false);
    assert.match(refused.error ?? "", /Envoy refused/);
    assert.equal(await active(3), false, "the old rules of the slot are not left active");
    assert.match(await logs(), /jr2\.custodian refuse secret=GH_TOKEN reason=value-not-printable-ascii/);
    assert.ok(
      lines.some((l) => /^jr2\.custodian refuse slot=3 sandbox=ticket-a1b2c version=\w+ reason=envoy$/.test(l)),
    );
    assert.equal(control.status(0).live, true);
    secrets.set("gh", b64data({ token: "ghp-value-3" }));
    assert.equal((await control.syncSlot(3)).live, true);

    // A Secret gone: the slot is removed from Envoy.
    secrets.delete("jr2-custodian-slot-1");
    assert.deepEqual(await control.syncSlot(1), { slot: 1, version: null, live: false, active: null });
    assert.equal(await active(1), false);

    // The dial token: Envoy's inbound role and the control API take the same one, also after it
    // changes. The target is no slot, so a dial that passes the token check is refused for its
    // target, and nothing is dialed.
    const dial = async (token: string) => {
      const res = await fetch(`http://${ip}:${CUSTODIAN_INBOUND_PORT}/healthz`, {
        headers: { "x-jr2-dial": token, "x-jr2-target": "10.1.2.3:8080" },
      });
      const body = await res.text();
      return /needs the dial token/.test(body) ? "token" : /not port 8080 or 8082/.test(body) ? "target" : body;
    };
    const api = async (token: string) =>
      (await control.fetch(new Request("http://c/slots/3", { headers: { "x-jr2-dial": token } }))).status;
    assert.equal(await dial("dial-token"), "target");
    assert.equal(await api("dial-token"), 200);
    secrets.set("jr2-custodian-dial", b64data({ token: "dial-token-2\n" }));
    await control.syncAll();
    assert.equal(await dial("dial-token"), "token", "the old token is refused at the next dial");
    assert.equal(await api("dial-token"), 401);
    assert.equal(await dial("dial-token-2"), "target");
    assert.equal(await api("dial-token-2"), 200);

    // Envoy's container starts again and reads the files that the control process wrote: each slot
    // that was live is live again, and a sync finds nothing to write.
    await exec("docker", ["restart", name]);
    for (
      let i = 0;
      i < 200 &&
      !(await admin("/ready").then(
        () => true,
        () => false,
      ));
      i++
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await control.syncAll();
    assert.equal(await active(3), true);
    assert.equal(control.status(3).live, true);
    for (const l of lines) assert.doesNotMatch(l, /value-|ghp-|token-|standin-|dial-token/, l);
    console.log(
      `jr2.custodian-control: first sync of 3 slots ${Math.round(first)} ms, one slot's update ${Math.round(update)} ms`,
    );
  } finally {
    await exec("docker", ["rm", "-f", name]).catch(() => {});
  }
});
