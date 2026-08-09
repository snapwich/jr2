// The instance-image build seam (ADR-0019). The staleness key is a content address of the BUNDLE
// — what actually goes into the image, kit included — so these tests pin the one property that
// makes it usable as a cache key at all: the same sources must hash the same, every time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sandboxWrapDockerfile, stageInstanceBundle, type BuildPort } from "../src/build.ts";

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
    push: async () => {},
    kindLoad: async () => {},
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
  const wrap = sandboxWrapDockerfile("j2-workspace-inst-default-base:abc123", "j2-harness:9f1e02c4d5a6");

  assert.match(wrap, /^FROM j2-workspace-inst-default-base:abc123$/m);
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
