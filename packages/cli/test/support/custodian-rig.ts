// The Custodian suite's rig (ADR-0059, ADR-0084): the REAL engine — the pinned Envoy image, run by
// docker with the bootstrap of a Custodian pod and the LDS and CDS of its slots, all as
// `custodian-rules.ts` renders them — against local upstreams. The files are laid out as the
// Custodian pod mounts them: `/etc/jr2` (the bootstrap, the program, `upstream.crt`) and the state
// folder (each slot's Lua table, values, Stand-ins and leaves; the LDS and CDS files; the dial token).
//
// What is faked, and how:
//
// - The uplink. In a Custodian pod, the uplink sends each connection of slot i to the slot's listener,
//   whatever address the Harness pod dialed, and Envoy reads that address back (`original_dst`). Here
//   the container runs on the host network, and a client dials the listener itself. Envoy then reads
//   the address that the client dialed, which is the address the chains see. So the rig gives each
//   address that a slot's chains name (a placeholder, an address entry) its own loopback address
//   (`127.18.x.y` for `198.18.x.y`; `127.77.0.n` for the others), and each port of the slot its own
//   free port of the host: the slot's listener binds each of them (`additional_addresses`). The
//   rig rewrites only the chains' match (address and port) and the address that a port-80 route
//   compares the dialed address with. The listener filters stay as rendered: no connection carries
//   any header or preamble that the production listener does not read.
// - The pod's DNS. Names resolve through the container's `/etc/hosts`, which the rig writes; its
//   `resolv.conf` names 127.0.0.1, where nothing answers, so no lookup leaves the host.
// - The Orchestrator (a plain HTTP server on the LAN address), the targets (HTTPS servers on the LAN
//   address, each with a certificate from its own CA), and the Harness pods behind the Fence
//   (inbound targets that the rig adds to the dial's table, on `127.0.0.1`).
// - The host's ports. The health, inbound and admin listeners move to free ports of the host.
//
// Opt-in (`pnpm --filter @jr2/cli test:custodian`, or `just custodian-test`): it needs docker and
// the image, which the default gate does not.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import * as net from "node:net";
import { createServer as createNetServer, type AddressInfo, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  CA_MOUNT,
  CONTROL_TOKEN_NAME,
  CUSTODIAN_CDS,
  CUSTODIAN_DIAL_TOKEN,
  CUSTODIAN_LDS,
  CUSTODIAN_POD_ARGS,
  CUSTODIAN_POD_BOOTSTRAP,
  CUSTODIAN_POD_PROGRAM,
  CUSTODIAN_PROGRAM,
  CUSTODIAN_STATE,
  custodianPodBootstrap,
  custodianRef,
  custodianXds,
  emptyPlaceholders,
  fenceRangesOf,
  JR2_CUSTODIAN_NAME,
  jr2NameAddress,
  leafStem,
  placeholderOf,
  renderSlot,
  SANDBOX_TOKEN_NAME,
  slotFolder,
  standInValueFile,
  withPlaceholders,
  type ConnectionBounds,
  type HeldManifest,
  type NameCacheBounds,
  type PlaceholderTable,
  type SlotOwner,
  type SlotRules,
} from "@jr2/orchestrator/internal";
import { issueCa, issueLeaf, trustBundles, type Pem } from "@jr2/orchestrator/internal";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Instance's two Fence ranges: the defaults. */
export const RANGES = fenceRangesOf(undefined);

/** The host's first non-internal IPv4 address: where the targets listen, an address that the dial
 * guard lets the Custodian reach. */
export function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  throw new Error("no non-loopback IPv4 address on this host — the Custodian suite needs one");
}

// ---- targets ------------------------------------------------------------------------------------

/** One recorded request at a target. */
export type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; closedAt?: number };

export type Upstream = {
  host: string;
  port: number;
  /** The name its certificate is for (the LAN address when it has no name). */
  name: string;
  /** Its own CA, the "private CA" a `caBundle` would carry. */
  ca: Pem;
  seen: Seen[];
  /** What the next request is answered with; default 200 `ok`. */
  handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;
  close: () => Promise<void>;
};

/** An HTTPS target on the LAN address, with a certificate for `name` (and the LAN address) from its
 * own CA. `tls` narrows what its TLS accepts: `"1.0"` is a host that speaks TLS 1.0 alone, as the
 * TLS of LiteLLM itself does. */
export async function startUpstream(name?: string, tls?: "1.0"): Promise<Upstream> {
  const host = lanAddress();
  const ca = issueCa(`upstream-${name ?? "address"}`);
  const leaf = issueLeaf(ca, name ?? host);
  const seen: Seen[] = [];
  const upstream: Upstream = {
    host,
    port: 0,
    name: name ?? host,
    ca,
    seen,
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    },
    close: async () => {},
  };
  // OpenSSL 3 takes TLS 1.0 only at security level 0.
  const only10 =
    tls === "1.0" ? ({ minVersion: "TLSv1", maxVersion: "TLSv1", ciphers: "DEFAULT:@SECLEVEL=0" } as const) : {};
  const server = createServer({ cert: leaf.cert, key: leaf.key, ...only10 }, (req, res) => {
    const entry: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers };
    seen.push(entry);
    req.socket.once("close", () => (entry.closedAt = Date.now()));
    upstream.handler(req, res, entry);
    if (req.listenerCount("data") === 0) req.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  upstream.port = (server.address() as AddressInfo).port;
  upstream.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return upstream;
}

/** A plain HTTP target (the Orchestrator's Service, a Harness pod behind the Fence, a plain web
 * target), recording each request and its body. `host` is the LAN address unless given. */
export async function startHttpTarget(host = lanAddress()): Promise<{
  host: string;
  port: number;
  seen: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }>;
  /** What a request is answered with; default 200 JSON that names the path. */
  handler?: (req: IncomingMessage, res: ServerResponse) => void;
  /** The next `n` requests get their connection closed and no answer: a pooled connection the
   * target closed as the request arrived. */
  drop: (n: number) => void;
  close: () => Promise<void>;
}> {
  const seen: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }> = [];
  let dropping = 0;
  const target = {
    host,
    port: 0,
    seen,
    handler: undefined as ((req: IncomingMessage, res: ServerResponse) => void) | undefined,
    drop: (n: number) => {
      dropping = n;
    },
    close: async () => {},
  };
  const server = createHttpServer((req, res) => {
    if (dropping > 0) {
      dropping -= 1;
      req.socket.destroy();
      return;
    }
    if (target.handler) {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: "" });
      return target.handler(req, res);
    }
    let body = "";
    req.on("data", (b: Buffer) => (body += b.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  target.port = (server.address() as AddressInfo).port;
  target.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return target;
}

/** A plain TCP target on the LAN address: it echoes what it reads, after `banner` when it speaks
 * first (as an SSH server does). */
export async function startTcpTarget(banner?: string): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createNetServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => {});
    if (banner !== undefined) s.write(banner);
    s.on("data", (d: Buffer) => s.write(d));
  });
  await new Promise<void>((resolve) => server.listen(0, lanAddress(), resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// ---- the pod ------------------------------------------------------------------------------------

/** The dial token of the Instance (ADR-0084), as the Custodian pod's control process writes it. */
export const DIAL_TOKEN = "dial-token-value";
/** The CONTROL token (ADR-0076) of a slot: what the Custodian puts in place of its control Stand-in. */
export const controlTokenOf = (slot: number) => `agent:slot-${slot}.signed-control-value`;
/** The FETCH token of a Sandbox slot: valid on the fetch route alone. */
export const fetchTokenOf = (slot: number) => `sbx-${slot}.signed-fetch-value`;
/** A slot's secret control Stand-in, as the pod's maker would mint it. */
export const controlStandInOf = (slot: number) =>
  `control-standin-${createHash("sha256").update(`rig:${slot}`).digest("hex").slice(0, 32)}`;
/** A held secret's secret Stand-in in one slot (ADR-0059): the readable `jr2-held-<NAME>.` prefix and
 * a part no one can derive from the name. Each slot has its own. */
export function heldStandInOf(name: string, slot: number): string {
  return `jr2-held-${name}.${createHash("sha256").update(`rig:${slot}:${name}`).digest("base64url")}`;
}

/** One slot of the rig: its owner, its manifest, and the value of each held secret. */
export type RigSlot = {
  slot: number;
  owner: SlotOwner;
  manifest: HeldManifest;
  /** Each held value by name, written VERBATIM: a test that wants a trailing newline says so. */
  values: Record<string, string>;
  /** The slot's placeholder table; one is made from the manifest when not given. On an update, a
   * slot keeps its table and grows it (append-only). */
  placeholders?: PlaceholderTable;
};

/** A slot's files: its Lua table, the control token and its Stand-in, on a Sandbox the fetch
 * token, each held secret's Stand-in, each value, and a leaf for each Intercepted host. */
async function writeSlotFiles(
  put: (path: string, text: string) => Promise<void>,
  s: Pick<RigSlot, "slot" | "owner" | "manifest" | "values">,
  r: SlotRules,
  leafOf: (host: string) => Pem,
): Promise<void> {
  await put(r.lua.path, r.lua.text);
  const values = `${slotFolder(s.slot)}/values`;
  await put(`${values}/${CONTROL_TOKEN_NAME}`, controlTokenOf(s.slot));
  await put(`${values}/${standInValueFile(CONTROL_TOKEN_NAME)}`, controlStandInOf(s.slot));
  if ("sandbox" in s.owner) await put(`${values}/${SANDBOX_TOKEN_NAME}`, fetchTokenOf(s.slot));
  for (const secret of s.manifest.secrets) {
    await put(`${values}/${standInValueFile(secret.name)}`, heldStandInOf(secret.name, s.slot));
  }
  for (const [name, value] of Object.entries(s.values)) await put(`${values}/${name}`, value);
  const intercepted = [
    { host: JR2_CUSTODIAN_NAME, port: 443 },
    ...s.manifest.egress.filter((e) => e.intercept && e.port !== 80),
  ];
  for (const { host, port } of intercepted) {
    const leaf = leafOf(host);
    await put(`${slotFolder(s.slot)}/tls/${leafStem(host, port)}.crt`, leaf.cert);
    await put(`${slotFolder(s.slot)}/tls/${leafStem(host, port)}.key`, leaf.key);
  }
}

/** Where a client dials to reach slot i as if it had dialed `address:port`. */
export type Dialed = { host: string; port: number };

export type CustodianPod = {
  /** A slot's listener, as if the slot dialed `address:port`. */
  dial: (slot: number, address: string, port: number) => Dialed;
  /** A slot's listener, as if the slot dialed the placeholder of `name` (from its resolver). */
  at: (slot: number, name: string, port: number) => Dialed;
  /** The placeholder table of a slot. */
  placeholders: (slot: number) => PlaceholderTable;
  /** `extra.crt` of a slot: what `NODE_EXTRA_CA_CERTS` names in its Harness container. */
  trust: (slot: number) => string;
  /** The ports of the pod's own listeners, moved to free ports of the host. */
  ports: { health: number; inbound: number; admin: number };
  output: () => string;
  /** Write each slot's files, then the LDS and CDS files, and wait until each slot whose rules
   * changed is live. Resolves the milliseconds from the LDS file's rename to the last slot live. */
  update: (slots: RigSlot[]) => Promise<number>;
  /** The state of a slot's listener in Envoy's admin: its version, and the error of a refused
   * update. */
  listener: (slot: number) => Promise<ListenerState>;
  stop: () => Promise<void>;
};

/** What Envoy's admin says of a slot's listener. Envoy keeps a listener's `version_info` when an
 * update changes only its filter chains (an update in place), so the rig tells which rules are
 * active by their `fingerprint`: the names of the chains and the Lua tables that they load. */
export type ListenerState = { fingerprint?: string; lastUpdated?: string; error?: string };

/** The rules' fingerprint of a listener (as rendered, or as Envoy's admin shows it). */
export function fingerprint(listener: unknown): string {
  const chains = ((listener as { filter_chains?: Array<{ name?: string }> }).filter_chains ?? []).map(
    (c) => c.name ?? "",
  );
  const tables = [...new Set([...JSON.stringify(listener).matchAll(/held-[0-9a-f]{16}\.lua/g)].map((m) => m[0]))];
  return createHash("sha256")
    .update(JSON.stringify([chains.sort(), tables.sort()]))
    .digest("hex")
    .slice(0, 16);
}

async function listenerState(get: (path: string) => Promise<string>, slot: number): Promise<ListenerState> {
  const text = await get(`/config_dump?resource=dynamic_listeners&name_regex=^slot-${slot}$`).catch(() => "");
  if (!text.startsWith("{")) return {};
  const entry = (
    JSON.parse(text) as {
      configs?: Array<{
        active_state?: { listener?: unknown; last_updated?: string };
        warming_state?: unknown;
        error_state?: { details?: string };
      }>;
    }
  ).configs?.[0];
  if (!entry) return {};
  return {
    ...(entry.active_state?.listener && !entry.warming_state
      ? { fingerprint: fingerprint(entry.active_state.listener), lastUpdated: entry.active_state.last_updated! }
      : {}),
    ...(entry.error_state?.details ? { error: entry.error_state.details } : {}),
  };
}

/** Write a file of the watched folder whole: a temp name, then a rename (Envoy reads on a move). */
async function moveInto(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.next`, text, { mode: 0o644 });
  await rename(`${path}.next`, path);
}

/** Wait until Envoy has taken the CDS file of `version`. */
async function clustersAt(get: (path: string) => Promise<string>, version: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (
    !(await get("/stats?filter=^cluster_manager\\.cds\\.version_text$").catch(() => "")).includes(`"${version}"`)
  ) {
    if (Date.now() > deadline) throw new Error(`Envoy never took the clusters of ${version}`);
    await sleep(5);
  }
}

/** Free ports of the host, all held until each is chosen, so that no two are the same. */
async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<Server>((resolve, reject) => {
          const s = createNetServer();
          s.once("error", reject);
          s.listen(0, "0.0.0.0", () => resolve(s));
        }),
    ),
  );
  const ports = servers.map((s) => (s.address() as AddressInfo).port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

type Listener = {
  name: string;
  address: { socket_address: { address: string; port_value: number } };
  additional_addresses?: Array<{ address: { socket_address: { address: string; port_value: number } } }>;
  filter_chains: Array<Record<string, any>>;
};

/** Each port that a slot's chains name. */
function portsOf(listener: Listener): number[] {
  const ports = new Set<number>([443, 80]);
  for (const c of listener.filter_chains) {
    const p = c.filter_chain_match?.destination_port;
    if (typeof p === "number") ports.add(p);
  }
  return [...ports];
}

/**
 * Start a Custodian pod on the host network with `slots`. `names` is the pod's DNS (`/etc/hosts`):
 * name → address. `inboundTargets` are the addresses (`127.0.0.1:<port>`) that the rig adds to the
 * dial's table of slot targets, as Harness pods behind the Fence. A listener's addresses cannot change
 * after it starts, so each slot binds each port that any slot names at the start, and a later update
 * uses those ports only.
 */
export async function startCustodianPod(opts: {
  slots: RigSlot[];
  upstreamCas: string[];
  orchestrator: { host: string; port: number };
  names?: Record<string, string>;
  inboundTargets?: string[];
  /** Slots that a later update adds: their ports are bound from the start. */
  extraSlots?: number[];
  connections?: ConnectionBounds;
  nameCache?: NameCacheBounds;
}): Promise<CustodianPod> {
  const root = await mkdtemp(join(tmpdir(), "jr2-custodian-pod-"));
  const local = (path: string): string =>
    path.startsWith(CUSTODIAN_STATE)
      ? join(root, "state", path.slice(CUSTODIAN_STATE.length))
      : join(root, "etc", path.slice("/etc/jr2".length));
  const put = async (path: string, text: string) => {
    await mkdir(dirname(local(path)), { recursive: true });
    await writeFile(local(path), text, { mode: 0o644 });
  };

  // Each slot's own CA (ADR-0059: one CA for each Sandbox), and its placeholder table.
  const cas = new Map<number, Pem>();
  const tables = new Map<number, PlaceholderTable>();
  const caOf = (slot: number): Pem => {
    if (!cas.has(slot)) cas.set(slot, issueCa(`custodian-suite-slot-${slot}`));
    return cas.get(slot)!;
  };
  const tableOf = (s: RigSlot): PlaceholderTable => {
    const prev = tables.get(s.slot) ?? s.placeholders ?? emptyPlaceholders(RANGES.placeholders);
    const next = withPlaceholders(prev, s.manifest.egress);
    tables.set(s.slot, next);
    return next;
  };

  // The address of a chain's match → the loopback address that stands for it.
  const aliases = new Map<string, string>();
  const aliasOf = (address: string): string => {
    const known = aliases.get(address);
    if (known) return known;
    const [a, b, c, d] = address.split(".").map(Number) as [number, number, number, number];
    const alias = a === 198 && (b === 18 || b === 19) ? `127.${b}.${c}.${d}` : `127.77.0.${aliases.size + 1}`;
    aliases.set(address, alias);
    return alias;
  };

  // The ports of each slot: one free port of the host for each port that any slot names.
  const rendered = (s: RigSlot): SlotRules =>
    renderSlot({ slot: s.slot, owner: s.owner, manifest: s.manifest, placeholders: tableOf(s), ranges: RANGES });
  const first = opts.slots.map(rendered);
  const used = new Set<number>();
  for (const r of first) for (const p of portsOf(r.listener as Listener)) used.add(p);
  const slotPorts = new Map<number, Map<number, number>>();
  const portList = [...used].sort((x, y) => x - y);
  const slotNumbers = [...opts.slots.map((s) => s.slot), ...(opts.extraSlots ?? [])];
  const free = await freePorts(portList.length * slotNumbers.length + 3);
  for (const slot of slotNumbers) slotPorts.set(slot, new Map(portList.map((p) => [p, free.pop()!])));
  const [health, inbound, admin] = [free.pop()!, free.pop()!, free.pop()!];

  const mapped = (slot: number, port: number): number => {
    const m = slotPorts.get(slot)?.get(port);
    if (m === undefined) throw new Error(`the rig bound no port for ${port} of slot ${slot}`);
    return m;
  };

  /** The slot's listener with its match moved to the rig's addresses and ports. */
  const moved = (r: SlotRules): Listener => {
    // A JSON copy: the renderer shares one match object between chains, and each must move once.
    const listener = JSON.parse(JSON.stringify(r.listener)) as Listener;
    for (const c of listener.filter_chains) {
      const m = c.filter_chain_match;
      if (!m) continue;
      if (typeof m.destination_port === "number") m.destination_port = mapped(r.slot, m.destination_port);
      for (const p of m.prefix_ranges ?? []) p.address_prefix = aliasOf(p.address_prefix);
    }
    // A port-80 route compares the dialed address with the name's placeholder (`role=http`).
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v === null || typeof v !== "object") return;
      const o = v as Record<string, any>;
      const lua = o["envoy.filters.http.lua"];
      if (lua?.role === "http" && typeof lua.address === "string") {
        const [address, port] = lua.address.split(":");
        lua.address = `${aliasOf(address)}:${mapped(r.slot, Number(port))}`;
      }
      for (const x of Object.values(o)) walk(x);
    };
    walk(listener.filter_chains);
    const ports = [...slotPorts.get(r.slot)!.values()];
    listener.address = { socket_address: { address: "0.0.0.0", port_value: ports[0]! } };
    listener.additional_addresses = ports
      .slice(1)
      .map((port_value) => ({ address: { socket_address: { address: "0.0.0.0", port_value } } }));
    return listener;
  };

  const leaves = new Map<string, Pem>();
  const slotFiles = (s: RigSlot, r: SlotRules): Promise<void> =>
    writeSlotFiles(put, s, r, (host) => {
      const key = `${s.slot}|${host}`;
      if (!leaves.has(key)) leaves.set(key, issueLeaf(caOf(s.slot), host));
      return leaves.get(key)!;
    });

  // The pod's static files.
  await put(CUSTODIAN_POD_PROGRAM, CUSTODIAN_PROGRAM);
  await put(`${CA_MOUNT}/upstream.crt`, trustBundles("", opts.upstreamCas.join("")).upstream);
  await put(CUSTODIAN_DIAL_TOKEN, `${DIAL_TOKEN}\n`);
  const bootstrap = custodianPodBootstrap({
    orchestrator: opts.orchestrator,
    range: 0,
    ranges: RANGES,
    ...(opts.connections ? { connections: opts.connections } : {}),
    ...(opts.nameCache ? { nameCache: opts.nameCache } : {}),
  }) as {
    admin: { address: { socket_address: { port_value: number } } };
    static_resources: { listeners: Array<Record<string, any>> };
  };
  bootstrap.admin.address.socket_address.port_value = admin;
  for (const l of bootstrap.static_resources.listeners) {
    if (l.name === "health") l.address.socket_address.port_value = health;
    if (l.name === "inbound") {
      l.address.socket_address.port_value = inbound;
      const manager = l.filter_chains[0].filters.find(
        (f: { name: string }) => f.name === "envoy.filters.network.http_connection_manager",
      );
      const source = manager.typed_config.http_filters[0].typed_config.default_source_code;
      const added = (opts.inboundTargets ?? []).map((t) => `HELD.inbound.targets["${t}"] = true\n`).join("");
      source.inline_string = (source.inline_string as string).replace("dofile(", `${added}dofile(`);
    }
  }
  await put(CUSTODIAN_POD_BOOTSTRAP, JSON.stringify(bootstrap));
  const empty = JSON.stringify({ version_info: "0", resources: [] });
  await put(CUSTODIAN_LDS, empty);
  await put(CUSTODIAN_CDS, empty);
  const hosts = ["127.0.0.1 localhost", ...Object.entries(opts.names ?? {}).map(([n, a]) => `${a} ${n}`), ""];
  await writeFile(join(root, "hosts"), hosts.join("\n"), { mode: 0o644 });
  await writeFile(join(root, "resolv.conf"), "nameserver 127.0.0.1\noptions timeout:1 attempts:1\n", {
    mode: 0o644,
  });

  const name = `jr2-custodian-suite-${process.pid}-${Date.now() % 100000}`;
  const gid = String(process.getgid?.() ?? 0);
  // prettier-ignore
  const args = [
    "run", "--rm", "--name", name, "--network", "host", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--user", `65532:${gid}`, "--group-add", gid,
    "-v", `${join(root, "etc")}:/etc/jr2:ro`, "-v", `${join(root, "state")}:${CUSTODIAN_STATE}:ro`,
    "-v", `${join(root, "hosts")}:/etc/hosts:ro`, "-v", `${join(root, "resolv.conf")}:/etc/resolv.conf:ro`,
    custodianRef(), ...CUSTODIAN_POD_ARGS,
  ];
  let output = "";
  const child: ChildProcess = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (b: Buffer) => (output += b.toString()));
  child.stderr?.on("data", (b: Buffer) => (output += b.toString()));
  const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
  const stop = async () => {
    await exec("docker", ["rm", "-f", name]).catch(() => {});
    await exited;
    await rm(root, { recursive: true, force: true });
  };

  const adminGet = async (path: string): Promise<string> => {
    const res = await fetch(`http://127.0.0.1:${admin}${path}`);
    return res.text();
  };
  const listener = (slot: number) => listenerState((path) => adminGet(path), slot);

  let version = 0;
  const last = new Map<number, string>();
  const update = async (slots: RigSlot[]): Promise<number> => {
    const all = slots.map((s) => ({ s, r: rendered(s) })).sort((x, y) => x.r.slot - y.r.slot);
    for (const { s, r } of all) await slotFiles(s, r);
    const changed = all.filter(({ r }) => last.get(r.slot) !== r.version).map(({ r }) => r);
    version += 1;
    const { lds, cds } = custodianXds(all.map(({ r }) => r));
    const ldsOut = {
      version_info: `v${version}`,
      resources: (lds.resources as Array<Record<string, unknown>>).map((l, i) => ({
        "@type": l["@type"],
        ...moved(all[i]!.r),
      })),
    };
    // The clusters first, by their own rename, and live before the listeners that name them: a
    // listener whose cluster Envoy does not know yet is refused (`unknown cluster`).
    await moveInto(local(CUSTODIAN_CDS), JSON.stringify({ ...cds, version_info: `v${version}` }));
    await clustersAt(adminGet, `v${version}`);
    const lds1 = local(CUSTODIAN_LDS);
    await writeFile(`${lds1}.next`, JSON.stringify(ldsOut), { mode: 0o644 });
    const started = performance.now();
    await rename(`${lds1}.next`, lds1);
    const deadline = Date.now() + 30_000;
    for (const r of changed) {
      const want = fingerprint(r.listener);
      for (;;) {
        const state = await listener(r.slot);
        if (state.fingerprint === want) break;
        if (state.error && !state.fingerprint) throw new Error(`slot ${r.slot} was refused:\n${state.error}`);
        if (Date.now() > deadline || child.exitCode !== null) {
          throw new Error(`slot ${r.slot} never went live:\n${JSON.stringify(state)}\n${output}`);
        }
        await sleep(5);
      }
    }
    const ms = performance.now() - started;
    for (const { r } of all) last.set(r.slot, r.version);
    return ms;
  };

  const deadline = Date.now() + 20_000;
  for (;;) {
    const ready = await fetch(`http://127.0.0.1:${health}/healthz`).then(
      (r) => r.status === 200,
      () => false,
    );
    if (ready) break;
    if (Date.now() > deadline || child.exitCode !== null) {
      await stop();
      throw new Error(`the Custodian never served:\n${output}`);
    }
    await sleep(100);
  }
  try {
    await update(opts.slots);
  } catch (e) {
    await stop();
    throw e;
  }

  return {
    dial: (slot, address, port) => ({ host: aliasOf(address), port: mapped(slot, port) }),
    at: (slot, n, port) => {
      const table = tables.get(slot)!;
      const address = n === JR2_CUSTODIAN_NAME ? jr2NameAddress(table.range) : placeholderOf(table, n);
      if (address === undefined) throw new Error(`slot ${slot} has no placeholder for ${n}`);
      return { host: aliasOf(address), port: mapped(slot, port) };
    },
    placeholders: (slot) => tables.get(slot)!,
    trust: (slot) => trustBundles(caOf(slot).cert).extra,
    ports: { health, inbound, admin },
    output: () => output,
    update,
    listener,
    stop,
  };
}

// ---- one update at full size ---------------------------------------------------------------------

/**
 * The time of one update of a full Custodian pod (risk 4 of the plan, ADR-0084): Envoy runs the
 * rendered bootstrap and the rendered LDS and CDS of `slots`, each listener as rendered, in its own
 * network namespace on a docker network. Then, `rounds` times, one slot gets one more rule, the
 * whole LDS file is written again and renamed into place, and the time runs until Envoy's admin
 * says that the slot's listener is active at the new version. The admin listener moves from the
 * pod's loopback to the container's address, so that the host can read it; nothing else moves.
 */
export async function timeUpdates(
  slots: Array<Pick<RigSlot, "slot" | "owner" | "manifest">>,
  rounds: number,
  grow: (manifest: HeldManifest, round: number) => HeldManifest,
): Promise<{ ms: number[]; ldsBytes: number; allocated?: number }> {
  const root = await mkdtemp(join(tmpdir(), "jr2-custodian-time-"));
  const local = (path: string): string =>
    path.startsWith(CUSTODIAN_STATE)
      ? join(root, "state", path.slice(CUSTODIAN_STATE.length))
      : join(root, "etc", path.slice("/etc/jr2".length));
  const put = async (path: string, text: string) => {
    await mkdir(dirname(local(path)), { recursive: true });
    await writeFile(local(path), text, { mode: 0o644 });
  };
  const ca = issueCa("custodian-suite-time");
  const leaves = new Map<string, Pem>();
  const leafOf = (host: string) => {
    if (!leaves.has(host)) leaves.set(host, issueLeaf(ca, host));
    return leaves.get(host)!;
  };
  const tables = new Map<number, PlaceholderTable>();
  const render = (s: Pick<RigSlot, "slot" | "owner" | "manifest">): SlotRules => {
    const table = withPlaceholders(tables.get(s.slot) ?? emptyPlaceholders(RANGES.placeholders), s.manifest.egress);
    tables.set(s.slot, table);
    return renderSlot({ slot: s.slot, owner: s.owner, manifest: s.manifest, placeholders: table, ranges: RANGES });
  };
  const valuesOf = (m: HeldManifest) => Object.fromEntries(m.secrets.map((x) => [x.name, `value-of-${x.name}`]));

  await put(CUSTODIAN_POD_PROGRAM, CUSTODIAN_PROGRAM);
  await put(`${CA_MOUNT}/upstream.crt`, trustBundles(ca.cert).upstream);
  await put(CUSTODIAN_DIAL_TOKEN, `${DIAL_TOKEN}\n`);
  const bootstrap = custodianPodBootstrap({
    orchestrator: { host: "orchestrator.invalid", port: 4000 },
    range: 0,
    ranges: RANGES,
  }) as { admin: { address: { socket_address: { address: string } } } };
  bootstrap.admin.address.socket_address.address = "0.0.0.0";
  await put(CUSTODIAN_POD_BOOTSTRAP, JSON.stringify(bootstrap));
  const current = slots.map((s) => ({ ...s }));
  let rendered = current.map(render);
  for (const [i, s] of current.entries())
    await writeSlotFiles(put, { ...s, values: valuesOf(s.manifest) }, rendered[i]!, leafOf);
  let adminGet: ((path: string) => Promise<string>) | undefined;
  const write = async (version: string): Promise<{ bytes: number; at: number }> => {
    const { lds, cds } = custodianXds(rendered);
    await moveInto(local(CUSTODIAN_CDS), JSON.stringify({ ...cds, version_info: version }));
    if (adminGet) await clustersAt(adminGet, version);
    const text = JSON.stringify({ ...lds, version_info: version });
    const path = local(CUSTODIAN_LDS);
    await writeFile(`${path}.next`, text, { mode: 0o644 });
    const at = performance.now();
    await rename(`${path}.next`, path);
    return { bytes: text.length, at };
  };
  const first = await write("v0");
  await writeFile(join(root, "resolv.conf"), "nameserver 127.0.0.1\n", { mode: 0o644 });

  const name = `jr2-custodian-time-${process.pid}-${Date.now() % 100000}`;
  const gid = String(process.getgid?.() ?? 0);
  // prettier-ignore
  await exec("docker", [
    "run", "-d", "--name", name, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", `65532:${gid}`, "--group-add", gid,
    "-v", `${join(root, "etc")}:/etc/jr2:ro`, "-v", `${join(root, "state")}:${CUSTODIAN_STATE}:ro`,
    "-v", `${join(root, "resolv.conf")}:/etc/resolv.conf:ro`,
    custodianRef(), ...CUSTODIAN_POD_ARGS,
  ]);
  try {
    const ip = (
      await exec("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name])
    ).stdout.trim();
    adminGet = (path: string) => fetch(`http://${ip}:15000${path}`).then((r) => r.text());
    const admin = adminGet;
    const until = async (slot: number, rules: SlotRules): Promise<number> => {
      const want = fingerprint(rules.listener);
      const deadline = Date.now() + 120_000;
      for (;;) {
        if ((await listenerState(admin, slot)).fingerprint === want) return performance.now();
        if (Date.now() > deadline) {
          const logs = await exec("docker", ["logs", name]).then(
            (r) =>
              (r.stdout + r.stderr)
                .split("\n")
                .filter((l) => !l.includes("work-in-progress"))
                .slice(-40)
                .join("\n"),
            () => "",
          );
          const dump = await fetch(
            `http://${ip}:15000/config_dump?resource=dynamic_listeners&name_regex=^slot-${slot}$`,
          )
            .then(
              (r) => r.text(),
              () => "",
            )
            .then((t) => t.replace(/"filter_chains"[\s\S]*$/, "…").slice(0, 3000));
          throw new Error(`slot ${slot} never went live:\n${dump}\n${logs}`);
        }
        await sleep(2);
      }
    };
    for (const [i, s] of current.entries()) await until(s.slot, rendered[i]!);
    const ms: number[] = [];
    for (let round = 1; round <= rounds; round++) {
      const i = (round * 37) % current.length;
      current[i] = { ...current[i]!, manifest: grow(current[i]!.manifest, round) };
      rendered = current.map(render);
      await writeSlotFiles(put, { ...current[i]!, values: valuesOf(current[i]!.manifest) }, rendered[i]!, leafOf);
      const { at } = await write(`v${round}`);
      ms.push((await until(current[i]!.slot, rendered[i]!)) - at);
    }
    const allocated = await fetch(`http://${ip}:15000/memory`).then(
      async (r) => Number(((await r.json()) as { allocated?: string }).allocated),
      () => undefined,
    );
    return { ms, ldsBytes: first.bytes, ...(allocated ? { allocated } : {}) };
  } finally {
    await exec("docker", ["rm", "-f", name]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

// ---- clients ------------------------------------------------------------------------------------

/** What one request through the Custodian came back with. */
export type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/**
 * One HTTPS request to `name` at `at` (where the slot dialed), as a client that trusts `ca` (the
 * Harness's `extra.crt`) would make it: the TLS name is `name`, and the `Host` is `authority`
 * (`name`, or `name:port` when given). `onResponse` sees the live response, for the streaming cases.
 */
export function httpsVia(
  at: Dialed,
  name: string,
  opts: {
    authority?: string;
    method?: string;
    path?: string;
    headers?: Record<string, string | string[]>;
    body?: string;
    ca: string;
    servername?: string | false;
    onResponse?: (res: IncomingMessage, req: ClientRequest) => void;
  },
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: at.host,
        port: at.port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers: { host: opts.authority ?? name, ...opts.headers },
        createConnection: () =>
          tlsConnect({
            host: at.host,
            port: at.port,
            ca: opts.ca,
            checkServerIdentity: (_h, cert) =>
              cert.subjectaltname?.includes(name) ? undefined : new Error(`no SAN for ${name}`),
            ...(opts.servername === false ? {} : { servername: opts.servername ?? name }),
            ALPNProtocols: ["http/1.1"],
          }),
      },
      (res) => {
        if (opts.onResponse) opts.onResponse(res, req);
        let body = "";
        const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        res.on("data", (b: Buffer) => (body += b.toString()));
        res.on("end", done);
        res.on("error", done);
        res.on("aborted", done);
      },
    );
    req.once("error", reject);
    req.end(opts.body);
  });
}

/** One plain HTTP request to `at`, with the `Host` given. */
export function httpVia(
  at: Dialed,
  authority: string,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: at.host,
        port: at.port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        agent: false,
        headers: { host: authority, ...opts.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (b: Buffer) => (body += b.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        res.on("error", reject);
      },
    );
    req.once("error", reject);
    req.end(opts.body);
  });
}

/** Raw bytes to `at`: what came back before the connection closed, or before `ms` passed. */
export function rawVia(at: Dialed, bytes: string | undefined, ms = 3_000): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const s = net.connect(at.port, at.host);
    s.on("error", () => {});
    s.on("data", (d: Buffer) => chunks.push(d));
    const timer = setTimeout(() => s.destroy(), ms);
    s.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    if (bytes !== undefined) s.write(bytes);
  });
}

/** The first bytes that a TLS client with `servername` (none when undefined) gets back: a TLS alert
 * (0x15), a server hello (0x16), or nothing. */
export async function helloReply(at: Dialed, servername?: string): Promise<Buffer> {
  const { duplexPair } = await import("node:stream");
  const [inner, outer] = duplexPair();
  const s = net.connect(at.port, at.host);
  const chunks: Buffer[] = [];
  outer.on("data", (d: Buffer) => s.write(d));
  s.on("data", (d: Buffer) => chunks.push(d));
  s.on("error", () => {});
  const client = tlsConnect({ socket: inner, host: "127.0.0.1", servername, rejectUnauthorized: false });
  client.on("error", () => {});
  await new Promise<void>((resolve) => {
    s.on("close", () => resolve());
    setTimeout(resolve, 3_000);
  });
  s.destroy();
  client.destroy();
  return Buffer.concat(chunks);
}
