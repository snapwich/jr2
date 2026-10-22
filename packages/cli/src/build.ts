// The image build seam (ADR-0019/0038): `jr2 up` builds EVERY image it deploys. There are two
// kinds — the Instance's Sandbox Images (the `file:` docker contexts its Machines carry,
// ADR-0037/0049), and — only when the CLI is running out of a kit CHECKOUT — the Kit images: the
// Harness, the operator and the Orchestrator (ADR-0069). An Instance produces no image of its own:
// its Workflows ride the Assembly `jr2 up` publishes (assembly.ts). Installed from npm the kit
// sources do not resolve, so a real instance takes the published-`<kitversion>` path and never
// needs docker for them. The checkout IS the signal: no flag, no config key, no env. One image is
// deployed and never built, in either world: the Custodian's, upstream Envoy pinned by digest
// (ADR-0038, ADR-0059).
//
// Every tag is a content address of its own inputs. That is what makes `imagePullPolicy:
// IfNotPresent` correct rather than lucky (a unique tag per content means "present" implies
// "current"), what lets a converge skip exactly what has not moved, and what makes the tag-equality
// check in `verifyRunningImage` sound for every layer.
//
// A Sandbox Image is ONE `docker build` of the user's own Dockerfile straight to its content tag
// (ADR-0037): no kit-owned second stage, no intermediate tag, and the resolved harness ref is NOT
// one of its hash inputs. The Harness arrives at POD time instead — every Sandbox mounts the kit's
// harness image as an `image` volume at `/opt/jr2` — so the runtime's version rides the volume, a kit
// edit re-images future pods without moving one Sandbox Image tag, and an image the user merely
// BROUGHT (a registry ref) is possible at all. Refs are deployed-never-built: nothing in this file
// ever sees one.
//
// Content addressing also MAKES garbage — ten Dockerfile iterations leave ten full images — so the
// same seam owns the collector (ADR-0039). Two facts shape it: every image jr2 builds is STAMPED
// (`jr2.dev/kind`, plus `jr2.dev/instance` on a Sandbox Image) at build time, so ownership is
// read off the image instead of parsed out of its name; and an image is garbage iff no live root
// names its ref. The reachability part — assembling the keep set from the cluster — belongs to the
// commands layer; what lives here is the part that touches images: the two stores' physics, the pure
// removal policy over them, and the loop that executes it.
//
// `BuildPort` is what the converge logic drives (tests fake it); `pnpmDockerBuild` is the real one:
// pnpm + docker + kind + crictl subprocesses.

import { execFile } from "node:child_process";
import { cp, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { contentHash, KIT_VERSION } from "@jr2/orchestrator/internal";
import { LABEL_INSTANCE } from "./deploy.ts";

const exec = promisify(execFile);

/** One `docker build`. */
export type BuildRequest = {
  /** The tag to build — always a content address of (inputs × platform set), ADR-0038/0045. */
  tag: string;
  /** `--platform`: what the bytes are FOR, always explicit (ADR-0045). Never empty, and never
   * left to the daemon default or to a remembered `DOCKER_DEFAULT_PLATFORM` — an implicit platform
   * is what let one tag name an amd64 image on one host and an arm64 image on another. A singleton
   * set is a plain `docker build`; more than one is `docker buildx build --push`, which delivers
   * itself (see {@link pnpmDockerBuild.build}). */
  platforms: readonly string[];
  /** The build context directory. */
  context: string;
  /** `-f <path>`: a Dockerfile COMMITTED in the repo, whose context is somewhere else (the kit
   * images build from the kit root; a Sandbox Image's own Dockerfile is its context's default). */
  dockerfile?: string;
  /** `--label k=v`: who built this image (ADR-0039). Stamped at BUILD time, never written into a
   * Dockerfile — the user's file keeps zero jr2 knowledge (ADR-0037) and the committed kit
   * Dockerfiles stay plain. The labels ride the image config through `kind load` into containerd,
   * so both stores can read provenance back, and the sweep touches labeled images and nothing
   * else. Use {@link kitImageLabels}/{@link sandboxImageLabels}: an
   * unstamped build is an image no sweep can ever collect. */
  labels?: Record<string, string>;
};

export type BuildPort = {
  /** Materialize the instance package (+ resolved prod deps) into `outDir` — `pnpm deploy` for a
   * workspace member, a staged copy plus a frozen lockfile install for a standalone Instance
   * (ADR-0043; {@link bundleInstance}). */
  bundle(instanceDir: string, outDir: string): Promise<void>;
  /** `docker build` one image. */
  build(req: BuildRequest): Promise<void>;
  /** The image's own declared `USER`, `""` when it declares none. The converge is the ONLY place
   * this is knowable — a provision cannot inspect an image — so the resolved map records it and the
   * port answers two questions off that record: whether ADR-0037's uid-1000 fallback applies, and
   * whether the kubelet will refuse the seat outright.
   *
   * `platforms` says WHERE the artifact is, not which variant to read (ADR-0045): a singleton build
   * is on the host daemon (`docker inspect`), while a multi-platform one went straight to the
   * registry as a manifest list the daemon never held (`docker buildx imagetools inspect`). */
  imageUser(image: string, platforms: readonly string[]): Promise<string>;
  /** What a Sandbox Effector's image holds for a push (ADR-0068): which of `paths` it has,
   * links followed, and its `/etc/passwd` (`""` when it has none). Read off a container created and
   * never started, so nothing of the image runs. A multi-platform build is read for its first
   * platform: the files a push needs do not differ by architecture. */
  imageFiles(image: string, platforms: readonly string[], paths: readonly string[]): Promise<ImageFiles>;

  /** What this host can build for: its own platform, plus every foreign one binfmt emulation
   * registers (`docker buildx inspect`'s `Platforms:` line). The converge's binfmt preflight
   * (ADR-0045, {@link assertEmulation}) is the only caller — a foreign `RUN` step without qemu
   * fails mid-build with the same cryptic `exec format error` that ADR exists to delete, so the
   * question is asked before any build is spent rather than diagnosed after. */
  buildablePlatforms(): Promise<string[]>;
  /** `docker push` — the registry delivery (ADR-0019). */
  push(tag: string): Promise<void>;
  /** `kind load docker-image` — the no-registry delivery onto a kind cluster's nodes. */
  kindLoad(tag: string, cluster: string): Promise<void>;

  /** Every LABELED image the host daemon holds (ADR-0039) — the daemon filters by label key, so
   * an image jr2 did not build never reaches the policy at all. Reports exact bytes and ALL tags
   * per image id, including the id that has none left (a rebuilt tag leaves its predecessor
   * `<none>:<none>`, still labeled, reachable by no ref — the bulk of an iteration session's
   * garbage). */
  hostImages(): Promise<ObservedImage[]>;
  /** Drop one host ref (`docker rmi <tag|id>`). The host sweep is now the only caller — with the
   * wrap gone there is no intermediate tag to untag (ADR-0037) — and it removes per TAG precisely
   * because `docker rmi` untags, the bytes coming back only with an id's last tag.
   * Delete-if-present. */
  removeHostImage(ref: string): Promise<void>;

  /** What each of a kind cluster's nodes holds, per node: containerd's own view (`crictl images`),
   * with the ownership label read back per image. Labels are not in CRI's image list — they live
   * in the image config, one `crictl inspecti` away — so the port pays that read and hands the
   * policy one shape for both stores. */
  nodeImages(cluster: string): Promise<NodeImages[]>;
  /** Remove one node image BY ID (`crictl rmi`), which takes every tag on it — CRI has no untag
   * verb, which is why the node policy is a per-id decision. Delete-if-present. */
  removeNodeImage(cluster: string, node: string, id: string): Promise<void>;
};

/**
 * Exclude sets for hashing KIT source directories — one per build CONTEXT, because an exclusion is
 * only sound when the `.dockerignore` governing that context really drops the entry. Excluding
 * anything context-visible under-hashes: an edit there changes the image at an unchanged tag, the
 * silent-stale-image bug ADR-0038 exists to delete. The inverse (hashing something the context
 * drops) merely costs a needless rebuild — the direction that ADR chose. So everything else is
 * hashed deliberately, tests included; each entry below is justified against its own ignore file.
 *
 * Named `KIT_` so neither can be reached for a USER directory by accident. A Sandbox Image's
 * context is hashed by the ORCHESTRATOR's `imageContextDigest` instead (ADR-0049 — both sides
 * compute it), which excludes nothing at all, for the same reason: that folder IS the build
 * context and carries no `.dockerignore`, so docker copies `dist/` and `node_modules/` straight in.
 */

/** For walks under `packages/*` (the Harness, the Orchestrator): their context is the KIT ROOT, so the root
 * `.dockerignore` governs, and the only entries it drops at any depth are `**\/node_modules` and
 * `**\/dist` (plus `*.log`/`.env` globs `contentHash`'s name-set cannot express — hashing a stray
 * one of those over-hashes, which is allowed). A `packages/harness/bin/` would be context-VISIBLE,
 * so it must stay hashed — the old shared set excluded it and lied. */
const KIT_PACKAGE_EXCLUDE = new Set(["node_modules", "dist"]);

/** For the walk of `operator/`: its context is `operator/` itself, governed by
 * `operator/.dockerignore`, an ALLOWLIST (`**` then `!**\/*.go`, go.mod, go.sum). `bin/` (~400 MB
 * of downloaded tooling) and `testbin/` hold no `.go`, and `cover.out` is not one — all three are
 * context-invisible, so excluding them is sound and keeps the converge walk off the tooling. The
 * rest of the non-go tree (Makefile, config/, hack/) stays hashed: over-hash, the cheap side. */
const KIT_OPERATOR_EXCLUDE = new Set(["bin", "testbin", "cover.out"]);

// `contentHash` lives in `@jr2/orchestrator/internal` (ADR-0069): the door recomputes an Assembly's hash
// with the same function. Re-exported so every CLI caller keeps its import.
export { contentHash } from "@jr2/orchestrator/internal";

// --- ownership: who built this image (ADR-0039) ------------------------------------------------

/**
 * Ownership is a LABEL, not a naming convention (ADR-0039). Name grammar was load-bearing and
 * ambiguous — `jr2-sandbox-<instance>-<name>` has no reserved delimiter, so instance `my` + image
 * `extra-default` and instance `my-extra` + image `default` collide on one repo — and it could not
 * survive its own source: deleting `images/<x>/` orphaned that image's tags, because nothing
 * derived their names any more. A stamp answers both: the image says who built it.
 */
export const LABEL_IMAGE_KIND = "jr2.dev/kind";

/** The two kinds jr2 builds, and the whole value domain of {@link LABEL_IMAGE_KIND}. The
 * per-Instance image retired with ADR-0069: an Instance publishes an Assembly instead. */
export type ImageKind = "sandbox" | "kit";

/** The kit's own images (Harness, operator, Orchestrator). No instance label: every instance on the
 * cluster shares one copy, and "kit images are never swept" is not a rule any more — a kit ref is
 * kept because some instance's map or pod names it, and collects with everything else when the
 * last instance leaves (ADR-0039). */
export function kitImageLabels(): Record<string, string> {
  return { [LABEL_IMAGE_KIND]: "kit" };
}

/** A Sandbox Image — the user's Dockerfile, built once, straight to its content tag (ADR-0037).
 * The stamp is applied on the command line, never written into the Dockerfile: the file stays the
 * user's, with zero jr2 knowledge in it (ADR-0039). A ref the user merely BROUGHT is never stamped,
 * because jr2 never builds it — and what jr2 did not stamp, jr2 does not sweep. */
export function sandboxImageLabels(instance: string): Record<string, string> {
  return { [LABEL_IMAGE_KIND]: "sandbox", [LABEL_INSTANCE]: instance };
}

// --- the platform set (ADR-0045) ---------------------------------------------------------------

/**
 * The platforms the kit RELEASES for — the supported set, and the only architectures jr2 will build
 * an image for. One constant, because `scripts/kit-push.sh` builds the published Kit images from the
 * same list: two hand-kept copies desynchronize silently, so `test/kit-push.test.ts` reads the
 * script's default and fails the gate when they drift.
 *
 * An arch outside this set is never built for. A Sandbox Image for `s390x` is dead weight: no Kit
 * image could sit beside it in the pod, so the Sandbox would fail at the Harness instead of at
 * the image nobody published.
 */
export const SUPPORTED_PLATFORMS: readonly string[] = ["linux/amd64", "linux/arm64"];

/** `linux/arm64` → `arm64` — the short name a node reports, a tag suffix carries, and `binfmt
 * --install` takes. */
export function platformArch(platform: string): string {
  return platform.slice(platform.lastIndexOf("/") + 1);
}

/**
 * The platform half of an image address: `-arm64`, or `-amd64-arm64` for a multi-platform build
 * (ADR-0045). It goes in the TAG rather than the hash salt, and that is the decision: the bytes are
 * a function of (inputs × platform), so a tag that named only the inputs was a lie — and the failure
 * it produced (an amd64 image delivered to an arm64 cluster, surfacing as a rollout timeout) was
 * invisible precisely because the tag did not say. Sorted, so one platform set has one spelling.
 */
export function platformSuffix(platforms: readonly string[]): string {
  return [...platforms]
    .map(platformArch)
    .sort()
    .map((arch) => `-${arch}`)
    .join("");
}

/** What one converge builds for, and how it was decided (ADR-0045). */
export type PlatformChoice = {
  /** The build set: non-empty, sorted, and a subset of {@link SUPPORTED_PLATFORMS}. */
  platforms: string[];
  /** Node architectures reported and skipped — outside the supported set, so never built for.
   * Reported rather than swallowed: a silently ignored node is a pod that will never schedule. */
  skipped: string[];
  /** `nodes` = derived from the cluster; `config` = the `platforms` key spoke instead. */
  source: "config" | "nodes";
};

/**
 * The cluster's nodes choose the platform set (ADR-0045): the schedulable nodes'
 * `.status.nodeInfo.architecture`, mapped to `linux/<arch>` and intersected with the supported set.
 * Reading a singleton set is not an assumption — it is the cluster stating what it can run; only a
 * non-singleton set involves judgement, and that case builds for both rather than guessing.
 *
 * `configured` is the one escape hatch, and it is ABSOLUTE: when set, derivation is skipped entirely.
 * It exists for the two cases derivation cannot see — autoscale-from-zero (the target pool has no
 * nodes yet) and set pollution (an amd64 GPU pool beside arm64 workers costs a needless qemu build).
 * Not additive or subtractive: cleverness the rare case does not earn. An entry outside the
 * supported set is an ERROR rather than a skip, unlike a node's — a key the user typed is a claim,
 * and quietly dropping half of it would build something other than what it asked for.
 */
export function choosePlatforms(opts: { nodeArches: string[]; configured?: readonly string[] }): PlatformChoice {
  const supported = new Set(SUPPORTED_PLATFORMS);
  if (opts.configured !== undefined) {
    const asked = [...new Set(opts.configured)].sort();
    const unsupported = asked.filter((p) => !supported.has(p));
    if (asked.length === 0 || unsupported.length > 0) throw noSupportedPlatform(unsupported, "config");
    return { platforms: asked, skipped: [], source: "config" };
  }
  const arches = [...new Set(opts.nodeArches)].sort();
  const platforms = arches.map((a) => `linux/${a}`).filter((p) => supported.has(p));
  const skipped = arches.filter((a) => !supported.has(`linux/${a}`));
  if (platforms.length === 0) throw noSupportedPlatform(arches, "nodes");
  return { platforms, skipped, source: "nodes" };
}

/** The empty-intersection error, named: what was found, what the kit publishes, and the one key that
 * overrides the answer. Loud on purpose — the alternative is building for a platform whose pod could
 * never be assembled, and discovering it as a rollout timeout. */
function noSupportedPlatform(found: string[], source: "config" | "nodes"): Error {
  const what =
    source === "config"
      ? `\`platforms\` names ${found.join(", ") || "an empty list"}`
      : `this cluster's schedulable nodes report ${found.join(", ") || "no architecture at all"}`;
  return new Error(
    `${what} — the kit releases images for ${SUPPORTED_PLATFORMS.join(", ")} and nothing else, so an ` +
      `image built for anything else could not be joined by a Kit image in the same pod. ` +
      `Set \`platforms\` in jr2.config.ts (docker platform strings, e.g. "linux/arm64") to name the ` +
      `set to build for.`,
  );
}

/**
 * The binfmt preflight (ADR-0045): a foreign platform's `RUN` steps are EMULATED, and without qemu
 * registered docker fails minutes into the build with the same cryptic `exec format error` this
 * whole ADR exists to delete. So the question is asked before any build is spent, and the answer
 * names the fix.
 *
 * A port that cannot answer at all reads as "no opinion" and the preflight stands aside: this check
 * may only ever turn a late cryptic failure into an early named one, never invent a failure of its
 * own — a docker too broken to list its builder's platforms fails at the build that follows, with
 * docker's own error naming it.
 */
export async function assertEmulation(port: BuildPort, platforms: readonly string[]): Promise<void> {
  const buildable = await port.buildablePlatforms().catch((): string[] => []);
  if (buildable.length === 0) return;
  const missing = platforms.filter((p) => !buildable.includes(p));
  if (missing.length === 0) return;
  throw new Error(
    `this host cannot build for ${missing.join(", ")}: a foreign architecture's RUN steps need qemu ` +
      `binfmt emulation, and none is registered (this builder targets ${buildable.join(", ")}). ` +
      `Install it, then re-run:\n` +
      `  docker run --privileged --rm tonistiigi/binfmt --install ${missing.map(platformArch).join(",")}`,
  );
}

// --- the kit images (ADR-0038) --------------------------------------------------------------

/** The images the KIT owns and builds. An Instance deploys them but never authors them. The
 * Orchestrator joined them in ADR-0069: an Instance publishes an Assembly, and builds no image. */
export type KitImageName = "harness" | "operator" | "orchestrator";
export type KitImageRefs = Record<KitImageName, string>;

type KitImage = {
  /** The image repo — `<repo>:<hash>` built, `<repo>:<kitversion>` published. */
  repo: string;
  /** The committed Dockerfile, relative to the kit root. */
  dockerfile: string;
  /** The docker build context, relative to the kit root. */
  context: string;
  /** What the hash covers, relative to the kit root — deliberately OVER-hashed (ADR-0038): the
   * whole source directory, tests included, rather than the exact file list the Dockerfile copies.
   * A hand-derived list desynchronizes silently the first time a `COPY` is added, which is the
   * invisible-stale-image bug this whole layer deletes; a needless rebuild costs cached seconds. */
  sources: string[];
  /** What the walk skips — only entries this image's OWN `.dockerignore` really drops (see the
   * `KIT_*_EXCLUDE` sets above): context-invisible, so skipping them cannot under-hash. */
  exclude: Set<string>;
};

export const KIT_IMAGES: Record<KitImageName, KitImage> = {
  harness: {
    repo: "jr2-harness",
    dockerfile: "deploy/harness/Dockerfile",
    context: ".",
    // The whole `deploy/harness/` directory, not just its Dockerfile: the image also compiles
    // `work-acl.c`, the static program the attach runs in every Sandbox (ADR-0005/0037). Naming the
    // files by hand is the desynchronization this over-hash rule exists to delete — a work-acl edit
    // would move no tag, and `jr2 up` would report convergence onto pods mounting the previous
    // runtime. The directory covers whatever the next `COPY` adds.
    //
    // And the ONE thing this image builds from outside those two trees: `jr2-upload-pack`, the
    // program behind `origin`'s fetch url in every Sandbox (ADR-0053). Its source lives in the
    // operator's Go module, because the ask and the cache agent that answers it are one decision —
    // so the harness image's address has to cover it, or an edit to the program would move no tag
    // and `jr2 up` would report convergence onto pods running the previous one. Its packages and
    // not the whole module: the rest of `operator/` addresses the operator image, and the program
    // imports the standard library alone — which the Dockerfile's builder stage enforces by
    // copying no more than this and downloading nothing.
    //
    // And the Effector (ADR-0068), on /opt/jr2 beside it: its own Go module, again exactly what the
    // Dockerfile's stage copies — never `effector/bin`, the linter and the local build.
    sources: [
      "packages/harness",
      "deploy/harness",
      "operator/go.mod",
      "operator/go.sum",
      "operator/cmd/jr2-upload-pack",
      "operator/internal/uploadpack",
      "effector/go.mod",
      "effector/cmd",
      "effector/internal",
    ],
    exclude: KIT_PACKAGE_EXCLUDE,
  },
  operator: {
    repo: "jr2-operator",
    dockerfile: "operator/Dockerfile",
    context: "operator",
    sources: ["operator"],
    exclude: KIT_OPERATOR_EXCLUDE,
  },
  orchestrator: {
    repo: "jr2-orchestrator",
    dockerfile: "deploy/orchestrator/Dockerfile",
    context: ".",
    // `@jr2/orchestrator` and every kit package it depends on, which the Dockerfile packs into the
    // image (ADR-0069). `packages/agent-protocol` is a runtime dependency, so an edit there changes
    // the image and must move its tag. The third-party closure (xstate, zod, hono, …) comes from
    // the registry, each package forced to the version `deploy/orchestrator/closure.json` pins, so
    // the tag addresses it through that file. closure.json equals pnpm-lock.yaml's closure, and
    // this list equals the Orchestrator's `workspace:` dependencies, both asserted in
    // test/orchestrator-image.test.ts.
    sources: ["packages/orchestrator", "packages/agent-protocol", "deploy/orchestrator"],
    exclude: KIT_PACKAGE_EXCLUDE,
  },
};

/**
 * Where the published Kit images live (ADR-0044). A bare `jr2-harness:<kitversion>` resolves against
 * `docker.io/library/` on a node, where nothing is — so the canonical home is BAKED, not configured:
 * only a home every user's nodes can pull from makes `npm i -g @jr2/cli && jr2 init && jr2 up` work
 * with zero image plumbing. Public GHCR egress is GitHub's cost, so the project can afford one.
 */
export const KIT_IMAGE_HOME = "ghcr.io/snapwich";

/**
 * What an INSTALLED kit deploys: the published `<kitversion>` tags at the canonical home
 * ({@link KIT_IMAGE_HOME}), one release train with the npm version (ADR-0019/0044). These constants
 * used to live in `jr2.config.ts`'s `images` block as its defaults; they belong here instead, because
 * a config key would be an override seat — and "nobody runs a patched Harness against a real
 * cluster" is ADR-0027's no-eject-hatch enforced rather than merely stated.
 *
 * `kitRegistry` re-homes them — `<kitRegistry>/jr2-harness:<kitversion>` — for a self-hosted,
 * air-gapped, or mirror-only cluster, which is ADR-0038's deferred edge, now closed. It replaces the
 * home rather than nesting under it: a mirror holds the same tags under its own name, seeded
 * deliberately (`jr2 kit push`) and never by a converge. It is NOT `config.registry`: that key says
 * where images this converge BUILDS go, and prefixing both with one key would make every
 * private-registry user mirror the Kit images they could have pulled from the home. The version is
 * still the CLI's own — re-homing says where the tags live, never which ones.
 */
export function publishedKitRefs(kitRegistry?: string): KitImageRefs {
  const home = kitRegistry ?? KIT_IMAGE_HOME;
  return {
    harness: `${home}/jr2-harness:${KIT_VERSION}`,
    operator: `${home}/jr2-operator:${KIT_VERSION}`,
    orchestrator: `${home}/jr2-orchestrator:${KIT_VERSION}`,
  };
}

/**
 * Is the CLI running out of a kit checkout (ADR-0038)? Resolve upward from this module's own URL,
 * requiring BOTH `deploy/harness/Dockerfile` and a `packages/harness/package.json` that names
 * `@jr2/harness`. Either marker alone matches an unrelated tree — someone else's `deploy/harness`,
 * or a vendored copy of one package — and a false positive means `jr2 up` tries to docker-build a
 * kit that is not there. Installed from npm the answer is `undefined`.
 *
 * A module under `node_modules` came from a registry, so the walk stops there: an instance that
 * lives INSIDE a checkout but installs `@jr2/*` from npm would otherwise reach the checkout root and
 * build a Harness at HEAD beside an Orchestrator at the pinned version. The checkout's own instances
 * link the workspace packages, and node resolves those links, so their CLI loads from `packages/`.
 */
export async function detectKitCheckout(
  fromDir: string = fileURLToPath(new URL(".", import.meta.url)),
): Promise<string | undefined> {
  let dir = resolve(fromDir);
  if (dir.split(sep).includes("node_modules")) return undefined;
  for (;;) {
    if (await isKitRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function isKitRoot(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, KIT_IMAGES.harness.dockerfile));
    const pkg = JSON.parse(await readFile(join(dir, "packages", "harness", "package.json"), "utf8")) as {
      name?: string;
    };
    return pkg.name === "@jr2/harness";
  } catch {
    return false;
  }
}

/** Address each kit image by its own sources and the platform set it is built for:
 * `[<registry>/]jr2-<x>:<hash>-<arch>` (ADR-0038/0045). A `packages/harness` edit moves the harness
 * ref with no bookkeeping — and NO Sandbox Image ref with it: the runtime arrives on the pod's
 * `/opt/jr2` volume, so future pods take the new one and every user image keeps its tag, its layers,
 * and its delivery (ADR-0037). The registry prefix rides here because a built kit image is delivered
 * down the same transport branch as everything else. */
export async function kitImageRefs(
  kitRoot: string,
  opts: { platforms: readonly string[]; registry?: string },
): Promise<KitImageRefs> {
  const refs = {} as KitImageRefs;
  const suffix = platformSuffix(opts.platforms);
  for (const name of Object.keys(KIT_IMAGES) as KitImageName[]) {
    const image = KIT_IMAGES[name];
    const hash = await contentHash(
      image.sources.map((s) => join(kitRoot, s)),
      `kit:${image.repo}`,
      image.exclude,
    );
    refs[name] = `${opts.registry ? `${opts.registry}/` : ""}${image.repo}:${hash}${suffix}`;
  }
  return refs;
}

/** The `docker build` for one kit image: its committed Dockerfile against its own context, for an
 * explicit platform set (ADR-0045), stamped `jr2.dev/kind=kit` on the command line — the committed
 * Dockerfiles stay plain (ADR-0039). */
export function kitImageBuild(
  kitRoot: string,
  name: KitImageName,
  tag: string,
  platforms: readonly string[],
): BuildRequest {
  const image = KIT_IMAGES[name];
  return {
    tag,
    platforms,
    context: join(kitRoot, image.context),
    dockerfile: join(kitRoot, image.dockerfile),
    labels: kitImageLabels(),
  };
}

// --- Sandbox Images (ADR-0037) ---------------------------------------------------------------

/** `[<registry>/]jr2-sandbox-<instance>-<name>:<hash>-<arch>` — the image a Sandbox's primary
 * container runs, addressed by its build context's content digest (`imageContextDigest`, which the
 * ORCHESTRATOR owns because both sides compute it — ADR-0049) and the platform set it was built for
 * (ADR-0045). `name` is the context directory's basename and is decoration: it makes
 * `docker images` readable, while the hash is the identity.
 * Names are for humans and for content addressing only: nothing reads ownership out of this string
 * any more (ADR-0039). `jr2-sandbox-`, never `jr2-workspace-`: a Workspace is a Machine, and the image
 * is the POD's (GLOSSARY.md, Sandbox Image's first `Avoid:`). A ref the user merely BROUGHT takes no
 * suffix and never passes here — jr2 never builds it, so its platforms are the registry's business. */
export function sandboxImageTag(
  instance: string,
  name: string,
  hash: string,
  opts: { platforms: readonly string[]; registry?: string },
): string {
  const suffix = platformSuffix(opts.platforms);
  return `${opts.registry ? `${opts.registry}/` : ""}jr2-sandbox-${instance}-${name}:${hash}${suffix}`;
}

/**
 * ONE build (ADR-0037): the user's Dockerfile, its own directory as the context, straight to its
 * content tag. No second stage, no intermediate tag — the mutable shared name that used to
 * serialize concurrent converges of one checkout existed only because the wrap did, and there is
 * no wrap. jr2 never reads the file, which is exactly why `instance` is a parameter: the ownership
 * stamp is applied on the command line, so the Dockerfile stays the user's (ADR-0039).
 */
export async function buildSandboxImage(
  port: BuildPort,
  opts: { dir: string; tag: string; instance: string; platforms: readonly string[] },
): Promise<void> {
  await port.build({
    tag: opts.tag,
    platforms: opts.platforms,
    context: opts.dir,
    labels: sandboxImageLabels(opts.instance),
  });
}

// --- the sweep (ADR-0039) ----------------------------------------------------------------------

/**
 * One image as either store reports it. The two stores disagree about almost everything — the host
 * daemon can untag and filters by label, containerd can do neither and counts its own snapshot
 * bytes — but they agree about this much, so one shape carries both and the policy below is one
 * body of reasoning instead of two.
 *
 * `tags` is EVERY tag on the id, not the interesting ones: both policies below turn on "are they
 * ALL unreachable", and an id with no tags at all (a rebuilt tag's predecessor, on either side) is
 * reachable by nothing and is therefore garbage by construction.
 */
export type ObservedImage = {
  /** The image id — the unit containerd removes, and the unit bytes are counted in. */
  id: string;
  /** Every ref the store names this id by, verbatim (containerd's are fully qualified). */
  tags: string[];
  /** The store's own byte count. Never compare one store's to the other's: containerd counts its
   * snapshots and the daemon counts its layers, and the same image differs by several percent. */
  bytes: number;
  /** Does the image config carry {@link LABEL_IMAGE_KIND}? An unlabeled image is not jr2's to take
   * (ADR-0039), so it is invisible: never removed, never even reported as kept. */
  labeled: boolean;
};

/** What one kind node holds. `kind load` put it there; only `docker exec <node> crictl` can see it. */
export type NodeImages = { node: string; images: ObservedImage[] };

/**
 * The namespace containerd gives a local, unqualified tag. `kind load` imports into containerd,
 * which NORMALIZES `jr2-instance-x:h` to `docker.io/library/jr2-instance-x:h`, while every root that
 * names an image — the `jr2-images` ConfigMap, a Sandbox's `spec.image`, a pod's container image —
 * spells it the short way.
 */
const CONTAINERD_LOCAL_NS = "docker.io/library/";

/**
 * The one normalization, applied to both sides before comparison: strip `docker.io/library/` and
 * nothing else. Stripping only that namespace is what keeps a registry ref comparable to itself —
 * `reg.example.com/jr2-instance-x:h` and `jr2-instance-x:h` are two different refs of two different
 * copies, and a keep set that names one must not protect the other (ADR-0039: a registry-delivered
 * copy is cache and sweeps like everything else).
 */
export function normalizeRef(ref: string): string {
  return ref.startsWith(CONTAINERD_LOCAL_NS) ? ref.slice(CONTAINERD_LOCAL_NS.length) : ref;
}

/** The keep set: the refs live roots name, normalized. Membership is WHOLE-REF equality — the
 * prefix matching this replaces is the primitive ADR-0039 deletes, so nothing here may grow a
 * `startsWith` back. */
function keepSet(keep: Iterable<string>): Set<string> {
  return new Set([...keep].map(normalizeRef));
}

/** What one host sweep will do (see {@link hostSweepPlan}). */
export type HostSweepPlan = {
  /** One entry per REF to drop, in listing order. */
  remove: Array<{
    /** What `docker rmi` is given: the tag, or the id when the image has no tags left. */
    ref: string;
    /** The image this ref names — the unit bytes belong to. */
    id: string;
    /** Bytes credited to THIS removal: the id's size on the removal that takes its last labeled
     * ref, and 0 on every other, because that is when the daemon actually gives the disk back. */
    bytes: number;
  }>;
  /** The plan's upper bound on reclaimed bytes (see {@link SweepResult.bytes}). */
  bytes: number;
};

/** What one node sweep will do, and what it deliberately will not (see {@link nodeSweepPlan}). */
export type NodeSweepPlan = {
  /** One removal per image id — every tag on it is unreachable, so the whole image goes. `tags` is
   * all of them, for the report; `crictl rmi` gets the ID. */
  remove: Array<{ id: string; tags: string[]; bytes: number }>;
  /** Unreachable tags left in place: their image id also carries a tag some root still names, and
   * crictl cannot take one without the others. Reported, because silence would read as "swept". */
  kept: string[];
};

/**
 * The HOST policy: per TAG, because `docker rmi <tag>` untags — an id keeps living under its other
 * tags. So a labeled ref no root names goes, even when a sibling tag on the same id stays; there
 * is no mixed-id case on this side.
 *
 * Aggressive by ADR-0039: nothing RUNS from the host daemon — its images are scratch awaiting
 * delivery — and BuildKit's cache is a separate store `docker rmi` does not touch, so regenerating
 * a swept tag costs seconds. The accepted cost, written down so nobody adds a name filter to
 * "fix" it: a second checkout converging to a different cluster can have its host kit generation
 * swept, because this keep set only sees the current context's roots.
 */
export function hostSweepPlan(images: ObservedImage[], keep: Iterable<string>): HostSweepPlan {
  const reachable = keepSet(keep);
  const remove: HostSweepPlan["remove"] = [];
  let bytes = 0;
  for (const image of images) {
    if (!image.labeled) continue;
    const garbage = image.tags.filter((t) => !reachable.has(normalizeRef(t)));
    // No tags at all: a rebuilt tag left this id behind. No ref can ever name it, so it is garbage
    // by construction — and it must be removed BY ID, since a ref-only sweep leaks exactly the
    // iteration garbage the sweep exists for.
    if (image.tags.length === 0) {
      remove.push({ ref: image.id, id: image.id, bytes: image.bytes });
      bytes += image.bytes;
      continue;
    }
    // The bytes come back with the LAST tag, so they are credited to that one removal and to no
    // other. Summing per tag would double count an id that carries two.
    const last = garbage.length === image.tags.length;
    for (const [i, ref] of garbage.entries()) {
      const credited = last && i === garbage.length - 1 ? image.bytes : 0;
      remove.push({ ref, id: image.id, bytes: credited });
      bytes += credited;
    }
  }
  return { remove, bytes };
}

/**
 * The NODE policy: per ID, unchanged physics from ADR-0038's fix. `crictl rmi <tag>` resolves the
 * tag to its image id and removes the whole image, every tag with it — CRI has no untag verb. So
 * an id is removed (once) only when EVERY tag on it is unreachable, and an id carrying a tag some
 * root still names is kept whole and reported. The mixed id is a real case, not a hypothetical:
 * two instances whose `images/<x>` trees and harness ref are byte-identical produce the same image
 * id under different tags, and one of them is still running.
 */
export function nodeSweepPlan(images: ObservedImage[], keep: Iterable<string>): NodeSweepPlan {
  const reachable = keepSet(keep);
  const remove: NodeSweepPlan["remove"] = [];
  const kept: string[] = [];
  for (const image of images) {
    if (!image.labeled) continue;
    const garbage = image.tags.filter((t) => !reachable.has(normalizeRef(t)));
    if (garbage.length === image.tags.length) remove.push({ id: image.id, tags: image.tags, bytes: image.bytes });
    else kept.push(...garbage);
  }
  return { remove, kept };
}

/** What a sweep actually did — the one report `up`, `down`, and `gc` narrate. */
export type SweepResult = {
  /** Gone: the ref removed, or the id for an image that had no tags left to name it. */
  removed: string[];
  /** Unreachable tags deliberately left in place — a node id that also carries a reachable tag. */
  kept: string[];
  /** `ref (error)` per removal that failed. The loop continues past a failure rather than
   * abandoning everything behind it (ADR-0039). */
  failed: string[];
  /** Bytes the removals gave back, counted once per image id. An UPPER BOUND, and narrated as the
   * quantity the user feels rather than a count (ADR-0039): an image reports every layer it holds
   * as its own, so two images sharing a base each report the shared bytes in full. */
  bytes: number;
};

const emptySweep = (): SweepResult => ({ removed: [], kept: [], failed: [], bytes: 0 });

/**
 * One report out of several — the host's and every node's, or several converges' (`mergeSweeps` is
 * associative, so a caller can fold as it goes). Refs are de-duplicated AFTER {@link normalizeRef},
 * because that is the only way the promise holds: the two stores spell one image differently
 * (`jr2-harness:33a4` on the host, `docker.io/library/jr2-harness:33a4` on a node), so a raw-string
 * set reports one image twice. The merged refs are the normalized spelling — the one the roots, and
 * the user, name an image by.
 *
 * BYTES are summed, not de-duplicated, and that is not the same oversight: the host's copy and each
 * node's copy are distinct bytes on the user's one disk, and removing both gives back both. Same
 * rule as two nodes holding the same ref — two copies, two lots of disk (ADR-0039: bytes are the
 * quantity the user feels). The count answers "how many images", the bytes "how much disk".
 */
export function mergeSweeps(...results: SweepResult[]): SweepResult {
  const merged = emptySweep();
  const removed = new Set<string>();
  const kept = new Set<string>();
  for (const r of results) {
    for (const ref of r.removed) removed.add(normalizeRef(ref));
    for (const ref of r.kept) kept.add(normalizeRef(ref));
    merged.failed.push(...r.failed);
    merged.bytes += r.bytes;
  }
  merged.removed = [...removed];
  merged.kept = [...kept];
  return merged;
}

/** "was already gone" is the goal state, however it was reached — the delete-if-present rule both
 * stores need, since neither `docker rmi` nor `crictl rmi` is idempotent (both exit 1). */
function isAlreadyGone(err: unknown): boolean {
  return /no such image/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Sweep the host daemon: every labeled ref no root names. `keep` is the caller's assembled keep
 * set — the union of the cluster's live roots plus whatever this converge just resolved, which the
 * commands layer owns because reachability is a question about Kubernetes, not about images.
 *
 * A failed removal is reported and skipped; nothing here throws for one image's sake.
 */
export async function sweepHost(
  port: BuildPort,
  opts: { keep: Iterable<string>; dryRun?: boolean },
): Promise<SweepResult> {
  const result = emptySweep();
  const plan = hostSweepPlan(await port.hostImages(), opts.keep);
  for (const entry of plan.remove) {
    if (opts.dryRun) {
      result.removed.push(entry.ref);
      result.bytes += entry.bytes;
      continue;
    }
    try {
      await port.removeHostImage(entry.ref);
      result.removed.push(entry.ref);
      result.bytes += entry.bytes;
    } catch (err) {
      // Already gone counts as removed but frees nothing: something else took those bytes.
      if (isAlreadyGone(err)) result.removed.push(entry.ref);
      else result.failed.push(`${entry.ref} (${(err instanceof Error ? err.message : String(err)).split("\n")[0]})`);
    }
  }
  return result;
}

/**
 * Sweep every node of a kind cluster. Only kind: elsewhere the nodes pull from a registry, whose
 * retention is the registry's business (ADR-0038's line, kept). One removal per image id, because
 * that is the only granularity CRI offers.
 *
 * Nothing here believes an exit code. A node removal is confirmed by RE-LISTING the store and
 * checking the id is gone, and only a confirmed one is counted as removed or credited with bytes.
 * That is not defensive programming, it is this store's physics: `crictl rmi <id>` exits 0 having
 * dropped only the names CRI knows, while a `kind load`ed image is ALSO held under an
 * `import-<date>@<digest>` ref it does not (see {@link pnpmDockerBuild.removeNodeImage}) — so
 * "exited 0" was, for the whole node half, compatible with reclaiming nothing and saying gigabytes.
 * A ref-driven removal fixes that; the re-list is what makes the report true whatever the store
 * does next.
 */
export async function sweepNodes(
  port: BuildPort,
  opts: { cluster: string; keep: Iterable<string>; dryRun?: boolean },
): Promise<SweepResult> {
  const result = emptySweep();
  /** One attempted removal, awaiting the re-list that says whether it happened. */
  const attempted: Array<{ node: string; id: string; names: string[]; bytes: number; error?: string }> = [];
  for (const { node, images } of await port.nodeImages(opts.cluster)) {
    const plan = nodeSweepPlan(images, opts.keep);
    result.kept.push(...plan.kept);
    for (const entry of plan.remove) {
      // What the report names: the tags if it has any, else the id — a tagless leftover has no
      // other name, and "removed sha256:abc…" is still the truth about a disk.
      const names = entry.tags.length ? entry.tags : [entry.id];
      if (opts.dryRun) {
        result.removed.push(...names);
        result.bytes += entry.bytes;
        continue;
      }
      const attempt = { node, id: entry.id, names, bytes: entry.bytes, error: undefined as string | undefined };
      try {
        await port.removeNodeImage(opts.cluster, node, entry.id);
      } catch (err) {
        // Already gone counts as removed but frees nothing: something else took those bytes.
        if (isAlreadyGone(err)) attempt.bytes = 0;
        else attempt.error = (err instanceof Error ? err.message : String(err)).split("\n")[0];
      }
      attempted.push(attempt);
    }
  }
  if (attempted.length === 0) return result;

  let survivors: Map<string, Set<string>> | undefined;
  try {
    survivors = new Map(
      (await port.nodeImages(opts.cluster)).map(({ node, images }) => [node, new Set(images.map((i) => i.id))]),
    );
  } catch (err) {
    // The removals happened; what cannot be established is whether they took. Unverified goes in
    // `failed`, which is the conservative half of the truth — it costs a re-plan next sweep, where
    // claiming the bytes would cost the user their trust in the one number this prints.
    const why = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    for (const a of attempted) result.failed.push(`${a.names[0]} (could not verify the removal: ${why})`);
    return result;
  }
  for (const a of attempted) {
    if (survivors.get(a.node)?.has(a.id)) {
      result.failed.push(`${a.names[0]} (${a.error ?? "the node still holds it after the removal"})`);
    } else {
      result.removed.push(...a.names);
      result.bytes += a.bytes;
    }
  }
  return result;
}

/** `swept 4 image(s) (2.1 GB)` — the narration is bytes, because disk is the quantity the user
 * feels (ADR-0039). SI units, matching what docker and crictl print. */
export function formatBytes(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1000 && unit < units.length - 1) {
    n /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? n : n.toFixed(1)} ${units[unit]}`;
}

/**
 * The floor a Sandbox Image owes (ADR-0037) is NOT proven here, and the absence is the decision.
 * The floor is a HARNESS-SEAT obligation; a built context may equally be destined for the
 * User Container seat, which owes no floor at all (ADR-0005) — and which seat a directory serves is
 * workflow-internal and statically unrecoverable (ADR-0031, the same line that puts an unknown image
 * name at provision). So a converge cannot know what to hold an image to. The probe lives at the one
 * place the seat IS known: the `preflight` init step at provision, in the user's own image, on the
 * mounted `/opt/jr2` (sandbox-kube.ts owns it). That is also the only thing that can ever prove a
 * registry ref, which no converge sees at all — so one prover, not two that can disagree.
 */

// --- the bundle's install (ADR-0043) -----------------------------------------------------------

/** One package manager's frozen, production install — the command that materializes the bundle. */
export type InstallCommand = { command: string; args: string[] };

/**
 * The whole supported set, one row per package manager, keyed by the lockfile that selects it. The
 * "dependency matrix" collapses to nothing (ADR-0043): a lockfile is a proprietary format, so
 * supporting a package manager means invoking the binary that speaks its lockfile — and that
 * binary's presence is guaranteed by the very thing that selects it, since the user wrote the
 * lockfile with it. jr2 itself depends on no package manager.
 *
 * pnpm gets `node-linker=hoisted` so the bundle is flat REAL files whichever PM wrote it: one
 * Assembly shape to strip, seal, hash, and resolve from, instead of one per manager (ADR-0069).
 *
 * bun's two spellings are ONE row — `bun.lockb` is the binary format `bun.lock` replaced — so an
 * instance holding both is mid-migration, not ambiguous: one manager, one command, bun's own
 * precedence.
 */
const LOCKFILE_INSTALLS: Array<{ manager: string; lockfiles: string[]; install: InstallCommand }> = [
  { manager: "npm", lockfiles: ["package-lock.json"], install: { command: "npm", args: ["ci", "--omit=dev"] } },
  {
    manager: "pnpm",
    lockfiles: ["pnpm-lock.yaml"],
    install: { command: "pnpm", args: ["install", "--prod", "--frozen-lockfile", "--config.node-linker=hoisted"] },
  },
  {
    manager: "bun",
    lockfiles: ["bun.lock", "bun.lockb"],
    install: { command: "bun", args: ["install", "--production", "--frozen-lockfile"] },
  },
];

/** Deliberately out for v1 (ADR-0043): one filename hides two incompatible generations (classic
 * `--frozen-lockfile` vs berry `--immutable`), and berry defaults to PnP — no `node_modules` at
 * all, which the image's resolution model cannot host. A named rejection, never a silent fallback;
 * adding yarn later is one row above plus its tests. */
const YARN_LOCKFILE = "yarn.lock";

/**
 * Which install this Instance's committed bytes name. The lockfile — not the user's
 * `node_modules/` — is the input, and that is forced rather than stylistic: the GitOps/CI path
 * runs from a clean checkout where no `node_modules` exists, a copied tree bakes in accidents
 * instead of declarations, and prod-pruning a copied tree means reimplementing resolution. It is
 * ADR-0019's derivability rule applied to dependencies — the deployed bundle is a function of what
 * `up` can see committed — so the lockfile is part of the instance contract: none is a hard error
 * naming the supported three, and two managers is an ambiguity error rather than a guess.
 */
export async function lockfileInstall(instanceDir: string): Promise<InstallCommand> {
  const present = new Set(await readdir(instanceDir));
  const found = LOCKFILE_INSTALLS.filter((row) => row.lockfiles.some((f) => present.has(f)));
  const names = [
    ...found.map((row) => `${row.manager}: ${row.lockfiles.filter((f) => present.has(f)).join(", ")}`),
    ...(present.has(YARN_LOCKFILE) ? [`yarn: ${YARN_LOCKFILE}`] : []),
  ];
  // Ambiguity is asked FIRST, and about managers rather than files: two managers' lockfiles say two
  // different dependency graphs, and picking one by precedence would deploy the graph the user
  // stopped maintaining.
  if (names.length > 1) {
    throw new Error(
      `${instanceDir} holds lockfiles from more than one package manager (${names.join("; ")}) — ` +
        `delete the stale one, so the bundle installs the dependency graph the instance really uses`,
    );
  }
  if (found.length === 1) return found[0]!.install;
  if (present.has(YARN_LOCKFILE)) {
    throw new Error(`${instanceDir} has a ${YARN_LOCKFILE}, and yarn is not supported — use npm, pnpm, or bun`);
  }
  throw new Error(
    `${instanceDir} has no lockfile — jr2 installs the instance's dependencies from ` +
      `${LOCKFILE_INSTALLS.map((row) => `${row.manager} (${row.lockfiles.join(" or ")})`).join(", ")}; ` +
      `run your package manager's install and commit the lockfile it writes`,
  );
}

/**
 * What a staged copy of the Instance leaves behind. `node_modules/` because the lockfile is the
 * input (above); `.jr2/` because it is CLI-local state; `.git/` because history is not image
 * content; `.env`/`.env.*` and `.npmrc` because those are the two files a user keeps credentials
 * in — `jr2 init` writes `.env` into the scaffold's `.gitignore` saying exactly that, and `jr2 up`
 * reads it HOST-side into the Secrets it writes for the pods that spend each value, never into
 * the Orchestrator's (ADR-0019, ADR-0068). Copied, they would put a
 * credential into the Assembly AND into the content address that names it, so rotating a key
 * would publish a new Assembly (ADR-0069). The workspace branch already drops both: `pnpm deploy`
 * filters through npm-packlist. A registry the frozen install needs reaches it the way a
 * deployment-varying value should — the environment (`npm_config_registry`) or the user-level
 * npmrc — neither of which is image content.
 *
 * Matched by name at any depth: a nested one of these is the same kind of thing.
 */
const BUNDLE_STAGE_EXCLUDE = new Set(["node_modules", ".jr2", ".git", ".env", ".npmrc"]);

function excludedFromStage(name: string): boolean {
  return BUNDLE_STAGE_EXCLUDE.has(name) || name.startsWith(".env.");
}

/** Run one subprocess in `cwd`. The seam the dispatch is tested through: a unit test asserts the
 * exact argv a lockfile selects without a package manager anywhere near it. */
export type RunCommand = (command: string, args: string[], cwd: string) => Promise<void>;

const execCommand: RunCommand = async (command, args, cwd) => {
  await exec(command, args, { cwd, ...BIG });
};

/**
 * Materialize the Instance into `outDir` (ADR-0043, as amended there). Two shapes, and the key is
 * the INSTANCE's own, asked in this order:
 *
 * 1. Its own lockfile. An instance that carries one is self-contained — the lockfile IS its
 *    dependency graph, wherever the folder sits — so it is staged as a copy
 *    ({@link BUNDLE_STAGE_EXCLUDE}) and installed frozen and production-only by the lockfile's own
 *    package manager ({@link lockfileInstall}). This is how a standalone instance committed INSIDE
 *    a pnpm monorepo bundles: it sits under a `pnpm-workspace.yaml` that does not list it, so the
 *    workspace above it says nothing about how it installs.
 * 2. A `pnpm-workspace.yaml` above it. A workspace member carries no lockfile of its own — the
 *    workspace root holds it — so it is the ABSENCE of one that sends the instance to `pnpm deploy
 *    --legacy`, hoisted like the lockfile path. pnpm is a contributor prerequisite, like go for the operator, never a
 *    product dependency.
 * 3. Neither: {@link lockfileInstall}'s named refusal.
 *
 * Neither key is {@link detectKitCheckout}: a checkout CLI legitimately drives a standalone
 * instance (the developer's `/tmp` folder), and an installed kit legitimately drives a member of
 * the user's own monorepo. Asking "is there a workspace file above me" FIRST — the previous rule —
 * answered a question about an ancestor, and sent shape (1) down `pnpm deploy`, which pnpm answers
 * for a non-member with "No projects matched the filters" and exit 0: no bundle, and the failure
 * surfaced later as an ENOENT from the staging. That silent success is why the deploy branch checks
 * that the bundle exists, and names the shape when it does not.
 */
export async function bundleInstance(
  instanceDir: string,
  outDir: string,
  run: RunCommand = execCommand,
): Promise<void> {
  const root = (await hasOwnLockfile(instanceDir)) ? undefined : await pnpmWorkspaceRoot(instanceDir);
  if (root) {
    const pkg = JSON.parse(await readFile(join(instanceDir, "package.json"), "utf8")) as { name?: string };
    if (!pkg.name) throw new Error(`${instanceDir}/package.json has no "name" — needed to bundle the instance`);
    // --legacy: materialize (copy) workspace deps into the bundle rather than linking them.
    // node-linker=hoisted, as on the lockfile path: a flat `node_modules` of real directories. The
    // Assembly codec is ustar, which cannot hold pnpm's long store entry names, and a flat tree is
    // also what lets the Kit closure strip be a top-level delete (ADR-0069).
    await run(
      "pnpm",
      ["--filter", pkg.name, "--prod", "deploy", "--legacy", "--config.node-linker=hoisted", outDir],
      instanceDir,
    );
    // pnpm exits 0 — "No projects matched the filters" — for a `--filter` that names no member.
    if (!(await exists(outDir))) {
      throw new Error(
        `pnpm deploy wrote no bundle for ${instanceDir}: it sits under the pnpm workspace at ${root} but is not ` +
          `one of its packages, and it has no lockfile of its own — add it to the workspace's \`packages:\`, ` +
          `or install and commit a lockfile so it bundles as a standalone instance`,
      );
    }
    return;
  }
  // Asked before the copy: an instance with no lockfile must fail on the cheap half.
  const { command, args } = await lockfileInstall(instanceDir);
  // `verbatimSymlinks`: a relative link inside the Instance stays relative. Without it, `cp` writes
  // an absolute link back to the source folder, which the seal refuses (ADR-0069).
  await cp(instanceDir, outDir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => src === instanceDir || !excludedFromStage(basename(src)),
  });
  await run(command, args, outDir);
}

/** Whether the instance carries a lockfile of ANY manager — yarn included, so a yarn instance under
 * a workspace reaches {@link lockfileInstall}'s named refusal rather than `pnpm deploy`. */
async function hasOwnLockfile(instanceDir: string): Promise<boolean> {
  const present = new Set(await readdir(instanceDir));
  return [...LOCKFILE_INSTALLS.flatMap((row) => row.lockfiles), YARN_LOCKFILE].some((f) => present.has(f));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The nearest `pnpm-workspace.yaml` at or above `dir`. A file test, not a manifest parse:
 * membership proper is pnpm's to decide, and this is asked only for an instance with no lockfile of
 * its own ({@link bundleInstance}). A `packages:` glob that excludes the directory does NOT fail
 * `pnpm deploy --filter` — pnpm exits 0 having deployed nothing — which the caller checks. */
async function pnpmWorkspaceRoot(dir: string): Promise<string | undefined> {
  let d = resolve(dir);
  for (;;) {
    try {
      await stat(join(d, "pnpm-workspace.yaml"));
      return d;
    } catch {
      const parent = dirname(d);
      if (parent === d) return undefined;
      d = parent;
    }
  }
}

// --- the real port ----------------------------------------------------------------------------

const BIG = { maxBuffer: 64 * 1024 * 1024 };

/** What {@link BuildPort.imageFiles} reads off an image. */
export type ImageFiles = { present: string[]; passwd: string };

/** The one file a `docker cp … -` tar stream carries, as text: a 512-byte header whose size field
 * (octal, at offset 124) says how long the content after it is. */
export function tarFileText(tar: Buffer): string {
  if (tar.length < 512) return "";
  const size = parseInt(tar.subarray(124, 136).toString("latin1").replace(/\0.*$/s, "").trim() || "0", 8);
  return tar.subarray(512, 512 + (Number.isFinite(size) ? size : 0)).toString("utf8");
}

/** The real build port: pnpm + docker + kind + crictl subprocesses. */
export const pnpmDockerBuild: BuildPort = {
  bundle: (instanceDir, outDir) => bundleInstance(instanceDir, outDir),

  /**
   * `--platform` is always explicit (ADR-0045), and the platform set picks the mechanism:
   *
   * - ONE platform: plain `docker build`, landing on the host daemon, delivered by the caller's
   *   transport branch (`docker push` or `kind load`) exactly as before.
   * - MORE than one: `docker buildx build --push`, which is `just kit-push`'s mechanism. It PUSHES
   *   ITSELF — a manifest list cannot live in the daemon and `kind load` cannot carry one — so the
   *   caller's deliver() step must not push again. This path only ever runs where it can deliver, by
   *   construction: a mixed-arch node set is never kind (kind nodes are containers on one host), and
   *   the non-kind branch already requires a `registry`.
   *
   * The multi-platform build needs a builder of its own: the default `docker` driver builds only the
   * host's platform and cannot push a manifest list at all. It is the SAME named builder
   * `scripts/kit-push.sh` creates, so the two share one cache. `--provenance=false` keeps the pushed
   * index to the platforms asked for — attestation manifests ride an index as extra
   * `unknown/unknown` entries, read by nothing here.
   */
  async build({ tag, platforms, context, dockerfile, labels }) {
    const args =
      platforms.length > 1
        ? ["buildx", "build", "--builder", await ensureMultiArchBuilder(), "--provenance=false", "--push"]
        : ["build"];
    args.push("--platform", platforms.join(","), "-t", tag);
    for (const [k, v] of Object.entries(labels ?? {})) args.push("--label", `${k}=${v}`);
    if (dockerfile) args.push("-f", dockerfile);
    args.push(context);
    await exec("docker", args, BIG);
  },

  async imageFiles(image, platforms, paths) {
    const platform = platforms.length > 1 ? ["--platform", platforms[0]!] : [];
    // `--entrypoint` names nothing that must exist: the container is created, read and removed,
    // never started.
    const { stdout } = await exec("docker", ["create", ...platform, "--entrypoint", "/jr2-not-run", image], BIG);
    const container = stdout.trim();
    try {
      const present: string[] = [];
      for (const path of paths) {
        const found = await exec("docker", ["cp", "-L", `${container}:${path}`, "-"], {
          ...BIG,
          encoding: "buffer",
        }).then(
          () => true,
          () => false,
        );
        if (found) present.push(path);
      }
      const passwd = await exec("docker", ["cp", "-L", `${container}:/etc/passwd`, "-"], {
        ...BIG,
        encoding: "buffer",
      }).then(
        ({ stdout: tar }) => tarFileText(tar as Buffer),
        () => "",
      );
      return { present, passwd };
    } finally {
      await exec("docker", ["rm", "-f", container]).catch(() => undefined);
    }
  },

  async imageUser(image, platforms) {
    // A multi-platform build went straight to the registry (`buildx --push`), so the daemon holds
    // nothing to inspect — `imagetools` reads the manifest list where it actually is (ADR-0045).
    if (platforms.length > 1) {
      const { stdout } = await exec(
        "docker",
        ["buildx", "imagetools", "inspect", image, "--format", "{{json .Image}}"],
        BIG,
      );
      return manifestListUser(image, stdout);
    }
    // `docker inspect` answers `""` for an image that declares no USER, which is the exact fact
    // the fallback turns on — so the empty string is DATA here, never a missing value.
    const { stdout } = await exec("docker", ["image", "inspect", "--format", "{{.Config.User}}", image], BIG);
    return stdout.trim();
  },

  async buildablePlatforms() {
    // `docker buildx inspect` prints one `Platforms:` line per builder node, listing the host's own
    // platform and every foreign one binfmt registered. A `*` marks the preferred entry.
    const { stdout } = await exec("docker", ["buildx", "inspect"], BIG);
    return [...stdout.matchAll(/^Platforms:\s*(.+)$/gm)].flatMap((m) =>
      m[1]!
        .split(",")
        .map((p) => p.trim().replace(/\*$/, ""))
        .filter(Boolean),
    );
  },

  async push(tag) {
    await exec("docker", ["push", tag], BIG);
  },

  async kindLoad(tag, cluster) {
    await exec("kind", ["load", "docker-image", tag, "--name", cluster], BIG);
  },

  async hostImages() {
    // Two calls, and neither is optional: `docker image ls` reports no labels and formats its size
    // for humans ("4.45MB"), while `docker image inspect` gives exact bytes, every tag, and the
    // labels — but has no filter of its own. So the daemon narrows by label key, then inspect
    // answers about the survivors. `-q` prints one line per TAG, hence the de-duplication.
    const { stdout: idOut } = await exec(
      "docker",
      ["image", "ls", "-q", "--no-trunc", "--filter", `label=${LABEL_IMAGE_KIND}`],
      BIG,
    );
    const ids = [
      ...new Set(
        idOut
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    if (ids.length === 0) return [];
    const { stdout } = await exec(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}\t{{.Size}}\t{{json .RepoTags}}\t{{json .Config.Labels}}", ...ids],
      BIG,
    );
    const images: ObservedImage[] = [];
    for (const line of stdout.split("\n").filter((l) => l.trim())) {
      const [id, size, tags, labels] = line.split("\t");
      const parsedLabels = (JSON.parse(labels ?? "null") ?? {}) as Record<string, string>;
      images.push({
        id: id!,
        // `<none>:<none>` is how a tagless image sometimes spells its absence of a name; it is not
        // a ref, and treating it as one would send `docker rmi <none>:<none>` at the daemon.
        tags: ((JSON.parse(tags ?? "[]") ?? []) as string[]).filter((t) => t && !t.startsWith("<none>")),
        bytes: Number(size) || 0,
        labeled: LABEL_IMAGE_KIND in parsedLabels,
      });
    }
    return images;
  },

  async removeHostImage(ref) {
    await exec("docker", ["rmi", ref], BIG);
  },

  async nodeImages(cluster) {
    const { stdout: nodeList } = await exec("kind", ["get", "nodes", "--name", cluster]);
    const nodes = nodeList
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const out: NodeImages[] = [];
    // The images live in each node's containerd, not the host daemon — `kind load` imported them
    // there — so the reach is `docker exec <node> crictl`, per node.
    for (const node of nodes) {
      const { stdout: raw } = await exec("docker", ["exec", node, "crictl", "images", "-o", "json"], BIG);
      const listed = (JSON.parse(raw) as { images?: CriImage[] }).images ?? [];
      // CRI's list is a VIEW, and it can outlive what containerd holds: a removal that goes
      // through `ctr` leaves the CRI image store still answering for an id whose refs and content
      // are gone. Such a row is not an image — nothing can run from it and nothing can be
      // reclaimed by taking it again — so containerd's own ref list, not CRI's, decides what is
      // here. Without this, every id the sweep took would come back on the next plan, forever.
      const held = await containerdRefs(node);
      const rows = listed.filter((r) => criRefs(r).some((ref) => held.has(normalizeRef(ref))));
      const labels = await crictlLabels(
        node,
        rows.map((r) => r.id),
        async (batch) => {
          const { stdout } = await exec("docker", ["exec", node, "crictl", "inspecti", "-o", "json", ...batch], BIG);
          return stdout;
        },
      );
      out.push({
        node,
        images: rows.map((r) => ({
          id: r.id,
          tags: r.repoTags ?? [],
          // containerd reports its byte count as a STRING.
          bytes: Number(r.size ?? 0) || 0,
          labeled: LABEL_IMAGE_KIND in (labels.get(r.id) ?? {}),
        })),
      });
    }
    return out;
  },

  async removeNodeImage(_cluster, node, id) {
    // The refs BEFORE the removal: `crictl rmi` reports none of them back, and afterwards the id
    // may no longer be answerable at all.
    const refs = await criRefsOf(node, id);
    // CRI first, because it is the one path that also updates crictl's own view of the node.
    await exec("docker", ["exec", node, "crictl", "rmi", id], BIG);
    // Then the names CRI never knew. `kind load docker-image` hands containerd an OCI archive, so
    // the image is held under `import-<date>@sha256:<digest>` as well as under its tag; `crictl
    // rmi` drops the tag, the import ref keeps the image alive, and the id stays on disk — which
    // is why removing by id alone reclaimed nothing on a kind node while exiting 0. `ctr` is the
    // only reach to those refs, and it is delete-if-present (a missing name warns and exits 0).
    // Both spellings go, because containerd holds a tag fully qualified and an import ref bare.
    const names = [...new Set(refs.flatMap((ref) => [ref, normalizeRef(ref)]))];
    if (names.length > 0)
      await exec("docker", ["exec", node, "ctr", "-n", CONTAINERD_K8S_NS, "images", "rm", ...names], BIG);
  },
};

/** The builder a multi-platform build runs on (ADR-0045). The default `docker` driver can build
 * only the host's own platform and cannot push a manifest list, so a container driver is required —
 * and it is `scripts/kit-push.sh`'s builder by name, so a converge and a release push share one
 * cache. `network=host` is what makes `localhost:<port>` mean the HOST's registry: buildkit runs in
 * a container of its own, where `localhost` would otherwise be that container. */
const MULTI_ARCH_BUILDER = "jr2-kit";

/** Create-if-absent, because a converge that needed the builder and did not have one would fail
 * with buildx's own driver error — the class of manual step jr2 deletes. */
async function ensureMultiArchBuilder(): Promise<string> {
  try {
    await exec("docker", ["buildx", "inspect", MULTI_ARCH_BUILDER], BIG);
  } catch {
    await exec(
      "docker",
      [
        "buildx",
        "create",
        "--name",
        MULTI_ARCH_BUILDER,
        "--driver",
        "docker-container",
        "--driver-opt",
        "network=host",
      ],
      BIG,
    );
  }
  return MULTI_ARCH_BUILDER;
}

/**
 * The declared `USER` of a manifest list, out of `docker buildx imagetools inspect --format
 * "{{json .Image}}"`: an object keyed by platform, each value that platform's image config (a
 * single-platform index answers with the bare config instead).
 *
 * One image, one seat: the map a provision reads carries ONE `sandboxUser` per image (ADR-0037), so
 * two platforms declaring different users is not a value this layer may average — it is a fact the
 * record cannot hold, and it says so instead of picking the entry it happened to read first.
 */
export function manifestListUser(image: string, json: string): string {
  type Config = { config?: { User?: string } };
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const byPlatform = "config" in parsed ? { "": parsed } : (parsed as Record<string, Config>);
  const users = Object.entries(byPlatform).map(
    ([platform, entry]) => [platform, (entry as Config)?.config?.User ?? ""] as const,
  );
  const distinct = new Set(users.map(([, user]) => user));
  if (distinct.size > 1) {
    throw new Error(
      `${image} declares a different USER per platform (${users.map(([p, u]) => `${p}: ${u || "none"}`).join(", ")}) — ` +
        `a Sandbox Image's seat is one fact in the image map, so the same USER must hold for every platform built`,
    );
  }
  return users[0]?.[1] ?? "";
}

/** One row of `crictl images -o json`. `repoDigests` matters as much as `repoTags` here: a
 * `kind load`ed image often has no tag left and is named only by its `import-<date>@<digest>`. */
type CriImage = { id: string; repoTags?: string[]; repoDigests?: string[]; size?: string };

/** The containerd namespace Kubernetes' images live in — the one `crictl` talks to, and the one
 * `ctr` must be pointed at, since its default (`default`) holds nothing of ours. */
const CONTAINERD_K8S_NS = "k8s.io";

/** Every name CRI knows one image by, its id included (containerd holds a `sha256:<id>` ref for
 * images it pulled itself). */
function criRefs(image: CriImage): string[] {
  return [...(image.repoTags ?? []), ...(image.repoDigests ?? []), image.id];
}

/** Every ref containerd itself holds on a node, normalized — the truth CRI's list only mirrors. */
async function containerdRefs(node: string): Promise<Set<string>> {
  const { stdout } = await exec("docker", ["exec", node, "ctr", "-n", CONTAINERD_K8S_NS, "images", "ls", "-q"], BIG);
  return new Set(
    stdout
      .split("\n")
      .map((s) => normalizeRef(s.trim()))
      .filter(Boolean),
  );
}

/** The refs one image is named by, asked of CRI. An id it cannot answer for is already gone, which
 * is the goal state: no refs to take. */
async function criRefsOf(node: string, id: string): Promise<string[]> {
  try {
    const { stdout } = await exec("docker", ["exec", node, "crictl", "inspecti", "-o", "json", id], BIG);
    const parsed = JSON.parse(stdout) as { status?: { repoTags?: string[]; repoDigests?: string[] } };
    return [...(parsed.status?.repoTags ?? []), ...(parsed.status?.repoDigests ?? [])];
  } catch {
    return [];
  }
}

/**
 * The ownership read on a node: CRI's image LIST carries no labels and offers no label filter, so
 * provenance costs an `inspecti`, whose `-o json` puts it at `info.imageSpec.config.Labels`.
 * `inspecti` is variadic and answers a whole batch as one JSON array — one subprocess per node
 * rather than one per image — but it is fatal on the first id it cannot find, so a listing that
 * raced a removal falls back to asking one at a time. ONE id nobody answers for reads as unlabeled,
 * which is the safe direction: unlabeled is invisible, and invisible is never swept.
 *
 * NO id answered for is a different fact and gets a different answer: it means the label read
 * itself is broken (no `crictl` on this node image, an unreachable containerd socket, a `docker
 * exec` the daemon refused), and the safe-direction rule then turns the WHOLE node sweep into a
 * no-op that narrates success — a permanently dead collector indistinguishable from a clean
 * cluster. So it throws, like the roots read, and says which node and why.
 *
 * `inspect` is the batch read, injected so the failure shapes above are testable without a node.
 */
export async function crictlLabels(
  node: string,
  ids: string[],
  inspect: (batch: string[]) => Promise<string>,
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (ids.length === 0) return out;
  type Inspected = {
    status?: { id?: string };
    info?: { imageSpec?: { config?: { Labels?: Record<string, string> } } };
  };
  const read = async (batch: string[]): Promise<void> => {
    const parsed = JSON.parse(await inspect(batch)) as Inspected | Inspected[];
    // One id answers with an object, several with an array.
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      const id = entry.status?.id;
      if (id) out.set(id, entry.info?.imageSpec?.config?.Labels ?? {});
    }
  };
  let firstFailure: unknown;
  try {
    await read(ids);
  } catch (err) {
    firstFailure = err;
    for (const id of ids) {
      try {
        await read([id]);
      } catch {
        // Gone, or unreadable: leave it out of the map, which reads as unlabeled.
      }
    }
  }
  if (out.size === 0) {
    throw new Error(
      `no image on node "${node}" would say who built it ` +
        `(${(firstFailure instanceof Error ? firstFailure.message : String(firstFailure)).split("\n")[0]}) — ` +
        `every image would read as unlabeled, so the node sweep would take nothing and report success`,
    );
  }
  return out;
}
