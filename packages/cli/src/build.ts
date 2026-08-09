// The image build seam (ADR-0019/0038): `j2 up` builds EVERY image it deploys. There are three
// kinds — the instance's own (engine + this instance's workflows baked, ADR-0008), the instance's
// Sandbox Images (`images/<name>/Dockerfile` + the kit-owned wrap, ADR-0037), and — only when the
// CLI is running out of a kit CHECKOUT — the Harness, Adapter, and operator images. Installed from
// npm those kit sources do not resolve, so a real instance takes the published-`<kitversion>` path
// and never needs docker for them. The checkout IS the signal: no flag, no config key, no env.
//
// Every tag is a content address of its own inputs. That is what makes `imagePullPolicy:
// IfNotPresent` correct rather than lucky (a unique tag per content means "present" implies
// "current"), what lets a converge skip exactly what has not moved, and what makes the tag-equality
// check in `verifyRunningImage` sound for every layer instead of only the instance's.
//
// One mechanism is worth naming twice: `sandboxWrapDockerfile` already embeds the resolved harness
// ref, so salting a Sandbox Image's hash with the wrap text satisfies ADR-0038's "a Sandbox Image's
// hash must include the resolved harness ref" for free — the same trick `stageInstanceBundle` plays
// with `INSTANCE_DOCKERFILE`, and one less mechanism than a second, hand-maintained input list.
//
// Content addressing also MAKES garbage — ten Dockerfile iterations leave ten full images — so the
// same seam owns the collector (ADR-0039). Two facts shape it: every image j2 builds is STAMPED
// (`j2.dev/kind`, plus `j2.dev/instance` on the instance-owned kinds) at build time, so ownership is
// read off the image instead of parsed out of its name; and an image is garbage iff no live root
// names its ref. The reachability part — assembling the keep set from the cluster — belongs to the
// commands layer; what lives here is the part that touches images: the two stores' physics, the pure
// removal policy over them, and the loop that executes it.
//
// `BuildPort` is what the converge logic drives (tests fake it); `pnpmDockerBuild` is the real one:
// pnpm + docker + kind + crictl subprocesses.

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { KIT_VERSION } from "@j2/orchestrator";
import { LABEL_INSTANCE } from "./deploy.ts";

const exec = promisify(execFile);

/** One `docker build`. Exactly one of `dockerfile`/`dockerfileContent` may be set. */
export type BuildRequest = {
  /** The tag to build — always a content address (ADR-0038). */
  tag: string;
  /** The build context directory. */
  context: string;
  /** `-f <path>`: a Dockerfile COMMITTED in the repo, whose context is somewhere else (the kit
   * images build from the kit root; a Sandbox Image's own Dockerfile is its context's default). */
  dockerfile?: string;
  /** `-f -`: a Dockerfile j2 GENERATES (the instance image, the wrap). Fed on stdin rather than
   * written into the context, so a generated file can never be mistaken for a user's own and can
   * never perturb the content hash of the directory it is built from. */
  dockerfileContent?: string;
  /** `--label k=v`: who built this image (ADR-0039). Stamped at BUILD time, never written into a
   * Dockerfile — the user's file keeps zero j2 knowledge (ADR-0037) and the committed kit
   * Dockerfiles stay plain. The labels ride the image config through `kind load` into containerd,
   * so both stores can read provenance back, and the sweep touches labeled images and nothing
   * else. Use {@link kitImageLabels}/{@link instanceImageLabels}/{@link sandboxImageLabels}: an
   * unstamped build is an image no sweep can ever collect. */
  labels?: Record<string, string>;
};

export type BuildPort = {
  /** Materialize the instance package (+ resolved deps) into `outDir` (`pnpm deploy`). */
  bundle(instanceDir: string, outDir: string): Promise<void>;
  /** `docker build` one image. */
  build(req: BuildRequest): Promise<void>;
  /** `docker run --rm --user 1000 <image> <argv…>` → stdout. The Sandbox Image preflight
   * (ADR-0037) is the one caller: it needs the LOCAL daemon, so it runs before transport. */
  run(image: string, argv: string[]): Promise<string>;
  /** `docker push` — the registry delivery (ADR-0019). */
  push(tag: string): Promise<void>;
  /** `kind load docker-image` — the no-registry delivery onto a kind cluster's nodes. */
  kindLoad(tag: string, cluster: string): Promise<void>;

  /** Every LABELED image the host daemon holds (ADR-0039) — the daemon filters by label key, so
   * an image j2 did not build never reaches the policy at all. Reports exact bytes and ALL tags
   * per image id, including the id that has none left (a rebuilt tag leaves its predecessor
   * `<none>:<none>`, still labeled, reachable by no ref — the bulk of an iteration session's
   * garbage). */
  hostImages(): Promise<ObservedImage[]>;
  /** Drop one host ref (`docker rmi <tag|id>`). Two callers, one subprocess: the wrap's
   * per-converge intermediate `-base` tag (ADR-0040), and the host sweep — which removes per TAG
   * precisely because `docker rmi` untags, and the bytes come back only with an id's last tag.
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
 * Nothing is excluded from a BUNDLE hash (ADR-0038). The old exclude set named `.modules.yaml` and
 * `.bin` — exactly the entries that varied between two stagings — so the tag stood still while the
 * bytes moved, and the mechanism that should have exposed the drift was the one hiding it. The
 * bundle is SEALED instead (`sealInstanceBundle`), and the empty default is what guards the seal:
 * with nothing excluded, a bundle that ever varies again re-tags on every converge, in the open,
 * where a rebuild-and-reload every single time is impossible to miss.
 */

/**
 * Exclude sets for hashing KIT source directories — one per build CONTEXT, because an exclusion is
 * only sound when the `.dockerignore` governing that context really drops the entry. Excluding
 * anything context-visible under-hashes: an edit there changes the image at an unchanged tag, the
 * silent-stale-image bug ADR-0038 exists to delete. The inverse (hashing something the context
 * drops) merely costs a needless rebuild — the direction that ADR chose. So everything else is
 * hashed deliberately, tests included; each entry below is justified against its own ignore file.
 *
 * Named `KIT_` so neither can be reached for a USER directory by accident. A Sandbox Image's
 * folder IS its build context (ADR-0037) and carries no `.dockerignore`, so docker copies `dist/`
 * and `node_modules/` straight in — hash them (`NO_EXCLUDE`).
 */

/** For walks under `packages/*` (harness, adapter): their context is the KIT ROOT, so the root
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

/** Hash everything: the only honest exclude set for a directory j2 does not own (see above). */
const NO_EXCLUDE: Set<string> = new Set();

/**
 * A short content hash over `paths` (files and/or directories, sorted walk), salted with `salt`.
 * Symlinks are skipped rather than followed: in a pnpm bundle `node_modules/<pkg>` links into the
 * virtual store, whose real files the walk already visits — following would hash the same bytes
 * twice. Each path contributes its entries under its own index prefix, so two directories that
 * happen to hold the same relative filenames stay distinguishable.
 */
export async function contentHash(paths: string[], salt: string, exclude: Set<string> = new Set()): Promise<string> {
  const h = createHash("sha256");
  h.update(`salt:${salt}\n`);
  const walk = async (root: string, d: string, index: number): Promise<void> => {
    const entries = (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (exclude.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(root, p, index);
      else if (e.isFile()) {
        h.update(`${index}:${relative(root, p)}\n`);
        h.update(await readFile(p));
      }
    }
  };
  for (const [index, p] of paths.entries()) {
    const st = await stat(p);
    if (st.isDirectory()) await walk(p, p, index);
    else {
      h.update(`${index}:${basename(p)}\n`);
      h.update(await readFile(p));
    }
  }
  return h.digest("hex").slice(0, 12);
}

/** The Dockerfile every instance image is built from — generated, never user-authored (ADR-0019).
 * git: the boot reconcile clones onto the source volume in this container (ADR-0004).
 * kubectl: the Sandbox backend shells it against the pod's ServiceAccount (sandbox-kubectl).
 * tsx: in the bundle the kit's `.ts` sources live under node_modules (materialized, not
 * workspace-linked), where Node's own type stripping refuses to run — so the image runs the
 * entrypoint through tsx. An image-runtime detail only; the repo stays zero-build. */
export const INSTANCE_DOCKERFILE = `FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \\
  && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/v1.31.4/bin/linux/$(dpkg --print-architecture)/kubectl" \\
  && chmod +x /usr/local/bin/kubectl \\
  && apt-get purge -y curl && rm -rf /var/lib/apt/lists/* \\
  && npm install -g --no-audit --no-fund tsx@4
WORKDIR /instance
COPY . .
ENV NODE_ENV=production
EXPOSE 4000
CMD ["tsx", "node_modules/@j2/orchestrator/bin/server.ts"]
`;

/**
 * The **wrap** (ADR-0037): the second, kit-owned stage `j2 up` builds on top of whatever
 * `images/<name>/Dockerfile` produced. The user's file has zero j2 knowledge and is never
 * rewritten — this is the entire j2 half of a Sandbox Image, and every line is load-bearing:
 *
 * - `COPY --from=<harness> /opt/j2 /opt/j2` — the injected runtime, verbatim from the stock
 *   Harness image (`deploy/harness/Dockerfile` publishes that tree). `/opt/j2`, not `/app`, so a
 *   base that already uses `/app` is not shadowed. `bin/` and `lib/` arrive as siblings, which is
 *   what makes node's `$ORIGIN/../lib` rpath resolve on a base with no libstdc++ of its own.
 * - `HOME=/home/j2`, created at **build** — an image layer, not a volume, so a mount never shadows
 *   dotfiles the user baked in. The attach's first act writes `$HOME/.gitconfig`, and uid 1000 on
 *   a minimal base has neither a passwd entry nor a home; without this every attach dies with
 *   `fatal: $HOME not set`, inside a turn, as a tool error the model has to interpret.
 * - `PATH` is **appended**, never prepended. Working tools spawn with no env override, so children
 *   inherit this PATH — appending lets the user's pinned `node`/`rg`/toolchain win and leaves j2's
 *   as the fallback. Note the escaped `\${PATH}`: the *emitted* Dockerfile must contain the literal
 *   `${PATH}` for the shell-free `ENV` form to expand it at build. Interpolating it here would
 *   emit `PATH=":/opt/j2/bin"` and delete the user's toolchain — the exact failure the
 *   append-never-prepend rule exists to prevent, arriving silently.
 * - `WORKDIR /work` is for the human: with the User Container gone it is where `kubectl exec`
 *   lands. It has no effect on the Agent — every Working tool takes an explicit cwd.
 * - `CMD` is absolute for that reason, identical to the stock image's.
 *
 * The returned text is also the salt for the Sandbox Image's content hash, which is how "the hash
 * must include the resolved harness ref" (ADR-0038) is satisfied without a second mechanism.
 */
export function sandboxWrapDockerfile(baseRef: string, harnessRef: string): string {
  return `FROM ${baseRef}
COPY --from=${harnessRef} /opt/j2 /opt/j2
USER root
RUN mkdir -p /home/j2 && chown 1000:0 /home/j2 && chmod 0775 /home/j2
ENV HOME=/home/j2 PATH="\${PATH}:/opt/j2/bin"
WORKDIR /work
USER 1000
CMD ["/opt/j2/bin/node", "/opt/j2/src/main.ts"]
`;
}

// --- ownership: who built this image (ADR-0039) ------------------------------------------------

/**
 * Ownership is a LABEL, not a naming convention (ADR-0039). Name grammar was load-bearing and
 * ambiguous — `j2-sandbox-<instance>-<name>` has no reserved delimiter, so instance `my` + image
 * `extra-default` and instance `my-extra` + image `default` collide on one repo — and it could not
 * survive its own source: deleting `images/<x>/` orphaned that image's tags, because nothing
 * derived their names any more. A stamp answers both: the image says who built it.
 */
export const LABEL_IMAGE_KIND = "j2.dev/kind";

/** The three kinds ADR-0038 builds, and the whole value domain of {@link LABEL_IMAGE_KIND}. */
export type ImageKind = "instance" | "sandbox" | "kit";

/** The kit's own images (Harness, Adapter, operator). No instance label: every instance on the
 * cluster shares one copy, and "kit images are never swept" is not a rule any more — a kit ref is
 * kept because some instance's map or pod names it, and collects with everything else when the
 * last instance leaves (ADR-0039). */
export function kitImageLabels(): Record<string, string> {
  return { [LABEL_IMAGE_KIND]: "kit" };
}

/** The instance's own image (engine + workflows baked). `j2.dev/instance` is the SAME key the
 * Namespace and the rest of the converged objects wear (deploy.ts) — deliberately one word for one
 * owner, whether it labels a Kubernetes object or an image config. */
export function instanceImageLabels(instance: string): Record<string, string> {
  return { [LABEL_IMAGE_KIND]: "instance", [LABEL_INSTANCE]: instance };
}

/** A Sandbox Image — the user's Dockerfile plus the kit-owned wrap (ADR-0037). Stamped on BOTH
 * builds: the wrap inherits these through `FROM <base>` anyway (harmless, same owner), but the
 * intermediate `-base` id survives its own untag as a labeled dangling image, and only a stamp
 * makes it collectable rather than invisible garbage forever. */
export function sandboxImageLabels(instance: string): Record<string, string> {
  return { [LABEL_IMAGE_KIND]: "sandbox", [LABEL_INSTANCE]: instance };
}

// --- the kit images (ADR-0038) --------------------------------------------------------------

/** The three images the KIT owns. An instance deploys them but never authors them. */
export type KitImageName = "harness" | "adapter" | "operator";
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
    repo: "j2-harness",
    dockerfile: "deploy/harness/Dockerfile",
    context: ".",
    sources: ["packages/harness", "deploy/harness/Dockerfile"],
    exclude: KIT_PACKAGE_EXCLUDE,
  },
  adapter: {
    repo: "j2-adapter",
    dockerfile: "deploy/adapter/Dockerfile",
    context: ".",
    sources: ["packages/adapter", "deploy/adapter/Dockerfile"],
    exclude: KIT_PACKAGE_EXCLUDE,
  },
  operator: {
    repo: "j2-operator",
    dockerfile: "operator/Dockerfile",
    context: "operator",
    sources: ["operator"],
    exclude: KIT_OPERATOR_EXCLUDE,
  },
};

/**
 * What an INSTALLED kit deploys: the published `<kitversion>` tags, one release train with the npm
 * version (ADR-0019). These constants used to live in `j2.config.ts`'s `images` block as its
 * defaults; they belong here instead, because a config key would be an override seat — and
 * "nobody runs a patched Harness against a real cluster" is ADR-0027's no-eject-hatch enforced
 * rather than merely stated. Deliberately NOT registry-prefixed: an air-gapped cluster needs a
 * registry prefix for kit refs, which is a different mechanism ADR-0038 defers.
 */
export function publishedKitRefs(): KitImageRefs {
  return {
    harness: `j2-harness:${KIT_VERSION}`,
    adapter: `j2-adapter:${KIT_VERSION}`,
    operator: `j2-operator:${KIT_VERSION}`,
  };
}

/**
 * Is the CLI running out of a kit checkout (ADR-0038)? Resolve upward from this module's own URL,
 * requiring BOTH `deploy/harness/Dockerfile` and a `packages/harness/package.json` that names
 * `@j2/harness`. Either marker alone matches an unrelated tree — someone else's `deploy/harness`,
 * or a vendored copy of one package — and a false positive means `j2 up` tries to docker-build a
 * kit that is not there. Installed from npm neither resolves and the answer is `undefined`.
 */
export async function detectKitCheckout(
  fromDir: string = fileURLToPath(new URL(".", import.meta.url)),
): Promise<string | undefined> {
  let dir = resolve(fromDir);
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
    return pkg.name === "@j2/harness";
  } catch {
    return false;
  }
}

/** Address each kit image by its own sources: `[<registry>/]j2-<x>:<hash>`. A `packages/harness`
 * edit moves the harness ref with no bookkeeping — and, through the wrap salt, every Sandbox Image
 * ref with it (ADR-0037's consequence). The registry prefix rides here because a built kit image is
 * delivered down the same transport branch as everything else. */
export async function kitImageRefs(kitRoot: string, registry?: string): Promise<KitImageRefs> {
  const refs = {} as KitImageRefs;
  for (const name of Object.keys(KIT_IMAGES) as KitImageName[]) {
    const image = KIT_IMAGES[name];
    const hash = await contentHash(
      image.sources.map((s) => join(kitRoot, s)),
      `kit:${image.repo}`,
      image.exclude,
    );
    refs[name] = `${registry ? `${registry}/` : ""}${image.repo}:${hash}`;
  }
  return refs;
}

/** The `docker build` for one kit image: its committed Dockerfile against its own context, stamped
 * `j2.dev/kind=kit` on the command line — the committed Dockerfiles stay plain (ADR-0039). */
export function kitImageBuild(kitRoot: string, name: KitImageName, tag: string): BuildRequest {
  const image = KIT_IMAGES[name];
  return {
    tag,
    context: join(kitRoot, image.context),
    dockerfile: join(kitRoot, image.dockerfile),
    labels: kitImageLabels(),
  };
}

// --- Sandbox Images (ADR-0037) ---------------------------------------------------------------

/** The base-tag stand-in inside the hash SALT. The real base ref is scratch — the hash this salt
 * produces plus a per-converge nonce (ADR-0040) — so it must never enter the hash; the harness ref
 * in the same text is a real input and must, which is the point (ADR-0038). */
const WRAP_SALT_BASE = "<base>";

/** `[<registry>/]j2-sandbox-<instance>-<name>:<hash>` — the wrapped image a Sandbox runs. Names are
 * for humans and for content addressing only: nothing reads ownership out of this string any more
 * (ADR-0039). `j2-sandbox-`, never `j2-workspace-`: a Workspace is a Machine, and the image is the
 * POD's (CONTEXT.md, Sandbox Image's first `Avoid:`). */
export function sandboxImageTag(instance: string, name: string, hash: string, registry?: string): string {
  return `${registry ? `${registry}/` : ""}j2-sandbox-${instance}-${name}:${hash}`;
}

/** The intermediate tag the USER's Dockerfile builds to, before the wrap. Never delivered, never
 * registry-prefixed, recorded in no map, and untagged once the wrap succeeds — SCRATCH, not an
 * address (ADR-0040), which is why it carries `nonce` beside the hash: a converge names its own,
 * the way `mkdtemp` names the staging bundle's. A content-hash-only name was a shared global, and
 * one concurrent converge's untag failed the other's wrap mid-`FROM`. The nonce is drawn by the
 * caller (tests pass a fixed one), and it cannot leak into the wrapped image or its address: a
 * `FROM` resolves to content, and the hash is salted at the `<base>` stand-in, never the real tag. */
export function sandboxBaseTag(instance: string, name: string, hash: string, nonce: string): string {
  return `j2-sandbox-${instance}-${name}-base:${hash}-${nonce}`;
}

/** The content address of a Sandbox Image: everything in its directory, with NO exclusions, salted
 * with the wrap — so the resolved harness ref is an input and editing `packages/harness/src`
 * re-tags every Sandbox Image rather than leaving pods on the old runtime.
 *
 * No exclusions is the whole point: that directory IS the build context (ADR-0037) and carries no
 * `.dockerignore`, so a `dist/` or `node_modules/` beside the Dockerfile is image content and must
 * be image address. The `KIT_*_EXCLUDE` sets describe the KIT's own ignore files and are a lie
 * about anyone else's tree. */
export function sandboxImageHash(dir: string, harnessRef: string): Promise<string> {
  return contentHash([dir], sandboxWrapDockerfile(WRAP_SALT_BASE, harnessRef), NO_EXCLUDE);
}

/** Two builds off one hash (ADR-0037): the user's Dockerfile, then the kit-owned wrap on top of
 * the result. The user's file is never rewritten and never even read by j2 — which is exactly why
 * `instance` is a parameter: the stamp both builds carry is applied on the command line, so the
 * Dockerfile stays the user's (ADR-0039). */
export async function buildSandboxImage(
  port: BuildPort,
  opts: { dir: string; tag: string; baseTag: string; harnessRef: string; instance: string },
): Promise<void> {
  const labels = sandboxImageLabels(opts.instance);
  await port.build({ tag: opts.baseTag, context: opts.dir, labels });
  await port.build({
    tag: opts.tag,
    context: opts.dir,
    dockerfileContent: sandboxWrapDockerfile(opts.baseTag, opts.harnessRef),
    labels,
  });
  // The wrapped image holds the layers; dropping the `-base` tag keeps the converge's own scratch
  // out of the sweep's story — left in place, the end-of-run sweep would collect it and narrate the
  // base's full size as reclaimed disk for layers the wrapped image still holds. What the untag
  // leaves behind — a labeled image with no tags — is the sweep's, by id (ADR-0039). The tag is
  // per-converge (ADR-0040), so each converge untags only its own and none can pull the base out
  // from under another's `FROM` — the shared-name failure that kept the `@kind` tier serial.
  // Delete-if-present still: a concurrent sweep is free to have taken it first (ADR-0039's
  // in-flight-is-not-a-root limit), and "already gone" is the goal state. A converge that FAILS
  // before this line leaves its base tagged — labeled, unreachable, named for a human — which any
  // later sweep collects.
  await port.removeHostImage(opts.baseTag).catch((err: unknown) => {
    if (!isAlreadyGone(err)) throw err;
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
  /** Does the image config carry {@link LABEL_IMAGE_KIND}? An unlabeled image is not j2's to take
   * (ADR-0039), so it is invisible: never removed, never even reported as kept. */
  labeled: boolean;
};

/** What one kind node holds. `kind load` put it there; only `docker exec <node> crictl` can see it. */
export type NodeImages = { node: string; images: ObservedImage[] };

/**
 * The namespace containerd gives a local, unqualified tag. `kind load` imports into containerd,
 * which NORMALIZES `j2-instance-x:h` to `docker.io/library/j2-instance-x:h`, while every root that
 * names an image — the `j2-images` ConfigMap, a Sandbox's `spec.image`, a pod's container image —
 * spells it the short way.
 */
const CONTAINERD_LOCAL_NS = "docker.io/library/";

/**
 * The one normalization, applied to both sides before comparison: strip `docker.io/library/` and
 * nothing else. Stripping only that namespace is what keeps a registry ref comparable to itself —
 * `reg.example.com/j2-instance-x:h` and `j2-instance-x:h` are two different refs of two different
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
   * quantity the user feels rather than a count (ADR-0039): a wrapped image reports its base's
   * layers as its own, so two images sharing layers each report the shared bytes in full. */
  bytes: number;
};

const emptySweep = (): SweepResult => ({ removed: [], kept: [], failed: [], bytes: 0 });

/**
 * One report out of several — the host's and every node's, or several converges' (`mergeSweeps` is
 * associative, so a caller can fold as it goes). Refs are de-duplicated AFTER {@link normalizeRef},
 * because that is the only way the promise holds: the two stores spell one image differently
 * (`j2-adapter:33a4` on the host, `docker.io/library/j2-adapter:33a4` on a node), so a raw-string
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

/** ADR-0037's preflight, verbatim: git present · `$HOME` writable as uid 1000 · glibc new enough
 * for j2's node (with the relocated libstdc++) · the vendored ripgrep. */
export const SANDBOX_PREFLIGHT = 'git config --global safe.directory "*" && /opt/j2/bin/node -e "" && rg --version';

/**
 * Prove the two contracts a Sandbox Image must satisfy, once per CHANGED image, after the wrap and
 * before transport (it needs the local daemon). "node did not execute" is not actionable, so the
 * error names every fix — including the one that is not a fix at all: a shell-free base cannot be
 * wrapped, because the preflight, the attach script (ADR-0004), and every bash Working tool all
 * need `sh`.
 */
export async function preflightSandboxImage(port: BuildPort, name: string, ref: string): Promise<void> {
  try {
    await port.run(ref, ["sh", "-c", SANDBOX_PREFLIGHT]);
  } catch (err) {
    throw new Error(
      `Sandbox Image "${name}" (${ref}) failed the preflight (ADR-0037): ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        `  - \`git\` must be installed in YOUR base — j2 does not relocate it (the agent wants the git you chose)\n` +
        `  - the base needs glibc no older than j2's node was built against; alpine/musl cannot run it at all\n` +
        `  - \`$HOME\` (/home/j2) must be writable by uid 1000 — the attach's first act is \`git config --global\`\n` +
        `  - \`rg\` is VENDORED at /opt/j2/bin, so its absence means the wrap did not apply, not a missing package\n` +
        `  - a shell-free base (distroless, scratch) cannot be a Sandbox Image: the attach and the bash tool need \`sh\``,
    );
  }
}

// --- the real port ----------------------------------------------------------------------------

const BIG = { maxBuffer: 64 * 1024 * 1024 };

/** The real build port: pnpm + docker + kind + crictl subprocesses. */
export const pnpmDockerBuild: BuildPort = {
  async bundle(instanceDir, outDir) {
    const pkg = JSON.parse(await readFile(join(instanceDir, "package.json"), "utf8")) as { name?: string };
    if (!pkg.name) throw new Error(`${instanceDir}/package.json has no "name" — needed to bundle the instance`);
    // --legacy: materialize (copy) workspace deps into the bundle rather than linking them.
    await exec("pnpm", ["--filter", pkg.name, "--prod", "deploy", "--legacy", outDir], { cwd: instanceDir });
  },

  async build({ tag, context, dockerfile, dockerfileContent, labels }) {
    const args = ["build", "-t", tag];
    for (const [k, v] of Object.entries(labels ?? {})) args.push("--label", `${k}=${v}`);
    if (dockerfile) args.push("-f", dockerfile);
    if (dockerfileContent) args.push("-f", "-");
    args.push(context);
    if (dockerfileContent) await execStdin(["docker", ...args], dockerfileContent);
    else await exec("docker", args, BIG);
  },

  async run(image, argv) {
    // --user 1000 is the preflight's whole point on the Sandbox path: the operator sets
    // RunAsNonRoot with no runAsUser, so the image's own `USER 1000` is what satisfies it, and
    // "works as root" proves nothing about the pod.
    const { stdout } = await exec("docker", ["run", "--rm", "--user", "1000", image, ...argv], BIG);
    return stdout;
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

/** Run a command with a string on stdin (`docker build -f -`). */
async function execStdin(argv: string[], stdin: string): Promise<void> {
  await new Promise<void>((ok, fail) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? ok() : fail(new Error(`${argv.join(" ")} exited ${code}`))));
    child.stdin.end(stdin);
  });
}

/** Where the bundle really lives: the `WORKDIR` of {@link INSTANCE_DOCKERFILE}, which `COPY . .`
 * puts it at. The one path a staged bundle is allowed to name itself by. */
const BUNDLE_WORKDIR = "/instance";

/** Fatal on purpose — a lenient decode would replace the bytes it could not read (see the seal). */
const UTF8 = new TextDecoder("utf8", { fatal: true });

/**
 * Every substitution the seal makes, longest needle first. A `.bin` shim's `NODE_PATH` is a CHAIN —
 * the bundle's own `node_modules`, then the `node_modules` of each directory above it, up to the
 * root — and `pnpm deploy` writes the staging path into it in BOTH spellings it knows: the one
 * `mkdtemp` returned, and the one `realpath` resolves it to. The two coincide only where the temp
 * root is a real directory, so anchoring on the returned spelling alone is correct on Linux and
 * wrong on macOS, where `os.tmpdir()` is `/var/folders/…` and `/var` is a symlink to `/private/var`.
 * There the resolved spelling keeps the random `mkdtemp` component, the bundle stays a different
 * artifact every converge, and the tag it is addressed by never notices.
 *
 * The rungs ABOVE the bundle are the same failure one level up — macOS puts a per-boot random
 * segment there (`/var/folders/<xy>/<random>`) — so each is rewritten to the root's, which is
 * where `/instance`'s ancestors actually are. They are matched as `<ancestor>/node_modules` and
 * never as a bare directory: replacing every occurrence of `/tmp` would rewrite that string
 * wherever some dependency's own source happens to hold it.
 */
async function bundleRewrites(dir: string): Promise<Array<[string, string]>> {
  const spellings = new Set([dir, await realpath(dir)]);
  const rewrites: Array<[string, string]> = [];
  for (const form of spellings) {
    rewrites.push([form, BUNDLE_WORKDIR]);
    for (let up = dirname(form); up !== dirname(up); up = dirname(up)) {
      rewrites.push([`${up}/node_modules`, "/node_modules"]);
    }
  }
  return rewrites.sort(([a], [b]) => b.length - a.length);
}

/**
 * Seal the staged bundle (ADR-0038): after this, its bytes are a function of its inputs alone.
 * `pnpm deploy` writes the scratch directory into every `.bin` shim's `NODE_PATH`, and that
 * directory is a fresh `mkdtemp` per converge — so the same sources staged twice are two different
 * images under one content-addressed tag, which is "present implies current" broken for the one
 * image every Instance runs. The rewrite targets `/instance` rather than any stable placeholder
 * because that is where the image holds the bundle: the shims go from WRONG to CORRECT, and
 * determinism falls out of fixing them. What gets rewritten, and why it is more than one string,
 * is {@link bundleRewrites}.
 *
 * A file that holds the path but does not decode as UTF-8 stops the converge, named. `/instance` is
 * SHORTER than the scratch path, so rewriting inside a binary slides every offset after it — that
 * ships an Orchestrator image whose executable fails in the cluster, where nothing can attribute
 * it, instead of a converge that failed on the machine that built it.
 */
async function sealInstanceBundle(dir: string): Promise<void> {
  const rewrites = await bundleRewrites(dir);
  const needles = rewrites.map(([from]) => Buffer.from(from));
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      // A symlink's CONTENT is its target, and `contentHash` skips symlinks too — so a link naming
      // the staging path would be neither sealed nor addressed: the bundle would vary at a tag that
      // never moved, which is the one failure this seal exists to make impossible, arriving
      // silently. pnpm writes relative targets (a real bundle: 276 links, none absolute), so this
      // throws rather than rewriting — nothing is known about what such a link would mean.
      if (e.isSymbolicLink()) {
        const target = await readlink(p);
        if (rewrites.some(([from]) => target.includes(from))) {
          throw new Error(
            `cannot seal the instance bundle: the symlink ${relative(dir, p)} points at the staging path ` +
              `("${target}"), which would leave the bundle naming a directory the image does not have`,
          );
        }
        continue;
      }
      // Directories and files below are reached through `Dirent`, which is lstat-based, so the walk
      // cannot follow a link out of the bundle.
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const bytes = await readFile(p);
        if (!needles.some((needle) => bytes.includes(needle))) continue;
        let text: string;
        try {
          text = UTF8.decode(bytes);
        } catch {
          throw new Error(
            `cannot seal the instance bundle: ${relative(dir, p)} holds the staging path but is not valid UTF-8 — ` +
              `"${BUNDLE_WORKDIR}" is shorter than "${dir}", so rewriting it would corrupt every offset after it`,
          );
        }
        for (const [from, to] of rewrites) text = text.replaceAll(from, to);
        await writeFile(p, text);
      }
    }
  };
  await walk(dir);
}

/** A materialized instance bundle: the exact bytes the image is built FROM, and their address. */
export type StagedBundle = {
  /** The bundle directory — the build context. */
  dir: string;
  /** Content address of `dir` (+ the Dockerfile that bakes it): the image tag, and the staleness key. */
  hash: string;
  /** Remove the scratch dir. Always call it; the bundle is a few thousand files. */
  dispose(): Promise<void>;
};

/**
 * Materialize the bundle and address it by content (ADR-0019 — the deployed image must be derivable
 * from what `up` can see). The bundle, not the instance folder, is the thing hashed: `pnpm deploy`
 * resolves the kit into it, so a kit edit in a workspace checkout and a kit upgrade from the
 * registry both move the hash, by the same rule and with no knowledge of which world it is in.
 * Hashing the instance folder instead missed kit sources entirely, which is how `j2 up` came to
 * skip builds it needed and report convergence on code it had not deployed.
 *
 * The bundle is SEALED before it is hashed, and NOTHING is excluded from that hash (ADR-0038): a
 * bundle that named its own scratch dir made one tag address many images, and the exclude set that
 * used to paper over it hid exactly the drift it was supposed to expose. With an empty exclude set
 * the failure inverts — anything that ever varies again re-tags on every converge, in the open.
 *
 * Staging precedes the staleness decision, so `pnpm deploy` (~1s) runs even on the skip path; the
 * docker build it guards is the expensive half. The Dockerfile salts the hash — it is image content
 * that never lands in the context (it rides `docker build -f -`).
 */
export async function stageInstanceBundle(port: BuildPort, instanceDir: string): Promise<StagedBundle> {
  const scratch = await mkdtemp(join(tmpdir(), "j2-image-"));
  const dir = join(scratch, "bundle");
  try {
    await port.bundle(instanceDir, dir);
    // `images/` is HOST-SIDE ONLY (ADR-0037): `discoverImages` is called by `j2 up` alone, and the
    // Orchestrator resolves every Sandbox Image from the `j2-images` ConfigMap it never scans a
    // filesystem for. Dropped BEFORE the hash because leaving it in falsified ADR-0038's own
    // rationale for that ConfigMap: editing only `images/default/Dockerfile` moved the INSTANCE
    // tag, which is a pod-template change, which rolled the Orchestrator and put every live run
    // through snapshot restore — the exact cost the map-not-env decision was taken to avoid.
    await rm(join(dir, "images"), { recursive: true, force: true });
    // `.modules.yaml` is nothing but a record of where and when this staging happened (a `prunedAt`
    // stamp and the scratch paths), and the image reads it never. It goes beside `images/`; the
    // rest of the where-and-when — the shims' baked `NODE_PATH` — the seal corrects.
    await rm(join(dir, "node_modules", ".modules.yaml"), { force: true });
    await sealInstanceBundle(dir);
    return {
      dir,
      hash: await contentHash([dir], INSTANCE_DOCKERFILE),
      dispose: () => rm(scratch, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(scratch, { recursive: true, force: true });
    throw err;
  }
}
