// `jr2 kit push <registry>` (ADR-0044): the installed self-hoster's mirror of the Kit images.
//
// Kit images live at a canonical public home (`ghcr.io/snapwich`, baked into `publishedKitRefs()`).
// A cluster that cannot reach it — air-gapped, mirror-only, or simply policy-bound to one registry —
// needs the three refs at its own address, which is what `kitRegistry` names in the config. This
// command is how the bytes get there.
//
// It is deliberately INSTANCE-LESS: no `jr2.config.ts`, no kube context, no namespace. Kit images are
// shared by every instance on a cluster (and possibly by every instance in an org), so moving them
// is its own deliberate act rather than a side effect of converging one instance — which is exactly
// why ADR-0044 keeps this out of `jr2 up`.
//
// It is a MIRROR and nothing else. There is no build arm here: the npm packages carry no Harness or
// Adapter source, and an installed CLI that could build Kit images would be the patched-Harness
// eject hatch ADR-0027/ADR-0038 welded shut. The kit developer's arm is `just kit-push`, in the
// checkout, where the sources actually are.
//
// The copy is `docker buildx imagetools create`, a registry-to-registry manifest copy: it moves the
// full manifest list (every platform, exact digests) without landing bytes on this host. A daemon
// -side `docker pull` + `docker push` would flatten a multi-arch image to the host's own platform
// and ship an amd64-only image to an arm64 cluster, so it is not an implementation detail we may
// swap — it is the decision.

import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { KIT_VERSION } from "@jr2/orchestrator";
import { KIT_IMAGES, publishedKitRefs, type KitImageName } from "../build.ts";
import { activity, result, type Io } from "../output.ts";

const exec = promisify(execFile);

const USAGE = `usage: jr2 kit push <registry>

  mirror the v${KIT_VERSION} kit images (harness, adapter, operator) from their canonical
  home into <registry>, for a cluster whose \`kitRegistry\` names it (ADR-0044)`;

/** Run one `docker` invocation, rejecting on a non-zero exit. The seam this command is tested
 * through: the claims are which argv each ref produces and what a failure means, and both are
 * decidable with no registry anywhere near the test. Narrower than `build.ts`'s `RunCommand` on
 * purpose — a mirror runs docker and only docker, and from nowhere in particular. */
export type RunDocker = (args: string[]) => Promise<void>;

const dockerCli: RunDocker = async (args) => {
  await exec("docker", args, { maxBuffer: 64 * 1024 * 1024 });
};

/** What one image's mirror did — the per-image line, and the machine-readable result's rows. */
type Mirrored = { image: KitImageName; source: string; target: string; copied: boolean };

export async function kit(args: string[], io: Io, docker: RunDocker = dockerCli): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: false, options: {} });
  const [sub, registry] = positionals;

  if (sub !== "push") {
    activity(io, sub === undefined ? "jr2 kit: no subcommand" : `unknown kit subcommand: ${sub}`);
    activity(io, USAGE);
    return 2;
  }
  if (!registry) {
    activity(io, "jr2 kit push: no target registry");
    activity(io, USAGE);
    return 2;
  }

  // A trailing slash is the one spelling a human types and no registry accepts.
  const target = registry.replace(/\/+$/, "");

  // Both ends come out of `publishedKitRefs`: bare, it is the canonical home; given a registry, it
  // is what that registry re-homes the refs to — which is precisely what a converge with
  // `kitRegistry: <target>` will ask its nodes to pull. So the mirror cannot fill an address the
  // deployment does not read, and neither side of ADR-0044 can drift from the other.
  const sources = publishedKitRefs();
  const targets = publishedKitRefs(target);

  activity(io, `jr2 kit push — mirroring the v${KIT_VERSION} kit images to ${target}`);
  const rows: Mirrored[] = [];
  for (const image of Object.keys(KIT_IMAGES) as KitImageName[]) {
    rows.push(await mirror(io, docker, image, sources[image], targets[image]));
  }

  const copied = rows.filter((r) => r.copied).length;
  activity(io, `mirrored ${copied} image(s), ${rows.length - copied} already present`);
  result(io, {
    registry: target,
    version: KIT_VERSION,
    images: Object.fromEntries(rows.map((r) => [r.image, r.target])),
  });
  return 0;
}

/**
 * One image, skip-checked first. A published version tag never moves — the release train ties it to
 * one npm version (ADR-0019) — so a tag already resolving in the target is not merely present, it is
 * CURRENT, and re-copying it would buy nothing. That is also why this asks the target before the
 * source: the common repeat run costs one inspect and no transfer at all.
 */
async function mirror(
  io: Io,
  docker: RunDocker,
  image: KitImageName,
  source: string,
  target: string,
): Promise<Mirrored> {
  if (await resolves(docker, target)) {
    activity(io, `${image}: already present — ${target}`);
    return { image, source, target, copied: false };
  }
  await requireSource(docker, image, source, target);
  await docker(["buildx", "imagetools", "create", "-t", target, source]);
  activity(io, `${image}: copied ${source} → ${target}`);
  return { image, source, target, copied: true };
}

/** Does this ref resolve in its registry? `imagetools inspect` reads the manifest and nothing else,
 * so the question costs a metadata round-trip rather than a pull. Any failure reads as "not there":
 * a registry that cannot answer is one this command must not assume it has already filled, and the
 * copy that follows fails loudly enough for both cases. */
async function resolves(docker: RunDocker, ref: string): Promise<boolean> {
  try {
    await docker(["buildx", "imagetools", "inspect", ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The missing-source failure, named on both ends. It is the common case in a dev loop — the home has
 * nothing at `0.0.0`, and nothing ever will — so the message must not read as a broken mirror. What
 * it points at is the other arm of ADR-0044: `just kit-push`, in the checkout, is what puts images
 * at a published name in the first place; this command only moves what is already there.
 */
async function requireSource(docker: RunDocker, image: KitImageName, source: string, target: string): Promise<void> {
  if (await resolves(docker, source)) return;
  throw new Error(
    `${image}: ${source} is not there, so nothing can be mirrored to ${target}\n` +
      `  a kit image reaches ${target} only by being copied from its published home;\n` +
      `  if v${KIT_VERSION} was never published (a dev version never is), seed a registry from a kit\n` +
      `  checkout with \`just kit-push <registry>\`, which builds the three images from source`,
  );
}
