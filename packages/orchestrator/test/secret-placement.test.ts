// Where a secret goes (ADR-0059, ADR-0068): naming is placement on both sides. A Workspace's pod gets
// the Held secrets its `workspace()` lists and the model keys its Agents' providers read; the
// Instance Harness its `"none"` Agents' model keys only; the Instance Effector what its Effects name
// with `secret("name")`. `hosts` is the binding and never the placement. Both is both; neither goes
// nowhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { JR2Config } from "../src/config.ts";
import { heldSecretsOf, workspaceHeldPod } from "../src/held-secrets.ts";
import type { CarriedEffect, WorkspacePod } from "../src/parts.ts";
import {
  refuseEffectSecrets,
  secretPlacementsOf,
  storedValueLength,
  type PlacedEffect,
  type PlacementWalk,
} from "../src/secret-placement.ts";

const VALUE = "a-long-enough-secret-value";

const httpEffect = (name: string, secrets: string[], extra: Partial<CarriedEffect> = {}): PlacedEffect => ({
  workflow: "ticket",
  effect: {
    name,
    path: [],
    kind: "http",
    placement: "instance",
    method: "POST",
    target: { scheme: "https", host: "jira.example.com", port: 443 },
    secrets,
    idempotent: false,
    timeoutMs: 30_000,
    ...extra,
  } as CarriedEffect,
});

const ws = (pod: Partial<WorkspacePod> = {}, workflow = "ticket") => ({
  workflow,
  pod: { path: [], secrets: [], models: [], effects: [], bindings: {}, ...pod } as WorkspacePod,
});

const walk = (w: Partial<PlacementWalk>): PlacementWalk => ({ effects: [], workspaces: [], ...w });

const heldIn = (out: ReturnType<typeof secretPlacementsOf>, pod: string) => out.held.find((p) => p.pod === pod)?.names;
const ROOT = workspaceHeldPod({ workflow: "ticket", path: [] });

test("a Workspace holds what its workspace() lists and its Agents' providers claim; the Instance Harness its 'none' Agents' keys only", () => {
  const config: JR2Config = {
    secrets: [
      { name: "ANTHROPIC_API_KEY", value: VALUE },
      { name: "OPENAI_API_KEY", value: VALUE },
      { name: "JIRA_TOKEN", value: VALUE, hosts: ["jira.example.com"] },
      { name: "GATEWAY_KEY", value: VALUE, hosts: ["gw.example.com"] },
    ],
  };
  const out = secretPlacementsOf(
    config,
    walk({
      workspaces: [ws({ secrets: ["JIRA_TOKEN"], models: ["anthropic/claude-sonnet-4-6"] })],
      instanceHarness: { models: ["openai/gpt-5"] },
    }),
  );
  assert.deepEqual(heldIn(out, ROOT), ["ANTHROPIC_API_KEY", "JIRA_TOKEN"]);
  assert.deepEqual(heldIn(out, "instance"), ["OPENAI_API_KEY"], "a 'none' Agent's provider key, and nothing else");
  assert.deepEqual([...out.claimed].sort(), ["ANTHROPIC_API_KEY", "JIRA_TOKEN", "OPENAI_API_KEY"]);
  assert.deepEqual(out.report, [
    'secret ANTHROPIC_API_KEY: Held in Workspace of workflow "ticket"',
    "secret OPENAI_API_KEY: Held in the Instance Harness",
    'secret JIRA_TOKEN: Held in Workspace of workflow "ticket"',
    'Workspace of workflow "ticket": Custodian holds ANTHROPIC_API_KEY (provider), JIRA_TOKEN',
    "the Instance Harness: Custodian holds OPENAI_API_KEY (provider)",
  ]);
  // `hosts` is the binding, never the placement: an entry with hosts that nothing names goes nowhere.
  assert.deepEqual(out.warnings, [
    "secrets[3] (GATEWAY_KEY) is named by nothing; goes nowhere — no workspace() lists it, no Agent's provider " +
      "reads it, and no Effect names it (ADR-0059, ADR-0068)",
  ]);
});

test("a model key only an Effect names is an Effect secret and no Custodian's — with one default host or none", () => {
  // The verifier's two cases: HF_TOKEN has one default host, AZURE_OPENAI_API_KEY none. Neither is
  // claimed by a provider an Agent names, so neither is Held, and R5 never fires for either.
  const config: JR2Config = {
    secrets: [
      { name: "HF_TOKEN", value: VALUE },
      { name: "AZURE_OPENAI_API_KEY", value: VALUE },
    ],
  };
  const out = secretPlacementsOf(
    config,
    walk({
      effects: [httpEffect("call", ["HF_TOKEN", "AZURE_OPENAI_API_KEY"])],
      workspaces: [ws({ models: ["anthropic/claude-sonnet-4-6"] })],
      instanceHarness: { models: ["anthropic/claude-haiku-4-5"] },
    }),
  );
  assert.deepEqual(out.claimed, new Set());
  assert.deepEqual(heldIn(out, ROOT), []);
  assert.deepEqual(heldIn(out, "instance"), []);
  assert.deepEqual(
    out.instance?.secrets.map((s) => s.name),
    ["HF_TOKEN", "AZURE_OPENAI_API_KEY"],
  );
  assert.deepEqual(out.report.slice(0, 2), [
    "secret HF_TOKEN: an Effect secret in the Instance Effector (ticket/call)",
    "secret AZURE_OPENAI_API_KEY: an Effect secret in the Instance Effector (ticket/call)",
  ]);
  const held = heldSecretsOf(config, out.claimed);
  assert.deepEqual(held.manifest.secrets, [], "no Custodian binds either");
});

test("both is both, reported per pod: Held where a workspace() lists it, and an Effect secret where an Effect names it", () => {
  const config: JR2Config = { secrets: [{ name: "SHARED_KEY", value: VALUE, hosts: ["gw.example.com"] }] };
  const out = secretPlacementsOf(
    config,
    walk({
      effects: [httpEffect("mirror", ["SHARED_KEY"])],
      workspaces: [ws({ secrets: ["SHARED_KEY"] }), ws({ path: ["review"] })],
    }),
  );
  assert.deepEqual(out.report, [
    'secret SHARED_KEY: Held in Workspace of workflow "ticket" and an Effect secret in the Instance Effector (ticket/mirror)',
    'Workspace of workflow "ticket": Custodian holds SHARED_KEY',
    'Workspace of workflow "ticket" → "review": Custodian holds nothing',
    "the Instance Effector: holds SHARED_KEY",
  ]);
  assert.deepEqual(heldIn(out, workspaceHeldPod({ workflow: "ticket", path: ["review"] })), []);
  assert.deepEqual(out.instance?.values, { SHARED_KEY: VALUE });
});

test("a model key a workspace() lists and its provider claims is redundant, and said to be", () => {
  const out = secretPlacementsOf(
    { secrets: [{ name: "ANTHROPIC_API_KEY", value: VALUE }] },
    walk({ workspaces: [ws({ secrets: ["ANTHROPIC_API_KEY"], models: ["anthropic/claude-sonnet-4-6"] })] }),
  );
  assert.deepEqual(heldIn(out, ROOT), ["ANTHROPIC_API_KEY"]);
  assert.ok(
    out.report.includes(
      'Workspace of workflow "ticket": secrets lists ANTHROPIC_API_KEY, which its Agents\' provider claims already — redundant',
    ),
  );
});

test("the custom provider's key is claimed by an Agent that names the provider, and warns when none does", () => {
  const config: JR2Config = {
    harness: {
      provider: { id: "vllm", api: "openai-completions", baseUrl: "https://llm.lan/v1", apiKey: VALUE },
    },
  };
  const used = secretPlacementsOf(
    config,
    walk({ workspaces: [ws({ models: ["vllm/qwen"] })], instanceHarness: { models: [] } }),
  );
  assert.deepEqual(heldIn(used, ROOT), ["JR2_PROVIDER_API_KEY"]);
  assert.deepEqual(heldIn(used, "instance"), []);
  const unused = secretPlacementsOf(config, walk({ workspaces: [ws({ models: ["anthropic/x"] })] }));
  assert.deepEqual(unused.claimed, new Set());
  assert.match(unused.warnings[0] ?? "", /harness\.provider\.apiKey is named by nothing; goes nowhere/);
});

test("a workspace() that lists a name the secrets list does not hold is refused with the line to add", () => {
  assert.throws(
    () => refuseEffectSecrets({ secrets: [] }, walk({ workspaces: [ws({ secrets: ["JIRA_TOKEN"] })] })),
    /a workspace\(\) lists secrets: \["JIRA_TOKEN"\].*secrets: \[\{ name: "JIRA_TOKEN", value: process\.env\.JIRA_TOKEN, hosts/,
  );
});

test("two inline Workspaces of one workflow that would hold different names are refused; the same names are one pod", () => {
  const config: JR2Config = { secrets: [{ name: "JIRA_TOKEN", value: VALUE, hosts: ["jira.example.com"] }] };
  assert.throws(
    () =>
      secretPlacementsOf(
        config,
        walk({ workspaces: [ws({ path: undefined, secrets: ["JIRA_TOKEN"] }), ws({ path: undefined })] }),
      ),
    /invokes two workspace\(\)s inline whose pods would hold different Held secrets/,
  );
  const same = secretPlacementsOf(
    config,
    walk({
      workspaces: [ws({ path: undefined, secrets: ["JIRA_TOKEN"] }), ws({ path: undefined, secrets: ["JIRA_TOKEN"] })],
    }),
  );
  assert.equal(same.held.length, 1);
});

test("an Effect secret shorter than 8 characters is refused, and says why", () => {
  assert.throws(
    () =>
      secretPlacementsOf(
        { secrets: [{ name: "jira", value: "short" }] },
        walk({ effects: [httpEffect("comment", ["jira"])] }),
      ),
    /secrets\[0\] \(jira\) is an Effect secret shorter than 8 characters.*match ordinary text/,
  );
  // A Held-only secret is not scrubbed by an Effector: the rule is the Effect secret's.
  assert.doesNotThrow(() =>
    secretPlacementsOf(
      { secrets: [{ name: "K", value: "short", hosts: ["a.example"] }] },
      walk({ workspaces: [ws({ secrets: ["K"] })] }),
    ),
  );
});

test("a valueFrom Effect secret shorter than 8 characters is refused as a literal is, by its length alone", () => {
  const config: JR2Config = { secrets: [{ name: "jira", valueFrom: { secretKeyRef: { name: "team", key: "jira" } } }] };
  const effects = [httpEffect("c", ["jira"])];
  const lookups = (length: number) => ({ secretKeys: () => ["jira"], valueLength: () => length });
  assert.throws(
    () => secretPlacementsOf(config, walk({ effects }), lookups(7)),
    /secrets\[0\] \(jira\) is an Effect secret shorter than 8 characters.*match ordinary text/,
  );
  assert.doesNotThrow(() => secretPlacementsOf(config, walk({ effects }), lookups(8)));
  // A Held-only reference is not scrubbed by an Effector: the rule is the Effect secret's.
  assert.doesNotThrow(() =>
    secretPlacementsOf(
      { secrets: [{ name: "K", valueFrom: { secretKeyRef: { name: "team", key: "k" } }, hosts: ["a.example"] }] },
      walk({ workspaces: [ws({ secrets: ["K"] })] }),
      { secretKeys: () => ["k"], valueLength: () => 3 },
    ),
  );
});

test("a stored value is measured as the Effector reads its file: bytes, one trailing newline off", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  assert.equal(storedValueLength(b64("1234567")), 7);
  assert.equal(storedValueLength(b64("1234567\n")), 7, "kubectl --from-file keeps the newline; the Effector drops it");
  assert.equal(storedValueLength(b64("1234567\r\n")), 7);
  assert.equal(storedValueLength(b64("1234567\n\n")), 8, "only one");
  assert.equal(storedValueLength(b64("é1234567")), 9, "bytes, as Go's len");
});

test("an Effect that names a secret the list does not hold is refused with the line to add", () => {
  assert.throws(
    () => secretPlacementsOf({ secrets: [] }, walk({ effects: [httpEffect("comment", ["jira-token"])] })),
    /"comment" names secret\("jira-token"\).*secrets: \[\{ name: "jira-token", value: process\.env\.JIRA_TOKEN \}\]/,
  );
});

test("a valueFrom Effect secret is a reference: its Secret and key must exist, and its value is never read", () => {
  const config: JR2Config = { secrets: [{ name: "jira", valueFrom: { secretKeyRef: { name: "team", key: "jira" } } }] };
  const effects = [httpEffect("c", ["jira"])];
  assert.throws(
    () => secretPlacementsOf(config, walk({ effects }), { secretKeys: () => undefined }),
    /names Secret "team", which does not exist/,
  );
  const out = secretPlacementsOf(config, walk({ effects }), { secretKeys: () => ["jira"] });
  assert.deepEqual(out.instance?.secrets, [{ name: "jira", source: { kind: "secret", secret: "team", key: "jira" } }]);
  assert.deepEqual(out.instance?.values, {});
});

test("the Instance Effector's targets and its longest timeout come from the Effects placed there", () => {
  const out = secretPlacementsOf(
    { secrets: [{ name: "jira", value: VALUE }] },
    walk({
      effects: [
        httpEffect("a", ["jira"]),
        httpEffect("b", ["jira"], { timeoutMs: 120_000 }),
        httpEffect("c", [], {
          target: { scheme: "http", host: "echo.seed.svc", port: 8080 },
        } as Partial<CarriedEffect>),
      ],
    }),
  );
  assert.deepEqual(out.instance?.targets, [
    { scheme: "https", host: "jira.example.com", port: 443, secrets: ["jira"] },
    { scheme: "http", host: "echo.seed.svc", port: 8080, secrets: [] },
  ]);
  assert.equal(out.instance?.longestTimeoutMs, 120_000);
  assert.deepEqual(out.instance?.effects, ["ticket/a", "ticket/b", "ticket/c"]);
});

test("one name listed twice is refused", () => {
  assert.throws(
    () =>
      secretPlacementsOf(
        {
          secrets: [
            { name: "x", value: VALUE },
            { name: "x", value: VALUE },
          ],
        },
        walk({}),
      ),
    /secrets\[1\]\.name x is listed twice/,
  );
});

test("the hover text of `secrets` and `SecretEntry` states the rule these tests hold: naming places, `hosts` binds", async () => {
  // A user reads the config's doc comments, not this file. `JR2Config.secrets` once said "a Held
  // secret where it has `hosts`" after B6.3 made naming the placement — a user who added `hosts`
  // for a Held secret got one that went nowhere (the GATEWAY_KEY case above).
  const source = await readFile(new URL("../src/config.ts", import.meta.url), "utf8");
  const docBefore = (marker: string): string => {
    const at = source.indexOf(marker);
    assert.ok(at > 0, `config.ts still has ${marker}`);
    const open = source.lastIndexOf("/**", at);
    return source.slice(open, at).replace(/\s*\*\s*/g, " ");
  };
  for (const doc of [docBefore("  secrets?: readonly SecretEntry[];"), docBefore("export type SecretEntry = {")]) {
    assert.doesNotMatch(doc, /Held secret (?:where|when|if) it has `hosts`/);
    assert.match(doc, /`hosts`[^.]*binding, never (?:its|the) placement/);
    assert.match(doc, /`workspace\(\)`/, "it names what places a Held secret");
    assert.match(doc, /secret\("name"\)/, "it names what places an Effect secret");
  }
});

// --- The Sandbox Effector's placement (ADR-0067, ADR-0068, B5.1, B6.2) ----------------------------

const upload = (name: string, secrets: string[]): CarriedEffect =>
  ({
    name,
    path: [],
    kind: "upload",
    placement: "sandbox",
    method: "PUT",
    target: { scheme: "https", host: "files.example.com", port: 443 },
    secrets,
    idempotent: false,
    timeoutMs: 30_000,
  }) as CarriedEffect;
const credentialed = (name: string, secrets: string[]): CarriedEffect =>
  ({
    name,
    path: [],
    kind: "command",
    placement: "sandbox",
    argv: ["terraform", "apply"],
    timeoutMs: 60_000,
    secrets,
  }) as CarriedEffect;
const pusher = (name: string, extra: Partial<Extract<CarriedEffect, { kind: "push" }>> = {}): CarriedEffect =>
  ({
    name,
    path: [],
    kind: "push",
    placement: "sandbox",
    sign: false,
    squash: false,
    force: false,
    pin: false,
    secrets: [],
    timeoutMs: 300_000,
    ...extra,
  }) as CarriedEffect;
const placedIn = (
  effects: CarriedEffect[],
  bindings: Record<string, string | undefined> = { app: "https://github.com/ourorg/app.git" },
) => {
  const pod = ws({ effects, bindings });
  return walk({ effects: effects.map((effect) => ({ workflow: "ticket", effect })), workspaces: [pod] });
};

test("a secret a credentialed command or an upload names is an Effect secret in its Workspace's Sandbox Effector, never 'named by nothing'", () => {
  const config: JR2Config = {
    secrets: [
      { name: "aws", value: VALUE },
      { name: "files", value: VALUE },
    ],
  };
  const out = secretPlacementsOf(config, placedIn([credentialed("deploy", ["aws"]), upload("report", ["files"])]));
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.report, [
    'secret aws: an Effect secret in the Sandbox Effector of Workspace of workflow "ticket" (ticket/deploy)',
    'secret files: an Effect secret in the Sandbox Effector of Workspace of workflow "ticket" (ticket/report)',
    'Workspace of workflow "ticket": Custodian holds nothing',
    'Workspace of workflow "ticket": Sandbox Effector (image the Sandbox Image) holds aws, files',
  ]);
  assert.equal(out.instance, undefined, "nothing is placed in the Instance Effector");
  const plan = out.sandbox[0]!;
  assert.equal(plan.pod, ROOT);
  assert.deepEqual(
    plan.secrets.map((s) => s.name),
    ["aws", "files"],
  );
  assert.deepEqual(plan.values, { aws: VALUE, files: VALUE });
  assert.deepEqual(plan.targets, [{ scheme: "https", host: "files.example.com", port: 443, secrets: ["files"] }]);
  assert.deepEqual(plan.effects, ["ticket/deploy", "ticket/report"]);
});

test("a Sandbox kind's secret missing from the list, or shorter than 8 characters, is refused as an http one is", () => {
  assert.throws(
    () => refuseEffectSecrets({ secrets: [] }, placedIn([credentialed("deploy", ["aws"])])),
    /the command Effect "deploy" names secret\("aws"\).*secrets: \[\{ name: "aws", value: process\.env\.AWS \}\]/,
  );
  assert.throws(
    () => refuseEffectSecrets({ secrets: [{ name: "files", value: "abc" }] }, placedIn([upload("report", ["files"])])),
    /secrets\[0\] \(files\) is an Effect secret shorter than 8 characters/,
  );
});

test("a Workspace with no Effect placed in its Sandbox Effector gets none; one names its image when the workspace() does", () => {
  const none = secretPlacementsOf({}, walk({ workspaces: [ws()] }));
  assert.deepEqual(none.sandbox, []);
  const named = secretPlacementsOf(
    { git: { credentials: [{ match: "github.com/ourorg/", token: "GH_TOKEN" }] } },
    walk({
      workspaces: [
        ws({
          effects: [pusher("publish")],
          bindings: { app: "https://github.com/ourorg/app.git" },
          effector: { image: "registry.example/tools:1" },
        }),
      ],
    }),
  );
  assert.equal(named.sandbox[0]?.image, "registry.example/tools:1");
  assert.match(
    named.report.at(-1)!,
    /Sandbox Effector \(image registry\.example\/tools:1\) holds no Effect secret; pushes Repo Slot "app" with git\.credentials "github\.com\/ourorg\/"/,
  );
});

test("a push is its Repo Slot and the entry its url matches; no credential rides the Workspace's plan (B10)", () => {
  const config: JR2Config = {
    git: {
      credentials: [
        { match: "github.com/other/", token: "OTHER" },
        {
          match: "github.com/ourorg/",
          token: "GH_TOKEN",
          push: { sshKey: "deploy-key" },
          sign: { sshKey: "signing-key", name: "jr2 bot", email: "bot@example.test" },
        },
      ],
    },
  };
  const out = secretPlacementsOf(
    config,
    placedIn([pusher("publish", { sign: true })], { app: "git@github.com:ourorg/app.git" }),
  );
  const plan = out.sandbox[0]!;
  assert.deepEqual(plan.pushes, [
    { slot: "app", sign: true, url: "git@github.com:ourorg/app.git", match: "github.com/ourorg/" },
  ]);
  assert.deepEqual(plan.secrets, [], "the push credential is not one of the Workspace's secrets");
  assert.equal(plan.commands, false);
  // A slot the run or a customize() binds: the provision matches its url, and the report says so.
  const perRun = secretPlacementsOf(
    { git: { credentials: [{ match: "*", token: "T" }] } },
    placedIn([pusher("publish")], { app: undefined }),
  );
  assert.deepEqual(perRun.sandbox[0]!.pushes, [{ slot: "app", sign: false }]);
  assert.match(
    perRun.report.at(-1)!,
    /pushes Repo Slot "app" with the git\.credentials entry its url matches at provision/,
  );
  // A credentialed command marks the plan, so the Effector fails closed on a node with no Landlock.
  const cmd = secretPlacementsOf(
    { secrets: [{ name: "aws", value: VALUE }] },
    placedIn([credentialed("deploy", ["aws"])]),
  );
  assert.equal(cmd.sandbox[0]!.commands, true);
});

test("jr2 up refuses a push with no matching entry, an entry with no credential, http, and sign with no sign field — each with a fix that works", () => {
  assert.throws(
    () =>
      refuseEffectSecrets(
        { git: { credentials: [{ match: "github.com/other/", token: "T" }] } },
        placedIn([pusher("publish")]),
      ),
    /push "publish" pushes Repo Slot "app" \(https:\/\/github\.com\/ourorg\/app\.git\), and no git\.credentials entry matches "github\.com\/ourorg\/app".*credentials: \[\{ match: "github\.com\/ourorg\/", token:/,
  );
  assert.throws(
    () => refuseEffectSecrets({ git: { credentials: [{ match: "*" }] } }, placedIn([pusher("publish")])),
    /entry "\*" holds no credential a push over https can spend — an entry with none admits a clone, never a push; add push: \{ token:/,
  );
  assert.throws(
    () =>
      refuseEffectSecrets(
        { git: { credentials: [{ match: "*", token: "T" }] } },
        placedIn([pusher("publish")], { app: "git@github.com:ourorg/app.git" }),
      ),
    /over ssh can spend; add sshKey: "<a Secret with identity and known_hosts>" to it/,
  );
  assert.throws(
    () =>
      refuseEffectSecrets(
        { git: { credentials: [{ match: "*", token: "T" }] } },
        placedIn([pusher("publish", { sign: true })]),
      ),
    /push "publish" pushes .* signed, and git\.credentials entry "\*" holds no sign field — add sign: \{ sshKey: .*name: .*email:/,
  );
  assert.throws(
    () =>
      refuseEffectSecrets(
        { git: { credentials: [{ match: "*", token: "T" }] } },
        placedIn([pusher("publish")], { app: "/srv/app.git" }),
      ),
    /a local path — jr2 never pushes to one/,
  );
  // A token over http (run B3's defect): jr2 up accepted it and the Effector refused every push.
  // Refused here; the fix it names — the https url — is accepted.
  for (const credentials of [[{ match: "*", token: "T" }], [{ match: "*", push: { token: "T" } }]]) {
    assert.throws(
      () =>
        refuseEffectSecrets(
          { git: { credentials } },
          placedIn([pusher("publish")], { app: "http://git.example.com/acme/app.git" }),
        ),
      /pushes Repo Slot "app" \(http:\/\/git\.example\.com\/acme\/app\.git\) over http:\/\/, and jr2 sends a push credential over https or ssh only .*bind the slot to the https url/,
    );
    assert.doesNotThrow(() =>
      refuseEffectSecrets(
        { git: { credentials } },
        placedIn([pusher("publish")], { app: "https://git.example.com/acme/app.git" }),
      ),
    );
  }
  // An ssh key over http cannot be spent either.
  assert.throws(
    () =>
      refuseEffectSecrets(
        { git: { credentials: [{ match: "*", sshKey: "k" }] } },
        placedIn([pusher("publish")], { app: "http://git.example.com/acme/app.git" }),
      ),
    /over http:\/\/, .*bind the slot to the ssh url \(git\.credentials entry "\*" then pushes with its ssh key\)/,
  );
  assert.doesNotThrow(() =>
    refuseEffectSecrets(
      { git: { credentials: [{ match: "*", sshKey: "k" }] } },
      placedIn([pusher("publish")], { app: "git@git.example.com:acme/app.git" }),
    ),
  );
  // A slot the run or a customize() binds is not refused at jr2 up: the provision checks its url
  // by the same rule (B10).
  for (const config of [{}, { git: { credentials: [{ match: "*", token: "T" }] } }]) {
    assert.doesNotThrow(() => refuseEffectSecrets(config, placedIn([pusher("publish")], { app: undefined })));
  }
});
