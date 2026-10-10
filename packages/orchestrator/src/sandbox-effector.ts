// A Workspace's Sandbox Effector, as `jr2 up` declares it and the provision makes it (ADR-0068,
// B5.1, B8): the same split as the Custodian's. `jr2 up` reads the Machines, places each Effect
// secret, and writes two objects per Workspace that places an Effect there:
//
//   - the Secret `jr2-effector-<pod>`: each literal Effect secret, each push token, and
//     `effector.json` (the targets its uploads call and the `git.credentials` entries its pushes
//     spend, each credential by directory);
//   - the manifest `effector-<pod>.json` in `jr2-held`: names only, never a value — the projected
//     sources that make the Effector's `/run/jr2/secrets`: that Secret's keys, each `valueFrom`
//     key of the user's own Secret by reference, and each key of a deploy-key or signing-key Secret
//     a push spends, at `@git/<dir>/<file>` — a directory no secret's file can take, since `@` is
//     no character of a secret's name (SECRET_NAME).
//
// The provision reads the pod's manifest, as it reads its Held manifest, and adds the `effector`
// container only when one is there: a Workspace with no such Effect gets no sidecar and no Secret.
// The per-pod key is derived from the Sandbox's name at provision (`effectorKey`), as the Sandbox
// token is, and written into a Secret the Sandbox CR owns.

import { readFile } from "node:fs/promises";
import type { SandboxEffectorPlan } from "./secret-placement.ts";

/** The Secret `jr2 up` writes per Workspace for its Sandbox Effector. */
export const sandboxEffectorSecret = (workspacePod: string): string => `jr2-effector-${workspacePod}`;
/** The `jr2-held` key of one Workspace's Sandbox Effector manifest. */
export const effectorManifestKey = (workspacePod: string): string => `effector-${workspacePod}.json`;
/** The Secret the provision writes per Sandbox with its Effector's key, owned by the CR. */
export const sandboxEffectorKeySecret = (sandbox: string): string => `${sandbox}-effector`;
/**
 * The headless Service the provision writes per Sandbox for its Effector, owned by the CR: how the
 * Orchestrator reaches it. Its name resolves to the pod's own address, which a request is signed
 * for (`POD_IP:port`, ADR-0068); the operator's Service names the Harness's port only. A Sandbox's
 * name always starts `ws-` and is at most 63 characters (`workspaceName`), so `fx-` in its place
 * keeps the name unique, as long, and apart from the operator's Service.
 */
export const sandboxEffectorService = (sandbox: string): string =>
  sandbox.startsWith("ws-") ? `fx-${sandbox.slice(3)}` : `fx-${sandbox}`.slice(0, 63);
/** The label every `jr2-effector-<pod>` Secret carries: its pod key, so a stale one is found. */
export const LABEL_EFFECTOR_POD = "jr2.dev/effector-pod";

/** One projected-volume source: a Secret's keys at paths. Kubernetes' own shape. */
export type ProjectedSecret = { secret: { name: string; items: Array<{ key: string; path: string }> } };

/** What the provision reads for one Workspace's Sandbox Effector. Names only. */
export type SandboxEffectorManifest = {
  version: 1;
  /** The Secret that holds `effector.json` (and the literals). */
  secret: string;
  /** The sources of `/run/jr2/secrets`. */
  sources: ProjectedSecret[];
};

const secretKey = (name: string): string => `secret.${name}`;
const gitKey = (dir: string, file: string): string => `git.${dir}.${file}`;
/**
 * Where the push credentials sit in `/run/jr2/secrets`: a secret's file is its name, and a name
 * holds only `[A-Za-z0-9._-]`, so no secret — one named `git` included — takes this directory.
 */
export const SANDBOX_EFFECTOR_GIT_DIR = "@git";
const gitPath = (dir: string, file: string): string => `${SANDBOX_EFFECTOR_GIT_DIR}/${dir}/${file}`;

/** The two objects `jr2 up` writes for one plan: the Secret's data and the manifest. */
export function sandboxEffectorObjectsOf(plan: SandboxEffectorPlan): {
  secret: { name: string; stringData: Record<string, string> };
  manifest: SandboxEffectorManifest;
} {
  const name = sandboxEffectorSecret(plan.pod);
  const config = { version: 1, placement: "sandbox", targets: plan.targets, git: plan.git };
  const stringData: Record<string, string> = { "effector.json": JSON.stringify(config, null, 2) };
  const own: Array<{ key: string; path: string }> = [];
  for (const s of plan.secrets) {
    if (s.source.kind !== "literal") continue;
    stringData[secretKey(s.name)] = plan.values[s.name] ?? "";
    own.push({ key: secretKey(s.name), path: s.name });
  }
  for (const f of plan.gitFiles) {
    if (f.source.kind !== "literal") continue;
    stringData[gitKey(f.dir, f.file)] = f.source.value;
    own.push({ key: gitKey(f.dir, f.file), path: gitPath(f.dir, f.file) });
  }
  const byRef = new Map<string, Array<{ key: string; path: string }>>();
  const add = (secret: string, key: string, path: string) =>
    byRef.set(secret, [...(byRef.get(secret) ?? []), { key, path }]);
  for (const s of plan.secrets) if (s.source.kind === "secret") add(s.source.secret, s.source.key, s.name);
  for (const f of plan.gitFiles)
    if (f.source.kind === "secret") add(f.source.secret, f.source.key, gitPath(f.dir, f.file));
  const sources: ProjectedSecret[] = [
    ...(own.length ? [{ secret: { name, items: own } }] : []),
    ...[...byRef].map(([secret, items]) => ({ secret: { name: secret, items } })),
  ];
  return { secret: { name, stringData }, manifest: { version: 1, secret: name, sources } };
}

/** The pod's manifest, or undefined when `jr2 up` placed no Effect in its Sandbox Effector. */
export async function readSandboxEffectorManifest(path: string): Promise<SandboxEffectorManifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as SandboxEffectorManifest;
  if (parsed.version !== 1 || typeof parsed.secret !== "string" || !Array.isArray(parsed.sources)) {
    throw new Error(`${path} is not a Sandbox Effector manifest jr2 reads (version 1)`);
  }
  return parsed;
}
