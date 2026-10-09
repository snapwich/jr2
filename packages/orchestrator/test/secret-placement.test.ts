// Where a secret goes (ADR-0059, ADR-0068): naming is placement on both sides. A Workspace's pod gets
// the Held secrets its `workspace()` lists and the model keys its Agents' providers read; the
// Instance Harness its `"none"` Agents' model keys only; the Instance Effector what its Effects name
// with `secret("name")`. `hosts` is the binding and never the placement. Both is both; neither goes
// nowhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JR2Config } from "../src/config.ts";
import { heldSecretsOf, workspaceHeldPod } from "../src/held-secrets.ts";
import type { CarriedEffect, WorkspacePod } from "../src/parts.ts";
import {
  refuseEffectSecrets,
  secretPlacementsOf,
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
  pod: { path: [], secrets: [], models: [], ...pod },
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
