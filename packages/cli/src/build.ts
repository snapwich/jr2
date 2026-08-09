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
// `BuildPort` is what the converge logic drives (tests fake it); `pnpmDockerBuild` is the real one:
// pnpm + docker + kind + crictl subprocesses.

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { KIT_VERSION } from "@j2/orchestrator";

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
};

export type BuildPort = {
  /** Materialize the instance package (+ resolved deps) into `outDir` (`pnpm deploy`). */
  bundle(instanceDir: string, outDir: string): Promise<void>;
  /** `docker build` one image. */
  build(req: BuildRequest): Promise<void>;
  /** `docker run --rm --user 1000 <image> <argv…>` → stdout. The Sandbox Image preflight
   * (ADR-0037) is the one caller: it needs the LOCAL daemon, so it runs before transport. */
  run(image: string, argv: string[]): Promise<string>;
  /** Drop a local tag (`docker rmi`). Used on the wrap's intermediate `-base` tag, whose layers
   * the wrapped image holds — so this untags, it does not reclaim. */
  untag(tag: string): Promise<void>;
  /** `docker push` — the registry delivery (ADR-0019). */
  push(tag: string): Promise<void>;
  /** `kind load docker-image` — the no-registry delivery onto a kind cluster's nodes. */
  kindLoad(tag: string, cluster: string): Promise<void>;
  /** Remove every image on a kind cluster's nodes whose repo:tag starts with one of `prefixes`,
   * returning what was removed (`j2 down`, ADR-0038). Content addressing means ten Dockerfile
   * iterations leave ten full images in containerd, invisible to `kubectl`. */
  kindPrune(cluster: string, prefixes: string[]): Promise<string[]>;
};

/**
 * Bundle entries that vary between two stagings of identical sources, and so cannot be part of a
 * content address: `.modules.yaml` stamps `prunedAt`, and `.bin/*` shims embed the absolute staging
 * path — a fresh temp dir every run. Neither is image content in any case; the shims' baked paths
 * are already wrong inside the container, where the bundle lives at /instance.
 */
const HASH_EXCLUDE = new Set([".modules.yaml", ".bin"]);

/**
 * The exclude set for hashing a KIT source directory (a kit package, the operator tree) — and
 * NOTHING else. Each entry is a path the KIT's own root `.dockerignore` really drops, so hashing it
 * would move a tag without moving the image, and `operator/bin` alone is ~400 MB of downloaded
 * tooling every converge would then walk. Everything else is hashed deliberately, tests included
 * (ADR-0038: a hand-derived file list desynchronizes silently the first time someone adds a `COPY`).
 *
 * Named `KIT_` so it cannot be reached for a USER directory by accident. A Sandbox Image's folder
 * IS its build context (ADR-0037) and carries no `.dockerignore`, so docker copies `dist/` and
 * `node_modules/` straight in; excluding them there under-hashes, and an edit under `images/x/dist`
 * would change the image at an unchanged tag — the silent-stale-image bug ADR-0038 exists to
 * delete. Over-hashing is that ADR's stated direction; under-hashing is the defect.
 */
const KIT_SOURCE_EXCLUDE = new Set(["node_modules", ".git", "bin", "testbin", "dist", "cover.out"]);

/** Hash everything: the only honest exclude set for a directory j2 does not own (see above). */
const NO_EXCLUDE: Set<string> = new Set();

/**
 * A short content hash over `paths` (files and/or directories, sorted walk), salted with `salt`.
 * Symlinks are skipped rather than followed: in a pnpm bundle `node_modules/<pkg>` links into the
 * virtual store, whose real files the walk already visits — following would hash the same bytes
 * twice. Each path contributes its entries under its own index prefix, so two directories that
 * happen to hold the same relative filenames stay distinguishable.
 */
export async function contentHash(paths: string[], salt: string, exclude: Set<string> = HASH_EXCLUDE): Promise<string> {
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
};

export const KIT_IMAGES: Record<KitImageName, KitImage> = {
  harness: {
    repo: "j2-harness",
    dockerfile: "deploy/harness/Dockerfile",
    context: ".",
    sources: ["packages/harness", "deploy/harness/Dockerfile"],
  },
  adapter: {
    repo: "j2-adapter",
    dockerfile: "deploy/adapter/Dockerfile",
    context: ".",
    sources: ["packages/adapter", "deploy/adapter/Dockerfile"],
  },
  operator: {
    repo: "j2-operator",
    dockerfile: "operator/Dockerfile",
    context: "operator",
    sources: ["operator"],
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
      KIT_SOURCE_EXCLUDE,
    );
    refs[name] = `${registry ? `${registry}/` : ""}${image.repo}:${hash}`;
  }
  return refs;
}

/** The `docker build` for one kit image: its committed Dockerfile against its own context. */
export function kitImageBuild(kitRoot: string, name: KitImageName, tag: string): BuildRequest {
  const image = KIT_IMAGES[name];
  return { tag, context: join(kitRoot, image.context), dockerfile: join(kitRoot, image.dockerfile) };
}

// --- Sandbox Images (ADR-0037) ---------------------------------------------------------------

/** The base-tag stand-in inside the hash SALT. The real base ref is derived from the hash this
 * salt produces, so it carries no information the hash does not already have — but the harness ref
 * in the same text does, which is the point (ADR-0038). */
const WRAP_SALT_BASE = "<base>";

/** `[<registry>/]j2-sandbox-<instance>-<name>:<hash>` — the wrapped image a Sandbox runs, and what
 * `j2 down` prunes by prefix. `j2-sandbox-`, never `j2-workspace-`: a Workspace is a Machine, and
 * the image is the POD's (CONTEXT.md, Sandbox Image's first `Avoid:`). */
export function sandboxImageTag(instance: string, name: string, hash: string, registry?: string): string {
  return `${registry ? `${registry}/` : ""}j2-sandbox-${instance}-${name}:${hash}`;
}

/** The intermediate tag the USER's Dockerfile builds to, before the wrap. Never delivered, never
 * registry-prefixed, and untagged once the wrap succeeds. */
export function sandboxBaseTag(instance: string, name: string, hash: string): string {
  return `j2-sandbox-${instance}-${name}-base:${hash}`;
}

/** The content address of a Sandbox Image: everything in its directory, with NO exclusions, salted
 * with the wrap — so the resolved harness ref is an input and editing `packages/harness/src`
 * re-tags every Sandbox Image rather than leaving pods on the old runtime.
 *
 * No exclusions is the whole point: that directory IS the build context (ADR-0037) and carries no
 * `.dockerignore`, so a `dist/` or `node_modules/` beside the Dockerfile is image content and must
 * be image address. `KIT_SOURCE_EXCLUDE` describes the KIT's `.dockerignore` and is a lie about
 * anyone else's tree. */
export function sandboxImageHash(dir: string, harnessRef: string): Promise<string> {
  return contentHash([dir], sandboxWrapDockerfile(WRAP_SALT_BASE, harnessRef), NO_EXCLUDE);
}

/** Two builds off one hash (ADR-0037): the user's Dockerfile, then the kit-owned wrap on top of
 * the result. The user's file is never rewritten and never even read by j2. */
export async function buildSandboxImage(
  port: BuildPort,
  opts: { dir: string; tag: string; baseTag: string; harnessRef: string },
): Promise<void> {
  await port.build({ tag: opts.baseTag, context: opts.dir });
  await port.build({
    tag: opts.tag,
    context: opts.dir,
    dockerfileContent: sandboxWrapDockerfile(opts.baseTag, opts.harnessRef),
  });
  // The wrapped image holds the layers; dropping the `-base` tag only stops the host daemon
  // accumulating one dangling tag per iteration of a Dockerfile.
  await port.untag(opts.baseTag);
}

// --- the kind prune (ADR-0038) -----------------------------------------------------------------

/** One entry of `crictl images -o json` on a kind node — containerd's view, not the host daemon's. */
export type NodeImage = { id: string; repoTags?: string[] };

/**
 * The namespace containerd gives a local, unqualified tag. `kind load` imports into containerd,
 * which NORMALIZES `j2-instance-x:h` to `docker.io/library/j2-instance-x:h` — so the bare prefixes
 * `j2 down` prunes by matched nothing at all, and a real run left 28 of this instance's images on
 * the node while reporting "no images to prune".
 */
const CONTAINERD_LOCAL_NS = "docker.io/library/";

/**
 * Which repoTags on a node belong to this instance (`j2 down`, ADR-0038) — the whole matching rule,
 * pure and exported because it is the part that was wrong, and the port around it is unfakeable.
 *
 * Exactly ONE normalization: strip `docker.io/library/`, then match anchored prefixes. Stripping
 * only that namespace is what preserves the property the anchoring existed for — a registry-pushed
 * `reg.example.com/j2-instance-x:h` keeps its host, so it never matches and stays the registry's
 * business — while `docker.io/library/j2-instance-x:h` matches, which is the whole point. Kit tags
 * (`j2-harness`, `j2-adapter`, `j2-operator`) match no prefix: every instance on the cluster shares
 * them.
 *
 * Returns the tags AS CONTAINERD NAMES them, because those are what `crictl rmi` is given: removing
 * by image ID would delete every OTHER tag on the same id with it.
 */
export function prunableTags(images: NodeImage[], prefixes: string[]): string[] {
  const matched: string[] = [];
  for (const image of images) {
    for (const tag of image.repoTags ?? []) {
      const local = tag.startsWith(CONTAINERD_LOCAL_NS) ? tag.slice(CONTAINERD_LOCAL_NS.length) : tag;
      if (prefixes.some((p) => local.startsWith(p))) matched.push(tag);
    }
  }
  return matched;
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

  async build({ tag, context, dockerfile, dockerfileContent }) {
    const args = ["build", "-t", tag];
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

  async untag(tag) {
    await exec("docker", ["rmi", tag], BIG);
  },

  async push(tag) {
    await exec("docker", ["push", tag], BIG);
  },

  async kindLoad(tag, cluster) {
    await exec("kind", ["load", "docker-image", tag, "--name", cluster], BIG);
  },

  async kindPrune(cluster, prefixes) {
    const { stdout: nodeList } = await exec("kind", ["get", "nodes", "--name", cluster]);
    const nodes = nodeList
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const removed: string[] = [];
    // The images live in each node's containerd, not the host daemon — `kind load` imported them
    // there — so the reach is `docker exec <node> crictl`, per node.
    for (const node of nodes) {
      const { stdout: raw } = await exec("docker", ["exec", node, "crictl", "images", "-o", "json"], BIG);
      const images = (JSON.parse(raw) as { images?: NodeImage[] }).images ?? [];
      // By TAG, never by `image.id`: `crictl rmi <id>` drops every tag on that id, including ones
      // no prefix matched — a kit tag sharing an id with an instance tag would go with it.
      for (const tag of prunableTags(images, prefixes)) {
        await exec("docker", ["exec", node, "crictl", "rmi", tag], BIG);
        removed.push(tag);
      }
    }
    return removed;
  },
};

/** Run a command with a string on stdin (`docker build -f -`). */
async function execStdin(argv: string[], stdin: string): Promise<void> {
  await new Promise<void>((ok, fail) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? ok() : fail(new Error(`${argv.join(" ")} exited ${code}`))));
    child.stdin.end(stdin);
  });
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
