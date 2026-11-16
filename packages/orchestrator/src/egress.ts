// The Egress list (ADR-0084): the names, and the exact addresses, that a Harness pod may reach
// through the Fence, each with its ports. All else is refused.
//
// This module is the pure half that `jr2 up` runs host-side, beside `heldSecretsOf`:
//
//   parseEgressList(...)   one list as the author wrote it (`egress` in `jr2.config.ts`, or a
//                          `workspace()`'s), into items, or the first refusal
//   egressWarnings(...)    the warning of each `"*"` and `*.` entry: each one is a channel out
//   missingEntry(...)      the refusal of a host that jr2 itself uses, has no secret, and no entry
//   egressRulesOf(...)     one pod's rules: its list, its bound hosts (Intercepted) and its SSH
//                          Repos' port 22 — what its manifest (`held-<pod>.json`) carries
//
// It also holds the two address ranges of the Fence: the segment, where each Harness pod has its
// address, and the placeholder range, from which the resolver gives each name an address in each
// Sandbox. An entry can name neither, because no host of the author's has such an address.

import { isIP } from "node:net";

/**
 * One entry of an Egress list. The Instance's `egress` in `jr2.config.ts` is the default list, and a
 * `workspace()` that states its own `egress` replaces it, whole. An entry is one of:
 *
 * - `"host"` or `"host:port"`: an exact DNS name. With no port, it permits ports 443 and 80.
 * - `"*.example.com"`: each name below `example.com`, for TLS and HTTP only.
 * - `"*"`: each name, for TLS and HTTP only.
 * - `"10.0.0.5:8000"`: an exact IPv4 address, for a host that has no name. The port is required.
 * - `{ host, port?, intercept: true }`: an exact name or address that the Custodian intercepts. It
 *   ends the TLS of that host, checks the `Host` header, and removes each credential header.
 *
 * A host that a Held secret of the pod is bound to needs no entry, and port 22 of each SSH Repo that
 * the Workspace binds is permitted with no entry. A host that jr2 uses from the pod with no secret
 * needs an entry: a model endpoint with no key, an MCP server with no `secret`, and the url of a
 * Sandbox Effector's `http` Effect with no secret. `jr2 up` refuses to converge without it:
 * `<pod> reaches <host> for <part>. No secret is bound to that host, and <list> has no entry for it — add egress: ["<entry>"]`.
 * The Instance Harness takes from the Instance's list only those hosts of its own Agents. `jr2 up`
 * gives a warning for `"*"` and for each `*.` entry, because each one is a channel out.
 *
 * The config load, `workspace()` and `jr2 up` refuse a bad entry:
 * `<at>[<i>] "<entry>" <problem> — an entry is "host", "host:port", "*.domain", "*", "a.b.c.d:port", or { host, port?, intercept: true }`.
 * The problem is one of: an IPv6 address, a range, an address with no port, an address that the
 * Custodian never dials (loopback, link-local, `0.0.0.0`), an address in the Fence's own ranges
 * (`fence`, and 198.18.0.0/15), a URL, a loopback name, a name in `jr2.internal`, or `intercept` on
 * a wildcard.
 */
export type EgressEntry = string | EgressHost;

/** The object form of an {@link EgressEntry}: an exact name or IPv4 address, with no port in `host`. */
export type EgressHost = {
  /** An exact DNS name or an IPv4 address. No port, no `*`. */
  host: string;
  /** The one port it permits. Default: 443 and 80 for a name; required for an address. */
  port?: number;
  /** `true`: the host is an Intercepted host. Default: `false`, a Tunneled host. */
  intercept?: boolean;
};

/** How an item matches a name: an exact name, each name below a domain (`*.`), each name (`*`), or
 * an exact IPv4 address. */
export type EgressMatch = "name" | "below" | "any" | "address";

/** One entry, parsed: its config path, its host (lowercase, no trailing dot; the domain for
 * `below`, `*` for `any`), its ports, and whether it is intercepted. */
export type EgressItem = { at: string; host: string; match: EgressMatch; ports: number[]; intercept: boolean };

/** Why a pod has a rule: an entry of its list, a Held secret of its Harness (`held`), a secret of
 * its Sandbox Effector (`effector`), or an SSH Repo that its Workspace binds (`repo`). */
export type EgressSource = "entry" | "held" | "effector" | "repo";

/**
 * One rule of a pod's derived Egress list: one host and one port. `intercept` makes it an
 * Intercepted host; otherwise it is a Tunneled host. `tlsHttpOnly` marks a `below` or `any` rule:
 * one placeholder address serves each name of it, so only a protocol that names its host in its
 * first bytes (a TLS name, an HTTP `Host`) can be carried. Values never appear here.
 */
export type EgressRule = {
  host: string;
  port: number;
  match: EgressMatch;
  intercept: boolean;
  tlsHttpOnly?: true;
  from: EgressSource[];
};

/** A host and a port. */
export type HostPort = { host: string; port: number };

/** The ports an entry with no port permits: TLS, then HTTP. */
export const DEFAULT_EGRESS_PORTS: readonly number[] = [443, 80];

/** The domain of jr2's own names: the resolver answers `custodian.jr2.internal` in each Harness
 * pod with jr2's control routes (ADR-0084). No entry can name it. */
export const JR2_NAME_DOMAIN = "jr2.internal";

/**
 * The addresses a tunnel never reaches (ADR-0059's dial guard): loopback, unspecified, link-local
 * (the cloud metadata address among it, and AWS's IPv6 one), and the IPv4-mapped spelling of each.
 * The script refuses a target that SPELLS one; this list refuses a name that RESOLVES to one.
 */
export const GUARDED_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["127.0.0.0", 8],
  ["0.0.0.0", 8],
  ["169.254.0.0", 16],
  ["::1", 128],
  ["::", 128],
  ["fe80::", 10],
  ["fd00:ec2::254", 128],
  ["::ffff:127.0.0.0", 104],
  ["::ffff:0.0.0.0", 104],
  ["::ffff:169.254.0.0", 112],
];

/** The default segment of the Fence: each Harness pod's address is in it. */
export const FENCE_SEGMENT = "198.19.0.0/20";
/** The default placeholder range: the resolver gives each name a placeholder address from it. */
export const FENCE_PLACEHOLDERS = "198.18.0.0/16";
/** The range that holds both defaults (RFC 2544's benchmark range). No entry can name an address in
 * it, whatever the Instance's `fence` says. */
const FENCE_DEFAULT_RANGE = "198.18.0.0/15";

/** The two ranges of the Fence (`fence` in `jr2.config.ts`): `segment` and `placeholders`, each an
 * IPv4 prefix `a.b.c.d/n`. */
export type FenceRanges = { segment: string; placeholders: string };

/** The ranges an Instance uses: its `fence`, else the defaults. `checkFence` has checked them. */
export function fenceRangesOf(fence: Partial<FenceRanges> | undefined): FenceRanges {
  return { segment: fence?.segment ?? FENCE_SEGMENT, placeholders: fence?.placeholders ?? FENCE_PLACEHOLDERS };
}

/**
 * `fence`'s SHAPE (the config load): an object with `segment?` and `placeholders?`, each an IPv4
 * prefix with no host bits, at least as large as its default, not inside a guarded range, and the
 * two do not overlap.
 */
export function checkFence(fence: unknown, where: string): void {
  const hint = `fence is { segment?, placeholders? }, each an IPv4 prefix such as "${FENCE_SEGMENT}" (ADR-0084)`;
  if (typeof fence !== "object" || fence === null || Array.isArray(fence)) {
    throw new Error(`${where} at fence: expected an object — ${hint}`);
  }
  for (const key of Object.keys(fence)) {
    if (key !== "segment" && key !== "placeholders") throw new Error(`${where} at fence.${key}: not a field — ${hint}`);
  }
  const given = fence as Partial<Record<keyof FenceRanges, unknown>>;
  const defaults: FenceRanges = { segment: FENCE_SEGMENT, placeholders: FENCE_PLACEHOLDERS };
  const parsed: Partial<Record<keyof FenceRanges, Cidr>> = {};
  for (const key of ["segment", "placeholders"] as const) {
    const raw = given[key];
    if (raw === undefined) continue;
    const cidr = typeof raw === "string" ? cidrOf(raw) : undefined;
    if (cidr === undefined) {
      throw new Error(`${where} at fence.${key}: ${JSON.stringify(raw)} is not an IPv4 prefix a.b.c.d/n — ${hint}`);
    }
    if ((cidr.base & ~maskOf(cidr.prefix)) >>> 0 !== 0) {
      throw new Error(
        `${where} at fence.${key}: "${raw}" has host bits set — write the network address, such as ` +
          `"${intText(cidr.base & maskOf(cidr.prefix))}/${cidr.prefix}" (ADR-0084)`,
      );
    }
    const least = cidrOf(defaults[key])!.prefix;
    if (cidr.prefix > least) {
      throw new Error(
        `${where} at fence.${key}: "${raw}" is smaller than /${least}, the size of the default ` +
          `"${defaults[key]}" (ADR-0084)`,
      );
    }
    const guarded = guardedIpv4().find((g) => overlaps(g, cidr));
    if (guarded !== undefined) {
      throw new Error(
        `${where} at fence.${key}: "${raw}" overlaps ${intText(guarded.base)}/${guarded.prefix}, which the ` +
          "Custodian never dials (ADR-0059, ADR-0084)",
      );
    }
    parsed[key] = cidr;
  }
  const segment = parsed.segment ?? cidrOf(defaults.segment)!;
  const placeholders = parsed.placeholders ?? cidrOf(defaults.placeholders)!;
  if (overlaps(segment, placeholders)) {
    throw new Error(
      `${where} at fence: the segment ${intText(segment.base)}/${segment.prefix} and the placeholders ` +
        `${intText(placeholders.base)}/${placeholders.prefix} overlap — a pod's address and a placeholder ` +
        "address must never be one address (ADR-0084)",
    );
  }
}

const ENTRY_FORMS =
  'an entry is "host", "host:port", "*.domain", "*", "a.b.c.d:port", or { host, port?, intercept: true } (ADR-0084)';

/**
 * Parse one Egress list, or throw the first refusal. `at` is the list's config path (`egress`,
 * `workspace(): egress`); each message names the entry by `<at>[<i>]` and says what to write. An
 * address in the Fence's own ranges (`ranges`, and 198.18.0.0/15 always), in a range that the
 * Custodian never dials, or `0.0.0.0` is refused, and so is any IPv6 address: the Fence carries
 * IPv4 alone.
 */
export function parseEgressList(
  at: string,
  list: unknown,
  ranges: FenceRanges = fenceRangesOf(undefined),
): EgressItem[] {
  if (!Array.isArray(list)) {
    throw new Error(`${at} must be a list — egress: ["api.github.com", "*.npmjs.org"]; ${ENTRY_FORMS}`);
  }
  return list.map((entry, i) => parseEntry(`${at}[${i}]`, entry, ranges));
}

function parseEntry(at: string, entry: unknown, ranges: FenceRanges): EgressItem {
  if (typeof entry === "string") {
    const refuse = (why: string): never => {
      throw new Error(`${at} "${entry}" ${why} — ${ENTRY_FORMS}`);
    };
    if (entry === "") refuse("is empty");
    if (/\s/.test(entry)) refuse("holds a space");
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry))
      refuse("is a URL; write its host, and its port when it is not 443 or 80");
    if (entry.startsWith("[") || isIP(entry) === 6) refuse("is an IPv6 address; the Fence carries IPv4 alone");
    if (/^[0-9.]+\/\d+$/.test(entry)) refuse("is a range; an entry is one address, with its port");
    if (/[/?#@]/.test(entry)) refuse("has a path, a query or userinfo");
    const colon = entry.lastIndexOf(":");
    const rawHost = colon < 0 ? entry : entry.slice(0, colon);
    if (rawHost.includes(":")) refuse("is not host:port");
    const port = colon < 0 ? undefined : portOf(refuse, entry.slice(colon + 1));
    return item(at, refuse, rawHost, port, false, ranges);
  }
  if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
    const shown = JSON.stringify(entry);
    const refuse = (why: string): never => {
      throw new Error(`${at} ${shown} ${why} — ${ENTRY_FORMS}`);
    };
    const keys = Object.keys(entry);
    const extra = keys.find((k) => k !== "host" && k !== "port" && k !== "intercept");
    if (extra !== undefined) refuse(`has the field ${extra}, which an entry does not have`);
    const { host, port, intercept } = entry as { host?: unknown; port?: unknown; intercept?: unknown };
    if (typeof host !== "string" || host === "") return refuse("needs a host, a string");
    if (intercept !== undefined && typeof intercept !== "boolean") refuse("has an intercept that is not true or false");
    if (isIP(host) === 6 || host.startsWith("[")) refuse("is an IPv6 address; the Fence carries IPv4 alone");
    if (host.includes(":") || /[/?#@\s]/.test(host))
      refuse("has a host that is not a name or an address; put the port in port");
    if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
      refuse("has a port outside 1–65535");
    }
    const parsed = item(at, refuse, host, port as number | undefined, intercept === true, ranges);
    if (parsed.intercept && parsed.match !== "name" && parsed.match !== "address") {
      refuse(
        "intercepts a wildcard; the Custodian intercepts an exact name or address, because its leaf names that host",
      );
    }
    return parsed;
  }
  throw new Error(`${at} ${JSON.stringify(entry)} is not an entry — ${ENTRY_FORMS}`);
}

function item(
  at: string,
  refuse: (why: string) => never,
  rawHost: string,
  port: number | undefined,
  intercept: boolean,
  ranges: FenceRanges,
): EgressItem {
  const host = rawHost.toLowerCase().replace(/\.$/, "");
  const ports = port === undefined ? [...DEFAULT_EGRESS_PORTS] : [port];
  if (host === "*") return { at, host, match: "any", ports, intercept };
  if (host.startsWith("*.")) {
    const domain = host.slice(2);
    if (!isDnsName(domain)) refuse("is not * and then a DNS name");
    if (ownName(domain)) refuse(`names ${JR2_NAME_DOMAIN}, the domain of jr2's own names`);
    return { at, host: domain, match: "below", ports, intercept };
  }
  if (host.includes("*")) refuse('holds a * that is not "*" alone or "*." at the start');
  if (isIP(host) === 4) {
    if (port === undefined) refuse("is an address with no port; an address entry names its one port: a.b.c.d:port");
    const why = refusedAddress(host, ranges);
    if (why !== undefined) refuse(why);
    return { at, host, match: "address", ports, intercept };
  }
  if (/^[0-9.]+$/.test(host)) refuse("is not an IPv4 address");
  if (!isDnsName(host)) refuse("is not a DNS name or an IPv4 address");
  if (host === "localhost" || host.endsWith(".localhost"))
    refuse("is a loopback name, which the Custodian never dials");
  if (ownName(host)) refuse(`names ${JR2_NAME_DOMAIN}, the domain of jr2's own names`);
  return { at, host, match: "name", ports, intercept };
}

/** Why an IPv4 entry is refused, or undefined: an address of the Fence, or one the Custodian never
 * dials. */
function refusedAddress(address: string, ranges: FenceRanges): string | undefined {
  const at = ipv4Int(address);
  if (at === 0) return "is the unspecified address";
  const guarded = guardedIpv4().find((g) => inCidr(g, at));
  if (guarded !== undefined) {
    return `is in ${intText(guarded.base)}/${guarded.prefix}, which the Custodian never dials (ADR-0059)`;
  }
  for (const [name, range] of [
    ["the Fence's segment", ranges.segment],
    ["the Fence's placeholder range", ranges.placeholders],
    ["the Fence's default ranges", FENCE_DEFAULT_RANGE],
  ] as const) {
    if (inCidr(cidrOf(range)!, at)) return `is in ${range}, ${name}; no host of yours has such an address`;
  }
  return undefined;
}

/**
 * The warning of each `"*"` and `*.` entry of one parsed list (ADR-0084): each one is a channel out.
 * `"*"` lets Workspace code send what it reads to any host that speaks TLS or HTTP. A `*.` entry
 * lets it send data in the labels of a name below the domain, which the domain's owner sees.
 */
export function egressWarnings(items: readonly EgressItem[]): string[] {
  const out: string[] = [];
  for (const i of items) {
    if (i.match === "any") {
      out.push(
        `${i.at} "*" permits each name, for TLS and HTTP: Workspace code can send what it reads to any such host. ` +
          "Name the hosts instead (ADR-0084)",
      );
    } else if (i.match === "below") {
      out.push(
        `${i.at} "*.${i.host}" permits each name below ${i.host}, for TLS and HTTP: the Custodian resolves each such ` +
          `name, so the owner of ${i.host} sees each label that Workspace code puts in one. Name the hosts instead (ADR-0084)`,
      );
    }
  }
  return out;
}

/** Whether `item` permits `host:port`. An address is permitted only by its own entry: a `*` or a
 * `*.` entry permits names alone. */
export function permits(item: EgressItem, host: string, port: number): boolean {
  if (!item.ports.includes(port)) return false;
  switch (item.match) {
    case "name":
    case "address":
      return item.host === host;
    case "below":
      return isIP(host) === 0 && host.endsWith(`.${item.host}`);
    case "any":
      return isIP(host) === 0;
  }
}

/** One host that jr2 itself uses from a pod and holds no secret for (ADR-0084): it needs an entry.
 * `what` says which part of the config names it, for the refusal. */
export type RequiredHost = HostPort & { what: string };

/**
 * The refusal of the first host of `required` that no item of `list` permits, or undefined. It names
 * the pod, the part of the config that uses the host, and the entry to add. `where` says which list
 * the entry goes in.
 */
export function missingEntry(
  label: string,
  required: readonly RequiredHost[],
  list: readonly EgressItem[],
  where: string,
): string | undefined {
  for (const r of required) {
    if (list.some((i) => permits(i, r.host, r.port))) continue;
    return (
      `${label} reaches ${hostText(r)} for ${r.what}. No secret is bound to that host, and ${where} has no ` +
      `entry for it — add egress: ["${entryText(r)}"]. All code in the pod can then reach it (ADR-0084)`
    );
  }
  return undefined;
}

/** The entry that permits `host:port`: the name alone for 443 and 80, else `host:port`. */
export function entryText({ host, port }: HostPort): string {
  return isIP(host) === 0 && DEFAULT_EGRESS_PORTS.includes(port) ? host : `${host}:${port}`;
}

/** `host` for 443, else `host:port`. */
export function hostText({ host, port }: HostPort): string {
  return port === 443 ? host : `${host}:${port}`;
}

/**
 * One pod's rules (ADR-0084), sorted by host and port: one per item and port of its list, each bound
 * host (a Held secret's, or its Sandbox Effector's) as an Intercepted host, which needs no entry,
 * and port 22 of each SSH Repo that its Workspace binds, as a Tunneled host. A bound host that the
 * list also names stays Intercepted, and its `from` names both.
 */
export function egressRulesOf(parts: {
  list: readonly EgressItem[];
  held: readonly HostPort[];
  effector: readonly HostPort[];
  repos: readonly HostPort[];
}): EgressRule[] {
  const rules = new Map<string, EgressRule>();
  const add = (host: string, port: number, match: EgressMatch, intercept: boolean, from: EgressSource): void => {
    const key = JSON.stringify([match, host, port]);
    const known = rules.get(key);
    if (known) {
      known.intercept ||= intercept;
      if (!known.from.includes(from)) known.from.push(from);
      return;
    }
    const wide = match === "below" || match === "any";
    rules.set(key, { host, port, match, intercept, ...(wide ? { tlsHttpOnly: true as const } : {}), from: [from] });
  };
  for (const i of parts.list) for (const port of i.ports) add(i.host, port, i.match, i.intercept, "entry");
  const exact = (host: string): EgressMatch => (isIP(host) === 0 ? "name" : "address");
  for (const h of parts.held) add(h.host, h.port, exact(h.host), true, "held");
  for (const h of parts.effector) add(h.host, h.port, exact(h.host), true, "effector");
  for (const h of parts.repos) add(h.host, h.port, exact(h.host), false, "repo");
  const order: Record<EgressMatch, number> = { name: 0, address: 1, below: 2, any: 3 };
  return [...rules.values()].sort(
    (a, b) => order[a.match] - order[b.match] || a.host.localeCompare(b.host) || a.port - b.port,
  );
}

/** One line for a human: each rule as `host:port`, Intercepted or Tunneled, grouped. */
export function egressText(rules: readonly EgressRule[]): string {
  if (rules.length === 0) return "nothing";
  const name = (r: EgressRule) => (r.match === "below" ? `*.${r.host}` : r.host);
  const group = (intercept: boolean) => {
    const byHost = new Map<string, number[]>();
    for (const r of rules.filter((x) => x.intercept === intercept)) {
      byHost.set(name(r), [...(byHost.get(name(r)) ?? []), r.port]);
    }
    return [...byHost].map(([h, ports]) => `${h}:${ports.join(",")}`);
  };
  const intercepted = group(true);
  const tunneled = group(false);
  return [
    ...(intercepted.length ? [`Intercepted ${intercepted.join(" ")}`] : []),
    ...(tunneled.length ? [`Tunneled ${tunneled.join(" ")}`] : []),
  ].join("; ");
}

/**
 * The host and port of an SSH Repo url — scp-style `git@host:path`, `ssh://` or `git+ssh://` — or
 * undefined for any other url. The port of `ssh://host:2222/…` is kept; else 22.
 */
export function sshHostOf(url: string): HostPort | undefined {
  const raw = url.trim();
  if (!raw.includes("://")) {
    const scp = /^(?:[^@/:]+@)?([^:/@]+):(?!\/\/)(.+)$/.exec(raw);
    return scp ? { host: scp[1]!.toLowerCase(), port: 22 } : undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "ssh:" && parsed.protocol !== "git+ssh:") return undefined;
  if (parsed.hostname === "") return undefined;
  return { host: parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""), port: parsed.port ? Number(parsed.port) : 22 };
}

/** The host and port of an `http://` or `https://` url (80 and 443 by default), or undefined. */
export function httpHostOf(url: string): HostPort | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") return undefined;
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return { host, port: parsed.port ? Number(parsed.port) : parsed.protocol === "http:" ? 80 : 443 };
}

// --- IPv4 arithmetic --------------------------------------------------------------------------

type Cidr = { base: number; prefix: number };

function isDnsName(host: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host) && host.length <= 253;
}

function ownName(host: string): boolean {
  return host === JR2_NAME_DOMAIN || host.endsWith(`.${JR2_NAME_DOMAIN}`);
}

function portOf(refuse: (why: string) => never, raw: string): number {
  if (!/^\d+$/.test(raw)) return refuse("has a port that is not a number");
  const port = Number(raw);
  if (port < 1 || port > 65535) refuse("has a port outside 1–65535");
  return port;
}

function ipv4Int(address: string): number {
  return address.split(".").reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
}

function intText(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
}

function maskOf(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function cidrOf(text: string): Cidr | undefined {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(text);
  if (!m || isIP(m[1]!) !== 4) return undefined;
  const prefix = Number(m[2]);
  if (prefix > 32) return undefined;
  return { base: ipv4Int(m[1]!), prefix };
}

function inCidr(c: Cidr, at: number): boolean {
  return (at & maskOf(c.prefix)) >>> 0 === (c.base & maskOf(c.prefix)) >>> 0;
}

function overlaps(a: Cidr, b: Cidr): boolean {
  const prefix = Math.min(a.prefix, b.prefix);
  return (a.base & maskOf(prefix)) >>> 0 === (b.base & maskOf(prefix)) >>> 0;
}

/** The IPv4 ranges of the dial guard (ADR-0059). */
function guardedIpv4(): Cidr[] {
  return GUARDED_RANGES.filter(([address]) => isIP(address) === 4).map(([address, prefix]) => ({
    base: ipv4Int(address),
    prefix,
  }));
}
