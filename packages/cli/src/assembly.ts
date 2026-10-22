// The Assembly, staged on the host (ADR-0069). `jr2 up` materializes the Instance with the bundle
// port, strips the Kit's packages out of it, seals it, and hashes it. The result is the tree that
// `jr2 up` packs and publishes to the door. The door recomputes the same hash with the same
// function and salt, so the two ends agree on one name for one Assembly.
//
// Why strip: the Orchestrator Kit image ships `@jr2/orchestrator` and its whole dependency closure
// at `/instance/node_modules`. An Assembly lives at `/instance/.jr2/assemblies/<hash>/`, so Node's
// bare-specifier walk from any file in it reaches the image's copies, but only when the Assembly
// holds no copy of its own. A second copy of `@jr2/orchestrator`, `xstate` or `zod` is a Machine
// whose Menus are empty with no error anywhere (ADR-0054). So the closure goes, and a copy that the
// strip cannot remove is a refusal, never a silent shadow.

import { lstat, mkdtemp, readdir, readFile, readlink, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assemblyHash, discoverModules, KIT_VERSION } from "@jr2/orchestrator/internal";
import { lockfileInstall, type BuildPort } from "./build.ts";

const ORCHESTRATOR = "@jr2/orchestrator";

/** A staged Assembly: the exact tree `jr2 up` packs and publishes, and its address. */
export type StagedAssembly = {
  /** The stripped, sealed tree. */
  dir: string;
  /** `assemblyHash(dir)`: the name the door recomputes and stores it under. */
  hash: string;
  /** The `@jr2/orchestrator` version the Assembly was written against. Equal to this CLI's
   * `KIT_VERSION`, or staging refuses (ADR-0056, ADR-0069). */
  kitVersion: string;
  /** The Workflow names the door will register from `workflows/`. */
  workflows: string[];
  /** Remove the scratch directory. Always call it. */
  dispose(): Promise<void>;
};

/**
 * Stage the Instance at `instanceDir` as an Assembly (ADR-0069). The steps run in this order, and
 * each refusal names the path and the fix:
 *
 * 1. `port.bundle` materializes the Instance and its production dependencies (ADR-0043).
 * 2. pnpm's two staging records go. They record where and when the staging ran, not content.
 * 3. The Kit version is read from the staged `@jr2/orchestrator` and must equal this CLI's.
 * 4. The Kit closure is stripped ({@link stripKitClosure}).
 * 5. Every `node_modules/.bin` goes: the Orchestrator runs no bin from an Assembly.
 * 6. The seal is checked ({@link checkSealed}). Nothing is rewritten.
 * 7. The tree is hashed with nothing excluded (ADR-0038), and its Workflows are listed.
 */
export async function stageAssembly(port: BuildPort, instanceDir: string): Promise<StagedAssembly> {
  const scratch = await mkdtemp(join(tmpdir(), "jr2-assembly-"));
  const dir = join(scratch, "assembly");
  const dispose = () => rm(scratch, { recursive: true, force: true });
  try {
    await port.bundle(instanceDir, dir);
    // `.modules.yaml` holds a `prunedAt` stamp and the scratch paths; `.pnpm-workspace-state.json`
    // holds a `lastValidatedTimestamp`. Either one alone gives every staging a new hash.
    for (const record of [".modules.yaml", ".pnpm-workspace-state.json"]) {
      await rm(join(dir, "node_modules", record), { force: true });
    }
    const kitVersion = await readKitVersion(dir, instanceDir);
    await stripKitClosure(dir);
    await removeBinDirs(dir);
    await checkSealed(dir);
    const hash = await assemblyHash(dir);
    const workflows = (await discoverModules(join(dir, "workflows"))).map((m) => m.name);
    return { dir, hash, kitVersion, workflows, dispose };
  } catch (err) {
    await dispose();
    throw err;
  }
}

/** Step 3: the version the Assembly was written against. ADR-0056's refusal, moved here; the door
 * repeats it, so a publish with a CLI of another version never reaches an import. */
async function readKitVersion(dir: string, instanceDir: string): Promise<string> {
  const manifest = join(dir, "node_modules", ORCHESTRATOR, "package.json");
  let text: string | undefined;
  try {
    text = await readFile(manifest, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let version: string | undefined;
  if (text !== undefined) {
    try {
      version = (JSON.parse(text) as { version?: string }).version;
    } catch (err) {
      throw new Error(
        `the Assembly staged from ${instanceDir} has a ${ORCHESTRATOR} whose manifest does not parse ` +
          `(node_modules/${ORCHESTRATOR}/package.json: ${(err as Error).message}) — reinstall ` +
          `${ORCHESTRATOR}@${KIT_VERSION} in ${instanceDir}`,
      );
    }
  }
  if (version === undefined) {
    throw new Error(
      `the Assembly staged from ${instanceDir} has no ${ORCHESTRATOR} (no node_modules/${ORCHESTRATOR}/package.json) — ` +
        `an Assembly names the Kit version it was written against; run ` +
        `\`${await addCommand(instanceDir)} ${ORCHESTRATOR}@${KIT_VERSION}\` in ${instanceDir} and commit the lockfile`,
    );
  }
  if (version !== KIT_VERSION) {
    throw new Error(
      `Kit version mismatch — an Instance has one (ADR-0056, ADR-0069): the Assembly staged from ${instanceDir} ` +
        `resolves ${ORCHESTRATOR} ${version}, and this jr2 is ${KIT_VERSION}; pin "${ORCHESTRATOR}" and ` +
        `"@jr2/cli" at ONE exact version in ${join(instanceDir, "package.json")} and reinstall`,
    );
  }
  return version;
}

/** The add command of the package manager that installs this Instance, so the fix in a refusal
 * does not write a second lockfile. An Instance with no lockfile of its own stages through `pnpm
 * deploy` in its workspace (ADR-0043). */
async function addCommand(instanceDir: string): Promise<string> {
  let manager = "pnpm";
  try {
    manager = (await lockfileInstall(instanceDir)).command;
  } catch {
    // no lockfile, or more than one: the bundle step named that already; pnpm is the workspace path
  }
  return manager === "npm" ? "npm i" : `${manager} add`;
}

// --- the Kit closure ----------------------------------------------------------------------------

/** One package that Node resolution reaches inside the staged tree. */
type Resolved = { name: string; path: string; real: string };

/**
 * Resolve `name` the way Node would from code in `fromDir`: the nearest `<ancestor>/node_modules/
 * <name>` walking up, never above `root` and never outside it (the staged tree is all the Assembly
 * carries; above it is the Kit image). Node skips an ancestor that is itself named `node_modules`.
 */
async function resolveFrom(root: string, fromDir: string, name: string): Promise<Resolved | undefined> {
  for (let d = fromDir; isInside(root, d); d = dirname(d)) {
    if (basename(d) !== "node_modules") {
      const path = join(d, "node_modules", name);
      try {
        if ((await stat(path)).isDirectory()) return { name, path, real: await realpath(path) };
      } catch {
        // not here; keep walking
      }
    }
    if (d === root) return undefined;
  }
  return undefined;
}

/** The `dependencies` and `optionalDependencies` of the package at `dir`: what a production
 * install puts on disk, so what the Kit image ships too (`npm install --omit=dev` installs both).
 * Not `devDependencies` (absent from a production install) and not `peerDependencies` (the
 * dependent supplies them, so they are its closure). A manifest that does not parse is refused:
 * the closure would shrink without a word. */
async function dependenciesOf(dir: string, root: string): Promise<string[]> {
  const manifest = join(dir, "package.json");
  let text: string;
  try {
    text = await readFile(manifest, "utf8");
  } catch {
    return [];
  }
  try {
    const m = JSON.parse(text) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return [...new Set([...Object.keys(m.dependencies ?? {}), ...Object.keys(m.optionalDependencies ?? {})])];
  } catch (err) {
    const shown = isInside(root, manifest) ? relative(root, manifest) : manifest;
    throw new Error(
      `cannot stage the Assembly: ${shown} does not parse (${(err as Error).message}), so the Kit closure ` +
        `that the strip removes is unknown (ADR-0069) — reinstall the Instance's dependencies`,
    );
  }
}

/**
 * The Kit closure of the staged tree at `dir` (ADR-0069): `@jr2/orchestrator` and every package its
 * `dependencies` reach, transitively, resolved by Node's rule inside the tree. Names, because the
 * rule is about names: any copy of a closure package in an Assembly shadows the image's copy. A
 * name that resolves to nothing in the tree is still in the closure (the image ships it), but its
 * own dependencies are unknown here, so the walk stops at it.
 */
export async function closureOf(dir: string): Promise<Set<string>> {
  return new Set((await resolveClosure(await realpath(dir))).names);
}

async function resolveClosure(root: string): Promise<{ names: string[]; resolved: Resolved[] }> {
  const names = new Set<string>([ORCHESTRATOR]);
  const resolved: Resolved[] = [];
  const seen = new Set<string>();
  const top = await resolveFrom(root, root, ORCHESTRATOR);
  const queue: Resolved[] = top ? [top] : [];
  while (queue.length > 0) {
    const pkg = queue.shift()!;
    if (seen.has(pkg.real)) continue;
    seen.add(pkg.real);
    resolved.push(pkg);
    // Node resolves from a module's REAL location. When a link takes a package out of the tree (a
    // workspace link that `pnpm deploy` writes back into the checkout), that location is host
    // geography: its `node_modules` are not in the Assembly and not in the image. So the walk
    // resolves from the directory that holds the link, which is where the image puts the package.
    // Not from the link itself: its own `node_modules` is the checkout's too.
    const from = isInside(root, pkg.real) ? pkg.real : dirname(pkg.path);
    for (const dep of await dependenciesOf(pkg.real, root)) {
      names.add(dep);
      const next = await resolveFrom(root, from, dep);
      if (next) queue.push(next);
    }
  }
  return { names: [...names].sort(), resolved };
}

/**
 * Step 4: strip the Kit closure from the staged tree at `dir`. Every `node_modules/<name>` entry of
 * a closure package goes when it IS the copy the closure resolved (the directory itself, or a link
 * to it). Both bundle paths install hoisted (`npm ci`, `bun`, and pnpm with `node-linker=hoisted`),
 * so these are top-level entries, and the tree holds no pnpm store. An entry
 * of a closure name that is ANY OTHER copy is refused, naming its path and the package that nests
 * it: the strip cannot remove it without breaking its nester, and keeping it is a second copy of a
 * Kit package (ADR-0054). Nothing is deleted until the whole tree is known to be clean.
 */
async function stripKitClosure(dir: string): Promise<void> {
  const root = await realpath(dir);
  const { names, resolved } = await resolveClosure(root);
  const closure = new Set(names);
  const kitDirs = new Set(resolved.map((r) => r.real));
  const viaKit = (real: string) => [...kitDirs].some((k) => isInside(k, real));

  const remove: string[] = [];
  const refusals: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.name === "node_modules" && e.isDirectory()) {
        await walkNodeModules(p);
      } else if (e.isDirectory()) {
        await walk(p);
      }
    }
  };
  // `nm` is one `node_modules` directory: its entries are package names (a scope is one level more).
  const walkNodeModules = async (nm: string): Promise<void> => {
    for (const e of await readdir(nm, { withFileTypes: true })) {
      const p = join(nm, e.name);
      if (e.name.startsWith("@") && e.isDirectory()) {
        for (const s of await readdir(p, { withFileTypes: true })) await visitPackage(nm, `${e.name}/${s.name}`);
      } else {
        await visitPackage(nm, e.name);
      }
    }
  };
  const visitPackage = async (nm: string, name: string): Promise<void> => {
    const p = join(nm, name);
    const st = await lstat(p);
    if (closure.has(name)) {
      let real: string | undefined;
      try {
        real = await realpath(p);
      } catch {
        real = undefined;
      }
      // A link to nothing, or to a place outside the tree, carries no copy: it goes with the rest.
      if (real === undefined || kitDirs.has(real) || viaKit(real) || !isInside(root, real)) {
        remove.push(p);
        return;
      }
      refusals.push(
        `${relative(root, p)} is a second copy of ${name}, nested by ${await nesterOf(root, nm)}: ` +
          `the Orchestrator's image ships ${name} for ${ORCHESTRATOR} ${KIT_VERSION}, and an Assembly that ` +
          `carries its own copy loads Machines whose Menus are empty (ADR-0054) — align that dependency ` +
          `with the ${name} ${ORCHESTRATOR} uses, or remove it, and reinstall`,
      );
      return;
    }
    // A package outside the closure is the Instance's own; its nested `node_modules` can still hide
    // a copy of a Kit package. A link leads elsewhere in the tree, which the walk reaches there.
    if (st.isDirectory()) await walk(p);
  };
  await walk(root);

  if (refusals.length > 0) {
    throw new Error(
      `cannot stage the Assembly: it would carry a second copy of a Kit package (ADR-0069)\n  ${refusals.join("\n  ")}`,
    );
  }
  for (const p of new Set(remove)) {
    await rm(p, { recursive: true, force: true });
    // A scope directory the strip emptied goes too: it is a record of a package that is gone.
    const scope = dirname(p);
    if (basename(scope).startsWith("@") && (await readdir(scope).catch(() => ["?"])).length === 0) {
      await rm(scope, { recursive: true, force: true });
    }
  }
}

/** The package whose `node_modules` is `nm`, by its manifest's name, for a refusal. */
async function nesterOf(root: string, nm: string): Promise<string> {
  const owner = dirname(nm);
  if (owner === root) return "the Instance itself";
  try {
    const m = JSON.parse(await readFile(join(owner, "package.json"), "utf8")) as { name?: string; version?: string };
    if (m.name) return `${m.name}${m.version ? `@${m.version}` : ""} (${relative(root, owner)})`;
  } catch {
    // not a package directory — name the directory
  }
  return relative(root, owner);
}

// --- `.bin` and the seal ------------------------------------------------------------------------

/** Step 5: every `node_modules/.bin`, at any depth. The Orchestrator runs no bin from an Assembly
 * (an Effect runs in an Effector, ADR-0068), and a shim names the staging path in its `NODE_PATH`,
 * which no rewrite can turn into a path that contains its own hash (ADR-0069). */
async function removeBinDirs(dir: string): Promise<void> {
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      // Whatever its type: a `.bin` that is a link is a bin directory too.
      if (e.name === ".bin" && basename(d) === "node_modules") await rm(p, { recursive: true, force: true });
      else if (e.isDirectory()) await walk(p);
    }
  };
  await walk(dir);
}

/**
 * The seal's two checks (ADR-0038, ADR-0069): the staged tree must record nothing about where it
 * was staged, so one hash names one Assembly. A symlink whose target names the staging path, or a
 * file that holds it, refuses the stage, naming the path. Nothing is rewritten: the `.bin` shims
 * the old seal rewrote are deleted now, so whatever still holds the path is unknown content.
 *
 * Both spellings of the staging path are checked: the one `mkdtemp` returned and the one `realpath`
 * resolves it to. On macOS `/var` is a link to `/private/var`, so the two differ.
 */
export async function checkSealed(dir: string): Promise<void> {
  const spellings = [...new Set([resolve(dir), await realpath(dir)])].sort((a, b) => b.length - a.length);
  const needles = spellings.map((s) => Buffer.from(s));
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) {
        // `assemblyHash` hashes a link's target, so a link that names the staging path gives every
        // staging a new hash, and the door's tree would name a directory it does not have.
        const target = await readlink(p);
        if (spellings.some((s) => target.includes(s))) {
          throw new Error(
            `cannot seal the Assembly: the symlink ${relative(dir, p)} points at the staging path ("${target}") — ` +
              `the Assembly would name a directory the Orchestrator does not have; make the link relative ` +
              `in the package that writes it`,
          );
        }
        // The door refuses a link that leaves the Assembly (ADR-0069); name it here, before the
        // cluster work, with the fix.
        if (isAbsolute(target) || !isInside(dir, resolve(dirname(p), target))) {
          const rel = relative(dir, p);
          // A link under `node_modules` is a package manager's; a link elsewhere is the Instance's own.
          const fix = rel.split(sep).includes("node_modules")
            ? "install that dependency as a copy, not a link"
            : "make the link relative, with a target inside the Instance";
          throw new Error(
            `cannot seal the Assembly: the symlink ${rel} points outside the Assembly ("${target}") — ` +
              `an Assembly carries only what it holds; ${fix}`,
          );
        }
      } else if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile()) {
        const bytes = await readFile(p);
        if (needles.some((n) => bytes.includes(n))) {
          throw new Error(
            `cannot seal the Assembly: ${relative(dir, p)} holds the staging path (${spellings[0]}) — ` +
              `the Assembly would record where it was staged, and two stagings of one Instance would get two ` +
              `hashes; find what writes the install path into that file and stop it (a postinstall step is the ` +
              `usual cause)`,
          );
        }
      }
    }
  };
  await walk(dir);
}

// --- where a host directory sits in the Assembly -------------------------------------------------

/**
 * The staged copy of a host directory (ADR-0069): what the Orchestrator holds in place of `dir`
 * once the Assembly lands. A directory under the Instance root keeps its relative path. A
 * directory a dependency ships sits under that package's hoisted copy, `node_modules/<name>/…`:
 * a module's `file:` URL names the module's real location, and pnpm links a workspace package to
 * its checkout, outside the root. `undefined` when the Assembly does not carry it.
 *
 * This is what keys a `file:` Sandbox Image context (ADR-0037, ADR-0049): the host digests the
 * staged copy, the door and every provision digest the landed copy, and the two are the same bytes
 * by construction. The Instance folder's own copy can differ, since staging drops `node_modules`,
 * `.git`, `.env` and `.npmrc` at every depth (ADR-0043), so a digest of it would name a context
 * the Orchestrator never sees.
 */
export async function stagedCopyOf(stagedDir: string, root: string, dir: string): Promise<string | undefined> {
  const real = await realpath(dir).catch(() => dir);
  const rootReal = await realpath(root).catch(() => root);
  let candidate: string | undefined;
  if (isInside(rootReal, real)) candidate = join(stagedDir, relative(rootReal, real));
  else {
    const pkg = await packageAbove(real);
    if (pkg) candidate = join(stagedDir, "node_modules", pkg.name, relative(pkg.dir, real));
  }
  if (candidate === undefined) return undefined;
  try {
    return (await stat(candidate)).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** The nearest package above `dir`, by its manifest's name; undefined when no manifest names one. */
async function packageAbove(dir: string): Promise<{ name: string; dir: string } | undefined> {
  for (let d = dir; ; d = dirname(d)) {
    try {
      const m = JSON.parse(await readFile(join(d, "package.json"), "utf8")) as { name?: string };
      if (m.name) return { name: m.name, dir: d };
    } catch {
      // no manifest here; keep walking
    }
    if (dirname(d) === d) return undefined;
  }
}

function isInside(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}
