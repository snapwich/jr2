// `jr2 completion bash|zsh|fish` (ADR-0009): a script that asks `jr2 completion __complete` for each
// completion, which answers from the command table, and from the deployment for Workspace handles,
// live run ids, Workflow names and a run's Agent slots — each lookup bounded at 2 s.

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.ts";
import { bounded, complete, completion, type Lookup } from "../src/commands/completion.ts";
import { COMMANDS } from "../src/command-table.ts";
import type { Io } from "../src/output.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkKit } from "./_kit.ts";

function mkIo(): { io: Io; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, cwd: "/" };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

const asked: Array<{ kind: string; run?: string; namespace?: string }> = [];
const lookup: Lookup = async (kind, ctx) => {
  asked.push({ kind, ...(ctx.run ? { run: ctx.run } : {}), ...(ctx.namespace ? { namespace: ctx.namespace } : {}) });
  if (kind === "run") return ["0b6c2f1e-1111", "77aa0000-2222"];
  if (kind === "workflow") return ["ticket", "release"];
  if (kind === "agent") return ["root/planner", "root.ws/coder"];
  return ["0b6c2f1e/ws", "ws-live"];
};

test("verbs, sub-verbs and flags come from the command table, and nothing else", async () => {
  assert.deepEqual(await complete([""], lookup), [...new Set(COMMANDS.map((c) => c.verb))]);
  assert.deepEqual(await complete(["wo"], lookup), ["workflows", "workspace"]);
  assert.deepEqual(await complete(["works"], lookup), ["workspace"]);
  assert.deepEqual(await complete(["workspace", ""], lookup), ["ls", "shell", "forward", "rm"]);
  assert.deepEqual(await complete(["workspace", "shell", "x", "--u"], lookup), ["--user"]);
  assert.deepEqual(await complete(["logs", "--f"], lookup), ["--follow"]);
  assert.deepEqual(await complete(["nope", ""], lookup), []);
  assert.deepEqual(await complete(["runs", "--status", "e"], lookup), ["ended", "error"]);
});

test("dynamic values: run ids, Workflow names, a run's Agent slots, Workspace handles with -n", async () => {
  asked.length = 0;
  assert.deepEqual(await complete(["logs", "0b"], lookup), ["0b6c2f1e-1111"]);
  assert.deepEqual(await complete(["run", ""], lookup), ["ticket", "release"]);
  assert.deepEqual(await complete(["gates", "--workflow", "t"], lookup), ["ticket"]);
  assert.deepEqual(await complete(["steer", "0b6c2f1e-1111", "root/"], lookup), ["root/planner"]);
  assert.deepEqual(await complete(["logs", "-f", "0b6c2f1e-1111", ""], lookup), ["root/planner", "root.ws/coder"]);
  assert.deepEqual(await complete(["workspace", "rm", "-n", "inst", "ws"], lookup), ["ws-live"]);
  assert.deepEqual(await complete(["completion", ""], lookup), ["bash", "zsh", "fish"]);
  assert.deepEqual(
    await complete(["workspace", "shell", "ws-live", "--", ""], lookup),
    [],
    "after -- it is the command's",
  );
  assert.deepEqual(asked, [
    { kind: "run" },
    { kind: "workflow" },
    { kind: "workflow" },
    { kind: "agent", run: "0b6c2f1e-1111" },
    { kind: "agent", run: "0b6c2f1e-1111" },
    { kind: "workspace", namespace: "inst" },
  ]);
});

test("a lookup over its budget, or one that fails, offers nothing", async () => {
  const slow = new Promise<string[]>((r) => setTimeout(() => r(["late"]), 200));
  assert.deepEqual(await bounded(slow, 20), []);
  assert.deepEqual(await bounded(Promise.reject(new Error("no cluster")), 20), []);
  assert.deepEqual(await bounded(Promise.resolve(["fast"]), 20), ["fast"]);
});

test("jr2 completion <shell> prints a script that asks `jr2 completion __complete`; an unknown shell is usage", async () => {
  for (const shell of ["bash", "zsh", "fish"]) {
    const { io, out } = mkIo();
    assert.equal(await main(["completion", shell], io), 0);
    assert.match(out(), /jr2 completion __complete/);
  }
  const { io, err } = mkIo();
  assert.equal(await main(["completion", "tcsh"], io), 2);
  assert.match(err(), /usage: jr2 completion <shell>/);
});

test("`__complete` prints one candidate a line, and is never read as a help request", async () => {
  const { io, out } = mkIo();
  let exited: number | undefined;
  await completion(["__complete", "workspace", ""], io, { lookup, exit: (c) => (exited = c) });
  assert.equal(out(), "ls\nshell\nforward\nrm\n");
  assert.equal(exited, 0);
  const help = mkIo();
  await completion(["__complete", "steer", "-h"], help.io, { lookup, exit: () => {} });
  assert.equal(help.out(), "");
});

test("a lookup past its budget closes the forward to the Orchestrator that it holds, before the exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "jr2-complete-slow-"));
  try {
    await writeFile(join(root, "jr2.config.ts"), "export default {};\n");
    await linkKit(root);
    let closed = 0;
    const io: Io = {
      stdout: () => {},
      stderr: () => {},
      env: {},
      cwd: root,
      kube: {
        currentContext: async () => "kind-test",
        readSecret: async () => "tok",
        portForward: async () => ({ url: "http://127.0.0.1:1", close: () => closed++ }),
        selfSubject: async () => undefined,
      },
      // An Orchestrator that never answers.
      fetch: () => new Promise<Response>(() => {}),
    };
    let exited: number | undefined;
    await completion(["__complete", "logs", ""], io, { exit: (c) => (exited = c), budgetMs: 50 });
    assert.equal(exited, 0);
    assert.equal(closed, 1, "the forward is closed when the budget passes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
