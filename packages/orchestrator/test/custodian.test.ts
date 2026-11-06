// The Custodian's configuration (ADR-0059), socket-free: what a pod's maker renders for Envoy and what a
// Harness pod gains from it. The claims only a real engine can check — the swap on the wire, the
// dial guard, streaming, abort — are the Custodian suite's (`packages/cli/test/custodian.docker.ts`).
// What is pinned here is that the rendering says what that suite proves: no admin listener, the
// five agent routes on the control socket and the ask on the fetch listener and nothing else, TLS ended only for bound targets, upstream verified
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
  MAY_HAVE_SENT_FLAGS,
  NOT_SENT_FLAGS,
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
  address?: { socket_address?: { address: string; port_value: number }; pipe?: { path: string; mode: number } };
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

test("nothing held: the control, fetch and health listeners alone — no admin, no xDS, no egress", () => {
  const boot = custodianBootstrap(EMPTY_HELD, ORCH) as Record<string, unknown>;
  assert.equal(boot.admin, undefined, "no admin listener: nothing in the pod can reconfigure or read it");
  assert.equal(boot.dynamic_resources, undefined, "no xDS");
  assert.deepEqual(
    listeners(EMPTY_HELD).map((l) => [l.name, l.address?.socket_address ?? l.address?.pipe]),
    [
      // The agent routes on a Unix socket under `/run/jr2`, which no confined process can make or
      // replace (ADR-0076); the ask alone on loopback.
      ["control", { path: "/run/jr2/custodian/control.sock", mode: 0o666 }],
      ["fetch", { address: "127.0.0.1", port_value: 8081 }],
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

test("the control socket forwards the five agent routes, the fetch listener the ask alone, and each answers the other's routes with 404", () => {
  const routesOf = (name: string) => {
    const hcm = listeners(EMPTY_HELD).find((l) => l.name === name)!.filter_chains[0]!.filters[0]!.typed_config;
    return { hcm, routes: hcm.route_config.virtual_hosts[0].routes as Array<Record<string, any>> };
  };
  const shape = (routes: Array<Record<string, any>>) =>
    routes.map((r) => [r.name, r.match.headers?.[0]?.string_match.exact, r.match.safe_regex?.regex ?? r.match.prefix]);
  const { hcm, routes } = routesOf("control");
  assert.deepEqual(shape(routes), [
    ["surface", "GET", "/agents/[^/]+/surface"],
    ["events", "POST", "/agents/[^/]+/events"],
    ["deliveries", "GET", "/agents/[^/]+/deliveries/[^/]+"],
    ["notices", "POST", "/agents/[^/]+/notices"],
    ["conversation", "POST", "/agents/[^/]+/conversation"],
    ["deny", undefined, "/"],
  ]);
  assert.deepEqual(routes[5]!.direct_response, { status: 404 }, "the ask, and anything else, never leaves here");
  const fetch = routesOf("fetch");
  assert.deepEqual(shape(fetch.routes), [
    ["fetch", "POST", "/fetch"],
    ["deny", undefined, "/"],
  ]);
  assert.deepEqual(fetch.routes[1]!.direct_response, { status: 404 }, "an agent route never leaves from loopback");
  assert.equal(fetch.routes[0]!.route.retry_policy.retry_on, "reset-before-request,connect-failure");
  // A pick retries only a failure before it was sent: the Harness reads the retry limit (`URX`) as a
  // pick that never reached the Orchestrator (ADR-0002), and that holds only while this is so.
  assert.equal(routes[1]!.route.retry_policy.retry_on, "reset-before-request,connect-failure");
  // An Instance ID is ONE encoded path segment: this listener must not refuse its `%2F`.
  assert.equal(hcm.path_with_escaped_slashes_action, "KEEP_UNCHANGED");
  // The rewrite of the ask stays on the route it arrived on.
  const lua = fetch.hcm.http_filters.find((f: { name: string }) => f.name === "envoy.filters.http.lua").typed_config;
  assert.equal(lua.clear_route_cache, false);
});

test("two held secrets: an egress listener on loopback, one internal listener per target, TLS ended with its leaf", () => {
  const all = listeners(TWO);
  assert.deepEqual(
    all.map((l) => l.name),
    [
      "control",
      "fetch",
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
  const script = custodianScript(TWO, { fetch: true });
  // The control credentials (ADR-0076, C3): the control token on the agent routes alone, its secret
  // Stand-in read from the values; the fetch token on the fetch route alone, its Stand-in public.
  assert.match(
    script,
    /HELD\.secrets\[1\] = \{ name = "JR2_CONTROL_TOKEN", headers = \{ "authorization" \}, paths = \{ "\/agents\/" \} \}/,
  );
  assert.match(
    script,
    /HELD\.secrets\[2\] = \{ name = "JR2_SANDBOX_TOKEN", headers = \{ "authorization" \}, standIn = "jr2-held-JR2_SANDBOX_TOKEN", paths = \{ "\/sandboxes\/" \} \}/,
  );
  assert.match(script, /HELD\.control = \{ HELD\.secrets\[1\], HELD\.secrets\[2\] \}/);
  assert.match(
    script,
    /HELD\.secrets\[3\] = \{ name = "ANTHROPIC_API_KEY", headers = \{ "x-api-key" \}, paths = \{ "\/v1\/messages" \} \}/,
  );
  assert.match(script, /HELD\.targets\["litellm\.corp\.example:443"\] = \{ HELD\.secrets\[3\] \}/);
  assert.match(script, /HELD\.targets\["10\.0\.0\.5:8000"\] = \{ HELD\.secrets\[4\] \}/);
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
  assert.ok(
    !/jr2-held-(?!JR2_SANDBOX_TOKEN")/.test(script) && !/sk-/.test(script),
    "never a value, never a secret Stand-in: the public fetch Stand-in alone",
  );
  // Each secret Stand-in is a value too, read beside the secret's own.
  assert.match(CUSTODIAN_PROGRAM, /s\.standIn or load\(s\.name \.\. "\.standin"\)/);
  // A pod that serves no Sandbox — the Instance Harness, a check pod — holds the control token alone.
  const instance = custodianScript(TWO, { fetch: false });
  assert.match(instance, /HELD\.control = \{ HELD\.secrets\[1\] \}/);
  assert.ok(!/JR2_SANDBOX_TOKEN/.test(instance));
  assert.match(instance, /HELD\.secrets\[2\] = \{ name = "ANTHROPIC_API_KEY"/);
});

test("the slot the Harness states goes to the Orchestrator alone: a bound host never gets it (ADR-0076)", () => {
  assert.match(CUSTODIAN_PROGRAM, /local SLOT_HEADER = "x-jr2-slot"/);
  assert.match(CUSTODIAN_PROGRAM, /"proxy-connection", SLOT_HEADER \}\) do headers:remove\(h\) end/);
});

test("composition, nothing held: the Harness gets the Custodian's address and its control Stand-in as a file, and no proxy", () => {
  const c = custodianComposition(EMPTY_HELD, {
    image: "envoy:c1",
    pod: "ws-0123456789abcdef",
    config: "ws-1-custodian",
    credentials: { secret: "ws-1-token" },
    sandbox: "ws-1",
    caBundle: false,
  });
  // No Stand-in in env (C1): the control Stand-in is a file only the Harness container mounts.
  assert.deepEqual(c.harnessEnv, [
    { name: "JR2_CUSTODIAN_URL", value: "http://127.0.0.1:8081" },
    { name: "JR2_CUSTODIAN_SOCKET", value: "/run/jr2/custodian/control.sock" },
    { name: "JR2_CONTROL_STANDIN_FILE", value: "/run/jr2/control/standin" },
  ]);
  assert.deepEqual(c.harnessMounts, [
    { name: "harness-credentials", mountPath: "/run/jr2", readOnly: true },
    { name: "custodian-socket", mountPath: "/run/jr2/custodian", readOnly: true },
  ]);
  assert.deepEqual(
    c.volumes.map((v) => v.name),
    ["custodian-values", "custodian-config", "custodian-socket", "harness-credentials"],
  );
  // The control socket's folder (ADR-0076): an emptyDir that the Custodian writes and the Harness
  // reads, and no other container mounts.
  assert.deepEqual(
    c.volumes.find((v) => v.name === "custodian-socket"),
    { name: "custodian-socket", emptyDir: {} },
  );
  assert.deepEqual(
    (c.custodianContainer as { volumeMounts: unknown[] }).volumeMounts.find(
      (m) => (m as { name: string }).name === "custodian-socket",
    ),
    { name: "custodian-socket", mountPath: "/run/jr2/custodian" },
  );
  // The Custodian's values: the control token and its Stand-in, and the fetch token (C3).
  assert.deepEqual(
    c.volumes.find((v) => v.name === "custodian-values"),
    {
      name: "custodian-values",
      projected: {
        defaultMode: 0o440,
        sources: [
          {
            secret: {
              name: "ws-1-token",
              items: [
                { key: "control-token", path: "JR2_CONTROL_TOKEN" },
                { key: "control-standin", path: "JR2_CONTROL_TOKEN.standin" },
                { key: "token", path: "JR2_SANDBOX_TOKEN" },
              ],
            },
          },
        ],
      },
    },
  );
  // The Harness's: the control Stand-in alone — never a token.
  assert.deepEqual(
    c.volumes.find((v) => v.name === "harness-credentials"),
    {
      name: "harness-credentials",
      projected: {
        defaultMode: 0o440,
        sources: [{ secret: { name: "ws-1-token", items: [{ key: "control-standin", path: "control/standin" }] } }],
      },
    },
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
    credentials: { secret: "jr2-instance-harness-credentials" },
    caBundle: true,
  });
  assert.equal((instance.custodianContainer as { env?: unknown }).env, undefined);
  assert.deepEqual(instance.harnessEnv.at(-1), { name: "NODE_EXTRA_CA_CERTS", value: "/etc/jr2/ca/ca.crt" });
  assert.deepEqual(instance.harnessMounts, [
    { name: "ca", mountPath: "/etc/jr2/ca", readOnly: true },
    { name: "harness-credentials", mountPath: "/run/jr2", readOnly: true },
    { name: "custodian-socket", mountPath: "/run/jr2/custodian", readOnly: true },
  ]);
  // …and so no fetch token: its values hold the control credentials alone.
  const values = JSON.stringify(instance.volumes.find((v) => v.name === "custodian-values"));
  assert.ok(!values.includes("JR2_SANDBOX_TOKEN"), values);
});

test("a pod's Harness gets a Stand-in file for its own manifest's names only, and none in env (C1b)", () => {
  // ADR-0059 "The walk reads definitions, not Turns": a Turn that overrides the model with another
  // provider's finds that provider's key absent, in a Workspace and the Instance Harness alike —
  // never a Stand-in that fails with 401. And no Stand-in rides env at all: a child's env is the
  // Harness's to build (ADR-0076).
  const anthropicOnly: HeldManifest = { version: 1, secrets: [TWO.secrets[0]!] };
  for (const pod of [
    { pod: "ws-0123456789abcdef", config: "ws-1-custodian", credentials: { secret: "ws-1-token" }, sandbox: "ws-1" },
    { pod: "instance", config: "jr2-held-custodian", credentials: { secret: "jr2-instance-harness-credentials" } },
  ]) {
    const c = custodianComposition(anthropicOnly, { image: "envoy:c1", caBundle: false, ...pod });
    assert.ok(!c.harnessEnv.some((e) => e.value?.startsWith("jr2-held-")), `${pod.pod}: no Stand-in in env`);
    for (const other of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "JR2_PROVIDER_API_KEY", "JR2_SANDBOX_TOKEN"]) {
      assert.ok(!c.harnessEnv.some((e) => e.name === other), `${pod.pod}: no ${other} at all`);
    }
    const files = (c.volumes.find((v) => v.name === "harness-credentials") as any).projected.sources[0].secret.items;
    assert.deepEqual(files, [
      { key: "control-standin", path: "control/standin" },
      { key: "standin-ANTHROPIC_API_KEY", path: "standins/ANTHROPIC_API_KEY" },
    ]);
    const values = (c.volumes.find((v) => v.name === "custodian-values") as any).projected.sources[0].secret.items;
    assert.deepEqual(values.at(-1), { key: "standin-ANTHROPIC_API_KEY", path: "ANTHROPIC_API_KEY.standin" });
  }
});

test("the granted secrets ride the Harness env by name, and only names its manifest holds (ADR-0076)", () => {
  const c = custodianComposition(TWO, {
    image: "envoy:c1",
    pod: "ws-0123456789abcdef",
    config: "ws-1-custodian",
    credentials: { secret: "ws-1-token" },
    sandbox: "ws-1",
    caBundle: false,
    granted: [TWO.secrets[1]!.name, "NOT_HELD"],
  });
  assert.deepEqual(
    c.harnessEnv.find((e) => e.name === "JR2_GRANTED_SECRETS"),
    { name: "JR2_GRANTED_SECRETS", value: TWO.secrets[1]!.name },
  );
});

test("reads: a Custodian reads the Instance's objects by default, and the check pod's own copies by name", () => {
  const literal = (name: string) => ({ ...TWO.secrets[0]!, name, source: { kind: "literal" as const } });
  const held: HeldManifest = { version: 1, secrets: [literal("ANTHROPIC_API_KEY")] };
  const opts = { image: "envoy:c1", caBundle: false, pod: "instance", config: "c", credentials: { secret: "t" } };
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
    "harness-credentials",
    "t",
  ]);
  const own = custodianComposition(held, {
    ...opts,
    reads: { literals: "p", tls: "p-tls", trust: "p-ca", program: "p" },
  });
  assert.deepEqual(names(own), ["t", "p", "c", "p", "p-tls", "p-ca", "p-ca", "harness-credentials", "t"]);
});

test("the rendered config is JSON a ConfigMap can carry, and names no value", () => {
  const text = JSON.stringify(custodianBootstrap(TWO, ORCH));
  assert.ok(text.length < 64 * 1024);
  assert.ok(!/jr2-held-/.test(text), "no Stand-in either: the bootstrap routes; the script decides");
});

test("the Orchestrator's unreachable answer names every Envoy flag of a stream it did not complete, its own resets included (ADR-0002)", () => {
  for (const name of ["control", "fetch"]) {
    const listener = listeners(EMPTY_HELD).find((l) => l.name === name)!;
    const hcm = listener.filter_chains[0]!.filters[0]!.typed_config;
    const flags = hcm.local_reply_config.mappers[0].filter.response_flag_filter.flags as string[];
    assert.deepEqual([...flags].sort(), ["DF", "DPE", "LR", "UC", "UF", "UH", "UMSDR", "UPE", "UR", "URX"], name);
  }
});

test("an intercepted target that gave no answer has two 502 texts, one per flag group, and the tunnel has one (ADR-0059)", () => {
  type Mapper = {
    filter: { response_flag_filter: { flags: string[] } };
    status_code: number;
    body_format_override: { text_format_source: { inline_string: string } };
  };
  const hcmOf = (name: string) =>
    listeners(TWO).find((l) => l.name === name)!.filter_chains[0]!.filters[0]!.typed_config;
  const leaf = TWO.secrets[0]!.hosts[0]!;
  const target = `${leaf.host}:${leaf.port}`;
  const intercept = hcmOf(`intercept-${leaf.leaf}`).local_reply_config.mappers as Mapper[];
  const details = "%RESPONSE_CODE_DETAILS% %UPSTREAM_TRANSPORT_FAILURE_REASON%\n";
  assert.deepEqual(
    intercept.map((m) => [
      m.status_code,
      m.filter.response_flag_filter.flags,
      m.body_format_override.text_format_source.inline_string,
    ]),
    [
      [502, ["UF", "UH", "DF"], `jr2 custodian: ${target} could not be reached: ${details}`],
      [
        502,
        ["UC", "DPE", "UMSDR", "URX", "UPE", "UR", "LR"],
        `jr2 custodian: ${target} did not answer; the request may have reached it: ${details}`,
      ],
    ],
  );
  // One reply can carry several flags, and Envoy uses the first mapper that matches any of them, in
  // order. `URX` comes with the last attempt's own flag: `UF,URX` was never sent, `UC,URX` may have
  // been.
  const textFor = (flags: string[]) =>
    intercept
      .find((m) => m.filter.response_flag_filter.flags.some((f) => flags.includes(f)))
      ?.body_format_override.text_format_source.inline_string.split(": %")[0];
  assert.equal(textFor(["UF", "URX"]), `jr2 custodian: ${target} could not be reached`);
  assert.equal(textFor(["UC", "URX"]), `jr2 custodian: ${target} did not answer; the request may have reached it`);
  assert.equal(textFor(["UH"]), `jr2 custodian: ${target} could not be reached`);
  assert.equal(textFor(["UPE"]), `jr2 custodian: ${target} did not answer; the request may have reached it`);

  // The tunnel: a 502 comes before its 200, so before any byte of the request. One text, every flag.
  const egress = hcmOf("egress").local_reply_config.mappers as Mapper[];
  const tunnel = egress.filter((m) => m.status_code === 502);
  assert.equal(tunnel.length, 1);
  assert.deepEqual(
    [...tunnel[0]!.filter.response_flag_filter.flags].sort(),
    [...NOT_SENT_FLAGS, ...MAY_HAVE_SENT_FLAGS].sort(),
  );
  assert.equal(
    tunnel[0]!.body_format_override.text_format_source.inline_string,
    `jr2 custodian: %REQ(:AUTHORITY)% could not be reached: ${details}`,
  );

  // The Orchestrator route keeps one list, the union of the two.
  const control = hcmOf("control").local_reply_config.mappers as Mapper[];
  assert.deepEqual(control[0]!.filter.response_flag_filter.flags, [...NOT_SENT_FLAGS, ...MAY_HAVE_SENT_FLAGS]);
});
