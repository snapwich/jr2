// The Egress list (ADR-0084): what a Harness pod may reach through the Fence. The author's two
// forms, the defaults (no port: 443 and 80), the wildcards (TLS and HTTP only, each with a
// warning), the refusals of an address, the Fence's own ranges, and the per-pod derivation: a
// `workspace()` list replaces the Instance's, a bound host needs no entry and is Intercepted, a
// host jr2 uses with no secret needs an entry, and an SSH Repo gets its port.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type JR2Config } from "../src/config.ts";
import {
  checkFence,
  egressRulesOf,
  egressWarnings,
  parseEgressList,
  permits,
  sshHostOf,
  uncarriedHosts,
  type EgressRule,
} from "../src/egress.ts";
import { bearer, file, http, secret, text } from "../src/http-effect.ts";
import { placementWalkOf } from "../src/assembly-checks.ts";
import { heldSecretsOf, readHeldManifest, workspaceHeldPod } from "../src/held-secrets.ts";
import { refuseEffectSecrets, secretPlacementsOf, type PlacementWalk } from "../src/secret-placement.ts";
import { workspacePodsOf, type CarriedEffect, type WorkspacePod } from "../src/parts.ts";
import { jr2Setup } from "../src/setup.ts";
import { workspace } from "../src/workspace.ts";
import { customize } from "../src/customize.ts";

const FORMS =
  'an entry is "host", "host:port", "*.domain", "*", "a.b.c.d:port", or { host, port?, intercept: true } (ADR-0084)';

const ws = (pod: Partial<WorkspacePod> = {}, workflow = "ticket") => ({
  workflow,
  pod: { path: [], route: [], secrets: [], models: [], effects: [], bindings: {}, ...pod } as WorkspacePod,
});
const walk = (w: Partial<PlacementWalk>): PlacementWalk => ({ effects: [], workspaces: [], ...w });
const ROOT = workspaceHeldPod({ workflow: "ticket", route: [] });

/** What `jr2 up` writes for each pod: the placement, the Held secrets, then the rules. */
function rulesOf(config: JR2Config, w: PlacementWalk): Record<string, EgressRule[]> {
  const placements = secretPlacementsOf(config, w);
  const { manifest } = heldSecretsOf(config, placements.claimed);
  return Object.fromEntries(
    placements.held.map((p) => [
      p.pod,
      egressRulesOf({
        ...p.egress,
        held: manifest.secrets.filter((b) => p.names.includes(b.name)).flatMap((b) => b.hosts),
      }),
    ]),
  );
}

const rule = (host: string, port: number, extra: Partial<EgressRule> = {}): EgressRule => ({
  host,
  port,
  match: "name",
  intercept: false,
  from: ["entry"],
  ...extra,
});

test("both entry forms parse; an entry with no port permits 443 and 80", () => {
  assert.deepEqual(
    parseEgressList("egress", ["GitHub.com.", "registry.npmjs.org:8443", { host: "pypi.org", intercept: true }]),
    [
      { at: "egress[0]", host: "github.com", match: "name", ports: [443, 80], intercept: false },
      { at: "egress[1]", host: "registry.npmjs.org", match: "name", ports: [8443], intercept: false },
      { at: "egress[2]", host: "pypi.org", match: "name", ports: [443, 80], intercept: true },
    ],
  );
  assert.deepEqual(parseEgressList("egress", [{ host: "10.0.0.5", port: 8000, intercept: true }]), [
    { at: "egress[0]", host: "10.0.0.5", match: "address", ports: [8000], intercept: true },
  ]);
  assert.deepEqual(
    egressRulesOf({ list: parseEgressList("egress", ["github.com"]), held: [], effector: [], repos: [] }),
    [rule("github.com", 80), rule("github.com", 443)],
  );
});

test("a `*.` entry and `*` are marked TLS and HTTP only, and permit names alone", () => {
  const list = parseEgressList("egress", ["*.example.com", "*"]);
  assert.deepEqual(
    list.map((i) => [i.match, i.host]),
    [
      ["below", "example.com"],
      ["any", "*"],
    ],
  );
  const rules = egressRulesOf({ list, held: [], effector: [], repos: [] });
  assert.ok(
    rules.every((r) => r.tlsHttpOnly === true),
    "each wildcard rule is TLS and HTTP only",
  );
  assert.ok(permits(list[0]!, "api.example.com", 443));
  assert.ok(!permits(list[0]!, "example.com", 443), "a `*.` entry permits the names below the domain");
  assert.ok(!permits(list[0]!, "api.example.com", 22), "and only its ports");
  assert.ok(permits(list[1]!, "anything.test", 80));
  assert.ok(!permits(list[1]!, "10.0.0.5", 443), "no wildcard permits an address");
  assert.throws(
    () => parseEgressList("egress", [{ host: "*.example.com", intercept: true }]),
    /intercepts a wildcard; the Custodian intercepts an exact name or address/,
  );
});

test('"*." is a `*.` entry with no domain and is refused, not read as "*"; a `*.` domain gets the checks of a name', () => {
  // An entry `*.${process.env.X ?? ""}` with X unset is "*.": read as "*", it would permit each name.
  for (const entry of ["*.", "*.:8080", { host: "*." }, { host: "*.", port: 8080 }]) {
    assert.throws(
      () => parseEgressList("egress", [entry]),
      (err: Error) => {
        assert.match(err.message, /^egress\[0\] .* is not \* and then a DNS name — /);
        return true;
      },
      JSON.stringify(entry),
    );
  }
  assert.deepEqual(
    parseEgressList("egress", ["*", "*.Example.COM."]).map((i) => [i.match, i.host]),
    [
      ["any", "*"],
      ["below", "example.com"],
    ],
  );
  assert.throws(() => parseEgressList("egress", ["*.localhost"]), /is a loopback name/);
  assert.throws(
    () => parseEgressList("egress", ["*.1"]),
    /is not an IPv4 address a\.b\.c\.d, and a name whose last label is a number/,
  );
  assert.throws(() => parseEgressList("egress", ["*.127.0.0.1"]), /a name whose last label is a number/);
});

test("jr2 up warns for `*` and for each `*.` entry, by its config path", () => {
  const items = parseEgressList("egress", ["github.com", "*.npmjs.org", "*"]);
  assert.deepEqual(egressWarnings(items), [
    'egress[1] "*.npmjs.org" permits each name below npmjs.org, for TLS and HTTP: the Custodian resolves each such ' +
      "name, so the owner of npmjs.org sees each label that Workspace code puts in one. Name the hosts instead (ADR-0084)",
    'egress[2] "*" permits each name, for TLS and HTTP: Workspace code can send what it reads to any such host. ' +
      "Name the hosts instead (ADR-0084)",
  ]);
  // Through the placement: the Instance's list once, and each workspace()'s own list by its path.
  const out = secretPlacementsOf(
    { egress: ["*"] },
    walk({ workspaces: [ws({ egress: ["*.example.com"] }), ws({}, "other")] }),
  );
  assert.deepEqual(
    out.warnings.map((w) => w.split(" permits")[0]),
    ['jr2.config.ts at egress[0] "*"', 'workflow "ticket": workspace() egress[0] "*.example.com"'],
  );
});

test("an address entry needs its port; IPv6, a range, multicast, and the addresses of the guard and the Fence are refused", () => {
  const refused = (entry: unknown, why: RegExp) =>
    assert.throws(
      () => parseEgressList("egress", [entry]),
      (err: Error) => {
        assert.match(err.message, why);
        assert.ok(err.message.startsWith("egress[0] "), err.message);
        assert.ok(err.message.endsWith(FORMS), err.message);
        return true;
      },
    );
  refused("10.0.0.5", /is an address with no port; an address entry names its one port: a\.b\.c\.d:port/);
  refused({ host: "10.0.0.5" }, /is an address with no port/);
  refused("[2001:db8::1]:443", /is an IPv6 address; the Fence carries IPv4 alone/);
  refused("2001:db8::1", /is an IPv6 address/);
  refused({ host: "2001:db8::1", port: 443 }, /is an IPv6 address/);
  refused("10.0.0.0/8", /is a range; an entry is one address, with its port/);
  refused("0.0.0.0:80", /is the unspecified address/);
  refused("127.0.0.1:8000", /is in 127\.0\.0\.0\/8, which the Custodian never dials/);
  refused("169.254.169.254:80", /is in 169\.254\.0\.0\/16, which the Custodian never dials/);
  refused("198.19.0.7:443", /is in 198\.19\.0\.0\/20, the Fence's segment/);
  refused("198.18.0.2:443", /is in 198\.18\.0\.0\/16, the Fence's placeholder range/);
  refused("198.19.200.1:443", /is in 198\.18\.0\.0\/15, the Fence's default ranges/);
  // No unicast TCP connection has a multicast or a reserved address.
  refused("224.0.0.1:80", /is in 224\.0\.0\.0\/4, which is multicast or reserved/);
  refused("255.255.255.255:80", /is in 240\.0\.0\.0\/4, which is multicast or reserved/);
  assert.equal(parseEgressList("egress", ["223.255.255.255:80"]).length, 1, "the last unicast /4 below them");
  refused("https://github.com", /is a URL/);
  refused("github.com/acme", /has a path/);
  refused("localhost:8000", /is a loopback name/);
  // A name whose last label is a number is an address to a URL parser and to inet_aton.
  refused("0x7f000001:80", /is not an IPv4 address a\.b\.c\.d, and a name whose last label is a number/);
  refused("0x7f.1:80", /is not an IPv4 address a\.b\.c\.d/);
  refused("127.1:80", /is not an IPv4 address a\.b\.c\.d/);
  refused({ host: "0177.0.0.1", port: 80 }, /is not an IPv4 address a\.b\.c\.d/);
  assert.equal(parseEgressList("egress", ["0x7f.example.com", "a1.example"]).length, 2, "a hex label inside a name");
  refused("custodian.jr2.internal", /names jr2\.internal, the domain of jr2's own names/);
  refused("*.jr2.internal", /names jr2\.internal/);
  refused("git*hub.com", /holds a \* that is not/);
  refused("github.com:0", /has a port outside 1–65535/);
  refused({ host: "github.com", port: 70000 }, /has a port outside 1–65535/);
  refused({ host: "github.com:22" }, /put the port in port/);
  refused({ host: "github.com", tls: true }, /has the field tls/);
  // With `fence`, the Instance's own ranges are refused too, and 198.18.0.0/15 still is.
  const ranges = { segment: "10.250.0.0/20", placeholders: "10.251.0.0/16" };
  assert.throws(() => parseEgressList("egress", ["10.250.0.9:80"], ranges), /the Fence's segment/);
  assert.throws(() => parseEgressList("egress", ["10.251.3.3:80"], ranges), /the Fence's placeholder range/);
  assert.throws(() => parseEgressList("egress", ["198.18.0.2:80"], ranges), /the Fence's default ranges/);
  assert.equal(parseEgressList("egress", ["198.20.0.1:80"], ranges).length, 1);
});

test("the config load checks only that egress is a list; jr2 up refuses a bad entry by its path, and the load checks `fence`", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jr2-egress-"));
  const file = join(dir, "jr2.config.ts");
  await writeFile(file, `export default { egress: "github.com" };\n`);
  await assert.rejects(loadConfig(dir), (err: Error) => err.message.startsWith(`${file} at egress must be a list`));
  // In-cluster `.env` is absent, so an entry that reads it is empty there: the load keeps it, and
  // the door's walk does not parse it. Host-side, with the value unset, jr2 up refuses it.
  const env = "JR2_EGRESS_TEST_ADDR";
  delete process.env[env];
  // One directory per load: the module cache keeps the first import of a file.
  const fromEnv = async () => {
    const d = await mkdtemp(join(tmpdir(), "jr2-egress-"));
    await writeFile(
      join(d, "jr2.config.ts"),
      `export default { egress: [process.env.${env} ?? "", process.env.${env}] };\n`,
    );
    return (await loadConfig(d))!;
  };
  const unset = await fromEnv();
  assert.deepEqual(unset.egress, ["", undefined]);
  const w = walk({ workspaces: [ws()] });
  assert.doesNotThrow(() => refuseEffectSecrets(unset, w, { egress: false }), "the door");
  for (const check of [refuseEffectSecrets, secretPlacementsOf]) {
    assert.throws(
      () => check(unset, w),
      (err: Error) => err.message.startsWith('jr2.config.ts at egress[0] "" is empty'),
      check.name,
    );
  }
  process.env[env] = "192.168.1.20:8000";
  try {
    const set = await fromEnv();
    assert.deepEqual(set.egress, ["192.168.1.20:8000", "192.168.1.20:8000"]);
    assert.doesNotThrow(() => refuseEffectSecrets(set, w));
    assert.deepEqual(rulesOf(set, w)[ROOT], [rule("192.168.1.20", 8000, { match: "address" })]);
  } finally {
    delete process.env[env];
  }
  const moved: JR2Config = { fence: { segment: "10.250.0.0/20" }, egress: ["10.250.0.9:80"] };
  assert.throws(
    () => secretPlacementsOf(moved, w),
    /^Error: jr2\.config\.ts at egress\[0\] "10\.250\.0\.9:80" is in 10\.250\.0\.0\/20/,
  );

  const at = "jr2.config.ts";
  assert.doesNotThrow(() => checkFence({ segment: "10.250.0.0/16", placeholders: "10.251.0.0/16" }, at));
  assert.throws(() => checkFence({ segment: "10.250.0.0/24" }, at), /smaller than \/20/);
  assert.throws(() => checkFence({ placeholders: "10.251.0.0/20" }, at), /smaller than \/16/);
  assert.throws(
    () => checkFence({ segment: "10.250.0.1/20" }, at),
    /has host bits set — write the network address, such as "10\.250\.0\.0\/20"/,
  );
  assert.throws(() => checkFence({ segment: "fd00::/64" }, at), /is not an IPv4 prefix/);
  assert.throws(
    () => checkFence({ segment: "198.18.0.0/20" }, at),
    /the segment 198\.18\.0\.0\/20 and the placeholders 198\.18\.0\.0\/16 overlap/,
  );
  assert.throws(() => checkFence({ segment: "169.254.0.0/16" }, at), /overlaps 169\.254\.0\.0\/16/);
  // No unicast TCP connection has a multicast or a reserved address.
  assert.throws(() => checkFence({ segment: "224.0.0.0/20" }, at), /overlaps 224\.0\.0\.0\/4, which is multicast/);
  assert.throws(() => checkFence({ placeholders: "240.0.0.0/16" }, at), /overlaps 240\.0\.0\.0\/4/);
  assert.throws(() => checkFence({ ranges: [] }, at), /at fence\.ranges: not a field/);
});

test("a workspace() list replaces the Instance's whole; with none, the Instance's applies", () => {
  const config: JR2Config = { egress: ["github.com", "registry.npmjs.org:443"] };
  const rules = rulesOf(config, walk({ workspaces: [ws({ egress: ["pypi.org:443"] }), ws({}, "other")] }));
  assert.deepEqual(rules[ROOT], [rule("pypi.org", 443)], "its own list, and nothing of the Instance's");
  assert.deepEqual(rules[workspaceHeldPod({ workflow: "other", route: [] })], [
    rule("github.com", 80),
    rule("github.com", 443),
    rule("registry.npmjs.org", 443),
  ]);
  // An empty list is a list: it permits no entry.
  assert.deepEqual(rulesOf(config, walk({ workspaces: [ws({ egress: [] })] }))[ROOT], []);
  // A workspace()'s list is checked against the Instance's `fence` at `jr2 up`.
  assert.throws(
    () =>
      secretPlacementsOf(
        { fence: { segment: "10.250.0.0/20" } },
        walk({ workspaces: [ws({ egress: ["10.250.0.9:80"] })] }),
      ),
    /^Error: workflow "ticket": workspace\(\) egress\[0\] "10\.250\.0\.9:80" is in 10\.250\.0\.0\/20/,
  );
});

test("workspace() carries its list to the walk, refuses a bad entry when called, and customize() keeps it", () => {
  const body = jr2Setup({ events: [] }).createMachine({ on: { "workspace.lost": {} }, id: "body" });
  const repos = { app: "https://example.test/app.git" };
  const machine = workspace(body, { repos, egress: ["github.com", { host: "pypi.org", intercept: true }] });
  assert.deepEqual(workspacePodsOf(machine)[0]?.egress, ["github.com", { host: "pypi.org", intercept: true }]);
  assert.equal(workspacePodsOf(workspace(body, { repos }))[0]?.egress, undefined, "absent: the Instance's");
  const resized = customize(machine, { resources: { limits: { memory: "4Gi" } } });
  assert.deepEqual(workspacePodsOf(resized)[0]?.egress, ["github.com", { host: "pypi.org", intercept: true }]);
  assert.throws(
    () => workspace(body, { repos, egress: ["10.0.0.5"] }),
    /^Error: workspace\(\): egress\[0\] "10\.0\.0\.5" is an address with no port/,
  );
  assert.throws(
    () => workspace(body, { repos, egress: "github.com" as never }),
    /^Error: workspace\(\): egress must be a list/,
  );
});

test("a bound host needs no entry and is Intercepted; one the list also names keeps both marks", () => {
  const config: JR2Config = {
    secrets: [
      { name: "ANTHROPIC_API_KEY", value: "a-long-enough-key" },
      { name: "JIRA_TOKEN", value: "a-long-enough-key", hosts: ["jira.example.com"] },
    ],
    egress: ["jira.example.com:443", "github.com:443"],
  };
  const rules = rulesOf(
    config,
    walk({ workspaces: [ws({ secrets: ["JIRA_TOKEN"], models: ["anthropic/claude-sonnet-4-6"] })] }),
  );
  assert.deepEqual(rules[ROOT], [
    rule("api.anthropic.com", 443, { intercept: true, from: ["held"] }),
    rule("github.com", 443),
    rule("jira.example.com", 443, { intercept: true, from: ["entry", "held"] }),
  ]);
});

test("a model endpoint with no key, an MCP server with no secret, and a Sandbox Effector url with no secret each refuse with the entry", () => {
  const provider = { id: "vllm", api: "openai-completions", baseUrl: "http://10.0.0.5:8000/v1" } as const;
  const config: JR2Config = { harness: { provider } };
  const keyless = walk({ workspaces: [ws({ models: ["vllm/qwen-x"] })] });
  assert.throws(
    () => secretPlacementsOf(config, keyless),
    (err: Error) => {
      assert.equal(
        err.message,
        'Workspace of workflow "ticket" reaches 10.0.0.5:8000 for the "vllm/…" models (harness.provider.baseUrl, ' +
          "with no apiKey). No secret is bound to that host, and the Instance's egress (jr2.config.ts) has no entry " +
          'for it — add egress: ["10.0.0.5:8000"]. All code in the pod can then reach it (ADR-0084)',
      );
      return true;
    },
  );
  assert.deepEqual(rulesOf({ ...config, egress: ["10.0.0.5:8000"] }, keyless)[ROOT], [
    rule("10.0.0.5", 8000, { match: "address" }),
  ]);
  // A workspace()'s own list replaces the Instance's, so the entry must be in it, and the refusal says so.
  assert.throws(
    () =>
      secretPlacementsOf(
        { ...config, egress: ["10.0.0.5:8000"] },
        walk({ workspaces: [ws({ models: ["vllm/qwen-x"], egress: ["github.com"] })] }),
      ),
    /and its workspace\(\)'s egress, which replaces the Instance's, has no entry for it — add egress: \["10\.0\.0\.5:8000"\]/,
  );
  // The Instance Harness has no entry of the author's: the Instance's list gives it the hosts it needs, alone.
  const instance = walk({ instanceHarness: { models: ["vllm/qwen-x"] } });
  assert.throws(() => secretPlacementsOf(config, instance), /^Error: the Instance Harness reaches 10\.0\.0\.5:8000/);
  assert.deepEqual(rulesOf({ ...config, egress: ["github.com", "10.0.0.5:8000"] }, instance).instance, [
    rule("10.0.0.5", 8000, { match: "address" }),
  ]);
  // A catalog gateway with no key held.
  assert.throws(
    () =>
      secretPlacementsOf(
        { harness: { catalog: { anthropic: { baseUrl: "https://llm.example.com" } } } },
        walk({ workspaces: [ws({ models: ["anthropic/claude-sonnet-4-6"] })] }),
      ),
    /reaches llm\.example\.com for the "anthropic\/…" models \(harness\.catalog\.anthropic\.baseUrl, with no key held\)\. .* add egress: \["llm\.example\.com"\]/,
  );

  // An MCP server with no secret, which an Agent there names.
  const mcp: JR2Config = { mcp: { orders: { url: "http://mcp.example.com:9000/mcp" } } };
  const naming = walk({
    workspaces: [ws({ mcp: [{ slot: "coder", path: [], entry: { server: "orders", tools: ["list"] } }] })],
  });
  assert.throws(
    () => secretPlacementsOf(mcp, naming),
    /reaches mcp\.example\.com:9000 for the MCP server "orders" \(mcp\.orders\.url, with no secret\)\. .* add egress: \["mcp\.example\.com:9000"\]/,
  );
  assert.throws(() => secretPlacementsOf({ ...mcp, egress: ["*"] }, naming), /add egress/, "`*` permits 443 and 80");
  assert.deepEqual(
    rulesOf({ ...mcp, egress: ["*.example.com:9000"] }, naming)[ROOT],
    [rule("example.com", 9000, { match: "below", tlsHttpOnly: true })],
    "a wildcard entry with its port permits the name",
  );

  // A Sandbox Effector's http Effect with no secret needs an entry; one that names a secret is bound.
  const effect = (name: string, host: string, secrets: string[]) =>
    ({
      name,
      path: [],
      route: [],
      kind: "http",
      placement: "sandbox",
      method: "POST",
      target: { scheme: "https", host, port: 443 },
      secrets,
      idempotent: false,
      file: true,
      timeoutMs: 30_000,
    }) as CarriedEffect;
  const effector = walk({
    workspaces: [
      ws({ effects: [effect("notify", "hooks.example.com", []), effect("upload", "s3.example.com", ["S3"])] }),
    ],
  });
  assert.throws(
    () => secretPlacementsOf({ secrets: [{ name: "S3", value: "a-long-enough-key" }] }, effector),
    /reaches hooks\.example\.com for the http Effect "notify" \(no secret\)\. .* add egress: \["hooks\.example\.com"\]/,
  );
  assert.deepEqual(
    rulesOf({ secrets: [{ name: "S3", value: "a-long-enough-key" }], egress: ["hooks.example.com:443"] }, effector)[
      ROOT
    ],
    [rule("hooks.example.com", 443), rule("s3.example.com", 443, { intercept: true, from: ["effector"] })],
  );
});

test("a host jr2 uses with no secret that no entry can permit is refused with the reason, not with an entry to add", () => {
  for (const [baseUrl, why] of [
    ["http://localhost:8000/v1", /it is a loopback name/],
    ["http://127.0.0.1:8000/v1", /it is in 127\.0\.0\.0\/8, which the Custodian never dials/],
    ["http://198.18.0.9:8000/v1", /it is in 198\.18\.0\.0\/16, the Fence's placeholder range/],
    ["http://[fd00::5]:8000/v1", /reaches \[fd00::5\]:8000 .*it is an IPv6 address, and the Fence carries IPv4 alone/],
  ] as const) {
    const config: JR2Config = { harness: { provider: { id: "vllm", api: "openai-completions", baseUrl } } };
    assert.throws(
      () => secretPlacementsOf(config, walk({ workspaces: [ws({ models: ["vllm/q"] })] })),
      (err: Error) => {
        assert.match(err.message, /The Fence cannot carry that host/, baseUrl);
        assert.match(err.message, why, baseUrl);
        assert.doesNotMatch(err.message, /add egress/, baseUrl);
        return true;
      },
    );
  }
});

test("a bound or SSH Repo host that the Fence cannot carry gets no rule, and a warning", () => {
  const config: JR2Config = {
    secrets: [{ name: "T", value: "a-long-enough-key", hosts: ["[fd00::7]:443"], headers: ["authorization"] }],
  };
  const w = walk({
    workspaces: [ws({ secrets: ["T"], bindings: { app: "ssh://git@[fd00::1]:2222/x", lib: "git@github.com:a/b" } })],
  });
  const placements = secretPlacementsOf(config, w);
  const { manifest } = heldSecretsOf(config, placements.claimed);
  const plan = placements.held.find((p) => p.pod === ROOT)!;
  const parts = { ...plan.egress, held: manifest.secrets.flatMap((b) => b.hosts) };
  assert.deepEqual(egressRulesOf(parts), [rule("github.com", 22, { from: ["repo"] })]);
  const warnings = uncarriedHosts(plan.label, parts);
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(
    warnings[0]!,
    /reaches \[fd00::7\] \(a Held secret is bound to it\), but the Fence cannot carry that host: it is an IPv6/,
  );
  assert.match(
    warnings[1]!,
    /reaches \[fd00::1\]:2222 \(it binds an SSH Repo there\), but the Fence cannot carry that host/,
  );
  // A Sandbox Effector's bound host in a refused range.
  const effector = uncarriedHosts("w", { held: [], effector: [{ host: "169.254.169.254", port: 80 }], repos: [] });
  assert.match(effector[0]!, /\(its Sandbox Effector uses it with a secret\).*it is in 169\.254\.0\.0\/16/);
});

test("an http Effect whose secrets sit in its url alone binds no host: its target needs an entry", () => {
  const body = (actors: Record<string, unknown>) =>
    workspace(
      jr2Setup({ events: [], actors: actors as never }).createMachine({ on: { "workspace.lost": {} }, id: "b" }),
      { repos: { app: "https://example.test/app.git" } },
    );
  const config: JR2Config = { secrets: [{ name: "tg", value: "a-long-enough-key" }] };
  const inUrl = http({
    method: "POST",
    url: text`https://api.telegram.org/bot${secret("tg")}/sendMessage`,
    body: file("m"),
  });
  const w = placementWalkOf([{ name: "ticket", machine: body({ notify: inUrl }) }]);
  assert.deepEqual(w.workspaces[0]!.pod.effects[0], { ...w.workspaces[0]!.pod.effects[0], urlSecrets: ["tg"] });
  assert.throws(
    () => secretPlacementsOf(config, w),
    /reaches api\.telegram\.org for the http Effect "notify" \(a secret in its url alone\)\. .* add egress: \["api\.telegram\.org"\]/,
  );
  assert.deepEqual(rulesOf({ ...config, egress: ["api.telegram.org"] }, w)[ROOT], [
    rule("api.telegram.org", 80),
    rule("api.telegram.org", 443),
  ]);
  // The same secret in its auth too: the Custodian holds it, so the host is bound.
  const both = http({
    method: "POST",
    url: text`https://api.telegram.org/bot${secret("tg")}/sendMessage`,
    body: file("m"),
    auth: bearer(secret("tg")),
  });
  const bound = placementWalkOf([{ name: "ticket", machine: body({ notify: both }) }]);
  assert.equal((bound.workspaces[0]!.pod.effects[0] as { urlSecrets?: string[] }).urlSecrets, undefined);
  assert.deepEqual(rulesOf(config, bound)[ROOT], [
    rule("api.telegram.org", 443, { intercept: true, from: ["effector"] }),
  ]);
});

test("an SSH Repo that the Workspace binds gets its port, 22 by default, as a Tunneled host with no entry", () => {
  const rules = rulesOf(
    {},
    walk({
      workspaces: [
        ws({
          bindings: {
            app: "git@github.com:acme/app.git",
            lib: "ssh://git@git.example.com:2222/acme/lib.git",
            docs: "https://github.com/acme/docs.git",
            open: undefined,
          },
        }),
      ],
    }),
  );
  assert.deepEqual(rules[ROOT], [
    rule("git.example.com", 2222, { from: ["repo"] }),
    rule("github.com", 22, { from: ["repo"] }),
  ]);
  assert.equal(sshHostOf("https://github.com/acme/app.git"), undefined);
  assert.deepEqual(sshHostOf("git+ssh://GitHub.com/acme/app"), { host: "github.com", port: 22 });
  // git accepts `ssh+git://` beside `git+ssh://`.
  assert.deepEqual(sshHostOf("ssh+git://git.example.com/x"), { host: "git.example.com", port: 22 });
  // git's scp form with a host in brackets: one host, so the Fence's IPv6 reason applies to it.
  assert.deepEqual(sshHostOf("git@[fd00::1]:acme/app.git"), { host: "fd00::1", port: 22 });
  const v6 = uncarriedHosts("w", { held: [], effector: [], repos: [sshHostOf("git@[fd00::1]:x")!] });
  assert.match(v6[0]!, /reaches \[fd00::1\]:22 \(it binds an SSH Repo there\).*it is an IPv6 address/);
});

test("a keyless model endpoint whose host a Held secret of the pod binds is refused with that reason", () => {
  const config: JR2Config = {
    secrets: [{ name: "VLLM_TOKEN", value: "a-long-enough-key", hosts: ["vllm.example.test"], headers: ["x-gw"] }],
    harness: { provider: { id: "vllm", api: "openai-completions", baseUrl: "https://vllm.example.test/v1" } },
  };
  const w = walk({ workspaces: [ws({ secrets: ["VLLM_TOKEN"], models: ["vllm/q"] })] });
  assert.throws(
    () => secretPlacementsOf(config, w),
    (err: Error) => {
      assert.equal(
        err.message,
        'Workspace of workflow "ticket" reaches vllm.example.test for the "vllm/…" models (harness.provider.baseUrl, ' +
          "with no apiKey). A Held secret of the pod is bound to that host, but this call carries no Stand-in of it, " +
          "so only an entry permits the call, and the Instance's egress (jr2.config.ts) has none — add egress: " +
          '["vllm.example.test"]. All code in the pod can then reach it (ADR-0084)',
      );
      return true;
    },
  );
  assert.doesNotThrow(() => secretPlacementsOf({ ...config, egress: ["vllm.example.test"] }, w));
});

test("a held manifest carries its Egress list; one without it is malformed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jr2-egress-"));
  const good = join(dir, "good.json");
  await writeFile(good, JSON.stringify({ version: 1, secrets: [], egress: [rule("github.com", 443)] }));
  assert.deepEqual((await readHeldManifest(good)).egress, [rule("github.com", 443)]);
  const old = join(dir, "old.json");
  await writeFile(old, JSON.stringify({ version: 1, secrets: [] }));
  await assert.rejects(readHeldManifest(old), /expected \{ version: 1, secrets: \[\.\.\.\], egress: \[\.\.\.\] \}/);
});
