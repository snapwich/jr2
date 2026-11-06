// Held secrets (ADR-0059): credentials the Harness uses and never holds — the entries of the
// `secrets` list that a Harness pod claims: a `workspace()` lists it under `secrets`, or a provider
// an Agent there names reads it (secret-placement.ts places each one, ADR-0068).
//
// The Agent executes code in the Harness container (ADR-0005), so a key in that container's env is
// a key it can take out of the pod. A held secret is not there: the Harness's env carries a
// STAND-IN, and the Custodian — a container of the same pod that the Agent executes nothing in —
// puts the value into requests toward the hosts the secret is bound to, and nowhere else.
//
// This module is the pure half, shared by every seat that needs it:
//
//   heldStandIn(...)     a held secret's Stand-in, minted per pod by the pod's maker — secret
//   standIn(name)        the fetch Stand-in's form — deterministic and public, for that one alone
//   heldSecretsOf(...)   `jr2 up`'s normalization of the claimed entries: every refusal (R1–R13),
//                        every warning, and the engine-neutral bindings each pod's manifest
//                        (`held-<pod>.json`) takes its own from
//
// It runs HOST-SIDE, in `jr2 up`, because only there does the config carry values: in-cluster,
// `process.env` has no `.env`, so a `value` reads `undefined` and a `hosts` entry built from `.env`
// reads `""`. The in-cluster Orchestrator never re-derives any of this. It reads the manifest
// `jr2 up` wrote, per provision, from a mount (the `jr2-images` pattern, ADR-0038).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isStdioServer, type JR2Config, type HarnessEnvVar } from "./config.ts";
import {
  CREDENTIAL_FILES,
  DOMAIN_WRITABLE_ROOTS,
  MODEL_KEYS,
  MODEL_KEY_PROVIDERS,
  SIGNING_CREDENTIALS,
} from "./model-keys.ts";
import {
  HELD_CA_SECRET,
  HELD_SECRETS_SECRET,
  HELD_TLS_SECRET,
  INSTANCE_EFFECTOR,
  INSTANCE_HARNESS_SERVICE,
  INSTANCE_SECRET,
} from "./names.ts";
import type { PlacementRoute } from "./parts.ts";
import { sign } from "./tokens.ts";

/** The kit's Secrets no Harness container may read (R13): the Instance token and signing key, each
 * pod's literal held values, the leaves, the CA, and every Effector's (ADR-0068) — the Instance
 * Effector's Effect secrets and key, each Workspace's Sandbox Effector Secret (`jr2-effector-<pod>`),
 * each Sandbox's Effector key (`<sandbox>-effector`), and each `git.credentials` entry's clone and
 * push Secrets (`jr2-git-<hash>`, `jr2-git-push-<hash>`, ADR-0051) — and each pod's own credentials
 * (ADR-0076): the Instance Harness's (`jr2-instance-harness-token`) and each Sandbox's
 * (`<sandbox>-token`), which hold the real control token beside the Stand-ins. */
const KIT_SECRETS: readonly string[] = [
  INSTANCE_SECRET,
  HELD_TLS_SECRET,
  HELD_CA_SECRET,
  INSTANCE_EFFECTOR,
  `${INSTANCE_HARNESS_SERVICE}-token`,
];
const KIT_SECRET_PREFIXES: readonly string[] = [`${HELD_SECRETS_SECRET}-`, "jr2-effector-", "jr2-git-"];
const isKitSecret = (name: string): boolean =>
  KIT_SECRETS.includes(name) ||
  name === HELD_SECRETS_SECRET ||
  KIT_SECRET_PREFIXES.some((p) => name.startsWith(p)) ||
  // A Sandbox's own Effector key and its credentials: every Sandbox's name starts `ws-`
  // (`workspaceName`).
  (name.startsWith("ws-") && (name.endsWith("-effector") || name.endsWith("-token")));

/**
 * The pod key of one Workspace (ADR-0059): its registered workflow and the placement route to its
 * `workspace()` (`PlacementRoute`) — what `jr2 up` reads off the walk and the run host off the live
 * actor (`actorRoute`), so both name one pod alike. Every Workspace has a route of its own, an
 * inline-invoked one included, so two Workspaces never share a key. A digest, so it is a name a
 * Secret and a ConfigMap key can carry; `ws-` keeps it apart from the Instance Harness's.
 */
export function workspaceHeldPod(at: { workflow: string; route: PlacementRoute }): string {
  const key = JSON.stringify([at.workflow, at.route]);
  return `ws-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/**
 * The names a provider claims for a pod (ADR-0059): the `secrets` entries that are a known model key
 * the provider of one of `models` reads, and the custom provider's key when an Agent there names
 * that provider. A model key is claimed by the PROVIDER — the Agent names its model, jr2 knows which
 * key that provider reads — so it is not listed under a `workspace()`'s `secrets`.
 */
export function providerClaims(config: JR2Config, models: readonly string[]): string[] {
  const providers = new Set(models.map((m) => m.split("/")[0] ?? ""));
  const claims = (config.secrets ?? [])
    .filter((s) => MODEL_KEYS[s.name]?.providers.some((p) => providers.has(p)))
    .map((s) => s.name);
  const custom = config.harness?.provider;
  if (custom?.apiKey && providers.has(custom.id)) claims.push(PROVIDER_KEY_NAME);
  return claims;
}

/**
 * The PUBLIC Stand-in form, `jr2-held-<NAME>`. Since ADR-0076 one Stand-in alone takes it: the fetch
 * Stand-in, `standIn("JR2_SANDBOX_TOKEN")`, which `jr2-upload-pack` holds as a constant and the
 * Custodian swaps on the fetch route alone. Every other Stand-in is secret ({@link heldStandIn}).
 */
export function standIn(name: string): string {
  return `jr2-held-${name}`;
}

/** What a Stand-in must never contain (ADR-0059): pi reads a key with it as an Anthropic OAuth
 * token, and answers with different auth headers. */
const OAUTH_MARK = "sk-ant-oat";

/**
 * The SECRET Stand-in of one held secret in one pod (ADR-0059, ADR-0076): what the Harness process
 * holds for it, as the file `/run/jr2/standins/<NAME>`, and what the Custodian of that pod swaps for
 * the value. `jr2-held-<NAME>.<hmac>` — the readable prefix keeps a log scrub's pattern, and the
 * HMAC under the signing key makes it unguessable, so Workspace code can spend only the secrets its
 * `workspace()` grants. `pod` is the Sandbox's name, or `instance` for the Instance Harness. The
 * pod's maker mints it: the Orchestrator for a Sandbox, `jr2 up` for the Instance Harness and a
 * check pod. ASCII letters, digits, `-`, `_` and `.` only, so it is a valid header and env value,
 * and it never contains `sk-ant-oat`: a signature that would is signed again under a counter.
 */
export function heldStandIn(key: Buffer, pod: string, name: string): string {
  for (let n = 0; ; n++) {
    const domain = `held-standin:${pod}/${name}${n === 0 ? "" : `#${n}`}`;
    const value = `${standIn(name)}.${sign(key, domain)}`;
    if (!value.includes(OAUTH_MARK)) return value;
  }
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

/** The fetch token's held name (ADR-0013, ADR-0076) — a held secret of the kit's own, bound to the
 * Orchestrator's fetch route (ADR-0059). Its Stand-in is the public `jr2-held-JR2_SANDBOX_TOKEN`,
 * which `jr2-upload-pack` holds; the Custodian holds the token. */
export const SANDBOX_TOKEN_NAME = "JR2_SANDBOX_TOKEN";

/** The control token's held name (ADR-0076) — the kit's own, bound to the agent routes. Its Stand-in
 * is secret: the Harness process alone holds it, as `/run/jr2/control/standin`. */
export const CONTROL_TOKEN_NAME = "JR2_CONTROL_TOKEN";

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

/** What `jr2 up` placed in one pod; what its composition reads (`held-<pod>.json` in the `jr2-held`
 * ConfigMap). Values never appear here. */
export type HeldManifest = { version: 1; secrets: HeldBinding[] };

/** One held secret, normalized. */
export type HeldBinding = {
  /** The env var; the Harness sees `standIn(name)`. */
  name: string;
  /** A literal lands in its pod's `jr2-held-secrets-<pod>` Secret under `name`; a `secret` is the user's own
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
  /** The length in characters of one key's value in a Secret a `valueFrom.secretKeyRef` names —
   * never the value — or undefined when it is not known. An Effect secret shorter than 8 characters
   * is refused by it as a literal is (ADR-0068). */
  valueLength?: (name: string, key: string) => number | undefined;
  /** Every model specifier a carried Agent definition names (`anthropic/claude-sonnet-4-6`) — R9's
   * evidence that a provider's turns will reach its host. */
  models?: readonly string[];
};

/** `heldSecretsOf`'s answer: every claimed binding, the literal values (host-side only — each goes
 * into the `jr2-held-secrets-<pod>` Secret of a pod that claims it and nowhere else), and what
 * `jr2 up` should warn about. */
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
 * Normalize the Held secrets — the entries of the `secrets` list some pod claims, and the implicit
 * `JR2_PROVIDER_API_KEY` when one claims it (`claimed`, from secret-placement.ts) — into bindings, or
 * throw the FIRST refusal. Every message names the config path and never a value, and says what to
 * write instead — the `checkGit` style. An entry no pod claims is not this function's: `hosts`,
 * `headers` and `paths` are the binding, never the placement, so R5 fires only for a claimed one.
 */
export function heldSecretsOf(
  config: JR2Config,
  claimed: ReadonlySet<string>,
  lookups: HeldLookups = {},
): HeldResolution {
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

  // R7 for an MCP server (ADR-0079): one with a `secret` needs an https url, because the Custodian
  // carries TLS only. Its url's host is the default binding of the secret it names (`hostsOf`).
  const serverHosts = new Map<string, Array<{ server: string; host: string; port: number; path: string }>>();
  for (const [server, declared] of Object.entries(config.mcp ?? {})) {
    if (isStdioServer(declared) || declared.secret === undefined || !claimed.has(declared.secret)) continue;
    const target = httpsTarget(declared.url);
    if (!target) {
      throw new Error(
        `mcp.${server}.url must be an https:// URL — the server has a secret, ${declared.secret}, and the Custodian ` +
          "carries TLS only (ADR-0059, ADR-0079). Read it from .env: " +
          `mcp: { "${server}": { url: process.env.${server.toUpperCase().replace(/-/g, "_")}_URL ?? "", secret: "${declared.secret}" } }`,
      );
    }
    const path = new URL(declared.url).pathname || "/";
    serverHosts.set(declared.secret, [...(serverHosts.get(declared.secret) ?? []), { server, ...target, path }]);
  }

  // jr2's own names (ADR-0076): the Harness's start takes a `JR2_` name from jr2's composition alone,
  // and refuses to start on an envFrom key that starts with `JR2_` (`effector nocore --harness-env`).
  // A user's `JR2_MENU_ONLY` or `JR2_START_ENV` would turn the domain off or replace its env.
  for (const [i, v] of env.entries()) {
    if (v.name.startsWith("JR2_")) {
      throw new Error(
        `harness.env[${i}] sets ${v.name}: JR2_ names are jr2's own, and the Harness takes them from jr2 alone ` +
          "(ADR-0076). Name the env var your program reads.",
      );
    }
  }
  for (const [i, ref] of (harness.envFrom ?? []).entries()) {
    const lookup = ref.secretRef
      ? `secret/${ref.secretRef.name}`
      : ref.configMapRef
        ? `configmap/${ref.configMapRef.name}`
        : "";
    const own = (lookups.envFromKeys?.get(lookup) ?? [])
      .map((key) => (ref.prefix ?? "") + key)
      .find((key) => key.startsWith("JR2_"));
    if (own !== undefined) {
      const where = ref.secretRef ? `Secret "${ref.secretRef.name}"` : `ConfigMap "${ref.configMapRef?.name}"`;
      throw new Error(
        `harness.envFrom[${i}] loads ${where}, which carries ${own}: JR2_ names are jr2's own, and the Harness ` +
          "does not start with one from envFrom (ADR-0076). Drop the key, or give the source a prefix.",
      );
    }
  }

  // R1: a known model key the Agent could read.
  for (const [i, v] of env.entries()) {
    if (!(v.name in MODEL_KEYS)) continue;
    throw new Error(
      `harness.env[${i}] sets ${v.name}, a model key the Agent could read and take out of the pod — hold it ` +
        `instead: secrets: [${heldLine(v)}] (ADR-0059)`,
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
        `instead: secrets: [{ name: "${known}", valueFrom: { secretKeyRef: { name: "${ref.secretRef?.name ?? "<secret>"}", key: "${known}" } } }], ` +
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

  // A credential file that the Harness process reads (ADR-0076): never one that the domain writes.
  for (const [i, v] of env.entries()) {
    if (!CREDENTIAL_FILES.includes(v.name)) continue;
    const path = v.value;
    if (path !== undefined) {
      const writable = DOMAIN_WRITABLE_ROOTS.find((root) => path === root || path.startsWith(`${root}/`));
      if (!path.startsWith("/") || writable !== undefined || path.split("/").includes("..")) {
        throw new Error(
          `harness.env[${i}] sets ${v.name} to "${path}", ${writable !== undefined ? `which is in ${writable}, a folder the Agent's code writes` : "which is not an absolute path"}: the Harness process reads that file, and code that writes it acts outside the Agent's confinement (ADR-0076). Point it at a file of the image that the Sandbox's user cannot write.`,
        );
      }
    }
    warnings.push(
      `harness.env sets ${v.name}: the Harness process reads ${path !== undefined ? `"${path}"` : "the file it names"}, ` +
        "so the Sandbox's user must not be able to write it — a folder of the image that the user owns is one the " +
        "Agent's code writes (ADR-0076)",
    );
  }
  for (const [i, ref] of (harness.envFrom ?? []).entries()) {
    const lookup = ref.secretRef
      ? `secret/${ref.secretRef.name}`
      : ref.configMapRef
        ? `configmap/${ref.configMapRef.name}`
        : "";
    for (const key of (lookups.envFromKeys?.get(lookup) ?? []).map((k) => (ref.prefix ?? "") + k)) {
      if (!CREDENTIAL_FILES.includes(key)) continue;
      warnings.push(
        `harness.envFrom[${i}] sets ${key}: the Harness process reads the file it names, so the Sandbox's user must ` +
          "not be able to write it — a folder of the image that the user owns is one the Agent's code writes (ADR-0076)",
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
  const entries: Entry[] = (config.secrets ?? []).flatMap((s, i) =>
    claimed.has(s.name) ? [{ at: `secrets[${i}]`, ...s }] : [],
  );

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
  if (provider?.apiKey && claimed.has(PROVIDER_KEY_NAME)) {
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

    // R6. An MCP server's secret with no binding goes in `authorization` alone (ADR-0079): the
    // Harness sends `Authorization: Bearer <Stand-in>`.
    const mcpDefault = e.hosts === undefined && e.headers === undefined && serverHosts.has(e.name);
    const headers = [...(e.headers ?? (mcpDefault ? ["authorization"] : DEFAULT_CREDENTIAL_HEADERS))];
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
    // R6 for an MCP server's secret (ADR-0079): the Harness sends its Stand-in in `authorization`
    // alone, so a binding without that header removes it on each call.
    for (const s of serverHosts.get(e.name) ?? []) {
      if (headers.includes("authorization")) break;
      throw new Error(
        `${e.at}.headers leaves out "authorization", where the Harness sends the Stand-in of ${e.name} to ` +
          `mcp.${s.server}.url — each call of that server would arrive with no credential. Add it, or drop headers ` +
          "to take that default (ADR-0059, ADR-0079)",
      );
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
    // R12 for an MCP server's secret (ADR-0079): every call goes to the url's path, so `paths` must
    // cover it, by the prefix rule the Custodian applies.
    for (const s of serverHosts.get(e.name) ?? []) {
      if (paths === undefined || paths.some((p) => pathCovers(p, s.path))) continue;
      throw new Error(
        `${e.at}.paths does not cover ${s.path}, the path of mcp.${s.server}.url, whose secret ${e.name} is — ` +
          `each call of that server would be refused with 403. Add "${s.path}", or drop paths (ADR-0059, ADR-0079)`,
      );
    }

    // R5 (+ the §3.4 default and R9)
    const hosts = hostsOf(e, catalogHosts, lookups.models ?? [], serverHosts.get(e.name) ?? []);
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
    if (ref?.name !== undefined && isKitSecret(ref.name)) {
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
    if (isKitSecret(secret)) {
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

  return { manifest: { version: 1, secrets }, values, warnings };
}

/** R4 and R10: exactly one source, and a literal that can ride a header. */
export function sourceOf(
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
 * config and cannot drift. An MCP server's secret with no `hosts` goes to the host of the url of
 * each server that names it (ADR-0079), for the same reason. */
function hostsOf(
  e: { at: string; name: string; hosts?: readonly string[] },
  catalogHosts: ReadonlyMap<string, string>,
  models: readonly string[],
  servers: ReadonlyArray<{ server: string; host: string; port: number }>,
): Array<{ host: string; port: number }> {
  const known = MODEL_KEYS[e.name];
  const effective = new Map<string, string | undefined>();
  for (const provider of known?.providers ?? []) effective.set(provider, catalogHosts.get(provider) ?? known?.host);

  if (e.hosts === undefined && servers.length > 0) {
    const out: Array<{ host: string; port: number }> = [];
    const add = (t: { host: string; port: number }) => {
      if (!out.some((o) => o.host === t.host && o.port === t.port)) out.push({ host: t.host, port: t.port });
    };
    for (const s of servers) add(s);
    // A model key that an MCP server also names keeps its provider's host beside the servers'.
    const defaults = new Set(effective.values());
    const only = defaults.size === 1 ? [...defaults][0] : undefined;
    if (only !== undefined) add(parseTarget(`${e.at}.hosts`, only));
    return out;
  }

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
  for (const s of servers) {
    if (targets.some((t) => t.host === s.host && t.port === s.port)) continue;
    throw new Error(
      `${e.at}.hosts leaves out ${s.host}${s.port === 443 ? "" : `:${s.port}`}, the host of mcp.${s.server}.url, ` +
        `whose secret ${e.name} is — each call of that server would arrive with the Stand-in and fail with 401. ` +
        "Add it, or drop hosts to take that default (ADR-0059, ADR-0079)",
    );
  }
  return targets;
}

/** Whether the `paths` entry `prefix` lets a request to `path` through: the Custodian's rule — the
 * same path, or `prefix` and then a `/` (or `prefix` ends in `/`). */
function pathCovers(prefix: string, path: string): boolean {
  return path === prefix || (path.startsWith(prefix) && (prefix.endsWith("/") || path.charAt(prefix.length) === "/"));
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

/** The `secrets` line R1 hands back, built from the entry it refuses. */
function heldLine(v: HarnessEnvVar): string {
  const ref = (v.valueFrom as { secretKeyRef?: { name?: string; key?: string } } | undefined)?.secretKeyRef;
  if (ref?.name && ref.key) {
    return `{ name: "${v.name}", valueFrom: { secretKeyRef: { name: "${ref.name}", key: "${ref.key}" } } }`;
  }
  return `{ name: "${v.name}", value: process.env.${v.name} }`;
}

/**
 * Read the manifest `jr2 up` wrote for one pod (`held-<pod>.json`, mounted from the `jr2-held`
 * ConfigMap), per call —
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
        "Harness pod's Custodian is composed from its own manifest in the `jr2-held` ConfigMap, which `jr2 up` " +
        "writes for each Workspace it walked (ADR-0059). Converge this instance with `jr2 up`.",
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
