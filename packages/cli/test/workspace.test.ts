// `jr2 workspace ls | shell | forward | rm` (ADR-0009, ADR-0012, ADR-0021): over the Sandbox CRs and
// kube alone, with a fake cluster. A handle is `<run-prefix>/<path>` or the CR's name; whether a run
// holds a Sandbox is the Lease's hold mark, and an idle keepalive is read on the server's clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";
import { SHELL_ENTRY, USER_SHELL, workspace } from "../src/commands/workspace.ts";
import type { Io } from "../src/output.ts";
import {
  idleTimeoutMs,
  matchHandle,
  rowOf,
  WorkspaceChangedError,
  type SandboxCR,
  type WorkspaceKube,
} from "../src/workspaces.ts";
import { workspaceLabel } from "@jr2/orchestrator/internal";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const RUN_A = "0b6c2f1e-1111-4222-8333-444455556666";
const RUN_B = "0b6c9999-1111-4222-8333-444455556666";

function cr(name: string, runId: string, path: string, notes: Record<string, string>, user = false): SandboxCR {
  return {
    metadata: {
      name,
      resourceVersion: `rv-${name}`,
      creationTimestamp: "2026-11-06T11:00:00Z",
      labels: { "jr2.dev/run": runId, "jr2.dev/workflow": "ticket", "jr2.dev/workspace": workspaceLabel(path) },
      annotations: { "jr2.dev/workspace-path": path, ...notes },
    },
    spec: { idleTimeout: "30m", ...(user ? { sidecars: [{ name: "user" }] } : {}) },
    status: { phase: "Ready" },
  };
}

const FRESH = { "jr2.dev/keepalive": "2026-11-06T11:59:00Z" };
const CRS = [
  cr("ws-live", RUN_A, "ws", { ...FRESH, "jr2.dev/hold": "held" }, true),
  cr("ws-ended", RUN_B, "ws", { ...FRESH, "jr2.dev/hold": "released" }),
  cr("ws-lapsed", RUN_B, "review/ws", { "jr2.dev/keepalive": "2026-11-06T11:00:00Z", "jr2.dev/hold": "held" }),
  cr("ws-nomark", RUN_B, "other", FRESH),
];

class FakeKube implements WorkspaceKube {
  deleted: string[] = [];
  /** The resourceVersion each delete named. */
  versions: Array<string | undefined> = [];
  /** A CR that a run placed again after `list`: its delete answers 409. */
  changed = new Set<string>();
  execs: Array<{ pod: string; container: string; argv: readonly string[]; tty: boolean }> = [];
  forwards: Array<{ pod: string; port: number }> = [];
  execCode = 0;
  closedForward = false;
  async context() {
    return "kind-jr2";
  }
  async list() {
    return { items: CRS, serverNow: NOW };
  }
  async delete(opts: { name: string; resourceVersion?: string }) {
    if (this.changed.has(opts.name)) throw new WorkspaceChangedError(opts.name);
    this.deleted.push(opts.name);
    this.versions.push(opts.resourceVersion);
  }
  async exec(opts: { pod: string; container: string; argv: readonly string[]; tty: boolean }) {
    this.execs.push({ pod: opts.pod, container: opts.container, argv: opts.argv, tty: opts.tty });
    return this.execCode;
  }
  async forward(opts: { pod: string; port: number }) {
    this.forwards.push({ pod: opts.pod, port: opts.port });
    return { port: 40123, close: () => (this.closedForward = true), closed: Promise.resolve(0) };
  }
}

function mkIo(kube: WorkspaceKube): { io: Io; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: {},
    cwd: "/",
    workspaces: kube,
  };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

test("the workspace label is a selector form of the path: legal characters, ≤63, a hash when cut", () => {
  assert.equal(workspaceLabel("review/ws"), "review-ws");
  assert.equal(workspaceLabel("pool/item #7/ws"), "pool-item--7-ws");
  const long = workspaceLabel(`${"a".repeat(80)}/ws`);
  assert.ok(long.length <= 63 && /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(long), long);
  assert.notEqual(long, workspaceLabel(`${"a".repeat(80)}/wz`));
});

test("a row's hold: the mark, an idle keepalive on the server's clock, or unknown", () => {
  assert.deepEqual(
    CRS.map((c) => rowOf(c, NOW).hold),
    ["held", "released", "idle", "unknown"],
  );
  assert.equal(rowOf(CRS[2]!, undefined).hold, "held", "no server clock: no keepalive is read");
});

test("a handle: the CR's name, <name>.jr2, or <run-prefix>/<path>; a short prefix can match two", () => {
  const rows = CRS.map((c) => rowOf(c, NOW));
  assert.deepEqual(
    matchHandle(rows, "ws-live").map((r) => r.name),
    ["ws-live"],
  );
  assert.deepEqual(
    matchHandle(rows, "ws-live.jr2").map((r) => r.name),
    ["ws-live"],
  );
  assert.deepEqual(
    matchHandle(rows, "0b6c9/review/ws").map((r) => r.name),
    ["ws-lapsed"],
  );
  assert.deepEqual(
    matchHandle(rows, "0b6c/ws").map((r) => r.name),
    ["ws-live", "ws-ended"],
  );
});

test("the idle timeout is a Go duration: 30m, 1h30m, 1h0m0s, 1.5h, 500ms; other text is unknown", () => {
  assert.equal(idleTimeoutMs("30m"), 1_800_000);
  assert.equal(idleTimeoutMs("1h30m"), 5_400_000);
  assert.equal(idleTimeoutMs("1h0m0s"), 3_600_000);
  assert.equal(idleTimeoutMs("1.5h"), 5_400_000);
  assert.equal(idleTimeoutMs("500ms"), 500);
  assert.equal(idleTimeoutMs(undefined), 1_800_000, "no value: the operator's default");
  assert.equal(idleTimeoutMs("30 minutes"), undefined);
  assert.equal(idleTimeoutMs(""), undefined);
});

test("a CR with no path prints <run-prefix>/<name>, and that handle names it", () => {
  const old = cr("ws-old", RUN_A, "", FRESH);
  delete old.metadata.annotations!["jr2.dev/workspace-path"];
  const row = rowOf(old, NOW);
  assert.equal(row.handle, "0b6c2f1e/ws-old");
  assert.deepEqual(
    matchHandle([row, ...CRS.map((c) => rowOf(c, NOW))], row.handle).map((r) => r.name),
    ["ws-old"],
  );
});

test("jr2 workspace ls lists every Workspace with its run's hold; [run] keeps one run's; --json", async () => {
  const kube = new FakeKube();
  const { io, out } = mkIo(kube);
  assert.equal(await main(["workspace", "ls", "-n", "inst"], io), 0);
  const lines = out().trim().split("\n");
  assert.match(lines[0]!, /^WORKSPACE\s+SANDBOX\s+WORKFLOW\s+PHASE\s+AGE\s+RUN$/);
  assert.match(out(), /0b6c2f1e\/ws\s+ws-live\s+ticket\s+Ready\s+60m\s+held/);
  assert.match(out(), /0b6c9999\/review\/ws\s+ws-lapsed\s+ticket\s+Ready\s+60m\s+idle/);

  const json = mkIo(kube);
  assert.equal(await main(["workspace", "ls", "0b6c2", "--json", "-n", "inst"], json.io), 0);
  const { workspaces } = JSON.parse(json.out()) as { workspaces: { name: string }[] };
  assert.deepEqual(
    workspaces.map((w) => w.name),
    ["ws-live"],
  );
});

test("jr2 workspace rm removes a released or idle Sandbox, and refuses a held one: cancel the run first", async () => {
  const kube = new FakeKube();
  for (const handle of ["ws-ended", "ws-lapsed"]) {
    const { io } = mkIo(kube);
    assert.equal(await main(["workspace", "rm", handle, "-n", "inst"], io), 0);
  }
  assert.deepEqual(kube.deleted, ["ws-ended", "ws-lapsed"]);
  assert.deepEqual(kube.versions, ["rv-ws-ended", "rv-ws-lapsed"], "each delete names the version it read");
  for (const handle of ["0b6c2f/ws", "ws-nomark"]) {
    const { io, err } = mkIo(kube);
    assert.equal(await main(["workspace", "rm", handle, "-n", "inst"], io), 1);
    assert.match(err(), /is not removed: .* — cancel the run first \(`jr2 send 0b6c\S+ --event CANCEL`\)/);
  }
  assert.deepEqual(kube.deleted, ["ws-ended", "ws-lapsed"], "nothing held is deleted");

  const { io, err } = mkIo(kube);
  assert.equal(await main(["workspace", "rm", "0b6c/ws", "-n", "inst"], io), 1);
  assert.match(err(), /"0b6c\/ws" names 2 Workspaces — give more of the run id:/);
});

test("jr2 workspace rm does not remove a Sandbox that changed after it was read: a run may hold it again", async () => {
  const kube = new FakeKube();
  kube.changed.add("ws-ended"); // a re-invoke placed the same name between the list and the delete
  const { io, err } = mkIo(kube);
  assert.equal(await main(["workspace", "rm", "ws-ended", "-n", "inst"], io), 1);
  assert.match(err(), /is not removed: it changed after it was read, so a run may hold it again/);
  assert.deepEqual(kube.deleted, []);
});

test("jr2 workspace shell starts the shell entry in the Harness container; -- runs one command; --user is -c user", async () => {
  const kube = new FakeKube();
  const { io } = mkIo(kube);
  assert.equal(await main(["workspace", "shell", "ws-live", "-n", "inst"], io), 0);
  assert.equal(await main(["workspace", "shell", "ws-live", "-n", "inst", "--", "git", "status"], io), 0);
  assert.equal(await main(["workspace", "shell", "ws-live", "--user", "-n", "inst"], io), 0);
  assert.deepEqual(kube.execs, [
    { pod: "ws-live", container: "harness", argv: SHELL_ENTRY, tty: true },
    { pod: "ws-live", container: "harness", argv: [...SHELL_ENTRY, "--", "git", "status"], tty: false },
    { pod: "ws-live", container: "user", argv: USER_SHELL, tty: true },
  ]);
  assert.match(SHELL_ENTRY.join(" "), /effector nocore --harness-env -- .*node .*workspace-shell-main\.ts$/);

  const none = mkIo(kube);
  assert.equal(await main(["workspace", "shell", "ws-ended", "--user", "-n", "inst"], none.io), 1);
  assert.match(none.err(), /has no User Container/);

  kube.execCode = 127;
  const noShell = mkIo(kube);
  assert.equal(await main(["workspace", "shell", "ws-live", "--user", "-n", "inst"], noShell.io), 127);
  assert.match(noShell.err(), /has no sh: give it a shell, or name a command after --/);
});

test("jr2 workspace forward prints the local address; --stdio carries one connection, <name>.jr2 as ssh's %h", async () => {
  const kube = new FakeKube();
  const { io, out } = mkIo(kube);
  assert.equal(await main(["workspace", "forward", "0b6c2f/ws", "8080", "-n", "inst"], io), 0);
  assert.equal(out(), "127.0.0.1:40123\n");

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const socket = Object.assign(new PassThrough(), {}) as unknown as import("node:net").Socket & EventEmitter;
  const connected: number[] = [];
  const done = workspace(["forward", "ws-live.jr2", "22", "--stdio", "-n", "inst"], mkIo(kube).io, {
    pipe: { stdin, stdout, connect: (p) => (connected.push(p), socket) },
  });
  await new Promise((r) => setTimeout(r, 5));
  socket.write("SSH-2.0-server\n");
  const got = await new Promise<string>((r) => stdout.once("data", (d: Buffer) => r(d.toString())));
  assert.equal(got, "SSH-2.0-server\n");
  socket.destroy();
  assert.equal(await done, 0);
  assert.deepEqual(connected, [40123]);
  assert.deepEqual(kube.forwards.at(-1), { pod: "ws-live", port: 22 });
  assert.equal(kube.closedForward, true, "the forward ends with the connection");
});

test("a SIGHUP to `workspace forward` (ssh ends its ProxyCommand so) ends the kubectl port-forward too", async () => {
  // The real `kubectlWorkspaces` against a fake `kubectl` on PATH: it lists one CR, then forwards
  // until it is killed, and says its pid.
  const dir = await mkdtemp(join(tmpdir(), "jr2-fwd-hup-"));
  try {
    const pidFile = join(dir, "pf.pid");
    const list = JSON.stringify({ items: [CRS[0]] });
    await writeFile(
      join(dir, "kubectl"),
      `#!/bin/sh
case "$*" in
  *port-forward*) echo $$ > ${pidFile}; echo "Forwarding from 127.0.0.1:45555 -> 8080"; exec sleep 300 ;;
  *" get "*) printf '%s' '${list}' ;;
  *) echo kind-jr2 ;;
esac
`,
      { mode: 0o755 },
    );
    const bin = fileURLToPath(new URL("../bin/jr2.js", import.meta.url));
    const child = spawn(process.execPath, [bin, "workspace", "forward", "ws-live", "8080", "-n", "inst"], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    for (let i = 0; i < 200 && !out.includes("127.0.0.1:45555"); i++) await sleep(25);
    assert.match(out, /127\.0\.0\.1:45555/);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    child.kill("SIGHUP");
    assert.equal(await exited, 129, "the verb exits as SIGHUP would have ended it");
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(pid, 0);
        await sleep(20);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "the port-forward ended with the verb");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
