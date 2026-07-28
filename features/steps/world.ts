// The Cucumber World for the j2 e2e suite: one per scenario (so scenarios are fully isolated and the
// suite is `--parallel`-safe). It owns a fresh temp INSTANCE folder, drives the REAL `j2` binary as a
// child process against it, and — when serving — the REAL server entrypoint the instance image runs
// (ADR-0010/0019: no host dev mode; the fixture boots exactly the deployed process, on the host).
//
// Black-box by design (ADR-0010): steps assert only on what a user's shell sees — captured stdout
// (the one machine-readable result), stderr (human activity), and the process exit code. The `j2`
// binary is pointed at the fixture's server the supported way: `J2_URL` + `J2_TOKEN` env. The
// wire-compatible stub Harness (ADR-0011) is a fixture owned by this tier, started in-process.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setWorldConstructor } from "@cucumber/cucumber";
import { startStubHarness } from "@j2/orchestrator";

/** The `j2` bin (a Node 24 type-stripped `.ts` shebang), resolved from this file's location. */
const BIN = fileURLToPath(new URL("../../packages/cli/bin/j2.ts", import.meta.url));
/** The instance image's server entrypoint (ADR-0019) — the per-scenario orchestrator fixture. */
const SERVER_BIN = fileURLToPath(new URL("../../packages/orchestrator/bin/server.ts", import.meta.url));
/** Base for per-scenario temp instances; gitignored. */
const TMP_BASE = fileURLToPath(new URL("../.tmp/", import.meta.url));
/**
 * The kind tier's instance (@kind, ADR-0010): ONE shared workspace package (`j2 up`'s image build
 * `pnpm deploy`s it, which needs workspace membership). Scenarios isolate by NAMESPACE: each `up`s
 * into a fresh one (`-n`), and namespace deletion is the teardown.
 */
const KIND_DIR = fileURLToPath(new URL("../kind-instance/", import.meta.url));

/** The captured outcome of one `j2 …` invocation. */
export type CliResult = { stdout: string; stderr: string; code: number };

/** The serving fixture's address + credential — what `J2_URL`/`J2_TOKEN` carry to the `j2` binary. */
export type ServerInfo = { url: string; token: string };

export class E2EWorld {
  /** The temp instance folder (holds `j2.config.ts`, `workflows/`, and the runtime `.j2/`). */
  dir = "";
  /** The running server-entrypoint child, while serving. */
  private serverProc?: ChildProcess;
  /** The serving orchestrator's address + Instance token, once serving. */
  server?: ServerInfo;
  /** The in-process stub Harness (ADR-0011), started on demand; its url is run input. */
  private stub?: { url: string; close: () => Promise<void> };
  /** The most recent `j2 …` invocation's captured output + exit code. */
  last?: CliResult;
  /** A runId carried between steps (the last run started or settled). */
  runId?: string;
  /** @kind: the run's Sandbox CR name, captured before an orchestrator restart / reap. */
  sandboxBefore?: string;
  /** @kind: the workspace endpoint before a restart — restore must land on the same one. */
  endpointBefore?: string;
  /** @kind: stdout of the last command run INSIDE a Sandbox container (ADR-0013 boundary probes). */
  podSays?: string;
  /** @kind: the branch head sha captured when the review worktree was attached — the ref the
   * ADR-0028 containment scenario asserts unmoved after the rogue commit. */
  branchHeadBefore?: string;
  /** @kind: the detached review worktree's in-pod path (ADR-0028), carried between steps. */
  reviewDir?: string;

  /** @kind: the scenario's fresh namespace — set = kind mode (runCli appends `-n`, no J2_URL). */
  kindNamespace?: string;
  /** The Instance token this scenario's server boots with (the fixture plays `j2 up`'s Secret). */
  private readonly token = randomBytes(16).toString("hex");

  /** Allocate a fresh, isolated instance folder. Called from the `Before` hook. */
  async setup(): Promise<void> {
    await mkdir(TMP_BASE, { recursive: true });
    this.dir = await mkdtemp(join(TMP_BASE, "inst-"));
  }

  /**
   * Adopt the shared kind instance (@kind scenarios) under a FRESH namespace, and make sure the
   * seed git bundle the config's `repos[]` clones from exists (self-healing: generated once,
   * then baked into the instance image by content hash).
   */
  async setupKind(): Promise<void> {
    this.kindNamespace = `j2e2e-${randomBytes(3).toString("hex")}`;
    this.dir = KIND_DIR;
    await ensureSeedBundle(join(this.dir, "seed"));
  }

  /** Tear the scenario down: stop the orchestrator (if any) and delete what the scenario owns —
   * its temp folder, or (@kind) its whole namespace (runs, store, Sandboxes go with it). */
  async cleanup(): Promise<void> {
    await this.stopServer();
    await this.stub?.close();
    this.stub = undefined;
    if (this.kindNamespace) {
      await execKubectl(["delete", "namespace", this.kindNamespace, "--ignore-not-found", "--wait=false"]).catch(
        () => {},
      );
      return; // the shared instance folder itself is a workspace package — never deleted
    }
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }

  /** Restart the orchestrator against the same instance — the restore path (ADR-0007/0012). */
  async restartServer(): Promise<void> {
    await this.stopServer();
    await this.startServer();
  }

  /** The Instance token as a bearer header — what the CLI sends after resolving its target. */
  authHeaders(): Record<string, string> {
    const token = this.server?.token;
    assert.ok(token, "the fixture server was booted with an Instance token (ADR-0013)");
    return { authorization: `Bearer ${token}` };
  }

  /** The stub Harness's url (started on first use) — passed as run-input `endpoint` (ADR-0011). */
  async stubHarnessUrl(): Promise<string> {
    this.stub ??= await startStubHarness();
    return this.stub.url;
  }

  /** Run `j2 <args>` against this instance, capturing stdout/stderr/exit code into `last`.
   * While serving on the host, the target rides `J2_URL`/`J2_TOKEN` — the supported "attach to a
   * deployed orchestrator" path (ADR-0009). @kind sets neither: the verbs resolve the REAL way
   * (current kube context + `-n <scenario namespace>` → Secret + port-forward, ADR-0019). */
  async runCli(args: string[]): Promise<CliResult> {
    const env = this.server ? { ...process.env, J2_URL: this.server.url, J2_TOKEN: this.server.token } : process.env;
    const full = this.kindNamespace ? [...args, "-n", this.kindNamespace] : args;
    const child = spawn(process.execPath, [BIN, ...full], { cwd: this.dir, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number>((resolve) => {
      child.on("close", (c) => resolve(c ?? 0));
    });
    this.last = { stdout, stderr, code };
    return this.last;
  }

  /** Scaffold the instance with the real `j2 init` (gives it `ping` + config). */
  async init(): Promise<void> {
    const r = await this.runCli(["init"]);
    if (r.code !== 0) throw new Error(`j2 init failed (${r.code}): ${r.stderr}`);
  }

  /** Copy the `loop` fixture into `workflows/` BEFORE serving, so boot discovery finds it. */
  async addLoopWorkflow(): Promise<void> {
    await this.addFixtureWorkflow("loop");
  }

  /** Copy any `features/fixtures/<name>.ts` workflow into the instance BEFORE serving. */
  async addFixtureWorkflow(name: string): Promise<void> {
    await mkdir(join(this.dir, "workflows"), { recursive: true });
    await copyFile(
      fileURLToPath(new URL(`../fixtures/${name}.ts`, import.meta.url)),
      join(this.dir, "workflows", `${name}.ts`),
    );
  }

  /** Boot the server entrypoint (the deployed process, ADR-0019) and wait for its announce line.
   * Host-only — @kind never calls this; its orchestrator runs in-cluster, deployed by `j2 up`. */
  async startServer(): Promise<void> {
    const proc = spawn(process.execPath, [SERVER_BIN], {
      cwd: this.dir,
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        J2_INSTANCE_TOKEN: this.token,
      },
    });
    this.serverProc = proc;
    proc.stderr?.on("data", () => {}); // drain so the pipe never blocks
    // The entrypoint announces one JSON object per line; the `{ url }` line is the address (repo
    // reconcile lines may precede it on a sandbox-ful instance).
    const url = await new Promise<string>((resolve, reject) => {
      let buf = "";
      proc.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        for (const line of buf.split("\n").slice(0, -1)) {
          try {
            const parsed = JSON.parse(line) as { url?: string };
            if (parsed.url) return resolve(parsed.url);
          } catch {
            // non-JSON noise on stdout is not the announcement
          }
        }
      });
      proc.on("close", (code) => reject(new Error(`server entrypoint exited (${code}) before announcing`)));
    });
    this.server = { url, token: this.token };
  }

  /** SIGINT the orchestrator and wait for it to exit (idempotent — safe to call again in cleanup). */
  async stopServer(): Promise<void> {
    const proc = this.serverProc;
    if (!proc) return;
    this.serverProc = undefined;
    this.server = undefined;
    const exited = new Promise<void>((resolve) => proc.on("close", () => resolve()));
    proc.kill("SIGINT");
    await exited;
  }

  /** The terminal stdout line parsed as JSON (the one machine-readable result a verb prints). */
  resultJson<T = Record<string, unknown>>(): T {
    const lines = (this.last?.stdout ?? "").trim().split("\n");
    return JSON.parse(lines[lines.length - 1] ?? "{}") as T;
  }
}

/** kubectl, for the World's own teardown (steps have their own namespace-aware helper). */
function execKubectl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("kubectl", args, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * The seed repo the kind config's `repos[]` clones from, as a git BUNDLE (`seed/app.bundle`):
 * a single file survives the instance image build (`pnpm deploy` strips nested `.git` dirs) and
 * is clonable from inside the cluster. Generated once; the image content hash then keeps it.
 */
async function ensureSeedBundle(seedDir: string): Promise<void> {
  const bundle = join(seedDir, "app.bundle");
  try {
    await readFile(bundle);
    return;
  } catch {
    // absent → generate
  }
  await mkdir(seedDir, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "j2-seed-"));
  const git = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile("git", ["-C", work, ...args], (err, _o, stderr) =>
        err ? reject(new Error(`git ${args.join(" ")}: ${stderr}`)) : resolve(),
      );
    });
  await git(["init", "-q", "-b", "main"]);
  await writeFile(join(work, "README.md"), "# app\n");
  await git(["add", "-A"]);
  await git(["-c", "user.email=e2e@j2", "-c", "user.name=e2e", "commit", "-qm", "init"]);
  await git(["bundle", "create", bundle, "HEAD", "main"]);
  await rm(work, { recursive: true, force: true });
}

setWorldConstructor(E2EWorld);
