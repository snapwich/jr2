// The Orchestrator's known model keys (ADR-0059), made from pi-ai's data at the exact pin this
// package holds. `@jr2/orchestrator` has no pi dependency and must not grow one, so it does not read
// pi at run time: this script writes the table as plain data, and the file is checked in.
//
//   node packages/harness/scripts/model-keys.ts [out-file]   (default: model-keys.generated.ts)
//
// `just model-keys` runs it. The script formats the file with the repo's prettier config itself, so
// the checked-in text is exactly what it makes. Run it at each pi bump. `test/model-keys.test.ts` is
// the gate: it checks the table against pi itself, and that the file is this script's text.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { findEnvKeys, getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/** One known model key, as the Orchestrator's `ModelKey` has it, and why it has no host. */
export type GeneratedKey = { providers: string[]; host?: string; noHost?: string };

/** The name pi reads for Bedrock's bearer form. It rides pi's credential chain, not its env-key
 * table, so `findEnvKeys` does not name it. */
const BEDROCK_BEARER = "AWS_BEARER_TOKEN_BEDROCK";

/** The host a set of base URLs goes to, or why there is not one. A port other than 443 is part of
 * the host. */
function hostOf(urls: readonly string[]): { host: string } | { noHost: string } {
  const hosts = new Set<string>();
  for (const url of urls) {
    if (!url) return { noHost: "the catalog names no base URL" };
    if (url.includes("{")) return { noHost: "a base URL is a template" };
    const parsed = new URL(url);
    hosts.add(parsed.port && parsed.port !== "443" ? `${parsed.hostname}:${parsed.port}` : parsed.hostname);
  }
  if (hosts.size !== 1) return { noHost: `the calls go to more than one host: ${[...hosts].join(", ")}` };
  return { host: [...hosts][0]! };
}

/** pi's known model keys: each env name that pi reads for a catalog provider, the providers that
 * read it (in catalog order), and their one default host. Names are in the order of their first
 * provider, then the order pi reads them in. */
export function modelKeys(): Record<string, GeneratedKey> {
  const urls = new Map<string, string[]>();
  for (const model of builtinModels().getModels()) {
    const list = urls.get(model.provider) ?? urls.set(model.provider, []).get(model.provider)!;
    if (!list.includes(model.baseUrl)) list.push(model.baseUrl);
  }
  const every = new Proxy({}, { get: () => "x", has: () => true }) as never;
  const providersOf = new Map<string, string[]>();
  for (const provider of urls.keys()) {
    for (const name of findEnvKeys(provider, every) ?? []) {
      (providersOf.get(name) ?? providersOf.set(name, []).get(name)!).push(provider);
    }
  }
  if (getEnvApiKey("amazon-bedrock", { [BEDROCK_BEARER]: "x" }) !== "<authenticated>") {
    throw new Error(`pi no longer reads ${BEDROCK_BEARER} for amazon-bedrock: the table must say what replaces it`);
  }
  if (!providersOf.has(BEDROCK_BEARER)) providersOf.set(BEDROCK_BEARER, ["amazon-bedrock"]);
  const order = [...urls.keys()];
  const names = [...providersOf.keys()].sort(
    (a, b) => order.indexOf(providersOf.get(a)![0]!) - order.indexOf(providersOf.get(b)![0]!),
  );
  return Object.fromEntries(
    names.map((name) => {
      const providers = providersOf.get(name)!;
      return [name, { providers, ...hostOf(providers.flatMap((p) => urls.get(p)!)) }];
    }),
  );
}

/** The checked-in file, from the repo root. */
export const MODEL_KEYS_FILE = fileURLToPath(
  new URL("../../orchestrator/src/model-keys.generated.ts", import.meta.url),
);

/** The table as the Orchestrator's source file, formatted as `out` (the file's path) is. */
export async function modelKeysSource(keys: Record<string, GeneratedKey>, out: string): Promise<string> {
  // The pin this package holds: pi-ai exports no `package.json`.
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const version = manifest.dependencies["@earendil-works/pi-ai"];
  const lines = Object.entries(keys).flatMap(([name, key]) => [
    ...(key.noHost ? [`  // No default host: ${key.noHost}.`] : []),
    `  ${name}: { providers: ${JSON.stringify(key.providers)}${key.host ? `, host: ${JSON.stringify(key.host)}` : ""} },`,
  ]);
  const text = [
    `// Made from @earendil-works/pi-ai ${version} by \`just model-keys\` (packages/harness/scripts/model-keys.ts).`,
    "// Do not edit: run the recipe at each pi bump. `model-keys.ts` says what the table means (ADR-0059).",
    "",
    'import type { ModelKey } from "./model-keys.ts";',
    "",
    "export const MODEL_KEYS: Readonly<Record<string, ModelKey>> = {",
    ...lines,
    "};",
    "",
  ].join("\n");
  return format(text, { ...(await resolveConfig(out)), filepath: out });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? MODEL_KEYS_FILE;
  writeFileSync(out, await modelKeysSource(modelKeys(), out));
}
