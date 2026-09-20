// Instance addressing (ADR-0009/0019). Two concerns the HTTP client doesn't have: WHICH instance
// folder we are in, and WHERE its deployed orchestrator is.
//
//   - `resolveRoot` walks up from cwd to the dir holding `jr2.config.ts` — the root marker (mirrors
//     flue's `flue.config.ts`).
//   - `resolveTarget` finds the orchestrator. `--url` / `JR2_URL` (+ `JR2_TOKEN`) short-circuits
//     everything — the ingress-exposed/remote-caller escape hatch, no folder walk. Otherwise the
//     DEPLOYMENT is addressed by the current kube context + the instance's namespace (`-n` >
//     `config.name` > folder name): the Instance token is read from the in-cluster `jr2-instance`
//     Secret and the `jr2-orchestrator` Service is port-forwarded for the life of the command —
//     kube RBAC is the real gate, and no local state file can go stale (ADR-0019).
//   - Every resolution prints its target on stderr, so ambient-context drift stays visible.

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadConfig } from "@jr2/orchestrator";
import { INSTANCE_SECRET, kubectlKube, ORCHESTRATOR_PORT, ORCHESTRATOR_SERVICE } from "./kube.ts";
import { activity, type Io } from "./output.ts";

/** Walk up from `cwd` to the directory containing `jr2.config.ts`; `undefined` if there is none. */
export function findRoot(cwd: string): string | undefined {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, "jr2.config.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** `findRoot`, for the callers that cannot proceed without one. */
export function resolveRoot(cwd: string): string {
  const root = findRoot(cwd);
  if (!root) throw new Error("not inside a jr2 instance — no jr2.config.ts found walking up from cwd");
  return root;
}

/** Where to talk, as whom, and how to hang up (the port-forward lives only as long as the verb). */
export type Target = { url: string; token?: string; close?: () => void };

export type TargetOptions = {
  /** Explicit orchestrator address (`--url`); with `JR2_URL` the escape hatch past the kube path. */
  url?: string;
  /** Kube namespace override (`-n`). Default: `config.name`, then the instance folder's name. */
  namespace?: string;
  /** Kube context override (`--context`). Default: the current kubectl context. */
  context?: string;
};

/** The parseArgs options every run-verb shares — how a target is addressed (ADR-0019). */
export const TARGET_ARGS = {
  url: { type: "string" },
  namespace: { type: "string", short: "n" },
  context: { type: "string" },
} as const;

/** Pull the target-addressing flags out of a strict:false parseArgs `values` bag. */
export function targetOptions(values: Record<string, unknown>): TargetOptions {
  return {
    url: values.url as string | undefined,
    namespace: values.namespace as string | undefined,
    context: values.context as string | undefined,
  };
}

/** Resolve the orchestrator a run-verb talks to (see the module doc for the full story). */
export async function resolveTarget(io: Io, opts: TargetOptions): Promise<Target> {
  const explicit = opts.url ?? io.env.JR2_URL;
  if (explicit) {
    activity(io, `→ ${explicit}`);
    return { url: explicit, token: io.env.JR2_TOKEN };
  }

  const root = resolveRoot(io.cwd);
  const config = await loadConfig(root);
  const namespace = opts.namespace ?? config?.name ?? basename(root);
  const kube = io.kube ?? kubectlKube;
  const context = opts.context ?? (await kube.currentContext());
  if (!context) {
    throw new Error("no kube context — `kind create cluster` (or point kubectl at one), then `jr2 up`");
  }
  activity(io, `→ context ${context} / namespace ${namespace}`);

  const ctx = opts.context ? { context: opts.context } : {};
  const token =
    io.env.JR2_TOKEN ??
    (await kube.readSecret({ namespace, name: INSTANCE_SECRET, key: "JR2_INSTANCE_TOKEN", ...ctx }));
  if (!token) {
    throw new Error(
      `not deployed here — right context? (context ${context}, namespace ${namespace}; \`jr2 up\` deploys)`,
    );
  }
  const fwd = await kube.portForward({ namespace, service: ORCHESTRATOR_SERVICE, port: ORCHESTRATOR_PORT, ...ctx });
  return { url: fwd.url, token, close: fwd.close };
}
