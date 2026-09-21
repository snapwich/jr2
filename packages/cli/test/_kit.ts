// Test instances live in the OS temp dir with no `node_modules`, so nothing resolves from them —
// and every Instance verb now refuses an Instance whose `@jr2/orchestrator` is not the copy the CLI
// runs against (ADR-0056). `linkKit` gives a temp instance the dependency a real one has: a symlink
// to this checkout's orchestrator, which is the same real path the CLI resolves through its own
// `node_modules`. `fakeKit` is the other side — a DIFFERENT copy, the shape the refusal exists for.

import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ORCHESTRATOR = fileURLToPath(new URL("../../orchestrator/", import.meta.url));

/** Resolve `@jr2/orchestrator` from `root` to this checkout's copy — the Instance's own dependency. */
export async function linkKit(root: string): Promise<void> {
  await mkdir(join(root, "node_modules", "@jr2"), { recursive: true });
  await symlink(await realpath(ORCHESTRATOR), join(root, "node_modules", "@jr2", "orchestrator"));
}

/** A second, unrelated copy of `name` at `version` under `root/node_modules` — real files, so its
 * real path can never equal the checkout's. `bin`, when given, is a `.js` body for `bin/jr2.js`. */
export async function fakeKit(root: string, name: string, version: string, bin?: string): Promise<string> {
  const dir = join(root, "node_modules", ...name.split("/"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "index.js"), "export {};\n");
  const manifest = {
    name,
    version,
    type: "module",
    exports: { ".": "./src/index.js" },
    ...(bin ? { bin: { jr2: "bin/jr2.js" } } : {}),
  };
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
  if (bin) {
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin", "jr2.js"), bin);
  }
  return dir;
}
