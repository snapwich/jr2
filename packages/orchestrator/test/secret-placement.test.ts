// Where a secret goes (ADR-0068): placement is read off the `secrets` list and the Effects that name
// it — `hosts` makes a Held secret, `secret("name")` in an Effect makes an Effect secret, both is
// both, and neither goes nowhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JR2Config } from "../src/config.ts";
import type { CarriedEffect } from "../src/parts.ts";
import { secretPlacementsOf, type PlacedEffect } from "../src/secret-placement.ts";

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

test("hosts makes a Held secret; secret() in an Effect makes an Effect secret; both is both; neither warns", () => {
  const config: JR2Config = {
    secrets: [
      { name: "GATEWAY_KEY", value: VALUE, hosts: ["gw.example.com"] },
      { name: "jira", value: VALUE },
      { name: "SHARED_KEY", value: VALUE, hosts: ["api.example.com"] },
      { name: "orphan", value: VALUE },
    ],
  };
  const out = secretPlacementsOf(config, [httpEffect("comment", ["jira"]), httpEffect("mirror", ["SHARED_KEY"])]);
  assert.deepEqual(out.report, [
    "secret GATEWAY_KEY: Held (every Custodian)",
    "secret jira: an Effect secret in the Instance Effector (ticket/comment)",
    "secret SHARED_KEY: Held (every Custodian) and an Effect secret in the Instance Effector (ticket/mirror)",
  ]);
  assert.deepEqual(out.warnings, [
    "secrets[3] (orphan) is named by nothing; goes nowhere — no hosts, and no Effect names it (ADR-0068)",
  ]);
  assert.deepEqual(out.instance?.secrets, [
    { name: "jira", source: { kind: "literal" } },
    { name: "SHARED_KEY", source: { kind: "literal" } },
  ]);
  assert.deepEqual(out.instance?.values, { jira: VALUE, SHARED_KEY: VALUE }, "only the Effect secrets' values");
});

test("a known model key with no hosts is Held: its hosts default (ADR-0059)", () => {
  const out = secretPlacementsOf({ secrets: [{ name: "ANTHROPIC_API_KEY", value: VALUE }] }, []);
  assert.deepEqual(out.report, ["secret ANTHROPIC_API_KEY: Held (every Custodian)"]);
  assert.equal(out.instance, undefined, "no Effect is placed there: no Instance Effector");
});

test("an Effect secret shorter than 8 characters is refused, and says why", () => {
  assert.throws(
    () => secretPlacementsOf({ secrets: [{ name: "jira", value: "short" }] }, [httpEffect("comment", ["jira"])]),
    /secrets\[0\] \(jira\) is an Effect secret shorter than 8 characters.*match ordinary text/,
  );
  // A Held-only secret is not scrubbed by an Effector: the rule is the Effect secret's.
  assert.doesNotThrow(() => secretPlacementsOf({ secrets: [{ name: "K", value: "short", hosts: ["a.example"] }] }, []));
});

test("an Effect that names a secret the list does not hold is refused with the line to add", () => {
  assert.throws(
    () => secretPlacementsOf({ secrets: [] }, [httpEffect("comment", ["jira-token"])]),
    /"comment" names secret\("jira-token"\).*secrets: \[\{ name: "jira-token", value: process\.env\.JIRA_TOKEN \}\]/,
  );
});

test("a valueFrom Effect secret is a reference: its Secret and key must exist, and its value is never read", () => {
  const config: JR2Config = { secrets: [{ name: "jira", valueFrom: { secretKeyRef: { name: "team", key: "jira" } } }] };
  assert.throws(
    () => secretPlacementsOf(config, [httpEffect("c", ["jira"])], { secretKeys: () => undefined }),
    /names Secret "team", which does not exist/,
  );
  const out = secretPlacementsOf(config, [httpEffect("c", ["jira"])], { secretKeys: () => ["jira"] });
  assert.deepEqual(out.instance?.secrets, [{ name: "jira", source: { kind: "secret", secret: "team", key: "jira" } }]);
  assert.deepEqual(out.instance?.values, {});
});

test("the Instance Effector's targets and its longest timeout come from the Effects placed there", () => {
  const out = secretPlacementsOf({ secrets: [{ name: "jira", value: VALUE }] }, [
    httpEffect("a", ["jira"]),
    httpEffect("b", ["jira"], { timeoutMs: 120_000 }),
    httpEffect("c", [], { target: { scheme: "http", host: "echo.seed.svc", port: 8080 } } as Partial<CarriedEffect>),
  ]);
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
        [],
      ),
    /secrets\[1\]\.name x is listed twice/,
  );
});
