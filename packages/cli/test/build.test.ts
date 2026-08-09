// The image build seam (ADR-0019/0038). Every tag `j2 up` deploys is a content address, so these
// tests pin the properties that make one usable as a cache key at all: the same sources hash the
// same every time, different sources do not, and the inputs each hash covers are the ones the ADRs
// name — including the one nothing else can see, a Sandbox Image's dependence on the resolved
// harness ref.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KIT_VERSION } from "@j2/orchestrator";
import {
  detectKitCheckout,
  kitImageBuild,
  kitImageRefs,
  prunableTags,
  publishedKitRefs,
  sandboxImageHash,
  sandboxWrapDockerfile,
  stageInstanceBundle,
  type BuildPort,
} from "../src/build.ts";

/** A port that materializes `files(out)` — what `pnpm deploy` would have written into the bundle. */
function stagingPort(files: (out: string) => Record<string, string>): BuildPort {
  return {
    bundle: async (_dir, out) => {
      for (const [rel, content] of Object.entries(files(out))) {
        await mkdir(join(out, dirname(rel)), { recursive: true });
        await writeFile(join(out, rel), content);
      }
    },
    build: async () => {},
    run: async () => "",
    untag: async () => {},
    push: async () => {},
    kindLoad: async () => {},
    kindPrune: async () => [],
  };
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

test("the bundle hash ignores the stager's own bookkeeping, so identical sources address identically", async () => {
  // `pnpm deploy` writes two things that vary run to run without the image varying at all:
  // `.modules.yaml` stamps `prunedAt`, and `.bin/*` shims embed the absolute staging path — which
  // is a fresh temp dir each run, and wrong inside the container regardless (the bundle is COPY'd
  // to /instance). Hashing them made every converge look stale, which is a cache that never hits.
  const port = (n: number) =>
    stagingPort((out) => ({
      "package.json": `{"name":"inst"}`,
      "node_modules/.modules.yaml": `prunedAt: Mon, 20 Jul 2026 00:04:${n} GMT\n`,
      "node_modules/.bin/node-which": `export NODE_PATH="${out}/node_modules/.pnpm/which"\n`,
    }));

  assert.equal(await hashOf(port(14)), await hashOf(port(15)), "same sources, two stagings, one address");
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

test("the wrap injects the Harness at /opt/j2, appends PATH, and gives uid 1000 a home", async () => {
  // Three claims that are SILENTLY wrong at runtime if inverted, on a base image no test here can
  // see, so nothing downstream catches them (ADR-0037):
  //   - `/app` instead of `/opt/j2` shadows an /app the user's own base already uses;
  //   - a PREPENDED PATH shadows the toolchain the user pinned — and interpolating `${PATH}` in
  //     the generator emits `PATH=":/opt/j2/bin"`, deleting it outright;
  //   - no writable $HOME for uid 1000 fails every attach with `fatal: $HOME not set`, mid-turn.
  const wrap = sandboxWrapDockerfile("j2-sandbox-inst-default-base:abc123", "j2-harness:9f1e02c4d5a6");

  assert.match(wrap, /^FROM j2-sandbox-inst-default-base:abc123$/m);
  assert.match(wrap, /^COPY --from=j2-harness:9f1e02c4d5a6 \/opt\/j2 \/opt\/j2$/m);
  assert.ok(!wrap.includes("/app"), "the injected runtime lives at /opt/j2, never /app");

  // The literal `${PATH}` must survive into the emitted Dockerfile, and j2's bin must FOLLOW it.
  assert.match(wrap, /^ENV HOME=\/home\/j2 PATH="\$\{PATH\}:\/opt\/j2\/bin"$/m);

  assert.match(wrap, /^RUN mkdir -p \/home\/j2 && chown 1000:0 \/home\/j2 && chmod 0775 \/home\/j2$/m);
  assert.ok(
    wrap.trimEnd().endsWith(`CMD ["/opt/j2/bin/node", "/opt/j2/src/main.ts"]`),
    "absolute CMD, WORKDIR-independent",
  );
});

test("installed from npm, the kit three resolve to the published <kitversion> tags", () => {
  // These were `j2.config.ts`'s `images` defaults; the block is gone (ADR-0038), so they live here
  // as the not-a-kit-checkout branch — and as the last leg of ADR-0037's Sandbox Image chain.
  // Deliberately NOT registry-prefixed: kit refs for a mirror-only cluster is a deferred mechanism.
  assert.deepEqual(publishedKitRefs(), {
    harness: `j2-harness:${KIT_VERSION}`,
    adapter: `j2-adapter:${KIT_VERSION}`,
    operator: `j2-operator:${KIT_VERSION}`,
  });
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

test("each kit image addresses its own sources; the registry prefixes a built ref", async () => {
  const kit = await mkTree(kitFiles("export const x = 1;\n"));
  const refs = await kitImageRefs(kit);
  for (const [name, ref] of Object.entries(refs)) {
    assert.match(ref, new RegExp(`^j2-${name}:[0-9a-f]{12}$`), `${name} is content-addressed`);
  }
  assert.deepEqual(await kitImageRefs(kit), refs, "same sources, same addresses");

  const pushed = await kitImageRefs(kit, "reg.example.com/j2");
  assert.equal(pushed.harness, `reg.example.com/j2/${refs.harness}`);

  // The build is the committed Dockerfile against its own context — the harness/adapter build from
  // the kit ROOT (the packages ship as source), the operator from `operator/`.
  assert.deepEqual(kitImageBuild(kit, "harness", refs.harness), {
    tag: refs.harness,
    context: kit,
    dockerfile: join(kit, "deploy", "harness", "Dockerfile"),
  });
  assert.equal(kitImageBuild(kit, "operator", refs.operator).context, join(kit, "operator"));
});

test("a packages/harness edit moves the harness ref AND, through the wrap salt, every Sandbox Image ref", async () => {
  // ADR-0037's consequence, and the only place it is checkable: a Sandbox Image is
  // `COPY --from=<harness>`, so without the harness ref in its hash, editing packages/harness/src
  // leaves every Sandbox Image tag unchanged and pods keep running the old runtime.
  const before = await kitImageRefs(await mkTree(kitFiles("export const x = 1;\n")));
  const after = await kitImageRefs(await mkTree(kitFiles("export const x = 2;\n")));
  assert.notEqual(after.harness, before.harness, "the harness ref moves with its sources");
  assert.equal(after.adapter, before.adapter, "…and only its own — the Adapter is untouched");

  const image = await mkTree({ Dockerfile: "FROM node:24-slim\nRUN apt-get install -y cargo\n" }, "j2-image-");
  assert.notEqual(
    await sandboxImageHash(image, after.harness),
    await sandboxImageHash(image, before.harness),
    "the same Dockerfile against a new Harness is a new image",
  );
  assert.equal(
    await sandboxImageHash(image, before.harness),
    await sandboxImageHash(image, before.harness),
    "…and the same inputs are the same address",
  );

  const edited = await mkTree({ Dockerfile: "FROM node:24-slim\nRUN apt-get install -y rustc\n" }, "j2-image-");
  assert.notEqual(
    await sandboxImageHash(edited, before.harness),
    await sandboxImageHash(image, before.harness),
    "a Dockerfile edit moves it too",
  );
});

test("a Sandbox Image's hash covers its WHOLE directory — node_modules and dist are image content", async () => {
  // The under-hashing defect: `images/<name>/` IS the build context (ADR-0037) and has no
  // `.dockerignore`, so docker COPYs `node_modules/` and `dist/` in. Hashing it with the kit's
  // exclude set (which describes the KIT's own `.dockerignore`) meant editing `images/x/dist/foo`
  // changed the image at an unchanged tag — the silent-stale-image bug ADR-0038 exists to delete.
  // Over-hashing is that ADR's stated direction; under-hashing is the defect.
  const harness = "j2-harness:0f1e2d3c4b5a";
  const dirOf = (a: string, b: string) =>
    mkTree(
      {
        "images/x/Dockerfile": "FROM node:24-slim\nCOPY . /srv\n",
        "images/x/node_modules/a.txt": a,
        "images/x/dist/b.txt": b,
      },
      "j2-image-tree-",
    ).then((root) => join(root, "images", "x"));

  const base = await sandboxImageHash(await dirOf("a1", "b1"), harness);
  assert.equal(await sandboxImageHash(await dirOf("a1", "b1"), harness), base, "same bytes, same address");
  assert.notEqual(await sandboxImageHash(await dirOf("a2", "b1"), harness), base, "node_modules/ is hashed");
  assert.notEqual(await sandboxImageHash(await dirOf("a1", "b2"), harness), base, "dist/ is hashed");
});

test("`images/` never enters the instance bundle, so a Dockerfile edit cannot roll the Orchestrator", async () => {
  // ADR-0038 rejects Deployment env for the ref map because a Dockerfile edit would otherwise roll
  // the Orchestrator and put every live run through snapshot restore. `pnpm deploy` bundles the
  // package whole, so `images/` rode into the image and the INSTANCE tag moved anyway — the
  // rationale was false in fact. `discoverImages` is host-side only (the CLI calls it; the
  // Orchestrator resolves refs from the `j2-images` ConfigMap), so the tree is pure dead weight.
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

test("the kind prune matches containerd's names, and removes by tag rather than by image id", async () => {
  // The dead-code defect: `kind load` imports into containerd, which NORMALIZES a local tag to
  // `docker.io/library/<name>:<tag>`. Matching bare prefixes with `startsWith` therefore matched
  // nothing ever — a real `j2 down` left 28 of this instance's images on the node and reported
  // "no images to prune". Stripping exactly that one namespace fixes it while keeping the property
  // the anchoring existed for: a registry-pushed ref keeps its host and is still spared (ADR-0038).
  const listing = `{"images":[
    {"id":"sha256:aaa","repoTags":["docker.io/library/j2-instance-myinst:aa11bb22cc33"],"size":"412000000"},
    {"id":"sha256:bbb","repoTags":["reg.example.com/j2-instance-myinst:aa11bb22cc33"],"size":"412000000"},
    {"id":"sha256:ccc","repoTags":["docker.io/library/j2-harness:0f1e2d3c4b5a"],"size":"238000000"}
  ]}`;
  const images = (JSON.parse(listing) as { images: Parameters<typeof prunableTags>[0] }).images;

  assert.deepEqual(
    prunableTags(images, ["j2-instance-myinst:", "j2-sandbox-myinst-"]),
    ["docker.io/library/j2-instance-myinst:aa11bb22cc33"],
    "the local tag goes; the registry's copy and the shared kit image stay",
  );

  // One id can carry several tags, which is why removal is by TAG: `crictl rmi <id>` would take
  // the kit tag below with it — an image every other instance on the cluster still needs.
  const shared = [{ id: "sha256:ddd", repoTags: ["docker.io/library/j2-sandbox-myinst-x:99aa", "j2-harness:0f1e"] }];
  assert.deepEqual(prunableTags(shared, ["j2-sandbox-myinst-"]), ["docker.io/library/j2-sandbox-myinst-x:99aa"]);
});
