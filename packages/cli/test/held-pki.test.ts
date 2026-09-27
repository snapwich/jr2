// The held-secret PKI (ADR-0059), read back with Node's own X.509 parser: jr2 WRITES two fixed
// certificate shapes and Node VERIFIES them. Pinned: the CA's and the leaf's extensions, DNS and IP
// SANs, the chain, when a leaf is reused and when it is issued again, and the trust bundles — the
// one that must never carry the jr2 CA.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { caFits, issueCa, issueLeaf, leafFits, trustBundles } from "../src/held-pki.ts";

const DAY = 86_400_000;
const ca = issueCa("myinst");

test("the CA: its own subject and issuer, a CA, ten years, its key its own", () => {
  const cert = new X509Certificate(ca.cert);
  assert.equal(cert.subject, "CN=jr2 held-secret CA (myinst)");
  assert.equal(cert.issuer, cert.subject);
  assert.equal(cert.ca, true);
  assert.ok(cert.verify(cert.publicKey), "self-signed");
  const years = (new Date(cert.validTo).getTime() - Date.now()) / (365 * DAY);
  assert.ok(years > 9.9 && years < 10.1, `ten years (got ${years})`);
  assert.ok(new Date(cert.validFrom).getTime() < Date.now() - 50 * 60_000, "an hour back, for clock skew");
  assert.equal(cert.serialNumber.length, 32, "16 random bytes");
  assert.ok(Number.parseInt(cert.serialNumber[0]!, 16) < 8, "top bit clear: a positive serial");
  assert.ok(caFits(ca));
});

test("a leaf: one SAN, DNS or IP, chained to the CA, a server certificate, one year", () => {
  const caCert = new X509Certificate(ca.cert);
  for (const [host, san, check] of [
    ["litellm.corp.example", "DNS:litellm.corp.example", (c: X509Certificate) => c.checkHost("litellm.corp.example")],
    ["10.0.0.5", "IP Address:10.0.0.5", (c: X509Certificate) => c.checkIP("10.0.0.5")],
    ["fd00::1", "IP Address:FD00:0:0:0:0:0:0:1", (c: X509Certificate) => c.checkIP("fd00::1")],
  ] as const) {
    const leaf = issueLeaf(ca, host);
    const cert = new X509Certificate(leaf.cert);
    assert.equal(cert.subject, `CN=${host}`);
    assert.equal(cert.issuer, caCert.subject);
    assert.equal(cert.subjectAltName, san);
    assert.ok(check(cert), `${host} matches its own SAN`);
    assert.ok(cert.verify(caCert.publicKey), "signed by the CA");
    assert.equal(cert.ca, false);
    assert.deepEqual(cert.keyUsage, ["1.3.6.1.5.5.7.3.1"], "serverAuth, and nothing else");
    assert.ok(cert.checkPrivateKey(createPrivateKey(leaf.key)), "its key is its own");
    const days = (new Date(cert.validTo).getTime() - Date.now()) / DAY;
    assert.ok(days > 364 && days < 366, `one year (got ${days})`);
  }
  assert.equal(new X509Certificate(issueLeaf(ca, "a.example").cert).checkHost("b.example"), undefined);
});

test("the extensions, as OpenSSL reads them: pathLen 0 and critical key usage on the CA; AKI and SKI on the leaf", (t) => {
  let openssl = true;
  try {
    execFileSync("openssl", ["version"]);
  } catch {
    openssl = false;
  }
  if (!openssl) return t.skip("no openssl on this host");
  const text = (pem: string) => execFileSync("openssl", ["x509", "-noout", "-text"], { input: pem }).toString();
  const caText = text(ca.cert);
  assert.match(caText, /Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
  assert.match(caText, /Key Usage: critical\s+Certificate Sign, CRL Sign/);
  assert.match(caText, /Subject Key Identifier/);
  const leafText = text(issueLeaf(ca, "litellm.corp.example").cert);
  assert.match(leafText, /Basic Constraints:\s+CA:FALSE/);
  assert.match(leafText, /Key Usage: critical\s+Digital Signature/);
  assert.match(leafText, /Extended Key Usage:\s+TLS Web Server Authentication/);
  assert.match(leafText, /Authority Key Identifier/);
  const caSki = /Subject Key Identifier:\s+([0-9A-F:]+)/.exec(caText)![1];
  assert.ok(leafText.includes(caSki!), "the leaf's AKI is the CA's SKI");
});

test("an issued chain verifies as OpenSSL verifies a server certificate", async (t) => {
  let openssl = true;
  try {
    execFileSync("openssl", ["version"]);
  } catch {
    openssl = false;
  }
  if (!openssl) return t.skip("no openssl on this host");
  const dir = await mkdtemp(join(tmpdir(), "jr2-pki-"));
  await writeFile(join(dir, "ca.pem"), ca.cert);
  await writeFile(join(dir, "leaf.pem"), issueLeaf(ca, "litellm.corp.example").cert);
  const out = execFileSync("openssl", [
    "verify",
    "-CAfile",
    join(dir, "ca.pem"),
    "-purpose",
    "sslserver",
    join(dir, "leaf.pem"),
  ]);
  assert.match(out.toString(), /leaf\.pem: OK/);
});

test("a leaf is reused while it fits, and issued again on a SAN change, a CA change, or 30 days left", () => {
  const leaf = issueLeaf(ca, "litellm.corp.example");
  assert.ok(leafFits(leaf, ca, "litellm.corp.example"));
  assert.ok(!leafFits(leaf, ca, "other.corp.example"), "the host moved");
  assert.ok(!leafFits(leaf, issueCa("myinst"), "litellm.corp.example"), "the CA was rotated");
  assert.ok(!leafFits(leaf, ca, "litellm.corp.example", new Date(Date.now() + 340 * DAY)), "under 30 days left");
  assert.ok(
    !leafFits({ cert: leaf.cert, key: issueLeaf(ca, "litellm.corp.example").key }, ca, "litellm.corp.example"),
    "not its own key",
  );
  assert.ok(!leafFits({ cert: "", key: "" }, ca, "litellm.corp.example"), "absent is never a fit");
  const ipLeaf = issueLeaf(ca, "10.0.0.5");
  assert.ok(leafFits(ipLeaf, ca, "10.0.0.5"));
  assert.ok(!leafFits(ipLeaf, ca, "10.0.0.6"));
  assert.ok(!caFits({ cert: ca.cert, key: issueCa("x").key }), "a CA whose key is not its own is not kept");
});

test("the trust bundles: the jr2 CA for the Harness, never upstream; the user's bundle in all three", () => {
  const user = issueCa("corp").cert;
  const { extra, bundle, upstream } = trustBundles(ca.cert, user);
  assert.equal(extra, `${user}${ca.cert}`, "NODE_EXTRA_CA_CERTS adds to Node's own roots");
  assert.ok(bundle.startsWith(rootCertificates[0]!), "bundle.crt replaces a tool's store, so it carries the roots");
  assert.ok(bundle.includes(user) && bundle.includes(ca.cert));
  assert.ok(upstream.includes(user) && upstream.startsWith(rootCertificates[0]!));
  assert.ok(!upstream.includes(ca.cert), "the Custodian never accepts one of its own leaves from upstream");
  assert.ok(Buffer.byteLength(bundle) + Buffer.byteLength(upstream) < 1024 * 1024, "fits a ConfigMap");
  assert.equal(trustBundles(ca.cert).extra, ca.cert, "no user bundle: the jr2 CA alone");
});
