// Instance addressing (ADR-0009). Two concerns the HTTP client doesn't have: WHICH instance folder we
// are in, and WHERE its running orchestrator is.
//
//   - `resolveRoot` walks up from cwd to the dir holding `j2.config.ts` — the root marker (mirrors
//     flue's `flue.config.ts`). That dir owns `.j2/` (sqlite store + the dev server's address).
//   - `j2 dev` writes `.j2/dev.json` = { url, token, pid } on boot and removes it on exit; run-control
//     verbs read it to find the orchestrator to attach to, and to authenticate against it.
//   - `resolveBaseUrl` precedence: explicit `--url` > `J2_URL` env > `.j2/dev.json`. The first two
//     SKIP the folder walk entirely, so `j2 --url … runs` works from anywhere (e.g. against a cluster).
//   - `resolveTarget` adds the credential (ADR-0013): the run and gate surfaces are authenticated, so
//     a verb needs `{ url, token }`, not a url. `J2_TOKEN` overrides — that is how `--url` reaches an
//     orchestrator whose `.j2/` this shell cannot see.

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

export type DevInfo = { url: string; token?: string; pid: number };

/** Read `<root>/.j2/dev.json` (the live `j2 dev` address + token); undefined if absent/unreadable. */
export function readDevJson(root: string): DevInfo | undefined {
  try {
    return JSON.parse(readFileSync(join(root, ".j2", "dev.json"), "utf8")) as DevInfo;
  } catch {
    return undefined;
  }
}

/** Resolve the orchestrator base URL a run-control verb should talk to (see precedence above). */
export function resolveBaseUrl(io: Io, opts: { url?: string }): string {
  return resolveTarget(io, opts).url;
}

/** Where to talk, and as whom (ADR-0013). The Instance token is the human/CLI credential: it
 * opens gates and run control, and an Agent never holds it — it lives here, on the host. */
export function resolveTarget(io: Io, opts: { url?: string }): { url: string; token?: string } {
  const explicit = opts.url ?? io.env.J2_URL;
  if (explicit) return { url: explicit, token: io.env.J2_TOKEN };
  const root = resolveRoot(io.cwd);
  const dev = readDevJson(root);
  if (!dev) throw new Error("no running orchestrator — run `j2 dev` (or pass --url / set J2_URL)");
  return { url: dev.url, token: io.env.J2_TOKEN ?? dev.token };
}
