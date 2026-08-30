// The read side of the image map (ADR-0037/0038): the shape `j2 up` writes and every provision
// consults. Two claims worth pinning here rather than at the port — the NESTING (a user image may
// legitimately be called "harness") and the refusal to fall back onto a published tag when the map
// is missing, which is ADR-0027/0038's "no eject hatch" made mechanical rather than merely stated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declaresNoUser,
  isRegistryRef,
  readImageRefs,
  resolveSandboxImage,
  resolveUserImage,
  unrunnableUser,
  type ImageRefs,
} from "../src/images.ts";

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
  // `images/harness/Dockerfile` is a perfectly legal name for someone's Sandbox Image, and
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
  await rejects({ harness: "h", adapter: "a", sandboxUser: { x: 7 } }, /`sandboxUser\.x` is not a USER/);
});

test("readImageRefs: a map with no Sandbox Images reads as an empty set, not an error", async () => {
  // The scaffolded, workspace-less instance: `j2 up` builds no Sandbox Image when `repos` is empty.
  const map = await readImageRefs(await mkMap(JSON.stringify({ harness: "h", adapter: "a" })));
  assert.deepEqual(map, { harness: "h", adapter: "a", sandbox: {}, sandboxUser: {} });
});

test('declaresNoUser: `""` is DATA — the recorded fact ADR-0037\'s fallback turns on', async () => {
  // Only the host that BUILT an image can see whether it declares a USER (`docker inspect` at
  // converge is free; the cluster has no such reach), so the fact travels in the map beside the
  // ref. An empty string is docker's own answer for "declares none" — never a missing value.
  const map = await readImageRefs(
    await mkMap(
      JSON.stringify({
        harness: "h",
        adapter: "a",
        sandbox: { default: "d", rust: "r", bare: "b" },
        sandboxUser: { default: "1000", rust: "app", bare: "" },
      }),
    ),
  );
  assert.equal(declaresNoUser(map, "bare"), true, "the fallback seat");
  assert.equal(declaresNoUser(map, "rust"), false, "an image that declared something needs no fallback");
  assert.equal(declaresNoUser(map, "default"), false);
  assert.equal(declaresNoUser(map), false, "absent name reads the same leg the ref came from");
  // A registry ref was never built and never inspected: its own USER stands, and a root one fails
  // the Harness container's runAsNonRoot — named at provision, never silently patched.
  assert.equal(declaresNoUser(map, "ghcr.io/acme/tools:1"), false);
  // An older converge's map records nothing: "nothing known" must leave the image alone.
  assert.equal(declaresNoUser(refs({ sandbox: { default: "d" } })), false);
});

test("unrunnableUser: the record catches the USERs the kubelet refuses BEFORE the pod is created", () => {
  // `runAsNonRoot` with no `runAsUser` makes the kubelet check the image's USER itself, and it
  // reads only what the manifest says — never the image's /etc/passwd. So a name it cannot resolve
  // and uid 0 both lose, and both lose as CreateContainerConfigError on the preflight init
  // container, which therefore has NO logs: the only symptom is the provision's Ready timeout.
  // Only a BUILT image is knowable, and the converge already recorded the string.
  const map = refs({
    sandbox: { app: "a", root: "r", zero: "z", ok: "o", pair: "p", bare: "b", def: "d", default: "dd" },
    sandboxUser: { app: "dev", root: "root", zero: "0", ok: "1000", pair: "1000:2000", bare: "", def: "1" },
  });
  assert.equal(unrunnableUser(map, "app"), "dev", "a name the kubelet cannot prove is non-root");
  assert.equal(unrunnableUser(map, "root"), "root");
  assert.equal(unrunnableUser(map, "zero"), "0", "uid 0 spelled numerically is still root");
  assert.equal(unrunnableUser(map, "ok"), undefined);
  assert.equal(unrunnableUser(map, "pair"), undefined, "docker records `uid:gid`; only the uid half is judged");
  // `""` is the fallback's trigger, not a failure — ADR-0037 supplies uid 1000 and a writable HOME.
  assert.equal(unrunnableUser(map, "bare"), undefined);
  // Unknowable cases answer undefined and let the pod learn the hard way: a registry ref was never
  // inspected, and an older converge's map recorded nothing at all.
  assert.equal(unrunnableUser(map, "ghcr.io/acme/tools:1"), undefined);
  assert.equal(unrunnableUser(refs({ sandbox: { default: "d" } }), "default"), undefined);
  // An absent name reads the same `default` leg the ref came from.
  assert.equal(unrunnableUser(refs({ sandbox: { default: "d" }, sandboxUser: { default: "root" } })), "root");
});

test("resolveSandboxImage walks ADR-0037's chain: spec name → default → the stock Harness", () => {
  const full = refs({ sandbox: { default: "d", rust: "r" } });
  assert.equal(resolveSandboxImage(full, "rust"), "r");
  assert.equal(resolveSandboxImage(full), "d");
  assert.equal(resolveSandboxImage(refs()), "j2-harness:h00", "no images/default → stock");
  // The last leg reads the MAP: in a kit checkout the Harness is content-addressed (ADR-0038).
  assert.equal(resolveSandboxImage(refs({ harness: "j2-harness:abc123" })), "j2-harness:abc123");
});

test("resolveSandboxImage: an unknown DIRNAME throws, listing what the converge discovered", () => {
  assert.throws(
    () => resolveSandboxImage(refs({ sandbox: { default: "d", rust: "r" } }), "golang"),
    (err: Error) => {
      assert.match(err.message, /no Sandbox Image named "golang"/);
      assert.match(err.message, /"default", "rust"/);
      assert.match(err.message, /images\/golang\/Dockerfile/, "names the fix");
      assert.match(err.message, /registry ref/, "names the OTHER origin too");
      return true;
    },
  );
  assert.throws(() => resolveSandboxImage(refs(), "golang"), /built none/);
});

test("the two origins are told apart by SHAPE alone: a ref has `/` or `:`, a dirname has neither", () => {
  // Shape, not a lookup, so the CLI and the port give the same answer without sharing state — and
  // a bare `ubuntu` reads as a DIRNAME, which is the safe direction: it fails naming what was
  // discovered instead of silently pulling a stranger's `:latest`.
  assert.equal(isRegistryRef("ghcr.io/acme/tools:1"), true);
  assert.equal(isRegistryRef("acme/tools"), true);
  assert.equal(isRegistryRef("tools:1"), true);
  assert.equal(isRegistryRef("rust"), false);
  assert.equal(isRegistryRef("ubuntu"), false);
});

test("a registry ref passes through VERBATIM — deployed, never built, never in the map", () => {
  // ADR-0037's second origin: j2 never built it, so there is no ref to look up and nothing to say
  // about its tag discipline. It is also why an empty map is no obstacle to a ref.
  const map = refs({ sandbox: { default: "d" } });
  assert.equal(resolveSandboxImage(map, "ghcr.io/acme/toolchain:2024-11"), "ghcr.io/acme/toolchain:2024-11");
  assert.equal(resolveSandboxImage(refs(), "acme/tools"), "acme/tools", "no build map needed at all");
  assert.equal(resolveUserImage(refs(), "ghcr.io/acme/sshd:1"), "ghcr.io/acme/sshd:1");
});

test("resolveUserImage: the SAME resolution as the Sandbox Image, and no fallback chain", () => {
  // ADR-0005 gives the User Container the same resolution deliberately — one string, two origins.
  // What it does NOT get is a default: absence means the pod has no third container, so there is
  // nothing for a default to be, and a j2-chosen one would be an opinion in the one seat that
  // promises none.
  const map = refs({ sandbox: { default: "d", rust: "r" } });
  assert.equal(resolveUserImage(map, "rust"), "r");
  assert.throws(
    () => resolveUserImage(map, "golang"),
    (err: Error) => {
      assert.match(err.message, /no User Container image named "golang"/);
      assert.match(err.message, /"default", "rust"/);
      return true;
    },
  );
});
