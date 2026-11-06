// What a mounted ConfigMap or digests Secret holds, as one digest (ADR-0038, ADR-0069, ADR-0078). A
// write to one rolls no pod, so the Orchestrator reads `jr2-images`, `jr2-held` and the two digests
// Secrets through mounts that the kubelet refreshes on its own period. `jr2 up` digests the data it
// applied, `GET /assembly` reports the digest of what the process reads, and `jr2 up` waits until
// the two agree. Then the door's checks and the provisions after the converge read the data that
// this converge wrote, and a Caller token or a Hook secret that it wrote works.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CALLER_DIGESTS_KEY,
  CALLER_DIGESTS_SECRET,
  HELD_CONFIGMAP,
  HELD_MOUNT,
  HOOK_DIGESTS_KEY,
  HOOK_DIGESTS_SECRET,
  IMAGES_CONFIGMAP,
  IMAGES_MOUNT,
} from "./names.ts";

/** The ConfigMaps the Orchestrator reads through a mount, by name, and where each is mounted. */
export const MOUNTED_CONFIGMAPS: Readonly<Record<string, string>> = {
  [IMAGES_CONFIGMAP]: IMAGES_MOUNT,
  [HELD_CONFIGMAP]: HELD_MOUNT,
};

/**
 * The digests Secrets (ADR-0078), by name, and the key of each. For these, `GET /assembly` reports
 * the digest of the file content that the process LOADED (`watchCallerDigests`), not of the file:
 * the authenticator and the Hook door use what is loaded, and the poll can be some seconds behind
 * the file. The content is digests of tokens, never a value.
 */
export const DIGEST_SECRETS: Readonly<Record<string, string>> = {
  [CALLER_DIGESTS_SECRET]: CALLER_DIGESTS_KEY,
  [HOOK_DIGESTS_SECRET]: HOOK_DIGESTS_KEY,
};

/** One digest of a mounted object's `data`: the same bytes give the same digest at both ends. */
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

/** The digest of what each digests Secret's watcher has loaded, by name (ADR-0078). A Secret with
 * no watcher, or whose file was not read, is left out, as an absent mount is. */
export function loadedDigests(
  watched: Readonly<Record<string, { loaded(): string | undefined } | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, watcher] of Object.entries(watched)) {
    const digest = watcher?.loaded();
    if (digest !== undefined) out[name] = digest;
  }
  return out;
}
