// The Cucumber World for the j2 e2e suite: one per scenario (so scenarios are fully isolated and the
// suite is `--parallel`-safe). It owns a fresh temp INSTANCE folder, drives the REAL `j2` binary as a
// child process against it, and — when serving — a REAL `j2 dev` orchestrator on an ephemeral port.
//
// Black-box by design (ADR-0010): steps assert only on what a user's shell sees — captured stdout
// (the one machine-readable result), stderr (human activity), and the process exit code. Nothing is
// imported from `@j2/cli` internals; the binary is spawned exactly as `pnpm exec j2` would run it.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, copyFile, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { setWorldConstructor } from "@cucumber/cucumber";

/** The `j2` bin (a Node 24 type-stripped `.ts` shebang), resolved from this file's location. */
const BIN = fileURLToPath(new URL("../../packages/cli/bin/j2.ts", import.meta.url));
/** Base for per-scenario temp instances; gitignored. */
const TMP_BASE = fileURLToPath(new URL("../.tmp/", import.meta.url));
/** The `loop` fixture workflow source, copied into an instance when a live run is needed. */
const LOOP_FIXTURE = fileURLToPath(new URL("../fixtures/loop.ts", import.meta.url));
/**
 * The kind tier's instance (@kind): ONE fixed folder, not a per-scenario mkdtemp. kind bakes the
 * `repos/` → node mount at cluster creation (ADR-0009), so a cluster serves exactly one instance
 * path — `just e2e-kind-up` scaffolds this folder and creates the cluster around it. Scenarios
 * still isolate: each boots its own `j2 dev` and owns its own runs and Sandboxes.
 */
const KIND_DIR = fileURLToPath(new URL("../.tmp/kind/", import.meta.url));

/** The captured outcome of one `j2 …` invocation. */
export type CliResult = { stdout: string; stderr: string; code: number };

/** What `j2 dev` advertised in `.j2/dev.json`. */
type DevInfo = { url: string; stubHarness?: string; pid: number };

export class E2EWorld {
  /** The temp instance folder (holds `j2.config.ts`, `workflows/`, and the runtime `.j2/`). */
  dir = "";
  /** The running `j2 dev` child, while serving. */
  private devProc?: ChildProcess;
  /** The address `j2 dev` advertised, once serving. */
  dev?: DevInfo;
  /** The most recent `j2 …` invocation's captured output + exit code. */
  last?: CliResult;
  /** A runId carried between steps (the last run started or settled). */
  runId?: string;
  /** @kind: the run's Sandbox CR name, captured before an orchestrator restart / reap. */
  sandboxBefore?: string;
  /** @kind: the workspace endpoint before a restart — restore must land on the same one. */
  endpointBefore?: string;

  /** True when this scenario runs against the shared kind instance (so cleanup must not delete it). */
  private kind = false;

  /** Allocate a fresh, isolated instance folder. Called from the `Before` hook. */
  async setup(): Promise<void> {
    await mkdir(TMP_BASE, { recursive: true });
    this.dir = await mkdtemp(join(TMP_BASE, "inst-"));
  }

  /**
   * Adopt the shared kind instance (@kind scenarios). Fails pointedly rather than scaffolding it:
   * the folder must EXIST before its cluster is created (the mount is baked then), so creating it
   * here would hand the scenario an instance no pod can see. Run state is reset so each scenario
   * starts with an empty store — a leftover in-flight run would otherwise be restored at boot and
   * re-provision Sandboxes underneath us. `repos/` is never touched: deleting the bind-mounted
   * directory would sever the node's view of it for the life of the cluster.
   */
  async setupKind(): Promise<void> {
    this.kind = true;
    this.dir = KIND_DIR;
    try {
      await readFile(join(this.dir, "j2.config.ts"), "utf8");
    } catch {
      throw new Error(`the kind e2e instance is not set up — run \`just e2e-kind-up\` (expected ${this.dir})`);
    }
    await rm(join(this.dir, ".j2"), { recursive: true, force: true });
  }

  /** Tear the scenario down: stop the orchestrator (if any) and delete the instance folder. */
  async cleanup(): Promise<void> {
    await this.stopDev();
    if (this.kind) return; // shared instance: its cluster's repos mount is baked to this path
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }

  /** Restart the orchestrator against the same instance — the restore path (ADR-0007/0012). */
  async restartDev(): Promise<void> {
    await this.stopDev();
    await this.startDev();
  }

  /** Run `j2 <args>` against this instance, capturing stdout/stderr/exit code into `last`. */
  async runCli(args: string[]): Promise<CliResult> {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: this.dir });
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

  /** Copy the `loop` fixture into `workflows/` BEFORE serving, so `j2 dev` discovers it at boot. */
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

  /** Boot `j2 dev --port 0` and wait until it advertises `.j2/dev.json`. */
  async startDev(): Promise<void> {
    this.devProc = spawn(process.execPath, [BIN, "dev", "--port", "0"], { cwd: this.dir });
    this.devProc.stderr?.on("data", () => {}); // drain so the pipe never blocks
    this.dev = await this.waitForDevJson();
  }

  /** SIGINT the orchestrator and wait for it to exit (idempotent — safe to call again in cleanup). */
  async stopDev(): Promise<void> {
    const proc = this.devProc;
    if (!proc) return;
    this.devProc = undefined;
    const exited = new Promise<void>((resolve) => proc.on("close", () => resolve()));
    proc.kill("SIGINT");
    await exited;
  }

  /** Read `<dir>/.j2/dev.json`, or undefined if it's not there. */
  async readDevJson(): Promise<DevInfo | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir, ".j2", "dev.json"), "utf8")) as DevInfo;
    } catch {
      return undefined;
    }
  }

  /** Poll for `dev.json` (the dev server binds asynchronously); fail loudly if it never appears. */
  private async waitForDevJson(): Promise<DevInfo> {
    for (let i = 0; i < 200; i++) {
      const info = await this.readDevJson();
      if (info?.url) return info;
      await sleep(50);
    }
    throw new Error("j2 dev never wrote .j2/dev.json");
  }

  /** The terminal stdout line parsed as JSON (the one machine-readable result a verb prints). */
  resultJson<T = Record<string, unknown>>(): T {
    const lines = (this.last?.stdout ?? "").trim().split("\n");
    return JSON.parse(lines[lines.length - 1] ?? "{}") as T;
  }
}

setWorldConstructor(E2EWorld);
