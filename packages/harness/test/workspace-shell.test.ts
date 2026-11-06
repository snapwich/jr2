// `jr2 workspace shell` in the pod (ADR-0076, ADR-0009): the client asks the Harness, and the
// Harness starts the shell through its one spawner, in the real Landlock domain on this host's
// kernel. The shell is a process of the domain: it signals an Agent's process, it cannot read the
// control Stand-in or any file under the folder that stands for `/run/jr2`, it gets the Stand-ins
// that the `workspace()` grants and no other, and the domain's umask. A client that cannot prove
// that it read the control Stand-in starts nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { ChildPolicy } from "../src/children.ts";
import { serveShells, shellClient, shellProof } from "../src/workspace-shell.ts";
import { deniedDir, testChildren } from "./support/children.ts";

// The Harness sets umask 002 before it starts its spawner (startup.ts); the domain inherits it.
process.umask(0o002);

const CONTROL = "jr2c_the-control-stand-in";

/** A pod in small: a `/run/jr2` with the control Stand-in's file, a domain that denies it, a work
 * root, and the Harness's shell socket. */
async function pod(opts: { standIns?: Map<string, string>; granted?: string[]; work?: boolean } = {}) {
  const runJr2 = deniedDir("run-jr2-");
  mkdirSync(join(runJr2, "control"), { recursive: true });
  const control = join(runJr2, "control", "standin");
  writeFileSync(control, `${CONTROL}\n`);
  const root = mkdtempSync(join(tmpdir(), "jr2-shell-"));
  const work = join(root, "work");
  const home = join(root, "home");
  mkdirSync(home);
  if (opts.work !== false) mkdirSync(work);
  const children = testChildren({
    home,
    work: opts.work === false ? join(root, "absent") : work,
    control: CONTROL,
    deny: [runJr2],
    ...(opts.standIns ? { standIns: opts.standIns } : {}),
    ...(opts.granted ? { granted: opts.granted } : {}),
    env: { JR2_HARNESS_TOKEN_SHA256: "x" },
  });
  const socket = join(mkdtempSync(join(tmpdir(), "jr2-shell-sock-")), "shell", "shell.sock");
  const served = await serveShells({ children: () => children, control: CONTROL, socket, work });
  return { control, work, home, children, socket, served };
}

/** Run one client to its end, with no terminal unless `tty` is given. */
async function run(
  p: { socket: string },
  argv: string[],
  opts: { proof?: string; tty?: { rows: number; cols: number }; input?: string } = {},
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (d: Buffer) => (out += d.toString()));
  stderr.on("data", (d: Buffer) => (err += d.toString()));
  const client = shellClient({
    socket: p.socket,
    proof: opts.proof ?? shellProof(CONTROL),
    argv,
    ...(opts.tty ? { tty: opts.tty } : {}),
    stdin,
    stdout,
    stderr,
  });
  if (opts.input !== undefined) stdin.write(opts.input);
  stdin.end();
  const code = await client.done;
  return { code, out: () => out, err: () => err };
}

function close(p: { children: ChildPolicy; served: { close: () => Promise<void> } }) {
  p.children.spawner.close();
  return p.served.close();
}

test("the shell is a process of the domain: the spawner's child, it ends an Agent's process, it cannot read the control Stand-in", async () => {
  const p = await pod();
  try {
    // An Agent's process, as `bash` starts it.
    const agent = p.children.spawner.spawn({ argv: ["sleep", "100"], env: p.children.env, cwd: p.work });
    const agentPid = await agent.started;
    const r = await run(p, ["sh", "-c", `cat ${p.control}; echo "ppid=$PPID"; kill ${agentPid}; echo "cwd=$PWD"`]);
    assert.doesNotMatch(r.out(), /the-control-stand-in/);
    assert.match(r.err(), /Permission denied|not permitted/);
    assert.match(r.out(), new RegExp(`ppid=${p.children.spawner.pid}\\n`), "started by the spawner, in its domain");
    assert.match(r.out(), new RegExp(`cwd=${p.work}\\n`), "in the Workspace's folder");
    assert.deepEqual(await agent.exited, { code: null, signal: "SIGTERM" }, "the shell ended an Agent's process");
  } finally {
    await close(p);
  }
});

test("a shell gets the Stand-ins that the workspace() grants, no other, no JR2_ name, and the domain's umask", async () => {
  const p = await pod({
    standIns: new Map([
      ["GITHUB_TOKEN", "jr2s_granted"],
      ["ANTHROPIC_API_KEY", "jr2s_withheld"],
    ]),
    granted: ["GITHUB_TOKEN"],
  });
  try {
    const r = await run(p, ["sh", "-c", "env; echo umask=$(umask)"]);
    assert.equal(r.code, 0, r.err());
    assert.match(r.out(), /^GITHUB_TOKEN=jr2s_granted$/m);
    assert.doesNotMatch(r.out(), /jr2s_withheld|the-control-stand-in/);
    assert.doesNotMatch(r.out(), /^JR2_/m);
    assert.match(r.out(), /^umask=0?002$/m, "files that a person makes are group-writable (ADR-0005)");
  } finally {
    await close(p);
  }
});

test("a client that does not prove it read the control Stand-in starts nothing", async () => {
  const p = await pod();
  try {
    const marker = join(p.work, "made");
    const r = await run(p, ["touch", marker], { proof: shellProof("jr2c_a-guess") });
    assert.equal(r.code, 126);
    assert.match(r.err(), /refused: the client did not prove that it reads the control Stand-in/);
    await sleep(100);
    assert.equal((await run(p, ["test", "-e", marker])).code, 1, "nothing ran");
  } finally {
    await close(p);
  }
});

test("with a terminal, the shell runs on a pseudo-terminal of its own, at the client's size, and reads what is typed", async () => {
  const p = await pod();
  try {
    const r = await run(p, ["sh", "-c", 'tty; stty size; read a; echo "got $a"'], {
      tty: { rows: 30, cols: 90 },
      input: "typed\n",
    });
    assert.equal(r.code, 0, r.err());
    assert.match(r.out(), /\/dev\/pts\/\d+/);
    assert.match(r.out(), /30 90/);
    assert.match(r.out(), /got typed/);
  } finally {
    await close(p);
  }
});

test("no command is bash or sh from the domain's PATH; with no work root it starts in HOME; an unknown command is said", async () => {
  const p = await pod({ work: false });
  try {
    const r = await run(p, [], { input: "echo shell=$0 cwd=$PWD; exit 3\n" });
    assert.equal(r.code, 3, r.err());
    assert.match(r.out(), new RegExp(`shell=(bash|sh) cwd=${p.home}`));
    const missing = await run(p, ["no-such-program-jr2"]);
    assert.equal(missing.code, 126);
    assert.match(missing.err(), /no-such-program-jr2: not on the Workspace's PATH/);
  } finally {
    await close(p);
  }
});

test("a client that goes away hangs up the shell", async () => {
  const p = await pod();
  try {
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (d: Buffer) => (out += d.toString()));
    const client = shellClient({
      socket: p.socket,
      proof: shellProof(CONTROL),
      argv: ["sh", "-c", "echo $$; exec sleep 100"],
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
    });
    for (let i = 0; i < 200 && !/\d+\n/.test(out); i++) await sleep(10);
    const pid = Number(out.trim());
    assert.ok(pid > 1, out);
    client.close();
    let alive = true;
    for (let i = 0; i < 200 && alive; i++) {
      try {
        process.kill(pid, 0);
        await sleep(10);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "the shell got the hang-up");
  } finally {
    await close(p);
  }
});

test("a client that does not read pauses the shell: the Harness's queue for it stays bounded, and all of the output comes when it reads", async () => {
  const p = await pod();
  const conns: Socket[] = [];
  p.served.server.on("connection", (c: Socket) => conns.push(c));
  const size = 32 << 20;
  const sock = createConnection(p.socket);
  try {
    await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
    sock.pause(); // the person's link is slow: nothing is read
    sock.write(
      `${JSON.stringify({ op: "start", proof: shellProof(CONTROL), argv: ["head", "-c", String(size), "/dev/zero"], tty: null })}\n`,
    );
    await sleep(1000);
    assert.equal(conns.length, 1);
    const queued = conns[0]!.writableLength;
    assert.ok(queued < 4 << 20, `the Harness queued ${queued} bytes for a client that does not read`);

    let got = 0;
    let exit: Record<string, unknown> | undefined;
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const f = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        buf = buf.slice(nl + 1);
        if (f.op === "out") got += Buffer.from(f.data as string, "base64").length;
        else exit = f;
      }
    });
    sock.resume();
    await new Promise<void>((resolve) => sock.once("end", () => resolve()));
    assert.deepEqual(exit, { op: "exit", code: 0, signal: null });
    assert.equal(got, size);
  } finally {
    sock.destroy();
    await close(p);
  }
});
