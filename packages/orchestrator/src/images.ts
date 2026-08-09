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
 * `images/<name>/Dockerfile` builds, wrapped with the Harness runtime (ADR-0037).
 */
export type ImageRefs = {
  /** The stock Harness image — also the last leg of the Sandbox Image fallback chain. */
  harness: string;
  /** The Adapter image (ADR-0013). An Agent with no Adapter cannot drive its Machine at all, so
   * this is required: a map without it fails the provision rather than shipping a mute pod. */
  adapter: string;
  /** Wrapped Sandbox Images by `images/<name>` dirname. Empty when the instance authored none. */
  sandbox: Record<string, string>;
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
  return { harness, adapter, sandbox };
}

/**
 * ADR-0037's resolution chain: the spec's `image` name → `images/default` → the stock Harness.
 * The last leg comes out of the MAP rather than a `j2-harness:${KIT_VERSION}` literal, because in
 * a kit checkout the Harness is built to a content-addressed tag (ADR-0038) and a literal would
 * name a tag nothing ever built.
 *
 * An unknown name throws, listing what the converge actually discovered — a converge-time check is
 * impossible (workflow internals are not statically recoverable, the line ADR-0031 drew), so
 * provision is the first honest moment to fail, and the error has to say what the choices were.
 */
export function resolveSandboxImage(refs: ImageRefs, name?: string): string {
  if (name !== undefined) {
    if (!Object.hasOwn(refs.sandbox, name)) {
      const known = Object.keys(refs.sandbox);
      throw new Error(
        `no Sandbox Image named "${name}" — this instance built ${known.length ? known.map((n) => `"${n}"`).join(", ") : "none"} ` +
          "from `images/<name>/Dockerfile`. Add `images/" +
          name +
          "/Dockerfile` and re-run `j2 up`, or fix the name the workspace() spec passes (ADR-0037).",
      );
    }
    return refs.sandbox[name]!;
  }
  return refs.sandbox["default"] ?? refs.harness;
}
