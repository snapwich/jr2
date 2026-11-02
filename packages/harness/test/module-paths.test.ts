// The folders where a bare require() looks last (ADR-0076, `module-paths.ts`): the Harness refuses
// to run when node would look for a module outside jr2's folders, because the domain writes its own
// HOME, and node fills those folders from HOME once, at its start.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalPathsFault } from "../src/module-paths.ts";

test("globalPathsFault: an entry outside /opt/jr2 and /run/jr2 is a fault that names it", () => {
  assert.equal(
    globalPathsFault(["/run/jr2/home/.node_modules", "/run/jr2/home/.node_libraries", "/opt/jr2/lib/node"]),
    undefined,
  );
  const fault = globalPathsFault(["/home/jr2/.node_modules", "/home/jr2/.node_libraries", "/opt/jr2/lib/node"]);
  assert.match(fault ?? "", /node looks for modules in \/home\/jr2\/\.node_modules, \/home\/jr2\/\.node_libraries,/);
  assert.match(fault ?? "", /ADR-0076/);
  // A folder that only starts with a trusted root's name is not under it; NODE_PATH's are refused too.
  assert.ok(globalPathsFault(["/opt/jr2x/lib/node"]) !== undefined);
  assert.ok(globalPathsFault(["/app/node_modules", "/opt/jr2/lib/node"]) !== undefined);
});

// The guard is `main.ts`'s first import: a node whose HOME is a folder that the domain writes does
// not run the Harness. (This host's node is outside /opt/jr2 too, which the fault also names.)
test("the guard ends a process whose node looks for modules under a HOME of the domain's", () => {
  const home = mkdtempSync(join(tmpdir(), "jr2-domain-home-"));
  const guard = new URL("../src/module-paths-guard.ts", import.meta.url).href;
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(guard)}); console.log("RAN")`],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    },
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /RAN/);
  assert.match(r.stderr, new RegExp(`jr2 harness: node looks for modules in ${home}/\\.node_modules`));
});
