// `jr2 kit push <registry>` (ADR-0044): the installed self-hoster's mirror. No registry is ever
// touched here — the whole command is decidable from the argv it hands docker, so the seam records
// invocations and decides which refs "resolve". Three claims: a present tag is skipped (published
// version tags never move, so present implies current), an absent one is copied with
// `imagetools create` (a manifest-list copy — NOT pull/push, which would flatten multi-arch), and a
// source the home does not have fails loudly enough to name both ends.

import { test } from "node:test";
import assert from "node:assert/strict";
import { KIT_VERSION } from "@jr2/orchestrator";
import { main } from "../src/cli.ts";
import { kit, type RunDocker } from "../src/commands/kit.ts";
import { publishedKitRefs } from "../src/build.ts";
import type { Io } from "../src/output.ts";

/** cwd "/" and an empty env on purpose: the command is instance-less (ADR-0044), so it must run
 * from outside any instance folder, with no kube context and no `jr2.config.ts` above it. */
function mkIo(): { io: Io; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, cwd: "/" },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

/** The docker seam: `present` is what the registries hold, so an `imagetools inspect` of anything
 * else rejects the way the real CLI does on an unresolvable ref. */
function mkDocker(present: string[] = []): { calls: string[][]; docker: RunDocker } {
  const holds = new Set(present);
  const calls: string[][] = [];
  const docker: RunDocker = async (args) => {
    calls.push(args);
    if (args[2] === "inspect" && !holds.has(args[3]!)) throw new Error(`${args[3]}: not found`);
    if (args[2] === "create") holds.add(args[4]!);
  };
  return { calls, docker };
}

// Both ends are the deployment's own vocabulary: bare, `publishedKitRefs` is the canonical home;
// with a registry, it is what `kitRegistry: reg.example.com` makes a converge pull (ADR-0044). The
// literals below are the claim that the mirror writes exactly those addresses.
const sources = publishedKitRefs();
const targets = publishedKitRefs("reg.example.com");

test("the mirror's ends are the home and the kitRegistry re-homing of it", () => {
  assert.deepEqual(targets, {
    harness: `reg.example.com/jr2-harness:${KIT_VERSION}`,
    adapter: `reg.example.com/jr2-adapter:${KIT_VERSION}`,
    operator: `reg.example.com/jr2-operator:${KIT_VERSION}`,
  });
  assert.ok(
    Object.values(sources).every((ref) => ref.startsWith("ghcr.io/snapwich/")),
    "the source is the canonical home, never a bare name a node would resolve to docker.io",
  );
});

test("an absent tag is copied registry-to-registry, never pulled and pushed", async () => {
  // `imagetools create` copies the full manifest list (every platform, exact digests) with no bytes
  // on this host. `docker pull` + `docker push` would flatten the image to the host's platform and
  // ship an amd64-only Harness to an arm64 cluster — so the argv IS the decision, not a detail.
  const { calls, docker } = mkDocker(Object.values(sources));
  const { io, out, err } = mkIo();

  assert.equal(await kit(["push", "reg.example.com"], io, docker), 0);
  assert.deepEqual(
    calls.filter((c) => c[2] === "create"),
    [
      ["buildx", "imagetools", "create", "-t", targets.harness, sources.harness],
      ["buildx", "imagetools", "create", "-t", targets.adapter, sources.adapter],
      ["buildx", "imagetools", "create", "-t", targets.operator, sources.operator],
    ],
    "all three kit images, canonical home → target",
  );
  assert.ok(
    !calls.some((c) => c[0] === "pull" || c[0] === "push"),
    "a daemon-side pull/push would flatten the manifest list",
  );
  assert.match(err(), /mirrored 3 image\(s\), 0 already present/);

  // The one machine-readable line names what a `kitRegistry` should now be set to.
  assert.deepEqual(JSON.parse(out()), { registry: "reg.example.com", version: KIT_VERSION, images: targets });
});

test("a tag already in the target is skipped — a published version tag never moves", async () => {
  // Present implies current (ADR-0044), so the skip costs one inspect and no transfer. The target is
  // asked FIRST, which is what makes the repeat run cheap.
  const { calls, docker } = mkDocker([...Object.values(sources), targets.harness, targets.adapter, targets.operator]);
  const { io, err } = mkIo();

  assert.equal(await kit(["push", "reg.example.com"], io, docker), 0);
  assert.deepEqual(
    calls,
    [
      ["buildx", "imagetools", "inspect", targets.harness],
      ["buildx", "imagetools", "inspect", targets.adapter],
      ["buildx", "imagetools", "inspect", targets.operator],
    ],
    "the target is inspected, and nothing else happens",
  );
  assert.match(err(), /harness: already present/);
  assert.match(err(), /mirrored 0 image\(s\), 3 already present/);
});

test("a partly-filled registry copies only what is missing", async () => {
  const { calls, docker } = mkDocker([...Object.values(sources), targets.harness]);
  const { io, err } = mkIo();

  assert.equal(await kit(["push", "reg.example.com"], io, docker), 0);
  assert.deepEqual(
    calls.filter((c) => c[2] === "create").map((c) => c[4]),
    [targets.adapter, targets.operator],
  );
  assert.match(err(), /mirrored 2 image\(s\), 1 already present/);
});

test("a source the home does not hold fails by name, pointing at the checkout-side seeder", async () => {
  // The common dev case: nothing is published at a dev version, and nothing ever will be. So the
  // failure must not read as a broken mirror — it names both registries and sends the reader to
  // `just kit-push`, the arm of ADR-0044 that actually builds images from a kit checkout.
  const { calls, docker } = mkDocker([]);
  const { io } = mkIo();

  await assert.rejects(
    () => kit(["push", "reg.example.com"], io, docker),
    (thrown: Error) => {
      const source = sources.harness.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(thrown.message, new RegExp(source), "names the source");
      assert.match(thrown.message, /reg\.example\.com\/jr2-harness/, "names the target");
      assert.match(thrown.message, /just kit-push/, "names the checkout-side seeder");
      return true;
    },
  );
  assert.ok(!calls.some((c) => c[2] === "create"), "nothing is copied once the source is known to be missing");
});

test("a trailing slash on the registry is not a second slash in the ref", async () => {
  const { calls, docker } = mkDocker(Object.values(sources));
  assert.equal(await kit(["push", "reg.example.com/"], mkIo().io, docker), 0);
  assert.equal(calls.find((c) => c[2] === "create")?.[4], targets.harness);
});

test("`kit` is a verb of the binary, and reaches no cluster to be one", async () => {
  // Dispatch only — the subcommand-less form returns before docker exists, so this asserts the wire
  // without spawning anything. That it works from cwd "/" with an empty env is the instance-less
  // claim: no `jr2.config.ts` resolve, no kube context, no namespace.
  const { io, err } = mkIo();
  assert.equal(await main(["kit"], io), 2);
  assert.match(err(), /usage: jr2 kit push <registry>/);
});

test("usage errors exit 2 and spend nothing", async () => {
  for (const args of [[], ["push"], ["pull", "reg.example.com"]]) {
    const { calls, docker } = mkDocker();
    const { io, err } = mkIo();
    assert.equal(await kit(args, io, docker), 2, `\`jr2 kit ${args.join(" ")}\` is a usage error`);
    assert.deepEqual(calls, [], "docker is never spawned for a malformed command line");
    assert.match(err(), /usage: jr2 kit push <registry>/);
  }
});
