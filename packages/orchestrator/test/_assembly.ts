// Publishing a fixture Assembly in-process (ADR-0069). The door is the one way in: there is no
// folder boot, so a test copies a tree into a staging directory and calls the door's `admit`,
// which writes the real layout and the real pointer. A tree that imports bare names must sit
// under this package, where `xstate` and `@jr2/orchestrator` resolve: `scratchInstance` makes
// such a folder, outside tsconfig's `src`/`test` globs.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assembliesDir, type PublishAnswer } from "../src/assembly.ts";
import { KIT_VERSION } from "../src/config.ts";
import { assemblyHash } from "../src/content-hash.ts";
import type { RunningInstance } from "../src/instance.ts";

/** This package's root: a scratch folder here resolves the package's own dependencies. */
export const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The bootstrap suite's fixture tree (`workflows/echo.ts`). */
export const FIXTURE_ASSEMBLY = join(PKG_DIR, "test", "fixtures", "instance");

/** A fresh instance folder under this package, named `.<prefix>-*`. */
export function scratchInstance(prefix = "inst"): Promise<string> {
  return mkdtemp(join(PKG_DIR, `.${prefix}-`));
}

/** A tree as a source folder, or as files by relative path. */
export type TreeSource = string | Record<string, string>;

/** Copy `src` into a new staging directory of `dir`'s Assembly store, as an unpack would leave it:
 * `<staging>/tree`. Returns the staging directory and the tree's hash. */
export async function stageTree(dir: string, src: TreeSource): Promise<{ staging: string; hash: string }> {
  const staging = join(assembliesDir(dir), `.staging-test-${randomBytes(4).toString("hex")}`);
  const tree = join(staging, "tree");
  await mkdir(tree, { recursive: true });
  if (typeof src === "string") await cp(src, tree, { recursive: true });
  else {
    for (const [rel, text] of Object.entries(src)) {
      await mkdir(dirname(join(tree, rel)), { recursive: true });
      await writeFile(join(tree, rel), text);
    }
  }
  return { staging, hash: await assemblyHash(tree) };
}

/** Admit `src` through `inst`'s door. Returns the door's answer. */
export async function admitTree(inst: RunningInstance, dir: string, src: TreeSource): Promise<PublishAnswer> {
  const { staging, hash } = await stageTree(dir, src);
  return inst.admit(staging, { hash, kitVersion: KIT_VERSION });
}

/** Admit `src` and require it to land. Returns its hash. */
export async function publishTree(inst: RunningInstance, dir: string, src: TreeSource): Promise<string> {
  const answer = await admitTree(inst, dir, src);
  assert.equal(answer.status, 200, `the fixture Assembly was refused: ${JSON.stringify(answer.body)}`);
  return answer.body.hash as string;
}
