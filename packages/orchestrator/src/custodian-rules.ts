// The rules of the Custodian of an Instance (ADR-0059, ADR-0084): what its Envoy is told for each
// slot, and the bootstrap of its pod. Pure functions, no I/O: the control process (M5) writes what
// they return into its in-memory folder, and Envoy reads it from there.
//
//   renderSlot(...)            one slot's rules, from its inputs: its listener on `20000 + slot`,
//                              its own clusters, its Lua table and its resolver table
//   custodianXds(...)          the LDS and the CDS file of every slot of a Custodian pod
//   custodianPodBootstrap(...) the pod's static bootstrap: admin on loopback, health on 15021, the
//                              Orchestrator's dial on 18080, the three dial listeners, the shared
//                              clusters, and LDS and CDS from the two files
//
// How a connection is decided. The uplink sends each TCP connection of slot i to port 20000 + i,
// whatever address the Harness pod dialed, so the port names the slot and no chain reads a source
// address. Envoy reads the dialed address back (`original_dst`) and, from the first bytes, the TLS
// name (`tls_inspector`). The slot's chains match the dialed address and port: a placeholder address
// stands for one name of the Egress list in that slot, and an address entry is its own address. The
// TLS name or the `Host` header must agree with the name, else the connection is refused with a
// reason. Then the Custodian dials the NAME, never the address that the pod dialed:
//
//   Tunneled host   the bytes go to the internal `dial` listener as an HTTP CONNECT for
//                   `name:port`, where the dial guard judges each address that the name
//                   resolves to, and the dial connects only to one it kept; plain HTTP on port 80 goes
//                   to the `dial-http` listener, where the same guard is
//   Intercepted     TLS ended with the slot's leaf for that host, the program's checks and swap,
//                   then the `dial-tls` listener: the same dial guard, Envoy's own verified TLS
//   jr2's own name  the control routes and the fetch route, to the Orchestrator
//   an address      dialed as written: the author wrote it, and `jr2 up` checked it
//
// Each connection that no entry permits gets a TLS alert, an HTTP 403 or a line of text, and each
// refusal is logged with the slot, its Harness pod and the reason.

import { createHash } from "node:crypto";
import {
  CA_MOUNT,
  CONTROL_PATHS,
  CONTROL_ROUTES,
  controlRoute,
  CUSTODIAN_ADMIN_PORT,
  CUSTODIAN_CDS,
  CUSTODIAN_CONNECTIONS,
  CUSTODIAN_DIAL_IDLE,
  CUSTODIAN_DIAL_TOKEN,
  CUSTODIAN_INBOUND_PORT,
  CUSTODIAN_LDS,
  CUSTODIAN_NAME_CACHE,
  CUSTODIAN_NAME_TTL,
  CUSTODIAN_POD_PROGRAM,
  CUSTODIAN_XDS,
  DIAL_PORTS,
  DIAL_TARGET_HEADER,
  DIAL_TOKEN_HEADER,
  FENCE_SLOTS,
  FETCH_PATHS,
  JR2_CUSTODIAN_NAME,
  MAY_HAVE_SENT_FLAGS,
  NOT_SENT_FLAGS,
  ORCHESTRATOR_UNREACHABLE,
  SLOT_LISTENER_BASE,
  slotFolder,
  CERTIFICATE_FAILED,
  CLOSED_IN_HANDSHAKE,
  TLS_FAILED,
  unreachable,
  type OrchestratorAddress,
} from "./custodian.ts";
import { dialGuardRanges, JR2_NAME_DOMAIN, uncarried, type EgressRule, type FenceRanges } from "./egress.ts";
import {
  CONTROL_TOKEN_NAME,
  CREDENTIAL_HEADERS,
  leafStem,
  SANDBOX_TOKEN_NAME,
  standIn,
  type HeldBinding,
  type HeldManifest,
} from "./held-secrets.ts";
import { CUSTODIAN_HEALTH_PORT } from "./names.ts";
import {
  checkAppendOnly,
  jr2NameAddress,
  placeholderName,
  placeholderOf,
  type PlaceholderTable,
} from "./placeholders.ts";

type Json = Record<string, unknown>;

/** The Harness pod of a slot, as each log line names it: a Sandbox by its name, or another Harness
 * pod by a label (`instance`, a check pod's). */
export type SlotOwner = { sandbox: string } | { pod: string };

/** What one slot's rules are made from. */
export type SlotInputs = {
  /** 0 … 127 (`FENCE_SLOTS`): the port of its listener, and of its resolver. */
  slot: number;
  owner: SlotOwner;
  /** The pod's held manifest: its Held secrets, and its Egress list as `jr2 up` derived it. */
  manifest: HeldManifest;
  /** The pod's placeholder table (`placeholders.ts`): a row for each name of its Egress list. */
  placeholders: PlaceholderTable;
  /** The Instance's two Fence ranges. */
  ranges: FenceRanges;
  /** A mark that changes when a value or a leaf of the slot changes, so that the program reads the
   * values again (ADR-0059: a changed value is taken live). */
  valuesVersion?: string;
};

/** One name that a slot's resolver answers, with its placeholder address. */
export type ResolverName = { name: string; match: "name" | "below" | "any"; address: string };

/** What a slot's resolver answers (`custodian-resolver.ts`): jr2's own name first, then each name of
 * the Egress list. Each other name is refused. `version` is the version of the slot's rules, and
 * `owner` the Harness pod as each log line names it (`ownerText`). */
export type ResolverTable = { slot: number; version: string; owner: string; names: ResolverName[] };

/** One slot's rules. */
export type SlotRules = {
  slot: number;
  /** A hash of the slot's inputs: the same inputs give the same rules and the same version. */
  version: string;
  /** Envoy's listener for the slot, on port `20000 + slot`. */
  listener: Json;
  /** The clusters that only this slot's chains name: one for each address entry. The clusters of
   * names are the pod's own (`custodianPodBootstrap`), shared by each slot. */
  clusters: Json[];
  /** The slot's Lua table: the program's `HELD` for this slot. Its path changes with its text and
   * with `valuesVersion`, so a chain that names it changes only when it changes. */
  lua: { path: string; text: string };
  resolver: ResolverTable;
};

// ---- Envoy's vocabulary -------------------------------------------------------------------------

const HCM = "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager";
const TCP = "type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy";
const DIRECT = "type.googleapis.com/envoy.extensions.filters.network.direct_response.v3.Config";
const LUA = "envoy.filters.http.lua";
const HTTP1: Json = {
  "envoy.extensions.upstreams.http.v3.HttpProtocolOptions": {
    "@type": "type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions",
    explicit_http_config: { http_protocol_options: {} },
  },
};

/** A TLS alert record: fatal, `access_denied` (49). The answer to TLS that no entry permits. */
const TLS_ALERT = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x31]).toString("base64");

/** The DNS cache of every dial by name, and the dial guard's second half (ADR-0059). A lookup
 * drops each address of the answer that is in a guarded range or in the Fence's own ranges, before
 * any dial can use it: Envoy connects to each address of a name in turn, so each one is judged. A
 * name with no address left is refused. One cache, shared by each dial listener and its cluster.
 * Each name is resolved as written, with no search domain of the Custodian's pod: a search domain
 * would let a Service of the cluster answer for a public name. The cache's bounds are the pod's, not
 * a slot's: while it is full, a new name of each slot is refused (`NAME_CACHE_FULL`). */
function dialDns(ranges: FenceRanges, bounds: NameCacheBounds): Json {
  return {
    name: "dial",
    dns_lookup_family: "V4_PREFERRED",
    max_hosts: bounds.hosts,
    host_ttl: CUSTODIAN_NAME_TTL,
    dns_cache_circuit_breaker: { max_pending_requests: bounds.pending },
    typed_dns_resolver_config: {
      name: "envoy.network.dns_resolver.cares",
      typed_config: {
        "@type": "type.googleapis.com/envoy.extensions.network.dns_resolver.cares.v3.CaresDnsResolverConfig",
        dns_resolver_options: { no_default_search_domain: true },
      },
    },
    resolved_address_filter: {
      ranges: dialGuardRanges(ranges).map(([address_prefix, prefix_len]) => ({ address_prefix, prefix_len })),
    },
  };
}

/** The bounds of the pod's cache of names: the names it holds, and the lookups in flight. */
export type NameCacheBounds = { hosts: number; pending: number };

/** The connection bounds of the pod: Envoy's global limit for the slot listeners, and the inbound
 * listener's own bound (`CUSTODIAN_CONNECTIONS`). */
export type ConnectionBounds = { pod: number; dial: number };

/** What Envoy says when the cache of names holds its bound of names, or of lookups in flight. Envoy
 * sets no response flag for either. */
const NAME_CACHE_FULL =
  "response.code_details == 'dns_cache_overflow' || " +
  "response.code_details == 'dynamic_forward_proxy_pending_request_overflow'";

/** The refusal of a name while the cache of names is full (ADR-0084). */
function nameCacheReply(): Json {
  return {
    filter: {
      extension_filter: {
        name: "envoy.access_loggers.extension_filters.cel",
        typed_config: {
          "@type": "type.googleapis.com/envoy.extensions.access_loggers.filters.cel.v3.ExpressionFilter",
          expression: NAME_CACHE_FULL,
        },
      },
    },
    status_code: 503,
    body_format_override: {
      text_format_source: {
        inline_string:
          "jr2 custodian: refused: the Custodian's cache of names is full, so it cannot look up " +
          "%REQ(:AUTHORITY)% now (ADR-0084)\n",
      },
    },
  };
}

/** The headers that the Custodian adds to the CONNECT of a tunnel, toward its own dial listener, so
 * that the dial listener's log names the slot and its Harness pod (`sandbox=<name>` or
 * `pod=<name>`). They go no further. */
const SLOT_HEADER = "x-jr2-fence-slot";
const OWNER_HEADER = "x-jr2-fence-owner";

/** A name as an RE2 pattern: each dot is a dot. */
const literal = (name: string): string => name.replace(/\./g, "\\.");

/** The `:authority` of a dial that is refused whatever it resolves to, in any letter case: an
 * address (the slot chains dial an address entry directly, so each dial by name names a name), an
 * empty name, `-` (Envoy's text for a TLS name that the client did not send), and jr2's own domain. */
const REFUSED_AUTHORITY = `(?i)^(\\[.*|(-|[0-9.]*|(.*\\.)?${literal(JR2_NAME_DOMAIN)}\\.?)(:[0-9]+)?)$`;

/** What the `dial` listener refuses as the target of a CONNECT: `REFUSED_AUTHORITY`, and a name
 * that ends in a dot. A tunnel dials a name in one spelling only, so no other spelling of a name
 * that a wildcard refuses can pass it. */
const REFUSED_CONNECT = `(?i)^(\\[.*|(-|[0-9.]*|(.*\\.)?${literal(JR2_NAME_DOMAIN)}|.*\\.)(:[0-9]+)?)$`;

/** An `:authority` that is one of `names`, in any letter case, with or without a trailing dot and a
 * port. */
function namesRegex(names: readonly string[]): string {
  return `(?i)^(${names.map(literal).join("|")})\\.?(:[0-9]+)?$`;
}

/** An `:authority` whose name ends in a dot, with or without a port. */
const TRAILING_DOT_AUTHORITY = "^[^:]*\\.(:[0-9]*)?$";

/** An `:authority` that names `port`: what a wildcard on that port carries. The Custodian dials the
 * port of the `Host`, so each other port is refused. A `Host` with no port names port 80. */
function portAuthority(port: number): string {
  return port === 80 ? "^[^:]*(:80)?$" : `^[^:]*:${port}$`;
}

function ip32(address: string): Json[] {
  return [{ address_prefix: address, prefix_len: 32 }];
}

function meta(fields: Record<string, string>): Json {
  return { filter_metadata: { [LUA]: fields } };
}

function textRefusal(reason: string): Json {
  return {
    name: "envoy.filters.network.direct_response",
    typed_config: { "@type": DIRECT, response: { inline_string: `jr2 custodian: refused: ${reason} (ADR-0084)\n` } },
  };
}

const ALERT: Json = {
  name: "envoy.filters.network.direct_response",
  typed_config: { "@type": DIRECT, response: { inline_bytes: TLS_ALERT } },
};

function chain(name: string, match: Json, filters: Json[], tls?: Json): Json {
  return { name, filter_chain_match: match, ...(tls ? { transport_socket: tls } : {}), filters };
}

/** The stdout access log of the Custodian's HTTP chains, in the `jr2.custodian key=value` contract
 * (ADR-0059): only the requests that the program marked, names only — never a header value, a body,
 * a path or a query. */
function httpLog(who: string, target: string): Json[] {
  return [
    {
      name: "envoy.access_loggers.stdout",
      filter: {
        metadata_filter: {
          matcher: { filter: "jr2", path: [{ key: "log" }], value: { bool_match: true } },
          match_if_key_not_found: false,
        },
      },
      typed_config: {
        "@type": "type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog",
        log_format: {
          text_format_source: {
            inline_string:
              `jr2.custodian ${who} action=%DYNAMIC_METADATA(jr2:action)% target=${target} ` +
              "secret=%DYNAMIC_METADATA(jr2:secret)% reason=%DYNAMIC_METADATA(jr2:reason)% " +
              "method=%REQ(:METHOD)% status=%RESPONSE_CODE% flags=%RESPONSE_FLAGS%\n",
          },
        },
      },
    },
  ];
}

/** The dynamic forward filter of a dial listener: it resolves the name through the one DNS cache,
 * whose lookup drops each guarded address (`dialDns`). */
function dialFilter(ranges: FenceRanges, bounds: NameCacheBounds): Json {
  return {
    name: "envoy.filters.http.dynamic_forward_proxy",
    typed_config: {
      "@type": "type.googleapis.com/envoy.extensions.filters.http.dynamic_forward_proxy.v3.FilterConfig",
      dns_cache_config: dialDns(ranges, bounds),
    },
  };
}

/** What Envoy says when the dial guard dropped each address of a name (`dialDns`). */
const GUARDED = "response.code_details.contains('address_denied')";

/** The guard's refusal (ADR-0059): a name whose every address the guard dropped. */
function guardReply(): Json {
  return {
    filter: {
      extension_filter: {
        name: "envoy.access_loggers.extension_filters.cel",
        typed_config: {
          "@type": "type.googleapis.com/envoy.extensions.access_loggers.filters.cel.v3.ExpressionFilter",
          expression: GUARDED,
        },
      },
    },
    status_code: 403,
    body_format_override: {
      text_format_source: {
        inline_string: "jr2 custodian: %REQ(:AUTHORITY)% resolves to an address that the Custodian never dials\n",
      },
    },
  };
}

/** The headers that an HTTP connection manager of Envoy adds to a request, which no target gets. */
const FORWARD_HEADERS = ["x-forwarded-proto", "x-forwarded-for", "x-request-id", "x-envoy-internal"];

/** One HTTP connection manager of the Custodian. It adds nothing to a request or a response: no
 * `server: envoy`, no `x-request-id`, no `x-forwarded-*`, no `x-envoy-*` (ADR-0059). */
function http(opts: {
  stat: string;
  log: Json[];
  routes: Json;
  lua: Json;
  local?: Json;
  strictPath?: boolean;
  /** How long a connection with no stream stays open: one hour when not given. */
  idle?: string;
}): Json {
  return {
    name: "envoy.filters.network.http_connection_manager",
    typed_config: {
      "@type": HCM,
      stat_prefix: opts.stat,
      codec_type: "HTTP1",
      server_header_transformation: "PASS_THROUGH",
      generate_request_id: false,
      skip_xff_append: true,
      normalize_path: true,
      merge_slashes: false,
      path_with_escaped_slashes_action: opts.strictPath ? "REJECT_REQUEST" : "KEEP_UNCHANGED",
      request_headers_timeout: "60s",
      stream_idle_timeout: "3600s",
      common_http_protocol_options: {
        idle_timeout: opts.idle ?? "3600s",
        headers_with_underscores_action: "REJECT_REQUEST",
      },
      access_log: opts.log,
      ...(opts.local ? { local_reply_config: opts.local } : {}),
      http_filters: [
        {
          name: LUA,
          typed_config: {
            "@type": "type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua",
            default_source_code: opts.lua,
            clear_route_cache: false,
          },
        },
        {
          name: "envoy.filters.http.router",
          typed_config: {
            "@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router",
            suppress_envoy_headers: true,
          },
        },
      ],
      route_config: {
        request_headers_to_remove: FORWARD_HEADERS,
        response_headers_to_remove: ["x-envoy-upstream-service-time"],
        ...opts.routes,
      },
    },
  };
}

function leafTls(slot: number, host: string, port: number): Json {
  const stem = leafStem(host, port);
  return {
    name: "envoy.transport_sockets.tls",
    typed_config: {
      "@type": "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext",
      common_tls_context: {
        // HTTP/1.1 alone: SSE rides it, and one protocol keeps each engine's behaviour the same.
        alpn_protocols: ["http/1.1"],
        tls_certificates: [
          {
            certificate_chain: { filename: `${slotFolder(slot)}/tls/${stem}.crt` },
            private_key: { filename: `${slotFolder(slot)}/tls/${stem}.key` },
          },
        ],
      },
    },
  };
}

/** A tunnel to `hostname` through the dial listener (a name, or `%REQUESTED_SERVER_NAME%:<port>`). */
function tunnel(slot: number, owner: string, hostname: string): Json {
  return {
    name: "envoy.filters.network.tcp_proxy",
    typed_config: {
      "@type": TCP,
      stat_prefix: `slot${slot}`,
      cluster: "dial",
      idle_timeout: "3600s",
      tunneling_config: {
        hostname,
        headers_to_add: [
          { header: { key: SLOT_HEADER, value: String(slot) } },
          { header: { key: OWNER_HEADER, value: owner } },
        ],
      },
    },
  };
}

function direct(cluster: string, slot: number): Json {
  return {
    name: "envoy.filters.network.tcp_proxy",
    typed_config: { "@type": TCP, stat_prefix: `slot${slot}`, cluster, idle_timeout: "3600s" },
  };
}

function staticCluster(name: string, address: string, port: number, extra: Json = {}): Json {
  return {
    name,
    type: "STATIC",
    connect_timeout: "30s",
    load_assignment: {
      cluster_name: name,
      endpoints: [{ lb_endpoints: [{ endpoint: { address: { socket_address: { address, port_value: port } } } }] }],
    },
    ...extra,
  };
}

function upstreamTls(san: Json, sni?: string): Json {
  return {
    name: "envoy.transport_sockets.tls",
    typed_config: {
      "@type": "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext",
      ...(sni ? { sni } : {}),
      common_tls_context: {
        validation_context: {
          // The roots and the user's caBundle, and NEVER a jr2 CA: the Custodian must not accept one
          // of its own leaves from a target (ADR-0059).
          trusted_ca: { filename: `${CA_MOUNT}/upstream.crt` },
          ...san,
        },
      },
    },
  };
}

// ---- one slot -----------------------------------------------------------------------------------

/** A slot's Harness pod as each log line names it: `sandbox=<name>` or `pod=<name>`. Throws unless
 * the name is a Kubernetes name, so a line cannot carry another key. */
export function ownerText(owner: SlotOwner): string {
  const [key, value] = "sandbox" in owner ? ["sandbox", owner.sandbox] : ["pod", owner.pod];
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(value) || value.length > 253) {
    throw new Error(`the ${key} of a slot is a Kubernetes name, not ${JSON.stringify(value)}`);
  }
  return `${key}=${value}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function lua(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function luaList(values: readonly string[]): string {
  return `{ ${values.map(lua).join(", ")} }`;
}

/** `host:port` as the program names a target. */
function targetOf(rule: Pick<EgressRule, "host" | "port" | "match">): string {
  return `${placeholderName(rule) ?? rule.host}:${rule.port}`;
}

/** The bound secrets of each `host:port`, in manifest order. */
function boundOf(manifest: HeldManifest): Map<string, HeldBinding[]> {
  const out = new Map<string, HeldBinding[]>();
  for (const s of manifest.secrets) {
    for (const h of s.hosts) {
      const key = `${h.host}:${h.port}`;
      out.set(key, [...(out.get(key) ?? []), s]);
    }
  }
  return out;
}

/**
 * The slot's Lua table: the program's `HELD`, then `dofile` of the program. It names the control
 * credentials — the control token, and on a Sandbox the fetch token, whose Stand-in is public — then
 * the manifest's secrets, the targets each is bound to, and the `open` targets: an Intercepted host
 * that no secret is bound to, and a bound host that an entry of the Egress list also names (ADR-0084).
 * A request to an open target that carries no Stand-in leaves with every credential header removed.
 * Never a value, and never a secret Stand-in: the program reads both from the slot's `values/`.
 */
function slotLua(inputs: SlotInputs, rules: readonly EgressRule[]): string {
  const sandbox = "sandbox" in inputs.owner ? inputs.owner.sandbox : undefined;
  const control = [
    `{ name = ${lua(CONTROL_TOKEN_NAME)}, headers = { "authorization" }, paths = ${luaList([CONTROL_PATHS])} }`,
    ...(sandbox !== undefined
      ? [
          `{ name = ${lua(SANDBOX_TOKEN_NAME)}, headers = { "authorization" }, standIn = ${lua(standIn(SANDBOX_TOKEN_NAME))}, ` +
            `paths = ${luaList([FETCH_PATHS])} }`,
        ]
      : []),
  ];
  const bound = boundOf(inputs.manifest);
  const intercepted = rules.filter((r) => r.intercept);
  const lines = [
    `-- Generated for slot ${inputs.slot} (ADR-0059, ADR-0084). Names, headers, paths, targets; never a value.`,
    `HELD = { secrets = {}, targets = {}, open = {}, hosts = ${intercepted.length}, slot = ${inputs.slot}, ` +
      `values = ${lua(`${slotFolder(inputs.slot)}/values/`)}${sandbox !== undefined ? `, sandbox = ${lua(sandbox)}` : ""} }`,
    `HELD.credential = ${luaList(CREDENTIAL_HEADERS)}`,
    ...control.map((entry, i) => `HELD.secrets[${i + 1}] = ${entry}`),
    `HELD.control = { ${control.map((_, i) => `HELD.secrets[${i + 1}]`).join(", ")} }`,
  ];
  const offset = control.length + 1;
  inputs.manifest.secrets.forEach((s, i) => {
    const paths = s.paths ? `, paths = ${luaList(s.paths)}` : "";
    // A secret that rides Basic (ADR-0068): a request with no credential gets the 401 git waits for.
    const basic = s.basic ? ", basic = true" : "";
    lines.push(
      `HELD.secrets[${i + offset}] = { name = ${lua(s.name)}, headers = ${luaList(s.headers)}${paths}${basic} }`,
    );
  });
  for (const r of intercepted) {
    const target = targetOf(r);
    const secrets = bound.get(target) ?? [];
    if (secrets.length > 0) {
      const refs = secrets.map((s) => `HELD.secrets[${inputs.manifest.secrets.indexOf(s) + offset}]`);
      lines.push(`HELD.targets[${lua(target)}] = { ${refs.join(", ")} }`);
    }
    if (secrets.length === 0 || r.from.includes("entry")) lines.push(`HELD.open[${lua(target)}] = true`);
  }
  lines.push(`dofile(${lua(CUSTODIAN_POD_PROGRAM)})`);
  return `${lines.join("\n")}\n`;
}

/** Throws unless the slot's inputs can be rendered: a slot number in range, a placeholder table of
 * the Instance's range that `checkAppendOnly` accepts (each name and each address once, in the
 * range, none on jr2's own address) with a row for each name, no rule that the Fence cannot carry, and each
 * rule once. Envoy refuses a listener with two chains that match alike, so a rule twice, or one
 * name and port both Tunneled and Intercepted, would leave the slot with no listener. */
function checkInputs(inputs: SlotInputs): void {
  const { slot, manifest, placeholders, ranges } = inputs;
  if (!Number.isInteger(slot) || slot < 0 || slot >= FENCE_SLOTS) {
    throw new Error(`slot ${slot} is not 0 … ${FENCE_SLOTS - 1} (ADR-0084)`);
  }
  if (placeholders.range !== ranges.placeholders) {
    throw new Error(
      `slot ${slot}: its placeholder table is of ${placeholders.range}, not the Instance's ${ranges.placeholders} (ADR-0084)`,
    );
  }
  try {
    checkAppendOnly(undefined, placeholders);
  } catch (e) {
    throw new Error(`slot ${slot}: ${(e as Error).message}`);
  }
  const seen = new Set<string>();
  for (const r of manifest.egress) {
    // `*.d` and `*` are spelled apart from a name, so the target says which rule it is.
    if (seen.has(targetOf(r)))
      throw new Error(`slot ${slot}: the rule ${targetOf(r)} is in the manifest twice (ADR-0084)`);
    seen.add(targetOf(r));
    if (r.match === "name" || r.match === "address") {
      const why = uncarried(r.host, ranges);
      if (why !== undefined) throw new Error(`slot ${slot}: the rule ${r.host}:${r.port} ${why} (ADR-0084)`);
    }
    const name = placeholderName(r);
    if (name !== undefined && placeholderOf(placeholders, name) === undefined) {
      throw new Error(`slot ${slot}: the placeholder table has no address for ${name} (ADR-0084)`);
    }
    if (r.intercept && r.match !== "name" && r.match !== "address") {
      throw new Error(`slot ${slot}: ${targetOf(r)} is intercepted, but a leaf names one host (ADR-0084)`);
    }
  }
}

/**
 * One slot's rules (ADR-0084): its listener, the clusters of its address entries, its Lua table and
 * its resolver table. Pure: the same inputs give the same rules, and `version` says so.
 *
 * The listener's chains, for each rule of the Egress list (the dialed address `A` is the name's
 * placeholder, or the address entry itself), then jr2's own name, then the refusals:
 *
 *   name, Tunneled, TLS     `A:port` with the TLS name → tunnel to the name; another TLS name →
 *                           TLS alert; plain bytes → a tunnel, on each port (a protocol that
 *                           sends no name: the address decides)
 *   Tunneled, port 80       one HTTP chain for the slot: the `Host` chooses the name, and the
 *                           program refuses it (403) unless `A` is that name's placeholder
 *   name, Intercepted       TLS with the TLS name → TLS ended with the slot's leaf, the program,
 *                           the guard, the name; another TLS name → TLS alert; plain bytes → text.
 *                           On port 80: HTTP with the program, no TLS
 *   `*.` and `*`            TLS and HTTP only, on each port of the rule: the TLS name or the
 *                           `Host` header must be below the domain (each name, for `*`); an
 *                           address, jr2's own domain and each Intercepted host of the slot are
 *                           refused in any letter case and with a trailing dot; a `Host` that
 *                           names another port than the rule's is refused. Plain bytes go to the
 *                           slot's HTTP chain of that port; port 80 carries HTTP alone (the one
 *                           chain above). A Tunneled name with an exact entry, on a port of the
 *                           wildcard where it has no rule of its own: the same TLS and HTTP, at
 *                           the name's own placeholder, for that name alone
 *   an address              each byte to the address as written, or, Intercepted, TLS ended with
 *                           the leaf of that address
 *   `custodian.jr2.internal` 443: TLS with the leaf, the six routes to the Orchestrator; 80: the
 *                           fetch route alone
 *   each port used, then each other port: TLS → TLS alert; else a line of text. A TLS name that
 *   does not agree, and plain bytes where TLS alone is carried, are refused by one chain of each
 *   port that lists the addresses
 */
export function renderSlot(inputs: SlotInputs): SlotRules {
  checkInputs(inputs);
  const { slot, manifest, placeholders, ranges } = inputs;
  const who = `slot=${slot} ${ownerText(inputs.owner)}`;
  const version = hash({
    slot,
    owner: inputs.owner,
    manifest,
    placeholders,
    ranges,
    values: inputs.valuesVersion ?? "",
  });
  const rules = manifest.egress;
  const luaText = slotLua(inputs, rules);
  const luaPath = `${slotFolder(slot)}/held-${hash([luaText, inputs.valuesVersion ?? ""])}.lua`;
  const program = { filename: luaPath };
  const chains: Json[] = [];
  const clusters: Json[] = [];
  const names: ResolverName[] = [];
  const ports = new Set<number>([443, 80]);
  // The dial listeners print it as it is: `sandbox=<name>` or `pod=<name>`, as each line of the slot.
  const owner = ownerText(inputs.owner);

  // A refusal that an HTTP route states: the program answers it, so it is logged as each refusal is.
  const refuseRoute = (reason: string, body: string, match: Json = { prefix: "/" }): Json => ({
    match,
    direct_response: { status: 403 },
    metadata: meta({ role: "refuse", status: "403", reason, body }),
  });
  // `tls`: the chain dials the target with Envoy's own TLS (an Intercepted address on a port that
  // is not 80); an Intercepted name goes through the `dial-tls` listener, which says its own.
  const httpChain = (
    stat: string,
    target: string,
    routes: Json[],
    extra: Partial<Parameters<typeof http>[0]> = {},
    tls = false,
  ) =>
    http({
      stat,
      log: httpLog(who, target),
      lua: program,
      local: { mappers: unreachable(target, { tls }).mappers as Json[] },
      routes: { virtual_hosts: routes },
      ...extra,
    });

  // The addresses of each port whose chains refuse a TLS name that does not agree, and plain bytes.
  const sniRefused = new Map<number, string[]>();
  const tlsOnly = new Map<number, string[]>();
  const refuseOn = (map: Map<number, string[]>, port: number, address: string): void => {
    map.set(port, [...(map.get(port) ?? []), address]);
  };
  // The slot's HTTP chain of each port that carries plain HTTP by its `Host`: its virtual hosts,
  // its route for `*`, and the addresses that it serves (on port 80, each address).
  const httpPorts = new Map<number, { hosts: Json[]; any?: Json[]; addresses: string[] }>();
  const httpOn = (port: number) => {
    if (!httpPorts.has(port)) httpPorts.set(port, { hosts: [], addresses: [] });
    return httpPorts.get(port)!;
  };
  // What the Custodian adds to a request toward its dial listeners, so that their log names the
  // slot. It replaces what the pod sent, and goes no further.
  const fenceHeaders = [
    { header: { key: SLOT_HEADER, value: String(slot) }, append_action: "OVERWRITE_IF_EXISTS_OR_ADD" },
    { header: { key: OWNER_HEADER, value: owner }, append_action: "OVERWRITE_IF_EXISTS_OR_ADD" },
  ];
  // The route of a Tunneled host's plain HTTP: the program refuses it unless the address dialed is
  // that host's placeholder.
  const tunnelRoute = (address: string, port: number): Json => ({
    match: { prefix: "/" },
    route: { cluster: "dial-http", timeout: "0s" },
    request_headers_to_add: fenceHeaders,
    metadata: meta({ role: "http", address: `${address}:${port}` }),
  });

  // The Intercepted names of the slot that a wildcard rule covers: a wildcard refuses them.
  const interceptedNames = [...new Set(rules.filter((r) => r.intercept && r.match === "name").map((r) => r.host))];
  const covered = (rule: EgressRule): string[] =>
    rule.match === "any"
      ? interceptedNames
      : rule.match === "below"
        ? interceptedNames.filter((n) => n.endsWith(`.${rule.host}`))
        : [];
  // The routes of a `*.` or `*` rule's plain HTTP on its port.
  const wildcardRoutes = (rule: EgressRule, address: string): Json[] => [
    refuseRoute("host", "the Host header names an address or a name of jr2's", {
      prefix: "/",
      headers: [{ name: ":authority", string_match: { safe_regex: { regex: REFUSED_AUTHORITY } } }],
    }),
    ...(covered(rule).length > 0
      ? [
          refuseRoute("intercepted", "the Host header names an Intercepted host, which no wildcard carries", {
            prefix: "/",
            headers: [{ name: ":authority", string_match: { safe_regex: { regex: namesRegex(covered(rule)) } } }],
          }),
        ]
      : []),
    // A tunnel dials a name in one spelling only, as the `dial` listener does (`REFUSED_CONNECT`).
    refuseRoute("host", "the Host header ends in a dot: a wildcard carries a name without one", {
      prefix: "/",
      headers: [{ name: ":authority", string_match: { safe_regex: { regex: TRAILING_DOT_AUTHORITY } } }],
    }),
    // The Custodian dials the port that the `Host` names: a wildcard carries the port of its rule
    // alone (ADR-0084: an entry permits its ports).
    {
      ...tunnelRoute(address, rule.port),
      match: {
        prefix: "/",
        headers: [{ name: ":authority", string_match: { safe_regex: { regex: portAuthority(rule.port) } } }],
      },
    },
    refuseRoute("port", `the Host header names a port other than ${rule.port}, which this entry does not permit`),
  ];

  for (const rule of rules) {
    ports.add(rule.port);
    const target = targetOf(rule);
    const name = placeholderName(rule);
    const address = name === undefined ? rule.host : placeholderOf(placeholders, name)!;
    // One row for each name: a name on two ports has one placeholder.
    if (name !== undefined && !names.some((n) => n.name === name)) {
      names.push({ name, match: rule.match as ResolverName["match"], address });
    }
    const at = { prefix_ranges: ip32(address), destination_port: rule.port };
    const sni = rule.match === "name" ? { server_names: [rule.host] } : {};

    if (rule.intercept) {
      const isAddress = rule.match === "address";
      const tls = rule.port !== 80;
      const cluster = isAddress ? `${tls ? "tls" : "http"}|${rule.host}|${rule.port}` : tls ? "dial-tls" : "dial-http";
      if (isAddress) {
        clusters.push(
          staticCluster(cluster, rule.host, rule.port, {
            typed_extension_protocol_options: HTTP1,
            ...(tls
              ? {
                  transport_socket: upstreamTls({
                    match_typed_subject_alt_names: [{ san_type: "IP_ADDRESS", matcher: { exact: rule.host } }],
                  }),
                }
              : {}),
          }),
        );
      }
      const manager = httpChain(
        `slot${slot}_intercept`,
        target,
        [
          {
            name: "intercept",
            domains: ["*"],
            routes: [
              {
                match: { prefix: "/" },
                route: { cluster, timeout: "0s" },
                ...(isAddress ? {} : { request_headers_to_add: fenceHeaders }),
                metadata: meta({ role: "intercept", target }),
              },
            ],
          },
        ],
        { strictPath: true },
        tls && isAddress,
      );
      if (tls) {
        chains.push(
          chain(
            `action=intercept target=${target}`,
            { ...at, transport_protocol: "tls", ...sni },
            [manager],
            leafTls(slot, rule.host, rule.port),
          ),
        );
        // An address has no TLS name to check: a client that dials it sends none.
        if (!isAddress) refuseOn(sniRefused, rule.port, address);
        refuseOn(tlsOnly, rule.port, address);
      } else {
        chains.push(
          chain(`action=refuse reason=tls target=${target}`, { ...at, transport_protocol: "tls" }, [ALERT]),
          chain(`action=intercept target=${target}`, at, [manager]),
        );
      }
      continue;
    }

    if (rule.match === "address") {
      const cluster = `tcp|${rule.host}|${rule.port}`;
      clusters.push(staticCluster(cluster, rule.host, rule.port));
      chains.push(chain(`action=tunnel target=${target}`, at, [direct(cluster, slot)]));
      continue;
    }

    if (rule.port === 80 && rule.match === "name") {
      // Port 80 of each Tunneled name is one HTTP chain of the slot (below): its `Host` chooses the
      // route, and the program checks that the address dialed is that host's placeholder.
      httpOn(80).hosts.push({
        name: rule.host,
        domains: [rule.host, `${rule.host}:80`],
        routes: [tunnelRoute(address, 80)],
      });
      continue;
    }

    if (rule.match === "name") {
      chains.push(
        chain(`action=tunnel target=${target}`, { ...at, transport_protocol: "tls", ...sni }, [
          tunnel(slot, owner, `${rule.host}:${rule.port}`),
        ]),
        // A protocol that sends no name (SSH, a database, also on 443): the address decides.
        chain(`action=tunnel target=${target} transport=raw`, { ...at, transport_protocol: "raw_buffer" }, [
          tunnel(slot, owner, `${rule.host}:${rule.port}`),
        ]),
      );
      refuseOn(sniRefused, rule.port, address);
      continue;
    }

    // `*.` and `*`, on each of their ports: on HTTP the `Host` header says which name was meant
    // (the slot's HTTP chain of that port, below), on TLS the TLS name. An Intercepted host, jr2's
    // own name among them, is never carried by a wildcard: it has its own chain, where the Custodian
    // ends its TLS.
    const web = httpOn(rule.port);
    if (rule.port !== 80) web.addresses.push(address);
    if (rule.match === "below") {
      web.hosts.push({
        name: `*.${rule.host}`,
        domains: [`*.${rule.host}`, `*.${rule.host}:${rule.port}`],
        routes: wildcardRoutes(rule, address),
      });
    } else {
      web.any = wildcardRoutes(rule, address);
    }
    // Port 80 carries HTTP alone. A chain of the address there would also hide the port's one HTTP
    // chain from it: Envoy does not step back from an address that matched.
    if (rule.port === 80) continue;
    chains.push(
      chain(
        `action=refuse reason=intercepted target=${target}`,
        {
          ...at,
          transport_protocol: "tls",
          // Each name also with a trailing dot, which a client may send and a DNS lookup accepts.
          server_names: [`*.${JR2_NAME_DOMAIN}`, JR2_NAME_DOMAIN, ...covered(rule)].flatMap((n) => [n, `${n}.`]),
        },
        [ALERT],
      ),
      chain(
        `action=tunnel target=${target}`,
        { ...at, transport_protocol: "tls", ...(rule.match === "below" ? { server_names: [`*.${rule.host}`] } : {}) },
        [tunnel(slot, owner, `%REQUESTED_SERVER_NAME%:${rule.port}`)],
      ),
    );
    if (rule.match === "below") refuseOn(sniRefused, rule.port, address);
  }

  // A Tunneled name with an exact entry has its own placeholder, so the chains of a `*.` or `*`
  // rule, which match that rule's placeholder, never see it. On each port of a wildcard that covers
  // the name, where the name has no rule of its own, its placeholder gets what the wildcard carries
  // for that name alone: TLS with its TLS name, and plain HTTP with its `Host`; no raw bytes, and no
  // other resolver row (ADR-0084).
  const coveredBy = new Set<string>();
  for (const wildcard of rules) {
    if (wildcard.match !== "any" && wildcard.match !== "below") continue;
    const port = wildcard.port;
    for (const exact of rules) {
      if (exact.match !== "name" || exact.intercept || interceptedNames.includes(exact.host)) continue;
      if (wildcard.match === "below" && !exact.host.endsWith(`.${wildcard.host}`)) continue;
      if (rules.some((r) => r.match === "name" && r.host === exact.host && r.port === port)) continue;
      const target = `${exact.host}:${port}`;
      if (coveredBy.has(target)) continue;
      coveredBy.add(target);
      const address = placeholderOf(placeholders, exact.host)!;
      const web = httpOn(port);
      // The wildcard's routes, so that a `Host` with no port, or another port, is refused as there.
      web.hosts.push({ name: exact.host, domains: [exact.host, target], routes: wildcardRoutes(wildcard, address) });
      if (port === 80) continue;
      web.addresses.push(address);
      chains.push(
        chain(
          `action=tunnel target=${target}`,
          {
            prefix_ranges: ip32(address),
            destination_port: port,
            transport_protocol: "tls",
            server_names: [exact.host],
          },
          [tunnel(slot, owner, target)],
        ),
      );
      refuseOn(sniRefused, port, address);
    }
  }

  // jr2's own name: the control routes on 443 with the slot's leaf, the fetch route on 443 and 80.
  const jr2 = jr2NameAddress(ranges.placeholders);
  names.unshift({ name: JR2_CUSTODIAN_NAME, match: "name", address: jr2 });
  const deny = {
    name: "deny",
    match: { prefix: "/" },
    direct_response: { status: 404 },
    metadata: meta({ role: "deny" }),
  };
  const toOrchestrator = (routes: Json[]): Json =>
    http({
      stat: `slot${slot}_control`,
      log: httpLog(who, "orchestrator"),
      lua: program,
      local: ORCHESTRATOR_UNREACHABLE,
      routes: { virtual_hosts: [{ name: "orchestrator", domains: ["*"], routes: [...routes, deny] }] },
    });
  const jr2At = { prefix_ranges: ip32(jr2) };
  chains.push(
    chain(
      `action=intercept target=${JR2_CUSTODIAN_NAME}:443`,
      { ...jr2At, destination_port: 443, transport_protocol: "tls", server_names: [JR2_CUSTODIAN_NAME] },
      [toOrchestrator(CONTROL_ROUTES.map(controlRoute))],
      leafTls(slot, JR2_CUSTODIAN_NAME, 443),
    ),
    chain(
      `action=refuse reason=tls target=${JR2_CUSTODIAN_NAME}:80`,
      { ...jr2At, destination_port: 80, transport_protocol: "tls" },
      [ALERT],
    ),
    chain(`action=control target=${JR2_CUSTODIAN_NAME}:80`, { ...jr2At, destination_port: 80 }, [
      toOrchestrator(CONTROL_ROUTES.filter((r) => r.name === "fetch").map(controlRoute)),
    ]),
  );

  refuseOn(sniRefused, 443, jr2);
  refuseOn(tlsOnly, 443, jr2);

  // On each port, one chain refuses a TLS name that is not the name of the address dialed, and one
  // refuses plain bytes where only TLS is carried. They list the addresses: a chain of a name with
  // its TLS name is as specific, and the TLS name then chooses it.
  for (const [port, addresses] of sniRefused) {
    chains.push(
      chain(
        `action=refuse reason=sni port=${port}`,
        { prefix_ranges: addresses.flatMap(ip32), destination_port: port, transport_protocol: "tls" },
        [ALERT],
      ),
    );
  }
  for (const [port, addresses] of tlsOnly) {
    chains.push(
      chain(
        `action=refuse reason=not-tls port=${port}`,
        { prefix_ranges: addresses.flatMap(ip32), destination_port: port },
        [textRefusal(`this address takes TLS only on port ${port}`)],
      ),
    );
  }

  // The slot's HTTP chain of a port: the `Host` chooses the virtual host. On port 80 it serves each
  // address of the port; on another port, the addresses of the wildcards there, by plain bytes.
  const webChain = (port: number): Json => {
    const web = httpOn(port);
    return http({
      stat: port === 80 ? `slot${slot}_http` : `slot${slot}_http_${port}`,
      log: httpLog(who, "%REQ(:AUTHORITY)%"),
      lua: program,
      local: { mappers: unreachable("%REQ(:AUTHORITY)%").mappers as Json[] },
      routes: {
        virtual_hosts: [
          ...web.hosts,
          {
            name: "each",
            domains: ["*"],
            routes: web.any ?? [refuseRoute("no-entry", "no entry of the Egress list permits this address and Host")],
          },
        ],
      },
    });
  };
  for (const [port, web] of httpPorts) {
    if (port === 80) continue;
    chains.push(
      chain(
        `action=tunnel port=${port} transport=http`,
        { prefix_ranges: web.addresses.flatMap(ip32), destination_port: port, transport_protocol: "raw_buffer" },
        [webChain(port)],
      ),
    );
  }

  // Each port that a chain names, then every other port. Envoy does not step back from a port that
  // matched to a chain with no port, so each port that a chain names has its own refusals.
  for (const port of [...ports].sort((a, b) => a - b)) {
    chains.push(
      chain(
        `action=refuse reason=no-entry port=${port} transport=tls`,
        { destination_port: port, transport_protocol: "tls" },
        [ALERT],
      ),
    );
    chains.push(
      chain(
        port === 80 ? "action=tunnel port=80" : `action=refuse reason=no-entry port=${port}`,
        { destination_port: port },
        port === 80
          ? [webChain(80)]
          : [textRefusal(`no entry of the Egress list permits this address on port ${port}`)],
      ),
    );
  }
  chains.push(chain("action=refuse reason=no-entry transport=tls", { transport_protocol: "tls" }, [ALERT]));
  // The version of the slot's rules, as a chain of its own, so that the control process reads from
  // Envoy which rules are active: Envoy keeps a listener's `version_info` when an update changes only
  // its chains. The chain refuses as the chain above does, and a change of version drains it alone.
  chains.push(
    chain(
      `action=refuse reason=no-entry transport=tls ${rulesChainName(version)}`,
      { server_names: [rulesServerName(version)], transport_protocol: "tls" },
      [ALERT],
    ),
  );

  const listener: Json = {
    name: `slot-${slot}`,
    address: { socket_address: { address: "0.0.0.0", port_value: SLOT_LISTENER_BASE + slot } },
    listener_filters: [
      {
        name: "envoy.filters.listener.original_dst",
        typed_config: { "@type": "type.googleapis.com/envoy.extensions.filters.listener.original_dst.v3.OriginalDst" },
      },
      {
        name: "envoy.filters.listener.tls_inspector",
        typed_config: {
          "@type": "type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector",
        },
      },
    ],
    // A protocol where the server speaks first sends no TLS name: after this wait, its bytes are
    // read as plain (ADR-0084).
    listener_filters_timeout: "2s",
    continue_on_listener_filters_timeout: true,
    access_log: [
      {
        name: "envoy.access_loggers.stdout",
        typed_config: {
          "@type": "type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog",
          log_format: {
            text_format_source: {
              inline_string:
                `jr2.custodian ${who} %FILTER_CHAIN_NAME% to=%DOWNSTREAM_LOCAL_ADDRESS% ` +
                "sni=%REQUESTED_SERVER_NAME% flags=%RESPONSE_FLAGS% rx=%BYTES_RECEIVED% tx=%BYTES_SENT%\n",
            },
          },
        },
      },
    ],
    filter_chains: chains,
    default_filter_chain: {
      name: "action=refuse reason=no-entry",
      filters: [textRefusal("no entry of the Egress list permits this address and port")],
    },
  };

  return {
    slot,
    version,
    listener,
    clusters,
    lua: { path: luaPath, text: luaText },
    resolver: { slot, version, owner, names },
  };
}

/** The part of a slot listener's chain name that states the version of its rules. A listener whose
 * chains include one with this name has those rules active (`custodian-control.ts`). */
export function rulesChainName(version: string): string {
  return `rules=${version}`;
}

/** The TLS name that the version chain matches: below jr2's own domain, which no entry can name. */
function rulesServerName(version: string): string {
  return `${version}.rules.${JR2_NAME_DOMAIN}`;
}

// ---- the files of a Custodian pod --------------------------------------------------------------

const LISTENER_TYPE = "type.googleapis.com/envoy.config.listener.v3.Listener";
const CLUSTER_TYPE = "type.googleapis.com/envoy.config.cluster.v3.Cluster";

/**
 * The LDS and the CDS file of a Custodian pod: one listener for each slot, and the clusters of the
 * slots' address entries, once each. Two slots that name one address name one cluster. Its
 * `version_info` is a hash of the slots' versions.
 */
export function custodianXds(slots: readonly SlotRules[]): { lds: Json; cds: Json } {
  const seen = new Set<number>();
  for (const s of slots) {
    // Envoy refuses an update with two listeners of one name, so one doubled slot stops every slot.
    if (seen.has(s.slot)) throw new Error(`slot ${s.slot} is rendered twice`);
    seen.add(s.slot);
  }
  const versionInfo = hash(slots.map((s) => [s.slot, s.version]));
  const clusters = new Map<string, Json>();
  for (const s of slots) {
    for (const c of s.clusters) {
      const name = c.name as string;
      const known = clusters.get(name);
      if (known !== undefined && JSON.stringify(known) !== JSON.stringify(c)) {
        throw new Error(`two slots render the cluster ${name} differently`);
      }
      clusters.set(name, c);
    }
  }
  return {
    lds: {
      version_info: versionInfo,
      resources: [...slots].sort((a, b) => a.slot - b.slot).map((s) => ({ "@type": LISTENER_TYPE, ...s.listener })),
    },
    cds: {
      version_info: versionInfo,
      resources: [...clusters.values()].map((c) => ({ "@type": CLUSTER_TYPE, ...c })),
    },
  };
}

// ---- the pod's bootstrap ------------------------------------------------------------------------

/** The highest VLAN range: its last slot is VLAN 4094, the highest VLAN there is. So a cluster has
 * ranges 0 … 30, one for each Instance whose Harness pods are behind the Fence. */
export const FENCE_LAST_RANGE = Math.floor((4094 - 2 - (FENCE_SLOTS - 1)) / FENCE_SLOTS);

/** The VLAN of slot `slot` of range `range` (ADR-0084): `2 + 128 × range + slot`, from 2 to 4094.
 * Any other range or slot is a program error: its address would be outside the segment, and the
 * inbound listener's target table would name addresses of no slot. */
export function slotVlan(range: number, slot: number): number {
  if (!Number.isInteger(range) || range < 0 || range > FENCE_LAST_RANGE) {
    throw new Error(`VLAN range ${range} is not 0 … ${FENCE_LAST_RANGE} (ADR-0084)`);
  }
  if (!Number.isInteger(slot) || slot < 0 || slot >= FENCE_SLOTS) {
    throw new Error(`slot ${slot} is not 0 … ${FENCE_SLOTS - 1} (ADR-0084)`);
  }
  return 2 + FENCE_SLOTS * range + slot;
}

/** The address of a VLAN on the segment: the segment's network address plus the VLAN. */
export function slotAddress(segment: string, vlan: number): string {
  const [base] = segment.split("/");
  const n = base!.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0) + vlan;
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
}

/** The Orchestrator's dial whose target gave no answer (ADR-0042, ADR-0084): 503 with
 * `x-jr2-custodian: unreachable` and the flags, so that the caller can tell "not delivered" from an
 * answer. The route removes a target's own `x-jr2-custodian` before this header is added. */
const INBOUND_UNREACHABLE: Json = {
  mappers: [
    {
      filter: { response_flag_filter: { flags: [...NOT_SENT_FLAGS, ...MAY_HAVE_SENT_FLAGS] } },
      status_code: 503,
      headers_to_add: [
        { header: { key: "x-jr2-custodian", value: "unreachable" }, append_action: "OVERWRITE_IF_EXISTS_OR_ADD" },
      ],
      body_format_override: {
        json_format: {
          error: "the Harness pod never answered through the Custodian",
          detail: "%RESPONSE_CODE_DETAILS% %UPSTREAM_TRANSPORT_FAILURE_REASON%",
          flags: "%RESPONSE_FLAGS%",
        },
      },
    },
  ],
};

function dfpCluster(ranges: FenceRanges, bounds: NameCacheBounds, name: string, extra: Json = {}, plain = false): Json {
  return {
    name,
    lb_policy: "CLUSTER_PROVIDED",
    connect_timeout: "30s",
    cluster_type: {
      name: "envoy.clusters.dynamic_forward_proxy",
      typed_config: {
        "@type": "type.googleapis.com/envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig",
        dns_cache_config: dialDns(ranges, bounds),
        // Plain HTTP has no TLS name to set or check.
        ...(plain ? { allow_insecure_cluster_options: true } : {}),
      },
    },
    ...extra,
  };
}

/** What Envoy says when a dial listener's HTTP/1 codec refuses a request (`DPE`). */
const CODEC_REFUSED = "response.code_details.startsWith('http1.')";

/** A dial listener's log (ADR-0059): one line for a refusal by the dial guard, one for a name that it
 * refuses, one for a name refused while the cache of names is full, one for a target that gave no
 * answer, each with the slot and its Harness pod that the slot's chain named. Of a target that gave
 * no answer, a failed TLS handshake has its own reason: `reason=tls-certificate` for a certificate
 * that the Custodian does not trust, `reason=tls` for each other TLS failure and, on the `dial-tls`
 * listener (`tls`), for a close before the handshake ended. A CONNECT that the listener's codec
 * refuses (a TLS name that is not a DNS name, which Envoy writes as `invalid:…`) is a name refused;
 * no header of it was read, so its line names no slot, and the slot's own line names the Sandbox
 * and the TLS name. */
function dialLog(tls: boolean): Json[] {
  const line = (reason: string, expression: string): Json => ({
    name: "envoy.access_loggers.stdout",
    filter: {
      extension_filter: {
        name: "envoy.access_loggers.extension_filters.cel",
        typed_config: {
          "@type": "type.googleapis.com/envoy.extensions.access_loggers.filters.cel.v3.ExpressionFilter",
          expression,
        },
      },
    },
    typed_config: {
      "@type": "type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog",
      log_format: {
        text_format_source: {
          inline_string:
            "jr2.custodian slot=%DYNAMIC_METADATA(jr2:slot)% %DYNAMIC_METADATA(jr2:owner)% action=refuse " +
            `target=%REQ(:AUTHORITY)% reason=${reason} method=%REQ(:METHOD)% status=%RESPONSE_CODE% flags=%RESPONSE_FLAGS%\n`,
        },
      },
    },
  });
  const noAnswer =
    `response.flags != 0u && response.code != 200 && response.code_details != 'via_upstream' && ` +
    `!(${GUARDED}) && !${CODEC_REFUSED}`;
  const handshake = tls ? `${TLS_FAILED} || ${CLOSED_IN_HANDSHAKE}` : TLS_FAILED;
  return [
    line("guard", GUARDED),
    line("name", `(response.code_details == 'direct_response' && response.code == 403) || ${CODEC_REFUSED}`),
    line("name-cache", NAME_CACHE_FULL),
    // A flag on an answer of the target, or on a tunnel that its client closed (`DC`), is no refusal.
    line("tls-certificate", `${noAnswer} && ${CERTIFICATE_FAILED}`),
    line("tls", `${noAnswer} && !${CERTIFICATE_FAILED} && (${handshake})`),
    line("unreachable", `${noAnswer} && !(${handshake})`),
  ];
}

/**
 * One internal dial listener of the Custodian pod (ADR-0059, ADR-0084). Every dial by name goes
 * through one, so the dial guard is in one place: the one DNS cache drops each address of a name in
 * a guarded range or in the Fence's own ranges, so the dial can connect only to an address that
 * the guard judged, and a name with no address left gets the guard's refusal.
 *
 *   dial       the CONNECT of a tunnel (a TLS name, or a protocol that sends no name): TCP
 *   dial-http  a Tunneled host's plain HTTP, or an Intercepted host on port 80: plain HTTP
 *   dial-tls   an Intercepted host after the swap: Envoy's own TLS, the name verified
 */
function dialListener(name: "dial" | "dial-http" | "dial-tls", ranges: FenceRanges, bounds: NameCacheBounds): Json {
  const connect = name === "dial";
  const fenceMetadata = {
    name: "envoy.filters.http.header_to_metadata",
    typed_config: {
      "@type": "type.googleapis.com/envoy.extensions.filters.http.header_to_metadata.v3.Config",
      request_rules: [
        [SLOT_HEADER, "slot"],
        [OWNER_HEADER, "owner"],
      ].map(([header, key]) => ({
        header,
        on_header_present: { metadata_namespace: "jr2", key, type: "STRING" },
        remove: true,
      })),
    },
  };
  const routes: Json[] = connect
    ? [
        {
          match: {
            connect_matcher: {},
            headers: [{ name: ":authority", string_match: { safe_regex: { regex: REFUSED_CONNECT } } }],
          },
          direct_response: { status: 403 },
        },
        {
          match: { connect_matcher: {} },
          route: {
            cluster: "dial-tcp",
            timeout: "0s",
            upgrade_configs: [{ upgrade_type: "CONNECT", connect_config: {} }],
          },
        },
        { match: { prefix: "/" }, direct_response: { status: 405 } },
      ]
    : [{ match: { prefix: "/" }, route: { cluster: `${name}-name`, timeout: "0s" } }];
  return {
    name,
    internal_listener: {},
    filter_chains: [
      {
        filters: [
          {
            name: "envoy.filters.network.http_connection_manager",
            typed_config: {
              "@type": HCM,
              stat_prefix: name,
              codec_type: "HTTP1",
              server_header_transformation: "PASS_THROUGH",
              generate_request_id: false,
              skip_xff_append: true,
              ...(connect ? { upgrade_configs: [{ upgrade_type: "CONNECT" }] } : {}),
              stream_idle_timeout: "3600s",
              common_http_protocol_options: { idle_timeout: "3600s" },
              access_log: dialLog(name === "dial-tls"),
              ...(connect
                ? {}
                : {
                    local_reply_config: {
                      mappers: [
                        guardReply(),
                        nameCacheReply(),
                        ...(unreachable("%REQ(:AUTHORITY)%", { tls: name === "dial-tls" }).mappers as Json[]),
                      ],
                    },
                  }),
              http_filters: [
                fenceMetadata,
                dialFilter(ranges, bounds),
                {
                  name: "envoy.filters.http.router",
                  typed_config: {
                    "@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router",
                    suppress_envoy_headers: true,
                  },
                },
              ],
              route_config: {
                // This manager sets `x-forwarded-proto` again; the target gets none of these (ADR-0059).
                request_headers_to_remove: FORWARD_HEADERS,
                response_headers_to_remove: ["x-envoy-upstream-service-time"],
                virtual_hosts: [{ name, domains: ["*"], routes }],
              },
            },
          },
        ],
      },
    ],
  };
}

export type CustodianPodOptions = {
  /** Where the control routes go: the Orchestrator's Service. */
  orchestrator: OrchestratorAddress;
  /** The Instance's VLAN range (`k`): the inbound listener dials only its slots. */
  range: number;
  /** The Instance's two Fence ranges. */
  ranges: FenceRanges;
  /** The bounds of the pod's cache of names. `CUSTODIAN_NAME_CACHE` when not given; a test sets
   * small ones. */
  nameCache?: NameCacheBounds;
  /** The pod's connection bounds. `CUSTODIAN_CONNECTIONS` when not given; a test sets small ones. */
  connections?: ConnectionBounds;
};

/**
 * The static bootstrap of a Custodian pod (ADR-0084), the same for each pod of an Instance:
 *
 *   admin     127.0.0.1:15000   the control process reads which slot is live; no Harness pod
 *                               reaches the pod's loopback
 *   health    0.0.0.0:15021     GET /healthz, for the kubelet
 *   inbound   0.0.0.0:18080     the Orchestrator's dial to a Harness pod: the dial token, a
 *                               target that is port 8080 or 8082 of a slot of this Instance
 *   dial      (internal)        every dial by name: the CONNECT of a tunnel, the dial guard on the
 *                               resolved address, then the TCP connection to that address
 *   slots     LDS and CDS       from the two files in the state folder, which Envoy watches
 */
export function custodianPodBootstrap(opts: CustodianPodOptions): Json {
  const { orchestrator, range, ranges } = opts;
  const bounds = opts.nameCache ?? CUSTODIAN_NAME_CACHE;
  const connections = opts.connections ?? CUSTODIAN_CONNECTIONS;
  const targets: string[] = [];
  for (let slot = 0; slot < FENCE_SLOTS; slot++) {
    const address = slotAddress(ranges.segment, slotVlan(range, slot));
    for (const port of DIAL_PORTS) targets.push(`${address}:${port}`);
  }
  const inboundTable = [
    "-- Generated (ADR-0084): the Orchestrator's dial. The dial token is read from its file, never from here.",
    "HELD = { secrets = {}, credential = {}, targets = {}, hosts = 0 }",
    `HELD.inbound = { token = ${lua(CUSTODIAN_DIAL_TOKEN)}, targets = {} }`,
    `for _, t in ipairs(${luaList(targets)}) do HELD.inbound.targets[t] = true end`,
    `dofile(${lua(CUSTODIAN_POD_PROGRAM)})`,
  ].join("\n");

  const health: Json = {
    name: "health",
    address: { socket_address: { address: "0.0.0.0", port_value: CUSTODIAN_HEALTH_PORT } },
    // A pod of the cluster can reach this listener; the kubelet probes one request at a time. So it
    // is outside Envoy's global limit, holds 16 connections at most, and closes one idle for 5 s.
    ignore_global_conn_limit: true,
    filter_chains: [
      {
        filters: [
          {
            name: "envoy.filters.network.connection_limit",
            typed_config: {
              "@type": "type.googleapis.com/envoy.extensions.filters.network.connection_limit.v3.ConnectionLimit",
              stat_prefix: "health",
              max_connections: 16,
            },
          },
          {
            name: "envoy.filters.network.http_connection_manager",
            typed_config: {
              "@type": HCM,
              stat_prefix: "health",
              codec_type: "HTTP1",
              server_header_transformation: "PASS_THROUGH",
              generate_request_id: false,
              request_headers_timeout: "5s",
              stream_idle_timeout: "5s",
              common_http_protocol_options: { idle_timeout: "5s" },
              http_filters: [
                {
                  name: "envoy.filters.http.router",
                  typed_config: { "@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router" },
                },
              ],
              route_config: {
                virtual_hosts: [
                  {
                    name: "health",
                    domains: ["*"],
                    routes: [
                      {
                        match: { path: "/healthz", headers: [{ name: ":method", string_match: { exact: "GET" } }] },
                        direct_response: { status: 200, body: { inline_string: "ok\n" } },
                      },
                      { match: { prefix: "/" }, direct_response: { status: 404 } },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  };

  const inbound: Json = {
    name: "inbound",
    address: { socket_address: { address: "0.0.0.0", port_value: CUSTODIAN_INBOUND_PORT } },
    // A pod of the cluster can reach this listener on a CNI that enforces no NetworkPolicy. So it is
    // outside Envoy's global limit and has its own bound, and it closes a connection with no stream
    // after a minute: a peer's idle connections here cannot stop a slot, and a Sandbox's held
    // connections cannot stop the Orchestrator's dial. A stream keeps the idle hour.
    ignore_global_conn_limit: true,
    filter_chains: [
      {
        filters: [
          {
            name: "envoy.filters.network.connection_limit",
            typed_config: {
              "@type": "type.googleapis.com/envoy.extensions.filters.network.connection_limit.v3.ConnectionLimit",
              stat_prefix: "inbound",
              max_connections: connections.dial,
            },
          },
          http({
            stat: "inbound",
            idle: CUSTODIAN_DIAL_IDLE,
            log: [
              {
                name: "envoy.access_loggers.stdout",
                filter: {
                  metadata_filter: {
                    matcher: { filter: "jr2", path: [{ key: "log" }], value: { bool_match: true } },
                    match_if_key_not_found: false,
                  },
                },
                typed_config: {
                  "@type": "type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog",
                  log_format: {
                    text_format_source: {
                      inline_string:
                        "jr2.custodian dial action=%DYNAMIC_METADATA(jr2:action)% target=%DYNAMIC_METADATA(jr2:target)% " +
                        "reason=%DYNAMIC_METADATA(jr2:reason)% method=%REQ(:METHOD)% status=%RESPONSE_CODE% " +
                        "flags=%RESPONSE_FLAGS%\n",
                    },
                  },
                },
              },
            ],
            lua: { inline_string: inboundTable },
            local: INBOUND_UNREACHABLE,
            routes: {
              virtual_hosts: [
                {
                  name: "inbound",
                  domains: ["*"],
                  routes: [
                    {
                      match: { prefix: "/" },
                      // A stream (a Handoff carry, a long poll) has no route timeout; it has the
                      // listener's idle hour.
                      route: { cluster: "inbound", timeout: "0s" },
                      // The target is removed on the cluster, after it chose the host by it.
                      request_headers_to_remove: [DIAL_TOKEN_HEADER],
                      response_headers_to_remove: ["x-jr2-custodian"],
                      metadata: meta({ role: "inbound" }),
                    },
                  ],
                },
              ],
            },
          }),
        ],
      },
    ],
  };

  const dials = (["dial", "dial-http", "dial-tls"] as const).map((name) => dialListener(name, ranges, bounds));

  const clusters: Json[] = [
    {
      name: "orchestrator",
      type: "LOGICAL_DNS",
      dns_lookup_family: "V4_PREFERRED",
      connect_timeout: "5s",
      // Node closes a keep-alive connection idle for 5 s. A pooled connection is dropped first.
      typed_extension_protocol_options: {
        "envoy.extensions.upstreams.http.v3.HttpProtocolOptions": {
          "@type": "type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions",
          common_http_protocol_options: { idle_timeout: "4s" },
          explicit_http_config: { http_protocol_options: {} },
        },
      },
      load_assignment: {
        cluster_name: "orchestrator",
        endpoints: [
          {
            lb_endpoints: [
              {
                endpoint: {
                  address: { socket_address: { address: orchestrator.host, port_value: orchestrator.port } },
                },
              },
            ],
          },
        ],
      },
    },
    {
      // The Harness pod that the dial names: the slot address in `x-jr2-target`, which the program
      // checked, through the uplink's route to that slot's VLAN.
      name: "inbound",
      type: "ORIGINAL_DST",
      lb_policy: "CLUSTER_PROVIDED",
      connect_timeout: "5s",
      original_dst_lb_config: { use_http_header: true, http_header_name: DIAL_TARGET_HEADER },
      typed_extension_protocol_options: {
        "envoy.extensions.upstreams.http.v3.HttpProtocolOptions": {
          "@type": "type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions",
          common_http_protocol_options: { idle_timeout: "4s" },
          explicit_http_config: { http_protocol_options: {} },
          // An upstream filter runs after the host is chosen: only here can the target header go.
          http_filters: [
            {
              name: "envoy.filters.http.header_mutation",
              typed_config: {
                "@type": "type.googleapis.com/envoy.extensions.filters.http.header_mutation.v3.HeaderMutation",
                mutations: { request_mutations: [{ remove: DIAL_TARGET_HEADER }] },
              },
            },
            {
              name: "envoy.filters.http.upstream_codec",
              typed_config: {
                "@type": "type.googleapis.com/envoy.extensions.filters.http.upstream_codec.v3.UpstreamCodec",
              },
            },
          ],
        },
      },
    },
    ...["dial", "dial-http", "dial-tls"].map((name) => ({
      name,
      load_assignment: {
        cluster_name: name,
        endpoints: [
          { lb_endpoints: [{ endpoint: { address: { envoy_internal_address: { server_listener_name: name } } } }] },
        ],
      },
      typed_extension_protocol_options: HTTP1,
    })),
    dfpCluster(ranges, bounds, "dial-tcp"),
    dfpCluster(ranges, bounds, "dial-http-name", { typed_extension_protocol_options: HTTP1 }, true),
    dfpCluster(ranges, bounds, "dial-tls-name", {
      typed_extension_protocol_options: {
        "envoy.extensions.upstreams.http.v3.HttpProtocolOptions": {
          "@type": "type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions",
          // The TLS name and the name checked in the target's certificate are the `Host`, which the
          // slot's program checked against the target.
          upstream_http_protocol_options: { auto_sni: true, auto_san_validation: true },
          explicit_http_config: { http_protocol_options: {} },
        },
      },
      transport_socket: upstreamTls({}),
    }),
  ];

  const watched = (path: string) => ({
    resource_api_version: "V3",
    path_config_source: { path, watched_directory: { path: CUSTODIAN_XDS } },
  });

  return {
    node: { id: "jr2-custodian", cluster: "jr2-custodian" },
    admin: { address: { socket_address: { address: "127.0.0.1", port_value: CUSTODIAN_ADMIN_PORT } } },
    bootstrap_extensions: [
      {
        name: "envoy.bootstrap.internal_listener",
        typed_config: {
          "@type": "type.googleapis.com/envoy.extensions.bootstrap.internal_listener.v3.InternalListener",
        },
      },
    ],
    static_resources: { listeners: [health, inbound, ...dials], clusters },
    dynamic_resources: { lds_config: watched(CUSTODIAN_LDS), cds_config: watched(CUSTODIAN_CDS) },
    overload_manager: {
      resource_monitors: [
        {
          name: "envoy.resource_monitors.global_downstream_max_connections",
          typed_config: {
            "@type":
              "type.googleapis.com/envoy.extensions.resource_monitors.downstream_connections.v3.DownstreamConnectionsConfig",
            max_active_downstream_connections: connections.pod,
          },
        },
      ],
    },
  };
}
