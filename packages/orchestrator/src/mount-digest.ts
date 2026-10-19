// What a mounted ConfigMap holds, as one digest (ADR-0038, ADR-0069). A publish rolls no pod, so
// the Orchestrator reads `jr2-images` and `jr2-held` through mounts the kubelet refreshes on its
// own period. `jr2 up` digests the data it applied, `GET /assembly` reports the digest of what the
// process reads, and the publish waits until the two agree. Then the door's checks, and the
// provisions that follow the converge, read the data this converge wrote.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HELD_CONFIGMAP, HELD_MOUNT, IMAGES_CONFIGMAP, IMAGES_MOUNT } from "./names.ts";

/** The ConfigMaps the Orchestrator reads through a mount, by name, and where each is mounted. */
export const MOUNTED_CONFIGMAPS: Readonly<Record<string, string>> = {
  [IMAGES_CONFIGMAP]: IMAGES_MOUNT,
  [HELD_CONFIGMAP]: HELD_MOUNT,
};

/** One digest of a ConfigMap's `data`: the same bytes give the same digest at both ends. */
export function configMapDigest(data: Readonly<Record<string, string>>): string {
  const entries = Object.keys(data)
    .sort()
    .map((key) => [key, data[key]]);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 16);
}

/**
 * The digest of a mounted ConfigMap, read from its mount (ADR-0069). The kubelet writes each key
 * as a file and keeps its own entries under names that start with `.`, which are not data. An
 * absent mount reads as `undefined`.
 */
export async function readMountDigest(dir: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const data: Record<string, string> = {};
  for (const name of names.filter((n) => !n.startsWith("."))) data[name] = await readFile(join(dir, name), "utf8");
  return configMapDigest(data);
}

/** Every mounted ConfigMap's digest, by name; a mount that is absent is left out. */
export async function readMountDigests(
  mounts: Readonly<Record<string, string>> = MOUNTED_CONFIGMAPS,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, dir] of Object.entries(mounts)) {
    const digest = await readMountDigest(dir);
    if (digest !== undefined) out[name] = digest;
  }
  return out;
}
