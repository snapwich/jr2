// The door's `file:` refusal (ADR-0069): a context whose digest the image map does not hold. The
// door imports the Assembly from a staging path that is gone when its `422` arrives, so the line
// names the context relative to the Assembly and the Workflow that names it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assemblyRefusals } from "../src/assembly-checks.ts";
import { agent } from "../src/harness-client.ts";
import { jr2Setup } from "../src/setup.ts";
import { workspace } from "../src/workspace.ts";

function boxed(image: string) {
  const body = jr2Setup({
    events: [],
    actors: { coder: agent({ model: "vllm/qwen", instructions: "i" }) },
  }).createMachine({
    id: "body",
    initial: "working",
    states: { working: { invoke: { id: "coder", src: "coder", input: { prompt: "go" } } } },
  });
  return workspace(body, { image, repos: { app: "https://example.test/app.git" }, spec: () => ({ branch: "b" }) });
}

test("a `file:` context not in the image map is named relative to the Assembly, with its Workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "jr2-checks-"));
  const tree = join(root, ".staging-0123456789ab-dead", "tree");
  await mkdir(join(tree, "images", "box"), { recursive: true });
  await writeFile(join(tree, "images", "box", "Dockerfile"), "FROM scratch\n");
  const lines = await assemblyRefusals({
    config: undefined,
    workflows: [{ name: "build", machine: boxed(pathToFileURL(join(tree, "images", "box")).href) }],
    images: async () => ({ harness: "h", custodian: "c", sandbox: {} }),
    root: tree,
  });
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /^the Sandbox Image context images\/box that workflow "build" names \(digest [0-9a-f]{12}\)/);
  assert.ok(!lines[0]!.includes(".staging-"), "the staging path never reaches the report");
});
