// The Custodian's configuration (ADR-0059), socket-free: what a pod's maker renders for Envoy and what a
// Harness pod gains from it. The claims only a real engine can check — the swap on the wire, the
// dial guard, streaming, abort — are the Custodian suite's (`packages/cli/test/custodian.docker.ts`).
// What is pinned here is that the rendering says what that suite proves: no admin listener, the
// three control routes and nothing else, TLS ended only for bound targets, upstream verified
// against `upstream.crt` alone, and never a value anywhere in what a ConfigMap carries.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CUSTODIAN_ARGS,
  custodianBootstrap,
  custodianComposition,
  custodianRef,
  custodianScript,
  CUSTODIAN_IMAGE,
  CUSTODIAN_PROGRAM,
} from "../src/custodian.ts";
import { EMPTY_HELD, leafStem, type HeldManifest } from "../src/held-secrets.ts";

const ORCH = { host: "jr2-orchestrator.ns.svc", port: 4000 };

const TWO: HeldManifest = {
  version: 1,
  secrets: [
    {
      name: "ANTHROPIC_API_KEY",
      source: { kind: "literal" },
      hosts: [{ host: "litellm.corp.example", port: 443, leaf: leafStem("litellm.corp.example", 443) }],
      headers: ["x-api-key"],
      paths: ["/v1/messages"],
    },
    {
      name: "JR2_PROVIDER_API_KEY",
      source: { kind: "literal" },
      hosts: [{ host: "10.0.0.5", port: 8000, leaf: leafStem("10.0.0.5", 8000) }],
      headers: ["authorization"],
    },
  ],
};

type Listener = {
  name: string;
  address?: { socket_address: { address: string; port_value: number } };
  internal_listener?: object;
  filter_chains: Array<{
    transport_socket?: { typed_config: Record<string, any> };
    filters: Array<{ typed_config: Record<string, any> }>;
  }>;
};
const listeners = (m: HeldManifest) =>
  (custodianBootstrap(m, ORCH) as { static_resources: { listeners: Listener[] } }).static_resources.listeners;
const clusters = (m: HeldManifest) =>
  (custodianBootstrap(m, ORCH) as { static_resources: { clusters: Array<Record<string, any>> } }).static_resources
    .clusters;

test("the image is upstream Envoy pinned by digest, re-homed by kitRegistry like a Kit image", () => {
  assert.match(CUSTODIAN_IMAGE.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(custodianRef(), `docker.io/envoyproxy/envoy:${CUSTODIAN_IMAGE.tag}@${CUSTODIAN_IMAGE.digest}`);
  assert.equal(
    custodianRef("zot.example.test/"),
    `zot.example.test/envoy:${CUSTODIAN_IMAGE.tag}@${CUSTODIAN_IMAGE.digest}`,
  );
  assert.deepEqual(CUSTODIAN_ARGS.slice(0, 2), ["-c", "/etc/jr2/custodian/config/envoy.json"]);
  assert.ok(CUSTODIAN_ARGS.includes("--disable-hot-restart"));
});

test("nothing held: the control and health listeners alone — no admin, no xDS, no egress", () => {
  const boot = custodianBootstrap(EMPTY_HELD, ORCH) as Record<string, unknown>;
  assert.equal(boot.admin, undefined, "no admin listener: nothing in the pod can reconfigure or read it");
  assert.equal(boot.dynamic_resources, undefined, "no xDS");
  assert.deepEqual(
    listeners(EMPTY_HELD).map((l) => [l.name, l.address?.socket_address]),
    [
      ["control", { address: "127.0.0.1", port_value: 8081 }],
      ["health", { address: "0.0.0.0", port_value: 15021 }],
    ],
  );
  assert.deepEqual(
    clusters(EMPTY_HELD).map((c) => c.name),
    ["orchestrator"],
  );
  const orchestrator = clusters(EMPTY_HELD)[0]!;
  assert.deepEqual(orchestrator.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address, {
    address: "jr2-orchestrator.ns.svc",
    port_value: 4000,
  });
});

test("the control listener forwards four routes — the Menu's two, a pick's answer, and the ask — and answers the rest itself", () => {
  const control = listeners(EMPTY_HELD).find((l) => l.name === "control")!;
  const hcm = control.filter_chains[0]!.filters[0]!.typed_config;
  const routes = hcm.route_config.virtual_hosts[0].routes as Array<Record<string, any>>;
  assert.deepEqual(
    routes.map((r) => [r.name, r.match.headers?.[0]?.string_match.exact, r.match.safe_regex?.regex ?? r.match.prefix]),
    [
      ["surface", "GET", "/agents/[^/]+/surface"],
      ["events", "POST", "/agents/[^/]+/events"],
      ["deliveries", "GET", "/agents/[^/]+/deliveries/[^/]+"],
      ["fetch", "POST", "/fetch"],
      ["deny", undefined, "/"],
    ],
  );
  assert.deepEqual(routes[4]!.direct_response, { status: 404 }, "anything else never reaches the Orchestrator");
  // A pick retries only a failure before it was sent: the Harness reads the retry limit (`URX`) as a
  // pick that never reached the Orchestrator (ADR-0002), and that holds only while this is so.
  assert.equal(routes[1]!.route.retry_policy.retry_on, "reset-before-request,connect-failure");
  // An Instance ID is ONE encoded path segment: this listener must not refuse its `%2F`.
  assert.equal(hcm.path_with_escaped_slashes_action, "KEEP_UNCHANGED");
  // The rewrite of the ask stays on the route it arrived on.
  const lua = hcm.http_filters.find((f: { name: string }) => f.name === "envoy.filters.http.lua").typed_config;
  assert.equal(lua.clear_route_cache, false);
});

test("two held secrets: an egress listener on loopback, one internal listener per target, TLS ended with its leaf", () => {
  const all = listeners(TWO);
  assert.deepEqual(
    all.map((l) => l.name),
    [
      "control",
      "health",
      "egress",
      `intercept-${TWO.secrets[0]!.hosts[0]!.leaf}`,
      `intercept-${TWO.secrets[1]!.hosts[0]!.leaf}`,
    ],
  );
  assert.deepEqual(all.find((l) => l.name === "egress")!.address!.socket_address, {
    address: "127.0.0.1",
    port_value: 15001,
  });
  const egress = all.find((l) => l.name === "egress")!.filter_chains[0]!.filters[0]!.typed_config;
  assert.deepEqual(
    egress.route_config.virtual_hosts.map((v: { domains: string[] }) => v.domains),
    [["litellm.corp.example:443"], ["10.0.0.5:8000"], ["*"]],
    "the interception set is the bound targets; every other target is the tunnel",
  );
  const intercept = all.find((l) => l.name === `intercept-${leafStem("litellm.corp.example", 443)}`)!;
  assert.ok(intercept.internal_listener, "reachable from the egress listener alone, never from the network");
  const tls = intercept.filter_chains[0]!.transport_socket!.typed_config.common_tls_context;
  assert.deepEqual(tls.alpn_protocols, ["http/1.1"]);
  assert.equal(
    tls.tls_certificates[0].certificate_chain.filename,
    `/etc/jr2/custodian/tls/${leafStem("litellm.corp.example", 443)}.crt`,
  );
  const hcm = intercept.filter_chains[0]!.filters[0]!.typed_config;
  assert.equal(hcm.path_with_escaped_slashes_action, "REJECT_REQUEST", "an encoded / toward a bound host is a 400");
  // It adds nothing to a request or a response.
  assert.equal(hcm.server_header_transformation, "PASS_THROUGH");
  assert.equal(hcm.generate_request_id, false);
  assert.equal(hcm.skip_xff_append, true);
  assert.ok(hcm.route_config.request_headers_to_remove.includes("x-forwarded-proto"));
  assert.equal(hcm.http_filters.at(-1).typed_config.suppress_envoy_headers, true);
  assert.equal(
    hcm.route_config.virtual_hosts[0].routes[0].route.timeout,
    "0s",
    "an LLM stream has no total time limit",
  );
});

test("upstream is verified against upstream.crt and the target's own name — DNS or IP — and never the jr2 CA", () => {
  const ups = clusters(TWO).filter((c) => String(c.name).startsWith("upstream-"));
  assert.deepEqual(
    ups.map((c) => {
      const tls = c.transport_socket.typed_config;
      return [c.type, tls.sni, tls.common_tls_context.validation_context.match_typed_subject_alt_names[0]];
    }),
    [
      ["LOGICAL_DNS", "litellm.corp.example", { san_type: "DNS", matcher: { exact: "litellm.corp.example" } }],
      ["STATIC", undefined, { san_type: "IP_ADDRESS", matcher: { exact: "10.0.0.5" } }],
    ],
  );
  for (const c of ups) {
    assert.deepEqual(c.transport_socket.typed_config.common_tls_context.validation_context.trusted_ca, {
      filename: "/etc/jr2/ca/upstream.crt",
    });
    assert.equal(c.connect_timeout, "30s");
  }
});

test("the script: a generated table of names, headers, paths and targets, then dofile of the program — never a value", () => {
  const script = custodianScript(TWO);
  assert.match(script, /HELD\.secrets\[1\] = \{ name = "JR2_SANDBOX_TOKEN", headers = \{ "authorization" \} \}/);
  assert.match(
    script,
    /HELD\.secrets\[2\] = \{ name = "ANTHROPIC_API_KEY", headers = \{ "x-api-key" \}, paths = \{ "\/v1\/messages" \} \}/,
  );
  assert.match(script, /HELD\.targets\["litellm\.corp\.example:443"\] = \{ HELD\.secrets\[2\] \}/);
  assert.match(script, /HELD\.targets\["10\.0\.0\.5:8000"\] = \{ HELD\.secrets\[3\] \}/);
  assert.match(script, /hosts = 2 \}/);
  assert.match(
    script,
    /HELD\.credential = \{ "authorization", "x-api-key", "x-goog-api-key", "api-key", "proxy-authorization" \}/,
  );
  // The fixed half is not copied per pod: the table ends by loading the program from the config
  // mount, where every pod's volume projects it from `jr2-held` (one copy per Instance).
  assert.match(script, /\ndofile\("\/etc\/jr2\/custodian\/config\/program\.lua"\)\n$/);
  assert.ok(!/function envoy_on_request/.test(script), "the program is loaded, never inlined");
  assert.ok(script.length < 2048, `a pod's own script stays small: ${script.length} bytes`);
  assert.match(CUSTODIAN_PROGRAM, /function envoy_on_request/);
  // The values are read from the mounted files at start; the program names only where.
  assert.match(CUSTODIAN_PROGRAM, /\/etc\/jr2\/custodian\/values\//);
  assert.ok(!/jr2-held-/.test(script) && !/sk-/.test(script), "never a value, never a Stand-in");
});

test("composition, nothing held: the Harness gets the Custodian's address and the token's Stand-in, and no proxy", () => {
  const c = custodianComposition(EMPTY_HELD, {
    image: "envoy:c1",
    pod: "ws-0123456789abcdef",
    config: "ws-1-custodian",
    token: { secret: "ws-1-token", key: "JR2_SANDBOX_TOKEN" },
    sandbox: "ws-1",
    caBundle: false,
  });
  assert.deepEqual(c.harnessEnv, [
    { name: "JR2_CUSTODIAN_URL", value: "http://127.0.0.1:8081" },
    { name: "JR2_SANDBOX_TOKEN", value: "jr2-held-JR2_SANDBOX_TOKEN" },
  ]);
  assert.deepEqual(c.harnessMounts, []);
  assert.deepEqual(
    c.volumes.map((v) => v.name),
    ["custodian-values", "custodian-config"],
  );
  assert.deepEqual((c.custodianContainer as { env: unknown }).env, [{ name: "JR2_SANDBOX", value: "ws-1" }]);
  // Its own pod's bootstrap and script, from the ConfigMap its maker rendered, under the names
  // Envoy is started with — beside the one program every pod shares, from `jr2-held` (ADR-0059).
  assert.deepEqual(
    c.volumes.find((v) => v.name === "custodian-config"),
    {
      name: "custodian-config",
      projected: {
        sources: [
          {
            configMap: {
              name: "ws-1-custodian",
              items: [
                { key: "envoy.json", path: "envoy.json" },
                { key: "custodian.lua", path: "custodian.lua" },
              ],
            },
          },
          { configMap: { name: "jr2-held", items: [{ key: "program.lua", path: "program.lua" }] } },
        ],
      },
    },
  );
  // The Instance Harness has no Sandbox, so no name to address an ask by.
  const instance = custodianComposition(EMPTY_HELD, {
    image: "envoy:c1",
    pod: "instance",
    config: "jr2-held-custodian",
    token: { secret: "jr2-instance", key: "JR2_INSTANCE_HARNESS_TOKEN" },
    caBundle: true,
  });
  assert.equal((instance.custodianContainer as { env?: unknown }).env, undefined);
  assert.deepEqual(instance.harnessEnv.at(-1), { name: "NODE_EXTRA_CA_CERTS", value: "/etc/jr2/ca/ca.crt" });
  assert.deepEqual(instance.harnessMounts, [{ name: "ca", mountPath: "/etc/jr2/ca", readOnly: true }]);
});

test("a pod's Harness gets a Stand-in for its own manifest's names only — a provider no definition there names has no variable", () => {
  // ADR-0059 "The walk reads definitions, not Turns": a Turn that overrides the model with another
  // provider's finds that provider's key variable absent, in a Workspace and the Instance Harness
  // alike — never a Stand-in that fails with 401.
  const anthropicOnly: HeldManifest = { version: 1, secrets: [TWO.secrets[0]!] };
  for (const pod of [
    {
      pod: "ws-0123456789abcdef",
      config: "ws-1-custodian",
      token: { secret: "ws-1-token", key: "JR2_SANDBOX_TOKEN" },
      sandbox: "ws-1",
    },
    {
      pod: "instance",
      config: "jr2-held-custodian",
      token: { secret: "jr2-instance", key: "JR2_INSTANCE_HARNESS_TOKEN" },
    },
  ]) {
    const c = custodianComposition(anthropicOnly, { image: "envoy:c1", caBundle: false, ...pod });
    const standIns = c.harnessEnv.filter((e) => e.value?.startsWith("jr2-held-")).map((e) => e.name);
    assert.deepEqual(standIns, ["JR2_SANDBOX_TOKEN", "ANTHROPIC_API_KEY"], pod.pod);
    for (const other of ["OPENAI_API_KEY", "JR2_PROVIDER_API_KEY"]) {
      assert.ok(!c.harnessEnv.some((e) => e.name === other), `${pod.pod}: no ${other} at all`);
    }
  }
});

test("shared: a Custodian reads the Instance's objects by default, and the preflight's own copies by name", () => {
  const literal = (name: string) => ({ ...TWO.secrets[0]!, name, source: { kind: "literal" as const } });
  const held: HeldManifest = { version: 1, secrets: [literal("ANTHROPIC_API_KEY")] };
  const opts = { image: "envoy:c1", caBundle: false, pod: "instance", config: "c", token: { secret: "t", key: "k" } };
  const names = (c: ReturnType<typeof custodianComposition>) =>
    JSON.stringify(c.volumes)
      .match(/"(?:name|secretName)":"[^"]+"/g)!
      .map((m) => m.split(":")[1]!.replaceAll('"', ""))
      .filter((n) => !n.startsWith("custodian-") && n !== "ca");
  assert.deepEqual(names(custodianComposition(held, opts)), [
    "t",
    "jr2-held-secrets-instance",
    "c",
    "jr2-held",
    "jr2-held-tls",
    "jr2-ca",
    "jr2-ca",
  ]);
  const own = custodianComposition(held, {
    ...opts,
    shared: { literals: "p", tls: "p-tls", trust: "p-ca", program: "p" },
  });
  assert.deepEqual(names(own), ["t", "p", "c", "p", "p-tls", "p-ca", "p-ca"]);
});

test("the rendered config is JSON a ConfigMap can carry, and names no value", () => {
  const text = JSON.stringify(custodianBootstrap(TWO, ORCH));
  assert.ok(text.length < 64 * 1024);
  assert.ok(!/jr2-held-/.test(text), "no Stand-in either: the bootstrap routes; the script decides");
});

test("the Orchestrator's unreachable answer names every Envoy flag of a stream it did not complete, its own resets included (ADR-0002)", () => {
  const control = listeners(EMPTY_HELD).find((l) => l.name === "control")!;
  const hcm = control.filter_chains[0]!.filters[0]!.typed_config;
  const flags = hcm.local_reply_config.mappers[0].filter.response_flag_filter.flags as string[];
  assert.deepEqual([...flags].sort(), ["DF", "DPE", "LR", "UC", "UF", "UH", "UMSDR", "UPE", "UR", "URX"]);
});
