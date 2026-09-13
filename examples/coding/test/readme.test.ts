// The README's runbook is executed by hand, so nothing else checks that its commands agree with
// the code they drive. Three claims here: every `j2 run … --input` it shows passes the named
// workflow's door (ADR-0033 — the `repo` field is an enum of URLS, ADR-0051, so a repo name is
// refused there), its `j2 up` narration lists the Machine walk where `j2 up` actually runs it
// — second, before any image is built (ADR-0051) — and every in-pod path it shows is keyed by a
// Repo Slot (ADR-0051).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inputSchemaOf, sandboxPartsOf } from "@j2/orchestrator";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("every `j2 run` in the README passes the named workflow's door", async () => {
  const runs = [...readme.matchAll(/^j2 run (\S+) --input '([^']*)'/gm)];
  assert.ok(runs.length > 0, "the runbook shows at least one `j2 run`");
  for (const [, workflow, json] of runs) {
    const { machine } = await import(`../workflows/${workflow}.ts`);
    const door = inputSchemaOf(machine);
    assert.ok(door, `${workflow} declares a door`);
    const parsed = door.safeParse(JSON.parse(json!));
    assert.ok(parsed.success, `j2 run ${workflow}: ${JSON.stringify(parsed.error?.issues)}`);
  }
});

test("the README's `j2 up` order puts the Machine walk before any image build", () => {
  const start = readme.indexOf("\nj2 up ");
  const narration = readme.slice(start, readme.indexOf("\n\n", start));
  const walk = narration.indexOf("the Machine walk");
  const firstImage = narration.indexOf("kit images");
  assert.ok(walk >= 0 && firstImage >= 0, "the narration names both layers");
  assert.ok(walk < firstImage, "the walk is narrated before the kit images");
});

// Every in-pod worktree path the runbook shows is keyed by a REPO SLOT the workflow declares
// (`/work/<slot>/<branch>`, the layout `attachScript` builds), never by the repository's name.
// The repo name is nowhere in that path, so a runbook that spells one sends the reader into a
// directory the pod does not have.
test("every `/work` path in the README names a Repo Slot the README's workflows declare", async () => {
  const workflows = new Set([...readme.matchAll(/^j2 run (\S+) /gm)].map(([, name]) => name!));
  assert.ok(workflows.size > 0, "the runbook runs at least one workflow");
  const slots = new Set<string>();
  for (const workflow of workflows) {
    const { machine } = await import(`../workflows/${workflow}.ts`);
    for (const slot of Object.keys(sandboxPartsOf(machine).repos ?? {})) slots.add(slot);
  }
  assert.ok(slots.size > 0, "those workflows declare at least one Repo Slot");

  const paths = [...readme.matchAll(/\/work\/([A-Za-z0-9._-]+)/g)];
  assert.ok(paths.length > 0, "the runbook shows at least one in-pod worktree path");
  for (const [path, dir] of paths) {
    assert.ok(slots.has(dir!), `${path}: "${dir}" is no Repo Slot — the slots are ${[...slots].join(", ")}`);
  }
});
