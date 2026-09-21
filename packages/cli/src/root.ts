// The Instance root walk (ADR-0009): up from `cwd` to the directory holding `jr2.config.ts`, the
// root marker. Its own module — builtins only — because the launcher runs it BEFORE it knows which
// `jr2` will run (ADR-0056), so nothing here may import the kit.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

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
