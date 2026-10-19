// The Orchestrator Kit image's inputs, held to the files that already state them (ADR-0069,
// ADR-0038). The image packs kit packages and installs a third-party closure, and each of those is
// written down in two places: the Orchestrator's `workspace:` dependencies against
// `KIT_IMAGES.orchestrator.sources` and the Dockerfile's pack stage, and the kit's pnpm-lock.yaml
// against `deploy/orchestrator/closure.json`. Two lists, one truth: a second copy that drifts is a
// silent stale image (a kit package edit that does not move the tag) or an image that runs versions
// no test tier runs. So each copy is asserted here, socket-free, rather than commented at.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_IMAGES } from "../src/build.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

type Manifest = { name: string; dependencies?: Record<string, string> };

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(join(REPO, path), "utf8")) as T;

/** Every kit package by name → its `packages/<dir>`. */
async function kitPackages(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of await readdir(join(REPO, "packages"), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try {
      out.set((await readJson<Manifest>(`packages/${e.name}/package.json`)).name, `packages/${e.name}`);
    } catch {
      // not a package
    }
  }
  return out;
}

/** `packages/orchestrator` and every kit package its RUNTIME `workspace:` dependencies reach. */
async function orchestratorKitDirs(): Promise<string[]> {
  const byName = await kitPackages();
  const seen = new Set<string>();
  const visit = async (dir: string): Promise<void> => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const m = await readJson<Manifest>(`${dir}/package.json`);
    for (const [name, range] of Object.entries(m.dependencies ?? {})) {
      if (!range.startsWith("workspace:")) continue;
      const next = byName.get(name);
      assert.ok(next, `${m.name} depends on ${name} (${range}), which is no kit package`);
      await visit(next);
    }
  };
  await visit("packages/orchestrator");
  return [...seen].sort();
}

/** The parts of pnpm-lock.yaml (lockfile v9) the closure walk reads: each importer's runtime
 * dependencies and each snapshot's dependencies, as `name → version` with the peer suffix kept
 * (it is part of the snapshot key). Parsed by indent, as data: the format is regular, and the
 * suite adds no YAML dependency for one file. */
function parseLock(text: string): {
  importers: Map<string, Map<string, string>>;
  snapshots: Map<string, Map<string, string>>;
} {
  const importers = new Map<string, Map<string, string>>();
  const snapshots = new Map<string, Map<string, string>>();
  const unquote = (s: string): string => s.trim().replace(/^'|'$/g, "");
  let section = "";
  let entry: Map<string, string> | undefined;
  let block = "";
  let dep = "";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) {
      section = body.replace(/:$/, "");
      entry = undefined;
      continue;
    }
    if (section !== "importers" && section !== "snapshots") continue;
    if (indent === 2) {
      const key = unquote(body.replace(/:( \{\})?$/, ""));
      entry = new Map();
      (section === "importers" ? importers : snapshots).set(key, entry);
      block = "";
      continue;
    }
    if (indent === 4) {
      block = body.replace(/:$/, "");
      continue;
    }
    if (!entry) continue;
    const runtime = block === "dependencies" || block === "optionalDependencies";
    if (!runtime) continue;
    if (section === "snapshots" && indent === 6) {
      const at = body.indexOf(": ");
      entry.set(unquote(body.slice(0, at)), unquote(body.slice(at + 2)));
    } else if (section === "importers" && indent === 6) {
      dep = unquote(body.replace(/:$/, ""));
    } else if (section === "importers" && indent === 8 && body.startsWith("version: ")) {
      entry.set(dep, unquote(body.slice("version: ".length)));
    }
  }
  return { importers, snapshots };
}

test("the Orchestrator image's sources and pack stage name exactly the kit packages it depends on", async () => {
  const dirs = await orchestratorKitDirs();
  const sources = KIT_IMAGES.orchestrator.sources;
  for (const dir of dirs) {
    assert.ok(sources.includes(dir), `${dir} is in the image, so KIT_IMAGES.orchestrator.sources must hash it`);
  }
  assert.deepEqual(
    sources.filter((s) => s.startsWith("packages/")).sort(),
    dirs,
    "KIT_IMAGES.orchestrator.sources hashes no kit package the image does not hold",
  );

  const dockerfile = await readFile(join(REPO, "deploy/orchestrator/Dockerfile"), "utf8");
  const copied = [...dockerfile.matchAll(/^COPY (packages\/\S+) /gm)].map((m) => m[1]!).sort();
  assert.deepEqual(copied, dirs, "the Dockerfile's pack stage copies exactly the kit packages the image holds");
  const packed = /const dirs = \[([^\]]*)\]/.exec(dockerfile);
  assert.ok(packed, "the pack stage names its packages in `const dirs = [ … ]`");
  assert.deepEqual(
    [...packed[1]!.matchAll(/"([^"]+)"/g)].map((m) => `packages/${m[1]}`).sort(),
    dirs,
    "the pack stage packs exactly the packages it copies",
  );
});

test("closure.json pins the image's third-party closure at the kit lockfile's versions", async () => {
  // The image installs from the registry with npm `overrides` set from closure.json, so closure.json
  // decides what runs in the deployed Orchestrator. Every unit test and the default e2e profile run
  // pnpm-lock.yaml's versions. This is the assertion that the two are one set.
  const { importers, snapshots } = parseLock(await readFile(join(REPO, "pnpm-lock.yaml"), "utf8"));
  const closure = new Map<string, string>();
  const bare = (version: string): string => version.replace(/\(.*$/, "");
  const visit = (name: string, version: string): void => {
    if (closure.has(name)) {
      assert.equal(closure.get(name), bare(version), `the closure holds one ${name}, so the image can hoist it`);
      return;
    }
    closure.set(name, bare(version));
    const snap = snapshots.get(`${name}@${version}`);
    assert.ok(snap, `pnpm-lock.yaml has a snapshot for ${name}@${version}`);
    for (const [n, v] of snap) visit(n, v);
  };
  for (const dir of await orchestratorKitDirs()) {
    const deps = importers.get(dir);
    assert.ok(deps, `pnpm-lock.yaml has an importer for ${dir}`);
    for (const [name, version] of deps) if (!version.startsWith("link:")) visit(name, version);
  }
  assert.ok(closure.has("xstate") && closure.has("zod"), "the walk found the class-identity packages");

  const pinned = await readJson<Record<string, string>>("deploy/orchestrator/closure.json");
  assert.deepEqual(
    Object.fromEntries([...Object.entries(pinned)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    Object.fromEntries([...closure].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    "deploy/orchestrator/closure.json equals the lockfile's closure of the Orchestrator's packages",
  );
});
