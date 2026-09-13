// The workflows' comments narrate the seam types they use, and nothing else checks that the
// narration agrees with the types the code writes. One claim here: every `Workspaced<…>` a workflow
// cites — in code or in prose — names the body's Repo Slots as its second argument (ADR-0051), the
// shape the compiler holds the code to; a slotless `Workspaced<RunInput>` in a comment is the
// retired shape, and a reader who copies it from the prose gets a compile error the prose denied.
// A cite that elides its arguments altogether (`Workspaced<…>`) names no shape and is left alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const workflows = new URL("../workflows/", import.meta.url);

/** The top-level arguments of one `Workspaced<…>` — nested `<…>` (e.g. `z.infer<typeof door>`) collapsed. */
const argsOf = (cite: string) => cite.replace(/<[^<>]*>/g, "").split(",");

test("every `Workspaced<…>` a workflow cites names the body's Repo Slots", () => {
  let cites = 0;
  for (const file of readdirSync(workflows).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(new URL(file, workflows), "utf8");
    for (const [, args] of source.matchAll(/Workspaced<((?:[^<>]|<[^<>]*>)*)>/g)) {
      if (/^(\.\.\.|…)$/.test(args!.trim())) continue;
      cites++;
      assert.equal(argsOf(args!).length, 2, `${file}: \`Workspaced<${args}>\` — the slots argument is required`);
    }
  }
  assert.ok(cites > 0, "the workflows cite `Workspaced` at least once");
});
