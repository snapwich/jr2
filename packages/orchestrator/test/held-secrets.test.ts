// Held secrets (ADR-0059): `heldSecretsOf`, the one function every refusal lives in — R1 to R12,
// each with the config path it names, and never a value in a message — plus the defaults it
// resolves (a known model key's host, from the catalog or from the table), the implicit
// `JR2_PROVIDER_API_KEY`, the three `hosts` forms, and the Stand-in itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { JR2Config } from "../src/config.ts";
import { heldSecretsOf, leafStem, parseTarget, standIn, type HeldLookups } from "../src/held-secrets.ts";

const SECRET = "sk-very-secret-value";

/** Run the rules, and on a refusal hand back the message — asserting it names no value. */
function refusal(config: JR2Config, lookups?: HeldLookups): string {
  try {
    heldSecretsOf(config, lookups);
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(!message.includes(SECRET), `a refusal names no value: ${message}`);
    return message;
  }
  throw new Error("expected a refusal");
}

const held = (entry: Record<string, unknown>, extra: JR2Config["harness"] = {}): JR2Config => ({
  harness: {
    ...extra,
    heldSecrets: [{ name: "GATEWAY_KEY", value: SECRET, hosts: ["gw.example.com"], ...entry } as never],
  },
});

test("the Stand-in: deterministic, public, per name, and never an Anthropic OAuth shape", () => {
  assert.equal(standIn("ANTHROPIC_API_KEY"), "jr2-held-ANTHROPIC_API_KEY");
  assert.notEqual(standIn("A"), standIn("B"));
  assert.match(standIn("JR2_PROVIDER_API_KEY"), /^[A-Za-z0-9_-]+$/);
  assert.ok(!standIn("ANTHROPIC_OAUTH_TOKEN").includes("sk-ant-oat"));
});

test("jr2-upload-pack presents the same Stand-in: the Go literal is standIn(JR2_SANDBOX_TOKEN)", async () => {
  // The User Container gets no env (ADR-0005), so the program carries the Stand-in as a constant —
  // two spellings of one value, pinned here so a rename on one side cannot pass silently.
  const go = await readFile(
    fileURLToPath(new URL("../../../operator/internal/uploadpack/uploadpack.go", import.meta.url)),
    "utf8",
  );
  assert.match(go, new RegExp(`SandboxTokenStandIn = "${standIn("JR2_SANDBOX_TOKEN")}"`));
});

test("a literal is normalized: hosts parsed, the leaf stem derived, default headers, the value kept host-side", () => {
  const { manifest, values, warnings } = heldSecretsOf(held({ paths: ["/v1/messages"] }));
  assert.deepEqual(manifest, {
    version: 1,
    secrets: [
      {
        name: "GATEWAY_KEY",
        source: { kind: "literal" },
        hosts: [{ host: "gw.example.com", port: 443, leaf: leafStem("gw.example.com", 443) }],
        headers: ["authorization", "x-api-key", "x-goog-api-key", "api-key"],
        paths: ["/v1/messages"],
      },
    ],
  });
  assert.deepEqual(values, { GATEWAY_KEY: SECRET });
  assert.ok(!JSON.stringify(manifest).includes(SECRET), "the manifest holds no value");
  assert.deepEqual(warnings, []);
});

test("the three hosts forms, and IP literals — IPv6 compressed and unbracketed", () => {
  assert.deepEqual(parseTarget("x", "api.example.com"), { host: "api.example.com", port: 443 });
  assert.deepEqual(parseTarget("x", "API.Example.com.:8443"), { host: "api.example.com", port: 8443 });
  assert.deepEqual(parseTarget("x", "https://litellm.corp.example/v1/messages"), {
    host: "litellm.corp.example",
    port: 443,
  });
  assert.deepEqual(parseTarget("x", "https://10.0.0.5:8000/v1"), { host: "10.0.0.5", port: 8000 });
  assert.deepEqual(parseTarget("x", "[fd00:0::1]:9443"), { host: "fd00::1", port: 9443 });
  assert.deepEqual(parseTarget("x", "fd00::1"), { host: "fd00::1", port: 443 });
});

test("the implicit JR2_PROVIDER_API_KEY: bound to the custom provider's own host and port", () => {
  const { manifest, values } = heldSecretsOf({
    harness: {
      provider: { id: "vllm", api: "openai-completions", baseUrl: "https://10.0.0.5:8000/v1", apiKey: SECRET },
    },
  });
  assert.deepEqual(
    manifest.secrets.map((s) => [s.name, s.hosts.map((h) => `${h.host}:${h.port}`)]),
    [["JR2_PROVIDER_API_KEY", ["10.0.0.5:8000"]]],
  );
  assert.deepEqual(values, { JR2_PROVIDER_API_KEY: SECRET });
  // No apiKey, nothing held — the keyless endpoint is still keyless.
  assert.deepEqual(
    heldSecretsOf({ harness: { provider: { id: "vllm", api: "openai-completions", baseUrl: "http://llm.lan/v1" } } })
      .manifest.secrets,
    [],
  );
});

test("a known model key with no hosts goes where its provider's calls go: the catalog override, else the table", () => {
  const table = heldSecretsOf({ harness: { heldSecrets: [{ name: "ANTHROPIC_API_KEY", value: SECRET }] } });
  assert.deepEqual(
    table.manifest.secrets[0]!.hosts.map((h) => h.host),
    ["api.anthropic.com"],
  );

  const gateway = heldSecretsOf({
    harness: {
      catalog: { anthropic: { baseUrl: "https://litellm.corp.example" } },
      heldSecrets: [{ name: "ANTHROPIC_API_KEY", value: SECRET, paths: ["/v1/messages"] }],
    },
  });
  assert.deepEqual(gateway.manifest.secrets[0]!.hosts, [
    { host: "litellm.corp.example", port: 443, leaf: leafStem("litellm.corp.example", 443) },
  ]);

  // An explicit hosts wins over both.
  const explicit = heldSecretsOf({
    harness: {
      catalog: { anthropic: { baseUrl: "https://litellm.corp.example" } },
      heldSecrets: [
        { name: "ANTHROPIC_API_KEY", value: SECRET, hosts: ["litellm.corp.example", "backup.corp.example"] },
      ],
    },
  });
  assert.deepEqual(
    explicit.manifest.secrets[0]!.hosts.map((h) => h.host),
    ["litellm.corp.example", "backup.corp.example"],
  );
});

test("R1: a known model key in harness.env — value or valueFrom — is refused with the heldSecrets line", () => {
  assert.match(
    refusal({ harness: { env: [{ name: "ANTHROPIC_API_KEY", value: SECRET }] } }),
    /^harness\.env\[0\] sets ANTHROPIC_API_KEY.*heldSecrets: \[\{ name: "ANTHROPIC_API_KEY", value: process\.env\.ANTHROPIC_API_KEY \}\]/,
  );
  assert.match(
    refusal({
      harness: { env: [{ name: "OPENAI_API_KEY", valueFrom: { secretKeyRef: { name: "team", key: "openai" } } }] },
    }),
    /valueFrom: \{ secretKeyRef: \{ name: "team", key: "openai" \} \}/,
  );
});

test("R1: an envFrom Secret or ConfigMap whose key NAMES include a model key is refused", () => {
  const envFromKeys = new Map([
    ["secret/team", ["GEMINI_API_KEY", "OTHER"]],
    ["configmap/settings", ["LOG_LEVEL"]],
  ]);
  assert.match(
    refusal(
      { harness: { envFrom: [{ configMapRef: { name: "settings" } }, { secretRef: { name: "team" } }] } },
      { envFromKeys },
    ),
    /^harness\.envFrom\[1\] loads Secret "team", which carries GEMINI_API_KEY/,
  );
});

test("warn, never refuse: a signing credential in harness.env names the gateway as the fix", () => {
  const { warnings } = heldSecretsOf({ harness: { env: [{ name: "AWS_SECRET_ACCESS_KEY", value: SECRET }] } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /AWS_SECRET_ACCESS_KEY.*cannot be held.*gateway/);
  assert.ok(!warnings[0]!.includes(SECRET));
});

test("R2: the kit's names are not a held secret's to take", () => {
  for (const name of [
    "JR2_PROVIDER_API_KEY",
    "JR2_ANYTHING",
    "HTTPS_PROXY",
    "no_proxy",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    assert.match(refusal(held({ name })), /^harness\.heldSecrets\[0\]\.name .* is the kit's|not an env var name/);
  }
  assert.match(refusal(held({ name: "lower_case" })), /not an env var name/);
});

test("R3: one name held twice, or held and set by harness.env", () => {
  assert.match(
    refusal({
      harness: {
        heldSecrets: [
          { name: "K", value: SECRET, hosts: ["a.example"] },
          { name: "K", value: SECRET, hosts: ["b.example"] },
        ],
      },
    }),
    /harness\.heldSecrets\[1\]\.name K is held twice/,
  );
  assert.match(
    refusal({
      harness: { env: [{ name: "K", value: "x" }], heldSecrets: [{ name: "K", value: SECRET, hosts: ["a.example"] }] },
    }),
    /also set by harness\.env/,
  );
});

test("R4: exactly one source, a present value, and one a header can carry", () => {
  assert.match(
    refusal(held({ value: undefined })),
    /needs exactly one of value or valueFrom.*GATEWAY_KEY has neither.*\.env/s,
  );
  assert.match(refusal(held({ valueFrom: { secretKeyRef: { name: "s", key: "k" } } })), /not both/);
  assert.match(refusal(held({ value: "" })), /\.value is empty/);
  assert.match(refusal(held({ value: `${SECRET}\n` })), /outside printable ASCII.*not shown/s);
  assert.match(refusal(held({ value: ` ${SECRET}` })), /leading or trailing space/);
  assert.match(refusal(held({ value: "a\rb" })), /outside printable ASCII/);
});

test("R5: hosts must be given where no default exists, exact, TLS, and one header per host per secret", () => {
  assert.match(refusal(held({ hosts: undefined })), /hosts is absent, and GATEWAY_KEY has no single default host/);
  assert.match(refusal(held({ hosts: [] })), /hosts is empty/);
  // A known name whose table host is regional has no default either.
  assert.match(
    refusal({ harness: { heldSecrets: [{ name: "MOONSHOT_API_KEY", value: SECRET }] } }),
    /no single default host/,
  );
  for (const [entry, why] of [
    ["*.example.com", /wildcard/],
    ["http://gw.example.com", /not https/],
    ["https://user:pw@gw.example.com", /userinfo/],
    ["gw.example.com/v1", /path/],
    ["gw.example.com:0", /outside 1–65535/],
    ["gw.example.com:70000", /outside 1–65535/],
    ["gw_example.com", /not a DNS name/],
  ] as const) {
    assert.match(refusal(held({ hosts: [entry] })), why, entry);
  }
  assert.match(
    refusal({
      harness: {
        heldSecrets: [
          { name: "A_KEY", value: SECRET, hosts: ["gw.example.com"], headers: ["authorization", "x-api-key"] },
          { name: "B_KEY", value: SECRET, hosts: ["https://gw.example.com/other"], headers: ["x-api-key"] },
        ],
      },
    }),
    /B_KEY and A_KEY are both bound to gw\.example\.com:443 in header x-api-key/,
  );
});

test("R6: a header that frames or routes the request cannot carry a secret; duplicates neither", () => {
  for (const header of [
    "host",
    "content-length",
    "transfer-encoding",
    "cookie",
    "proxy-authorization",
    "X-Api-Key",
    "a b",
  ]) {
    assert.match(refusal(held({ headers: [header] })), /headers\[0\] .* cannot carry a held secret/, header);
  }
  assert.match(refusal(held({ headers: ["x-api-key", "x-api-key"] })), /lists "x-api-key" twice/);
});

test("R7: the custom provider's key and a catalog gateway need https", () => {
  assert.match(
    refusal({
      harness: { provider: { id: "v", api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1", apiKey: SECRET } },
    }),
    /^harness\.provider\.apiKey is set, and harness\.provider\.baseUrl is not https:\/\//,
  );
  assert.match(
    refusal({ harness: { catalog: { anthropic: { baseUrl: "http://litellm.lan" } } } }),
    /catalog\.anthropic\.baseUrl must be an https:\/\/ URL/,
  );
  // In-cluster `.env` reads `""` — which `jr2 up`, host-side, refuses the same way.
  assert.match(refusal({ harness: { catalog: { anthropic: { baseUrl: "" } } } }), /must be an https:\/\/ URL/);
});

test("R8: a catalog key must be a provider with a known key, and not the custom provider's id", () => {
  assert.match(
    refusal({ harness: { catalog: { anthropik: { baseUrl: "https://x.example" } } } }),
    /"anthropik" is not a pi catalog provider/,
  );
  assert.match(
    refusal({
      harness: {
        provider: { id: "openai", api: "openai-completions", baseUrl: "https://x.example/v1" },
        catalog: { openai: { baseUrl: "https://y.example/v1" } },
      },
    }),
    /"openai" is also harness\.provider\.id/,
  );
});

test("R9: an explicit hosts that leaves out where a carried Agent's provider sends its calls", () => {
  const config: JR2Config = {
    harness: { heldSecrets: [{ name: "ANTHROPIC_API_KEY", value: SECRET, hosts: ["litellm.corp.example"] }] },
  };
  assert.match(
    refusal(config, { models: ["anthropic/claude-sonnet-4-6"] }),
    /hosts leaves out api\.anthropic\.com, where pi sends every "anthropic\/…" turn/,
  );
  // No Agent names an anthropic model: nothing would reach that host, so nothing to refuse.
  assert.equal(heldSecretsOf(config, { models: ["vllm/qwen"] }).manifest.secrets.length, 1);
});

test("R10: a referenced Secret or key that does not exist", () => {
  const ref = { name: "team", key: "anthropic" };
  const config: JR2Config = {
    harness: { heldSecrets: [{ name: "ANTHROPIC_API_KEY", valueFrom: { secretKeyRef: ref } }] },
  };
  assert.match(refusal(config, { secretKeys: () => undefined }), /names Secret "team", which does not exist/);
  assert.match(
    refusal(config, { secretKeys: () => ["openai"] }),
    /names key "anthropic" of Secret "team", which has no such key/,
  );
  const { manifest, values } = heldSecretsOf(config, { secretKeys: () => ["anthropic"] });
  assert.deepEqual(manifest.secrets[0]!.source, { kind: "secret", secret: "team", key: "anthropic" });
  assert.deepEqual(values, {}, "a referenced value is never read");
});

test("R11: while a secret is held, harness.env may not set the proxy or the trust variables", () => {
  assert.match(
    refusal(held({}, { env: [{ name: "HTTPS_PROXY", value: "http://corp-proxy:3128" }] })),
    /harness\.env\[0\] sets HTTPS_PROXY/,
  );
  // Nothing held: the mechanism is not running, so its names are the user's.
  assert.equal(
    heldSecretsOf({ harness: { env: [{ name: "HTTPS_PROXY", value: "http://p" }] } }).manifest.secrets.length,
    0,
  );
});

test("R12: a path prefix nothing can step around", () => {
  for (const path of ["v1/messages", "/v1/../admin", "/v1/%2e%2e/admin", "/v1%2Fadmin", '/v1"x']) {
    assert.match(refusal(held({ paths: [path] })), /paths\[0\]/, path);
  }
});
