// Held secrets (ADR-0059): credentials the Harness uses and never holds.
//
// The Agent executes code in the Harness container (ADR-0005), so a key in that container's env is
// a key it can take out of the pod. A held secret is not there: the Harness's env carries a
// STAND-IN, and the Custodian — a container of the same pod that the Agent executes nothing in —
// puts the value into requests toward the hosts the secret is bound to, and nowhere else.
//
// This module is the pure half, shared by every seat that needs it:
//
//   standIn(name)        the value the Harness sees — deterministic and public
//   heldSecretsOf(...)   `jr2 up`'s normalization: every refusal (R1–R13), every warning, and the
//                        engine-neutral manifest (`held.json`) every composition reads
//
// It runs HOST-SIDE, in `jr2 up`, because only there does the config carry values: in-cluster,
// `process.env` has no `.env`, so a `value` reads `undefined` and a `hosts` entry built from `.env`
// reads `""`. The in-cluster Orchestrator never re-derives any of this. It reads the manifest
// `jr2 up` wrote, per provision, from a mount (the `jr2-images` pattern, ADR-0038).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import type { JR2Config, HarnessEnvVar } from "./config.ts";
import { MODEL_KEYS, MODEL_KEY_PROVIDERS, SIGNING_CREDENTIALS } from "./model-keys.ts";
import { HELD_CA_SECRET, HELD_SECRETS_SECRET, HELD_TLS_SECRET, INSTANCE_SECRET } from "./names.ts";

/** The kit's Secrets no Harness container may read (R13): the Instance token and signing key, the
 * literal held values, the leaves, and the CA. */
const KIT_SECRETS: readonly string[] = [INSTANCE_SECRET, HELD_SECRETS_SECRET, HELD_TLS_SECRET, HELD_CA_SECRET];

/**
 * The Stand-in for one held secret: what its env var holds in the Harness container.
 *
 * Deterministic and public — it is not a secret, the Agent reads it from its env, and it means
 * something only to the Custodian and only toward a bound host. Unique per name, so one request can
 * carry two secrets' Stand-ins and the Custodian can tell them apart. ASCII letters, digits, `-`
 * and `_` only, so it is a valid header and env value; and it never contains `sk-ant-oat`, which pi
 * reads as an Anthropic OAuth token and answers with different auth headers.
 */
export function standIn(name: string): string {
  return `jr2-held-${name}`;
}

/** The request headers a Stand-in is swapped in when a held secret names none — the four places a
 * model API carries its key: `Authorization: Bearer` (OpenAI-compatible, `ANTHROPIC_AUTH_TOKEN`),
 * `x-api-key` (Anthropic), `x-goog-api-key` (Gemini), `api-key` (Azure). */
export const DEFAULT_CREDENTIAL_HEADERS: readonly string[] = [
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
];

/** Headers the Custodian treats as a credential on every bound host, whether a secret names them or
 * not: one that is not the product of a swap is stripped, and one sent twice is refused. */
export const CREDENTIAL_HEADERS: readonly string[] = [...DEFAULT_CREDENTIAL_HEADERS, "proxy-authorization"];

/** The env var the custom provider's key rides as (ADR-0018) — held since ADR-0059, and the kit's. */
export const PROVIDER_KEY_NAME = "JR2_PROVIDER_API_KEY";

/** The Sandbox token's env var (ADR-0013) — a held secret of the kit's own, bound to the
 * Orchestrator (ADR-0059). The Harness container holds its Stand-in; the Custodian holds the token. */
export const SANDBOX_TOKEN_NAME = "JR2_SANDBOX_TOKEN";

/** The env names the mechanism owns on a Harness container (ADR-0059): the proxy, the trust
 * bundles, and every `JR2_` name. A held secret may not choose them, and while a held secret exists,
 * `harness.env` may not either — the Custodian cannot chain to a second proxy yet (R11). */
export const MECHANISM_ENV: readonly string[] = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
];

/** What `jr2 up` resolved; what every composition reads (`held.json` in the `jr2-held`
 * ConfigMap). Values never appear here. */
export type HeldManifest = { version: 1; secrets: HeldBinding[] };

/** One held secret, normalized. */
export type HeldBinding = {
  /** The env var; the Harness sees `standIn(name)`. */
  name: string;
  /** A literal lands in the `jr2-held-secrets` Secret under `name`; a `secret` is the user's own
   * Secret, mounted by reference so a rotation reaches new pods without a `jr2 up`. */
  source: { kind: "literal" } | { kind: "secret"; secret: string; key: string };
  /** `leaf` is the file stem of this host's certificate in `jr2-held-tls` (`leafStem`). */
  hosts: HeldHost[];
  headers: string[];
  paths?: string[];
};

export type HeldHost = { host: string; port: number; leaf: string };

/** The manifest with nothing held — what `jr2 up` writes when the config holds no secret. */
export const EMPTY_HELD: HeldManifest = { version: 1, secrets: [] };

/**
 * The file stem of one bound `host:port`'s leaf certificate: 16 hex characters of its sha-256.
 * One leaf per target, because the Custodian selects the leaf by CONNECT target — and a change to
 * one host leaves the others' leaves alone.
 */
export function leafStem(host: string, port: number): string {
  return createHash("sha256").update(`${host}:${port}`).digest("hex").slice(0, 16);
}

/** The inputs `heldSecretsOf` cannot compute: what the cluster holds, read by `jr2 up`. */
export type HeldLookups = {
  /** The key NAMES (never the values) of each Secret and ConfigMap `harness.envFrom` names, by
   * `secret/<name>` or `configmap/<name>` — R1 refuses a known model key among them. */
  envFromKeys?: ReadonlyMap<string, readonly string[]>;
  /** The key names of a Secret a `valueFrom.secretKeyRef` names, or undefined when it does not
   * exist in the namespace (R10). */
  secretKeys?: (name: string) => readonly string[] | undefined;
  /** Every model specifier a carried Agent definition names (`anthropic/claude-sonnet-4-6`) — R9's
   * evidence that a provider's turns will reach its host. */
  models?: readonly string[];
};

/** `heldSecretsOf`'s answer: the manifest, the literal values (host-side only — they go into the
 * `jr2-held-secrets` Secret and nowhere else), and what `jr2 up` should warn about. */
export type HeldResolution = {
  manifest: HeldManifest;
  values: Record<string, string>;
  warnings: string[];
};

const NAME = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_TOKEN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const FRAMING_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "cookie",
]);

/**
 * Normalize `harness.heldSecrets` (plus the implicit `JR2_PROVIDER_API_KEY`) into the manifest,
 * or throw the FIRST refusal. Every message names the config path and never a value, and says
 * what to write instead — the `checkGit` style.
 */
export function heldSecretsOf(config: JR2Config, lookups: HeldLookups = {}): HeldResolution {
  const harness = config.harness ?? {};
  const warnings: string[] = [];
  const env = harness.env ?? [];

  // R7 and R8 first: the catalog and the provider decide the effective hosts every default reads.
  const catalogHosts = new Map<string, string>();
  for (const [id, reach] of Object.entries(harness.catalog ?? {})) {
    if (!MODEL_KEY_PROVIDERS.has(id)) {
      throw new Error(
        `harness.catalog.${id}: "${id}" is not a pi catalog provider jr2 knows a key for — the catalog ids are ` +
          `${[...MODEL_KEY_PROVIDERS].sort().join(", ")} (ADR-0059)`,
      );
    }
    if (harness.provider && harness.provider.id === id) {
      throw new Error(
        `harness.catalog.${id}: "${id}" is also harness.provider.id — a custom provider owns its own baseUrl; ` +
          "rename the custom provider or drop the catalog entry (ADR-0059)",
      );
    }
    const target = httpsTarget(reach.baseUrl);
    if (!target) {
      throw new Error(
        `harness.catalog.${id}.baseUrl must be an https:// URL — the Custodian carries TLS only (ADR-0059). ` +
          'Read it from .env: catalog: { anthropic: { baseUrl: process.env.LITELLM_URL ?? "" } }',
      );
    }
    catalogHosts.set(id, target.port === 443 ? target.host : `${target.host}:${target.port}`);
  }

  // R1: a known model key the Agent could read.
  for (const [i, v] of env.entries()) {
    if (!(v.name in MODEL_KEYS)) continue;
    throw new Error(
      `harness.env[${i}] sets ${v.name}, a model key the Agent could read and take out of the pod — hold it ` +
        `instead: heldSecrets: [${heldLine(v)}] (ADR-0059)`,
    );
  }
  for (const [i, ref] of (harness.envFrom ?? []).entries()) {
    const lookup = ref.secretRef
      ? `secret/${ref.secretRef.name}`
      : ref.configMapRef
        ? `configmap/${ref.configMapRef.name}`
        : "";
    // The env var names, as the kubelet writes them: `prefix` first.
    const keys = (lookups.envFromKeys?.get(lookup) ?? []).map((key) => (ref.prefix ?? "") + key);
    const known = keys.find((key) => key in MODEL_KEYS);
    if (known === undefined) continue;
    const where = ref.secretRef ? `Secret "${ref.secretRef.name}"` : `ConfigMap "${ref.configMapRef?.name}"`;
    throw new Error(
      `harness.envFrom[${i}] loads ${where}, which carries ${known} — a model key the Agent could read. Hold it ` +
        `instead: heldSecrets: [{ name: "${known}", valueFrom: { secretKeyRef: { name: "${ref.secretRef?.name ?? "<secret>"}", key: "${known}" } } }], ` +
        `and drop the key from that ${ref.secretRef ? "Secret" : "ConfigMap"} (ADR-0059)`,
    );
  }
  for (const v of env) {
    if (SIGNING_CREDENTIALS.includes(v.name)) {
      warnings.push(
        `harness.env sets ${v.name}: a signing credential cannot be held (a Stand-in cannot be swapped into a ` +
          "signature), so the Agent can read it — route the provider through a gateway that holds it, and hold " +
          "the gateway's key instead (ADR-0059)",
      );
    }
  }

  type Entry = {
    at: string;
    name: string;
    value?: string;
    valueFrom?: { secretKeyRef: { name: string; key: string } };
    hosts?: readonly string[];
    headers?: readonly string[];
    paths?: readonly string[];
  };
  const entries: Entry[] = (harness.heldSecrets ?? []).map((s, i) => ({ at: `harness.heldSecrets[${i}]`, ...s }));

  // R2, for the user's own entries — before the implicit one joins them.
  for (const e of entries) {
    if (!NAME.test(e.name)) {
      throw new Error(`${e.at}.name "${e.name}" is not an env var name ([A-Z_][A-Z0-9_]*) (ADR-0059)`);
    }
    if (e.name.startsWith("JR2_") || MECHANISM_ENV.includes(e.name)) {
      throw new Error(
        `${e.at}.name ${e.name} is the kit's — JR2_ names and the proxy and trust variables belong to the ` +
          "mechanism (ADR-0059). Name the env var your client reads.",
      );
    }
  }

  // The custom provider's key: held since ADR-0059, bound to its own endpoint.
  const provider = harness.provider;
  if (provider?.apiKey) {
    const target = httpsTarget(provider.baseUrl);
    if (!target) {
      throw new Error(
        "harness.provider.apiKey is set, and harness.provider.baseUrl is not https:// — the key is a held secret " +
          "and the Custodian carries TLS only (ADR-0059). Serve the endpoint over TLS (and name its CA in " +
          "harness.caBundle), or drop apiKey for an endpoint that needs none.",
      );
    }
    entries.push({
      at: "harness.provider.apiKey",
      name: PROVIDER_KEY_NAME,
      value: provider.apiKey,
      hosts: [provider.baseUrl],
      headers: DEFAULT_CREDENTIAL_HEADERS,
    });
  }

  if (entries.length > 0) {
    // R11: the mechanism's names are the mechanism's while it runs.
    for (const [i, v] of env.entries()) {
      if (MECHANISM_ENV.includes(v.name)) {
        throw new Error(
          `harness.env[${i}] sets ${v.name}, which the Custodian owns while a held secret exists — it cannot ` +
            "chain to another proxy or trust store yet. Drop the entry; put a private CA in harness.caBundle (ADR-0059).",
        );
      }
    }
  }

  const envNames = new Set(env.map((v) => v.name));
  const seen = new Set<string>();
  const values: Record<string, string> = {};
  const secrets: HeldBinding[] = [];
  for (const e of entries) {
    // R3
    if (seen.has(e.name)) throw new Error(`${e.at}.name ${e.name} is held twice — one env var, one meaning (ADR-0059)`);
    seen.add(e.name);
    if (envNames.has(e.name)) {
      throw new Error(
        `${e.at}.name ${e.name} is also set by harness.env — drop that entry; the Harness sees the Stand-in (ADR-0059)`,
      );
    }

    // R4
    const source = sourceOf(e, lookups);
    if (source.kind === "literal") values[e.name] = e.value as string;

    // R6
    const headers = [...(e.headers ?? DEFAULT_CREDENTIAL_HEADERS)];
    const seenHeader = new Set<string>();
    for (const [j, header] of headers.entries()) {
      if (!HEADER_TOKEN.test(header) || FRAMING_HEADERS.has(header) || header.startsWith("proxy-")) {
        throw new Error(
          `${e.at}.headers[${j}] "${header}" cannot carry a held secret — a lowercase header name that does not ` +
            "frame or route the request (not host, content-length, transfer-encoding, connection, upgrade, te, " +
            "trailer, keep-alive, cookie, proxy-*) (ADR-0059)",
        );
      }
      if (seenHeader.has(header)) throw new Error(`${e.at}.headers lists "${header}" twice (ADR-0059)`);
      seenHeader.add(header);
    }

    // R12
    const paths = e.paths === undefined ? undefined : [...e.paths];
    for (const [j, path] of (paths ?? []).entries()) {
      if (!/^\/[A-Za-z0-9._~!$&'()*+,=:@%/-]*$/.test(path) || path.includes("..") || /%2e|%2f|%5c/i.test(path)) {
        throw new Error(
          `${e.at}.paths[${j}] "${path}" must start with "/" and hold no "..", ";", "%2e", "%2f" or "%5c" — a prefix the ` +
            "request could step around is no prefix (ADR-0059)",
        );
      }
    }

    // R5 (+ the §3.4 default and R9)
    const hosts = hostsOf(e, catalogHosts, lookups.models ?? []);
    secrets.push({
      name: e.name,
      source,
      hosts: hosts.map((t) => ({ ...t, leaf: leafStem(t.host, t.port) })),
      headers,
      ...(paths ? { paths } : {}),
    });
  }

  // R13: a held value the Harness container is also handed, under any name, is not held — `env`
  // wins only a same-name collision (R3), so the Stand-in cannot cover it under another name. The
  // kit's own Secrets are never the Harness's, whatever is held.
  const heldBy = (secret: string, key?: string): string | undefined =>
    secrets.find(
      (b) => b.source.kind === "secret" && b.source.secret === secret && (key === undefined || b.source.key === key),
    )?.name;
  for (const [i, v] of env.entries()) {
    const ref = (v.valueFrom as { secretKeyRef?: { name?: string; key?: string } } | undefined)?.secretKeyRef;
    if (ref?.name !== undefined && KIT_SECRETS.includes(ref.name)) {
      throw new Error(
        `harness.env[${i}] (${v.name}) reads Secret "${ref.name}", which is the kit's and never the Harness's — the ` +
          "Agent would read it. Drop the entry (ADR-0059)",
      );
    }
    const by = ref?.name !== undefined ? heldBy(ref.name, ref.key) : undefined;
    if (by !== undefined) {
      throw new Error(
        `harness.env[${i}] reads key "${ref!.key}" of Secret "${ref!.name}", which ${by} holds — the Agent would ` +
          `read it as ${v.name}. Drop the entry; the Harness sees the Stand-in as ${by} (ADR-0059)`,
      );
    }
    const same = v.value !== undefined ? Object.keys(values).find((n) => values[n] === v.value) : undefined;
    if (same !== undefined) {
      throw new Error(
        `harness.env[${i}] (${v.name}) is set to the value ${same} holds — the Agent would read it there. Drop the ` +
          `entry; the Harness sees the Stand-in as ${same} (ADR-0059)`,
      );
    }
  }
  for (const [i, ref] of (harness.envFrom ?? []).entries()) {
    const secret = ref.secretRef?.name;
    if (secret === undefined) continue;
    if (KIT_SECRETS.includes(secret)) {
      throw new Error(
        `harness.envFrom[${i}] loads Secret "${secret}", which is the kit's and never the Harness's — the Agent ` +
          "would read every key of it. Drop the entry (ADR-0059)",
      );
    }
    const by = heldBy(secret);
    if (by !== undefined) {
      throw new Error(
        `harness.envFrom[${i}] loads Secret "${secret}", which ${by} holds — the Agent would read every key of it ` +
          "from its env. Move the held key to a Secret harness.envFrom does not load (ADR-0059)",
      );
    }
  }

  // R5: one header on one host names one secret.
  const byTarget = new Map<string, { name: string; headers: string[] }[]>();
  for (const s of secrets) {
    for (const h of s.hosts) {
      const key = `${h.host}:${h.port}`;
      for (const other of byTarget.get(key) ?? []) {
        const shared = s.headers.filter((header) => other.headers.includes(header));
        if (shared.length > 0) {
          throw new Error(
            `${s.name} and ${other.name} are both bound to ${key} in header ${shared.join(", ")} — one header on ` +
              "one host carries one secret; give each its own `headers` (ADR-0059)",
          );
        }
      }
      byTarget.set(key, [...(byTarget.get(key) ?? []), { name: s.name, headers: s.headers }]);
    }
  }

  return { manifest: { version: 1, secrets }, values, warnings };
}

/** R4 and R10: exactly one source, and a literal that can ride a header. */
function sourceOf(
  e: { at: string; name: string; value?: string; valueFrom?: { secretKeyRef: { name: string; key: string } } },
  lookups: HeldLookups,
): HeldBinding["source"] {
  const hasValue = e.value !== undefined;
  if (hasValue === (e.valueFrom !== undefined)) {
    throw new Error(
      `${e.at} needs exactly one of value or valueFrom — ` +
        (hasValue
          ? "not both"
          : `${e.name} has neither, which is what an unset .env variable reads as: set ${e.name} in .env, or ` +
            "reference a Secret with valueFrom: { secretKeyRef: { name, key } }") +
        " (ADR-0059)",
    );
  }
  if (e.valueFrom) {
    const { name, key } = e.valueFrom.secretKeyRef;
    const keys = lookups.secretKeys?.(name);
    if (keys === undefined) {
      throw new Error(
        `${e.at}.valueFrom names Secret "${name}", which does not exist in the instance's namespace — create it ` +
          `first: kubectl create secret generic ${name} --from-literal=${key}=... (ADR-0019, ADR-0059)`,
      );
    }
    if (!keys.includes(key)) {
      throw new Error(`${e.at}.valueFrom names key "${key}" of Secret "${name}", which has no such key (ADR-0059)`);
    }
    return { kind: "secret", secret: name, key };
  }
  const value = e.value as string;
  if (value === "") {
    throw new Error(`${e.at}.value is empty — set ${e.name} in .env (ADR-0059)`);
  }
  if (!/^[\x20-\x7e]+$/.test(value) || value !== value.trim()) {
    throw new Error(
      `${e.at}.value holds a character a header cannot carry (outside printable ASCII) or leading or trailing ` +
        "space — a pasted newline, most likely; the value itself is not shown (ADR-0059)",
    );
  }
  return { kind: "literal" };
}

/** R5 and R9: where one secret may go. A known model key with no `hosts` goes where its provider's
 * calls go — the catalog override's host, else the table's — so the key and the calls read one
 * config and cannot drift. */
function hostsOf(
  e: { at: string; name: string; hosts?: readonly string[] },
  catalogHosts: ReadonlyMap<string, string>,
  models: readonly string[],
): Array<{ host: string; port: number }> {
  const known = MODEL_KEYS[e.name];
  const effective = new Map<string, string | undefined>();
  for (const provider of known?.providers ?? []) effective.set(provider, catalogHosts.get(provider) ?? known?.host);

  if (e.hosts === undefined || e.hosts.length === 0) {
    const defaults = new Set(effective.values());
    const only = defaults.size === 1 ? [...defaults][0] : undefined;
    if (e.hosts === undefined && only !== undefined) return [parseTarget(`${e.at}.hosts`, only)];
    throw new Error(
      `${e.at}.hosts is ${e.hosts === undefined ? "absent" : "empty"}, and ${e.name} has no single default host — ` +
        'name where the value may go: hosts: ["gateway.example.com"] (ADR-0059)',
    );
  }

  const targets = e.hosts.map((entry, j) => parseTarget(`${e.at}.hosts[${j}]`, entry));
  for (const [provider, host] of effective) {
    if (host === undefined) continue;
    if (!models.some((m) => m.startsWith(`${provider}/`))) continue;
    const want = parseTarget(`${e.at}.hosts`, host);
    if (targets.some((t) => t.host === want.host && t.port === want.port)) continue;
    throw new Error(
      `${e.at}.hosts leaves out ${want.host}${want.port === 443 ? "" : `:${want.port}`}, where pi sends every ` +
        `"${provider}/…" turn an Agent here names — each would arrive with the Stand-in and fail with 401. Add it, ` +
        `or drop hosts to take that default (ADR-0059)`,
    );
  }
  return targets;
}

/** An `https://` URL's host and port, or undefined for anything else. */
function httpsTarget(url: string): { host: string; port: number } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) return undefined;
  return { host: normalHost(parsed.hostname), port: parsed.port ? Number(parsed.port) : 443 };
}

/** One `hosts` entry: `host`, `host:port`, `[v6]:port`, or an `https://` URL (R5). */
export function parseTarget(at: string, entry: string): { host: string; port: number } {
  const refuse = (why: string): never => {
    throw new Error(`${at} "${entry}" ${why} — an entry is host, host:port, or an https:// URL (ADR-0059)`);
  };
  if (entry.includes("*")) refuse("holds a wildcard; a binding names exact hosts");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
    if (!/^https:\/\//i.test(entry)) refuse("is not https://; the Custodian carries TLS only");
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return refuse("is not a URL");
    }
    if (url.username || url.password) refuse("carries userinfo");
    return checkedTarget(refuse, url.hostname, url.port ? Number(url.port) : 443);
  }
  if (/[/?#@\s]/.test(entry)) refuse("has a path, a query or userinfo on a bare host");
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed) return checkedTarget(refuse, bracketed[1] as string, portOf(refuse, bracketed[2]));
  if (isIP(entry) === 6) return checkedTarget(refuse, entry, 443);
  const [host, port, extra] = entry.split(":");
  if (extra !== undefined) refuse("is not host:port");
  return checkedTarget(refuse, host as string, portOf(refuse, port));
}

function portOf(refuse: (why: string) => never, raw: string | undefined): number {
  if (raw === undefined) return 443;
  if (!/^\d+$/.test(raw)) return refuse("has a port that is not a number");
  return Number(raw);
}

function checkedTarget(refuse: (why: string) => never, rawHost: string, port: number): { host: string; port: number } {
  if (!Number.isInteger(port) || port < 1 || port > 65535) refuse("has a port outside 1–65535");
  const host = normalHost(rawHost);
  if (isIP(host) === 0 && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    refuse("is not a DNS name or an IP literal");
  }
  return { host, port };
}

/** One spelling per host: lowercase, no trailing dot, no IPv6 brackets, IPv6 compressed — the form
 * the Custodian compares a CONNECT target in. */
export function normalHost(raw: string): string {
  const bare = raw
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (isIP(bare) === 6) return new URL(`https://[${bare}]/`).hostname.replace(/^\[|\]$/g, "");
  return bare;
}

/** The `heldSecrets` line R1 hands back, built from the entry it refuses. */
function heldLine(v: HarnessEnvVar): string {
  const ref = (v.valueFrom as { secretKeyRef?: { name?: string; key?: string } } | undefined)?.secretKeyRef;
  if (ref?.name && ref.key) {
    return `{ name: "${v.name}", valueFrom: { secretKeyRef: { name: "${ref.name}", key: "${ref.key}" } } }`;
  }
  return `{ name: "${v.name}", value: process.env.${v.name} }`;
}

/**
 * Read the manifest `jr2 up` wrote (`held.json`, mounted from the `jr2-held` ConfigMap), per call —
 * the `readImageRefs` stance (ADR-0038): no cache, so a `jr2 up` that changes a held secret reaches
 * the next provision without rolling the Orchestrator. Absent or malformed is a pointed error naming
 * `jr2 up`, never "nothing held": a Sandbox composed on a guess would put a key where the converge
 * did not, or leave out one it did.
 */
export async function readHeldManifest(path: string): Promise<HeldManifest> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `no held-secret manifest at ${path} (${(err as NodeJS.ErrnoException).code ?? "read failed"}) — every ` +
        "Harness pod's Custodian is composed from the `jr2-held` ConfigMap, which `jr2 up` writes (ADR-0059). " +
        "Converge this instance with `jr2 up`.",
    );
  }
  const bad = (why: string): never => {
    throw new Error(`the held-secret manifest at ${path} is malformed: ${why} — re-run \`jr2 up\` (ADR-0059).`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return bad(`not JSON (${err instanceof Error ? err.message : err})`);
  }
  const manifest = parsed as Partial<HeldManifest>;
  if (manifest?.version !== 1 || !Array.isArray(manifest.secrets))
    return bad("expected { version: 1, secrets: [...] }");
  for (const s of manifest.secrets) {
    if (typeof s?.name !== "string" || !Array.isArray(s.hosts) || !Array.isArray(s.headers)) {
      bad(`an entry is not { name, source, hosts, headers } (got ${JSON.stringify(s)})`);
    }
  }
  return manifest as HeldManifest;
}
