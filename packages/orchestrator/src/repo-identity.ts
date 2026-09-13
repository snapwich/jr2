// A Repo's identity and its cache key (ADR-0051). The url IS the identity — the string a Machine
// writes on its Repo Slot. Two spellings of one repository — `https://`, `git@…:`, `ssh://`, with or without
// `.git`, a trailing `/`, a default port, an upper-case host — resolve to ONE identity (host plus
// path, scheme and user dropped) and therefore one node cache. The key is the identity made into a
// DNS-1123 label: the Repo CR's `metadata.name`, the hostPath leaf, the in-pod mount `/repos/<key>`,
// and the pod volume name `repo-<key>`.
//
// Pure, no I/O. Shared by the Orchestrator (the Machine walk's bound urls, the CR it creates, the
// cache it mounts, and the credentials fence a per-run url meets at provision), the CLI (which
// groups the walk's bound ssh urls by the credential Secret each identity matches, for the
// ADR-0047 prompt — it judges nothing), and the e2e steps (the mount path they assert) — every
// side derives the same key from the same string, and nothing ever writes one down.

import { createHash } from "node:crypto";

export type RepoIdentity = {
  /** `host/path` for a remote (host lower-cased, a non-default port kept as `host:port`), or the
   * absolute path for a local repository. Path case is KEPT: hosts are case-insensitive, paths on
   * most forges are not. */
  identity: string;
  /** `<slug>-<sha256(identity)[:8]>` — a DNS-1123 label of at most 49 characters. */
  key: string;
  scheme: "https" | "http" | "ssh" | "git" | "local";
};

/** The schemes git clones from, as spelled → as named; `git+ssh` is ssh. */
const SCHEME: Record<string, RepoIdentity["scheme"]> = {
  https: "https",
  http: "http",
  ssh: "ssh",
  "git+ssh": "ssh",
  git: "git",
};

/** Default ports, dropped from the identity — `ssh://host:22/x` and `ssh://host/x` are one Repo. */
const DEFAULT_PORT: Record<string, string> = { ssh: "22", https: "443", http: "80", git: "9418" };

/** `git@host:org/repo.git` — the scp-style ssh spelling: an optional user, a host, a colon, a
 * path that is NOT `//` (that would be a scheme). */
const SCP_STYLE = /^(?:[^@/:]+@)?([^:/@]+):(?!\/\/)(.+)$/;

/** Resolve a url to its identity and cache key. Throws on an empty, relative, or unparseable url,
 * a scheme git cannot clone from, or a url that begins with `-` — the caller's spelling is the
 * error's subject. */
export function repoIdentity(url: string): RepoIdentity {
  const raw = url.trim();
  if (raw === "") throw new Error("repo url is empty");
  // No repository is spelled with a leading `-`, and git reads such an argv element as an OPTION
  // (`--upload-pack=<command>` runs a shell). A per-run url is run input, so the identity — the
  // one thing the credentials fence inspects — refuses the shape; the cache agent's `--` is the
  // second lock.
  if (raw.startsWith("-")) throw new Error(`repo url begins with "-", which git reads as an option: "${raw}"`);
  const resolved = resolveRemote(raw) ?? resolveLocal(raw);
  return { ...resolved, key: keyOf(resolved.identity) };
}

/** The cache key alone — `repoIdentity(url).key`. */
export function repoKey(url: string): string {
  return repoIdentity(url).key;
}

function resolveRemote(raw: string): Omit<RepoIdentity, "key"> | undefined {
  if (!raw.includes("://")) {
    const scp = SCP_STYLE.exec(raw);
    if (!scp) return undefined;
    const [, host, path] = scp as unknown as [string, string, string];
    return { scheme: "ssh", identity: remoteIdentity(host.toLowerCase(), path) };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`repo url is not parseable: "${raw}"`);
  }
  const spelled = parsed.protocol.slice(0, -1);
  if (spelled === "file") return undefined;
  const scheme = SCHEME[spelled];
  if (scheme === undefined)
    throw new Error(
      `repo url "${raw}" has an unsupported scheme "${spelled}" — use https, http, ssh, git, or a local path`,
    );
  if (parsed.hostname === "") throw new Error(`repo url "${raw}" has no host`);
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port !== "" && parsed.port !== DEFAULT_PORT[scheme] ? `:${parsed.port}` : "";
  return { scheme, identity: remoteIdentity(host + port, parsed.pathname) };
}

function resolveLocal(raw: string): Omit<RepoIdentity, "key"> {
  const path = raw.startsWith("file://") ? new URL(raw).pathname : raw;
  if (!path.startsWith("/")) throw new Error(`repo url must be absolute or remote: "${raw}"`);
  const identity = "/" + normalizePath(path);
  return { scheme: "local", identity };
}

function remoteIdentity(host: string, path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "") throw new Error(`repo url has no path: "${host}" alone names no repository`);
  return `${host}/${normalized}`;
}

/** Leading `/` off, `//` collapsed, `.` and `..` segments resolved (as `new URL()` resolves them,
 * so the hand-parsed scp form lands where the URL forms do), trailing `/` off, ONE trailing
 * `.git` off; case kept. The `.git` comes off the LAST SEGMENT — as a suffix (`repo.git`) or as the
 * whole segment (`repo/.git`, the git dir git itself clones from) — so no `/` survives it. */
function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const last = segments.pop();
  if (last !== undefined && last !== ".git") segments.push(last.replace(/\.git$/, ""));
  return segments.join("/");
}

function keyOf(identity: string): string {
  const last =
    identity
      .split("/")
      .filter((s) => s !== "")
      .pop() ?? "";
  const slug =
    last
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "repo";
  return `${slug}-${createHash("sha256").update(identity).digest("hex").slice(0, 8)}`;
}
