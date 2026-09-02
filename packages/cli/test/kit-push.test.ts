// The checkout arm of ADR-0044 is a shell script (`just kit-push` → scripts/kit-push.sh), because
// the build needs the whole repo and the binary's arm is a mirror that builds nothing. That leaves
// the same three images described in two places: `KIT_IMAGES` here, for what `j2 up` builds from a
// checkout at content-addressed tags, and the script's own table, for what a release pushes at the
// published ones.
//
// Two lists, one truth — and a hand-kept second copy desynchronizes silently, which is the whole
// failure class ADR-0038's over-hashing rule exists to delete. So the copy is asserted rather than
// commented at: a Dockerfile that moves, an image that is added, a context that changes fails the
// default gate here, seconds after the edit, instead of on a release push nobody watches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_IMAGES, type KitImageName } from "../src/build.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** The script's `images=( … )` block, one `repo|dockerfile|context` row per line. Parsed as data
 * rather than executed: this suite is socket-free and shell-free (ADR-0010). */
async function scriptImages(): Promise<string[][]> {
  const script = await readFile(join(REPO, "scripts", "kit-push.sh"), "utf8");
  const block = /^images=\(\n([\s\S]*?)^\)$/m.exec(script);
  assert.ok(block, "scripts/kit-push.sh declares its images as an `images=( … )` array");
  return block[1]!
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("|"));
}

test("kit-push.sh pushes exactly the images j2 up builds, from the same files", async () => {
  const expected = (Object.keys(KIT_IMAGES) as KitImageName[]).map((name) => [
    KIT_IMAGES[name].repo,
    KIT_IMAGES[name].dockerfile,
    KIT_IMAGES[name].context,
  ]);
  assert.deepEqual(await scriptImages(), expected);
});

test("kit-push.sh tags at <registry>/<repo>:<version>, read from the manifests", async () => {
  const script = await readFile(join(REPO, "scripts", "kit-push.sh"), "utf8");
  // The published name an INSTALLED kit resolves is `<kitRegistry>/<repo>:<kitversion>`
  // (`publishedKitRefs`), so the push must compose the same three parts — a script that invented a
  // `-latest` or dropped the registry would put the bytes where nothing looks.
  assert.match(script, /tag="\$registry\/\$repo:\$version"/);
  // Read from the manifests, never written down: the version is the release train (ADR-0019), and
  // a literal here would go stale at exactly the moment it matters.
  assert.match(script, /packages\/cli\/package\.json/);
  assert.doesNotMatch(script, /^version="[0-9]/m);
});
