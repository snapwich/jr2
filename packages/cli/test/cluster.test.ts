// `j2 cluster` — the kind/CRD orchestration against a fake process seam (real kind is the
// cluster e2e tier). Load-bearing bits: extraMounts baked into the generated config, existing
// clusters left alone loudly, the bundled CRD applied against the cluster's context.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cluster, kindConfig } from "../src/commands/cluster.ts";
import type { Io } from "../src/output.ts";

async function instanceIo(): Promise<{ io: Io; dir: string; out: string[]; err: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "j2-cluster-"));
  await writeFile(join(dir, "j2.config.ts"), "export default { repos: [] }\n");
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, cwd: dir }, dir, out, err };
}

function fakeExec(clusters: string[] = []) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    exec: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { stdout: cmd === "kind" && args[0] === "get" ? clusters.join("\n") : "" };
    },
  };
}

test("cluster up: writes the extraMounts kind config, creates, installs the CRD", async () => {
  const { io, dir, out } = await instanceIo();
  const { calls, exec } = fakeExec([]);

  assert.equal(await cluster(["up"], io, exec), 0);

  const written = await readFile(join(dir, ".j2", "kind.yaml"), "utf8");
  assert.match(written, /extraMounts:/);
  assert.match(written, new RegExp(`hostPath: ${join(dir, "repos")}`));
  assert.match(written, /containerPath: \/repos/);
  assert.match(written, /readOnly: true/);

  const create = calls.find((c) => c.cmd === "kind" && c.args[0] === "create");
  assert.ok(create, "kind create cluster ran");
  assert.deepEqual(create!.args.slice(0, 4), ["create", "cluster", "--name", "j2"]);
  const apply = calls.find((c) => c.cmd === "kubectl");
  assert.ok(apply!.args.join(" ").includes("--context kind-j2"), "CRD applied against the new cluster's context");
  assert.ok(apply!.args[apply!.args.length - 1]!.endsWith("sandbox-crd.yaml"));

  assert.deepEqual(JSON.parse(out.join("")).cluster, "j2");
});

test("cluster up: an existing cluster is left as-is (extraMounts are baked at creation)", async () => {
  const { io, err } = await instanceIo();
  const { calls, exec } = fakeExec(["j2"]);

  assert.equal(await cluster(["up"], io, exec), 0);
  assert.ok(!calls.some((c) => c.cmd === "kind" && c.args[0] === "create"));
  assert.match(err.join(""), /already exists/);
  assert.ok(
    calls.some((c) => c.cmd === "kubectl"),
    "CRD still (re)applied — apply is idempotent",
  );
});

test("cluster down deletes by name; unknown subcommand is usage", async () => {
  const { io } = await instanceIo();
  const { calls, exec } = fakeExec();
  assert.equal(await cluster(["down", "--name", "other"], io, exec), 0);
  assert.deepEqual(calls[0], { cmd: "kind", args: ["delete", "cluster", "--name", "other"] });
  assert.equal(await cluster(["sideways"], io, exec), 2);
});

test("kindConfig pins the mount the cluster cannot gain later", () => {
  const yaml = kindConfig("x", "/inst/repos");
  assert.match(yaml, /name: x/);
  assert.match(yaml, /hostPath: \/inst\/repos/);
});
