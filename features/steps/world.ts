// The Cucumber World for the j2 e2e suite: one per scenario (so scenarios are fully isolated and the
// suite is `--parallel`-safe). It owns a fresh temp INSTANCE folder, drives the REAL `j2` binary as a
// child process against it, and — when serving — the REAL server entrypoint the instance image runs
// (ADR-0010/0019: no host dev mode; the fixture boots exactly the deployed process, on the host).
//
// Black-box by design (ADR-0010): steps assert only on what a user's shell sees — captured stdout
// (the one machine-readable result), stderr (human activity), and the process exit code. The `j2`
// binary is pointed at the fixture's server the supported way: `J2_URL` + `J2_TOKEN` env. The
// wire-compatible stub Harness (ADR-0011) is a fixture owned by this tier, started in-process.
// @kind owns a second in-process fixture: the scripted MODEL its pods talk to (ADR-0038) — there
// the Harness is the REAL one, in a real pod, and only the LLM is faked. @dist fakes one thing and
// one thing only, a tier lower still: the REGISTRY (ADR-0043). Its `j2` is not this checkout's at
// all but a globally installed npm package, so the mode users run is the mode that executes.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setWorldConstructor } from "@cucumber/cucumber";
import { startStubHarness } from "@j2/orchestrator";
import type { Browser, Page } from "playwright";
import { startFakeProvider, type FakeProvider } from "./fake-provider.ts";
import type { InstalledKit } from "./dist-kit.ts";

/** The `j2` bin (the `.js` shim that type-erases the kit's `.ts` sources), resolved from this
 * file's location. */
const BIN = fileURLToPath(new URL("../../packages/cli/bin/j2.js", import.meta.url));
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

/** The entrypoint's one-line boot report. `lost`/`drifted`/`failed` appear only when non-empty —
 * the runs this boot did not resume (ADR-0030). */
export type Announcement = {
  url?: string;
  workflows?: string[];
  lost?: string[];
  drifted?: string[];
  failed?: string[];
};

export class E2EWorld {
  /** The temp instance folder (holds `j2.config.ts`, `workflows/`, and the runtime `.j2/`). */
  dir = "";
  /** The running server-entrypoint child, while serving. */
  private serverProc?: ChildProcess;
  /** The last boot's announce line, whole (ADR-0030 reports unresumed runs on it). */
  announced?: Announcement;
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
  /** @kind: the tag of the labeled image the sweep scenario planted on every node (ADR-0039) —
   * garbage by construction, since no root will ever name it. */
  plantedImage?: string;
  /** @kind: every ref the plant's `kind load` ADDED, per node — the tag, the
   * `import-<date>@<digest>` only containerd knows, and the bare `sha256:<id>`. The sweep has to
   * take all of them, so the assertion (and the teardown) works from this set, not from the tag. */
  plantedRefs?: Record<string, string[]>;

  /** @console: the real Chromium the browser tier drives (ADR-0010 as amended) — launched by the
   * `Before("@console")` hook, closed in `After`. Type-only import: the default profile never
   * loads playwright's runtime. */
  browser?: Browser;
  /** @console: the one tab the console steps drive against this scenario's orchestrator. */
  page?: Page;

  /** The scenario's own namespace on the real cluster — set = cluster mode (runCli appends `-n`
   * and passes no J2_URL, so the verbs resolve the REAL way). @kind and @dist both own one; it is
   * what makes the scenario, not the cluster, the isolation unit. */
  namespace?: string;
  /** @dist: the globally installed kit this scenario drives (ADR-0043). Its presence is what makes
   * `runCli` spawn the `j2` on PATH instead of this checkout's `bin/j2.js` — that swap IS the tier,
   * since a checkout binary would take checkout mode and never execute the branch under test. */
  dist?: InstalledKit;
  /** @kind: the scripted MODEL this scenario's pods talk to (ADR-0038). The pod runs the stock
   * Harness, so this is the only fake left in the tier — see `fake-provider.ts`. */
  provider?: FakeProvider;
  /** Extra env for the `j2` binary — @kind publishes the fake provider's address here, because a
   * deployment-varying endpoint rides env and never a committed literal (ADR-0019). */
  private extraEnv: Record<string, string> = {};
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
   *
   * Also starts this scenario's scripted MODEL (ADR-0038) and publishes its address to the `j2`
   * binary. HOST-SIDE, on an ephemeral port, so `--parallel` stays safe and the tier needs neither
   * an image nor a manifest for it. The instance image's content hash is unaffected: the config
   * file is byte-identical run to run, and the varying URL materializes into the agents ConfigMap.
   */
  async setupKind(): Promise<void> {
    this.namespace = `j2e2e-${randomBytes(3).toString("hex")}`;
    this.dir = KIND_DIR;
    await ensureSeedBundle(join(this.dir, "seed"));
    this.provider = await startFakeProvider();
    this.extraEnv.J2_FAKE_PROVIDER_URL = `http://${await kindHostAddress()}:${this.provider.port}/v1`;
  }

  /**
   * @dist (ADR-0043): drive the kit as a USER has it. Two facts make the tier, and both live here —
   * the `j2` is the globally installed one (see `runCli`), and the instance is a folder in the OS
   * temp dir, outside this checkout and outside any git repo. An instance inside the workspace
   * would bundle with `pnpm deploy`; the lockfile install this proves would never run.
   *
   * The name is minted lowercase here rather than taken from `mkdtemp`, whose suffix may carry
   * uppercase: it becomes the instance's identity, its namespace, AND the repository half of the
   * instance image's tag — and a docker repository may not be mixed case.
   */
  async setupDist(kit: InstalledKit): Promise<void> {
    const name = `j2dist-${randomBytes(4).toString("hex")}`;
    this.dir = join(tmpdir(), name);
    await mkdir(this.dir);
    this.namespace = name;
    this.dist = kit;
    // The bundle's frozen install runs inside a staged COPY of the instance, and the stage drops
    // `.npmrc` along with the other credential files (ADR-0043) — so the registry reaches that
    // install the way a deployment-varying value should, on the environment `j2 up` inherits and
    // passes down. A real user's private registry travels the same road.
    this.extraEnv.npm_config_registry = kit.registry;
  }

  /** Tear the scenario down: stop the orchestrator (if any) and delete what the scenario owns —
   * its namespace on the cluster (runs, store, Sandboxes go with it) and its temp folder. */
  async cleanup(): Promise<void> {
    await this.stopServer();
    await this.stub?.close();
    this.stub = undefined;
    await this.provider?.close();
    this.provider = undefined;
    if (this.namespace) {
      await execKubectl(["delete", "namespace", this.namespace, "--ignore-not-found", "--wait=false"]).catch(() => {});
    }
    // @kind's instance folder is the ONE exception: it is a workspace package shared by every
    // scenario, so its scenarios own a namespace and nothing on disk. @dist's temp folder is its
    // own, and goes.
    if (this.dir && this.dir !== KIND_DIR) await rm(this.dir, { recursive: true, force: true });
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
   * deployed orchestrator" path (ADR-0009). @kind and @dist set neither: the verbs resolve the
   * REAL way (current kube context + `-n <scenario namespace>` → Secret + port-forward, ADR-0019).
   *
   * WHICH binary is the @dist tier's whole point (ADR-0043): there the command is the bare name
   * `j2`, found on a PATH that starts with the throwaway global prefix, so the thing under test is
   * an npm install of the published package — shim, `files:` list, prod dependency chain and all.
   * Everywhere else it is this checkout's `bin/j2.js`, run by this node.
   *
   * `namespaced: false` is for the verbs that address no instance at all: `j2 gc` decides what is
   * garbage by asking the WHOLE cluster (ADR-0039), so a namespace flag would narrow nothing — and
   * a step must invoke it the way a user does. */
  async runCli(args: string[], opts: { namespaced?: boolean } = {}): Promise<CliResult> {
    const env: NodeJS.ProcessEnv = this.server
      ? { ...process.env, ...this.extraEnv, J2_URL: this.server.url, J2_TOKEN: this.server.token }
      : { ...process.env, ...this.extraEnv };
    const full = this.namespace && opts.namespaced !== false ? [...args, "-n", this.namespace] : args;
    if (this.dist) env.PATH = `${this.dist.binDir}:${process.env.PATH ?? ""}`;
    const child = this.dist
      ? spawn("j2", full, { cwd: this.dir, env })
      : spawn(process.execPath, [BIN, ...full], { cwd: this.dir, env });
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
    await this.installFixtureWorkflow(name, name);
  }

  /** Install a fixture under a DIFFERENT workflow name — how a scenario replaces a workflow's code
   * while keeping its identity, which is what `j2 up` does after an edit (ADR-0030). */
  async installFixtureWorkflow(fixture: string, name: string): Promise<void> {
    await mkdir(join(this.dir, "workflows"), { recursive: true });
    await copyFile(
      fileURLToPath(new URL(`../fixtures/${fixture}.ts`, import.meta.url)),
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
    const announced = await new Promise<Announcement>((resolve, reject) => {
      let buf = "";
      proc.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        for (const line of buf.split("\n").slice(0, -1)) {
          try {
            const parsed = JSON.parse(line) as Announcement;
            if (parsed.url) return resolve(parsed);
          } catch {
            // non-JSON noise on stdout is not the announcement
          }
        }
      });
      proc.on("close", (code) => reject(new Error(`server entrypoint exited (${code}) before announcing`)));
    });
    // Kept whole, not just the url: the boot also reports the runs it did NOT resume (ADR-0030),
    // and that line is the only place a drifted run announces itself.
    this.announced = announced;
    this.server = { url: announced.url!, token: this.token };
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

/**
 * The address a POD reaches this host on (@kind). `localhost` never works from a pod (ADR-0019
 * says so where `HarnessProvider.baseUrl` is declared), and the scripted provider runs host-side —
 * so the tier needs the kind bridge's GATEWAY, which is this host's address on the docker network
 * every kind node is attached to.
 *
 * The fallback, if a docker daemon is ever not local to the test process: run the fake provider
 * in-cluster as a Deployment + Service and point the config at its Service DNS. Host-side is
 * preferred while the daemon IS local — zero images, zero manifests, and an ephemeral port per
 * scenario, which is what keeps `--parallel` safe.
 */
async function kindHostAddress(): Promise<string> {
  const gateway = await new Promise<string>((resolve, reject) => {
    execFile(
      "docker",
      ["network", "inspect", "kind", "-f", "{{(index .IPAM.Config 0).Gateway}}"],
      (err, stdout, stderr) =>
        err
          ? reject(
              new Error(
                `could not resolve the kind bridge gateway (docker network inspect kind): ${stderr || err.message}\n` +
                  `  the @kind tier serves its scripted model from the HOST, so pods must be able to dial back;\n` +
                  `  is the cluster up (\`just e2e-kind-up\`) and is this docker daemon the local one?`,
              ),
            )
          : resolve(stdout.trim()),
    );
  });
  assert.ok(gateway, "the kind docker network reported a gateway address");
  return gateway;
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
