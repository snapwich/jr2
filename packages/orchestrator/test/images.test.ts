// The read side of the image map (ADR-0037/0038/0049): the shape `j2 up` writes and every provision
// consults. Three claims worth pinning here rather than at the port — the NESTING (a user image may
// legitimately be called "harness"), the refusal to fall back onto a published tag when the map is
// missing (ADR-0027/0038's "no eject hatch" made mechanical rather than merely stated), and the
// CONTENT DIGEST that lets the host at `j2 up` and the baked Orchestrator name the same context
// without a path table.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  imageContextDigest,
  isImageContext,
  readImageRefs,
  resolveSandboxImage,
  resolveUserImage,
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
  assert.equal((await resolveSandboxImage(map)).ref, "j2-sandbox-inst-default:d00", "`default` is the user's leg");
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

/** A build context on disk: a directory whose FULL content is the image's address. */
async function mkContext(files: Record<string, string>): Promise<{ dir: string; url: string }> {
  const dir = await mkdtemp(join(tmpdir(), "j2-ctx-"));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return { dir, url: pathToFileURL(dir).href };
}

test("the two origins are told apart by SHAPE alone: a `file:` URL is a context, anything else a ref", () => {
  // Shape, not a lookup, so the CLI and the port give the same answer without sharing state. The
  // `images/<name>` dirname retired with dirname discovery (ADR-0049/0050), so a bare `ubuntu` is
  // now exactly what it looks like — a registry ref.
  assert.equal(isImageContext("file:///srv/instance/workflows/image"), true);
  assert.equal(isImageContext("ghcr.io/acme/tools:1"), false);
  assert.equal(isImageContext("acme/tools"), false);
  assert.equal(isImageContext("ubuntu"), false);
});

test("imageContextDigest: the whole directory, no exclusions — and the SAME digest from another path", async () => {
  // The claim ADR-0049 rides on: the host at `j2 up` and the baked Orchestrator hash the same tree
  // at two different absolute paths and must agree, or the digest key finds nothing.
  const files = { Dockerfile: "FROM node:24-slim\n", "dist/b.txt": "b", "node_modules/x/i.js": "x" };
  const a = await mkContext(files);
  const b = await mkContext(files);
  assert.equal(await imageContextDigest(a.dir), await imageContextDigest(b.dir), "content addresses, not paths");

  // No exclusions: that directory IS the build context and carries no `.dockerignore`, so a
  // `dist/` or `node_modules/` beside the Dockerfile is image CONTENT and must be image address.
  // Under-hashing is the silent-stale-image bug ADR-0038 exists to delete.
  const edited = await mkContext({ ...files, "dist/b.txt": "b!" });
  assert.notEqual(await imageContextDigest(a.dir), await imageContextDigest(edited.dir));
  const deeper = await mkContext({ ...files, "node_modules/x/i.js": "y" });
  assert.notEqual(await imageContextDigest(a.dir), await imageContextDigest(deeper.dir));
});

test('the recorded `USER`: `""` is DATA — the fact ADR-0037\'s fallback seat turns on', async () => {
  // Only the host that BUILT an image can see whether it declares a USER (`docker inspect` at
  // converge is free; the cluster has no such reach), so the fact travels in the map beside the
  // ref. An empty string is docker's own answer for "declares none" — never a missing value.
  const bare = await mkContext({ Dockerfile: "FROM node:24-slim\n" });
  const bareKey = await imageContextDigest(bare.dir);
  const map = refs({ sandbox: { default: "d", [bareKey]: "b" }, sandboxUser: { default: "1000", [bareKey]: "" } });

  assert.equal((await resolveSandboxImage(map, bare.url)).fallbackSeat, true, "the fallback seat");
  assert.equal((await resolveSandboxImage(map)).fallbackSeat, false, "an image that declared one needs no fallback");
  // A registry ref was never built and never inspected: its own USER stands, and a root one fails
  // the Harness container's runAsNonRoot — named at provision, never silently patched.
  assert.equal((await resolveSandboxImage(map, "ghcr.io/acme/tools:1")).fallbackSeat, false);
  // An older converge's map records nothing: "nothing known" must leave the image alone.
  assert.equal((await resolveSandboxImage(refs({ sandbox: { default: "d" } }))).fallbackSeat, false);
});

test("refusedUser: the record catches the USERs the kubelet refuses BEFORE the pod is created", async () => {
  // `runAsNonRoot` with no `runAsUser` makes the kubelet check the image's USER itself, and it
  // reads only what the manifest says — never the image's /etc/passwd. So a name it cannot resolve
  // and uid 0 both lose, and both lose as CreateContainerConfigError on the preflight init
  // container, which therefore has NO logs: the only symptom is the provision's Ready timeout.
  // Only a BUILT image is knowable, and the converge already recorded the string.
  const cases: Record<string, string> = {
    app: "dev",
    root: "root",
    zero: "0",
    ok: "1000",
    pair: "1000:2000",
    bare: "",
  };
  const ctx: Record<string, { url: string; key: string }> = {};
  for (const which of Object.keys(cases)) {
    const made = await mkContext({ Dockerfile: `FROM node:24-slim\n# ${which}\n` });
    ctx[which] = { url: made.url, key: await imageContextDigest(made.dir) };
  }
  const sandbox: Record<string, string> = {};
  const sandboxUser: Record<string, string> = {};
  for (const [which, user] of Object.entries(cases)) {
    sandbox[ctx[which]!.key] = `ref-${which}`;
    sandboxUser[ctx[which]!.key] = user;
  }
  const map = refs({ sandbox, sandboxUser });
  const refused = async (which: string) => (await resolveSandboxImage(map, ctx[which]!.url)).refusedUser;

  assert.equal(await refused("app"), "dev", "a name the kubelet cannot prove is non-root");
  assert.equal(await refused("root"), "root");
  assert.equal(await refused("zero"), "0", "uid 0 spelled numerically is still root");
  assert.equal(await refused("ok"), undefined);
  assert.equal(await refused("pair"), undefined, "docker records `uid:gid`; only the uid half is judged");
  // `""` is the fallback's trigger, not a failure — ADR-0037 supplies uid 1000 and a writable HOME.
  assert.equal(await refused("bare"), undefined);
  // Unknowable cases answer undefined and let the pod learn the hard way: a registry ref was never
  // inspected, and an older converge's map recorded nothing at all.
  assert.equal((await resolveSandboxImage(map, "ghcr.io/acme/tools:1")).refusedUser, undefined);
  assert.equal((await resolveSandboxImage(refs({ sandbox: { default: "d" } }))).refusedUser, undefined);
  // An absent image reads the same reserved `default` leg the ref came from.
  const dflt = refs({ sandbox: { default: "d" }, sandboxUser: { default: "root" } });
  assert.equal((await resolveSandboxImage(dflt)).refusedUser, "root");
});

test("resolveSandboxImage walks ADR-0037's chain: the wrapper's context → images/default → the stock Harness", async () => {
  const shipped = await mkContext({ Dockerfile: "FROM golang:1.23\n" });
  const key = await imageContextDigest(shipped.dir);
  const full = refs({ sandbox: { default: "d", [key]: "g" } });
  assert.equal((await resolveSandboxImage(full, shipped.url)).ref, "g", "the context the Machine carries");
  assert.equal((await resolveSandboxImage(full)).ref, "d", "no image named → the Instance's images/default");
  assert.equal((await resolveSandboxImage(refs())).ref, "j2-harness:h00", "no images/default → stock");
  // The last leg reads the MAP: in a kit checkout the Harness is content-addressed (ADR-0038).
  assert.equal((await resolveSandboxImage(refs({ harness: "j2-harness:abc123" }))).ref, "j2-harness:abc123");
});

test("a context the last converge did not build fails at provision, naming `j2 up`", async () => {
  // The stale-deployment case: the Orchestrator's own node_modules holds a context whose digest is
  // in no map. A converge-time check cannot exist for this (the map IS what a converge writes), so
  // provision is the first honest moment — before a Secret or a CR is applied.
  const shipped = await mkContext({ Dockerfile: "FROM golang:1.23\n" });
  await assert.rejects(
    () => resolveSandboxImage(refs({ sandbox: { default: "d" } }), shipped.url),
    (err: Error) => {
      assert.match(err.message, /no Sandbox Image for file:/);
      assert.match(err.message, /context digest [0-9a-f]{12}/);
      assert.match(err.message, /j2 up/, "names the fix");
      return true;
    },
  );
});

test("a context the Orchestrator's bundle does not hold names the path, not a cluster fault", async () => {
  // A packaging bug, not a converge one: a `file:` image must travel WITH its module.
  await assert.rejects(
    () => resolveSandboxImage(refs(), pathToFileURL(join(tmpdir(), "j2-no-such-context")).href),
    (err: Error) => {
      assert.match(err.message, /cannot be read/);
      assert.match(err.message, /j2-no-such-context/);
      assert.match(err.message, /node_modules/, "names where it must have travelled to");
      return true;
    },
  );
});

test("a registry ref passes through VERBATIM — deployed, never built, never in the map", async () => {
  // ADR-0037's second origin: j2 never built it, so there is no ref to look up and nothing to say
  // about its tag discipline. It is also why an empty map is no obstacle to a ref.
  const map = refs({ sandbox: { default: "d" } });
  assert.equal(
    (await resolveSandboxImage(map, "ghcr.io/acme/toolchain:2024-11")).ref,
    "ghcr.io/acme/toolchain:2024-11",
  );
  assert.equal((await resolveSandboxImage(refs(), "acme/tools")).ref, "acme/tools", "no build map needed at all");
  assert.equal(await resolveUserImage(refs(), "ghcr.io/acme/sshd:1"), "ghcr.io/acme/sshd:1");
});

test("resolveUserImage: the SAME resolution as the Sandbox Image, and no fallback chain", async () => {
  // ADR-0005 gives the User Container the same resolution deliberately — one string, two origins.
  // What it does NOT get is a default: absence means the pod has no third container, so there is
  // nothing for a default to be, and a j2-chosen one would be an opinion in the one seat that
  // promises none. (Absence is unstatable here: the option is simply not passed.)
  const sshd = await mkContext({ Dockerfile: "FROM debian:12\n" });
  const key = await imageContextDigest(sshd.dir);
  assert.equal(await resolveUserImage(refs({ sandbox: { [key]: "s" } }), sshd.url), "s");
  await assert.rejects(
    () => resolveUserImage(refs({ sandbox: { default: "d" } }), sshd.url),
    /no User Container image for file:/,
  );
});
