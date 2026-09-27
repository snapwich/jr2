// The Custodian (ADR-0059): the jr2-composed container in every Harness pod that holds the pod's
// credentials and carries its traffic out — the Agent's Menu and the ask toward the Orchestrator
// (ADR-0013, ADR-0053), and, when a held secret exists, the Harness's outbound HTTPS.
//
// Its engine is Envoy, the upstream distroless image pinned by digest: jr2 deploys it and never
// builds it (ADR-0038). This module is the jr2 half — everything Envoy is told, and where:
//
//   custodianBootstrap(...)   the static bootstrap `jr2 up` writes into the `jr2-held` ConfigMap:
//                             no admin listener, no xDS, one internal listener per bound host
//   custodianScript(...)      the Lua the bootstrap runs: `custodian.lua`, with a generated table
//                             of names, headers, paths and targets in front — never a value
//   custodianComposition(...) what a Harness pod gains: the Custodian container, its volumes, and
//                             the Harness container's env and mounts. BOTH placements call it —
//                             `kubectlSandbox` per provision, `instanceHarnessObjects` at converge —
//                             so the two pod shapes cannot drift
//
// The Custodian is a separate container from the Harness, and that is the point: the Agent
// executes code in the Harness container and nothing here (ADR-0005). What it holds — the
// Sandbox token and every held secret — is mounted into this container alone, and
// `shareProcessNamespace` stays off, so the Agent cannot read its env, its files or its `/proc`.

import { readFileSync } from "node:fs";
import type { HarnessEnvVar } from "./config.ts";
import {
  CREDENTIAL_HEADERS,
  SANDBOX_TOKEN_NAME,
  standIn,
  type HeldBinding,
  type HeldManifest,
} from "./held-secrets.ts";
import {
  CA_CONFIGMAP,
  CUSTODIAN_CONTROL_PORT,
  CUSTODIAN_HEALTH_PORT,
  CUSTODIAN_PORT,
  HELD_CONFIGMAP,
  HELD_SECRETS_SECRET,
  HELD_TLS_SECRET,
} from "./names.ts";

/**
 * The Custodian's image: Envoy's upstream distroless build, pinned by the digest of its multi-arch
 * index. Deployed, never built (ADR-0038) — jr2 writes Envoy's configuration, not Envoy. The tag
 * rides along for a human reading a pod spec; the digest is what a node pulls. `kitRegistry`
 * re-homes it like a Kit image, and `jr2 kit push` mirrors it (ADR-0044).
 */
export const CUSTODIAN_IMAGE = {
  repo: "envoyproxy/envoy",
  tag: "distroless-v1.39.1",
  digest: "sha256:eb2c01c13125d1629637cb4e4cce7207009fb7cc2c8027f9742758549d15b6f4",
} as const;

/** The Custodian's ref, at its canonical home or re-homed onto a `kitRegistry` mirror — the same
 * two answers `publishedKitRefs` gives a Kit image (ADR-0044). */
export function custodianRef(kitRegistry?: string): string {
  const { repo, tag, digest } = CUSTODIAN_IMAGE;
  const home = kitRegistry ? `${kitRegistry.replace(/\/+$/, "")}/${repo.split("/").pop()}` : `docker.io/${repo}`;
  return `${home}:${tag}@${digest}`;
}

/** Where the Custodian reads what it holds, and how it is told what to do with it. */
export const CUSTODIAN_VALUES = "/etc/jr2/custodian/values";
export const CUSTODIAN_TLS = "/etc/jr2/custodian/tls";
export const CUSTODIAN_CONFIG = "/etc/jr2/custodian/config";
/** The two keys of the `jr2-held` ConfigMap the Custodian reads (beside `held.json`). */
export const CUSTODIAN_BOOTSTRAP_KEY = "envoy.json";
export const CUSTODIAN_SCRIPT_KEY = "custodian.lua";

/** Where the Harness and the Custodian see the `jr2-ca` ConfigMap (ADR-0020). */
export const CA_MOUNT = "/etc/jr2/ca";

/** Envoy's command line: the rendered bootstrap, ONE worker (a pod-local sidecar needs no more,
 * and the start-up line then prints once), and no hot restart — a pod replaces a container, it
 * never hands sockets from one Envoy to the next. */
export const CUSTODIAN_ARGS: readonly string[] = [
  "-c",
  `${CUSTODIAN_CONFIG}/${CUSTODIAN_BOOTSTRAP_KEY}`,
  "--concurrency",
  "1",
  "--disable-hot-restart",
  // The access log is the `jr2.custodian` contract; flushed twice a second, not Envoy's ten.
  "--file-flush-interval-msec",
  "500",
  "--log-level",
  "warning",
];

/** The address the Harness reaches the Custodian's control listener at: its Menu and the ask. */
export const CUSTODIAN_URL = `http://127.0.0.1:${CUSTODIAN_CONTROL_PORT}`;

/** Where the Orchestrator's Service is, from inside a Harness pod. */
export type OrchestratorAddress = { host: string; port: number };

// ---- the bootstrap ------------------------------------------------------------------------------

type Json = Record<string, unknown>;

const HCM = "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager";
const LUA_FILTER = "envoy.filters.http.lua";

/** A stdout access log in the `jr2.custodian key=value` contract (ADR-0059: the `@kind` steps match
 * on it). Names only: never a header value, a body, a path, a query or a Stand-in. `logged` limits it
 * to the requests the script marked, so a CONNECT handed to an intercept listener logs there, once. */
function accessLog(target: string): Json[] {
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
              `jr2.custodian action=%DYNAMIC_METADATA(jr2:action)% target=${target} ` +
              "secret=%DYNAMIC_METADATA(jr2:secret)% reason=%DYNAMIC_METADATA(jr2:reason)% " +
              "method=%REQ(:METHOD)% status=%RESPONSE_CODE%\n",
          },
        },
      },
    },
  ];
}

/** One HTTP connection manager. Every one of them adds nothing to a request and nothing to a
 * response: no `server: envoy`, no `x-request-id`, no `x-forwarded-*`, no `x-envoy-*` (§5.4). */
function hcm(
  prefix: string,
  opts: {
    strictPath?: boolean;
    target: string;
    routes: Json;
    idleSeconds: number;
    lua: boolean;
    upgrade?: boolean;
    local?: Json;
  },
): Json {
  return {
    name: "envoy.filters.network.http_connection_manager",
    typed_config: {
      "@type": HCM,
      stat_prefix: prefix,
      codec_type: "HTTP1",
      server_header_transformation: "PASS_THROUGH",
      generate_request_id: false,
      skip_xff_append: true,
      normalize_path: true,
      merge_slashes: false,
      // Toward a bound host an encoded `/` or `\` is refused (§5.4): a `paths` prefix must not be
      // steppable-around. The control listener keeps it — an Instance ID is one encoded segment.
      // `normalize_path` reads a bare `\` as `/` and `..;` as `..`, so the upstream gets the path
      // the prefix was checked against, whatever IIS or Tomcat would read.
      path_with_escaped_slashes_action: opts.strictPath ? "REJECT_REQUEST" : "KEEP_UNCHANGED",
      request_headers_timeout: "60s",
      stream_idle_timeout: `${opts.idleSeconds}s`,
      common_http_protocol_options: { idle_timeout: "3600s" },
      ...(opts.upgrade ? { upgrade_configs: [{ upgrade_type: "CONNECT" }] } : {}),
      access_log: accessLog(opts.target),
      ...(opts.local ? { local_reply_config: opts.local } : {}),
      http_filters: [
        ...(opts.lua
          ? [
              {
                name: LUA_FILTER,
                typed_config: {
                  "@type": "type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua",
                  default_source_code: { filename: `${CUSTODIAN_CONFIG}/${CUSTODIAN_SCRIPT_KEY}` },
                  // The route the request arrived on is the route it leaves by: the ask's rewrite
                  // to this pod's Sandbox must not be routed again (it would find no route). The
                  // one re-route the script wants — a normalized CONNECT target — it asks for.
                  clear_route_cache: false,
                },
              },
            ]
          : []),
        {
          name: "envoy.filters.http.router",
          typed_config: {
            "@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router",
            suppress_envoy_headers: true,
          },
        },
      ],
      route_config: {
        request_headers_to_remove: ["x-forwarded-proto", "x-forwarded-for", "x-request-id", "x-envoy-internal"],
        response_headers_to_remove: ["x-envoy-upstream-service-time"],
        ...opts.routes,
      },
    },
  };
}

/** Route metadata the script reads its role and target from. */
function meta(fields: Record<string, string>): Json {
  return { filter_metadata: { [LUA_FILTER]: fields } };
}

/** An upstream that never answered, said as the Custodian's own 502 (§5.4) — the host and Envoy's
 * reason, never a retry without verification. */
function unreachable(target: string): Json {
  return {
    mappers: [
      {
        filter: { response_flag_filter: { flags: ["UF", "URX", "UH", "DF", "DPE", "UMSDR"] } },
        status_code: 502,
        body_format_override: {
          text_format_source: {
            inline_string: `jr2 custodian: ${target} could not be reached: %RESPONSE_CODE_DETAILS% %UPSTREAM_TRANSPORT_FAILURE_REASON%\n`,
          },
        },
      },
    ],
  };
}

/** The Orchestrator unreachable, said so the Harness can tell it from an answer and retry the
 * surface read the way ADR-0042 asks — the one route on this pod that retries. */
const ORCHESTRATOR_UNREACHABLE: Json = {
  mappers: [
    {
      filter: { response_flag_filter: { flags: ["UF", "URX", "UH", "DF", "DPE", "UMSDR"] } },
      status_code: 502,
      headers_to_add: [
        { header: { key: "x-jr2-custodian", value: "unreachable" }, append_action: "OVERWRITE_IF_EXISTS_OR_ADD" },
      ],
      body_format_override: {
        json_format: {
          error: "the Orchestrator never answered through the Custodian",
          detail: "%RESPONSE_CODE_DETAILS% %UPSTREAM_TRANSPORT_FAILURE_REASON%",
          flags: "%RESPONSE_FLAGS%",
        },
      },
    },
  ],
};

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

/** The dial guard, by resolved address: an RBAC filter after the dynamic forward proxy, on the
 * address that filter saved. A bound target never resolves here, so it never matches. */
function resolvedGuard(): Json {
  return {
    name: "envoy.filters.http.rbac",
    typed_config: {
      "@type": "type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBAC",
      rules: {
        action: "DENY",
        policies: {
          guard: {
            permissions: GUARDED_RANGES.map(([address_prefix, prefix_len]) => ({
              matcher: {
                name: "envoy.rbac.matchers.upstream_ip_port",
                typed_config: {
                  "@type":
                    "type.googleapis.com/envoy.extensions.rbac.matchers.upstream_ip_port.v3.UpstreamIpPortMatcher",
                  upstream_ip: { address_prefix, prefix_len },
                },
              },
            })),
            principals: [{ any: true }],
          },
        },
      },
    },
  };
}

/** The egress listener's own replies. The guard's refusal by resolved address is the one 403 of
 * a request the script let through as a tunnel, so it is said the way the script says a refusal by
 * spelling; the script's own refusals carry their own bodies and are left alone. */
function egressReplies(): Json {
  return {
    mappers: [
      {
        filter: {
          and_filter: {
            filters: [
              {
                status_code_filter: {
                  comparison: { op: "EQ", value: { default_value: 403, runtime_key: "jr2.guard" } },
                },
              },
              {
                metadata_filter: {
                  matcher: { filter: "jr2", path: [{ key: "action" }], value: { string_match: { exact: "tunnel" } } },
                },
              },
            ],
          },
        },
        body_format_override: {
          text_format_source: {
            inline_string:
              "jr2 custodian: %REQ(:AUTHORITY)% resolves to a loopback, link-local or unspecified address\n",
          },
        },
      },
      ...(unreachable("%REQ(:AUTHORITY)%").mappers as Json[]),
    ],
  };
}

/** Every bound target, in manifest order, with the secrets bound to it. */
function targetsOf(
  manifest: HeldManifest,
): Array<{ key: string; host: string; port: number; leaf: string; secrets: HeldBinding[] }> {
  const byKey = new Map<string, { key: string; host: string; port: number; leaf: string; secrets: HeldBinding[] }>();
  for (const secret of manifest.secrets) {
    for (const h of secret.hosts) {
      const key = `${authorityHost(h.host)}:${h.port}`;
      const entry = byKey.get(key) ?? { key, host: h.host, port: h.port, leaf: h.leaf, secrets: [] };
      entry.secrets.push(secret);
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

/** A host as a CONNECT target spells it: an IPv6 literal in brackets. */
function authorityHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

/**
 * The Custodian's static bootstrap (ADR-0059): Envoy's whole configuration, rendered once per
 * converge by `jr2 up`, identical for every Harness pod of the Instance.
 *
 *   control   127.0.0.1:8081   the Menu and the ask, plain HTTP, to the Orchestrator's Service —
 *                              three routes and nothing else, each swapping the Sandbox token's
 *                              Stand-in for the token (ADR-0013, ADR-0053)
 *   health    0.0.0.0:15021    GET /healthz, for the kubelet, which cannot reach loopback
 *   egress    127.0.0.1:15001  CONNECT only — present when a held secret exists; a bound target
 *                              goes to its intercept listener, every other one is tunneled
 *   intercept (internal)       one per bound target: TLS ended with that target's leaf, the swap,
 *                              then Envoy's own verified TLS to the target
 */
export function custodianBootstrap(manifest: HeldManifest, orchestrator: OrchestratorAddress): Json {
  const targets = targetsOf(manifest);
  const orchestratorTarget = `${orchestrator.host}:${orchestrator.port}`;
  const route = (name: string, method: string, regex: string, extra: Json = {}): Json => ({
    name,
    match: { safe_regex: { regex }, headers: [{ name: ":method", string_match: { exact: method } }] },
    route: { cluster: "orchestrator", timeout: "0s", auto_host_rewrite: true, ...extra },
    metadata: meta({ role: "control", route: name }),
  });

  const listeners: Json[] = [
    {
      name: "control",
      address: { socket_address: { address: "127.0.0.1", port_value: CUSTODIAN_CONTROL_PORT } },
      filter_chains: [
        {
          filters: [
            hcm("control", {
              target: orchestratorTarget,
              idleSeconds: 3600,
              lua: true,
              local: ORCHESTRATOR_UNREACHABLE,
              routes: {
                virtual_hosts: [
                  {
                    name: "orchestrator",
                    domains: ["*"],
                    routes: [
                      route("surface", "GET", "/agents/[^/]+/surface"),
                      route("events", "POST", "/agents/[^/]+/events"),
                      route("fetch", "POST", "/fetch"),
                      {
                        name: "deny",
                        match: { prefix: "/" },
                        direct_response: { status: 404 },
                        metadata: meta({ role: "deny" }),
                      },
                    ],
                  },
                ],
              },
            }),
          ],
        },
      ],
    },
    {
      name: "health",
      address: { socket_address: { address: "0.0.0.0", port_value: CUSTODIAN_HEALTH_PORT } },
      filter_chains: [
        {
          filters: [
            hcm("health", {
              target: "health",
              idleSeconds: 60,
              lua: true,
              routes: {
                virtual_hosts: [
                  {
                    name: "health",
                    domains: ["*"],
                    routes: [
                      {
                        match: { path: "/healthz", headers: [{ name: ":method", string_match: { exact: "GET" } }] },
                        direct_response: { status: 404 },
                        metadata: meta({ role: "health" }),
                      },
                      { match: { prefix: "/" }, direct_response: { status: 404 } },
                    ],
                  },
                ],
              },
            }),
          ],
        },
      ],
    },
  ];

  const clusters: Json[] = [
    {
      name: "orchestrator",
      type: "LOGICAL_DNS",
      dns_lookup_family: "V4_PREFERRED",
      connect_timeout: "5s",
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
  ];

  if (targets.length > 0) {
    listeners.push({
      name: "egress",
      address: { socket_address: { address: "127.0.0.1", port_value: CUSTODIAN_PORT } },
      filter_chains: [
        {
          filters: [
            hcm("egress", {
              target: "%REQ(:AUTHORITY)%",
              idleSeconds: 3600,
              lua: true,
              upgrade: true,
              local: egressReplies(),
              routes: {
                virtual_hosts: [
                  ...targets.map((t) => ({
                    name: `intercept-${t.leaf}`,
                    domains: [t.key],
                    routes: [
                      {
                        match: { connect_matcher: {} },
                        route: {
                          cluster: `intercept-${t.leaf}`,
                          timeout: "0s",
                          upgrade_configs: [{ upgrade_type: "CONNECT", connect_config: {} }],
                        },
                        metadata: meta({ role: "egress" }),
                      },
                      { match: { prefix: "/" }, direct_response: { status: 405 }, metadata: meta({ role: "egress" }) },
                    ],
                  })),
                  {
                    name: "tunnel",
                    domains: ["*"],
                    routes: [
                      {
                        match: { connect_matcher: {} },
                        route: {
                          cluster: "tunnel",
                          timeout: "0s",
                          upgrade_configs: [{ upgrade_type: "CONNECT", connect_config: {} }],
                        },
                        metadata: meta({ role: "egress" }),
                      },
                      { match: { prefix: "/" }, direct_response: { status: 405 }, metadata: meta({ role: "egress" }) },
                    ],
                  },
                ],
              },
            }),
          ],
        },
      ],
    });
    for (const t of targets) {
      listeners.push({
        name: `intercept-${t.leaf}`,
        internal_listener: {},
        filter_chains: [
          {
            transport_socket: {
              name: "envoy.transport_sockets.tls",
              typed_config: {
                "@type": "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext",
                common_tls_context: {
                  // HTTP/1.1 alone, in every branch: SSE rides it, and one downstream protocol
                  // keeps the behaviour the same whatever engine carries it.
                  alpn_protocols: ["http/1.1"],
                  tls_certificates: [
                    {
                      certificate_chain: { filename: `${CUSTODIAN_TLS}/${t.leaf}.crt` },
                      private_key: { filename: `${CUSTODIAN_TLS}/${t.leaf}.key` },
                    },
                  ],
                },
              },
            },
            filters: [
              hcm(`intercept-${t.leaf}`, {
                strictPath: true,
                target: t.key,
                idleSeconds: 3600,
                lua: true,
                local: unreachable(t.key),
                routes: {
                  virtual_hosts: [
                    {
                      name: t.leaf,
                      domains: ["*"],
                      routes: [
                        {
                          match: { prefix: "/" },
                          route: { cluster: `upstream-${t.leaf}`, timeout: "0s" },
                          metadata: meta({ role: "intercept", target: t.key }),
                        },
                      ],
                    },
                  ],
                },
              }),
            ],
          },
        ],
      });
      clusters.push(
        {
          name: `intercept-${t.leaf}`,
          load_assignment: {
            cluster_name: `intercept-${t.leaf}`,
            endpoints: [
              {
                lb_endpoints: [
                  {
                    endpoint: { address: { envoy_internal_address: { server_listener_name: `intercept-${t.leaf}` } } },
                  },
                ],
              },
            ],
          },
        },
        {
          name: `upstream-${t.leaf}`,
          type: isIpLiteral(t.host) ? "STATIC" : "LOGICAL_DNS",
          dns_lookup_family: "V4_PREFERRED",
          connect_timeout: "30s",
          load_assignment: {
            cluster_name: `upstream-${t.leaf}`,
            endpoints: [
              {
                lb_endpoints: [{ endpoint: { address: { socket_address: { address: t.host, port_value: t.port } } } }],
              },
            ],
          },
          transport_socket: {
            name: "envoy.transport_sockets.tls",
            typed_config: {
              "@type": "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext",
              ...(isIpLiteral(t.host) ? {} : { sni: t.host }),
              common_tls_context: {
                validation_context: {
                  // Roots + the user's caBundle, and NEVER the jr2 CA: the Custodian must not accept
                  // one of its own leaves from upstream (§4.4).
                  trusted_ca: { filename: `${CA_MOUNT}/upstream.crt` },
                  match_typed_subject_alt_names: [
                    { san_type: isIpLiteral(t.host) ? "IP_ADDRESS" : "DNS", matcher: { exact: t.host } },
                  ],
                },
              },
            },
          },
        },
      );
    }
    clusters.push({
      name: "tunnel",
      lb_policy: "CLUSTER_PROVIDED",
      connect_timeout: "30s",
      cluster_type: {
        name: "envoy.clusters.dynamic_forward_proxy",
        typed_config: {
          "@type": "type.googleapis.com/envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig",
          dns_cache_config: { name: "tunnel", dns_lookup_family: "V4_PREFERRED" },
        },
      },
    });
    // The dynamic forward proxy filter resolves the CONNECT target for the tunnel cluster; it sits
    // after the script so a refused target is never resolved at all. It saves the address it
    // resolved, and the dial guard's second half judges THAT address, so a name that resolves to a
    // guarded address is refused like the literal (ADR-0059).
    const egress = listeners.find((l) => l.name === "egress") as {
      filter_chains: Array<{ filters: Array<{ typed_config: { http_filters: Json[] } }> }>;
    };
    const filters = egress.filter_chains[0]!.filters[0]!.typed_config.http_filters;
    filters.splice(
      filters.length - 1,
      0,
      {
        name: "envoy.filters.http.dynamic_forward_proxy",
        typed_config: {
          "@type": "type.googleapis.com/envoy.extensions.filters.http.dynamic_forward_proxy.v3.FilterConfig",
          dns_cache_config: { name: "tunnel", dns_lookup_family: "V4_PREFERRED" },
          save_upstream_address: true,
        },
      },
      resolvedGuard(),
    );
  }

  return {
    // No admin listener and no xDS: nothing in the pod can reconfigure this, or read it back.
    node: { id: "jr2-custodian", cluster: "jr2-custodian" },
    bootstrap_extensions: [
      {
        name: "envoy.bootstrap.internal_listener",
        typed_config: {
          "@type": "type.googleapis.com/envoy.extensions.bootstrap.internal_listener.v3.InternalListener",
        },
      },
    ],
    static_resources: { listeners, clusters },
    // A single-writer sidecar: one worker, so the start-up line prints once.
    overload_manager: {
      resource_monitors: [
        {
          name: "envoy.resource_monitors.global_downstream_max_connections",
          typed_config: {
            "@type":
              "type.googleapis.com/envoy.extensions.resource_monitors.downstream_connections.v3.DownstreamConnectionsConfig",
            max_active_downstream_connections: 4096,
          },
        },
      ],
    },
  };
}

// ---- the script ---------------------------------------------------------------------------------

/** `custodian.lua` beside this module — the fixed half of the script. */
const SCRIPT = readFileSync(new URL("./custodian.lua", import.meta.url), "utf8");

/** A Lua string literal. Every string that reaches here passed `heldSecretsOf`'s rules (names,
 * header tokens, printable paths), so escaping the two characters Lua gives meaning to is enough. */
function lua(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function luaList(values: readonly string[]): string {
  return `{ ${values.map(lua).join(", ")} }`;
}

/**
 * The script the Custodian runs: a generated `HELD` table in front of `custodian.lua`. The table
 * names every secret this pod holds — the Sandbox token first, then the manifest's — with the
 * headers and paths each may ride and the targets each is bound to. It never holds a value: the
 * script reads those from the mounted files at start.
 */
export function custodianScript(manifest: HeldManifest): string {
  const lines = [
    "-- Generated by `jr2 up` from held.json (ADR-0059). Names, headers, paths, targets; never a value.",
    `HELD = { secrets = {}, targets = {}, hosts = ${targetsOf(manifest).length} }`,
    `HELD.credential = ${luaList(CREDENTIAL_HEADERS)}`,
    `HELD.secrets[1] = { name = ${lua(SANDBOX_TOKEN_NAME)}, headers = { "authorization" } }`,
    "HELD.control = { HELD.secrets[1] }",
  ];
  manifest.secrets.forEach((s, i) => {
    const paths = s.paths ? `, paths = ${luaList(s.paths)}` : "";
    lines.push(`HELD.secrets[${i + 2}] = { name = ${lua(s.name)}, headers = ${luaList(s.headers)}${paths} }`);
  });
  for (const t of targetsOf(manifest)) {
    const refs = t.secrets.map((s) => `HELD.secrets[${manifest.secrets.indexOf(s) + 2}]`);
    lines.push(`HELD.targets[${lua(t.key)}] = { ${refs.join(", ")} }`);
  }
  return `${lines.join("\n")}\n\n${SCRIPT}`;
}

// ---- the composition ----------------------------------------------------------------------------

export type CustodianCompositionOptions = {
  /** The Custodian's resolved ref (`custodianRef`, from the image map). */
  image: string;
  /** Where the Sandbox token lives: a Sandbox's `<name>-token` Secret, or the Instance Harness's key
   * of `jr2-instance`. Mounted into the Custodian alone (ADR-0013). */
  token: { secret: string; key: string };
  /** This pod's Sandbox — the name the ask is addressed by (ADR-0053). Absent on the Instance
   * Harness, which mounts no Repo and answers an ask by saying so. */
  sandbox?: string;
  /** The Instance ships a `harness.caBundle` (ADR-0020). */
  caBundle: boolean;
};

type Container = Record<string, unknown>;
type Volume = Record<string, unknown>;
type VolumeMount = { name: string; mountPath: string; readOnly?: boolean };

/** What one Harness pod gains from the Custodian. */
export type CustodianComposition = {
  /** The Harness container's env — in `env`, after `harness.env`, before the wire's gate (§5.1). In
   * Kubernetes `env` wins over `envFrom`, so a Stand-in overrides a same-named key of any `envFrom`
   * Secret, even one that changes after the converge. */
  harnessEnv: HarnessEnvVar[];
  harnessMounts: VolumeMount[];
  custodianContainer: Container;
  volumes: Volume[];
};

/** The isolation baseline, stated by the Custodian itself rather than left to the operator's
 * default: the image is not jr2's, and a read-only root is a claim only the seat can make. */
const CUSTODIAN_SECURITY = {
  runAsNonRoot: true,
  readOnlyRootFilesystem: true,
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
  seccompProfile: { type: "RuntimeDefault" },
};

/**
 * The Custodian in one Harness pod, and what the Harness container gets from it (ADR-0059). Called
 * by BOTH placements, so a Sandbox and the Instance Harness cannot differ in what they hold.
 *
 * The Custodian is ALWAYS here: it carries the Menu and the ask, which every Harness pod needs
 * (ADR-0013). The egress half — `HTTPS_PROXY`, the trust bundles, the leaves — joins it only when
 * the manifest holds a secret, and with none the Harness's HTTPS goes direct, as it always did.
 */
export function custodianComposition(manifest: HeldManifest, opts: CustodianCompositionOptions): CustodianComposition {
  const held = manifest.secrets.length > 0;
  const literal = manifest.secrets.filter((s) => s.source.kind === "literal").map((s) => s.name);

  const harnessEnv: HarnessEnvVar[] = [
    { name: "JR2_CUSTODIAN_URL", value: CUSTODIAN_URL },
    { name: SANDBOX_TOKEN_NAME, value: standIn(SANDBOX_TOKEN_NAME) },
  ];
  if (held) {
    const proxy = `http://127.0.0.1:${CUSTODIAN_PORT}`;
    const noProxy = "localhost,127.0.0.1,::1";
    harnessEnv.push(
      ...manifest.secrets.map((s) => ({ name: s.name, value: standIn(s.name) })),
      { name: "HTTPS_PROXY", value: proxy },
      { name: "https_proxy", value: proxy },
      { name: "NO_PROXY", value: noProxy },
      { name: "no_proxy", value: noProxy },
      { name: "NODE_USE_ENV_PROXY", value: "1" },
      { name: "NODE_EXTRA_CA_CERTS", value: `${CA_MOUNT}/extra.crt` },
      { name: "SSL_CERT_FILE", value: `${CA_MOUNT}/bundle.crt` },
      { name: "REQUESTS_CA_BUNDLE", value: `${CA_MOUNT}/bundle.crt` },
      { name: "GIT_SSL_CAINFO", value: `${CA_MOUNT}/bundle.crt` },
    );
  } else if (opts.caBundle) {
    harnessEnv.push({ name: "NODE_EXTRA_CA_CERTS", value: `${CA_MOUNT}/ca.crt` });
  }

  const trust = held || opts.caBundle;
  const volumes: Volume[] = [
    {
      name: "custodian-values",
      projected: {
        // Group-readable, for the pod's fsGroup: the Custodian runs as Envoy's own uid.
        defaultMode: 0o440,
        sources: [
          { secret: { name: opts.token.secret, items: [{ key: opts.token.key, path: SANDBOX_TOKEN_NAME }] } },
          ...(literal.length
            ? [{ secret: { name: HELD_SECRETS_SECRET, items: literal.map((n) => ({ key: n, path: n })) } }]
            : []),
          ...manifest.secrets.flatMap((s) =>
            s.source.kind === "secret"
              ? [{ secret: { name: s.source.secret, items: [{ key: s.source.key, path: s.name }] } }]
              : [],
          ),
        ],
      },
    },
    { name: "custodian-config", configMap: { name: HELD_CONFIGMAP } },
    ...(held
      ? [
          { name: "custodian-tls", secret: { secretName: HELD_TLS_SECRET, defaultMode: 0o440 } },
          {
            name: "custodian-trust",
            configMap: { name: CA_CONFIGMAP, items: [{ key: "upstream.crt", path: "upstream.crt" }] },
          },
        ]
      : []),
    ...(trust ? [{ name: "ca", configMap: { name: CA_CONFIGMAP } }] : []),
  ];

  const custodianContainer: Container = {
    name: "custodian",
    image: opts.image,
    imagePullPolicy: "IfNotPresent",
    args: CUSTODIAN_ARGS,
    // Non-secret settings only: never a value in env.
    ...(opts.sandbox !== undefined ? { env: [{ name: "JR2_SANDBOX", value: opts.sandbox }] } : {}),
    volumeMounts: [
      { name: "custodian-values", mountPath: CUSTODIAN_VALUES, readOnly: true },
      { name: "custodian-config", mountPath: CUSTODIAN_CONFIG, readOnly: true },
      ...(held
        ? [
            { name: "custodian-tls", mountPath: CUSTODIAN_TLS, readOnly: true },
            { name: "custodian-trust", mountPath: CA_MOUNT, readOnly: true },
          ]
        : []),
    ],
    // The kubelet probes the pod IP and cannot reach a loopback listener, and a distroless image
    // has no shell for an exec probe — so the health listener exists. Pod Ready needs it, and the
    // operator holds the Sandbox's Ready on pod Ready: no Turn is admitted before this serves.
    readinessProbe: {
      httpGet: { path: "/healthz", port: CUSTODIAN_HEALTH_PORT },
      initialDelaySeconds: 1,
      periodSeconds: 2,
      failureThreshold: 15,
    },
    securityContext: CUSTODIAN_SECURITY,
  };

  return {
    harnessEnv,
    harnessMounts: trust ? [{ name: "ca", mountPath: CA_MOUNT, readOnly: true }] : [],
    custodianContainer,
    volumes,
  };
}
