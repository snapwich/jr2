// The resolved key→ref image map, from the READ side (ADR-0037/0038/0049). `jr2 up` builds every
// image it deploys and writes this map into the `jr2-images` ConfigMap; the Sandbox port consults it
// when it creates a pod. This module is the shape both sides agree on — deliberately its own file,
// not folded into sandbox-kubectl.ts, because the CLI needs the type without dragging in the
// kubectl port.
//
// The map is NESTED, never flat. The kit's own `harness`/`adapter` refs sit beside a `sandbox`
// sub-map, so a user image can never shadow them — and `default` is the one reserved key in that
// sub-map, because ADR-0037's fallback chain is built on it.
//
// A user image's key is its build context's CONTENT DIGEST (ADR-0049). That is what lets the two
// sides agree without a path table: a Machine names its context as a `file:` URL, whose absolute
// path differs between the host at `jr2 up` and the baked Orchestrator, while the FOLDER is the same
// folder — the instance's `node_modules` holds the very tree the converge hashed. Digest in, digest
// out, no dirname registry in between.
//
// There is NO cache and NO memo for the map itself. The whole reason it arrives as a mounted
// ConfigMap rather than Deployment env (ADR-0038) is that a Dockerfile edit must not roll the
// Orchestrator and put every live run through snapshot restore; a read-once cache would give back
// exactly the stale-ref behavior the mount exists to avoid. The cost is a plain file read per
// provision.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every image ref one converge resolved. `harness`/`adapter` are the kit's own (built from a kit
 * checkout, or the published `<kitversion>` tags); `sandbox` is the instance's own docker-context
 * builds — one `docker build` straight to a content tag, carrying no jr2 layers at all, because the
 * Harness arrives at POD time on the `/opt/jr2` volume (ADR-0037).
 *
 * A registry REF is deliberately absent from this map and always will be: it is never built,
 * never labeled, never swept, and never inspected at converge (ADR-0037/0039 — what jr2 did not
 * stamp, jr2 does not touch). It needs no entry because it already IS its own ref.
 */
export type ImageRefs = {
  /** The stock Harness image — also the last leg of the Sandbox Image fallback chain. */
  harness: string;
  /** The Adapter image (ADR-0013). An Agent with no Adapter cannot drive its Machine at all, so
   * this is required: a map without it fails the provision rather than shipping a mute pod. */
  adapter: string;
  /** Built Sandbox Images by their build context's CONTENT DIGEST (ADR-0049), plus the reserved
   * key `default` — the Instance's `images/default`, ADR-0037's middle leg. Empty when the
   * instance ships no context and scaffolded no default. */
  sandbox: Record<string, string>;
  /**
   * What each BUILT Sandbox Image's `USER` is, keyed by the same key — the answer to a
   * question a provision cannot ask. ADR-0037 gives an image that declares no user a fallback
   * (uid 1000, `HOME=/home/jr2` on an emptyDir), and only the host that built the image can see
   * which case it is: `docker inspect` at converge is free, the cluster has no such reach.
   *
   * `""` is DATA, not a missing value: it is docker's own answer for "declares none", and it is
   * exactly what the fallback turns on. An ABSENT key means jr2 did not build the image — a
   * registry ref by construction, never built, never inspected — so it runs as whatever its own
   * `USER` says, and one that would run as root fails the Harness container's `runAsNonRoot`.
   * Optional so an older converge's map still reads: absent reads as "nothing known", which
   * applies no fallback, which is the safe direction (the image keeps its own identity).
   */
  sandboxUser?: Record<string, string>;
};

/**
 * Read the map the CLI wrote, per call. Absent or unparseable is a POINTED error naming the path
 * and `jr2 up` — never a fallback onto a published tag: in a kit checkout the Harness is built to a
 * content-addressed tag, so a literal `jr2-harness:<kitversion>` fallback would name a tag that was
 * never built, and more importantly it would be the eject hatch ADR-0027/0038 refuse (nobody gets
 * to run a hand-picked Harness against a real cluster).
 */
export async function readImageRefs(path: string): Promise<ImageRefs> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `no image map at ${path} (${(err as NodeJS.ErrnoException).code ?? "read failed"}) — every Sandbox ` +
        "image is resolved from the `jr2-images` ConfigMap, which `jr2 up` writes when it builds the " +
        "instance's images (ADR-0038). Converge this instance with `jr2 up`.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `the image map at ${path} is not JSON (${err instanceof Error ? err.message : err}) — it is written by ` +
        "`jr2 up`; re-run it to rewrite the `jr2-images` ConfigMap (ADR-0038).",
    );
  }
  const bad = (why: string): never => {
    throw new Error(`the image map at ${path} is malformed: ${why} — re-run \`jr2 up\` (ADR-0038).`);
  };
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) bad("expected a JSON object");
  const map = parsed as Record<string, unknown>;
  const ref = (key: string): string => {
    const value = map[key];
    if (typeof value !== "string" || !value) bad(`no \`${key}\` ref (got ${JSON.stringify(value)})`);
    return value as string;
  };
  const harness = ref("harness");
  // Required, not optional: with the ref living in the map there is no "no adapter configured"
  // branch left to gate on, and an Agent whose pod has no Adapter parks forever on a tool call it
  // cannot make (ADR-0013). Failing the provision is the only honest outcome.
  const adapter = ref("adapter");
  const sandboxRaw = map["sandbox"];
  if (sandboxRaw !== undefined && (typeof sandboxRaw !== "object" || sandboxRaw === null || Array.isArray(sandboxRaw)))
    bad("`sandbox` must be an object of name → ref");
  const sandbox: Record<string, string> = {};
  for (const [name, value] of Object.entries((sandboxRaw ?? {}) as Record<string, unknown>)) {
    if (typeof value !== "string" || !value) bad(`\`sandbox.${name}\` is not a ref (got ${JSON.stringify(value)})`);
    sandbox[name] = value as string;
  }
  const userRaw = map["sandboxUser"];
  if (userRaw !== undefined && (typeof userRaw !== "object" || userRaw === null || Array.isArray(userRaw)))
    bad("`sandboxUser` must be an object of name → USER");
  const sandboxUser: Record<string, string> = {};
  for (const [name, value] of Object.entries((userRaw ?? {}) as Record<string, unknown>)) {
    // `""` is admitted deliberately — it is docker's answer for "declares no USER", the fact the
    // fallback turns on. Only a non-string is malformed.
    if (typeof value !== "string") bad(`\`sandboxUser.${name}\` is not a USER (got ${JSON.stringify(value)})`);
    sandboxUser[name] = value as string;
  }
  return { harness, adapter, sandbox, sandboxUser };
}

/**
 * Which of ADR-0037's two origins an image string names, told apart by SHAPE alone: a `file:` URL
 * is a docker CONTEXT the Machine's module ships (`import.meta.resolve("./image")` — the only way
 * an ES module can name a folder it owns), and anything else is a registry REF.
 *
 * Shape is the whole test on purpose: it needs no lookup, so it gives the same answer on the CLI's
 * side and here. There is no third shape any more — the `images/<name>` dirname retired with
 * dirname discovery (ADR-0049/0050), so a bare `ubuntu` is now what it looks like, a ref.
 */
export function isImageContext(image: string): boolean {
  return image.startsWith("file:");
}

/**
 * The content address of a build context: everything in that directory, with NO exclusions — and
 * nothing else (ADR-0037/0038).
 *
 * It lives HERE, not in the CLI's build module, because BOTH sides compute it: `jr2 up` keys the
 * map it publishes by this digest, and the baked Orchestrator computes it again at provision to
 * look the ref up. One implementation is what makes "the host and the pod agree without a path
 * table" true rather than hopeful (ADR-0049).
 *
 * No exclusions is deliberate: that directory IS the build context and it carries no
 * `.dockerignore`, so a `dist/` or `node_modules/` beside the Dockerfile is image content and must
 * be image address. The resolved harness ref is likewise NOT an input — the Harness arrives on a
 * pod volume, so a kit edit moves the harness image's own tag and re-images future pods while
 * every Sandbox Image tag stands still.
 */
export async function imageContextDigest(dir: string): Promise<string> {
  const h = createHash("sha256");
  // A domain separator, and the whole of it: a Sandbox Image's build is `docker build` of the
  // user's own directory with no generated text anywhere in it, so — unlike the instance image,
  // whose generated Dockerfile is image content the context never holds — there is nothing to salt
  // WITH. The constant only keeps this hash's domain apart from the bundle's.
  h.update("salt:sandbox\n");
  const walk = async (root: string, d: string): Promise<void> => {
    const entries = (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(root, p);
      // Symlinks are skipped, as they are for every other content address jr2 takes: a link's
      // content is its target's path, which is host geography, not image content.
      else if (e.isFile()) {
        h.update(`0:${relative(root, p)}\n`);
        h.update(await readFile(p));
      }
    }
  };
  await walk(dir, dir);
  return h.digest("hex").slice(0, 12);
}

/**
 * The map key one image string resolves to: a CONTEXT is keyed by its content digest, a REF is its
 * own key and is never looked up. Absent is the reserved `default` key — ADR-0037's middle leg.
 *
 * A context whose folder is unreadable fails HERE, before a Secret or a CR exists, naming the path:
 * in a deployed Orchestrator that means the module shipped a context the instance bundle does not
 * hold, which is a packaging bug and not a cluster one.
 */
async function imageKey(image: string): Promise<string> {
  if (!isImageContext(image)) return image;
  const dir = fileURLToPath(image);
  try {
    return await imageContextDigest(dir);
  } catch (err) {
    throw new Error(
      `the Sandbox Image context ${image} cannot be read (${(err as NodeJS.ErrnoException).code ?? "read failed"}) — ` +
        "a `file:` image names a docker context the Machine's own module ships (ADR-0037), so it must travel " +
        `with the module: check that ${dir} exists in the instance's node_modules.`,
    );
  }
}

/**
 * One resolved Sandbox Image (ADR-0037): the ref the pod runs, plus the two seat facts only the
 * host that BUILT it could see. One call rather than three, because all three answers must come
 * off the same leg of the resolution chain — split, they could disagree.
 */
export type ResolvedImage = {
  /** The ref the primary container runs. */
  ref: string;
  /**
   * The image declares no `USER`, so ADR-0037's fallback seat applies: uid 1000 with
   * `HOME=/home/jr2` on an emptyDir.
   *
   * Only a recorded `""` — docker's own answer for "declares none" — sets this. Everything else is
   * false, and each for its own reason: a registry ref was never inspected (its own `USER` stands,
   * and a root one fails `runAsNonRoot` at provision, named from the pod's own status rather than
   * silently patched); the stock Harness declares `USER 1000` itself; and an unrecorded key is a
   * map an older converge wrote, where "nothing known" must leave the image's identity alone.
   */
  fallbackSeat: boolean;
  /**
   * The recorded `USER` the kubelet will REFUSE, when it will.
   *
   * Every jr2-owned seat carries `runAsNonRoot: true` and names no `runAsUser` (the image's own
   * `USER` decides — ADR-0005), and the kubelet resolves that pairing before it ever starts the
   * container. Two recorded values lose there: a non-numeric name (`USER dev`), which the kubelet
   * cannot prove is non-root because it does not read the image's `/etc/passwd`, and uid 0
   * (`USER root`, `USER 0`), which plainly is root.
   *
   * Both surface as CreateContainerConfigError on the FIRST init step that runs the image — the
   * preflight — and that container never starts, so `kubectl logs -c preflight` prints nothing. The
   * record is the one place that can see it coming: `docker inspect` at converge already put the
   * string in the map, so the provision can fail BEFORE it applies anything. Only a BUILT image is
   * knowable here; a registry ref was never inspected, so it answers undefined and that pod is
   * caught later, from the cluster (`rootImageFault` in sandbox-kubectl.ts) — same fault, same fix,
   * one round trip more expensive.
   */
  refusedUser?: string;
};

/** The recorded `USER`, judged. `uid:gid` is split because docker records the whole `USER` line;
 * only the uid half decides. */
function judgeUser(recorded: string | undefined): Pick<ResolvedImage, "fallbackSeat" | "refusedUser"> {
  // `""` is the fallback's trigger, not a failure (ADR-0037 supplies uid 1000); absent is unknown.
  if (recorded === undefined) return { fallbackSeat: false };
  if (recorded === "") return { fallbackSeat: true };
  const uid = recorded.split(":")[0]!;
  if (!/^\d+$/.test(uid) || Number(uid) === 0) return { fallbackSeat: false, refusedUser: recorded };
  return { fallbackSeat: false };
}

/**
 * Look one built key up in the map this converge wrote — for the Sandbox Image and the User
 * Container alike, because ADR-0005 gives the User Container "the same resolution" deliberately.
 *
 * An unknown key throws: a converge-time check is impossible for a ref and unnecessary for a
 * context (the walk built every one it found), so this fires when the Orchestrator's own
 * `node_modules` holds a context the LAST converge did not build — a stale deployment. The error
 * says exactly that, because "re-run `jr2 up`" is the whole fix.
 */
function builtRef(refs: ImageRefs, key: string, image: string, what: string): string {
  const ref = refs.sandbox[key];
  if (ref === undefined) {
    throw new Error(
      `no ${what} for ${image} (context digest ${key}) — this instance's last converge built ` +
        `${Object.keys(refs.sandbox).length} image(s), none of them this one. Re-run \`jr2 up\`: it walks the ` +
        "registered Machines and builds every `file:` context they carry (ADR-0037/0049).",
    );
  }
  return ref;
}

/**
 * ADR-0037's resolution chain: the wrapper's `image` (a context or a ref) → the Instance's
 * `images/default` → the stock Harness. The last leg comes out of the MAP rather than a
 * `jr2-harness:${KIT_VERSION}` literal, because in a kit checkout the Harness is built to a
 * content-addressed tag (ADR-0038) and a literal would name a tag nothing ever built.
 *
 * A REF passes through VERBATIM. It is deployed-never-built: jr2 never built it, so jr2 has no ref to
 * look up and nothing to say about its tag discipline — the cluster pulls it, and nothing was
 * inspected, so no seat fact is known.
 */
export async function resolveSandboxImage(refs: ImageRefs, image?: string): Promise<ResolvedImage> {
  if (image === undefined) {
    const ref = refs.sandbox["default"];
    if (ref === undefined) return { ref: refs.harness, fallbackSeat: false };
    return { ref, ...judgeUser(refs.sandboxUser?.["default"]) };
  }
  if (!isImageContext(image)) return { ref: image, fallbackSeat: false };
  const key = await imageKey(image);
  return { ref: builtRef(refs, key, image, "Sandbox Image"), ...judgeUser(refs.sandboxUser?.[key]) };
}

/**
 * The User Container's image (ADR-0005). Same two origins, same resolution — and NO fallback
 * chain: absence means the pod has no third container, so there is nothing for a default to be.
 * The seat's identity is "what jr2 does not own", and a jr2-chosen default would be an opinion in
 * the one place ADR-0005 promises none. Its `USER` is not judged either: the seat carries no
 * `securityContext` at all, so root is allowed there.
 */
export async function resolveUserImage(refs: ImageRefs, image: string): Promise<string> {
  if (!isImageContext(image)) return image;
  return builtRef(refs, await imageKey(image), image, "User Container image");
}
