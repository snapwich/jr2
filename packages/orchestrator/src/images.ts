// The resolved name→ref image map, from the READ side (ADR-0037/0038). `j2 up` builds every image
// it deploys and writes this map into the `j2-images` ConfigMap; the Sandbox port consults it when
// it creates a pod. This module is the shape both sides agree on — deliberately its own file, not
// folded into sandbox-kubectl.ts, because the CLI needs the type without dragging in the kubectl
// port.
//
// The map is NESTED, never flat. `images/harness/Dockerfile` is a legal user image (nothing stops
// someone naming their Sandbox Image "harness"), and `images/default` is the name ADR-0037's
// fallback chain is built on — so user images must sit under their own `sandbox` key or a user
// image would shadow the kit's own refs.
//
// There is NO cache and NO memo here. The whole reason the map arrives as a mounted ConfigMap
// rather than Deployment env (ADR-0038) is that a Dockerfile edit must not roll the Orchestrator
// and put every live run through snapshot restore; a read-once cache would give back exactly the
// stale-ref behavior the mount exists to avoid. The cost is a plain file read per provision.

import { readFile } from "node:fs/promises";

/**
 * Every image ref one converge resolved. `harness`/`adapter` are the kit's own (built from a kit
 * checkout, or the published `<kitversion>` tags); `sandbox` is the instance's own
 * `images/<name>/Dockerfile` builds — one `docker build` straight to a content tag, carrying no j2
 * layers at all, because the Harness arrives at POD time on the `/opt/j2` volume (ADR-0037).
 *
 * A registry REF is deliberately absent from this map and always will be: it is never built,
 * never labeled, never swept, and never inspected at converge (ADR-0037/0039 — what j2 did not
 * stamp, j2 does not touch). It needs no entry because it already IS its own ref.
 */
export type ImageRefs = {
  /** The stock Harness image — also the last leg of the Sandbox Image fallback chain. */
  harness: string;
  /** The Adapter image (ADR-0013). An Agent with no Adapter cannot drive its Machine at all, so
   * this is required: a map without it fails the provision rather than shipping a mute pod. */
  adapter: string;
  /** Built Sandbox Images by `images/<name>` dirname. Empty when the instance authored none. */
  sandbox: Record<string, string>;
  /**
   * What each BUILT Sandbox Image's `USER` is, keyed by the same dirname — the answer to a
   * question a provision cannot ask. ADR-0037 gives an image that declares no user a fallback
   * (uid 1000, `HOME=/home/j2` on an emptyDir), and only the host that built the image can see
   * which case it is: `docker inspect` at converge is free, the cluster has no such reach.
   *
   * `""` is DATA, not a missing value: it is docker's own answer for "declares none", and it is
   * exactly what the fallback turns on. An ABSENT key means j2 did not build the image — a
   * registry ref by construction, never built, never inspected — so it runs as whatever its own
   * `USER` says, and one that would run as root fails the Harness container's `runAsNonRoot`.
   * Optional so an older converge's map still reads: absent reads as "nothing known", which
   * applies no fallback, which is the safe direction (the image keeps its own identity).
   */
  sandboxUser?: Record<string, string>;
};

/**
 * Read the map the CLI wrote, per call. Absent or unparseable is a POINTED error naming the path
 * and `j2 up` — never a fallback onto a published tag: in a kit checkout the Harness is built to a
 * content-addressed tag, so a literal `j2-harness:<kitversion>` fallback would name a tag that was
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
        "image is resolved from the `j2-images` ConfigMap, which `j2 up` writes when it builds the " +
        "instance's images (ADR-0038). Converge this instance with `j2 up`.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `the image map at ${path} is not JSON (${err instanceof Error ? err.message : err}) — it is written by ` +
        "`j2 up`; re-run it to rewrite the `j2-images` ConfigMap (ADR-0038).",
    );
  }
  const bad = (why: string): never => {
    throw new Error(`the image map at ${path} is malformed: ${why} — re-run \`j2 up\` (ADR-0038).`);
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
 * Which of ADR-0037's two origins a spec string names, told apart by SHAPE alone — a registry ref
 * contains `/` (a host or a namespace) or `:` (a tag), and an `images/<name>` dirname can contain
 * neither, because it is one path segment discovered from the filesystem. Shape is the whole test
 * on purpose: it needs no lookup, so it gives the same answer on the CLI's side and here, and a
 * bare `ubuntu` — no host, no tag — is read as a dirname, which is the safe direction (it fails
 * naming what was discovered, instead of silently pulling a stranger's `:latest`).
 */
export function isRegistryRef(name: string): boolean {
  return name.includes("/") || name.includes(":");
}

/**
 * Resolve one image NAME to a ref (ADR-0037), for the Sandbox Image and the User Container alike —
 * one function because ADR-0005 gives the User Container "the same resolution" deliberately.
 *
 * A REF passes through VERBATIM. It is deployed-never-built: j2 never built it, so j2 has no ref
 * to look up and nothing to say about its tag discipline — the cluster pulls it. A DIRNAME is
 * looked up in the map this converge wrote.
 *
 * An unknown dirname throws, listing what the converge actually discovered — a converge-time check
 * is impossible (workflow internals are not statically recoverable, the line ADR-0031 drew), so
 * provision is the first honest moment to fail, and the error has to say what the choices were.
 * It names BOTH origins, because "this name is not one of my folders" and "you meant a registry
 * ref and forgot the tag" are the two ways to arrive here.
 */
function resolveImageName(refs: ImageRefs, name: string, what: string): string {
  if (isRegistryRef(name)) return name;
  if (!Object.hasOwn(refs.sandbox, name)) {
    const known = Object.keys(refs.sandbox);
    throw new Error(
      `no ${what} named "${name}" — this instance built ${known.length ? known.map((n) => `"${n}"`).join(", ") : "none"} ` +
        `from \`images/<name>/Dockerfile\`. Add \`images/${name}/Dockerfile\` and re-run \`j2 up\`, ` +
        "or name a registry ref instead (a ref carries a `/` or a `:`; a dirname carries neither) — ADR-0037.",
    );
  }
  return refs.sandbox[name]!;
}

/**
 * ADR-0037's resolution chain: the spec's `image` (dirname or ref) → `images/default` → the stock
 * Harness. The last leg comes out of the MAP rather than a `j2-harness:${KIT_VERSION}` literal,
 * because in a kit checkout the Harness is built to a content-addressed tag (ADR-0038) and a
 * literal would name a tag nothing ever built.
 */
export function resolveSandboxImage(refs: ImageRefs, name?: string): string {
  if (name !== undefined) return resolveImageName(refs, name, "Sandbox Image");
  return refs.sandbox["default"] ?? refs.harness;
}

/**
 * Whether the image {@link resolveSandboxImage} would pick declares no `USER`, and so needs
 * ADR-0037's fallback seat: uid 1000 with `HOME=/home/j2` on an emptyDir.
 *
 * It reads the SAME leg of the chain the ref came from, so the two can never disagree. Everything
 * that is not a recorded `""` answers false, and each for its own reason: a registry ref was never
 * inspected (its own `USER` stands, and a root one fails `runAsNonRoot` at provision — named from
 * the pod's own status, not silently patched); the stock Harness declares `USER 1000` itself; and
 * an unrecorded name is a map an older converge wrote, where "nothing known" must leave the
 * image's identity alone.
 */
export function declaresNoUser(refs: ImageRefs, name?: string): boolean {
  const key = name ?? "default";
  if (isRegistryRef(key)) return false;
  return refs.sandboxUser?.[key] === "";
}

/**
 * The recorded `USER` the kubelet will REFUSE, or undefined when it will not.
 *
 * Every j2-owned seat carries `runAsNonRoot: true` and names no `runAsUser` (the image's own
 * `USER` decides — ADR-0005), and the kubelet resolves that pairing before it ever starts the
 * container. Two recorded values lose there: a non-numeric name (`USER dev`), which the kubelet
 * cannot prove is non-root because it does not read the image's `/etc/passwd`, and uid 0
 * (`USER root`, `USER 0`), which plainly is root.
 *
 * Both surface as CreateContainerConfigError on the FIRST init step that runs the image — the
 * preflight — and that container never starts, so `kubectl logs -c preflight` prints nothing. The
 * record is the one place that can see it coming: `docker inspect` at converge already put the
 * string in the map, so the provision fails BEFORE it applies anything and names the edit. Only a
 * BUILT image is knowable here; a registry ref was never inspected, so an absent key answers
 * undefined and that pod is caught later, from the cluster (`rootImageFault` in
 * sandbox-kubectl.ts) — same fault, same fix, one round trip more expensive.
 *
 * `uid:gid` is split because docker records the whole `USER` line; only the uid half is judged.
 */
export function unrunnableUser(refs: ImageRefs, name?: string): string | undefined {
  const key = name ?? "default";
  if (isRegistryRef(key)) return undefined;
  const recorded = refs.sandboxUser?.[key];
  // `""` is the fallback's trigger, not a failure (ADR-0037 supplies uid 1000); absent is unknown.
  if (recorded === undefined || recorded === "") return undefined;
  const uid = recorded.split(":")[0]!;
  if (!/^\d+$/.test(uid) || Number(uid) === 0) return recorded;
  return undefined;
}

/**
 * The User Container's image (ADR-0005). Same two origins, same resolution — and NO fallback
 * chain: absence means the pod has no third container, so there is nothing for a default to be.
 * The seat's identity is "what j2 does not own", and a j2-chosen default would be an opinion in
 * the one place ADR-0005 promises none.
 */
export function resolveUserImage(refs: ImageRefs, name: string): string {
  return resolveImageName(refs, name, "User Container image");
}
