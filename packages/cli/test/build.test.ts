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
  buildSandboxImage,
  crictlLabels,
  detectKitCheckout,
  formatBytes,
  hostSweepPlan,
  kitImageBuild,
  kitImageLabels,
  kitImageRefs,
  mergeSweeps,
  nodeSweepPlan,
  publishedKitRefs,
  sandboxImageHash,
  sandboxWrapDockerfile,
  stageInstanceBundle,
  sweepHost,
  sweepNodes,
  type BuildPort,
  type BuildRequest,
  type ObservedImage,
} from "../src/build.ts";

/** Every verb, inert. Each test overrides the two or three it is about; the rest answering with
 * nothing is what keeps a build test from depending on the sweep and vice versa. */
function nullPort(): BuildPort {
  return {
    bundle: async () => {},
    build: async () => {},
    run: async () => "",
    push: async () => {},
    kindLoad: async () => {},
    hostImages: async () => [],
    removeHostImage: async () => {},
    nodeImages: async () => [],
    removeNodeImage: async () => {},
  };
}

/** A port that materializes `files(out)` — what `pnpm deploy` would have written into the bundle. */
function stagingPort(files: (out: string) => Record<string, string>): BuildPort {
  return {
    ...nullPort(),
    bundle: async (_dir, out) => {
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
    // Stamped on the command line, because the committed Dockerfile stays plain (ADR-0039).
    labels: { "j2.dev/kind": "kit" },
  });
  assert.equal(kitImageBuild(kit, "operator", refs.operator).context, join(kit, "operator"));
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
  const base = await kitImageRefs(await mkTree(kitFiles(src)));

  const withBin = await kitImageRefs(await mkTree({ ...kitFiles(src), "packages/harness/bin/tool": "#!/bin/sh\n" }));
  assert.notEqual(withBin.harness, base.harness, "packages/harness/bin is context-visible, so it is hashed");

  const withNm = await kitImageRefs(await mkTree({ ...kitFiles(src), "packages/harness/node_modules/x.js": "1;" }));
  assert.equal(withNm.harness, base.harness, "**/node_modules is dockerignored, so it stays excluded");

  const withTooling = await kitImageRefs(
    await mkTree({ ...kitFiles(src), "operator/bin/etcd": "ELF…", "operator/cover.out": "mode: set\n" }),
  );
  assert.equal(withTooling.operator, base.operator, "operator's non-go tooling and coverage stay excluded");
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

// --- ownership + the sweep (ADR-0039) ----------------------------------------------------------

test("every image j2 builds is stamped, so ownership is read off the image and never off its name", async () => {
  // The primitive ADR-0039 deletes is parsing names: `j2-sandbox-<instance>-<name>` has no reserved
  // delimiter, so `my` + `extra-default` and `my-extra` + `default` are one repo, and deleting an
  // `images/<x>/` folder orphaned its tags because nothing derived their names any more. A stamp
  // answers both — but only for images that carry one, so an unstamped build is a permanent leak.
  const requests: BuildRequest[] = [];
  const port: BuildPort = { ...nullPort(), build: async (req) => void requests.push(req) };

  await buildSandboxImage(port, {
    dir: "/tmp/images/default",
    tag: "j2-sandbox-inst-default:99aa",
    baseTag: "j2-sandbox-inst-default-base:99aa",
    harnessRef: "j2-harness:0f1e",
    instance: "inst",
  });

  // BOTH builds, not just the wrap: the `-base` tag is dropped straight after, and the labeled id
  // it leaves behind is only collectable because it was stamped.
  assert.deepEqual(
    requests.map((r) => [r.tag, r.labels]),
    [
      ["j2-sandbox-inst-default-base:99aa", { "j2.dev/kind": "sandbox", "j2.dev/instance": "inst" }],
      ["j2-sandbox-inst-default:99aa", { "j2.dev/kind": "sandbox", "j2.dev/instance": "inst" }],
    ],
  );
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
