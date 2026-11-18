// The rules of the Custodian of an Instance (ADR-0059, ADR-0084), socket-free: what the renderer
// tells Envoy for one slot, and the bootstrap of the Custodian pod. What only a real engine can show
// is the Custodian suite's (`just custodian-test`): the pinned Envoy validates these files there
// (`packages/cli/test/custodian-rules.docker.ts`), and runs connections through them
// (`packages/cli/test/custodian.docker.ts`). What is
// pinned here is that the rendering says what ADR-0084 decides: the dialed address and port choose a
// chain, the TLS name or the `Host` header must agree with the name, the Custodian dials the name
// through the dial guard, and every other connection is refused with a reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_ROUTES,
  CUSTODIAN_CONNECTIONS,
  CUSTODIAN_DRAIN_SECONDS,
  CUSTODIAN_NAME_CACHE,
  CUSTODIAN_POD_ARGS,
  CUSTODIAN_PROGRAM,
  JR2_CUSTODIAN_NAME,
} from "../src/custodian.ts";
import {
  custodianPodBootstrap,
  custodianXds,
  renderSlot,
  rulesChainName,
  slotAddress,
  slotVlan,
  type SlotRules,
} from "../src/custodian-rules.ts";
import { fenceRangesOf, GUARDED_RANGES } from "../src/egress.ts";
import { effectorBindingName, leafStem } from "../src/held-secrets.ts";
import { withPushTokens } from "../src/sandbox-fence.ts";
import { emptyPlaceholders, withPlaceholders } from "../src/placeholders.ts";
import {
  INSTANCE_MANIFEST,
  inputsOf,
  manySlots,
  RANGES,
  rule,
  SANDBOX_MANIFEST,
  THREE_SLOTS,
} from "./_custodian-slots.ts";

type Chain = {
  name: string;
  filter_chain_match: Record<string, any>;
  transport_socket?: { typed_config: Record<string, any> };
  filters: Array<{ name: string; typed_config: Record<string, any> }>;
};

const sandbox = () => renderSlot(inputsOf(3, SANDBOX_MANIFEST, { sandbox: "ticket-a1b2c" }));
const chainsOf = (r: SlotRules) => (r.listener as { filter_chains: Chain[] }).filter_chains;
const chainOf = (r: SlotRules, name: string): Chain => {
  const found = chainsOf(r).find((c) => c.name === name);
  assert.ok(
    found,
    `no chain ${name}; chains: ${chainsOf(r)
      .map((c) => c.name)
      .join(" | ")}`,
  );
  return found;
};
const at = (address: string, port: number) => ({
  prefix_ranges: [{ address_prefix: address, prefix_len: 32 }],
  destination_port: port,
});
/** The HTTP connection manager of a chain, if it has one. */
const manager = (c: Chain) =>
  c.filters.find((f) => f.name === "envoy.filters.network.http_connection_manager")?.typed_config;
const tcp = (c: Chain) => c.filters.find((f) => f.name === "envoy.filters.network.tcp_proxy")?.typed_config;
const text = (c: Chain) => c.filters[0]!.typed_config.response?.inline_string as string | undefined;
/** An RE2 pattern of Envoy as a JS RegExp: a leading `(?i)` is the `i` flag. */
const re2 = (pattern: string) => (pattern.startsWith("(?i)") ? new RegExp(pattern.slice(4), "i") : new RegExp(pattern));
const isAlert = (c: Chain) => c.filters[0]!.typed_config.response?.inline_bytes === "FQMDAAICMQ==";

test("a slot's listener is on 20000 + slot, reads the dialed address and the TLS name, and no chain reads a source address", () => {
  const r = sandbox();
  const listener = r.listener as Record<string, any>;
  assert.equal(listener.name, "slot-3");
  assert.deepEqual(listener.address, { socket_address: { address: "0.0.0.0", port_value: 20003 } });
  assert.deepEqual(
    listener.listener_filters.map((f: { name: string }) => f.name),
    ["envoy.filters.listener.original_dst", "envoy.filters.listener.tls_inspector"],
  );
  assert.equal(listener.listener_filters_timeout, "2s", "a server-first protocol waits about 2 s");
  assert.equal(listener.continue_on_listener_filters_timeout, true);
  const json = JSON.stringify(r.listener);
  assert.doesNotMatch(
    json,
    /source_prefix_ranges|source_ports|direct_source/,
    "the port names the slot, never an address",
  );
  assert.match(text(listener.default_filter_chain as Chain)!, /no entry of the Egress list permits/);
});

test("a Tunneled name: its placeholder and port with its TLS name go to the dial listener as the name; another TLS name gets an alert; plain bytes are carried by the address, on 443 too", () => {
  const r = sandbox();
  const p = r.resolver.names.find((n) => n.name === "github.com")!.address;
  const tls = chainOf(r, "action=tunnel target=github.com:443");
  assert.deepEqual(tls.filter_chain_match, { ...at(p, 443), transport_protocol: "tls", server_names: ["github.com"] });
  assert.equal(tcp(tls)!.cluster, "dial");
  assert.equal(
    tcp(tls)!.tunneling_config.hostname,
    "github.com:443",
    "the Custodian dials the name, never the address",
  );
  assert.deepEqual(
    tcp(tls)!.tunneling_config.headers_to_add.map((h: { header: { key: string; value: string } }) => h.header),
    [
      { key: "x-jr2-fence-slot", value: "3" },
      { key: "x-jr2-fence-owner", value: "sandbox=ticket-a1b2c" },
    ],
  );
  // One chain of the port refuses another TLS name on each address whose name it checks; the chain
  // of the name with its TLS name is as specific, and the TLS name chooses it.
  const sni = chainOf(r, "action=refuse reason=sni port=443");
  assert.ok(sni.filter_chain_match.prefix_ranges.some((x: { address_prefix: string }) => x.address_prefix === p));
  assert.equal(sni.filter_chain_match.transport_protocol, "tls");
  assert.equal(sni.filter_chain_match.server_names, undefined);
  assert.ok(isAlert(sni));
  // One rule serves each protocol (ADR-0084): SSH over 443, for example, is carried by the address.
  const raw = chainOf(r, "action=tunnel target=github.com:443 transport=raw");
  assert.deepEqual(raw.filter_chain_match, { ...at(p, 443), transport_protocol: "raw_buffer" });
  assert.equal(tcp(raw)!.tunneling_config.hostname, "github.com:443");
  // Plain bytes are refused on 443 only where TLS alone is carried: an Intercepted name, jr2's name.
  const plain = chainOf(r, "action=refuse reason=not-tls port=443");
  assert.ok(!plain.filter_chain_match.prefix_ranges.some((x: { address_prefix: string }) => x.address_prefix === p));
  assert.equal(plain.filter_chain_match.transport_protocol, undefined);
  assert.match(text(plain)!, /^jr2 custodian: refused: this address takes TLS only on port 443/);
});

test("a protocol that sends no name (SSH on 22) is carried by its exact name's address; TLS there still needs the name", () => {
  const r = sandbox();
  const p = r.resolver.names.find((n) => n.name === "github.com")!.address;
  const raw = chainOf(r, "action=tunnel target=github.com:22 transport=raw");
  assert.deepEqual(raw.filter_chain_match, { ...at(p, 22), transport_protocol: "raw_buffer" });
  assert.equal(tcp(raw)!.tunneling_config.hostname, "github.com:22");
  const sni = chainOf(r, "action=refuse reason=sni port=22");
  assert.deepEqual(sni.filter_chain_match, { ...at(p, 22), transport_protocol: "tls" });
  assert.ok(
    !chainsOf(r).some((c) => c.name === "action=refuse reason=not-tls port=22"),
    "plain bytes are carried there",
  );
});

test("port 80: one HTTP chain of the slot, whose Host chooses the name, and the program checks that the address dialed is that name's placeholder", () => {
  const r = sandbox();
  const p = r.resolver.names.find((n) => n.name === "github.com")!.address;
  const c = chainOf(r, "action=tunnel port=80");
  assert.deepEqual(c.filter_chain_match, { destination_port: 80 });
  const hcm = manager(c)!;
  const vhosts = hcm.route_config.virtual_hosts as Array<{ name: string; domains: string[]; routes: any[] }>;
  const github = vhosts.find((v) => v.name === "github.com")!;
  assert.deepEqual(github.domains, ["github.com", "github.com:80"]);
  assert.equal(github.routes[0].route.cluster, "dial-http");
  assert.deepEqual(github.routes[0].metadata.filter_metadata["envoy.filters.http.lua"], {
    role: "http",
    address: `${p}:80`,
  });
  assert.deepEqual(
    github.routes[0].request_headers_to_add.map((h: { header: { key: string } }) => h.header.key),
    ["x-jr2-fence-slot", "x-jr2-fence-owner"],
  );
  assert.deepEqual(
    hcm.http_filters.map((f: { name: string }) => f.name),
    ["envoy.filters.http.lua", "envoy.filters.http.router"],
    "the dial guard is on the dial listener, the one place each dial by name goes through",
  );
  // The program refuses a Host whose placeholder is not the address dialed.
  assert.match(CUSTODIAN_PROGRAM, /downstreamLocalAddress\(\)\n    if here ~= meta:get\("address"\)/);
  // With no `*` rule, any other Host is refused; TLS on port 80 gets an alert.
  const plainSlot = renderSlot(
    inputsOf(
      4,
      { ...SANDBOX_MANIFEST, egress: SANDBOX_MANIFEST.egress.filter((x) => x.match !== "any") },
      { sandbox: "x" },
    ),
  );
  const each = (
    manager(chainOf(plainSlot, "action=tunnel port=80"))!.route_config.virtual_hosts as Array<{
      name: string;
      routes: any[];
    }>
  ).find((v) => v.name === "each")!;
  assert.equal(each.routes[0].metadata.filter_metadata["envoy.filters.http.lua"].reason, "no-entry");
  assert.ok(isAlert(chainOf(r, "action=refuse reason=no-entry port=80 transport=tls")));
});

test("an Intercepted name: TLS ended with the slot's leaf for that host, the program, the dial guard, then the name over verified TLS", () => {
  const r = sandbox();
  const p = r.resolver.names.find((n) => n.name === "api.anthropic.com")!.address;
  const c = chainOf(r, "action=intercept target=api.anthropic.com:443");
  assert.deepEqual(c.filter_chain_match, {
    ...at(p, 443),
    transport_protocol: "tls",
    server_names: ["api.anthropic.com"],
  });
  const stem = leafStem("api.anthropic.com", 443);
  assert.deepEqual(c.transport_socket!.typed_config.common_tls_context, {
    alpn_protocols: ["http/1.1"],
    tls_certificates: [
      {
        certificate_chain: { filename: `/run/jr2-custodian/slots/3/tls/${stem}.crt` },
        private_key: { filename: `/run/jr2-custodian/slots/3/tls/${stem}.key` },
      },
    ],
  });
  const hcm = manager(c)!;
  assert.equal(hcm.path_with_escaped_slashes_action, "REJECT_REQUEST");
  assert.equal(hcm.common_http_protocol_options.headers_with_underscores_action, "REJECT_REQUEST");
  assert.equal(hcm.http_filters[0].typed_config.default_source_code.filename, r.lua.path);
  const route = hcm.route_config.virtual_hosts[0].routes[0];
  assert.equal(route.route.cluster, "dial-tls", "the dial-tls listener: the guard, then Envoy's own TLS to the name");
  assert.deepEqual(route.metadata.filter_metadata["envoy.filters.http.lua"], {
    role: "intercept",
    target: "api.anthropic.com:443",
  });
  assert.ok(
    chainOf(r, "action=refuse reason=sni port=443").filter_chain_match.prefix_ranges.some(
      (x: { address_prefix: string }) => x.address_prefix === p,
    ),
  );
  const bodies = hcm.local_reply_config.mappers.map(
    (m: { body_format_override: { text_format_source: { inline_string: string } } }) =>
      m.body_format_override.text_format_source.inline_string,
  );
  assert.match(bodies[0], /could not be reached/);
  assert.match(bodies[1], /may have reached it/);
  // An intercepted entry on port 80 is HTTP with the program, no TLS.
  const http80 = chainOf(r, "action=intercept target=registry.npmjs.org:80");
  assert.equal(http80.transport_socket, undefined);
  assert.equal(manager(http80)!.route_config.virtual_hosts[0].routes[0].route.cluster, "dial-http");
});

test("an address entry is dialed as written; an Intercepted one ends TLS with the leaf of that address and checks the target's IP SAN", () => {
  const r = sandbox();
  const tunnel = chainOf(r, "action=tunnel target=10.0.0.5:8000");
  assert.deepEqual(tunnel.filter_chain_match, at("10.0.0.5", 8000));
  assert.equal(tcp(tunnel)!.cluster, "tcp|10.0.0.5|8000");
  assert.equal(tcp(tunnel)!.tunneling_config, undefined);
  const cluster = r.clusters.find((c) => c.name === "tcp|10.0.0.5|8000") as Record<string, any>;
  assert.equal(cluster.type, "STATIC");
  assert.deepEqual(cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address, {
    address: "10.0.0.5",
    port_value: 8000,
  });
  const held = chainOf(r, "action=intercept target=10.0.0.7:8443");
  assert.deepEqual(held.filter_chain_match, { ...at("10.0.0.7", 8443), transport_protocol: "tls" });
  assert.equal(manager(held)!.route_config.virtual_hosts[0].routes[0].route.cluster, "tls|10.0.0.7|8443");
  assert.ok(
    !manager(held)!.http_filters.some((f: { name: string }) => f.name === "envoy.filters.http.dynamic_forward_proxy"),
    "an address is not resolved",
  );
  const tls = r.clusters.find((c) => c.name === "tls|10.0.0.7|8443") as Record<string, any>;
  assert.deepEqual(tls.transport_socket.typed_config.common_tls_context.validation_context, {
    trusted_ca: { filename: "/etc/jr2/ca/upstream.crt" },
    match_typed_subject_alt_names: [{ san_type: "IP_ADDRESS", matcher: { exact: "10.0.0.7" } }],
  });
  assert.ok(
    !chainsOf(r).some((c) => c.name === "action=refuse reason=sni port=8443"),
    "an address has no TLS name to check",
  );
});

test("`*.` and `*` carry TLS and HTTP only, on each of their ports, by the name the client sent, and never an Intercepted host or jr2's own name", () => {
  const r = sandbox();
  const below = r.resolver.names.find((n) => n.name === "*.githubusercontent.com")!;
  const anyName = r.resolver.names.find((n) => n.name === "*")!;
  assert.equal(below.match, "below");
  const tls = chainOf(r, "action=tunnel target=*.githubusercontent.com:443");
  assert.deepEqual(tls.filter_chain_match.server_names, ["*.githubusercontent.com"]);
  assert.equal(tcp(tls)!.tunneling_config.hostname, "%REQUESTED_SERVER_NAME%:443");
  // Port 80 carries HTTP alone: no chain of a wildcard's address there, so the port's HTTP chain
  // takes it.
  assert.ok(!chainsOf(r).some((c) => c.name === "action=tunnel target=*:80" || c.name.endsWith("target=*:80")));
  // Plain bytes to a wildcard's address on 443 are HTTP, whose `Host` must name port 443.
  const web443 = chainOf(r, "action=tunnel port=443 transport=http");
  assert.deepEqual(web443.filter_chain_match, {
    prefix_ranges: [below.address, anyName.address].map((a) => ({ address_prefix: a, prefix_len: 32 })),
    destination_port: 443,
    transport_protocol: "raw_buffer",
  });
  const vhosts443 = manager(web443)!.route_config.virtual_hosts as Array<{
    name: string;
    domains: string[];
    routes: any[];
  }>;
  assert.deepEqual(
    vhosts443.map((v) => [v.name, v.domains]),
    [
      ["*.githubusercontent.com", ["*.githubusercontent.com", "*.githubusercontent.com:443"]],
      ["each", ["*"]],
    ],
  );
  const tunnel443 = vhosts443[0]!.routes.find((x) => x.route)!;
  assert.deepEqual(tunnel443.metadata.filter_metadata["envoy.filters.http.lua"], {
    role: "http",
    address: `${below.address}:443`,
  });
  const port443Re = re2(tunnel443.match.headers[0].string_match.safe_regex.regex);
  assert.match("x.githubusercontent.com:443", port443Re);
  for (const host of ["x.githubusercontent.com", "x.githubusercontent.com:80", "x.githubusercontent.com:4430"]) {
    assert.doesNotMatch(host, port443Re, host);
  }
  assert.ok(
    !chainOf(r, "action=refuse reason=not-tls port=443").filter_chain_match.prefix_ranges.some(
      (x: { address_prefix: string }) => x.address_prefix === below.address || x.address_prefix === anyName.address,
    ),
  );
  const any = chainOf(r, "action=tunnel target=*:443");
  assert.equal(any.filter_chain_match.server_names, undefined);
  // Each Intercepted name of the slot, and jr2's domain, is refused on the `*` chain.
  const refused = chainOf(r, "action=refuse reason=intercepted target=*:443");
  // Each name also with a trailing dot: Envoy makes a TLS name lower case, but keeps its dot.
  assert.deepEqual(
    refused.filter_chain_match.server_names,
    ["*.jr2.internal", "jr2.internal", "api.anthropic.com", "api.github.com", "registry.npmjs.org"].flatMap((n) => [
      n,
      `${n}.`,
    ]),
  );
  assert.ok(isAlert(refused));
  // On HTTP, an address, an empty name, jr2's domain and an Intercepted host are refused by Host, in
  // any letter case; then `*` carries a Host with no port or port 80, and refuses each other port.
  const http = manager(chainOf(r, "action=tunnel port=80"))!;
  const each = (http.route_config.virtual_hosts as Array<{ name: string; routes: any[] }>).find(
    (v) => v.name === "each",
  )!;
  const [addressRoute, interceptedRoute, dotRoute, tunnelRoute, portRoute] = each.routes;
  const addressRe = re2(addressRoute.match.headers[0].string_match.safe_regex.regex);
  for (const host of [
    "10.0.0.9",
    "10.0.0.9:80",
    "[fd00::1]:80",
    ":80",
    "-",
    "custodian.jr2.internal",
    "CUSTODIAN.JR2.INTERNAL",
    "custodian.jr2.internal.:80",
    "x.jr2.internal:80",
  ]) {
    assert.match(host, addressRe, host);
  }
  for (const host of ["example.com", "example.com:80", "jr2.internal.example.com"]) {
    assert.doesNotMatch(host, addressRe, host);
  }
  const interceptedRe = re2(interceptedRoute.match.headers[0].string_match.safe_regex.regex);
  for (const host of ["api.anthropic.com", "api.anthropic.com:80", "API.ANTHROPIC.COM", "api.anthropic.com."]) {
    assert.match(host, interceptedRe, host);
  }
  assert.doesNotMatch("xapi.anthropic.com", interceptedRe);
  // A name with a trailing dot is refused, as the CONNECT of a tunnel refuses it: a wildcard dials
  // a name in one spelling only.
  assert.equal(dotRoute.metadata.filter_metadata["envoy.filters.http.lua"].reason, "host");
  assert.deepEqual(dotRoute.direct_response, { status: 403 });
  const dotRe = re2(dotRoute.match.headers[0].string_match.safe_regex.regex);
  for (const host of ["other.test.", "OTHER.TEST.", "other.test.:80", "other.test.:6379", "a."]) {
    assert.match(host, dotRe, host);
  }
  for (const host of ["other.test", "other.test:80", "OTHER.TEST", "a.b"]) assert.doesNotMatch(host, dotRe, host);
  assert.equal(tunnelRoute.route.cluster, "dial-http");
  const portRe = re2(tunnelRoute.match.headers[0].string_match.safe_regex.regex);
  for (const host of ["example.com", "example.com:80"]) assert.match(host, portRe, host);
  for (const host of ["example.com:6379", "example.com:8080", "example.com:", "example.com:080", "a:80:6379"]) {
    assert.doesNotMatch(host, portRe, host);
  }
  assert.equal(portRoute.metadata.filter_metadata["envoy.filters.http.lua"].reason, "port");
  assert.deepEqual(portRoute.match, { prefix: "/" });
  // `*.` on port 80: the same port check.
  const below80 = (http.route_config.virtual_hosts as Array<{ name: string; routes: any[] }>).find(
    (v) => v.name === "*.githubusercontent.com",
  )!;
  assert.deepEqual(
    below80.routes.map((x) => x.metadata.filter_metadata["envoy.filters.http.lua"].reason ?? "tunnel"),
    ["host", "host", "tunnel", "port"],
  );
});

test("a `*.` entry on another port carries TLS and plain HTTP there, and its `Host` must name that port", () => {
  const manifest = {
    version: 1 as const,
    secrets: [],
    egress: [rule("d.test", 8080, "below", false, "entry"), rule("plain.test", 8080, "name", false, "entry")],
  };
  const r = renderSlot(inputsOf(5, manifest, { sandbox: "x" }));
  const below = r.resolver.names.find((n) => n.name === "*.d.test")!;
  const plain = r.resolver.names.find((n) => n.name === "plain.test")!;
  assert.equal(
    tcp(chainOf(r, "action=tunnel target=*.d.test:8080"))!.tunneling_config.hostname,
    "%REQUESTED_SERVER_NAME%:8080",
  );
  const web = chainOf(r, "action=tunnel port=8080 transport=http");
  // Only the wildcard's address: an exact name on the port is carried by its address.
  assert.deepEqual(web.filter_chain_match, { ...at(below.address, 8080), transport_protocol: "raw_buffer" });
  assert.deepEqual(chainOf(r, "action=tunnel target=plain.test:8080 transport=raw").filter_chain_match, {
    ...at(plain.address, 8080),
    transport_protocol: "raw_buffer",
  });
  const vhosts = manager(web)!.route_config.virtual_hosts as Array<{ name: string; domains: string[]; routes: any[] }>;
  assert.deepEqual(vhosts[0]!.domains, ["*.d.test", "*.d.test:8080"]);
  assert.deepEqual(
    vhosts[0]!.routes.map((x) => x.metadata.filter_metadata["envoy.filters.http.lua"].reason ?? "tunnel"),
    ["host", "host", "tunnel", "port"],
  );
  const tunnel = vhosts[0]!.routes[2];
  assert.equal(tunnel.route.cluster, "dial-http");
  assert.equal(tunnel.metadata.filter_metadata["envoy.filters.http.lua"].address, `${below.address}:8080`);
  const portRe = re2(tunnel.match.headers[0].string_match.safe_regex.regex);
  assert.match("a.d.test:8080", portRe);
  for (const host of ["a.d.test", "a.d.test:80", "a.d.test:80800", "a.d.test:8080:1"]) {
    assert.doesNotMatch(host, portRe, host);
  }
  assert.match(vhosts[0]!.routes[3].metadata.filter_metadata["envoy.filters.http.lua"].body, /other than 8080/);
  // With no `*` on the port, another `Host` is refused there.
  assert.equal(vhosts[1]!.routes[0].metadata.filter_metadata["envoy.filters.http.lua"].reason, "no-entry");
  assert.ok(!chainsOf(r).some((c) => c.name === "action=refuse reason=not-tls port=8080"));
  const matches = chainsOf(r).map((c) => JSON.stringify(c.filter_chain_match));
  assert.equal(new Set(matches).size, matches.length);
});

for (const [label, wildcard, name] of [
  ["`*`", rule("*", 443, "any", false, "entry"), "github.com"],
  ["`*.corp.test`", rule("corp.test", 443, "below", false, "entry"), "git.corp.test"],
] as const) {
  test(`a Tunneled name with an exact entry on port 22 keeps, at its own placeholder, the TLS and HTTP that ${label} permits on 443 and 80, for that name alone`, () => {
    const egress = [
      wildcard,
      { ...wildcard, port: 80 },
      rule(name, 22, "name", false, "repo"),
      rule("secure.corp.test", 443, "name", true, "entry"),
    ];
    const r = renderSlot(inputsOf(4, { version: 1, secrets: [], egress }, { sandbox: "x" }));
    // No new resolver row: the name keeps its one placeholder.
    assert.deepEqual(
      r.resolver.names.map((n) => n.name),
      [JR2_CUSTODIAN_NAME, wildcard.match === "any" ? "*" : "*.corp.test", name, "secure.corp.test"],
    );
    const own = r.resolver.names.find((n) => n.name === name)!.address;
    const secure = r.resolver.names.find((n) => n.name === "secure.corp.test")!.address;
    const named = (address: string) =>
      chainsOf(r)
        .filter((c) =>
          (c.filter_chain_match.prefix_ranges ?? []).some(
            (x: { address_prefix: string }) => x.address_prefix === address,
          ),
        )
        .map((c) => c.name);

    // TLS on 443 with the name's TLS name: a tunnel to the name on 443. Another TLS name is refused.
    const tls = chainOf(r, `action=tunnel target=${name}:443`);
    assert.deepEqual(tls.filter_chain_match, {
      ...at(own, 443),
      transport_protocol: "tls",
      server_names: [name],
    });
    assert.equal(tcp(tls)!.tunneling_config.hostname, `${name}:443`);
    assert.deepEqual(named(own).sort(), [
      "action=refuse reason=sni port=22",
      "action=refuse reason=sni port=443",
      "action=tunnel port=443 transport=http",
      `action=tunnel target=${name}:22`,
      `action=tunnel target=${name}:22 transport=raw`,
      `action=tunnel target=${name}:443`,
    ]);
    // A wildcard carries TLS and HTTP only: no raw chain of the name on 443.
    assert.ok(!chainsOf(r).some((c) => c.name === `action=tunnel target=${name}:443 transport=raw`));
    // Plain bytes on 443 are HTTP, whose `Host` must name port 443.
    const web443 = manager(chainOf(r, "action=tunnel port=443 transport=http"))!;
    const host443 = (
      web443.route_config.virtual_hosts as Array<{ name: string; domains: string[]; routes: any[] }>
    ).find((v) => v.name === name)!;
    assert.deepEqual(host443.domains, [name, `${name}:443`]);
    const tunnel443 = host443.routes.find((x) => x.route)!;
    assert.equal(tunnel443.metadata.filter_metadata["envoy.filters.http.lua"].address, `${own}:443`);
    assert.match(`${name}:443`, re2(tunnel443.match.headers[0].string_match.safe_regex.regex));
    assert.doesNotMatch(name, re2(tunnel443.match.headers[0].string_match.safe_regex.regex));

    // HTTP on 80: the slot's one HTTP chain has a virtual host of the name, whose route needs the
    // name's own placeholder.
    const web80 = manager(chainOf(r, "action=tunnel port=80"))!;
    const host80 = (web80.route_config.virtual_hosts as Array<{ name: string; domains: string[]; routes: any[] }>).find(
      (v) => v.name === name,
    )!;
    assert.deepEqual(host80.domains, [name, `${name}:80`]);
    const tunnel80 = host80.routes.find((x) => x.route)!;
    assert.equal(tunnel80.route.cluster, "dial-http");
    assert.deepEqual(tunnel80.metadata.filter_metadata["envoy.filters.http.lua"], {
      role: "http",
      address: `${own}:80`,
    });

    // An Intercepted host gets no such chain: a wildcard never carries it.
    assert.ok(!named(secure).some((n) => n.startsWith("action=tunnel")));
    assert.ok(
      !(web80.route_config.virtual_hosts as Array<{ name: string }>).some((v) => v.name === "secure.corp.test"),
    );
    const matches = chainsOf(r).map((c) => JSON.stringify(c.filter_chain_match));
    assert.equal(new Set(matches).size, matches.length);
  });
}

test("a rule of a name's own on a wildcard's port wins over the wildcard, and a name that the `*.` does not cover gets nothing of it", () => {
  const egress = [
    rule("*", 80, "any", false, "entry"),
    rule("corp.test", 443, "below", false, "entry"),
    rule("github.com", 443, "name", false, "entry"),
    rule("github.com", 80, "name", false, "entry"),
    rule("other.example", 22, "name", false, "repo"),
  ];
  const r = renderSlot(inputsOf(4, { version: 1, secrets: [], egress }, { sandbox: "x" }));
  const web80 = manager(chainOf(r, "action=tunnel port=80"))!;
  const hosts = (web80.route_config.virtual_hosts as Array<{ name: string; routes: any[] }>).map((v) => v.name);
  // `github.com:80` is the author's rule (its one route); `other.example` is under `*` on 80.
  assert.deepEqual(hosts, ["github.com", "other.example", "each"]);
  const github = (web80.route_config.virtual_hosts as Array<{ name: string; routes: any[] }>)[0]!;
  assert.equal(github.routes.length, 1);
  // `*.corp.test` on 443 covers neither name; `github.com:443` keeps its own chains.
  assert.ok(!chainsOf(r).some((c) => c.name === "action=tunnel target=other.example:443"));
  assert.ok(chainsOf(r).some((c) => c.name === "action=tunnel target=github.com:443 transport=raw"));
});

test("jr2's own name: TLS with the slot's leaf on 443 and the six routes to the Orchestrator; on 80 the fetch route alone", () => {
  const r = sandbox();
  assert.deepEqual(r.resolver.names[0], { name: JR2_CUSTODIAN_NAME, match: "name", address: "198.18.0.1" });
  // One row for each name: github.com is on ports 22, 80 and 443, and has one placeholder.
  const resolved = r.resolver.names.map((n) => n.name);
  assert.equal(new Set(resolved).size, resolved.length, resolved.join(" "));
  assert.equal(resolved.filter((n) => n === "github.com").length, 1);
  const c = chainOf(r, `action=intercept target=${JR2_CUSTODIAN_NAME}:443`);
  assert.deepEqual(c.filter_chain_match, {
    ...at("198.18.0.1", 443),
    transport_protocol: "tls",
    server_names: [JR2_CUSTODIAN_NAME],
  });
  assert.match(
    c.transport_socket!.typed_config.common_tls_context.tls_certificates[0].certificate_chain.filename,
    new RegExp(`/slots/3/tls/${leafStem(JR2_CUSTODIAN_NAME, 443)}\\.crt$`),
  );
  const routes = manager(c)!.route_config.virtual_hosts[0].routes as Array<{ name: string }>;
  assert.deepEqual(
    routes.map((x) => x.name),
    [...CONTROL_ROUTES.map((x) => x.name), "deny"],
  );
  const local = manager(c)!.local_reply_config.mappers[0];
  assert.equal(local.headers_to_add[0].header.key, "x-jr2-custodian");
  const plain = chainOf(r, `action=control target=${JR2_CUSTODIAN_NAME}:80`);
  assert.deepEqual(
    (manager(plain)!.route_config.virtual_hosts[0].routes as Array<{ name: string }>).map((x) => x.name),
    ["fetch", "deny"],
  );
});

test("each port that a chain names has its own refusals — TLS alert, HTTP 403 on 80, else text — and every other port is refused too", () => {
  const r = sandbox();
  for (const port of [22, 80, 443, 8000, 8443]) {
    assert.ok(isAlert(chainOf(r, `action=refuse reason=no-entry port=${port} transport=tls`)));
    if (port === 80) continue; // the slot's HTTP chain on port 80 refuses a Host that no entry permits
    const c = chainOf(r, `action=refuse reason=no-entry port=${port}`);
    assert.deepEqual(c.filter_chain_match, { destination_port: port });
    assert.match(text(c)!, new RegExp(`on port ${port}`));
  }
  assert.ok(isAlert(chainOf(r, "action=refuse reason=no-entry transport=tls")));
  // No two chains match alike: Envoy refuses such a listener.
  const matches = chainsOf(r).map((c) => JSON.stringify(c.filter_chain_match));
  assert.equal(new Set(matches).size, matches.length);
});

test("the Lua table names the slot's values folder, its Sandbox, the control credentials, the bound targets and the open ones, and never a value", () => {
  const r = sandbox();
  const t = r.lua.text;
  assert.match(t, /values = "\/run\/jr2-custodian\/slots\/3\/values\/"/);
  assert.match(t, /sandbox = "ticket-a1b2c"/);
  assert.match(
    t,
    /HELD\.secrets\[1\] = \{ name = "JR2_CONTROL_TOKEN", headers = \{ "authorization" \}, paths = \{ "\/agents\/" \} \}/,
  );
  assert.match(t, /name = "JR2_SANDBOX_TOKEN".*standIn = "jr2-held-JR2_SANDBOX_TOKEN".*paths = \{ "\/sandboxes\/" \}/);
  assert.match(t, /HELD\.targets\["api\.anthropic\.com:443"\] = \{ HELD\.secrets\[3\] \}/);
  // A bound host that an entry also names, and an intercepted entry with no secret, are open.
  assert.match(t, /HELD\.open\["api\.github\.com:443"\] = true/);
  assert.match(t, /HELD\.open\["registry\.npmjs\.org:443"\] = true/);
  assert.doesNotMatch(t, /HELD\.open\["api\.anthropic\.com:443"\]/, "a bound host with no entry needs its Stand-in");
  assert.match(t, /\ndofile\("\/etc\/jr2\/custodian\/program\.lua"\)\n$/);
  // The Instance Harness and a check pod serve no fetch.
  const instance = renderSlot(inputsOf(0, INSTANCE_MANIFEST, { pod: "instance" }));
  assert.doesNotMatch(instance.lua.text, /JR2_SANDBOX_TOKEN|sandbox = /);
  // The program reads the slot's table: its values folder, its Sandbox, its open targets.
  assert.match(CUSTODIAN_PROGRAM, /local VALUES = HELD\.values or /);
  assert.match(CUSTODIAN_PROGRAM, /local sandbox = HELD\.sandbox/);
  assert.match(CUSTODIAN_PROGRAM, /HELD\.open/);
});

test("a secret that rides Basic is marked in the Lua table, so a request with no credential gets the 401 git waits for (ADR-0068)", () => {
  const manifest = {
    ...SANDBOX_MANIFEST,
    secrets: SANDBOX_MANIFEST.secrets.map((s) =>
      s.name === "GH_TOKEN" ? { ...s, holder: "effector" as const, basic: true as const } : s,
    ),
  };
  const t = renderSlot(inputsOf(3, manifest, { sandbox: "ticket-a1b2c" })).lua.text;
  assert.match(t, /\{ name = "GH_TOKEN", headers = \{ "authorization" \}, basic = true \}/);
  assert.doesNotMatch(t, /name = "ANTHROPIC_API_KEY"[^\n]*basic/);
  assert.match(CUSTODIAN_PROGRAM, /"www-authenticate"\] = 'Basic realm="jr2"'/);
});

test("the rules hold no value and no secret Stand-in: only names, paths and the public fetch Stand-in", () => {
  // A Sandbox whose Effector holds a header secret and pushes over https: both bindings are the
  // Effector's, and their Stand-ins are lower case (ADR-0068).
  const effector = withPushTokens(
    {
      ...SANDBOX_MANIFEST,
      secrets: [
        ...SANDBOX_MANIFEST.secrets,
        {
          name: effectorBindingName("files-token"),
          source: { kind: "literal" },
          hosts: [{ host: "files.example.com", port: 443, leaf: leafStem("files.example.com", 443) }],
          headers: ["authorization"],
          holder: "effector",
        },
      ],
      egress: [...SANDBOX_MANIFEST.egress, rule("files.example.com", 443, "name", true, "effector")],
    },
    [{ secret: "jr2-git-push-0a1b2c3d", host: "git.example.com", port: 443 }],
    RANGES,
  );
  const slots = [...THREE_SLOTS, inputsOf(4, effector, { sandbox: "ticket-d4e5f" })];
  const all = JSON.stringify(slots.map(renderSlot));
  assert.match(all, /effector_files_2dtoken/, "the Effector's binding is in the rules, by name");
  assert.match(all, /push_0a1b2c3d/, "the push binding is in the rules, by name");
  const standIns = [...all.matchAll(/jr2-held-[A-Za-z0-9_]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(standIns)], ["jr2-held-JR2_SANDBOX_TOKEN"], "only the public fetch Stand-in");
  assert.doesNotMatch(all, /sk-ant|value-of/);
});

test("the same inputs give the same rules; a new Tunneled host leaves each intercept chain as it was, so its streams are not drained", () => {
  const one = sandbox();
  assert.deepEqual(sandbox(), one);
  const manifest = {
    ...SANDBOX_MANIFEST,
    egress: [...SANDBOX_MANIFEST.egress, rule("pypi.org", 443, "name", false, "entry")],
  };
  const inputs = inputsOf(3, manifest, { sandbox: "ticket-a1b2c" });
  // The table of the Sandbox is the old one with a row added.
  inputs.placeholders = withPlaceholders(
    withPlaceholders(emptyPlaceholders(RANGES.placeholders), SANDBOX_MANIFEST.egress),
    manifest.egress,
  );
  const two = renderSlot(inputs);
  assert.notEqual(two.version, one.version);
  assert.equal(two.lua.path, one.lua.path, "the Lua table did not change");
  for (const c of chainsOf(one).filter((x) => x.name.startsWith("action=intercept"))) {
    assert.deepEqual(chainOf(two, c.name), c, c.name);
  }
  assert.ok(chainsOf(two).some((c) => c.name === "action=tunnel target=pypi.org:443"));
  // Listener-level fields are the same: Envoy would drain the whole listener otherwise.
  const { filter_chains: _a, ...restOne } = one.listener as Record<string, unknown>;
  const { filter_chains: _b, ...restTwo } = two.listener as Record<string, unknown>;
  assert.deepEqual(restTwo, restOne);
  // A changed value gives a new table path, so the program reads the values again.
  const rotated = renderSlot({ ...inputsOf(3, SANDBOX_MANIFEST, { sandbox: "ticket-a1b2c" }), valuesVersion: "2" });
  assert.notEqual(rotated.lua.path, one.lua.path);
  assert.equal(rotated.lua.text, one.lua.text);
});

test("a chain of its own states the version of the slot's rules: it refuses as the port-less TLS chain does, and a new version changes that chain alone", () => {
  const one = sandbox();
  const marks = chainsOf(one).filter((c) => c.name.split(" ").includes(rulesChainName(one.version)));
  assert.equal(marks.length, 1);
  const portless = chainOf(one, "action=refuse reason=no-entry transport=tls");
  assert.deepEqual(marks[0]!.filters, portless.filters);
  assert.deepEqual(marks[0]!.filter_chain_match, {
    server_names: [`${one.version}.rules.jr2.internal`],
    transport_protocol: "tls",
  });
  const rotated = renderSlot({ ...inputsOf(3, SANDBOX_MANIFEST, { sandbox: "ticket-a1b2c" }), valuesVersion: "2" });
  assert.notEqual(rotated.version, one.version);
  // A chain that loads no Lua table is the same: only the version's chain changes there.
  const plain = (r: typeof one) =>
    chainsOf(r).filter((c) => !JSON.stringify(c).includes(".lua") && !c.name.includes("rules="));
  assert.ok(plain(one).some((c) => c.name.startsWith("action=tunnel")));
  assert.deepEqual(plain(rotated), plain(one), "a chain that names no Lua table does not drain for a new version");
  assert.ok(chainsOf(rotated).some((c) => c.name.endsWith(rulesChainName(rotated.version))));
});

test("the renderer refuses a slot out of range, a placeholder table of another range or with a name missing, a rule the Fence cannot carry, and an owner that is no Kubernetes name", () => {
  const ok = inputsOf(3, SANDBOX_MANIFEST, { sandbox: "ticket-a1b2c" });
  assert.throws(() => renderSlot({ ...ok, slot: 128 }), /slot 128 is not 0 … 127/);
  assert.throws(() => renderSlot({ ...ok, slot: -1 }), /is not 0 … 127/);
  assert.throws(
    () => renderSlot({ ...ok, ranges: fenceRangesOf({ placeholders: "100.64.0.0/16" }) }),
    /not the Instance's/,
  );
  assert.throws(
    () => renderSlot({ ...ok, placeholders: emptyPlaceholders(RANGES.placeholders) }),
    /no address for api\.anthropic\.com/,
  );
  const bad = { ...SANDBOX_MANIFEST, egress: [rule("127.0.0.1", 8000, "address", false, "entry")] };
  assert.throws(() => renderSlot(inputsOf(3, bad, { sandbox: "x" })), /127\.0\.0\.1:8000 is in 127\.0\.0\.0\/8/);
  const wild = { ...SANDBOX_MANIFEST, egress: [rule("example.com", 443, "below", true, "entry")] };
  assert.throws(() => renderSlot(inputsOf(3, wild, { sandbox: "x" })), /a leaf names one host/);
  assert.throws(() => renderSlot({ ...ok, owner: { sandbox: "a b%" } }), /is a Kubernetes name/);
  // Each rule once: Envoy refuses a listener with two chains that match alike, so the slot would
  // have no listener.
  const twice = (egress: ReturnType<typeof rule>[]) => () =>
    renderSlot(inputsOf(3, { version: 1, secrets: [], egress }, { sandbox: "x" }));
  assert.throws(
    twice([rule("a.test", 443, "name", false, "entry"), rule("a.test", 443, "name", false, "entry")]),
    /^Error: slot 3: the rule a\.test:443 is in the manifest twice \(ADR-0084\)$/,
  );
  assert.throws(
    twice([rule("a.test", 443, "name", false, "entry"), rule("a.test", 443, "name", true, "entry")]),
    /the rule a\.test:443 is in the manifest twice/,
  );
  assert.throws(
    twice([rule("d.test", 443, "below", false, "entry"), rule("d.test", 443, "below", false, "entry")]),
    /the rule \*\.d\.test:443 is in the manifest twice/,
  );
  assert.throws(
    twice([rule("10.0.0.5", 8000, "address", false, "entry"), rule("10.0.0.5", 8000, "address", true, "entry")]),
    /the rule 10\.0\.0\.5:8000 is in the manifest twice/,
  );
  // A name and the wildcard of its domain, or one name on two ports, are two rules.
  twice([rule("d.test", 443, "name", false, "entry"), rule("d.test", 443, "below", false, "entry")])();
  twice([rule("a.test", 443, "name", false, "entry"), rule("a.test", 80, "name", false, "entry")])();
  // A placeholder table that `checkAppendOnly` refuses: two names on one address would give two
  // chains that match alike (no listener for the slot), and a name on jr2's own address or outside
  // the placeholder range would be dialed at an address that is not its own.
  const two = [rule("a.test", 443, "name", false, "entry"), rule("b.test", 443, "name", false, "entry")];
  const table = (a: string, b: string) => ({
    ...inputsOf(3, { version: 1, secrets: [], egress: two }, { sandbox: "x" }),
    placeholders: {
      range: RANGES.placeholders,
      rows: [
        { name: "a.test", address: a },
        { name: "b.test", address: b },
      ],
    },
  });
  renderSlot(table("198.18.0.5", "198.18.0.6"));
  assert.throws(() => renderSlot(table("198.18.0.5", "198.18.0.5")), /^Error: slot 3: .*gives 198\.18\.0\.5 twice/);
  assert.throws(() => renderSlot(table("198.18.0.1", "198.18.0.6")), /^Error: slot 3: .*gives 198\.18\.0\.1 twice/);
  assert.throws(
    () => renderSlot(table("198.19.0.9", "198.18.0.6")),
    /^Error: slot 3: .*198\.19\.0\.9 of a\.test is not in/,
  );
});

test("the dial guard refuses GUARDED_RANGES and the Fence's own ranges, also when `fence` moves them, and judges each address of a name (ADR-0059, ADR-0084)", () => {
  // The one DNS cache of each dial drops each guarded address of an answer: Envoy connects to each
  // address of a name in turn, so a guard that judged one address only would let a second one pass.
  const cacheOf = (config: Record<string, any>) => config.dns_cache_config;
  const rangesOf = (cache: Record<string, any>) =>
    cache.resolved_address_filter.ranges.map(
      (r: { address_prefix: string; prefix_len: number }) => `${r.address_prefix}/${r.prefix_len}`,
    );
  const defaults = [...GUARDED_RANGES.map(([a, n]) => `${a}/${n}`), "198.19.0.0/20", "198.18.0.0/16", "198.18.0.0/15"];
  const boot = custodianPodBootstrap({ orchestrator: { host: "o", port: 4000 }, range: 0, ranges: RANGES }) as any;
  const caches: unknown[] = [];
  for (const name of ["dial", "dial-http", "dial-tls"]) {
    const dial = boot.static_resources.listeners.find((l: { name: string }) => l.name === name);
    const hcm = dial.filter_chains[0].filters[0].typed_config;
    assert.deepEqual(
      hcm.http_filters.map((f: { name: string }) => f.name),
      [
        "envoy.filters.http.header_to_metadata",
        "envoy.filters.http.dynamic_forward_proxy",
        "envoy.filters.http.router",
      ],
      name,
    );
    const cache = cacheOf(hcm.http_filters[1].typed_config);
    assert.deepEqual(rangesOf(cache), defaults, name);
    assert.equal(cache.resolved_address_filter.invert_match, undefined, `${name}: the ranges are dropped, not kept`);
    caches.push(cache);
    // A name with no address left gets the guard's refusal: 403 on HTTP, a `reason=guard` line.
    const guard = hcm.access_log.find((l: any) =>
      (l.typed_config.log_format.text_format_source.inline_string as string).includes("reason=guard"),
    );
    assert.equal(
      guard.filter.extension_filter.typed_config.expression,
      "response.code_details.contains('address_denied')",
    );
    const lineOf = (reason: string) =>
      hcm.access_log.find((l: any) =>
        (l.typed_config.log_format.text_format_source.inline_string as string).includes(`reason=${reason} `),
      ).filter.extension_filter.typed_config.expression as string;
    // A target that gave no answer: not the guard's refusal, and not a request that the codec
    // refused (`DPE`: a TLS name that is not a DNS name), which is a name refused.
    assert.equal(
      lineOf("unreachable"),
      "response.flags != 0u && response.code != 200 && response.code_details != 'via_upstream' && " +
        "!(response.code_details.contains('address_denied')) && !response.code_details.startsWith('http1.')",
    );
    assert.equal(
      lineOf("name"),
      "(response.code_details == 'direct_response' && response.code == 403) || " +
        "response.code_details.startsWith('http1.')",
    );
    // The cache of names is full: Envoy sets no response flag, so the details say it.
    const full =
      "response.code_details == 'dns_cache_overflow' || " +
      "response.code_details == 'dynamic_forward_proxy_pending_request_overflow'";
    assert.equal(lineOf("name-cache"), full);
    if (name !== "dial") {
      const [mapper] = hcm.local_reply_config.mappers;
      assert.equal(mapper.status_code, 403, name);
      assert.equal(
        mapper.filter.extension_filter.typed_config.expression,
        guard.filter.extension_filter.typed_config.expression,
      );
      assert.match(mapper.body_format_override.text_format_source.inline_string, /never dials/);
      const cacheMapper = hcm.local_reply_config.mappers[1];
      assert.equal(cacheMapper.status_code, 503, name);
      assert.equal(cacheMapper.filter.extension_filter.typed_config.expression, full);
      assert.match(
        cacheMapper.body_format_override.text_format_source.inline_string,
        /^jr2 custodian: refused: the Custodian's cache of names is full/,
      );
    }
    // This manager adds `x-forwarded-proto`; no target gets it, nor the other forwarding headers.
    assert.deepEqual(hcm.route_config.request_headers_to_remove, [
      "x-forwarded-proto",
      "x-forwarded-for",
      "x-request-id",
      "x-envoy-internal",
    ]);
    // Each line names the slot and its Harness pod as the slot's own lines do: `sandbox=` or `pod=`.
    for (const log of hcm.access_log) {
      const format = log.typed_config.log_format.text_format_source.inline_string as string;
      assert.match(
        format,
        /^jr2\.custodian slot=%DYNAMIC_METADATA\(jr2:slot\)% %DYNAMIC_METADATA\(jr2:owner\)% action=refuse /,
      );
    }
  }
  // The CONNECT of a tunnel names a name in one spelling: an address, `-` (no TLS name), jr2's
  // domain in any letter case and a name with a trailing dot are refused, whatever they resolve to.
  const connect = boot.static_resources.listeners.find((l: { name: string }) => l.name === "dial").filter_chains[0]
    .filters[0].typed_config.route_config.virtual_hosts[0].routes[0];
  assert.deepEqual(connect.direct_response, { status: 403 });
  const connectRe = re2(connect.match.headers[0].string_match.safe_regex.regex);
  for (const authority of [
    "-:443",
    "10.0.0.1:443",
    "[::1]:443",
    "custodian.jr2.internal:443",
    "CUSTODIAN.JR2.INTERNAL:443",
    "api.anthropic.com.:443",
    "API.ANTHROPIC.COM.:443",
  ]) {
    assert.match(authority, connectRe, authority);
  }
  for (const authority of ["example.com:443", "EXAMPLE.com:22", "jr2.internal.example.com:443"]) {
    assert.doesNotMatch(authority, connectRe, authority);
  }
  // Each dial by name of a slot goes through a dial listener: no slot chain dials a name itself.
  const clustersNamed = JSON.stringify(sandbox().listener).match(/"cluster":"[^"]+"/g) ?? [];
  for (const c of new Set(clustersNamed)) {
    assert.match(c, /"cluster":"(dial|dial-http|dial-tls|orchestrator|tcp\|10\.0\.0\.5\|8000|tls\|10\.0\.0\.7\|8443)"/);
  }
  // The clusters of the dial listeners use the same cache: Envoy needs one config for one cache name,
  // and the cluster connects only to an address that this cache kept.
  for (const name of ["dial-tcp", "dial-http-name", "dial-tls-name"]) {
    const cluster = boot.static_resources.clusters.find((c: { name: string }) => c.name === name);
    caches.push(cacheOf(cluster.cluster_type.typed_config));
  }
  for (const cache of caches) assert.deepEqual(cache, caches[0]);
  // The cache's bounds are the pod's, for all its slots: Envoy's defaults (1,024 names, 1,024
  // lookups in flight) are 8 names for each slot of a full range.
  const bounds = caches[0] as Record<string, any>;
  assert.equal(bounds.max_hosts, 8192);
  assert.equal(bounds.dns_cache_circuit_breaker.max_pending_requests, 4096);
  assert.equal(bounds.host_ttl, "300s");
  assert.deepEqual(CUSTODIAN_NAME_CACHE, { hosts: 8192, pending: 4096 });
  const small = custodianPodBootstrap({
    orchestrator: { host: "o", port: 4000 },
    range: 0,
    ranges: RANGES,
    nameCache: { hosts: 8, pending: 2 },
  }) as any;
  const smallCaches = [
    ...["dial", "dial-http", "dial-tls"].map(
      (name) =>
        small.static_resources.listeners.find((l: { name: string }) => l.name === name).filter_chains[0].filters[0]
          .typed_config.http_filters[1].typed_config.dns_cache_config,
    ),
    ...["dial-tcp", "dial-http-name", "dial-tls-name"].map(
      (name) =>
        small.static_resources.clusters.find((c: { name: string }) => c.name === name).cluster_type.typed_config
          .dns_cache_config,
    ),
  ];
  for (const cache of smallCaches) {
    assert.deepEqual(cache, { ...bounds, max_hosts: 8, dns_cache_circuit_breaker: { max_pending_requests: 2 } });
  }
  const moved = fenceRangesOf({ segment: "100.64.0.0/16", placeholders: "100.65.0.0/16" });
  const bootMoved = custodianPodBootstrap({ orchestrator: { host: "o", port: 4000 }, range: 0, ranges: moved }) as any;
  const dialMoved = bootMoved.static_resources.listeners.find((l: { name: string }) => l.name === "dial-tls");
  assert.deepEqual(
    rangesOf(cacheOf(dialMoved.filter_chains[0].filters[0].typed_config.http_filters[1].typed_config)).slice(-3),
    ["100.64.0.0/16", "100.65.0.0/16", "198.18.0.0/15"],
  );
});

test("the pod's bootstrap: admin on loopback, health, the Orchestrator's dial to this Instance's slots alone, the dial listener, LDS and CDS from watched files", () => {
  const boot = custodianPodBootstrap({
    orchestrator: { host: "jr2-orchestrator.ns.svc", port: 4000 },
    range: 2,
    ranges: RANGES,
  }) as any;
  assert.deepEqual(boot.admin.address.socket_address, { address: "127.0.0.1", port_value: 15000 });
  const listeners = boot.static_resources.listeners as Array<Record<string, any>>;
  assert.deepEqual(
    listeners.map((l) => [l.name, l.address?.socket_address?.port_value ?? "internal"]),
    [
      ["health", 15021],
      ["inbound", 18080],
      ["dial", "internal"],
      ["dial-http", "internal"],
      ["dial-tls", "internal"],
    ],
    "18081 is the control process's, not Envoy's",
  );
  // The health listener and the inbound listener are outside Envoy's global limit of the slots, and
  // each has its own bound: a peer on the cluster's network that fills one stops no slot, and a
  // Sandbox that fills the global limit stops neither the kubelet's probe nor the Orchestrator's dial.
  const limitOf = (l: Record<string, any>) => {
    const filter = l.filter_chains[0].filters[0];
    assert.equal(filter.name, "envoy.filters.network.connection_limit", l.name);
    return filter.typed_config.max_connections;
  };
  assert.equal(listeners[0]!.ignore_global_conn_limit, true);
  assert.equal(limitOf(listeners[0]!), 16);
  assert.equal(listeners[1]!.ignore_global_conn_limit, true);
  assert.equal(limitOf(listeners[1]!), 1024);
  assert.deepEqual(CUSTODIAN_CONNECTIONS, { pod: 16384, dial: 1024 });
  assert.equal(
    boot.overload_manager.resource_monitors[0].typed_config.max_active_downstream_connections,
    CUSTODIAN_CONNECTIONS.pod,
  );
  const small = custodianPodBootstrap({
    orchestrator: { host: "o", port: 4000 },
    range: 2,
    ranges: RANGES,
    connections: { pod: 10, dial: 4 },
  }) as any;
  assert.equal(small.overload_manager.resource_monitors[0].typed_config.max_active_downstream_connections, 10);
  assert.equal(limitOf(small.static_resources.listeners[1]), 4);
  assert.equal(limitOf(small.static_resources.listeners[0]), 16);
  // The inbound listener's table: ports 8080 and 8082 of each slot of range 2, and of no other.
  const inbound = listeners[1]!.filter_chains[0].filters[1].typed_config;
  // A connection with no stream closes after a minute; a stream (a Handoff carry, a long poll) has
  // the idle hour.
  assert.equal(inbound.common_http_protocol_options.idle_timeout, "60s");
  assert.equal(inbound.stream_idle_timeout, "3600s");
  const table = inbound.http_filters[0].typed_config.default_source_code.inline_string as string;
  const first = slotAddress(RANGES.segment, slotVlan(2, 0));
  const last = slotAddress(RANGES.segment, slotVlan(2, 127));
  assert.equal(first, "198.19.1.2");
  assert.equal(last, "198.19.1.129");
  assert.ok(table.includes(`"${first}:8080"`) && table.includes(`"${last}:8082"`));
  assert.ok(!table.includes(`"${slotAddress(RANGES.segment, slotVlan(1, 127))}:8080"`), "another Instance's slot");
  assert.equal((table.match(/:808[02]"/g) ?? []).length, 256);
  assert.match(table, /token = "\/run\/jr2-custodian\/dial-token"/);
  const route = inbound.route_config.virtual_hosts[0].routes[0];
  assert.deepEqual(route.request_headers_to_remove, ["x-jr2-dial"]);
  assert.deepEqual(route.response_headers_to_remove, ["x-jr2-custodian"]);
  assert.equal(route.route.timeout, "0s");
  assert.equal(inbound.local_reply_config.mappers[0].status_code, 503);
  const clusters = boot.static_resources.clusters as Array<Record<string, any>>;
  const original = clusters.find((c) => c.name === "inbound")!;
  assert.deepEqual(original.original_dst_lb_config, { use_http_header: true, http_header_name: "x-jr2-target" });
  // The target header goes on the cluster, after it chose the host: a route's removal runs first.
  const upstreamFilters =
    original.typed_extension_protocol_options["envoy.extensions.upstreams.http.v3.HttpProtocolOptions"].http_filters;
  assert.deepEqual(upstreamFilters[0].typed_config.mutations, { request_mutations: [{ remove: "x-jr2-target" }] });
  assert.deepEqual(
    clusters.map((c) => c.name),
    ["orchestrator", "inbound", "dial", "dial-http", "dial-tls", "dial-tcp", "dial-http-name", "dial-tls-name"],
  );
  const tls = clusters.find((c) => c.name === "dial-tls-name")!;
  assert.deepEqual(
    tls.typed_extension_protocol_options["envoy.extensions.upstreams.http.v3.HttpProtocolOptions"]
      .upstream_http_protocol_options,
    { auto_sni: true, auto_san_validation: true },
  );
  assert.equal(
    tls.transport_socket.typed_config.common_tls_context.validation_context.trusted_ca.filename,
    "/etc/jr2/ca/upstream.crt",
  );
  // Each name is resolved as written: no search domain of the pod.
  assert.equal(
    tls.cluster_type.typed_config.dns_cache_config.typed_dns_resolver_config.typed_config.dns_resolver_options
      .no_default_search_domain,
    true,
  );
  assert.deepEqual(boot.dynamic_resources.lds_config.path_config_source, {
    path: "/run/jr2-custodian/xds/lds.json",
    watched_directory: { path: "/run/jr2-custodian/xds" },
  });
  assert.equal(boot.dynamic_resources.cds_config.path_config_source.path, "/run/jr2-custodian/xds/cds.json");
  assert.ok(CUSTODIAN_POD_ARGS.includes("--drain-time-s"));
  assert.equal(CUSTODIAN_POD_ARGS[CUSTODIAN_POD_ARGS.indexOf("--drain-time-s") + 1], String(CUSTODIAN_DRAIN_SECONDS));
  assert.equal(CUSTODIAN_DRAIN_SECONDS, 60);
  // The program decides each request in a protected call: an error refuses it, and Envoy never lets
  // an unchecked dial through. Its own refusals of a dial say that they are the Custodian's.
  assert.match(CUSTODIAN_PROGRAM, /local ok, err = pcall\(decide, handle, meta, role\)\n  if not ok then/);
  assert.match(
    CUSTODIAN_PROGRAM,
    /refuse\(handle, 503, "error", "the Custodian could not decide this request", mark\)/,
  );
  for (const [reason, mark] of [
    ["not-ready", "not-ready"],
    ["dial", "refused"],
    ["target", "refused"],
  ] as const) {
    assert.match(CUSTODIAN_PROGRAM, new RegExp(`refuse\\(handle, [45]03, "${reason}", "[^"]+", "${mark}"\\)`), reason);
  }
});

test("the LDS and CDS files hold each slot's listener and each address cluster once, and refuse a cluster two slots render differently", () => {
  const slots = THREE_SLOTS.map(renderSlot);
  const twice = renderSlot(inputsOf(4, SANDBOX_MANIFEST, { sandbox: "ticket-z9y8x" }));
  const { lds, cds } = custodianXds([...slots, twice]);
  const names = (lds.resources as Array<{ name: string; "@type": string }>).map((l) => l.name);
  assert.deepEqual(names, ["slot-0", "slot-1", "slot-3", "slot-4"]);
  assert.equal(
    (lds.resources as Array<{ "@type": string }>)[0]!["@type"],
    "type.googleapis.com/envoy.config.listener.v3.Listener",
  );
  const clusterNames = (cds.resources as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(clusterNames, ["tcp|10.0.0.5|8000", "tls|10.0.0.7|8443"], "two slots name one cluster once");
  assert.equal(lds.version_info, cds.version_info);
  assert.equal(custodianXds([...slots, twice]).lds.version_info, lds.version_info);
  const clash = { ...twice, clusters: [{ ...twice.clusters[0]!, connect_timeout: "1s" }] };
  assert.throws(() => custodianXds([...slots, clash]), /render the cluster tcp\|10\.0\.0\.5\|8000 differently/);
  // Two listeners of one name make Envoy refuse the whole update, so every slot would fail.
  const again = renderSlot(inputsOf(4, SANDBOX_MANIFEST, { sandbox: "other-a1b2c" }));
  assert.throws(() => custodianXds([...slots, twice, again]), /slot 4 is rendered twice/);
});

test("a VLAN range is 0 … 30: each of its 128 slots has a VLAN from 2 to 4094 and an address in the segment", () => {
  assert.equal(slotVlan(0, 0), 2);
  assert.equal(slotVlan(30, 127), 3969);
  assert.equal(slotAddress(RANGES.segment, slotVlan(30, 127)), "198.19.15.129");
  for (const range of [31, -1, 1000, 1.5, Number.NaN]) {
    assert.throws(() => slotVlan(range, 0), /VLAN range .* is not 0 … 30/, String(range));
    assert.throws(
      () => custodianPodBootstrap({ orchestrator: { host: "o", port: 4000 }, range, ranges: RANGES }),
      /VLAN range .* is not 0 … 30/,
      String(range),
    );
  }
  for (const slot of [-1, 128, 0.5]) assert.throws(() => slotVlan(0, slot), /slot .* is not 0 … 127/, String(slot));
  assert.doesNotThrow(() =>
    custodianPodBootstrap({ orchestrator: { host: "o", port: 4000 }, range: 30, ranges: RANGES }),
  );
});

test("size: 128 slots of 30 entries each, rendered into the LDS and CDS files, with no Intercepted host and with 5 of 30 (risk 4 of the plan)", (t) => {
  for (const intercepted of [0, 5]) {
    const started = performance.now();
    const slots = manySlots(128, 30, intercepted).map(renderSlot);
    const { lds, cds } = custodianXds(slots);
    const ms = performance.now() - started;
    const ldsBytes = Buffer.byteLength(JSON.stringify(lds));
    const cdsBytes = Buffer.byteLength(JSON.stringify(cds));
    const luaBytes = slots.reduce((n, s) => n + Buffer.byteLength(s.lua.text), 0);
    const chains = slots.reduce((n, s) => n + chainsOf(s).length, 0);
    const one = Buffer.byteLength(JSON.stringify(slots[5]!.listener));
    const line = `128 slots x 30 entries, ${intercepted} Intercepted with a bound secret: lds ${ldsBytes} bytes, cds ${cdsBytes} bytes, lua ${luaBytes} bytes, ${chains} filter chains, one listener ${one} bytes, rendered in ${Math.round(ms)} ms`;
    t.diagnostic(line);
    console.log(`jr2.custodian-rules size: ${line}`);
    // A ceiling, so that a change that makes each slot much larger is seen: the Custodian pod writes
    // this file into memory and Envoy parses it whole on each change.
    assert.ok(ldsBytes < 24 * 1024 * 1024, `the LDS file is ${ldsBytes} bytes`);
    if (intercepted > 0) {
      assert.equal((slots[5]!.lua.text.match(/^HELD\.targets\[/gm) ?? []).length, intercepted);
    }
  }
});
