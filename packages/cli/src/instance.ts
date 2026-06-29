// Instance addressing (ADR-0009). Two concerns the HTTP client doesn't have: WHICH instance folder we
// are in, and WHERE its running orchestrator is.
//
//   - `resolveRoot` walks up from cwd to the dir holding `j2.config.ts` — the root marker (mirrors
//     flue's `flue.config.ts`). That dir owns `.j2/` (sqlite store + the dev server's address).
//   - `j2 dev` writes `.j2/dev.json` = { url, pid } on boot and removes it on exit; run-control verbs
//     read it to find the orchestrator to attach to.
//   - `resolveBaseUrl` precedence: explicit `--url` > `J2_URL` env > `.j2/dev.json`. The first two
//     SKIP the folder walk entirely, so `j2 --url … runs` works from anywhere (e.g. against a cluster).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Io } from "./output.ts";

/** Walk up from `cwd` to the directory containing `j2.config.ts`; throws if there is none. */
export function resolveRoot(cwd: string): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, "j2.config.ts"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("not inside a j2 instance — no j2.config.ts found walking up from cwd");
    dir = parent;
  }
}

export type DevInfo = { url: string; pid: number };

/** Read `<root>/.j2/dev.json` (the live `j2 dev` address); undefined if absent or unreadable. */
export function readDevJson(root: string): DevInfo | undefined {
  try {
    return JSON.parse(readFileSync(join(root, ".j2", "dev.json"), "utf8")) as DevInfo;
  } catch {
    return undefined;
  }
}

/** Resolve the orchestrator base URL a run-control verb should talk to (see precedence above). */
export function resolveBaseUrl(io: Io, opts: { url?: string }): string {
  if (opts.url) return opts.url;
  if (io.env.J2_URL) return io.env.J2_URL;
  const root = resolveRoot(io.cwd);
  const dev = readDevJson(root);
  if (!dev) throw new Error("no running orchestrator — run `j2 dev` (or pass --url / set J2_URL)");
  return dev.url;
}
