// The PKI of the Custodian's leaves (ADR-0059): the CAs, and the leaves the Custodian ends TLS with.
//
// Two kinds of CA, one shape of leaf:
//
//   the Instance's CA   `jr2 up` keeps it in the `jr2-held-ca` Secret, which no pod mounts, and
//                       issues the leaves of the Instance Harness and the check pods from it before
//                       a pod starts. A Custodian holds leaves and no key that could mint one.
//   a Sandbox's CA      the Orchestrator makes it at provision (`sandboxPki`), with critical name
//                       constraints for the Sandbox's Intercepted hosts and jr2's own name, issues one
//                       leaf for each, and drops the key: it exists only in that call's memory, and
//                       no object holds it. The pod gets the CA's certificate only.
//
// jr2 WRITES a few fixed certificate shapes and nothing else, so this is a small DER writer over
// `node:crypto` rather than a dependency: the libraries that write X.509 bring a dozen packages
// (`@peculiar/x509`) or an ASN.1 parser and pure-JS RSA (`node-forge`) jr2 has no use for. Nor does
// it shell to `openssl`: that would add a binary to `jr2 up`'s floor, and macOS ships LibreSSL,
// whose flags differ. Node VERIFIES what this writes — the tests read every certificate back with
// `crypto.X509Certificate` and end TLS handshakes with them, and the Custodian suite ends real TLS
// handshakes with them.
//
//   CA         CN=jr2 held-secret CA (<instance>)  CA:true pathLen:0, keyCertSign+cRLSign, SKI   10 years
//   Sandbox CA CN=jr2 Sandbox CA (<sandbox>)       the same, and critical nameConstraints        10 years
//   leaf       CN=<host> (an address: no subject)  one DNS or IP SAN (critical for an address),     1 year
//                                                  CA:false, digitalSignature, serverAuth, AKI, SKI
//
// Keys are ECDSA P-256. Serials are 16 random bytes, top bit clear. `notBefore` is an hour back,
// for clock skew between this host and a node.

import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { isIP } from "node:net";
import { rootCertificates } from "node:tls";

/** One certificate and its key, both PEM. */
export type Pem = { cert: string; key: string };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A leaf is issued again when fewer than this many days remain on it. */
const RENEW_BEFORE_DAYS = 30;

// ---- DER ----------------------------------------------------------------------------------------

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const octets = (content: Buffer): Buffer => tlv(0x04, content);
const bits = (content: Buffer, unused = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unused]), content]));
const bool = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const utf8 = (value: string): Buffer => tlv(0x0c, Buffer.from(value, "utf8"));
/** A context-specific tag: constructed and EXPLICIT for `[0]`/`[3]` of the TBS, primitive and
 * IMPLICIT for a SAN or a key identifier. */
const context = (n: number, content: Buffer, constructed: boolean): Buffer =>
  tlv((constructed ? 0xa0 : 0x80) | n, content);

/** A DER INTEGER from its big-endian magnitude: minimal, and positive. */
function integer(magnitude: Buffer): Buffer {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0 && (magnitude[start + 1] as number) < 0x80) start++;
  const trimmed = magnitude.subarray(start);
  return tlv(0x02, (trimmed[0] as number) >= 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number) as [number, number, ...number[]];
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk: number[] = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime until 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5). */
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

const name = (cn: string): Buffer => seq(set(seq(oid("2.5.4.3"), utf8(cn))));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
}

// ---- keys ---------------------------------------------------------------------------------------

/** A P-256 public key's uncompressed point — the subjectPublicKey bits a key identifier hashes. */
function ecPoint(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x as string, "base64url"),
    Buffer.from(jwk.y as string, "base64url"),
  ]);
}

function p256(): { publicKeyDer: Buffer; point: Buffer; keyPem: string } {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKeyDer: pair.publicKey.export({ type: "spki", format: "der" }),
    point: ecPoint(pair.publicKey),
    keyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

/** RFC 5280's key identifier, method 1: the SHA-1 of the subjectPublicKey bits. */
function keyId(point: Buffer): Buffer {
  return createHash("sha1").update(point).digest();
}

function serial(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] as number) & 0x7f || 0x01;
  return bytes;
}

function pem(der: Buffer): string {
  const b64 = der
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .replace(/\n$/, "");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/** Sign a TBSCertificate into a Certificate. */
function certificate(tbs: Buffer, signerKeyPem: string): Buffer {
  const signature = sign("sha256", tbs, createPrivateKey(signerKeyPem));
  return seq(tbs, ECDSA_SHA256, bits(signature));
}

// ---- the two shapes -----------------------------------------------------------------------------

/** The per-Instance CA: `CN=jr2 held-secret CA (<instance>)`, ten years. */
export function issueCa(instance: string, now: Date = new Date()): Pem {
  return selfSignedCa(`jr2 held-secret CA (${instance})`, now, []);
}

/**
 * A CA whose critical name constraints permit `hosts` and nothing else (ADR-0059): each DNS name
 * exactly, and each IP literal as one address. A DNS constraint also permits each name below it
 * (RFC 5280 §4.2.1.10), so each name gets an excluded subtree `.<name>` too, unless another of
 * `hosts` is below it. Then that exclusion would also exclude the lower host, so the CA also
 * permits the other names below the upper one: name constraints cannot state that set exactly.
 * With no IP literal among `hosts`, every IPv4 and IPv6 address is excluded; with no name, every
 * DNS name is excluded. Else the CA cannot vouch for a host outside `hosts`, whatever leaf its key
 * signs. Throws on an empty list and on a host that is not a name or an IP literal (a wildcard, a
 * trailing dot).
 */
export function issueConstrainedCa(cn: string, hosts: readonly string[], now: Date = new Date()): Pem {
  return selfSignedCa(cn, now, [extension("2.5.29.30", true, nameConstraints(hosts))]);
}

/** A Sandbox's CA as the pod gets it, and a leaf for each of its Intercepted hosts. No CA key. */
export type SandboxPki = {
  /** The CA's certificate, PEM. Its key is not here, and not anywhere else. */
  ca: string;
  /** One leaf for each host, by the host in lower case (an IP literal as it was given). */
  leaves: ReadonlyMap<string, Pem>;
};

/**
 * A Sandbox's CA and its leaves (ADR-0059): a CA constrained to `hosts` (`issueConstrainedCa`), one
 * leaf for each host, and then no key that can sign another leaf. The CA's key exists only inside
 * this call: it is not returned, so no object that the caller writes can hold it. `hosts` are the
 * Sandbox's Intercepted hosts and jr2's own name.
 */
export function sandboxPki(sandbox: string, hosts: readonly string[], now: Date = new Date()): SandboxPki {
  const ca = issueConstrainedCa(`jr2 Sandbox CA (${sandbox})`, hosts, now);
  const leaves = new Map(unique(hosts).map((host) => [host, issueLeaf(ca, host, now)] as const));
  return { ca: ca.cert, leaves };
}

function selfSignedCa(cn: string, now: Date, more: Buffer[]): Pem {
  const key = p256();
  const subject = name(cn);
  const tbs = seq(
    context(0, integer(Buffer.from([2])), true),
    integer(serial()),
    ECDSA_SHA256,
    subject,
    seq(time(new Date(now.getTime() - HOUR)), time(new Date(now.getTime() + 3650 * DAY))),
    subject,
    key.publicKeyDer,
    context(
      3,
      seq(
        extension("2.5.29.19", true, seq(bool(true), integer(Buffer.from([0])))),
        // keyCertSign (bit 5) + cRLSign (bit 6): 0b0000_0110, one unused bit.
        extension("2.5.29.15", true, bits(Buffer.from([0x06]), 1)),
        extension("2.5.29.14", false, octets(keyId(key.point))),
        ...more,
      ),
      true,
    ),
  );
  return { cert: pem(certificate(tbs, key.keyPem)), key: key.keyPem };
}

/** The hosts, lowercase, each once, in their first order. */
function unique(hosts: readonly string[]): string[] {
  return [...new Set(hosts.map((h) => (isIP(h) === 0 ? h.toLowerCase() : h)))];
}

const DNS_NAME = /^(?=.{1,253}$)([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*$/;

/** NameConstraints (RFC 5280 §4.2.1.10): permittedSubtrees [0], excludedSubtrees [1]. */
function nameConstraints(hosts: readonly string[]): Buffer {
  const all = unique(hosts);
  if (all.length === 0) throw new Error("a constrained CA needs at least one host");
  const names = all.filter((h) => isIP(h) === 0);
  const addresses = all.filter((h) => isIP(h) !== 0);
  for (const n of names) {
    if (!DNS_NAME.test(n)) throw new Error(`${n} is not a host name that a name constraint can state`);
  }
  const subtree = (general: Buffer): Buffer => seq(general);
  const dns = (n: string): Buffer => context(2, Buffer.from(n, "ascii"), false);
  const ip = (bytes: Buffer, mask: Buffer): Buffer => context(7, Buffer.concat([bytes, mask]), false);
  const ipBytes = (h: string): Buffer => (isIP(h) === 4 ? Buffer.from(h.split(".").map(Number)) : ipv6Bytes(h));
  const permitted = [
    ...names.map((n) => subtree(dns(n))),
    ...addresses.map((a) => {
      const bytes = ipBytes(a);
      return subtree(ip(bytes, Buffer.alloc(bytes.length, 0xff)));
    }),
  ];
  const excluded = [
    ...names.filter((n) => !names.some((o) => o.endsWith(`.${n}`))).map((n) => subtree(dns(`.${n}`))),
    // A constraint holds only for its own name form (RFC 5280 §4.2.1.10): with addresses alone, the
    // permitted subtrees state no DNS name, so every name is excluded ("" is each name).
    ...(names.length === 0 ? [subtree(dns(""))] : []),
    ...(addresses.length === 0
      ? [subtree(ip(Buffer.alloc(4), Buffer.alloc(4))), subtree(ip(Buffer.alloc(16), Buffer.alloc(16)))]
      : []),
  ];
  return seq(
    context(0, Buffer.concat(permitted), true),
    ...(excluded.length ? [context(1, Buffer.concat(excluded), true)] : []),
  );
}

/** A leaf for one bound host — a DNS name or an IP literal — signed by `ca`, one year. */
export function issueLeaf(ca: Pem, host: string, now: Date = new Date()): Pem {
  const key = p256();
  const caCert = new X509Certificate(ca.cert);
  const caKeyId = keyId(ecPoint(caCert.publicKey));
  const tbs = seq(
    context(0, integer(Buffer.from([2])), true),
    integer(serial()),
    ECDSA_SHA256,
    issuerName(caCert),
    seq(time(new Date(now.getTime() - HOUR)), time(new Date(now.getTime() + 365 * DAY))),
    // An address leaf has an empty subject: a verifier checks the CN of a leaf with no DNS SAN
    // against a CA's DNS constraints — OpenSSL a CN that reads as a host name ("10.0.0.5" does),
    // GnuTLS any CN — and refuses the leaf. With an empty subject the SAN must be critical
    // (RFC 5280 §4.2.1.6).
    isIP(host) === 0 ? name(host) : seq(),
    key.publicKeyDer,
    context(
      3,
      seq(
        extension("2.5.29.17", isIP(host) !== 0, seq(subjectAltName(host))),
        extension("2.5.29.19", false, seq()),
        // digitalSignature (bit 0): 0b1000_0000, seven unused bits.
        extension("2.5.29.15", true, bits(Buffer.from([0x80]), 7)),
        extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))),
        extension("2.5.29.35", false, seq(context(0, caKeyId, false))),
        extension("2.5.29.14", false, octets(keyId(key.point))),
      ),
      true,
    ),
  );
  return { cert: pem(certificate(tbs, ca.key)), key: key.keyPem };
}

/** The issuer, as the CA's own subject — read off its DER rather than rebuilt from its CN, so a CA
 * this module did not write still chains. */
function issuerName(ca: X509Certificate): Buffer {
  const der = ca.raw;
  // Certificate → TBSCertificate → [0] version, serial, sigAlg, issuer, validity, SUBJECT.
  const tbs = children(children(der, 0)[0] as Buffer, 0);
  return tbs[5] as Buffer;
}

/** The DER elements inside one constructed element, whole (tag and length included). */
function children(der: Buffer, offset: number): Buffer[] {
  const header = (at: number): { start: number; end: number } => {
    const first = der[at + 1] as number;
    if (first < 0x80) return { start: at + 2, end: at + 2 + first };
    const n = first & 0x7f;
    let len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (der[at + 2 + i] as number);
    return { start: at + 2 + n, end: at + 2 + n + len };
  };
  const outer = header(offset);
  const out: Buffer[] = [];
  for (let at = outer.start; at < outer.end; ) {
    const inner = header(at);
    out.push(der.subarray(at, inner.end));
    at = inner.end;
  }
  return out;
}

function subjectAltName(host: string): Buffer {
  const family = isIP(host);
  if (family === 4) return context(7, Buffer.from(host.split(".").map(Number)), false);
  if (family === 6) return context(7, ipv6Bytes(host), false);
  return context(2, Buffer.from(host, "ascii"), false);
}

function ipv6Bytes(host: string): Buffer {
  const [head = "", tail] = host.split("::");
  const groups = (part: string) => (part ? part.split(":") : []);
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const all = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return Buffer.from(all.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]));
}

// ---- reuse --------------------------------------------------------------------------------------

/**
 * Does a leaf `jr2 up` already holds still serve this host? Only when its one SAN names exactly
 * this host, it verifies against the CURRENT CA, its key is its own, and more than 30 days remain.
 * Anything else — a moved host, a rotated CA, an expiring leaf — issues a new one.
 */
export function leafFits(leaf: Pem, ca: Pem, host: string, now: Date = new Date()): boolean {
  try {
    const cert = new X509Certificate(leaf.cert);
    const issuer = new X509Certificate(ca.cert);
    if (!cert.verify(issuer.publicKey)) return false;
    if (!cert.checkPrivateKey(createPrivateKey(leaf.key))) return false;
    const want = isIP(host) === 0 ? `DNS:${host}` : undefined;
    if (want !== undefined ? cert.subjectAltName !== want : cert.checkIP(host) === undefined) return false;
    if (isIP(host) !== 0 && (cert.subjectAltName ?? "").split(",").length !== 1) return false;
    return new Date(cert.validTo).getTime() - now.getTime() > RENEW_BEFORE_DAYS * DAY;
  } catch {
    return false;
  }
}

/** A CA `jr2 up` found in the cluster is kept when it parses, is a CA, and its key is its own. */
export function caFits(ca: Pem, now: Date = new Date()): boolean {
  try {
    const cert = new X509Certificate(ca.cert);
    return (
      cert.ca && cert.checkPrivateKey(createPrivateKey(ca.key)) && new Date(cert.validTo).getTime() > now.getTime()
    );
  } catch {
    return false;
  }
}

/** SHA-256 of a certificate's DER — what the Instance Harness's held digest covers per leaf. */
export function fingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}

// ---- trust --------------------------------------------------------------------------------------

/**
 * The three bundles a held secret needs, beside the user's own `ca.crt` (ADR-0020, ADR-0059).
 * "Roots" are the Mozilla roots of the Node that runs `jr2 up` — no file on the host, no dependency,
 * and one list whatever engine verifies with it.
 *
 *   extra.crt      caBundle + the jr2 CA      the Harness's NODE_EXTRA_CA_CERTS (adds to Node's roots)
 *   bundle.crt     roots + both               SSL_CERT_FILE and friends (these REPLACE a tool's store)
 *   upstream.crt   roots + caBundle           the Custodian's upstream trust — NEVER the jr2 CA, so
 *                                            it can never accept one of its own leaves from upstream
 */
export function trustBundles(jr2Ca: string, caBundle?: string): { extra: string; bundle: string; upstream: string } {
  const roots = rootCertificates.map((c) => (c.endsWith("\n") ? c : `${c}\n`)).join("");
  const user = caBundle ? (caBundle.endsWith("\n") ? caBundle : `${caBundle}\n`) : "";
  return {
    extra: `${user}${jr2Ca}`,
    bundle: `${roots}${user}${jr2Ca}`,
    upstream: `${roots}${user}`,
  };
}
