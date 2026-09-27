// The known model keys (ADR-0059), checked against pi at the exact pin. `@jr2/orchestrator` holds a
// COPY of pi's data — it has no pi dependency, and `jr2 up` reads the table host-side — so this is
// the canary: a pi bump that adds a provider, renames a key, or moves a default host fails the
// default gate here, before a converge binds a key to the wrong host (the conformance role,
// ADR-0027).

import { test } from "node:test";
import assert from "node:assert/strict";
import { findEnvKeys, getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { MODEL_KEYS } from "@jr2/orchestrator";

const catalog = builtinModels();
/** Every catalog provider, with the set of base URLs its models name. */
const providers = new Map<string, Set<string>>();
for (const model of catalog.getModels()) {
  (providers.get(model.provider) ?? providers.set(model.provider, new Set()).get(model.provider)!).add(model.baseUrl);
}
/** Every env name pi reads for any provider, as the table spells them. */
const everyName = Object.fromEntries(Object.keys(MODEL_KEYS).map((name) => [name, "x"]));

/** pi's own answer for a provider's one default host: absent when a base URL is a template or
 * missing, or when two models of the provider go to different hosts. */
function defaultHost(urls: Set<string>): string | undefined {
  const hosts = new Set<string>();
  for (const url of urls) {
    if (!url || url.includes("{")) return undefined;
    const parsed = new URL(url);
    hosts.add(parsed.port && parsed.port !== "443" ? `${parsed.hostname}:${parsed.port}` : parsed.hostname);
  }
  return hosts.size === 1 ? [...hosts][0] : undefined;
}

test("every env name pi reads for a catalog provider is in the table, under that provider", () => {
  for (const provider of providers.keys()) {
    const names = findEnvKeys(provider, everyName) ?? [];
    for (const name of names) {
      assert.ok(
        MODEL_KEYS[name]?.providers.includes(provider),
        `${name} (read by pi for "${provider}") is missing from MODEL_KEYS`,
      );
    }
    // And pi reads nothing the table does not know about: an unknown key name would be refused by
    // no rule, and would sit in the Harness container's env.
    const everything = findEnvKeys(provider, new Proxy({}, { get: () => "x", has: () => true }) as never) ?? [];
    for (const name of everything)
      assert.ok(name in MODEL_KEYS, `pi reads ${name} for "${provider}", and MODEL_KEYS lacks it`);
  }
});

test("every table entry is read by pi for exactly the providers it names", () => {
  for (const [name, key] of Object.entries(MODEL_KEYS)) {
    if (name === "AWS_BEARER_TOKEN_BEDROCK") {
      // Bedrock's bearer form rides pi's credential chain, not its env-key table.
      assert.equal(getEnvApiKey("amazon-bedrock", { AWS_BEARER_TOKEN_BEDROCK: "x" }), "<authenticated>");
      continue;
    }
    for (const provider of key.providers) {
      assert.ok(
        (findEnvKeys(provider, { [name]: "x" }) ?? []).includes(name),
        `MODEL_KEYS says "${provider}" reads ${name}; pi does not`,
      );
    }
  }
});

test("every provider's default host is the table's — or the table has none where pi has none", () => {
  for (const [name, key] of Object.entries(MODEL_KEYS)) {
    const hosts = key.providers.map((p) => (providers.has(p) ? defaultHost(providers.get(p)!) : undefined));
    const agreed = hosts.every((h) => h !== undefined && h === hosts[0]) ? hosts[0] : undefined;
    assert.equal(key.host, agreed, `${name}: the table's default host is ${key.host}, pi's catalog says ${agreed}`);
  }
});
