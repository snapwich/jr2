// The mounted ConfigMap digests (ADR-0069): the digest `jr2 up` computes over the data it applied
// equals the one the Orchestrator reads from the kubelet's mount, and `GET /assembly` reports it,
// so a publish can wait for the kubelet instead of reading a stale mount.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunHost } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { configMapDigest, readMountDigest, readMountDigests } from "../src/mount-digest.ts";
import { mkStore } from "./_fixtures.ts";

/** A ConfigMap mount the way the kubelet writes one: a timestamped dir, `..data`, a link per key. */
async function kubeletMount(data: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jr2-mount-"));
  const stamp = "..2026_10_18_00_00_00.1";
  await mkdir(join(dir, stamp));
  for (const [key, value] of Object.entries(data)) await writeFile(join(dir, stamp, key), value);
  await symlink(stamp, join(dir, "..data"));
  for (const key of Object.keys(data)) await symlink(join("..data", key), join(dir, key));
  return dir;
}

test("a kubelet mount reads as the digest of the data applied", async () => {
  const data = { "images.json": '{"harness":"h"}', "held-a.json": "{}" };
  const dir = await kubeletMount(data);
  try {
    assert.equal(await readMountDigest(dir), configMapDigest(data));
    assert.notEqual(await readMountDigest(dir), configMapDigest({ ...data, "held-b.json": "{}" }));
    assert.equal(await readMountDigest(join(dir, "absent")), undefined);
    assert.deepEqual(await readMountDigests({ "jr2-held": dir, "jr2-images": join(dir, "absent") }), {
      "jr2-held": configMapDigest(data),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the digest does not depend on key order", () => {
  assert.equal(configMapDigest({ a: "1", b: "2" }), configMapDigest({ b: "2", a: "1" }));
});

test("GET /assembly reports the mount digests when the process has mounts, and none otherwise", async () => {
  const host = new RunHost({ store: await mkStore() });
  const mounted = await createApp(host, undefined, { mounts: async () => ({ "jr2-images": "abc" }) }).request(
    "/assembly",
  );
  assert.deepEqual(((await mounted.json()) as { mounts?: unknown }).mounts, { "jr2-images": "abc" });
  const bare = await createApp(host).request("/assembly");
  assert.equal(((await bare.json()) as { mounts?: unknown }).mounts, undefined);
  await host.close();
});
