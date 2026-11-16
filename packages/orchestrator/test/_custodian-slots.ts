// Slot inputs that use each kind of rule (ADR-0084), for the renderer's unit tests. The same data, for the
// pinned Envoy's validation, is in `packages/cli/test/support/custodian-slots.ts`.

import { fenceRangesOf, type EgressRule } from "../src/egress.ts";
import { leafStem, type HeldManifest } from "../src/held-secrets.ts";
import { emptyPlaceholders, withPlaceholders } from "../src/placeholders.ts";
import type { SlotInputs } from "../src/custodian-rules.ts";

export const RANGES = fenceRangesOf(undefined);

export const rule = (
  host: string,
  port: number,
  match: EgressRule["match"],
  intercept: boolean,
  ...from: EgressRule["from"]
): EgressRule => ({
  host,
  port,
  match,
  intercept,
  ...(match === "below" || match === "any" ? { tlsHttpOnly: true as const } : {}),
  from,
});

/** A Sandbox's manifest with each kind of rule: a bound model host, a bound host that an entry also
 * names, an intercepted entry with no secret, Tunneled names on 443, 80 and 22, a `*.` entry (also on 9443), `*`,
 * and two address entries, one of them intercepted. */
export const SANDBOX_MANIFEST: HeldManifest = {
  version: 1,
  secrets: [
    {
      name: "ANTHROPIC_API_KEY",
      source: { kind: "literal" },
      hosts: [{ host: "api.anthropic.com", port: 443, leaf: leafStem("api.anthropic.com", 443) }],
      headers: ["x-api-key"],
      paths: ["/v1/messages"],
    },
    {
      name: "GH_TOKEN",
      source: { kind: "secret", secret: "gh", key: "token" },
      hosts: [{ host: "api.github.com", port: 443, leaf: leafStem("api.github.com", 443) }],
      headers: ["authorization"],
    },
    {
      name: "LOCAL_KEY",
      source: { kind: "literal" },
      hosts: [{ host: "10.0.0.7", port: 8443, leaf: leafStem("10.0.0.7", 8443) }],
      headers: ["authorization"],
    },
  ],
  egress: [
    rule("api.anthropic.com", 443, "name", true, "held"),
    rule("api.github.com", 443, "name", true, "entry", "held"),
    rule("github.com", 22, "name", false, "repo"),
    rule("github.com", 80, "name", false, "entry"),
    rule("github.com", 443, "name", false, "entry"),
    rule("registry.npmjs.org", 443, "name", true, "entry"),
    rule("registry.npmjs.org", 80, "name", true, "entry"),
    rule("10.0.0.5", 8000, "address", false, "entry"),
    rule("10.0.0.7", 8443, "address", true, "held"),
    rule("githubusercontent.com", 443, "below", false, "entry"),
    rule("githubusercontent.com", 80, "below", false, "entry"),
    rule("githubusercontent.com", 9443, "below", false, "entry"),
    rule("*", 443, "any", false, "entry"),
    rule("*", 80, "any", false, "entry"),
  ],
};

/** The Instance Harness's manifest: one bound model host. */
export const INSTANCE_MANIFEST: HeldManifest = {
  version: 1,
  secrets: [
    {
      name: "JR2_PROVIDER_API_KEY",
      source: { kind: "literal" },
      hosts: [{ host: "litellm.corp.example", port: 443, leaf: leafStem("litellm.corp.example", 443) }],
      headers: ["authorization"],
    },
  ],
  egress: [rule("litellm.corp.example", 443, "name", true, "held")],
};

export function inputsOf(slot: number, manifest: HeldManifest, owner: SlotInputs["owner"]): SlotInputs {
  return {
    slot,
    owner,
    manifest,
    placeholders: withPlaceholders(emptyPlaceholders(RANGES.placeholders), manifest.egress),
    ranges: RANGES,
  };
}

/** Three slots: the Instance Harness, a check pod with nothing held, and a Sandbox. */
export const THREE_SLOTS: SlotInputs[] = [
  inputsOf(0, INSTANCE_MANIFEST, { pod: "instance" }),
  inputsOf(1, { version: 1, secrets: [], egress: [] }, { pod: "check" }),
  inputsOf(3, SANDBOX_MANIFEST, { sandbox: "ticket-a1b2c" }),
];

/** `count` slots of `entries` exact names each, for the size test. The first `intercepted` of each
 * slot are Intercepted on 443, each with a secret bound to it; the others are Tunneled, on 443 and 80
 * in turn. */
export function manySlots(count: number, entries: number, intercepted = 0): SlotInputs[] {
  const out: SlotInputs[] = [];
  for (let slot = 0; slot < count; slot++) {
    const egress: EgressRule[] = [];
    const secrets: HeldManifest["secrets"] = [];
    for (let e = 0; e < entries; e++) {
      const host = `host-${e}.example-${slot % 7}.com`;
      if (e < intercepted) {
        egress.push(rule(host, 443, "name", true, "held"));
        secrets.push({
          name: `KEY_${e}`,
          source: { kind: "literal" },
          hosts: [{ host, port: 443, leaf: leafStem(host, 443) }],
          headers: ["authorization"],
        });
      } else {
        egress.push(rule(host, e % 2 === 0 ? 443 : 80, "name", false, "entry"));
      }
    }
    out.push(inputsOf(slot, { version: 1, secrets, egress }, { sandbox: `ws-${slot}` }));
  }
  return out;
}
