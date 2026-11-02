// The folders where a bare require() looks last (ADR-0076): node's `Module.globalPaths`. node fills
// them once, at its start, from HOME (`$HOME/.node_modules`, `$HOME/.node_libraries`), NODE_PATH
// and its own prefix (`<prefix>/lib/node`), and a later change of HOME does not change them. A
// module that a provider loads lazily, on its first Turn, can miss in `node_modules` and fall
// through to them (pi-ai's Bedrock path asks for `supports-color`, its Google path for
// `bufferutil`). The domain writes its own HOME, so a folder there would run the domain's code in
// the Harness process, with the control Stand-in in its memory.
//
// `effector nocore --harness-env` starts node with HOME=/run/jr2/home and no NODE_PATH, so each
// entry is under `/run/jr2` or `/opt/jr2`. This check makes that a mechanism: the Harness refuses
// to run when an entry is anywhere else (`module-paths-guard.ts`, the first import of `main.ts`).

import { createRequire } from "node:module";

/** The folders that no process of the domain writes: jr2's runtime volume, and jr2's own folder,
 * which the domain cannot write (ADR-0076). */
export const TRUSTED_MODULE_ROOTS: readonly string[] = ["/opt/jr2", "/run/jr2"];

/** Why `paths` let a bare require() load a module from a folder outside `roots`, or undefined. */
export function globalPathsFault(
  paths: readonly string[],
  roots: readonly string[] = TRUSTED_MODULE_ROOTS,
): string | undefined {
  const outside = paths.filter((p) => !roots.some((root) => p === root || p.startsWith(`${root}/`)));
  if (outside.length === 0) return undefined;
  return (
    `node looks for modules in ${outside.join(", ")}, outside ${roots.join(" and ")}: a module that the ` +
    "Agent's code puts there would run in the Harness process. Start the Harness with " +
    "`effector nocore --harness-env`, which gives node HOME=/run/jr2/home and no NODE_PATH (ADR-0076)"
  );
}

/** This process's `Module.globalPaths`. */
export function globalPaths(): readonly string[] {
  const Module = createRequire(import.meta.url)("node:module") as { globalPaths?: readonly string[] };
  return Module.globalPaths ?? [];
}
