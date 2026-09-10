// The image build seam (ADR-0019/0038). Every tag `j2 up` deploys is a content address, so these
// tests pin the properties that make one usable as a cache key at all: the same sources hash the
// same every time, different sources do not, and the inputs each hash covers are the ones the ADRs
// name — including the one that is now deliberately ABSENT, a Sandbox Image's dependence on the
// resolved harness ref (ADR-0037: the runtime arrives on a pod volume, so it addresses nothing).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KIT_VERSION } from "@j2/orchestrator";
import {
  assertEmulation,
  buildSandboxImage,
  bundleInstance,
  choosePlatforms,
  contentHash,
  crictlLabels,
  detectKitCheckout,
  formatBytes,
  hostSweepPlan,
  kitImageBuild,
  kitImageLabels,
  kitImageRefs,
  lockfileInstall,
  manifestListUser,
  mergeSweeps,
  nodeSweepPlan,
  platformSuffix,
  publishedKitRefs,
  sandboxImageTag,
  stageInstanceBundle,
  sweepHost,
  sweepNodes,
  KIT_IMAGE_HOME,
  SUPPORTED_PLATFORMS,
  type BuildPort,
  type BuildRequest,
  type ObservedImage,
  type RunCommand,
} from "../src/build.ts";
import { imageContextDigest } from "@j2/orchestrator";

/** Every verb, inert. Each test overrides the two or three it is about; the rest answering with
 * nothing is what keeps a build test from depending on the sweep and vice versa. */
function nullPort(): BuildPort {
  return {
    bundle: async () => {},
    build: async () => {},
    imageUser: async () => "",
    push: async () => {},
    kindLoad: async () => {},
    hostImages: async () => [],
    removeHostImage: async () => {},
    nodeImages: async () => [],
    removeNodeImage: async () => {},
    buildablePlatforms: async () => [...SUPPORTED_PLATFORMS],
  };
}

/** The everyday platform set (ADR-0045): a cluster whose schedulable nodes are all one arch, which
 * is what every test here builds for unless it is about the multi-arch branch itself. */
const AMD64: readonly string[] = ["linux/amd64"];

/** A port that materializes `files(out)` — what `pnpm deploy` would have written into the bundle.
 * `out` is the real scratch dir `stageInstanceBundle` chose, so a fake can bake it into the bundle
 * exactly as pnpm does, and the seal that follows is the real one. */
function stagingPort(files: (out: string) => Record<string, string | Uint8Array>): BuildPort {
  return {
    ...nullPort(),
    bundle: async (_dir, out) => {
      // `pnpm deploy` creates its target; a fake that resolves `out` must be able to see it too.
      await mkdir(out, { recursive: true });
      for (const [rel, content] of Object.entries(files(out))) {
        await mkdir(join(out, dirname(rel)), { recursive: true });
        await writeFile(join(out, rel), content);
      }
    },
  };
}

/** One image as a store reports it. Defaults are the interesting case: j2 built it, and it holds
 * bytes worth reclaiming. */
function image(over: Partial<ObservedImage> & { id: string }): ObservedImage {
  return { tags: [], bytes: 0, labeled: true, ...over };
}

async function hashOf(port: BuildPort): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "j2-build-"));
  const staged = await stageInstanceBundle(port, root);
  try {
    return staged.hash;
  } finally {
    await staged.dispose();
  }
}

/** Write `files` (relative path → content) under a fresh temp dir and return it. */
async function mkTree(files: Record<string, string>, prefix = "j2-tree-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  return root;
}

/** A kit checkout as `detectKitCheckout`/`kitImageRefs` see one: both markers plus the sources
 * each kit image is hashed over. `harnessSrc` varies so a kit edit can be simulated. */
function kitFiles(harnessSrc: string): Record<string, string> {
  return {
    "deploy/harness/Dockerfile": "FROM node:24-slim\n",
    "deploy/adapter/Dockerfile": "FROM node:24-alpine\n",
    "operator/Dockerfile": "FROM golang:1.23\n",
    "operator/main.go": "package main\n",
    "packages/harness/package.json": `{"name":"@j2/harness"}`,
    "packages/harness/src/main.ts": harnessSrc,
    "packages/adapter/package.json": `{"name":"@j2/adapter"}`,
    "packages/adapter/src/main.ts": "export const a = 1;\n",
  };
}

/** What `pnpm deploy --legacy` writes that names where and when it staged. MEASURED, not imagined —
 * a shim's `NODE_PATH` is a CHAIN, and it holds the staging path in two spellings plus the
 * `node_modules` of every directory above it:
 *
 *   <realpath(out)>/node_modules/.pnpm/<pkg>/node_modules   ← the resolved form, always present
 *   <out>/node_modules/.pnpm/node_modules                   ← the form `mkdtemp` returned
 *   <dirname(realpath(out))>/node_modules                   ← one ancestor rung, and so on to `/`
 *
 * The two spellings coincide only where the temp root is a real directory. They diverge on macOS,
 * where `os.tmpdir()` is `/var/folders/…` and `/var` is a symlink to `/private/var` — so a seal
 * that knows only the returned form leaves the random `mkdtemp` component behind in the resolved
 * one. The ancestor rungs carry it too: on macOS the per-boot `/var/folders/<xy>/<random>` sits
 * ABOVE the bundle. `.modules.yaml` and `.pnpm-workspace-state.json` are nothing but records of
 * where and when — the second one written by `pnpm install` (the standalone branch, ADR-0043)
 * rather than by `pnpm deploy`, and carrying a millisecond stamp, so two identical installs from
 * one lockfile differ by it alone. */
function pnpmStagingPort(stamp: string): BuildPort {
  return stagingPort((out) => {
    const real = realpathSync(out);
    const chain = (pkg: string): string =>
      `${real}/node_modules/.pnpm/${pkg}/node_modules:${out}/node_modules/.pnpm/node_modules:${dirname(real)}/node_modules:/node_modules`;
    return {
      "package.json": `{"name":"inst"}`,
      "node_modules/.modules.yaml": `prunedAt: Mon, 20 Jul 2026 00:04:${stamp} GMT\nvirtualStoreDir: ${out}/node_modules/.pnpm\n`,
      "node_modules/.pnpm-workspace-state.json": `{"lastValidatedTimestamp":17881413000${stamp}}`,
      "node_modules/.bin/tsx": `export NODE_PATH="${chain("tsx@4")}"\nexec node "$basedir/../tsx/dist/cli.mjs" "$@"\n`,
      "node_modules/.bin/which": `export NODE_PATH="${chain("which@4")}"\n`,
      "node_modules/.pnpm/tsx@4/node_modules/tsx/dist/cli.mjs": "export const cli = 1;\n",
    };
  });
}

/** Run `body` with `os.tmpdir()` pointed at a SYMLINK to a real directory — the macOS shape, which
 * is where the returned and resolved spellings of a staging path diverge. Restores `TMPDIR`. */
async function withSymlinkedTmpdir(body: (root: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "j2-symtmp-"));
  const real = join(base, "real");
  const link = join(base, "link");
  await mkdir(real);
  await symlink(real, link);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = link;
  try {
    await body(base);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    await rm(base, { recursive: true, force: true });
  }
}

/** Stage one Instance twice. Each call gets its own scratch dir, so the pair IS the experiment;
 * both bundles stay on disk until the caller disposes them, because the claim is about bytes. */
async function stageTwice(port: BuildPort, other = port) {
  const root = await mkdtemp(join(tmpdir(), "j2-build-"));
  const a = await stageInstanceBundle(port, root);
  const b = await stageInstanceBundle(other, root);
  return { a, b, dispose: () => Promise.all([a.dispose(), b.dispose()]) };
}

/** Every byte of a bundle, nothing excluded — the property the image tag is supposed to have. */
const bundleBytes = (dir: string) => contentHash([dir], "bundle-bytes", new Set());

test("one Instance staged twice is byte-identical: the bundle records neither where nor when it was staged", async () => {
  // ADR-0038. The tag addresses the materialized bundle, so anything in it that names its own
  // scratch dir — or the minute it was written — makes one tag name many images, and "present
  // implies current" stops being true for the one image every Instance runs. The seal answers both
  // BEFORE the hash: the staging path is rewritten to /instance, the WORKDIR the image holds the
  // bundle at, so the shims go from WRONG to CORRECT rather than merely stable; `.modules.yaml` is
  // deleted. Excluding those entries instead named exactly the files that varied, so the tag stood
  // still while the bytes moved — the mechanism that should have exposed the drift was hiding it.
  const { a, b, dispose } = await stageTwice(pnpmStagingPort("14"), pnpmStagingPort("15"));
  try {
    assert.equal(await bundleBytes(a.dir), await bundleBytes(b.dir), "two stagings, one set of bytes");
    assert.equal(a.hash, b.hash, "…and therefore one address");

    // Correct, not merely stable: this is the path the shim resolves against inside the container.
    // Every rung of the chain lands somewhere real — the bundle's own entries at /instance, the
    // rungs above it at the root, which is where /instance's ancestors are.
    assert.equal(
      await readFile(join(a.dir, "node_modules", ".bin", "tsx"), "utf8"),
      `export NODE_PATH="/instance/node_modules/.pnpm/tsx@4/node_modules:/instance/node_modules/.pnpm/node_modules:` +
        `/node_modules:/node_modules"\nexec node "$basedir/../tsx/dist/cli.mjs" "$@"\n`,
    );
    await assert.rejects(stat(join(a.dir, "node_modules", ".modules.yaml")), "a record of where and when, deleted");
    await assert.rejects(
      stat(join(a.dir, "node_modules", ".pnpm-workspace-state.json")),
      "…and so is the install's own timestamp",
    );
  } finally {
    await dispose();
  }
});

test("the seal holds where the temp root is a symlink — the macOS shape", async () => {
  // `os.tmpdir()` is `/var/folders/…` on macOS and `/var` is a symlink to `/private/var`, so pnpm
  // bakes the RESOLVED spelling of a path `mkdtemp` handed back unresolved. A seal anchored on the
  // returned spelling alone rewrites some entries and leaves the random component in the rest —
  // green on Linux, and on a Mac every converge re-tags and re-loads the whole instance image while
  // the shims keep naming a directory the container does not have. The ancestor rungs are the same
  // failure one level up: on macOS they carry a per-boot random segment of their own.
  await withSymlinkedTmpdir(async (root) => {
    const { a, b, dispose } = await stageTwice(pnpmStagingPort("14"), pnpmStagingPort("15"));
    try {
      assert.equal(await bundleBytes(a.dir), await bundleBytes(b.dir), "two stagings, one set of bytes");
      assert.equal(a.hash, b.hash, "…and therefore one address");
      const shim = await readFile(join(a.dir, "node_modules", ".bin", "tsx"), "utf8");
      assert.ok(!shim.includes(root), `the shim still names the staging root:\n${shim}`);
      assert.ok(!shim.includes(realpathSync(root)), `the shim still names the RESOLVED staging root:\n${shim}`);
    } finally {
      await dispose();
    }
  });
});

test("a non-UTF-8 file holding the staging path is a loud failure, never a blind rewrite", async () => {
  // /instance is SHORTER than the scratch path, so rewriting bytes inside a binary slides every
  // offset after it and ships an executable that segfaults in a Sandbox instead of a build that
  // failed on a laptop. j2 does not know how to seal such a file, and says so, naming it.
  const port = stagingPort((out) => ({
    "package.json": `{"name":"inst"}`,
    "node_modules/.pnpm/esbuild@0/node_modules/esbuild/bin/esbuild": Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xc3, 0x28]),
      Buffer.from(`${out}/node_modules\0`),
    ]),
  }));

  await assert.rejects(
    stageInstanceBundle(port, await mkdtemp(join(tmpdir(), "j2-build-"))),
    /esbuild\/bin\/esbuild.*not valid UTF-8/s,
  );
});

test("a symlink pointing at the staging path is a loud failure — its target is content nothing else sees", async () => {
  // `contentHash` skips symlinks, and so does the seal's rewrite, so a link naming the scratch dir
  // would be neither sealed nor addressed: the bundle varies at a tag that never moves, which is
  // exactly the failure the seal exists to make impossible, arriving with no symptom. pnpm writes
  // relative targets (a real bundle: 276 links, none absolute), so this is a guard, not a path j2
  // knows how to repair.
  const port: BuildPort = {
    ...nullPort(),
    bundle: async (_dir, out) => {
      await mkdir(join(out, "node_modules", ".pnpm"), { recursive: true });
      await writeFile(join(out, "package.json"), `{"name":"inst"}`);
      await symlink(`${out}/node_modules/.pnpm/which@4`, join(out, "node_modules", "which"));
    },
  };

  await assert.rejects(
    stageInstanceBundle(port, await mkdtemp(join(tmpdir(), "j2-build-"))),
    /symlink node_modules\/which points at the staging path/,
  );
});

test("the bundle hash tracks the kit — a dependency's sources are image content", async () => {
  // The staleness defect this closes: the hash walked the instance folder, where the kit appears
  // only as a version range. In the bundle it is materialized source, and it is what runs.
  const kit = (body: string) =>
    stagingPort(() => ({
      "package.json": `{"name":"inst"}`,
      "node_modules/.pnpm/@j2+orchestrator/node_modules/@j2/orchestrator/src/lease.ts": body,
    }));

  const before = await hashOf(kit("export const renew = () => 1;\n"));
  assert.notEqual(await hashOf(kit("export const renew = () => 2;\n")), before);
  assert.equal(await hashOf(kit("export const renew = () => 1;\n")), before);
});

test("installed from npm, the kit three resolve to the published <kitversion> tags at the canonical home", () => {
  // These were `j2.config.ts`'s `images` defaults; the block is gone (ADR-0038), so they live here
  // as the not-a-kit-checkout branch — and as the last leg of ADR-0037's Sandbox Image chain. The
  // home is BAKED (ADR-0044): a bare `j2-harness:0.0.0` resolves to `docker.io/library/`, where
  // nothing is, so the zero-plumbing `npm i -g @j2/cli && j2 init && j2 up` needs a real host here.
  assert.deepEqual(publishedKitRefs(), {
    harness: `${KIT_IMAGE_HOME}/j2-harness:${KIT_VERSION}`,
    adapter: `${KIT_IMAGE_HOME}/j2-adapter:${KIT_VERSION}`,
    operator: `${KIT_IMAGE_HOME}/j2-operator:${KIT_VERSION}`,
  });
  assert.equal(KIT_IMAGE_HOME, "ghcr.io/snapwich");
});

test("kitRegistry re-homes the published refs — the same tags, a self-hosted mirror (ADR-0044)", () => {
  // REPLACES the home rather than nesting under it: a mirror holds the same three tags under its
  // own name, seeded deliberately by `j2 kit push`, never by a converge.
  assert.deepEqual(publishedKitRefs("zot.example.test"), {
    harness: `zot.example.test/j2-harness:${KIT_VERSION}`,
    adapter: `zot.example.test/j2-adapter:${KIT_VERSION}`,
    operator: `zot.example.test/j2-operator:${KIT_VERSION}`,
  });
  // The version is the CLI's own either way: re-homing says where the tags live, not which ones.
  assert.ok(Object.values(publishedKitRefs("localhost:5000/j2")).every((r) => r.endsWith(`:${KIT_VERSION}`)));
});

test("a kit checkout needs BOTH markers — either alone is somebody else's tree", async () => {
  // A false positive means `j2 up` tries to docker-build a kit that is not there; a false negative
  // means it deploys published images over the sources you just edited. Both markers, or neither.
  const full = await mkTree(kitFiles("export const x = 1;\n"));
  assert.equal(await detectKitCheckout(full), full);
  // Found by walking UP, which is how the CLI's own module dir resolves it in a real checkout.
  assert.equal(await detectKitCheckout(join(full, "packages", "harness", "src")), full);

  const dockerfileOnly = await mkTree({ "deploy/harness/Dockerfile": "FROM node:24-slim\n" });
  assert.equal(await detectKitCheckout(dockerfileOnly), undefined);

  const packageOnly = await mkTree({ "packages/harness/package.json": `{"name":"@j2/harness"}` });
  assert.equal(await detectKitCheckout(packageOnly), undefined);

  const wrongName = await mkTree({
    "deploy/harness/Dockerfile": "FROM node:24-slim\n",
    "packages/harness/package.json": `{"name":"@someone/harness"}`,
  });
  assert.equal(await detectKitCheckout(wrongName), undefined);
});

test("each kit image addresses its own sources and platform set; the registry prefixes a built ref", async () => {
  const kit = await mkTree(kitFiles("export const x = 1;\n"));
  const refs = await kitImageRefs(kit, { platforms: AMD64 });
  for (const [name, ref] of Object.entries(refs)) {
    // `<hash>-<arch>` (ADR-0045): the bytes are a function of (inputs × platform), so the address
    // says which — a tag that named only the inputs delivered an amd64 image to an arm64 cluster.
    assert.match(ref, new RegExp(`^j2-${name}:[0-9a-f]{12}-amd64$`), `${name} is content-addressed`);
  }
  assert.deepEqual(await kitImageRefs(kit, { platforms: AMD64 }), refs, "same sources, same addresses");

  const both = await kitImageRefs(kit, { platforms: ["linux/arm64", "linux/amd64"] });
  assert.match(both.harness, /^j2-harness:[0-9a-f]{12}-amd64-arm64$/, "a multi-platform build says so, sorted");
  assert.notEqual(both.harness, refs.harness, "…and never collides with the single-platform address");

  const pushed = await kitImageRefs(kit, { platforms: AMD64, registry: "reg.example.com/j2" });
  assert.equal(pushed.harness, `reg.example.com/j2/${refs.harness}`);

  // The build is the committed Dockerfile against its own context — the harness/adapter build from
  // the kit ROOT (the packages ship as source), the operator from `operator/`.
  assert.deepEqual(kitImageBuild(kit, "harness", refs.harness, AMD64), {
    tag: refs.harness,
    // Explicit on every build (ADR-0045): the daemon default and DOCKER_DEFAULT_PLATFORM steer
    // nothing, which is what deletes the manual step whose forgetting was the failure.
    platforms: AMD64,
    context: kit,
    dockerfile: join(kit, "deploy", "harness", "Dockerfile"),
    // Stamped on the command line, because the committed Dockerfile stays plain (ADR-0039).
    labels: { "j2.dev/kind": "kit" },
  });
  assert.equal(kitImageBuild(kit, "operator", refs.operator, AMD64).context, join(kit, "operator"));
});

test("kit hashes exclude only what each context's OWN .dockerignore drops", async () => {
  // An exclusion is sound only when the entry is context-invisible; excluding anything the build
  // can see under-hashes (a silent stale image, ADR-0038). packages/* build from the KIT ROOT,
  // whose .dockerignore drops **/node_modules and **/dist — so a packages/harness/bin/ IS context
  // content and must move the ref (the old shared exclude set skipped it). The operator builds
  // from operator/, whose .dockerignore allowlists go sources only — bin/testbin/cover.out are
  // invisible there, so they must NOT move the ref (and the ~400 MB of downloaded tooling under
  // operator/bin stays off the converge walk).
  const src = "export const x = 1;\n";
  const base = await kitImageRefs(await mkTree(kitFiles(src)), { platforms: AMD64 });

  const withBin = await kitImageRefs(await mkTree({ ...kitFiles(src), "packages/harness/bin/tool": "#!/bin/sh\n" }), {
    platforms: AMD64,
  });
  assert.notEqual(withBin.harness, base.harness, "packages/harness/bin is context-visible, so it is hashed");

  const withNm = await kitImageRefs(await mkTree({ ...kitFiles(src), "packages/harness/node_modules/x.js": "1;" }), {
    platforms: AMD64,
  });
  assert.equal(withNm.harness, base.harness, "**/node_modules is dockerignored, so it stays excluded");

  const withTooling = await kitImageRefs(
    await mkTree({ ...kitFiles(src), "operator/bin/etcd": "ELF…", "operator/cover.out": "mode: set\n" }),
    { platforms: AMD64 },
  );
  assert.equal(withTooling.operator, base.operator, "operator's non-go tooling and coverage stay excluded");
});

test("a packages/harness edit moves the harness ref and NO Sandbox Image ref", async () => {
  // The inversion ADR-0037 decided: the wrap made every Sandbox Image `COPY --from=<harness>`, so a
  // kit source edit re-tagged, rebuilt, and re-delivered every user image on the cluster. The
  // runtime rides the pod's /opt/j2 volume now, so the harness ref moves alone and future pods pick
  // it up — the only way an image the user merely BROUGHT could ever follow a kit update at all.
  const before = await kitImageRefs(await mkTree(kitFiles("export const x = 1;\n")), { platforms: AMD64 });
  const after = await kitImageRefs(await mkTree(kitFiles("export const x = 2;\n")), { platforms: AMD64 });
  assert.notEqual(after.harness, before.harness, "the harness ref moves with its sources");
  assert.equal(after.adapter, before.adapter, "…and only its own — the Adapter is untouched");

  const image = await mkTree({ Dockerfile: "FROM node:24-slim\nRUN apt-get install -y cargo\n" }, "j2-image-");
  assert.equal(
    await imageContextDigest(image),
    await imageContextDigest(image),
    "the same directory is the same address, and the harness ref is not even a parameter to ask about",
  );

  const edited = await mkTree({ Dockerfile: "FROM node:24-slim\nRUN apt-get install -y rustc\n" }, "j2-image-");
  assert.notEqual(await imageContextDigest(edited), await imageContextDigest(image), "a Dockerfile edit moves it");
});

test("`images/` never enters the instance bundle, so a Dockerfile edit cannot roll the Orchestrator", async () => {
  // ADR-0038 rejects Deployment env for the ref map because a Dockerfile edit would otherwise roll
  // the Orchestrator and put every live run through snapshot restore. `pnpm deploy` bundles the
  // package whole, so `images/` rode into the image and the INSTANCE tag moved anyway — the
  // rationale was false in fact. `images/default` is host-side only (`j2 up` checks that one path;
  // the Orchestrator resolves refs from the `j2-images` ConfigMap), so the tree is pure dead weight.
  // A context a MODULE ships is a different tree entirely: it lives beside the workflow and rides
  // the bundle, which is what lets the pod compute its digest at all (ADR-0049).
  const port = (dockerfile: string) =>
    stagingPort(() => ({
      "package.json": `{"name":"inst"}`,
      "workflows/build.ts": "export const machine = 1;\n",
      "images/default/Dockerfile": dockerfile,
    }));

  assert.equal(
    await hashOf(port("FROM node:24-slim\nRUN apt-get install -y cargo\n")),
    await hashOf(port("FROM node:24-slim\n")),
    "editing images/default/Dockerfile leaves the instance image's address alone",
  );

  const scratchRoot = await mkdtemp(join(tmpdir(), "j2-build-"));
  const staged = await stageInstanceBundle(port("FROM node:24-slim\n"), scratchRoot);
  try {
    await assert.rejects(stat(join(staged.dir, "images")), "the staged bundle carries no images/ at all");
    assert.ok(await stat(join(staged.dir, "workflows")), "…and everything the Orchestrator DOES read stays");
  } finally {
    await staged.dispose();
  }
});

// --- the platform set (ADR-0045) ---------------------------------------------------------------

test("the tag names the platform set, sorted, in the address itself", () => {
  // In the TAG, not the salt: the triggering failure — an amd64 image delivered to an arm64 cluster
  // — was invisible precisely because the tag did not say. Sorted, so one set has one spelling.
  assert.equal(platformSuffix(["linux/arm64"]), "-arm64");
  assert.equal(platformSuffix(["linux/arm64", "linux/amd64"]), "-amd64-arm64");
  assert.equal(platformSuffix(["linux/amd64", "linux/arm64"]), platformSuffix(["linux/arm64", "linux/amd64"]));
  // The supported set is what the kit RELEASES for — `scripts/kit-push.sh` builds the same list, and
  // kit-push.test.ts fails the gate if the two drift.
  assert.deepEqual([...SUPPORTED_PLATFORMS], ["linux/amd64", "linux/arm64"]);
});

test("the cluster's nodes choose the platform set; an unpublished arch is reported and skipped", () => {
  // A singleton is not an assumption — it is the cluster stating what it can run.
  assert.deepEqual(choosePlatforms({ nodeArches: ["arm64", "arm64", "arm64"] }), {
    platforms: ["linux/arm64"],
    skipped: [],
    source: "nodes",
  });
  // Mixed: build for both rather than guess which node the pod lands on.
  assert.deepEqual(choosePlatforms({ nodeArches: ["arm64", "amd64"] }), {
    platforms: ["linux/amd64", "linux/arm64"],
    skipped: [],
    source: "nodes",
  });
  // An arch the kit publishes no Kit image for is dead weight: nothing could sit beside the instance
  // image in that pod, so it is reported and never built for.
  assert.deepEqual(choosePlatforms({ nodeArches: ["amd64", "s390x"] }), {
    platforms: ["linux/amd64"],
    skipped: ["s390x"],
    source: "nodes",
  });
});

test("no supported platform at all is a loud error naming what was found and the way out", () => {
  // The empty intersection, and the read that found no node at all (an autoscaled-to-zero pool):
  // both are the same fact — nothing to build for — and both point at the one key that overrides it.
  assert.throws(() => choosePlatforms({ nodeArches: ["s390x", "ppc64le"] }), /ppc64le, s390x[\s\S]*`platforms`/);
  assert.throws(() => choosePlatforms({ nodeArches: [] }), /no architecture at all[\s\S]*`platforms`/);
});

test("`platforms` is absolute — derivation is skipped, and an unpublished entry is the same error", () => {
  // The escape hatch for what derivation cannot see: a pool with no nodes yet, or a polluted set
  // whose second arch would cost a needless qemu cross-build.
  assert.deepEqual(choosePlatforms({ nodeArches: ["amd64", "arm64"], configured: ["linux/arm64"] }), {
    platforms: ["linux/arm64"],
    skipped: [],
    source: "config",
  });
  // NOT additive or subtractive, and never quietly trimmed: a key the user typed is a claim, so an
  // unsupported entry fails by name rather than building something other than what was asked for.
  assert.throws(
    () => choosePlatforms({ nodeArches: ["amd64"], configured: ["linux/amd64", "linux/s390x"] }),
    /`platforms` names linux\/s390x/,
  );
  assert.throws(() => choosePlatforms({ nodeArches: ["amd64"], configured: [] }), /an empty list/);
});

test("a foreign platform with no emulation fails BEFORE any build, naming the fix", async () => {
  // Without qemu binfmt, a foreign `RUN` dies minutes in with `exec format error` — the very
  // symptom this ADR exists to delete. So the question is asked first, and the answer is a command.
  const amd64Only: BuildPort = { ...nullPort(), buildablePlatforms: async () => ["linux/amd64", "linux/386"] };
  await assert.rejects(
    () => assertEmulation(amd64Only, ["linux/arm64"]),
    /cannot build for linux\/arm64[\s\S]*tonistiigi\/binfmt --install arm64/,
  );
  await assert.doesNotReject(() => assertEmulation(amd64Only, ["linux/amd64"]));

  // A port that cannot answer has no opinion: this check may only ever turn a late cryptic failure
  // into an early named one, never invent a failure of its own.
  const noDocker: BuildPort = {
    ...nullPort(),
    buildablePlatforms: async () => {
      throw new Error("Cannot connect to the Docker daemon");
    },
  };
  await assert.doesNotReject(() => assertEmulation(noDocker, ["linux/arm64"]));
});

test("imageUser follows the artifact: a manifest list answers per platform, and must answer once", () => {
  // A multi-platform build never lands in the daemon (buildx pushes it), so the seat is read off the
  // registry with `buildx imagetools inspect`, whose `{{json .Image}}` is keyed by platform.
  const list = JSON.stringify({
    "linux/amd64": { config: { User: "app" } },
    "linux/arm64": { config: { User: "app" } },
  });
  assert.equal(manifestListUser("reg/x:1-amd64-arm64", list), "app");
  // A single-platform index answers with the bare config; no USER is the empty string, which is
  // DATA (ADR-0037's uid-1000 fallback turns on it) rather than a missing value.
  assert.equal(manifestListUser("reg/x:1-amd64", JSON.stringify({ config: {} })), "");
  // One image, one seat: the map a provision reads carries a single `sandboxUser` per image, so a
  // per-platform disagreement is a fact the record cannot hold — it says so instead of picking one.
  const split = JSON.stringify({
    "linux/amd64": { config: { User: "app" } },
    "linux/arm64": { config: { User: "root" } },
  });
  assert.throws(() => manifestListUser("reg/x:1-amd64-arm64", split), /different USER per platform/);
});

// --- ownership + the sweep (ADR-0039) ----------------------------------------------------------

test("a Sandbox Image is ONE build to its content tag: no intermediate name, no generated Dockerfile", async () => {
  // The wrap needed a mutable tag between the user's build and its own, which serialized concurrent
  // converges of one checkout (one converge's untag failed the other's `FROM`) — a problem space
  // that existed only because the wrap did. With the runtime arriving at pod time there is exactly
  // one build, its context is the user's own directory, and nothing j2 generated is fed to docker.
  const requests: BuildRequest[] = [];
  const removed: string[] = [];
  const port: BuildPort = {
    ...nullPort(),
    build: async (req) => void requests.push(req),
    removeHostImage: async (ref) => void removed.push(ref),
  };

  const tag = sandboxImageTag("inst", "default", "99aa", { platforms: AMD64 });
  await buildSandboxImage(port, { dir: "/tmp/images/default", tag, instance: "inst", platforms: AMD64 });

  assert.equal(requests.length, 1, `one docker build (got: ${requests.map((r) => r.tag).join(", ")})`);
  assert.equal(requests[0]!.dockerfileContent, undefined, "the user's own Dockerfile, never a generated one");
  assert.equal(requests[0]!.dockerfile, undefined, "…found where docker looks by default, in its own context");
  // Stamped on the command line — ownership is read off the image, never parsed out of its name
  // (ADR-0039), and the user's Dockerfile keeps zero j2 knowledge.
  assert.deepEqual(requests[0], {
    tag: "j2-sandbox-inst-default:99aa-amd64",
    platforms: AMD64,
    context: "/tmp/images/default",
    labels: { "j2.dev/kind": "sandbox", "j2.dev/instance": "inst" },
  });
  assert.deepEqual(removed, [], "nothing to untag: there is no intermediate to leave behind");
});

test("the sweep matches containerd's names, and a registry copy is a different ref", () => {
  // ONE normalization, on both sides: `kind load` imports into containerd, which rewrites a local
  // tag to `docker.io/library/<name>:<tag>`, while every root — the `j2-images` map, a Sandbox's
  // spec.image, a pod's container image — spells it the short way. Stripping exactly that namespace
  // and nothing else is also what keeps the two COPIES apart: a keep set naming the local ref must
  // not protect the registry's copy of the same content, which under ADR-0039 is cache like any
  // other and sweeps when nothing names it.
  const images = [
    image({ id: "sha256:aaa", tags: ["docker.io/library/j2-instance-myinst:aa11"], bytes: 412_000_000 }),
    image({ id: "sha256:bbb", tags: ["reg.example.com/j2-instance-myinst:aa11"], bytes: 412_000_000 }),
    image({ id: "sha256:ccc", tags: ["docker.io/library/j2-harness:0f1e"], bytes: 238_000_000 }),
  ];
  const keep = ["j2-instance-myinst:aa11", "j2-harness:0f1e"];

  assert.deepEqual(nodeSweepPlan(images, keep), {
    remove: [{ id: "sha256:bbb", tags: ["reg.example.com/j2-instance-myinst:aa11"], bytes: 412_000_000 }],
    kept: [],
  });

  // …and the registry's copy IS kept once a root names it by its own, host-qualified ref.
  assert.deepEqual(nodeSweepPlan(images, [...keep, "reg.example.com/j2-instance-myinst:aa11"]).remove, []);
});

test("a node image id is removed whole, once — and a mixed id is kept whole and said", () => {
  // `crictl rmi <tag>` resolves the tag to its image id and removes the WHOLE image, every tag with
  // it (CRI has no untag verb). So removal is a per-ID decision: an id goes only when every tag on
  // it is unreachable. Not paranoia — two instances whose `images/x` trees and harness ref are
  // byte-identical hash to the same content under different tags, and the other one is running.
  const shared = [
    image({
      id: "sha256:ddd",
      tags: ["docker.io/library/j2-sandbox-myinst-default:99aa", "docker.io/library/j2-sandbox-other-default:99aa"],
      bytes: 500,
    }),
  ];
  assert.deepEqual(nodeSweepPlan(shared, ["j2-sandbox-other-default:99aa"]), {
    remove: [],
    kept: ["docker.io/library/j2-sandbox-myinst-default:99aa"],
  });

  // The failure observed live: three unreachable tags on one id (hash-moving edits that produced
  // byte-identical images). One id, one removal, all three tags reported — a second `rmi` for a
  // sibling tag is what died `no such image` and aborted the old loop.
  const triple = [
    image({
      id: "sha256:eee",
      tags: [
        "docker.io/library/j2-sandbox-myinst-default:c0cc",
        "docker.io/library/j2-sandbox-myinst-default:b1aa",
        "docker.io/library/j2-instance-myinst:77ff",
      ],
      bytes: 900,
    }),
  ];
  assert.deepEqual(nodeSweepPlan(triple, ["j2-instance-myinst:88ee"]), {
    remove: [{ id: "sha256:eee", tags: triple[0]!.tags, bytes: 900 }],
    kept: [],
  });
});

test("an unlabeled image is invisible — not removed, not kept, not reported", () => {
  // Images built before ADR-0039 carry no stamp, and neither does anything j2 never built. Sweeping
  // them means guessing by name again, which is the whole primitive being deleted — so they are not
  // "kept" either: the sweep has nothing to say about an image that is not its business.
  const images = [
    image({ id: "sha256:aaa", tags: ["docker.io/library/j2-instance-old:beef"], bytes: 100, labeled: false }),
    image({ id: "sha256:bbb", tags: ["docker.io/library/postgres:16"], bytes: 200, labeled: false }),
    image({ id: "sha256:ccc", tags: ["docker.io/library/j2-instance-new:c0de"], bytes: 300 }),
  ];
  assert.deepEqual(nodeSweepPlan(images, []), {
    remove: [{ id: "sha256:ccc", tags: ["docker.io/library/j2-instance-new:c0de"], bytes: 300 }],
    kept: [],
  });
  // The ref removed is the store's OWN spelling — normalization decides reachability, never what
  // is handed back to `docker rmi`, which knows only the tags it holds.
  assert.deepEqual(hostSweepPlan(images, []).remove, [
    { ref: "docker.io/library/j2-instance-new:c0de", id: "sha256:ccc", bytes: 300 },
  ]);
});

test("reachability beats any naming: a kit ref goes when nothing names it, a stranger stays when something does", () => {
  // "Kit images are never pruned" was a rule by fiat; it dissolves into reachability. A kit ref is
  // kept because some instance's map or pod names it — and when the last instance leaves the
  // cluster, it collects like everything else. The converse matters just as much: a ref no name
  // grammar would recognize is untouchable while a live root names it.
  const images = [
    image({ id: "sha256:kit", tags: ["docker.io/library/j2-harness:0f1e"], bytes: 238_000_000 }),
    image({ id: "sha256:odd", tags: ["docker.io/library/whatever-i-named-it:v3"], bytes: 10 }),
  ];
  assert.deepEqual(nodeSweepPlan(images, ["whatever-i-named-it:v3"]), {
    remove: [{ id: "sha256:kit", tags: ["docker.io/library/j2-harness:0f1e"], bytes: 238_000_000 }],
    kept: [],
  });
});

test("the host sweeps per TAG, and credits an id's bytes exactly once — on the tag that frees them", () => {
  // `docker rmi <tag>` untags: the id lives on under its other tags, and the disk comes back only
  // with the last one. So the host plan is per ref (no mixed-id case at all), while the byte
  // accounting is per id — summing per tag would report an image twice for having two names.
  const twoTags = image({ id: "sha256:aaa", tags: ["j2-instance-x:aa", "j2-instance-x:bb"], bytes: 1_000 });

  // One tag reachable: the other still goes, but nothing is reclaimed by dropping a name.
  const partial = hostSweepPlan([twoTags], ["j2-instance-x:aa"]);
  assert.deepEqual(partial, { remove: [{ ref: "j2-instance-x:bb", id: "sha256:aaa", bytes: 0 }], bytes: 0 });

  // Both unreachable: two removals, one credit.
  const whole = hostSweepPlan([twoTags], []);
  assert.deepEqual(
    whole.remove.map((r) => r.ref),
    ["j2-instance-x:aa", "j2-instance-x:bb"],
  );
  assert.equal(whole.bytes, 1_000, "the id's size is credited once, not once per tag");
});

test("a labeled image with no tags left is garbage by construction, and goes by id", () => {
  // Rebuilding a moved tag leaves its predecessor `<none>:<none>` on the host, and `kind load`
  // leaves the same tagless id on a node. No keep set can ever name one — and a ref-only sweep
  // leaks exactly them, which after a Dockerfile-iteration session is most of the disk.
  const orphan = image({ id: "sha256:dead", tags: [], bytes: 2_000 });
  assert.deepEqual(hostSweepPlan([orphan], ["j2-instance-x:aa"]), {
    remove: [{ ref: "sha256:dead", id: "sha256:dead", bytes: 2_000 }],
    bytes: 2_000,
  });
  assert.deepEqual(nodeSweepPlan([orphan], ["j2-instance-x:aa"]).remove, [
    { id: "sha256:dead", tags: [], bytes: 2_000 },
  ]);
});

test("a failed removal is reported and the loop goes on; already-gone is success", () => {
  // Neither `docker rmi` nor `crictl rmi` is idempotent — both exit 1 on a missing image — so
  // delete-if-present has to be read out of the error, and one image's failure must never abandon
  // everything queued behind it (ADR-0039).
  const images = [
    image({ id: "sha256:aaa", tags: ["j2-a:1"], bytes: 10 }),
    image({ id: "sha256:bbb", tags: ["j2-b:1"], bytes: 20 }),
    image({ id: "sha256:ccc", tags: ["j2-c:1"], bytes: 40 }),
  ];
  const port: BuildPort = {
    ...nullPort(),
    hostImages: async () => images,
    removeHostImage: async (ref) => {
      if (ref === "j2-a:1") throw new Error("Error response from daemon: No such image: j2-a:1");
      if (ref === "j2-b:1") throw new Error("Error response from daemon: conflict: image is in use\nby a container");
    },
  };

  return sweepHost(port, { keep: [] }).then((result) => {
    assert.deepEqual(result.removed, ["j2-a:1", "j2-c:1"], "absent IS the goal state, however it got there");
    assert.deepEqual(result.failed, ["j2-b:1 (Error response from daemon: conflict: image is in use)"]);
    assert.equal(result.bytes, 40, "an image something else already took gave US no bytes back");
  });
});

/**
 * A node store that really removes — the listing shrinks. A fake whose `removeNodeImage` only
 * returned is how the node half came to reclaim nothing while reporting gigabytes: on a kind node
 * `crictl rmi <id>` exits 0 having dropped only the names CRI knows, leaving the image alive under
 * the `import-<date>@<digest>` ref `kind load` also created. Nothing socket-free can see that, but
 * a store that can DISAGREE with its own exit code can — see `keeps` below.
 */
function nodeStore(
  perNode: Record<string, ObservedImage[]>,
  opts: { keeps?: string[] } = {},
): BuildPort & { calls: string[] } {
  const store = new Map(Object.entries(perNode).map(([node, images]) => [node, [...images]]));
  const port = {
    ...nullPort(),
    calls: [] as string[],
    nodeImages: async () => [...store].map(([node, images]) => ({ node, images })),
    removeNodeImage: async (_cluster: string, node: string, id: string) => {
      port.calls.push(`${node} ${id}`);
      // Exits 0 either way; `keeps` is the store that shrugged and kept the image anyway.
      if (opts.keeps?.includes(id)) return;
      store.set(
        node,
        (store.get(node) ?? []).filter((i) => i.id !== id),
      );
    },
  };
  return port;
}

test("the node sweep reaches every node, one rmi per id, and sums what it took", async () => {
  const nodes = () => ({
    "j2-control-plane": [
      image({ id: "sha256:aaa", tags: ["docker.io/library/j2-instance-x:aa"], bytes: 1_000 }),
      image({ id: "sha256:bbb", tags: ["docker.io/library/j2-harness:0f1e"], bytes: 2_000 }),
    ],
    "j2-worker": [image({ id: "sha256:aaa", tags: ["docker.io/library/j2-instance-x:aa"], bytes: 1_000 })],
  });
  const port = nodeStore(nodes());

  const result = await sweepNodes(port, { cluster: "j2", keep: ["j2-harness:0f1e"] });
  assert.deepEqual(port.calls, ["j2-control-plane sha256:aaa", "j2-worker sha256:aaa"], "each node holds its copy");
  assert.deepEqual(result.removed, ["docker.io/library/j2-instance-x:aa", "docker.io/library/j2-instance-x:aa"]);
  assert.equal(result.bytes, 2_000, "two nodes, two copies, two lots of disk");
  assert.deepEqual(result.failed, []);

  // A dry run answers the same plan and touches nothing (`j2 gc --dry-run`, ADR-0039).
  const untouched = nodeStore(nodes());
  const dry = await sweepNodes(untouched, { cluster: "j2", keep: ["j2-harness:0f1e"], dryRun: true });
  assert.deepEqual(untouched.calls, []);
  assert.deepEqual(dry.removed, result.removed);
});

test("a node removal is confirmed by re-listing — an exit code is not a reclaimed byte", async () => {
  // The failure this exists for: `crictl rmi <id>` exits 0 on a kind node having dropped only the
  // names CRI knows, while the image lives on under the `import-<date>@<digest>` ref `kind load`
  // also wrote — so the store says success, the disk says nothing was freed, and the next `j2 gc`
  // re-plans the very same id. Trusting the exit code makes the one number ADR-0039 prints a lie.
  const port = nodeStore(
    {
      "j2-control-plane": [
        image({ id: "sha256:stays", tags: ["docker.io/library/j2-instance-x:aa"], bytes: 400_000_000 }),
        image({ id: "sha256:goes", tags: ["docker.io/library/j2-instance-x:bb"], bytes: 1_000 }),
      ],
    },
    { keeps: ["sha256:stays"] },
  );

  const result = await sweepNodes(port, { cluster: "j2", keep: [] });
  assert.deepEqual(result.removed, ["docker.io/library/j2-instance-x:bb"], "only what the node no longer holds");
  assert.equal(result.bytes, 1_000, "the 400 MB the store kept are not the user's to celebrate");
  assert.deepEqual(result.failed, ["docker.io/library/j2-instance-x:aa (the node still holds it after the removal)"]);
});

test("a re-list that cannot answer leaves the removals unverified, and unverified is not reclaimed", async () => {
  let listings = 0;
  const port: BuildPort = {
    ...nullPort(),
    nodeImages: async () => {
      if (++listings > 1) throw new Error("Cannot connect to the Docker daemon\nis it running?");
      return [{ node: "j2-control-plane", images: [image({ id: "sha256:a", tags: ["j2-x:1"], bytes: 10 })] }];
    },
  };
  const result = await sweepNodes(port, { cluster: "j2", keep: [] });
  assert.deepEqual(result.removed, []);
  assert.equal(result.bytes, 0);
  assert.deepEqual(result.failed, ["j2-x:1 (could not verify the removal: Cannot connect to the Docker daemon)"]);
});

test("one image swept on both stores is one image, however each store spells it", async () => {
  // The host says `j2-adapter:33a4`, containerd says `docker.io/library/j2-adapter:33a4`. Merging
  // raw strings reports one image twice; the bytes stay summed, because the two copies are two
  // lots of the user's disk (the same rule as two nodes holding one ref).
  const merged = mergeSweeps(
    { removed: ["j2-adapter:33a4"], kept: [], failed: [], bytes: 217_000_000 },
    { removed: ["docker.io/library/j2-adapter:33a4"], kept: [], failed: [], bytes: 224_000_000 },
  );
  assert.deepEqual(merged.removed, ["j2-adapter:33a4"], "one image, once, in the spelling a root would use");
  assert.equal(merged.bytes, 441_000_000);
});

test("a node whose images will not say who built them stops the sweep instead of narrating success", async () => {
  // A broken label read makes every image read as unlabeled, and unlabeled is invisible — so the
  // whole node sweep becomes a no-op that prints "swept nothing". One id nobody answers for is
  // still fine: that one is gone or racing, and the rest of the node is swept normally.
  const ok = await crictlLabels("j2-control-plane", ["sha256:a", "sha256:b"], async (batch) => {
    if (batch.length > 1) throw new Error("crictl: no such image sha256:b");
    if (batch[0] === "sha256:b") throw new Error("crictl: no such image sha256:b");
    return JSON.stringify({
      status: { id: "sha256:a" },
      info: { imageSpec: { config: { Labels: kitImageLabels() } } },
    });
  });
  assert.deepEqual([...ok.keys()], ["sha256:a"]);

  await assert.rejects(
    () =>
      crictlLabels("j2-control-plane", ["sha256:a"], async () => {
        throw new Error('OCI runtime exec failed: exec: "crictl": executable file not found in $PATH');
      }),
    /no image on node "j2-control-plane" would say who built it.*crictl.*not found/s,
  );
});

test("bytes are the narration, because disk is the quantity the user feels", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(940), "940 B");
  assert.equal(formatBytes(4_445_841), "4.4 MB");
  assert.equal(formatBytes(2_100_000_000), "2.1 GB");
});

// --- the bundle's install (ADR-0043) -----------------------------------------------------------

/** The exec seam, recording. No package manager is ever spawned here: the claims are which argv a
 * lockfile selects and where it runs, and both are decidable from the Instance's own bytes. */
function recordingRun(): { calls: Array<{ command: string; args: string[]; cwd: string }>; run: RunCommand } {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  return { calls, run: async (command, args, cwd) => void calls.push({ command, args, cwd }) };
}

/** A scratch `outDir` that does NOT exist yet — the shape `stageInstanceBundle` hands the port. */
async function bundleOut(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "j2-bundle-")), "bundle");
}

test("each lockfile selects the package manager that speaks it, frozen and production-only", async () => {
  // ADR-0043's dispatch, whole. Lockfiles are proprietary formats, so "supporting a PM" is nothing
  // but invoking the binary that wrote the lockfile — the binary whose presence the lockfile itself
  // guarantees. pnpm carries `node-linker=hoisted` so the bundle is flat real files whatever wrote
  // it; bun's two spellings are one row, since `bun.lockb` is the format `bun.lock` replaced.
  const table: Array<[string, string[]]> = [
    ["package-lock.json", ["npm", "ci", "--omit=dev"]],
    ["pnpm-lock.yaml", ["pnpm", "install", "--prod", "--frozen-lockfile", "--config.node-linker=hoisted"]],
    ["bun.lock", ["bun", "install", "--production", "--frozen-lockfile"]],
    ["bun.lockb", ["bun", "install", "--production", "--frozen-lockfile"]],
  ];
  for (const [lockfile, argv] of table) {
    const instance = await mkTree({ "package.json": `{"name":"inst"}`, [lockfile]: "lock\n" }, "j2-instance-");
    const out = await bundleOut();
    const { calls, run } = recordingRun();
    await bundleInstance(instance, out, run);
    assert.deepEqual(
      calls,
      [{ command: argv[0]!, args: argv.slice(1), cwd: out }],
      `${lockfile} installs with ${argv[0]}, in the staged bundle`,
    );
  }
});

test("a standalone instance is staged from its committed bytes, never from its node_modules", async () => {
  // The lockfile — not the user's `node_modules/` — is the input, and that is forced (ADR-0043):
  // the GitOps/CI path runs from a clean checkout where no `node_modules` exists, and a copied tree
  // bakes in accidents rather than declarations. ADR-0019's derivability rule, applied to deps.
  // `.j2/` is CLI-local state and `.git/` is history: neither is image content.
  //
  // `.env*` and `.npmrc` are the sharper case, and the reason this asserts the WHOLE listing: they
  // are where a user is told to keep credentials (`j2 init` gitignores `.env` in those words), and
  // `j2 up` reads `.env` host-side into the Orchestrator's Secret. Copied, an API key would sit in
  // an image layer and in the content address naming it — so rotating the key alone would re-tag
  // the image and roll the Orchestrator.
  const instance = await mkTree(
    {
      "package.json": `{"name":"inst"}`,
      "package-lock.json": "lock\n",
      "workflows/feature.ts": "export const machine = 1;\n",
      "node_modules/left-pad/index.js": "module.exports = 1;\n",
      ".j2/state.json": `{"token":"…"}`,
      ".git/HEAD": "ref: refs/heads/main\n",
      ".env": "ANTHROPIC_API_KEY=sk-secret\n",
      ".env.local": "J2_GIT_TOKEN=ghp-secret\n",
      ".npmrc": `//registry.npmjs.org/:_authToken=npm-secret\n`,
    },
    "j2-instance-",
  );
  const out = await bundleOut();
  await bundleInstance(instance, out, recordingRun().run);

  assert.deepEqual((await readdir(out)).sort(), ["package-lock.json", "package.json", "workflows"]);
  assert.equal(await readFile(join(out, "workflows", "feature.ts"), "utf8"), "export const machine = 1;\n");
});

test("the instance's own shape decides the bundle, not the CLI's provenance", async () => {
  // Keyed on a `pnpm-workspace.yaml` above the INSTANCE, never on `detectKitCheckout()`: a checkout
  // CLI can legitimately drive a standalone instance (a developer's /tmp folder), and `pnpm deploy`
  // would fail there — its job, materializing workspace symlinks, only exists in a workspace. This
  // test process runs out of the kit checkout, which is what makes the case real rather than
  // hypothetical.
  assert.ok(await detectKitCheckout(), "the CLI under test IS a kit checkout");
  const standalone = await mkTree({ "package.json": `{"name":"inst"}`, "pnpm-lock.yaml": "lock\n" }, "j2-instance-");
  const { calls, run } = recordingRun();
  await bundleInstance(standalone, await bundleOut(), run);
  assert.equal(calls[0]?.args[0], "install", "the standalone instance still installs from its lockfile");

  // The mirror case: a workspace member takes `pnpm deploy --legacy` unchanged, and needs no
  // lockfile of its own — the workspace root holds it (examples/*, in this checkout).
  const root = await mkTree(
    { "pnpm-workspace.yaml": "packages:\n  - examples/*\n", "examples/starter/package.json": `{"name":"starter"}` },
    "j2-workspace-",
  );
  const member = join(root, "examples", "starter");
  const out = await bundleOut();
  const member_ = recordingRun();
  await bundleInstance(member, out, member_.run);
  assert.deepEqual(member_.calls, [
    { command: "pnpm", args: ["--filter", "starter", "--prod", "deploy", "--legacy", out], cwd: member },
  ]);
  await assert.rejects(stat(out), "pnpm deploy writes the bundle itself — nothing is staged for it");
});

test("no lockfile, two package managers, and yarn are each a named refusal", async () => {
  // The lockfile is part of the instance contract (ADR-0043), so every miss says what to do. Two
  // managers means two dependency graphs, and a precedence rule would silently deploy the one the
  // user stopped maintaining. Yarn is deliberately out for v1: one filename hides two incompatible
  // generations, and berry defaults to PnP — no `node_modules` at all, which the image's resolution
  // model cannot host.
  const none = await mkTree({ "package.json": `{"name":"inst"}` }, "j2-instance-");
  await assert.rejects(
    lockfileInstall(none),
    /no lockfile.*npm \(package-lock\.json\), pnpm \(pnpm-lock\.yaml\), bun \(bun\.lock or bun\.lockb\)/s,
  );

  const two = await mkTree(
    { "package.json": `{"name":"inst"}`, "package-lock.json": "lock\n", "pnpm-lock.yaml": "lock\n" },
    "j2-instance-",
  );
  await assert.rejects(
    lockfileInstall(two),
    /more than one package manager \(npm: package-lock\.json; pnpm: pnpm-lock\.yaml\)/,
  );

  const yarn = await mkTree({ "package.json": `{"name":"inst"}`, "yarn.lock": "lock\n" }, "j2-instance-");
  await assert.rejects(lockfileInstall(yarn), /yarn is not supported — use npm, pnpm, or bun/);

  // Both bun spellings is a migration, not an ambiguity: one manager, one command.
  const bun = await mkTree(
    { "package.json": `{"name":"inst"}`, "bun.lock": "lock\n", "bun.lockb": "bin\n" },
    "j2-instance-",
  );
  assert.deepEqual(await lockfileInstall(bun), {
    command: "bun",
    args: ["install", "--production", "--frozen-lockfile"],
  });

  // And the refusal comes BEFORE the copy: an instance with no lockfile fails on the cheap half.
  const out = await bundleOut();
  await assert.rejects(bundleInstance(none, out, recordingRun().run));
  await assert.rejects(stat(out), "nothing was staged");
});

test("the seal leaves an npm-shaped bundle alone — its shims name no absolute path", async () => {
  // The seal exists for `pnpm deploy`, which bakes the scratch directory into every `.bin` shim's
  // NODE_PATH (ADR-0038). npm and bun write `$basedir`-relative shims, so the rewrite finds
  // nothing — and the standalone bundle is already a function of its inputs. Asserted rather than
  // assumed: the same hash twice is what makes `IfNotPresent` correct for the instance image.
  const npmBundle = stagingPort(() => ({
    "package.json": `{"name":"inst"}`,
    "package-lock.json": `{"lockfileVersion":3}`,
    "node_modules/.bin/tsx": `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\nexec node "$basedir/../tsx/dist/cli.mjs" "$@"\n`,
    "node_modules/tsx/dist/cli.mjs": "export const cli = 1;\n",
  }));
  const { a, b, dispose } = await stageTwice(npmBundle);
  try {
    assert.equal(a.hash, b.hash, "two stagings, one address");
    assert.match(await readFile(join(a.dir, "node_modules", ".bin", "tsx"), "utf8"), /\$basedir/);
  } finally {
    await dispose();
  }
});
