// A Sandbox's objects on the Fence (ADR-0084, ADR-0059): the slot Secret that the Custodian reads, the
// trust ConfigMap and the Stand-in Secret that the pod mounts, and the CR that names the slot's
// attachment with no Custodian container. Pinned: the slot Secret's keys and owner, that the
// Custodian's renderer finds a leaf for each TLS chain, that each leaf chains to the CA that the pod
// trusts, that no object holds the CA's key, the placeholder table's growth, and the CR's Fence part.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { renderSlot } from "../src/custodian-rules.ts";
import { readSlotSecret, SLOT_SPEC_KEY } from "../src/custodian-slot.ts";
import { JR2_CUSTODIAN_NAME } from "../src/custodian.ts";
import { CONTROL_TOKEN_NAME, heldStandIn, leafStem, SANDBOX_TOKEN_NAME } from "../src/held-secrets.ts";
import { checkAppendOnly, placeholderOf } from "../src/placeholders.ts";
import { fenceComposition, FENCE_CUSTODIAN_URL, leafTargets, sandboxFenceObjects } from "../src/sandbox-fence.ts";
import { sandboxCr, sandboxEffectorContainer } from "../src/sandbox-kube.ts";
import { resolveSize, splitSize } from "../src/size.ts";
import { controlStandIn, controlToken, sandboxToken } from "../src/tokens.ts";
import { RANGES, rule, SANDBOX_MANIFEST } from "./_custodian-slots.ts";

const KEY = Buffer.from("the-signing-key-of-the-instance");
const UID = "6f1c0d6e-0000-4000-8000-000000000003";

const objectsOf = (over: Partial<Parameters<typeof sandboxFenceObjects>[0]> = {}) =>
  sandboxFenceObjects({
    namespace: "jr2-test",
    sandbox: "ws-3",
    uid: UID,
    slot: 7,
    manifest: SANDBOX_MANIFEST,
    heldPod: "ws-abc",
    ranges: RANGES,
    signingKey: KEY,
    ...over,
  });

const text = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

test("the slot Secret: its name, its labels, the CR as its owner, and a key for each file of the slot", () => {
  const { slotSecret } = objectsOf();
  assert.equal(slotSecret.kind, "Secret");
  assert.deepEqual(slotSecret.metadata, {
    name: "jr2-custodian-slot-7",
    namespace: "jr2-test",
    labels: { "jr2.dev/sandbox": "ws-3", "jr2.dev/fence-slot": "7" },
    ownerReferences: [
      {
        apiVersion: "core.jr2.dev/v1alpha1",
        kind: "Sandbox",
        name: "ws-3",
        uid: UID,
        controller: true,
        blockOwnerDeletion: false,
      },
    ],
  });
  const stems = leafTargets(SANDBOX_MANIFEST).map((t) => leafStem(t.host, t.port));
  assert.deepEqual(
    Object.keys(slotSecret.data).sort(),
    [
      SLOT_SPEC_KEY,
      `values.${CONTROL_TOKEN_NAME}`,
      `values.${CONTROL_TOKEN_NAME}.standin`,
      `values.${SANDBOX_TOKEN_NAME}`,
      "values.ANTHROPIC_API_KEY.standin",
      "values.GH_TOKEN.standin",
      "values.LOCAL_KEY.standin",
      ...stems.flatMap((s) => [`tls.${s}.crt`, `tls.${s}.key`]),
    ].sort(),
  );
  // No held value is in it: the values are in `jr2-held-secrets-<pod>` and the user's Secrets.
  assert.ok(!Object.keys(slotSecret.data).some((k) => /^values\.(ANTHROPIC_API_KEY|GH_TOKEN|LOCAL_KEY)$/.test(k)));
});

test("the slot Secret's values are the Sandbox's signed tokens and Stand-ins, and its spec names the Sandbox", () => {
  const { slotSecret } = objectsOf();
  const { spec, files } = readSlotSecret(slotSecret.data);
  assert.deepEqual(spec.owner, { sandbox: "ws-3" });
  assert.equal(spec.heldPod, "ws-abc", "the manifest holds a literal");
  assert.deepEqual(spec.manifest, SANDBOX_MANIFEST);
  const value = (path: string) => files.get(path)?.toString("utf8");
  assert.equal(value(`values/${CONTROL_TOKEN_NAME}`), controlToken(KEY, "ws-3"));
  assert.equal(value(`values/${CONTROL_TOKEN_NAME}.standin`), controlStandIn(KEY, "ws-3"));
  assert.equal(value(`values/${SANDBOX_TOKEN_NAME}`), sandboxToken(KEY, "ws-3"));
  assert.equal(value("values/GH_TOKEN.standin"), heldStandIn(KEY, "ws-3", "GH_TOKEN"));

  const noLiteral = {
    ...SANDBOX_MANIFEST,
    secrets: SANDBOX_MANIFEST.secrets.filter((s) => s.source.kind === "secret"),
  };
  assert.equal(readSlotSecret(objectsOf({ manifest: noLiteral }).slotSecret.data).spec.heldPod, undefined);
});

test("the Custodian renders the slot from the Secret, and each TLS chain finds its leaf there", () => {
  const { slotSecret } = objectsOf();
  const { spec, files } = readSlotSecret(slotSecret.data);
  const rules = renderSlot({
    slot: 7,
    owner: spec.owner,
    manifest: spec.manifest,
    placeholders: spec.placeholders,
    ranges: RANGES,
  });
  const named = [...JSON.stringify(rules.listener).matchAll(/\/tls\/([0-9a-f]{16}\.(?:crt|key))/g)].map((m) => m[1]);
  assert.ok(named.length > 0);
  for (const file of named) assert.ok(files.has(`tls/${file}`), `tls/${file} is in the slot Secret`);
  assert.ok(named.includes(`${leafStem(JR2_CUSTODIAN_NAME, 443)}.crt`), "jr2's own name has its leaf");
});

test("each leaf chains to the CA in the trust files, names its host, and has its own key; no object holds the CA's key", () => {
  const { slotSecret, trust, standIns } = objectsOf({
    caBundle: "-----BEGIN CERTIFICATE-----\nuser\n-----END CERTIFICATE-----\n",
  });
  const { files } = readSlotSecret(slotSecret.data);
  // The trust files: `extra.crt` is the user's bundle, then the Sandbox's CA.
  const extra = trust.data["extra.crt"]!;
  assert.ok(extra.startsWith("-----BEGIN CERTIFICATE-----\nuser\n"));
  const caPem = extra.slice(extra.indexOf("-----END CERTIFICATE-----\n") + "-----END CERTIFICATE-----\n".length);
  const ca = new X509Certificate(caPem);
  assert.equal(ca.subject, "CN=jr2 Sandbox CA (ws-3)");
  assert.ok(trust.data["bundle.crt"]!.endsWith(caPem), "bundle.crt ends with the Sandbox's CA");

  for (const { host, port } of leafTargets(SANDBOX_MANIFEST)) {
    const stem = leafStem(host, port);
    const cert = new X509Certificate(files.get(`tls/${stem}.crt`)!);
    assert.ok(cert.verify(ca.publicKey), `${host}:${port} chains to the Sandbox's CA`);
    assert.ok(host.includes(":") || cert.checkHost(host) !== undefined || cert.checkIP(host) !== undefined, host);
    assert.ok(cert.checkPrivateKey(createPrivateKey(files.get(`tls/${stem}.key`)!)));
  }

  // Each private key of each object written is a leaf's: none is the CA's.
  const caPublic = ca.publicKey.export({ type: "spki", format: "der" });
  let keys = 0;
  for (const object of [slotSecret, trust, standIns]) {
    for (const [k, v] of Object.entries(object.data)) {
      const body = object.kind === "Secret" ? text(v) : v;
      for (const m of body.matchAll(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----\n?/g)) {
        keys++;
        const pub = createPublicKey(m[0]).export({ type: "spki", format: "der" });
        assert.ok(!pub.equals(caPublic), `${k} of ${object.metadata?.name} holds the CA's key`);
      }
      if (object.kind !== "Secret" || !k.startsWith("tls.")) {
        assert.doesNotMatch(body, /PRIVATE KEY/, `${k} of ${object.metadata?.name} holds a key`);
      }
    }
  }
  assert.equal(keys, leafTargets(SANDBOX_MANIFEST).length, "one key for each leaf, and no other");
});

test("each write makes a new CA; the leaves of jr2's name and of each Intercepted host are the CA's constraints", () => {
  const a = objectsOf().trust.data["extra.crt"];
  const b = objectsOf().trust.data["extra.crt"];
  assert.notEqual(a, b);
  assert.deepEqual(
    leafTargets(SANDBOX_MANIFEST).map((t) => `${t.host}:${t.port}`),
    [
      `${JR2_CUSTODIAN_NAME}:443`,
      "api.anthropic.com:443",
      "api.github.com:443",
      "registry.npmjs.org:443",
      "10.0.0.7:8443",
    ],
    "port 80 of an Intercepted host is plain HTTP: no leaf",
  );
});

test("the trust ConfigMap and the Stand-in Secret: owned by the CR; Stand-ins and no token", () => {
  const { trust, standIns } = objectsOf();
  assert.equal(trust.kind, "ConfigMap");
  assert.equal(trust.metadata?.name, "ws-3-trust");
  assert.deepEqual(Object.keys(trust.data).sort(), ["bundle.crt", "extra.crt"]);
  assert.equal(standIns.metadata?.name, "ws-3-standins");
  for (const o of [trust, standIns]) {
    assert.deepEqual(
      (o.metadata as { ownerReferences: Array<{ uid: string }> }).ownerReferences.map((r) => r.uid),
      [UID],
    );
  }
  assert.deepEqual(Object.keys(standIns.data).sort(), [
    "control-standin",
    "standin-ANTHROPIC_API_KEY",
    "standin-GH_TOKEN",
    "standin-LOCAL_KEY",
  ]);
  assert.equal(text(standIns.data["control-standin"]!), controlStandIn(KEY, "ws-3"));
  const all = Object.values(standIns.data).map(text).join("\n");
  for (const token of [controlToken(KEY, "ws-3"), sandboxToken(KEY, "ws-3")]) assert.ok(!all.includes(token));
});

test("the placeholder table grows append-only: a known name keeps its address, a new name gets the next", () => {
  const first = objectsOf().placeholders;
  assert.equal(first.range, RANGES.placeholders);
  const more = {
    ...SANDBOX_MANIFEST,
    egress: [...SANDBOX_MANIFEST.egress, rule("pypi.org", 443, "name", false, "entry")],
  };
  const second = objectsOf({ manifest: more, placeholders: first }).placeholders;
  checkAppendOnly(first, second);
  for (const row of first.rows) assert.equal(placeholderOf(second, row.name), row.address);
  assert.equal(second.rows.length, first.rows.length + 1);
  // A table of another range is a program error, and nothing is written.
  assert.throws(() => objectsOf({ placeholders: { range: "198.18.16.0/20", rows: [] } }), /not the Instance's/);
});

test("the Fence composition: the slot's attachment and nameserver, the Custodian by name over HTTPS, the trust, no proxy", () => {
  const fence = fenceComposition(SANDBOX_MANIFEST, {
    sandbox: "ws-3",
    slot: 7,
    ranges: RANGES,
    granted: ["GH_TOKEN", "NOT_HELD"],
  });
  assert.deepEqual(fence.network, { attachment: "jr2-fence-7", nameserver: "198.19.0.1" });
  const env = Object.fromEntries(fence.harnessEnv.map((e) => [e.name, e.value]));
  assert.deepEqual(env, {
    JR2_CUSTODIAN_URL: FENCE_CUSTODIAN_URL,
    JR2_CONTROL_STANDIN_FILE: "/run/jr2/control/standin",
    JR2_GRANTED_SECRETS: "GH_TOKEN",
    NODE_EXTRA_CA_CERTS: "/etc/jr2/ca/extra.crt",
    SSL_CERT_FILE: "/etc/jr2/ca/bundle.crt",
    REQUESTS_CA_BUNDLE: "/etc/jr2/ca/bundle.crt",
    GIT_SSL_CAINFO: "/etc/jr2/ca/bundle.crt",
  });
  assert.equal(FENCE_CUSTODIAN_URL, "https://custodian.jr2.internal");
  const json = JSON.stringify(fence);
  assert.doesNotMatch(json, /HTTPS_PROXY|https_proxy|NO_PROXY|JR2_CUSTODIAN_SOCKET|control\.sock|-token"/);
  assert.match(json, /"ws-3-trust"/);
  assert.match(json, /"ws-3-standins"/);
  assert.doesNotMatch(json, /jr2-ca/, "no caBundle: no ca.crt");
  const withBundle = fenceComposition(SANDBOX_MANIFEST, { sandbox: "ws-3", slot: 7, ranges: RANGES, caBundle: true });
  assert.match(JSON.stringify(withBundle.volumes), /"jr2-ca".*"ca\.crt"/);
  // A moved segment moves the nameserver.
  const moved = fenceComposition(SANDBOX_MANIFEST, {
    sandbox: "ws-3",
    slot: 7,
    ranges: { segment: "10.77.0.0/20", placeholders: RANGES.placeholders },
  });
  assert.equal(moved.network.nameserver, "10.77.0.1");
});

test("a Sandbox CR on the Fence: spec.network, no Custodian container, and the Sandbox Effector with exec probes", () => {
  const fence = fenceComposition(SANDBOX_MANIFEST, { sandbox: "ws-3", slot: 7, ranges: RANGES });
  const effector = sandboxEffectorContainer({
    image: "img",
    keys: [],
    securityContext: {},
    secretVolume: "s",
    keyVolume: "k",
    scratchVolume: "x",
    fence: true,
  });
  const cr = sandboxCr({
    namespace: "jr2-test",
    req: { name: "ws-3", runId: "r1", workflow: "w", path: "" },
    seat: { image: "img", env: [], homeVolume: [], homeMount: [], securityContext: { runAsNonRoot: true } as never },
    repos: [],
    pod: fence,
    split: splitSize(resolveSize(undefined, undefined)),
    sidecars: [effector],
    env: fence.harnessEnv,
    envFrom: [],
    harnessImage: "harness:1",
    gitCredentials: [],
    priorityClassName: "jr2-sandbox",
    idleTimeout: "30m",
  });
  assert.deepEqual(cr.spec.network, { attachment: "jr2-fence-7", nameserver: "198.19.0.1" });
  assert.deepEqual(
    cr.spec.sidecars.map((c) => c.name),
    ["effector"],
    "no Custodian container in the pod",
  );
  assert.ok(!JSON.stringify(cr).includes("custodian-values"));
  assert.ok(cr.spec.volumeMounts.some((m) => m.mountPath === "/etc/jr2/ca"));
  const command = ["/opt/jr2/bin/effector", "healthcheck", "http://127.0.0.1:8082/healthz"];
  assert.deepEqual((effector as Record<string, unknown>).startupProbe, {
    exec: { command },
    timeoutSeconds: 2,
    periodSeconds: 1,
    failureThreshold: 600,
  });
  assert.deepEqual(effector.readinessProbe, { exec: { command }, timeoutSeconds: 2, periodSeconds: 10 });
  // Off the Fence, the Effector keeps the kubelet's HTTP probe.
  const plain = sandboxEffectorContainer({
    image: "img",
    keys: [],
    securityContext: {},
    secretVolume: "s",
    keyVolume: "k",
    scratchVolume: "x",
  });
  assert.deepEqual(plain.readinessProbe, { httpGet: { path: "/healthz", port: 8082 }, periodSeconds: 1 });
  assert.equal("startupProbe" in plain, false);
});
