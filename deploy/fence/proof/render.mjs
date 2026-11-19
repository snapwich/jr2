#!/usr/bin/env node
// The M1 proof of the Fence (ADR-0084): it writes the Kubernetes objects of one proof Instance to stdout, as YAML
// (JSON documents, which kubectl reads as YAML). A test fixture of this repo, not jr2 code: `jr2 up` makes the real
// objects. The proof pods have only the postures that jr2 gives a pod, with no NET_ADMIN and no privilege.
//
//   render.mjs custodian --ns <ns> --range <k> --live <i,j,...> --nodes <node,...>
//       the slot NADs (0..127) and the trunk NAD, the Custodian's ConfigMaps (uplink, Envoy, resolver) and its
//       DaemonSet on the named nodes. A live slot has rules: an Envoy listener on 20000+i and a resolver on 25000+i.
//   render.mjs sandbox --ns <ns> --slot <i> --range <k> --node <node> [--http-probe] [--window]
//       one Sandbox pod on slot i, whose only network is the Fence.
//
// The Egress list of each live slot: example.com (443 and 80); slot 4 also has example.org. So slot 4 has a
// placeholder (198.18.0.3) that the other slots did not get.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEGMENT_BASE = [198, 19, 0, 0];
const SLOTS = 128;
const ENVOY =
  "docker.io/envoyproxy/envoy:distroless-v1.39.1@sha256:eb2c01c13125d1629637cb4e4cce7207009fb7cc2c8027f9742758549d15b6f4";
const COREDNS = "registry.k8s.io/coredns/coredns:v1.14.2";
const PROOF = "jr2-fence-proof:1";
const JR2_NAME = "custodian.jr2.internal";

function args() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = { cmd };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i].replace(/^--/, "");
    if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) o[k] = rest[++i];
    else o[k] = true;
  }
  return o;
}

const vlan = (k, i) => 2 + 128 * k + i;
function addr(v) {
  const n = ((SEGMENT_BASE[0] << 24) | (SEGMENT_BASE[1] << 16) | (SEGMENT_BASE[2] << 8) | SEGMENT_BASE[3]) + v;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}
const GW = addr(1);
const mac = (v) =>
  `02:00:c6:13:${((v >> 8) & 255).toString(16).padStart(2, "0")}:${(v & 255).toString(16).padStart(2, "0")}`;

function egressOf(slot) {
  const names = ["example.com"];
  if (slot === 4) names.push("example.org");
  return names.map((name, j) => ({ name, placeholder: `198.18.0.${2 + j}` }));
}

function nad(ns, name, config) {
  return {
    apiVersion: "k8s.cni.cncf.io/v1",
    kind: "NetworkAttachmentDefinition",
    metadata: { name, namespace: ns, labels: { "jr2.dev/fence-proof": "true" } },
    spec: { config: JSON.stringify(config) },
  };
}

function slotNad(ns, k, i) {
  const v = vlan(k, i);
  return nad(ns, `jr2-fence-${i}`, {
    cniVersion: "1.0.0",
    name: `jr2-fence-${i}`,
    plugins: [
      {
        type: "bridge",
        bridge: "jr2fence0",
        isGateway: false,
        isDefaultGateway: false,
        ipMasq: false,
        hairpinMode: false,
        portIsolation: true,
        mtu: 1500,
        vlan: v,
        args: { cni: { mac: mac(v) } },
        ipam: {
          type: "static",
          addresses: [{ address: `${addr(v)}/20`, gateway: GW }],
          routes: [{ dst: "0.0.0.0/0", gw: GW }],
        },
      },
    ],
  });
}

function trunkNad(ns, k) {
  const sysctl = {};
  for (const dev of ["all", "default", "net1"]) {
    sysctl[`net.ipv4.conf.${dev}.forwarding`] = "0";
    sysctl[`net.ipv6.conf.${dev}.disable_ipv6`] = "1";
    sysctl[`net.ipv4.conf.${dev}.rp_filter`] = "1";
    sysctl[`net.ipv4.conf.${dev}.arp_ignore`] = "1";
  }
  return nad(ns, "jr2-fence-uplink", {
    cniVersion: "1.0.0",
    name: "jr2-fence-uplink",
    plugins: [
      {
        type: "bridge",
        bridge: "jr2fence0",
        isGateway: false,
        isDefaultGateway: false,
        ipMasq: false,
        hairpinMode: false,
        portIsolation: false,
        mtu: 1500,
        // With vlanTrunk and no vlan, the stock bridge plugin v1.10.0 adds VID 1 (PVID, untagged) to the trunk port,
        // so the trunks of two Instances on one node share VLAN 1. With vlan = the first VLAN of the range, the plugin
        // first adds that VID as PVID, then adds the whole range as tagged VIDs, which replaces the flags of that
        // VID. The port then has exactly the range, tagged, and no PVID: the bridge drops each untagged frame from
        // the trunk. M1 reads `bridge vlan show` to check it.
        vlan: vlan(k, 0),
        preserveDefaultVlan: false,
        vlanTrunk: [{ minID: vlan(k, 0), maxID: vlan(k, SLOTS - 1) }],
      },
      { type: "tuning", sysctl },
    ],
  });
}

// --- Envoy: one listener for each live slot, on 20000+i --------------------------------------------------------
const TLS_ALERT = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x31]).toString("base64"); // fatal access_denied
const text = (reason) => ({
  name: "envoy.filters.network.direct_response",
  typed_config: {
    "@type": "type.googleapis.com/envoy.extensions.filters.network.direct_response.v3.Config",
    response: { inline_string: `jr2 custodian: refused: ${reason}\n` },
  },
});
const alert = {
  name: "envoy.filters.network.direct_response",
  typed_config: {
    "@type": "type.googleapis.com/envoy.extensions.filters.network.direct_response.v3.Config",
    response: { inline_bytes: TLS_ALERT },
  },
};
const tcpProxy = (cluster) => ({
  name: "envoy.filters.network.tcp_proxy",
  typed_config: {
    "@type": "type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy",
    stat_prefix: "tunnel",
    cluster,
    idle_timeout: "3600s",
  },
});
function http(slot, virtualHosts) {
  return {
    name: "envoy.filters.network.http_connection_manager",
    typed_config: {
      "@type": "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager",
      stat_prefix: `slot${slot}_http`,
      route_config: {
        virtual_hosts: [
          ...virtualHosts,
          {
            name: "refused",
            domains: ["*"],
            routes: [
              {
                match: { prefix: "/" },
                direct_response: {
                  status: 403,
                  body: { inline_string: "jr2 custodian: refused: the Host header does not name the dialed host\n" },
                },
                response_headers_to_add: [{ header: { key: "x-jr2-custodian", value: "refused" } }],
              },
            ],
          },
        ],
      },
      http_filters: [
        {
          name: "envoy.filters.http.router",
          typed_config: { "@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router" },
        },
      ],
    },
  };
}
const ip32 = (a) => [{ address_prefix: a, prefix_len: 32 }];

function slotListener(i, k) {
  const chains = [];
  const vhosts = [];
  for (const { name, placeholder } of egressOf(i)) {
    chains.push({
      name: `${name}:443/tls`,
      filter_chain_match: {
        prefix_ranges: ip32(placeholder),
        destination_port: 443,
        transport_protocol: "tls",
        server_names: [name],
      },
      filters: [tcpProxy(`up|${name}|443`)],
    });
    chains.push({
      name: `${name}:443/refused-sni`,
      filter_chain_match: { prefix_ranges: ip32(placeholder), destination_port: 443, transport_protocol: "tls" },
      filters: [alert],
    });
    chains.push({
      name: `${name}:443/refused-not-tls`,
      filter_chain_match: { prefix_ranges: ip32(placeholder), destination_port: 443 },
      filters: [text(`port 443 of ${name} takes TLS only`)],
    });
    chains.push({
      name: `${name}:80/http`,
      filter_chain_match: { prefix_ranges: ip32(placeholder), destination_port: 80 },
      filters: [
        http(i, [
          {
            name,
            domains: [name, `${name}:80`],
            routes: [{ match: { prefix: "/" }, route: { cluster: `up|${name}|80` } }],
          },
        ]),
      ],
    });
  }
  // The catch-alls of each used port, then the default chains.
  chains.push({
    name: "refused-443-tls",
    filter_chain_match: { destination_port: 443, transport_protocol: "tls" },
    filters: [alert],
  });
  chains.push({
    name: "refused-443",
    filter_chain_match: { destination_port: 443 },
    filters: [text("no entry permits this address")],
  });
  chains.push({ name: "refused-80", filter_chain_match: { destination_port: 80 }, filters: [http(i, [])] });
  chains.push({ name: "refused-tls", filter_chain_match: { transport_protocol: "tls" }, filters: [alert] });
  return {
    name: `slot-${i}`,
    address: { socket_address: { address: "0.0.0.0", port_value: 20000 + i } },
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
    listener_filters_timeout: "2s",
    continue_on_listener_filters_timeout: true,
    access_log: [
      {
        name: "envoy.access_loggers.stdout",
        typed_config: {
          "@type": "type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog",
          log_format: {
            text_format_source: {
              inline_string: `jr2.custodian slot=${i} vlan=${vlan(k, i)} chain=%FILTER_CHAIN_NAME% from=%DOWNSTREAM_REMOTE_ADDRESS% to=%DOWNSTREAM_LOCAL_ADDRESS% sni=%REQUESTED_SERVER_NAME% flags=%RESPONSE_FLAGS% rx=%BYTES_RECEIVED% tx=%BYTES_SENT%\n`,
            },
          },
        },
      },
    ],
    filter_chains: chains,
    default_filter_chain: { name: "refused-default", filters: [text("no entry permits this address and port")] },
  };
}

function upstream(name, port) {
  return {
    name: `up|${name}|${port}`,
    type: "LOGICAL_DNS",
    dns_lookup_family: "V4_ONLY",
    connect_timeout: "5s",
    load_assignment: {
      cluster_name: `up|${name}|${port}`,
      endpoints: [
        { lb_endpoints: [{ endpoint: { address: { socket_address: { address: name, port_value: port } } } }] },
      ],
    },
  };
}

function envoyConfig(live, k) {
  const names = [...new Set(live.flatMap((i) => egressOf(i).map((e) => e.name)))];
  return {
    admin: { address: { socket_address: { address: "127.0.0.1", port_value: 15000 } } },
    static_resources: {
      listeners: [
        {
          name: "health",
          address: { socket_address: { address: "0.0.0.0", port_value: 15021 } },
          filter_chains: [
            {
              filters: [
                {
                  name: "envoy.filters.network.http_connection_manager",
                  typed_config: {
                    "@type":
                      "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager",
                    stat_prefix: "health",
                    route_config: {
                      virtual_hosts: [
                        {
                          name: "health",
                          domains: ["*"],
                          routes: [
                            {
                              match: { prefix: "/" },
                              direct_response: { status: 200, body: { inline_string: "ok\n" } },
                            },
                          ],
                        },
                      ],
                    },
                    http_filters: [
                      {
                        name: "envoy.filters.http.router",
                        typed_config: { "@type": "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router" },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
        ...live.map((i) => slotListener(i, k)),
      ],
      clusters: names.flatMap((n) => [upstream(n, 443), upstream(n, 80)]),
    },
  };
}

// --- The resolver: r6's CoreDNS form, one server block for each live slot, on 25000+i --------------------------
const re = (name) => "^" + name.replace(/\./g, "[.]") + "[.]$";
function corefile(live) {
  const soa = `${JR2_NAME}. hostmaster.${JR2_NAME}. 1 60 60 60 60`;
  const blocks = live.map((i) => {
    const entries = [{ name: JR2_NAME, placeholder: "198.18.0.1" }, ...egressOf(i)];
    const t = entries.flatMap(({ name, placeholder }) => [
      `  template IN A ${name} {\n    match "${re(name)}"\n    answer "{{ .Name }} 60 IN A ${placeholder}"\n    fallthrough\n  }`,
      `  template ANY ANY ${name} {\n    match "${re(name)}"\n    rcode NOERROR\n    authority "${name}. 60 IN SOA ${soa}"\n    fallthrough\n  }`,
    ]);
    return [
      `.:${25000 + i} {`,
      `  log . "jr2.custodian dns slot=${i} from={remote} {type} {name} rcode={rcode}"`,
      "  errors",
      ...t,
      `  template ANY ANY {\n    rcode NXDOMAIN\n    authority ". 60 IN SOA ${soa}"\n  }`,
      "}",
    ].join("\n");
  });
  // CoreDNS needs one server block; with no live slot it serves a refusal on the loopback only.
  if (blocks.length === 0) blocks.push(`.:25999 {\n  bind 127.0.0.1\n  template ANY ANY {\n    rcode REFUSED\n  }\n}`);
  return blocks.join("\n") + "\n";
}

function configMap(ns, name, data) {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name, namespace: ns, labels: { "jr2.dev/fence-proof": "true" } },
    data,
  };
}

const none = { drop: ["ALL"] };

function custodian(o) {
  const ns = o.ns;
  const k = Number(o.range);
  const live = o.live && o.live !== true ? String(o.live).split(",").map(Number) : [];
  const nodes = String(o.nodes).split(",");
  const docs = [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: ns, labels: { "jr2.dev/fence-proof": "true" } } },
  ];
  for (let i = 0; i < SLOTS; i++) docs.push(slotNad(ns, k, i));
  docs.push(trunkNad(ns, k));
  docs.push(
    configMap(ns, "jr2-custodian-uplink", { "uplink.sh": readFileSync(join(HERE, "..", "uplink.sh"), "utf8") }),
  );
  docs.push(configMap(ns, "jr2-custodian-envoy", { "envoy.yaml": JSON.stringify(envoyConfig(live, k), null, 1) }));
  docs.push(configMap(ns, "jr2-custodian-dns", { Corefile: corefile(live) }));
  docs.push({
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: { name: "jr2-custodian", namespace: ns, labels: { "jr2.dev/fence-proof": "true" } },
    spec: {
      selector: { matchLabels: { app: "jr2-custodian" } },
      updateStrategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: "100%" } },
      template: {
        metadata: {
          labels: { app: "jr2-custodian" },
          annotations: {
            "k8s.v1.cni.cncf.io/networks": JSON.stringify([{ name: "jr2-fence-uplink", interface: "net1" }]),
            "jr2.dev/live": live.join(","),
          },
        },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 1,
          affinity: {
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                nodeSelectorTerms: [
                  { matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: nodes }] },
                ],
              },
            },
          },
          initContainers: [
            {
              name: "uplink",
              image: PROOF,
              imagePullPolicy: "Never",
              command: ["sh", "/etc/jr2/uplink/uplink.sh", String(k)],
              securityContext: { runAsUser: 0, capabilities: { drop: ["ALL"], add: ["NET_ADMIN"] } },
              volumeMounts: [{ name: "uplink", mountPath: "/etc/jr2/uplink" }],
            },
          ],
          containers: [
            {
              name: "envoy",
              image: ENVOY,
              args: [
                "-c",
                "/etc/envoy/envoy.yaml",
                "--concurrency",
                "2",
                "-l",
                "warning",
                "--disable-hot-restart",
                "--drain-time-s",
                "60",
              ],
              securityContext: {
                runAsUser: 1337,
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: none,
              },
              readinessProbe: { httpGet: { path: "/", port: 15021 }, periodSeconds: 2 },
              volumeMounts: [{ name: "envoy", mountPath: "/etc/envoy" }],
            },
            {
              name: "dns",
              image: COREDNS,
              args: ["-conf", "/etc/coredns/Corefile"],
              securityContext: {
                runAsUser: 65532,
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                // The CoreDNS binary carries the file capability NET_BIND_SERVICE, so exec fails without it. It
                // binds no port below 1024 here. M6 replaces CoreDNS with jr2's own resolver.
                capabilities: { drop: ["ALL"], add: ["NET_BIND_SERVICE"] },
              },
              volumeMounts: [{ name: "dns", mountPath: "/etc/coredns" }],
            },
          ],
          volumes: [
            { name: "uplink", configMap: { name: "jr2-custodian-uplink" } },
            { name: "envoy", configMap: { name: "jr2-custodian-envoy" } },
            { name: "dns", configMap: { name: "jr2-custodian-dns" } },
          ],
        },
      },
    },
  });
  return docs;
}

function sandbox(o) {
  const i = Number(o.slot);
  const k = Number(o.range);
  const v = vlan(k, i);
  const tool = (name, sc) => ({
    name,
    image: PROOF,
    imagePullPolicy: "Never",
    command: ["sleep", "infinity"],
    securityContext: sc,
  });
  const containers = [
    {
      name: "web",
      image: PROOF,
      imagePullPolicy: "Never",
      command: [
        "sh",
        "-c",
        "mkdir -p /tmp/www && echo 'sandbox web of slot " +
          i +
          "' > /tmp/www/index.html && exec python3 -m http.server -d /tmp/www 8080",
      ],
      securityContext: { runAsUser: 1000, runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: none },
      // An exec probe: the kubelet cannot reach a pod address on the Fence.
      readinessProbe: o["http-probe"]
        ? { httpGet: { path: "/", port: 8080 }, periodSeconds: 2, timeoutSeconds: 1 }
        : { exec: { command: ["nc", "-z", "127.0.0.1", "8080"] }, periodSeconds: 2 },
    },
    tool("v1", { runAsUser: 1000, runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: none }),
    tool("v2", { runAsUser: 0 }),
  ];
  const initContainers = [];
  if (o.window) {
    initContainers.push({
      name: "probe",
      image: PROOF,
      imagePullPolicy: "Never",
      restartPolicy: "Always",
      command: ["python3", "-u", "/opt/fence/window-probe.py"],
      env: [
        { name: "NODE_IP", valueFrom: { fieldRef: { fieldPath: "status.hostIP" } } },
        { name: "API_IP", value: String(o["api-ip"] || "") },
      ],
      securityContext: { runAsUser: 1000, runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: none },
    });
  }
  return [
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: o.name || `sbx-${i}`,
        namespace: o.ns,
        labels: { "jr2.dev/fence-proof": "true", "jr2.dev/slot": String(i) },
        annotations: {
          "v1.multus-cni.io/default-network": `${o.ns}/jr2-fence-${i}`,
          "jr2.dev/vlan": String(v),
          "jr2.dev/address": addr(v),
        },
      },
      spec: {
        nodeSelector: { "kubernetes.io/hostname": o.node },
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        terminationGracePeriodSeconds: 1,
        dnsPolicy: "None",
        dnsConfig: { nameservers: [GW], searches: [], options: [{ name: "ndots", value: "1" }] },
        initContainers,
        containers,
      },
    },
  ];
}

const o = args();
const docs = o.cmd === "custodian" ? custodian(o) : o.cmd === "sandbox" ? sandbox(o) : null;
if (!docs) {
  console.error("usage: render.mjs custodian|sandbox ...");
  process.exit(2);
}
process.stdout.write(docs.map((d) => JSON.stringify(d)).join("\n---\n") + "\n");
