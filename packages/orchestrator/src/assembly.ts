// The current Assembly on the Orchestrator's own volume, and the door that publishes the next one
// (ADR-0069). The Kit image holds the engine; an Instance's Workflows, its `jr2.config.ts` and
// what they import arrive as an Assembly that `jr2 up` publishes over `PUT /assembly`. This module
// owns the layout, the pointer, the publish, and which Assembly a boot loads.
//
// The layout, under the state volume (`<dir>/.jr2`, mounted at `/instance/.jr2` when deployed):
//
//   assemblies/<hash>/          the tree, exactly as unpacked
//   assemblies/<hash>.json      { hash, kitVersion, workflows, publishedAt }, outside the tree
//   assemblies/current          one line: the current hash
//   assemblies/.staging-*       a publish in flight; removed at boot and on failure
//
// A publish is atomic. The tree lands under its hash, then one rename flips `current`. A crash
// before the flip leaves the old Assembly current; a crash after it boots the new one. The pod
// never rolls for a publish: the process reloads.
//
// There is one way in: the door. The Orchestrator never loads the folder it was started in, so a
// test, the e2e fixture and `jr2 up` all cross the same checks and write the same layout.

import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { AssemblyTarRefusal, unpackAssembly } from "./assembly-tar.ts";
import { KIT_VERSION } from "./config.ts";
import { assemblyHash } from "./content-hash.ts";

/** The Assembly a process serves: where its tree is, its hash, and the Kit version it names. */
export type CurrentAssembly = {
  /** The directory `loadConfig` and `loadWorkflows` read: `assemblies/<hash>`. */
  root: string;
  hash: string;
  kitVersion: string;
};

/** What `<hash>.json` holds: the record of one published Assembly, written beside its tree. */
export type AssemblyRecord = { hash: string; kitVersion: string; workflows: string[]; publishedAt: string };

/** Which Assembly a boot loads, or none and why. */
export type ResolvedAssembly = {
  current: CurrentAssembly | null;
  /** Why there is no current Assembly when the volume says there should be one. */
  error?: string;
};

/** An Assembly that live runs hold (ADR-0069), as `GET /assembly` lists it. */
export type HeldAssembly = { hash: string; kitVersion: string; runs: string[] };

/** `GET /assembly`'s body. */
export type AssemblyView = {
  kitVersion: string;
  current: { hash: string; kitVersion: string; workflows: string[] } | null;
  held: HeldAssembly[];
};

/** The Assemblies directory under an instance folder. */
export function assembliesDir(dir: string): string {
  return join(dir, ".jr2", "assemblies");
}

/** The shape of an Assembly hash (`assemblyHash`'s 12 hex digits). Checked before a hash names a
 * path, so a header or a pointer cannot name a directory outside `assemblies/`. */
const HASH = /^[0-9a-f]{12}$/;

/** True when `hash` has the shape of an Assembly hash. */
export function isAssemblyHash(hash: string | undefined): hash is string {
  return hash !== undefined && HASH.test(hash);
}

/**
 * Which Assembly a boot loads (ADR-0069): the one `assemblies/current` names, when its tree and
 * record are on the volume and its Kit version is this Orchestrator's. Otherwise none, and the
 * process serves with no Workflows (ADR-0048: degrade the capability, not the daemon). A pointer
 * that names a missing tree, or an Assembly published for another Kit version, is that case, with
 * the reason in `error`. No pointer at all is volume loss, or a Kit image before its first
 * publish: no reason to give.
 */
export async function resolveAssembly(dir: string): Promise<ResolvedAssembly> {
  const pointed = await readPointer(dir);
  if (pointed === undefined) return { current: null };
  const found = await publishedAssembly(dir, pointed);
  if ("current" in found) return { current: found.current };
  return { current: null, error: found.error };
}

/** The hash `current` names, or undefined when there is no pointer. A pointer with no hash shape
 * reads as a hash that is not on the volume: it is reported, never followed. */
async function readPointer(dir: string): Promise<string | undefined> {
  try {
    return (await readFile(join(assembliesDir(dir), "current"), "utf8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** One published Assembly by hash, with its record — or why it cannot be the current one. */
async function publishedAssembly(dir: string, hash: string): Promise<{ current: CurrentAssembly } | { error: string }> {
  const missing = { error: `current names ${hash}, which is not on the volume` };
  if (!isAssemblyHash(hash)) return missing;
  const root = join(assembliesDir(dir), hash);
  try {
    if (!(await stat(root)).isDirectory()) return missing;
  } catch {
    return missing;
  }
  let record: AssemblyRecord;
  try {
    record = JSON.parse(await readFile(join(assembliesDir(dir), `${hash}.json`), "utf8")) as AssemblyRecord;
  } catch {
    return { error: `current names ${hash}, whose record ${hash}.json is not on the volume` };
  }
  // The Kit version bump of ADR-0069: `jr2 up` rolls the image first and publishes second. The new
  // image boots on the old pointer, and an Assembly written against another Kit version is not one
  // this process may import, so it serves with none until the publish.
  if (record.kitVersion !== KIT_VERSION) {
    return {
      error:
        `current names ${hash}, published for Kit version ${record.kitVersion}; this Orchestrator is ` +
        `${KIT_VERSION} — \`jr2 up\` publishes an Assembly built against it`,
    };
  }
  return { current: { root, hash, kitVersion: record.kitVersion } };
}

/** The temp file `writeDurably` renames over its target. A crash before the rename leaves one. */
const DURABLE_TMP = /\.tmp-[0-9a-f]{8}$/;

/** Remove every `.staging-*` a crashed publish left, and every temp file a crashed pointer or
 * record write left. A boot ignores them; this is the cleanup. */
export async function removeStaging(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(assembliesDir(dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of names) {
    if (name.startsWith(".staging-") || DURABLE_TMP.test(name)) {
      await rm(join(assembliesDir(dir), name), { recursive: true, force: true });
    }
  }
}

/**
 * What the process makes of an Assembly before it lands: the Workflow names, the walk's refusals,
 * and the step that makes it current. `activate` holds the Machines and the config the import
 * already loaded, so the swap after the pointer flips imports nothing and cannot half-apply.
 */
export type LoadedAssembly = {
  refusals: string[];
  workflows: string[];
  activate: (next: CurrentAssembly) => Promise<void>;
};

/** A publish as it reaches the door, after authentication. */
export type PublishRequest = {
  /** The `jr2-kit-version` header. */
  kitVersion: string | undefined;
  /** The `jr2-assembly-hash` header. */
  hash: string | undefined;
  /** The tarball. Read only when the checks before it pass. */
  body: WebReadableStream<Uint8Array> | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | null;
};

/** What the door answers: an HTTP status and its JSON body. */
export type PublishAnswer = { status: 200 | 400 | 409 | 422 | 500; body: Record<string, unknown> };

export type AssemblyDoorOptions = {
  /** The instance folder: the Assemblies live under `<dir>/.jr2/assemblies`. */
  dir: string;
  /** The Assembly the process serves now. */
  current: () => CurrentAssembly | null;
  /** The names the process registers now, for `GET /assembly`. */
  workflows: () => string[];
  /** The live runs by the Assembly hash they hold. */
  holds: () => Map<string, string[]>;
  /**
   * Import a tree and walk it (ADR-0069): the config, every Workflow, and the refusals the
   * Orchestrator can see. The tree is already at `assemblies/<hash>`, so what it imports is what
   * the process keeps. A throw is an import error, which refuses the publish as a refusal line does.
   */
  load: (root: string) => Promise<LoadedAssembly>;
  /** The package names the Kit image provides (ADR-0069). Default: {@link kitClosure}. */
  kitPackages?: () => Promise<Set<string>>;
};

/** The door over one Assembly store. */
export type AssemblyDoor = {
  /** `GET /assembly`. */
  view: () => AssemblyView;
  /** The current Assembly, for `/healthz` and the announce line. */
  current: () => CurrentAssembly | null;
  /** `PUT /assembly`, after authentication: checks 2 and 3, `unpack`, then `admit`. */
  publish: (req: PublishRequest) => Promise<PublishAnswer>;
  /**
   * Checks 4 to 6 over a staging directory that holds the unpacked `tree/`: the hash, the import
   * and the walk, then the landing. `publish` calls it after the unpack. A test calls it directly on
   * a copied tree, so it writes the real layout and the real pointer. The staging directory is
   * removed when it returns.
   */
  admit: (staging: string, header: { hash: string; kitVersion: string }) => Promise<PublishAnswer>;
};

/**
 * The publish door (ADR-0069). Checks run in order, each with its own status, and the old
 * Assembly stays current through every refusal:
 *
 *   1. authentication is the route's (401, 403);
 *   2. the Kit version header is not this Orchestrator's → 409, before the body is read;
 *   3. the hash is the current one → 200 `unchanged`, before the body is read;
 *   4. the body is unpacked to staging and its hash recomputed; a refused entry or another hash →
 *      400;
 *   5. a Kit package in the tree, then the config and every Workflow imported and walked; an import
 *      error or a refusal → 422 with the report;
 *   6. the tree is under its hash, the record is written, `current` flips, the process swaps;
 *   7. → 200.
 *
 * One publish at a time: a second one while the first is in flight → 409.
 */
export function assemblyDoor(opts: AssemblyDoorOptions): AssemblyDoor {
  const root = assembliesDir(opts.dir);
  const kitPackages = opts.kitPackages ?? kitClosure;
  let inFlight = false;

  // Step 1 holds the current Assembly only (ADR-0069's hold of other Assemblies is step 2). The
  // current one is held by construction: the next run starts under it. The runs listed are the
  // live runs that hold it; a run that holds an earlier Assembly restores into the current one at
  // the next boot, so step 1 claims no hold for it.
  const held = (): HeldAssembly[] => {
    const current = opts.current();
    if (!current) return [];
    return [{ hash: current.hash, kitVersion: current.kitVersion, runs: opts.holds().get(current.hash) ?? [] }];
  };

  const view = (): AssemblyView => {
    const current = opts.current();
    return {
      kitVersion: KIT_VERSION,
      current: current ? { hash: current.hash, kitVersion: current.kitVersion, workflows: opts.workflows() } : null,
      held: held(),
    };
  };

  const answer = (a: CurrentAssembly) => ({ hash: a.hash, kitVersion: a.kitVersion, workflows: opts.workflows() });

  const kitVersionRefusal = (kitVersion: string | undefined): PublishAnswer | undefined => {
    // The exact Kit version (ADR-0056, moved to the door by ADR-0069). Not semver: the kit is 0.x
    // and its minors break.
    if (kitVersion === KIT_VERSION) return undefined;
    return {
      status: 409,
      body: {
        error:
          `the Assembly names Kit version ${kitVersion ?? "(none)"}; this Orchestrator is ${KIT_VERSION} — ` +
          "an Assembly must name the exact Kit version of the Orchestrator it is published to (ADR-0069)",
        kitVersion: { assembly: kitVersion ?? null, orchestrator: KIT_VERSION },
      },
    };
  };

  const hashRefusal = (hash: string | undefined): PublishAnswer | undefined =>
    isAssemblyHash(hash)
      ? undefined
      : {
          status: 400,
          body: { error: `the jr2-assembly-hash header ${JSON.stringify(hash ?? null)} is not an Assembly hash` },
        };

  /** Checks 4 (the hash) to 7, under the lock. */
  const admitLocked = async (staging: string, hash: string): Promise<PublishAnswer> => {
    const tree = join(staging, "tree");
    const got = await assemblyHash(tree);
    if (got !== hash) {
      return {
        status: 400,
        body: { error: `the Assembly hashes to ${got}, not to the ${hash} its header names — nothing was published` },
      };
    }

    // 5a. A Kit package carried in the Assembly (ADR-0054, ADR-0069). The host strips the Kit
    // closure, so this is a staging bug or a hand-built archive. Refused before the import: a second
    // `xstate` or `@jr2/orchestrator` would load beside the Kit image's, and its Machines would walk
    // to empty Menus with no error.
    const carried = [...(await kitPackages())].filter((name) => existsSync(join(tree, "node_modules", name))).sort();
    if (carried.length) {
      return {
        status: 422,
        body: {
          error: "refused",
          report: carried.map(
            (name) =>
              `the Assembly carries node_modules/${name}, which the Kit image provides — an Assembly ships no ` +
              "Kit package, so its Machines resolve the Kit image's own copy (ADR-0054, ADR-0069)",
          ),
        },
      };
    }

    // 6a. The tree goes under its hash BEFORE the import, so the modules the process keeps are the
    // ones at the path it serves, never a second copy at a staging path. It is not current until the
    // pointer flips. A tree an earlier publish left under this hash is reused only when it still
    // hashes to it: a crash can leave a tree whose files never reached the disk.
    const final = join(root, hash);
    let created = false;
    if (existsSync(final) && (await assemblyHash(final).catch(() => undefined)) !== hash) {
      await rm(final, { recursive: true, force: true });
    }
    if (!existsSync(final)) {
      await syncTree(tree);
      await rename(tree, final);
      await fsyncDir(root);
      created = true;
    }

    // 5b. Import and walk. The server has no `tsc`: a type error that survives the host's
    // typecheck shows here as an import error, named in the report.
    let loaded: LoadedAssembly;
    try {
      loaded = await opts.load(final);
    } catch (err) {
      if (created) await rm(final, { recursive: true, force: true });
      return { status: 422, body: { error: "refused", report: [message(err)] } };
    }
    if (loaded.refusals.length) {
      if (created) await rm(final, { recursive: true, force: true });
      return { status: 422, body: { error: "refused", report: loaded.refusals } };
    }

    // 6b. The record, then the pointer: a crash between them leaves the old pointer.
    const record: AssemblyRecord = {
      hash,
      kitVersion: KIT_VERSION,
      workflows: loaded.workflows,
      publishedAt: new Date().toISOString(),
    };
    await writeDurably(join(root, `${hash}.json`), `${JSON.stringify(record)}\n`);
    await writeDurably(join(root, "current"), `${hash}\n`);
    const next: CurrentAssembly = { root: final, hash, kitVersion: KIT_VERSION };
    try {
      await loaded.activate(next);
    } catch (err) {
      // The pointer has flipped, so the next boot loads the new Assembly. Say so, rather than
      // claim the old one is still current.
      return {
        status: 500,
        body: { error: `the Assembly ${hash} is current on the volume, but the reload failed: ${message(err)}` },
      };
    }
    // 7.
    return { status: 200, body: { ...answer(next), held: held() } };
  };

  const admit: AssemblyDoor["admit"] = async (staging, header) => {
    try {
      const refused = kitVersionRefusal(header.kitVersion) ?? hashRefusal(header.hash);
      if (refused) return refused;
      if (inFlight) return { status: 409, body: { error: "a publish is in flight" } };
      inFlight = true;
      try {
        return await admitLocked(staging, header.hash);
      } finally {
        inFlight = false;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  };

  const publish = async (req: PublishRequest): Promise<PublishAnswer> => {
    // 2.
    const refused = kitVersionRefusal(req.kitVersion) ?? hashRefusal(req.hash);
    if (refused) return refused;
    const hash = req.hash!;
    // 3. A repeat publish of the current Assembly is a no-op, and costs no upload read.
    const current = opts.current();
    if (current?.hash === hash && existsSync(join(root, hash))) {
      return { status: 200, body: { ...answer(current), held: held(), unchanged: true } };
    }
    if (inFlight) return { status: 409, body: { error: "a publish is in flight" } };
    inFlight = true;
    const staging = join(root, `.staging-${hash}-${randomBytes(4).toString("hex")}`);
    try {
      // 4. Stream to staging and unpack beside the archive.
      const unpacked = await unpack(req.body, staging);
      if (unpacked) return unpacked;
      return await admitLocked(staging, hash);
    } finally {
      await rm(staging, { recursive: true, force: true });
      inFlight = false;
    }
  };

  return { view, current: opts.current, publish, admit };
}

/**
 * The body to `<staging>/assembly.tar`, unpacked beside it into `<staging>/tree`. A refused
 * archive answers 400, naming the entry when there is one. Any other failure (a full volume, a
 * permission) is the server's, not the publisher's: it is thrown, and the route answers 500.
 */
async function unpack(body: PublishRequest["body"], staging: string): Promise<PublishAnswer | undefined> {
  await mkdir(staging, { recursive: true });
  const archive = join(staging, "assembly.tar");
  await pipeline(bodyStream(body), createWriteStream(archive));
  try {
    await unpackAssembly(createReadStream(archive), join(staging, "tree"));
  } catch (err) {
    if (!(err instanceof AssemblyTarRefusal)) throw err;
    return { status: 400, body: { error: err.message, ...(err.entry !== "" ? { entry: err.entry } : {}) } };
  }
  return undefined;
}

/** A request body as a Node stream. An absent body is an empty archive, which the unpack refuses. */
function bodyStream(body: PublishRequest["body"]): Readable {
  if (body === null) return Readable.from([]);
  if (typeof (body as ReadableStream).getReader === "function") {
    return Readable.fromWeb(body as WebReadableStream<Uint8Array>);
  }
  return Readable.from(body as AsyncIterable<Uint8Array>);
}

/**
 * The packages the Kit image provides (ADR-0069): `@jr2/orchestrator` and every package its
 * `dependencies` reach, as installed beside this module. Resolved the way Node resolves a bare
 * name: the nearest `node_modules/<name>` up from the dependent's own directory. A package that is
 * not installed (an optional dependency) is named and not followed. Computed once per process.
 */
export function kitClosure(): Promise<Set<string>> {
  closure ??= computeKitClosure();
  return closure;
}
let closure: Promise<Set<string>> | undefined;

async function computeKitClosure(): Promise<Set<string>> {
  const names = new Set<string>(["@jr2/orchestrator"]);
  const visit = async (pkgDir: string): Promise<void> => {
    let manifest: { dependencies?: Record<string, string> };
    try {
      manifest = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as typeof manifest;
    } catch {
      return;
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (names.has(name)) continue;
      names.add(name);
      const found = await installedPackage(pkgDir, name);
      if (found) await visit(found);
    }
  };
  await visit(join(dirname(fileURLToPath(import.meta.url)), ".."));
  return names;
}

/** The real directory of `name` as Node resolves it from `from`, or undefined when absent. */
async function installedPackage(from: string, name: string): Promise<string | undefined> {
  for (let d = from; ; d = dirname(d)) {
    const candidate = join(d, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpath(candidate);
    if (dirname(d) === d) return undefined;
  }
}

/** fsync every file and directory under `dir`, so a tree the pointer names after a power loss
 * holds its bytes and not empty files. Symlinks are skipped: their target is in the inode. */
async function syncTree(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await syncTree(p);
    else if (e.isFile()) await fsyncPath(p);
  }
  await fsyncPath(dir);
}

/** Write a file so that a crash leaves the old content or the new, never a part: a temp file,
 * fsynced, renamed over the target, and the directory fsynced. */
async function writeDurably(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, text);
  await fsyncPath(tmp);
  await rename(tmp, path);
  await fsyncDir(join(path, ".."));
}

/** Make a rename in `dir` durable. */
function fsyncDir(dir: string): Promise<void> {
  return fsyncPath(dir);
}

async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
