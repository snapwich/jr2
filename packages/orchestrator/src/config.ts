// Workflow author configuration: the repos a j2 deployment orchestrates, and (when the
// instance has a cluster) how Sandboxes are built.
//
// `defineConfig` is an identity passthrough — it exists solely so a `j2.config.ts` gets full
// type inference and checking against `J2Config` at authoring time, exactly like the config
// helpers in vite/tsup/etc. No runtime behavior beyond returning its argument.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type RepoConfig = {
  name: string;
  url: string;
  ref?: string;
};

/** How this instance builds Sandboxes (ADR-0012 / GAP(3)). Its PRESENCE is the switch: with it,
 * `j2 dev` reconciles `repos/` and wires the kubectl Sandbox backend; without it, the instance
 * is workspace-less (workspace() invocations fault pointedly). */
export type SandboxConfig = {
  /** The Harness image every Sandbox runs (one image, many personas — ADR-0001). */
  image: string;
  /** The Adapter image (ADR-0013): the sidecar that serves the Agent its MCP surface on localhost
   * and is the only thing in the pod holding an Orchestrator credential. Without it an Agent has
   * no route to its Machine at all — so a `workspace()` workflow whose Agent must ACT needs it. */
  adapterImage?: string;
  /** Kube namespace for Sandbox CRs. Default `default`. */
  namespace?: string;
  /** kubectl `--context` override. Default: the current context (ADR-0009). */
  context?: string;
  /** CR `spec.idleTimeout` — the operator's orphan-GC backstop. Default `30m`. */
  idleTimeout?: string;
};

export type J2Config = {
  repos: RepoConfig[];
  sandbox?: SandboxConfig;
};

/** Identity passthrough that pins a config object's type to `J2Config` for inference. */
export function defineConfig(c: J2Config): J2Config {
  return c;
}

/**
 * Load an instance's `j2.config.ts` (default export). Absent file → undefined (an instance
 * can boot configless); a file that fails to IMPORT throws — a broken config must be loud,
 * never silently treated as "no config".
 */
export async function loadConfig(dir: string): Promise<J2Config | undefined> {
  const file = join(dir, "j2.config.ts");
  if (!existsSync(file)) return undefined;
  const mod = (await import(pathToFileURL(file).href)) as { default?: J2Config };
  if (!mod.default) throw new Error(`${file} has no default export (use \`export default defineConfig({…})\`)`);
  return mod.default;
}
