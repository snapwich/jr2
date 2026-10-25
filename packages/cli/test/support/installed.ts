// An Instance folder laid out as npm leaves one (ADR-0043's installed shape), staged from this
// checkout, for the tests that must not see the checkout's pnpm links: `typecheck.test.ts` (the
// compiler reads the kit's sources as an installed Instance holds them) and `check.test.ts` (the
// `jr2` binary loads the kit's sources from under `node_modules`, where Node does not strip types).

import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const REPO_TYPESCRIPT = join(REPO, "node_modules", "typescript");
const ORCHESTRATOR = join(REPO, "packages", "orchestrator");
const CLI = join(REPO, "packages", "cli");

type Manifest = { files: string[]; dependencies?: Record<string, string> };

/** Copy the `files:` list of the package at `from` to `to`, with a manifest that has no
 * devDependencies, as `npm pack` and an install leave it. */
async function copyPackage(from: string, to: string): Promise<Manifest> {
  const pkg = JSON.parse(await readFile(join(from, "package.json"), "utf8")) as Manifest;
  await mkdir(to, { recursive: true });
  for (const entry of pkg.files) {
    // The docs bundle is made at pack time (ADR-0072), so a checkout holds none until docs:build.
    // The compiler and the loader read no file of it.
    if (!existsSync(join(from, entry))) continue;
    await cp(join(from, entry), join(to, entry), { recursive: true });
  }
  await writeFile(join(to, "package.json"), JSON.stringify({ ...pkg, devDependencies: undefined }));
  return pkg;
}

/** An instance as npm leaves one, staged from this checkout (ADR-0043's installed shape).
 *
 * Faithful in the one way that matters: `node_modules/@jr2/orchestrator` is a COPY of the package's
 * `files:` list with no `node_modules` of its own, and only its declared `dependencies` sit beside
 * it. So a kit source reaching for a devDependency — `@jr2/harness`, which is private and never
 * published (ADR-0009/0043) — is `Cannot find module` here and nowhere else in the default gate.
 * With `cli`, `node_modules/@jr2/cli` is a copy of the CLI's `files:` list in the same way.
 */
export async function mkInstalledInstance(opts: { cli?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jr2-installed-"));
  const modules = join(root, "node_modules");
  const pkg = await copyPackage(ORCHESTRATOR, join(modules, "@jr2", "orchestrator"));
  // `cli`: the Instance's own `@jr2/cli` too, as the scaffold pins it in devDependencies. A `jr2`
  // from the checkout then hands off to this copy (ADR-0056), and this copy loads the kit from here.
  const cli = opts.cli ? await copyPackage(CLI, join(modules, "@jr2", "cli")) : undefined;

  // Flat-hoisted, as npm and pnpm's default public hoisting both leave them. Each is the link the
  // workspace already resolved, so the versions under test are the versions that ship.
  const deps = new Set([...Object.keys(pkg.dependencies ?? {}), "@types/node"]);
  for (const dep of [...deps]) {
    await mkdir(join(modules, dirname(dep)), { recursive: true });
    await symlink(join(ORCHESTRATOR, "node_modules", dep), join(modules, dep), "dir");
  }
  for (const dep of Object.keys(cli?.dependencies ?? {}).filter((d) => !deps.has(d))) {
    await mkdir(join(modules, dirname(dep)), { recursive: true });
    await symlink(join(CLI, "node_modules", dep), join(modules, dep), "dir");
  }
  await symlink(REPO_TYPESCRIPT, join(modules, "typescript"), "dir");

  // What `jr2 init` scaffolds, verbatim in shape: an ESM package, the real extends chain, and one
  // workflow that imports the kit — which is what pulls @jr2/orchestrator's sources into the program.
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "staged", private: true, type: "module" }));
  await writeFile(
    join(root, "tsconfig.json"),
    `{ "extends": "@jr2/orchestrator/tsconfig.instance.json", "include": ["**/*.ts"] }`,
  );
  // The config imports the kit by BARE specifier, so this is also where "does the package resolve
  // the way npm laid it out?" is answered; in the checkout it resolves through a pnpm link instead.
  await writeFile(
    join(root, "jr2.config.ts"),
    `import { defineConfig } from "@jr2/orchestrator";\n` +
      `export default defineConfig({ git: { credentials: [{ match: "*", token: "JR2_GIT_TOKEN" }] } });\n`,
  );
  await mkdir(join(root, "workflows"), { recursive: true });
  await writeFile(
    join(root, "workflows", "ping.ts"),
    `import { jr2Setup } from "@jr2/orchestrator";\n` +
      `export const machine = jr2Setup({ events: [] }).createMachine({\n` +
      `  id: "ping",\n  initial: "done",\n  states: { done: { type: "final" } },\n});\n`,
  );
  return root;
}
