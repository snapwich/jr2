// The read side of the image map (ADR-0037/0038): the shape `j2 up` writes and every provision
// consults. Two claims worth pinning here rather than at the port — the NESTING (a user image may
// legitimately be called "harness") and the refusal to fall back onto a published tag when the map
// is missing, which is ADR-0027/0038's "no eject hatch" made mechanical rather than merely stated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readImageRefs, resolveSandboxImage, type ImageRefs } from "../src/images.ts";

async function mkMap(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "j2-imgmap-"));
  const path = join(dir, "images.json");
  await writeFile(path, body);
  return path;
}

const refs = (over: Partial<ImageRefs> = {}): ImageRefs => ({
  harness: "j2-harness:h00",
  adapter: "j2-adapter:a00",
  sandbox: {},
  ...over,
});

test("the map is nested, so a user image named `harness` cannot collide with the kit's", async () => {
  // `images/harness/Dockerfile` is a perfectly legal name for someone's toolchain, and
  // `images/default` is a name ADR-0037 hands out itself — a flat map would let either shadow a
  // kit ref, which is why user images live under `sandbox`.
  const path = await mkMap(
    JSON.stringify({
      harness: "j2-harness:h00",
      adapter: "j2-adapter:a00",
      sandbox: { harness: "j2-sandbox-inst-harness:u00", default: "j2-sandbox-inst-default:d00" },
    }),
  );
  const map = await readImageRefs(path);
  assert.equal(map.harness, "j2-harness:h00", "the kit's stock Harness is untouched");
  assert.equal(resolveSandboxImage(map, "harness"), "j2-sandbox-inst-harness:u00", "the user's image wins its name");
});

test("readImageRefs: an absent map names the path and `j2 up`, and never falls back to a tag", async () => {
  await assert.rejects(
    () => readImageRefs("/nope/j2/images.json"),
    (err: Error) => {
      assert.match(err.message, /\/nope\/j2\/images\.json/);
      assert.match(err.message, /j2 up/);
      // A `j2-harness:<kitversion>` fallback would name a tag a kit checkout never built — and
      // would be exactly the escape hatch ADR-0027/0038 refuse.
      assert.doesNotMatch(err.message, /j2-harness:/);
      return true;
    },
  );
});

test("readImageRefs: unparseable or malformed content is loud, never a partial map", async () => {
  const rejects = async (body: unknown, message: RegExp): Promise<void> => {
    const path = await mkMap(typeof body === "string" ? body : JSON.stringify(body));
    await assert.rejects(() => readImageRefs(path), message);
  };
  await rejects("not json at all", /is not JSON/);
  await rejects(["a"], /expected a JSON object/);
  await rejects({ adapter: "a", sandbox: {} }, /no `harness` ref/);
  // An Agent with no Adapter has no route to its Machine at all (ADR-0013), so this is required.
  await rejects({ harness: "h", sandbox: {} }, /no `adapter` ref/);
  await rejects({ harness: "h", adapter: "a", sandbox: { x: 7 } }, /`sandbox\.x` is not a ref/);
});

test("readImageRefs: a map with no Sandbox Images reads as an empty set, not an error", async () => {
  // The scaffolded, workspace-less instance: `j2 up` builds no Sandbox Image when `repos` is empty.
  const map = await readImageRefs(await mkMap(JSON.stringify({ harness: "h", adapter: "a" })));
  assert.deepEqual(map, { harness: "h", adapter: "a", sandbox: {} });
});

test("resolveSandboxImage walks ADR-0037's chain: spec name → default → the stock Harness", () => {
  const full = refs({ sandbox: { default: "d", rust: "r" } });
  assert.equal(resolveSandboxImage(full, "rust"), "r");
  assert.equal(resolveSandboxImage(full), "d");
  assert.equal(resolveSandboxImage(refs()), "j2-harness:h00", "no images/default → stock");
  // The last leg reads the MAP: in a kit checkout the Harness is content-addressed (ADR-0038).
  assert.equal(resolveSandboxImage(refs({ harness: "j2-harness:abc123" })), "j2-harness:abc123");
});

test("resolveSandboxImage: an unknown name throws, listing what the converge discovered", () => {
  assert.throws(
    () => resolveSandboxImage(refs({ sandbox: { default: "d", rust: "r" } }), "golang"),
    (err: Error) => {
      assert.match(err.message, /no Sandbox Image named "golang"/);
      assert.match(err.message, /"default", "rust"/);
      assert.match(err.message, /images\/golang\/Dockerfile/, "names the fix");
      return true;
    },
  );
  assert.throws(() => resolveSandboxImage(refs(), "golang"), /built none/);
});
