// The PKI of the Custodian's leaves (ADR-0059), read back with Node's own X.509 parser and TLS: jr2
// WRITES a few fixed certificate shapes and Node VERIFIES them. Pinned: the CA's and the leaf's
// extensions, DNS and IP SANs, the chain, when a leaf is reused and when it is issued again, the
// trust bundles — the one that must never carry the jr2 CA — and a Sandbox's CA: its name
// constraints, the leaves that verify under it and the ones that do not, and no key of it anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import { connect, createSecureContext, rootCertificates, TLSSocket } from "node:tls";
import { isIP } from "node:net";
import {
  caFits,
  issueCa,
  issueConstrainedCa,
  issueLeaf,
  leafFits,
  sandboxPki,
  trustBundles,
  type Pem,
} from "../src/pki.ts";

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
    assert.equal(cert.subject, isIP(host) === 0 ? `CN=${host}` : `CN=jr2 leaf (${host})`);
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

// ---- a Sandbox's CA ------------------------------------------------------------------------------

/** One DER element: its tag, its content, and where the next element starts. */
function element(der: Buffer, at: number): { tag: number; content: Buffer; end: number } {
  const first = der[at + 1]!;
  let start = at + 2;
  let len = first;
  if (first >= 0x80) {
    len = 0;
    for (let i = 0; i < (first & 0x7f); i++) len = len * 256 + der[at + 2 + i]!;
    start = at + 2 + (first & 0x7f);
  }
  return { tag: der[at]!, content: der.subarray(start, start + len), end: start + len };
}

function elements(der: Buffer): Array<{ tag: number; content: Buffer }> {
  const out: Array<{ tag: number; content: Buffer }> = [];
  for (let at = 0; at < der.length; ) {
    const e = element(der, at);
    out.push(e);
    at = e.end;
  }
  return out;
}

/** A GeneralName as text: `DNS:<name>` or `IP:<address>/<mask>`. */
function generalName(tag: number, content: Buffer): string {
  if (tag === 0x82) return `DNS:${content.toString("ascii")}`;
  if (tag === 0x87) {
    const half = content.length / 2;
    const text = (b: Buffer) =>
      half === 4 ? [...b].join(".") : [...Array(8).keys()].map((i) => b.readUInt16BE(2 * i).toString(16)).join(":");
    return `IP:${text(content.subarray(0, half))}/${text(content.subarray(half))}`;
  }
  return `tag ${tag}`;
}

/** The certificate's nameConstraints extension: whether it is critical, and each subtree as text. */
function nameConstraintsOf(
  certPem: string,
): { critical: boolean; permitted: string[]; excluded: string[] } | undefined {
  const tbs = elements(element(new X509Certificate(certPem).raw, 0).content)[0]!.content;
  const ext = elements(tbs).find((e) => e.tag === 0xa3);
  if (ext === undefined) return undefined;
  for (const one of elements(elements(ext.content)[0]!.content)) {
    const [id, ...rest] = elements(one.content);
    if (!id!.content.equals(Buffer.from([0x55, 0x1d, 0x1e]))) continue;
    const critical = rest.length === 2 && rest[0]!.tag === 0x01 && rest[0]!.content[0] === 0xff;
    const value = rest[rest.length - 1]!.content;
    const out = { critical, permitted: [] as string[], excluded: [] as string[] };
    for (const part of elements(element(value, 0).content)) {
      const list = part.tag === 0xa0 ? out.permitted : out.excluded;
      for (const subtree of elements(part.content)) {
        const [base] = elements(subtree.content);
        list.push(generalName(base!.tag, base!.content));
      }
    }
    return out;
  }
  return undefined;
}

/** A TLS handshake, in process and with no socket, of a client that trusts `ca` alone with a server
 * that presents `leaf`: undefined when it completes, else the client's error. */
async function handshake(ca: string, leaf: Pem, host: string): Promise<Error | undefined> {
  const [serverSide, clientSide] = duplexPair();
  const server = new TLSSocket(serverSide, {
    isServer: true,
    secureContext: createSecureContext({ cert: leaf.cert, key: leaf.key }),
  });
  server.on("error", () => {});
  return new Promise((resolve) => {
    const client = connect({
      socket: clientSide,
      ca: [ca],
      host,
      ...(isIP(host) === 0 ? { servername: host } : {}),
    });
    client.once("secureConnect", () => {
      client.destroy();
      server.destroy();
      resolve(undefined);
    });
    client.once("error", (err) => {
      server.destroy();
      resolve(err);
    });
  });
}

const SANDBOX_HOSTS = ["api.anthropic.com", "custodian.jr2.internal", "Model.Corp.Example"];

test("a Sandbox's CA: critical nameConstraints with exactly its Intercepted hosts and jr2's name, and no address", () => {
  const pki = sandboxPki("ws-3", SANDBOX_HOSTS);
  const cert = new X509Certificate(pki.ca);
  assert.equal(cert.subject, "CN=jr2 Sandbox CA (ws-3)");
  assert.equal(cert.ca, true);
  assert.deepEqual(nameConstraintsOf(pki.ca), {
    critical: true,
    permitted: ["DNS:api.anthropic.com", "DNS:custodian.jr2.internal", "DNS:model.corp.example"],
    // Each name below a permitted name, and every address: the CA states no IP literal.
    excluded: [
      "DNS:.api.anthropic.com",
      "DNS:.custodian.jr2.internal",
      "DNS:.model.corp.example",
      "IP:0.0.0.0/0.0.0.0",
      "IP:0:0:0:0:0:0:0:0/0:0:0:0:0:0:0:0",
    ],
  });
  assert.equal(nameConstraintsOf(issueCa("myinst").cert), undefined, "the Instance's CA states no constraint");
  assert.deepEqual([...pki.leaves.keys()], ["api.anthropic.com", "custodian.jr2.internal", "model.corp.example"]);
});

test("a Sandbox's CA with an address entry permits that one address, and a name below another stays permitted", () => {
  const pki = sandboxPki("ws-4", ["10.0.0.5", "corp.example", "api.corp.example", "custodian.jr2.internal"]);
  assert.deepEqual(nameConstraintsOf(pki.ca), {
    critical: true,
    permitted: [
      "DNS:corp.example",
      "DNS:api.corp.example",
      "DNS:custodian.jr2.internal",
      "IP:10.0.0.5/255.255.255.255",
    ],
    // `.corp.example` would exclude `api.corp.example`, which the CA must permit.
    excluded: ["DNS:.api.corp.example", "DNS:.custodian.jr2.internal"],
  });
});

test("each leaf of a Sandbox verifies under its CA alone, for its own host", async () => {
  const pki = sandboxPki("ws-3", [...SANDBOX_HOSTS, "10.0.0.5"]);
  for (const [host, leaf] of pki.leaves) {
    assert.equal(await handshake(pki.ca, leaf, host), undefined, `${host} verifies`);
    assert.ok(new X509Certificate(leaf.cert).verify(new X509Certificate(pki.ca).publicKey));
  }
  const other = await handshake(pki.ca, pki.leaves.get("api.anthropic.com")!, "custodian.jr2.internal");
  assert.ok(other instanceof Error, "a leaf does not serve another host of the same CA");
});

test("a leaf for another name does not verify under a Sandbox's CA, even when its key signed it", async () => {
  // The same constraints as a Sandbox's CA, with the key kept: what a key that leaked could sign.
  const ca = issueConstrainedCa("jr2 Sandbox CA (ws-3)", SANDBOX_HOSTS);
  assert.equal(await handshake(ca.cert, issueLeaf(ca, "api.anthropic.com"), "api.anthropic.com"), undefined);
  for (const host of [
    "github.com",
    "evil.api.anthropic.com",
    "anthropic.com",
    "x.custodian.jr2.internal",
    "10.0.0.5",
  ]) {
    const err = await handshake(ca.cert, issueLeaf(ca, host), host);
    assert.ok(err instanceof Error, `${host} must not verify`);
    assert.match(err.message, /subtree violation/, host);
  }
  // An address that the CA permits verifies; another address does not.
  const withAddress = issueConstrainedCa("jr2 Sandbox CA (ws-4)", ["10.0.0.5", "custodian.jr2.internal"]);
  assert.equal(await handshake(withAddress.cert, issueLeaf(withAddress, "10.0.0.5"), "10.0.0.5"), undefined);
  assert.ok((await handshake(withAddress.cert, issueLeaf(withAddress, "10.0.0.6"), "10.0.0.6")) instanceof Error);
  assert.ok((await handshake(withAddress.cert, issueLeaf(withAddress, "github.com"), "github.com")) instanceof Error);
});

test("a Sandbox's PKI holds no CA key: the CA is a certificate alone, and each key is a leaf's own", () => {
  const pki = sandboxPki("ws-3", SANDBOX_HOSTS);
  assert.deepEqual(Object.keys(pki).sort(), ["ca", "leaves"]);
  assert.doesNotMatch(pki.ca, /PRIVATE KEY/);
  const caKey = new X509Certificate(pki.ca).publicKey;
  for (const leaf of pki.leaves.values()) {
    const cert = new X509Certificate(leaf.cert);
    assert.ok(cert.checkPrivateKey(createPrivateKey(leaf.key)));
    assert.ok(!caKey.equals(cert.publicKey), "no leaf has the CA's key");
  }
});

test("a constrained CA refuses a host that a name constraint cannot state", () => {
  assert.throws(() => issueConstrainedCa("x", []), /at least one host/);
  for (const host of ["*.example.com", "example.com.", "a b", "under_score.example"]) {
    assert.throws(() => issueConstrainedCa("x", [host]), /not a host name/, host);
  }
});
