// The Assembly, staged on the host (ADR-0069). No package manager runs here: the bundle port writes a
// prepared tree in the hoisted shape that every bundle path leaves (`npm ci`, `bun`, and pnpm with
// `node-linker=hoisted`), and the strip, the `.bin` removal, the seal checks and the hash that
// follow are the real ones.

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { KIT_VERSION } from "@jr2/orchestrator";
import { checkSealed, closureOf, stageAssembly, stagedCopyOf } from "../src/assembly.ts";
import type { BuildPort } from "../src/build.ts";

type Entry = string | { link: string };
type Tree = Record<string, Entry>;

async function write(root: string, tree: Tree): Promise<void> {
  for (const [rel, entry] of Object.entries(tree)) {
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    if (typeof entry === "string") await writeFile(p, entry);
    else await symlink(entry.link, p);
  }
}

const pkg = (name: string, version: string, dependencies: Record<string, string> = {}, extra: object = {}) =>
  JSON.stringify({ name, version, dependencies, ...extra });

/** A port that writes `tree(out)` where the bundle goes. Its docker methods throw: staging an
 * Assembly spends no docker. */
function fixturePort(tree: (out: string) => Tree): BuildPort {
  const docker = () => {
    throw new Error("staging an Assembly must not call docker");
  };
  return {
    bundle: async (_instanceDir, out) => {
      await mkdir(out, { recursive: true });
      await write(out, tree(out));
    },
    build: docker,
    imageUser: docker,
    imageFiles: docker,
    buildablePlatforms: docker,
    push: docker,
    kindLoad: docker,
    hostImages: docker,
    removeHostImage: docker,
    nodeImages: docker,
    removeNodeImage: docker,
  };
}

/** What `npm ci --omit=dev` leaves for an Instance that depends on the Kit, `@jr2/machines`, and
 * one dependency of its own: hoisted, real directories. `hono` depends on `hono-dep`, so the
 * closure is transitive; `@jr2/machines` peers the orchestrator and is not in the closure. */
function hoisted(version = KIT_VERSION): Tree {
  return {
    "package.json": pkg("my-instance", "1.0.0", { "@jr2/orchestrator": version, "@jr2/machines": version }),
    "jr2.config.ts": "export default {};\n",
    "workflows/ping.ts": "export const machine = 1;\n",
    "workflows/pong.ts": "export const machine = 2;\n",
    "workflows/_shared.ts": "export const x = 1;\n",
    "node_modules/@jr2/orchestrator/package.json": pkg(
      "@jr2/orchestrator",
      version,
      { "@jr2/agent-protocol": version, xstate: "^5", zod: "^4", hono: "^4" },
      { devDependencies: { "dev-only": "1" }, peerDependencies: { "peer-only": "1" } },
    ),
    "node_modules/@jr2/orchestrator/src/index.ts": "export {};\n",
    "node_modules/@jr2/agent-protocol/package.json": pkg("@jr2/agent-protocol", version),
    "node_modules/xstate/package.json": pkg("xstate", "5.32.2"),
    "node_modules/zod/package.json": pkg("zod", "4.4.3"),
    "node_modules/hono/package.json": pkg("hono", "4.12.27", { "hono-dep": "^1" }),
    "node_modules/hono-dep/package.json": pkg("hono-dep", "1.0.0"),
    "node_modules/@jr2/machines/package.json": pkg(
      "@jr2/machines",
      version,
      {},
      { peerDependencies: { "@jr2/orchestrator": version, xstate: "^5", zod: "^4" } },
    ),
    "node_modules/left-pad/package.json": pkg("left-pad", "1.0.0", { "pad-helper": "^2" }),
    "node_modules/left-pad/node_modules/pad-helper/package.json": pkg("pad-helper", "2.0.0"),
    "node_modules/.bin/tsc": "#!/bin/sh\n",
    "node_modules/left-pad/node_modules/.bin/pad": "#!/bin/sh\n",
    "node_modules/.package-lock.json": "{}\n",
  };
}

async function scratchInstance(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jr2-assembly-test-"));
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

test("closureOf: the orchestrator's dependencies, transitively, by Node's resolution — not dev, not peer", async () => {
  const dir = await scratchInstance();
  try {
    await write(dir, hoisted());
    assert.deepEqual(
      [...(await closureOf(dir))].sort(),
      ["@jr2/agent-protocol", "@jr2/orchestrator", "hono", "hono-dep", "xstate", "zod"].sort(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("closureOf: a dependency resolves from the dependent's own node_modules first", async () => {
  const dir = await scratchInstance();
  try {
    await write(dir, {
      ...hoisted(),
      // hono's own private copy of hono-dep depends on deep-dep; the top-level hono-dep does not.
      "node_modules/hono/node_modules/hono-dep/package.json": pkg("hono-dep", "0.9.0", { "deep-dep": "1" }),
      "node_modules/deep-dep/package.json": pkg("deep-dep", "1.0.0"),
    });
    assert.ok((await closureOf(dir)).has("deep-dep"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stageAssembly: the Kit closure goes; @jr2/machines and the Instance's own dependencies stay", async () => {
  const staged = await stageAssembly(
    fixturePort(() => hoisted()),
    await scratchInstance(),
  );
  try {
    const nm = join(staged.dir, "node_modules");
    for (const gone of ["@jr2/orchestrator", "@jr2/agent-protocol", "xstate", "zod", "hono", "hono-dep"]) {
      assert.equal(await exists(join(nm, gone)), false, `${gone} is stripped`);
    }
    for (const kept of ["@jr2/machines", "left-pad", "left-pad/node_modules/pad-helper"]) {
      assert.ok(await exists(join(nm, kept, "package.json")), `${kept} is kept`);
    }
    assert.equal(staged.kitVersion, KIT_VERSION);
    assert.deepEqual(staged.workflows, ["ping", "pong"]);
    assert.ok(await exists(join(staged.dir, "jr2.config.ts")));
  } finally {
    await staged.dispose();
  }
  assert.equal(await exists(staged.dir), false, "dispose removes the scratch directory");
});

test("stageAssembly: every node_modules/.bin goes, at every depth", async () => {
  const staged = await stageAssembly(
    fixturePort(() => hoisted()),
    await scratchInstance(),
  );
  try {
    assert.equal(await exists(join(staged.dir, "node_modules", ".bin")), false);
    assert.equal(await exists(join(staged.dir, "node_modules", "left-pad", "node_modules", ".bin")), false);
  } finally {
    await staged.dispose();
  }
});

test("stageAssembly: pnpm's staging records go", async () => {
  const staged = await stageAssembly(
    fixturePort(() => ({
      ...hoisted(),
      "node_modules/.modules.yaml": `prunedAt: ${Date.now()}\n`,
      "node_modules/.pnpm-workspace-state.json": `{"lastValidatedTimestamp":${Date.now()}}\n`,
    })),
    await scratchInstance(),
  );
  try {
    assert.equal(await exists(join(staged.dir, "node_modules", ".modules.yaml")), false);
    assert.equal(await exists(join(staged.dir, "node_modules", ".pnpm-workspace-state.json")), false);
  } finally {
    await staged.dispose();
  }
});

test("stageAssembly: a nested copy of a Kit package is refused, naming its path and its nester", async () => {
  await assert.rejects(
    stageAssembly(
      fixturePort(() => ({
        ...hoisted(),
        "node_modules/left-pad/node_modules/zod/package.json": pkg("zod", "3.22.0"),
      })),
      await scratchInstance(),
    ),
    (err: Error) => {
      assert.match(err.message, /node_modules\/left-pad\/node_modules\/zod is a second copy of zod/);
      assert.match(err.message, /nested by left-pad@1\.0\.0/);
      assert.match(err.message, /ADR-0054/);
      return true;
    },
  );
});

test("stageAssembly: a top-level copy that is not the one the orchestrator resolves is refused", async () => {
  await assert.rejects(
    stageAssembly(
      fixturePort(() => ({
        ...hoisted(),
        // The Instance's own zod@3 is hoisted; the orchestrator's zod@4 is nested under it.
        "node_modules/zod/package.json": pkg("zod", "3.22.0"),
        "node_modules/@jr2/orchestrator/node_modules/zod/package.json": pkg("zod", "4.4.3"),
      })),
      await scratchInstance(),
    ),
    /node_modules\/zod is a second copy of zod, nested by the Instance itself/,
  );
});

test("stageAssembly: a Kit package linked out of the tree resolves its closure inside the tree", async () => {
  // A workspace member: `pnpm deploy` links @jr2/orchestrator back into the checkout. The checkout's
  // node_modules are host geography, not the Assembly and not the image, so the closure resolves
  // from where the link sits. The Instance's own top-level xstate is then the resolved copy, and it
  // goes; nothing the checkout holds alone reaches the closure.
  const outside = await scratchInstance();
  try {
    await write(outside, {
      "orchestrator/package.json": pkg("@jr2/orchestrator", KIT_VERSION, { xstate: "^5", "secret-dep": "1" }),
      "orchestrator/node_modules/xstate/package.json": pkg("xstate", "5.32.2"),
      "orchestrator/node_modules/secret-dep/package.json": pkg("secret-dep", "1.0.0", { "deeper-outside": "1" }),
      "orchestrator/node_modules/deeper-outside/package.json": pkg("deeper-outside", "1.0.0"),
    });
    const tree = {
      "package.json": pkg("my-instance", "1.0.0", { "@jr2/orchestrator": KIT_VERSION, xstate: "^5" }),
      "workflows/ping.ts": "export const machine = 1;\n",
      "node_modules/@jr2/orchestrator": { link: join(outside, "orchestrator") },
      "node_modules/xstate/package.json": pkg("xstate", "5.32.2"),
      "node_modules/@jr2/machines/package.json": pkg("@jr2/machines", KIT_VERSION),
    };
    const dir = await scratchInstance();
    try {
      await write(dir, tree);
      assert.deepEqual([...(await closureOf(dir))].sort(), ["@jr2/orchestrator", "secret-dep", "xstate"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const staged = await stageAssembly(
      fixturePort(() => tree),
      await scratchInstance(),
    );
    try {
      const nm = join(staged.dir, "node_modules");
      assert.deepEqual((await readdir(nm)).sort(), ["@jr2"]);
      assert.deepEqual(await readdir(join(nm, "@jr2")), ["machines"]);
    } finally {
      await staged.dispose();
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("closureOf: optionalDependencies are in the closure, as a production install puts them on disk", async () => {
  const dir = await scratchInstance();
  try {
    await write(dir, {
      ...hoisted(),
      "node_modules/@jr2/orchestrator/package.json": pkg(
        "@jr2/orchestrator",
        KIT_VERSION,
        { xstate: "^5" },
        { optionalDependencies: { "opt-dep": "1" } },
      ),
      "node_modules/opt-dep/package.json": pkg("opt-dep", "1.0.0"),
    });
    assert.ok((await closureOf(dir)).has("opt-dep"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stageAssembly: a closure manifest that does not parse is refused, naming the file", async () => {
  await assert.rejects(
    stageAssembly(
      fixturePort(() => ({ ...hoisted(), "node_modules/hono/package.json": "{ not json" })),
      await scratchInstance(),
    ),
    /node_modules\/hono\/package\.json does not parse/,
  );
});

test("stageAssembly: an orchestrator manifest that does not parse is refused, naming it and the reinstall", async () => {
  await assert.rejects(
    stageAssembly(
      fixturePort(() => ({ ...hoisted(), "node_modules/@jr2/orchestrator/package.json": "{ not json" })),
      await scratchInstance(),
    ),
    /node_modules\/@jr2\/orchestrator\/package\.json: .*reinstall @jr2\/orchestrator@/s,
  );
});

test("stageAssembly: a node_modules/.bin that is a link goes too", async () => {
  const staged = await stageAssembly(
    fixturePort(() => {
      const tree: Tree = { ...hoisted(), "tools/x": "#!/bin/sh\n", "node_modules/.bin": { link: "../tools" } };
      delete tree["node_modules/.bin/tsc"];
      return tree;
    }),
    await scratchInstance(),
  );
  try {
    assert.equal(await exists(join(staged.dir, "node_modules", ".bin")), false);
  } finally {
    await staged.dispose();
  }
});

test("stageAssembly: the hash is stable across two stagings and moves with content", async () => {
  const instance = await scratchInstance();
  const a = await stageAssembly(
    fixturePort(() => hoisted()),
    instance,
  );
  const b = await stageAssembly(
    fixturePort(() => hoisted()),
    instance,
  );
  const c = await stageAssembly(
    fixturePort(() => ({ ...hoisted(), "workflows/ping.ts": "export const machine = 3;\n" })),
    instance,
  );
  try {
    assert.notEqual(a.dir, b.dir, "two stagings, two scratch directories");
    assert.equal(a.hash, b.hash);
    assert.notEqual(a.hash, c.hash);
    assert.match(a.hash, /^[0-9a-f]{12}$/);
  } finally {
    await Promise.all([a.dispose(), b.dispose(), c.dispose()]);
  }
});

test("stageAssembly: a `file:` image context rides the Assembly, and an edit to it moves the hash", async () => {
  // The Assembly holds the `file:` contexts its Machines name (ADR-0069): the door checks their
  // digests against the image map, so staging must keep them and hash them.
  const instance = await scratchInstance();
  const withImage = (dockerfile: string) => ({ ...hoisted(), "images/default/Dockerfile": dockerfile });
  const a = await stageAssembly(
    fixturePort(() => withImage("FROM node:24-slim\n")),
    instance,
  );
  const b = await stageAssembly(
    fixturePort(() => withImage("FROM node:24\n")),
    instance,
  );
  try {
    assert.ok((await lstat(join(a.dir, "images", "default", "Dockerfile"))).isFile(), "the context is staged");
    assert.notEqual(a.hash, b.hash, "a Dockerfile edit is Assembly content");
  } finally {
    await Promise.all([a.dispose(), b.dispose()]);
  }
});

test("stageAssembly: the Kit version is read, and another version is refused naming both", async () => {
  await assert.rejects(
    stageAssembly(
      fixturePort(() => hoisted("0.0.1-other")),
      await scratchInstance(),
    ),
    (err: Error) => {
      assert.match(err.message, /Kit version mismatch/);
      assert.match(err.message, /0\.0\.1-other/);
      assert.ok(err.message.includes(KIT_VERSION));
      return true;
    },
  );
});

test("stageAssembly: no @jr2/orchestrator is refused naming the install", async () => {
  const tree = hoisted();
  for (const k of Object.keys(tree)) if (k.startsWith("node_modules/@jr2/orchestrator/")) delete tree[k];
  const instance = await scratchInstance();
  await writeFile(join(instance, "package-lock.json"), "{}\n");
  await assert.rejects(
    stageAssembly(
      fixturePort(() => tree),
      instance,
    ),
    /no @jr2\/orchestrator .*`npm i @jr2\/orchestrator@/s,
  );
});

test("stageAssembly: the install fix names the Instance's own package manager", async () => {
  const tree = hoisted();
  for (const k of Object.keys(tree)) if (k.startsWith("node_modules/@jr2/orchestrator/")) delete tree[k];
  const instance = await scratchInstance();
  await writeFile(join(instance, "pnpm-lock.yaml"), "lock\n");
  await assert.rejects(
    stageAssembly(
      fixturePort(() => tree),
      instance,
    ),
    /`pnpm add @jr2\/orchestrator@/,
  );
});

test("stageAssembly: a file that holds the staging path is refused, naming the file", async () => {
  await assert.rejects(
    stageAssembly(
      fixturePort((out) => ({ ...hoisted(), "node_modules/left-pad/baked.js": `module.exports = "${out}";\n` })),
      await scratchInstance(),
    ),
    /cannot seal the Assembly: node_modules\/left-pad\/baked\.js holds the staging path/,
  );
});

test("stageAssembly: a symlink that names the staging path is refused, naming the link", async () => {
  await assert.rejects(
    stageAssembly(
      fixturePort((out) => ({ ...hoisted(), "node_modules/which": { link: join(out, "node_modules", "left-pad") } })),
      await scratchInstance(),
    ),
    /cannot seal the Assembly: the symlink node_modules\/which points at the staging path/,
  );
});

test("checkSealed: a link that leaves the tree is refused; a relative link inside it passes", async () => {
  const dir = await scratchInstance();
  try {
    await write(dir, { "a/file": "x", "a/inside": { link: "file" } });
    await checkSealed(dir);
    await write(dir, { "a/outside": { link: "../../elsewhere" } });
    await assert.rejects(
      checkSealed(dir),
      /the symlink a\/outside points outside the Assembly .*make the link relative, with a target inside the Instance/,
    );
    await rm(join(dir, "a", "outside"));
    await write(dir, { "node_modules/dep": { link: "/somewhere/dep" } });
    await assert.rejects(
      checkSealed(dir),
      /the symlink node_modules\/dep points outside the Assembly .*install that dependency as a copy/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkSealed: rewrites nothing", async () => {
  const dir = await scratchInstance();
  try {
    await write(dir, { "keep.txt": "/instance/node_modules\n" });
    await checkSealed(dir);
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(join(dir, "keep.txt"), "utf8"), "/instance/node_modules\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stagedCopyOf: a context under the root keeps its path; one a linked package ships maps under node_modules/<name>", async () => {
  // A workspace package is a link to its checkout, so a module's `file:` URL names a directory
  // outside the Instance root; the Assembly holds that package hoisted at node_modules/<name>.
  const scratch = await mkdtemp(join(tmpdir(), "jr2-staged-copy-"));
  const root = join(scratch, "instance");
  const checkout = join(scratch, "checkout", "tools");
  const staged = join(scratch, "staged");
  try {
    await write(root, { "images/box/Dockerfile": "FROM x\n", "package.json": pkg("inst", "1.0.0") });
    await write(checkout, { "package.json": pkg("@acme/tools", "2.0.0"), "images/go/Dockerfile": "FROM go\n" });
    await mkdir(join(root, "node_modules", "@acme"), { recursive: true });
    await symlink(checkout, join(root, "node_modules", "@acme", "tools"));
    await write(staged, {
      "images/box/Dockerfile": "FROM x\n",
      "node_modules/@acme/tools/package.json": pkg("@acme/tools", "2.0.0"),
      "node_modules/@acme/tools/images/go/Dockerfile": "FROM go\n",
    });
    assert.equal(await stagedCopyOf(staged, root, join(root, "images", "box")), join(staged, "images", "box"));
    // Named through the link, or by its real location: both land on the hoisted copy.
    const viaLink = join(root, "node_modules", "@acme", "tools", "images", "go");
    const expected = join(staged, "node_modules", "@acme", "tools", "images", "go");
    assert.equal(await stagedCopyOf(staged, root, viaLink), expected);
    assert.equal(await stagedCopyOf(staged, root, join(checkout, "images", "go")), expected);
    // Not carried: a folder the install left out, and a directory no package names.
    assert.equal(await stagedCopyOf(staged, root, join(root, "images", "absent")), undefined);
    assert.equal(await stagedCopyOf(staged, root, join(scratch, "elsewhere")), undefined);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
