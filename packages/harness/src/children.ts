// The Harness's children (ADR-0076, ADR-0077): how the Harness of a Sandbox starts each process
// that a model drives or that runs Workspace code — each `bash` call, each search tool, jr2's own
// git for the attach and the sync, and each `command` Effect placed here (the cut among them) — and
// where the file tools do their I/O. All of it runs in ONE Landlock domain, which the Harness is not
// in: the Harness starts the spawner once (`spawner.ts`), confined by the Effector's confiner on the
// runtime volume, and asks it for each process and each file op:
//
//   /opt/jr2/bin/effector confine <rules> -- /opt/jr2/bin/effector spawner
//
// The rules are `confine.ForHarness`'s, which `effector harness-rules --deny /run/jr2 --read
// /run/jr2/output` writes once at start: every right on every path except `/run/jr2`, and read alone
// in `/run/jr2/output`. That folder holds the control Stand-in, each held secret's Stand-in, the
// Custodian's control socket's folder, and the Harness's conversations; its `output` folder holds
// the whole output of a long `bash` call, which the model reads (`OUTPUT_DIR`). A confined process cannot ptrace one outside its domain, so `/proc/<harness>/environ`
// and `/mem` stay closed.
//
// The domain's env is the env that the container STARTED with — the image's `ENV`, `harness.env`,
// `envFrom`, the proxy and CA variables — with startup.ts's PATH, HOME and git identity, without
// jr2's own `JR2_*` names (except `JR2_CUSTODIAN_URL`), and with HOME, TMPDIR and the Stand-ins of
// the secrets that the `workspace()` grants (`JR2_GRANTED_SECRETS`). It never holds what the Harness
// put in its own env after the start: the control Stand-in, a model key's Stand-in that no grant
// names.
//
// There is no unconfined branch (ADR-0077): a Harness of a Sandbox that cannot confine refuses to
// serve (`probeLandlock`), and every process here starts through the spawner.

import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SpawnError, Spawner, SpawnerGoneError, type SpawnExit, type Spawned } from "./spawner.ts";

/** The Effector's binary on the runtime volume: the confiner and the spawner (ADR-0068, ADR-0076). */
export const CONFINER = "/opt/jr2/bin/effector";
/** Every path that jr2 holds for the Harness alone (ADR-0076): denied to the domain. */
export const RUNTIME_SECRETS = "/run/jr2";
/** Where the control Stand-in's file is mounted, in the Harness container alone (ADR-0076). */
export const CONTROL_STANDIN_FILE = `${RUNTIME_SECRETS}/control/standin`;
/** Where each held secret's Stand-in is mounted, one file a name (ADR-0059). */
export const STANDINS_DIR = `${RUNTIME_SECRETS}/standins`;
/** The Custodian's control socket (ADR-0076): the agent routes, never on a port. */
export const CONTROL_SOCKET = `${RUNTIME_SECRETS}/custodian/control.sock`;
/** Where a Harness keeps its conversations (ADR-0031): under `/run/jr2`, so no process of the
 * domain reads another Agent's conversation (ADR-0076). */
export const CONVERSATIONS_DIR = `${RUNTIME_SECRETS}/conversations`;
/**
 * The Harness's own folder for the whole output of a long `bash` call (ADR-0076): an emptyDir of
 * the Harness container's alone (sandbox-kube.ts), which the domain reads and does not write. pi's
 * `bash` makes that file in this process's `os.tmpdir()` and opens it by its path again to read
 * it, so the Harness's TMPDIR is this folder (`useOutputDir`): there, no process of the domain can
 * put a link or a FIFO in the file's place. The model reads the file by the path that pi gives.
 */
export const OUTPUT_DIR = `${RUNTIME_SECRETS}/output`;
/** Where the Harness of a Sandbox listens for a person's shell (`workspace-shell.ts`): in a folder
 * of the Harness container's alone under `/run/jr2`, where no process of the domain makes a file. */
export const SHELL_SOCKET = `${RUNTIME_SECRETS}/shell/shell.sock`;

/**
 * The Harness process's own HOME (ADR-0076): not the domain's. The domain writes its HOME, and code
 * in this process reads files under HOME: node, once at its start, for the folders where a bare
 * require() looks last (`$HOME/.node_modules`, `module-paths.ts`); the AWS SDK's `~/.aws/config`
 * (which can name a `credential_process` to run) for a Bedrock model; Google's `~/.config/gcloud`
 * for Vertex. So `effector nocore --harness-env` gives node this HOME before node starts. Under
 * `/run/jr2`, the domain cannot make, write or link anything there. The folder does not exist, and
 * nothing makes it: `/run/jr2` is a read-only volume, for the Harness too. Each reader takes a HOME
 * that does not exist as one with no files in it. Nothing in this process writes under HOME.
 */
export const HARNESS_HOME = `${RUNTIME_SECRETS}/home`;

/** Check that the Harness process started with its own HOME and that the domain has another one.
 * `env` is `process.env` in the Harness. A HOME set here, after node started, is too late: node
 * read HOME at its start (`module-paths.ts`). So this changes nothing, and throws instead. */
export function assertHarnessHome(env: NodeJS.ProcessEnv, policy: ChildPolicy): void {
  if (env.HOME !== HARNESS_HOME) {
    throw new Error(
      `the Harness process's HOME is ${env.HOME ?? "not set"}, not ${HARNESS_HOME}: node read it at its start, so ` +
        "a module that the Agent's code puts under it would run in the Harness. Start the Harness with " +
        "`effector nocore --harness-env` (ADR-0076)",
    );
  }
  if (policy.env.HOME === undefined || policy.env.HOME === HARNESS_HOME) {
    throw new Error(`the domain's env has no HOME of its own: it would share ${HARNESS_HOME} (ADR-0076)`);
  }
}

/**
 * The container's whole start env, as data (ADR-0076): `effector nocore --harness-env` gives the
 * Harness process only the names that jr2 composed, less each name that loads code from a path
 * (`NODE_OPTIONS`, `LD_*`, `OPENSSL_CONF` …), and puts the whole start env here, base64 of
 * `NAME=value` entries each ended by a NUL byte. The domain's env is made from it, so the image's
 * `ENV` reaches each program of the Agent as it did. No program reads this name.
 */
export const START_ENV = "JR2_START_ENV";

/**
 * The container's start env: `JR2_START_ENV` decoded, or, in a start without it (a test, a run on
 * a host), `env` itself. It removes `JR2_START_ENV` from `env`, so that nothing passes it on.
 */
export function takeStartEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const data = env[START_ENV];
  delete env[START_ENV];
  const out: Record<string, string> = {};
  if (data === undefined) {
    for (const [name, value] of Object.entries(env)) if (value !== undefined) out[name] = value;
    return out;
  }
  for (const entry of Buffer.from(data, "base64").toString("utf8").split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

/** The one `JR2_*` name that the domain keeps: `jr2-upload-pack` reads it for a fetch (ADR-0053). */
const KEPT_JR2 = "JR2_CUSTODIAN_URL";

/** Names that no held secret may take: the domain's env is made of them (PATH, HOME, the proxy). */
export const RESERVED_ENV: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "JR2_CUSTODIAN_URL",
  "OMP_NUM_THREADS",
  "PYTHON_CPU_COUNT",
  "GOMAXPROCS",
] as const;

/** How the Harness reaches the domain: the spawner, and the env that each process gets. */
export type ChildPolicy = {
  /** The domain's env (ADR-0076). */
  readonly env: Readonly<Record<string, string>>;
  /** The one spawner of the domain. */
  readonly spawner: Spawner;
};

/** A program on `path`, or undefined. The Harness's check before it names a shell: the spawner
 * finds the program itself. An empty or relative entry is the Agent's folder, and never searched. */
export function lookPath(file: string, path: string | undefined, cwd?: string): string | undefined {
  if (file.includes("/")) return isAbsolute(file) ? file : resolve(cwd ?? process.cwd(), file);
  for (const dir of (path ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, file);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** The Stand-ins in `dir`, by the held secret's name: each file's value, one trailing newline off. */
export function readStandIns(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }
  for (const name of names) {
    // A projected Secret volume holds `..data` and its timestamped folder beside the keys.
    if (name.startsWith(".")) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const file = join(dir, name);
    if (!statSync(file).isFile()) continue;
    out.set(name, readFileSync(file, "utf8").replace(/\r?\n$/, ""));
  }
  return out;
}

/** The control Stand-in (ADR-0076): read once at start from its file, held in memory, sent as the
 * bearer of every control request. Never in an env. */
export function readControlStandIn(file: string): string {
  let value: string;
  try {
    value = readFileSync(file, "utf8").replace(/\r?\n$/, "");
  } catch (err) {
    throw new Error(
      `no control Stand-in at ${file} (${(err as NodeJS.ErrnoException).code ?? String(err)}) — the Harness reads ` +
        "its Menu and delivers its picks with it, so it cannot serve (ADR-0076)",
      { cause: err },
    );
  }
  if (value === "") throw new Error(`the control Stand-in at ${file} is empty — the Harness cannot serve (ADR-0076)`);
  return value;
}

/** The granted names (`JR2_GRANTED_SECRETS`): a comma-separated list of held secrets' names. */
export function grantedOf(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
}

/**
 * The domain's env (ADR-0076): `start` — the container's env at the start, with startup.ts's PATH,
 * HOME and git identity — without `JR2_*` but `JR2_CUSTODIAN_URL`; then HOME and TMPDIR; then the
 * Stand-in of each granted secret under its own name. A granted name with no Stand-in is a fault of
 * the pod's maker, said loudly. A value equal to the control Stand-in, or to the Stand-in of a held
 * secret that no grant names, is never put in, whatever its name.
 */
export function childEnv(
  start: Readonly<Record<string, string | undefined>>,
  standIns: ReadonlyMap<string, string>,
  granted: readonly string[],
  control: string | undefined,
  dirs: { home: string; tmp: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(start)) {
    if (value === undefined) continue;
    if (name.startsWith("JR2_") && name !== KEPT_JR2) continue;
    out[name] = value;
  }
  out.HOME = dirs.home;
  out.TMPDIR = dirs.tmp;
  const withheld = new Set<string>();
  if (control !== undefined && control !== "") withheld.add(control);
  for (const [name, value] of standIns) if (!granted.includes(name) && value !== "") withheld.add(value);
  for (const name of granted) {
    const value = standIns.get(name);
    if (value === undefined) {
      throw new Error(
        `the workspace() grants ${name}, and the pod holds no Stand-in for it in its Stand-ins folder — ` +
          "a fault of the pod's maker (ADR-0059, ADR-0076)",
      );
    }
    out[name] = value;
  }
  for (const [name, value] of Object.entries(out)) if (withheld.has(value)) delete out[name];
  return out;
}

/** The real path of `p`, or `p` when it does not exist. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The rules of the domain, as `effector harness-rules` writes them (`confine.ForHarness`): one call
 * at start. Every right on every path but each of `deny`, and read alone in each of `read`, which
 * lies in a path of `deny`.
 */
export function harnessRules(confiner: string, deny: readonly string[], read: readonly string[] = []): string[] {
  const args = [...deny.flatMap((d) => ["--deny", d]), ...read.flatMap((r) => ["--read", r])];
  const out = execFileSync(confiner, ["harness-rules", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {},
  });
  return out.split("\0").filter((a) => a !== "");
}

/**
 * The Landlock probe (ADR-0077): the Harness of a Sandbox runs `effector probe` at start, and refuses
 * to serve without Landlock. Undefined when the kernel offers it; else the line the Harness says,
 * with the node's name.
 */
export function probeLandlock(confiner: string, node: string): string | undefined {
  const r = spawnSync(confiner, ["probe"], { encoding: "utf8", timeout: 10_000, env: {} });
  if (r.status === 0) return undefined;
  // No confiner to ask: the runtime volume is not this Harness's, which is no fact about the node.
  if (r.error !== undefined) {
    return `the confiner ${confiner} did not run (${r.error.message}): the Harness of a Sandbox confines each process it starts with it, so it cannot serve (ADR-0076)`;
  }
  const why = (r.stderr || r.stdout || `exit ${r.status}`).trim();
  return (
    `landlock: unavailable on node ${node} (${why.replace(/^landlock: /, "")}): jr2 requires Landlock on every ` +
    "Sandbox node, and this Harness confines each process it starts with it (ADR-0076, ADR-0077) — " +
    "keep this node out with sandbox.nodeSelector or a taint, or enable Landlock in its kernel"
  );
}

/** What the domain is made from: the container's start env and the pod's paths. Seams for tests. */
export type PolicyInputs = {
  /** The container's env at the start, with startup.ts's PATH, HOME and git identity. */
  env: Readonly<Record<string, string | undefined>>;
  confiner?: string;
  standIns: ReadonlyMap<string, string>;
  control: string | undefined;
  /** The paths that the domain may not reach. Default: `/run/jr2` alone. */
  deny?: readonly string[];
  /** The folders in a path of `deny` that the domain may read and not write. Default: `OUTPUT_DIR`. */
  read?: readonly string[];
  /** Where the spawner's start and restarts are said. Default: `console.error`. */
  log?: (line: string) => void;
};

/** The domain of this Harness (ADR-0076): its rules from the confiner, its env, its one spawner. */
export function childPolicy(inputs: PolicyInputs): ChildPolicy {
  const confiner = inputs.confiner ?? CONFINER;
  const home = real(inputs.env.HOME ?? "/home/jr2");
  const tmp = real(inputs.env.TMPDIR ?? tmpdir());
  const deny = (inputs.deny ?? [RUNTIME_SECRETS]).map(real);
  // A folder that the domain works in cannot be one that it may not reach.
  for (const [what, dir] of [
    ["HOME", home],
    ["TMPDIR", tmp],
  ] as const) {
    const held = deny.find((d) => dir === d || dir.startsWith(`${d}/`));
    if (held !== undefined) {
      throw new Error(
        `${what} is ${dir}, which is in ${held}: no process of the domain reaches ${held} (ADR-0076) — ` +
          "give the container another HOME or TMPDIR",
      );
    }
  }
  const env = childEnv(inputs.env, inputs.standIns, grantedOf(inputs.env.JR2_GRANTED_SECRETS), inputs.control, {
    home,
    tmp,
  });
  const rules = harnessRules(confiner, deny, (inputs.read ?? [OUTPUT_DIR]).map(real));
  const spawner = new Spawner({
    argv: [confiner, "confine", ...rules, "--", confiner, "effector", "spawner"],
    env: {},
    ...(inputs.log ? { log: inputs.log } : {}),
  });
  return { env, spawner };
}

/**
 * Make `dir` this process's TMPDIR (ADR-0076): the folder where pi's `bash` makes a long command's
 * whole output (`OUTPUT_DIR`). It must be a folder, not a link, that this process can write. The
 * domain keeps its own TMPDIR, from the start env (`childPolicy`), so call this after the domain is
 * made. A Harness whose folder is not there cannot serve: pi would write the file where the domain
 * writes, and open it there by its path again.
 */
export function useOutputDir(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const fix = `mount a folder of the Harness container's own at ${dir} (ADR-0076)`;
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (err) {
    throw new Error(`the Harness's output folder ${dir} is not there (${(err as Error).message}): ${fix}`);
  }
  if (!stat.isDirectory()) throw new Error(`the Harness's output folder ${dir} is not a folder: ${fix}`);
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new Error(`the Harness cannot write its output folder ${dir}: ${fix}`);
  }
  env.TMPDIR = dir;
}

/** A process the domain ran to its end, as `execFile` answers one. */
export type RunResult = {
  /** Its exit code; null when it did not start, a signal ended it, or the run was stopped. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** As `execFile`'s: `Command failed: …` for a failed exit, the spawn error, an `AbortError`. */
  error?: Error & { code?: unknown };
};

/**
 * Run `argv` in the domain to its end, collecting its output, as `execFile` does: stdin from
 * `input` (else /dev/null), each stream bounded by `maxBuffer`, a `timeoutMs`, an abort `signal`.
 * A stop (abort, timeout, an output too long) ends the process group with SIGTERM.
 */
export function runIn(
  children: ChildPolicy,
  argv: readonly string[],
  opts: {
    cwd: string;
    env?: Readonly<Record<string, string | undefined>>;
    input?: Buffer | string;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBuffer?: number;
    encoding?: BufferEncoding;
  },
): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? children.env)) if (v !== undefined) env[k] = v;
  const encoding = opts.encoding ?? "utf8";
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
  if (opts.signal?.aborted) {
    return Promise.resolve({ code: null, signal: null, stdout: "", stderr: "", error: abortError() });
  }
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let stopped: (Error & { code?: unknown }) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let proc: Spawned | undefined;
    const stop = (why: Error & { code?: unknown }) => {
      stopped ??= why;
      proc?.signal("SIGTERM");
    };
    const onAbort = () => stop(abortError());
    const keep = (into: Buffer[], len: number, chunk: Buffer, stream: string): number => {
      if (stopped !== undefined) return len;
      const room = maxBuffer - len;
      if (chunk.length > room) {
        into.push(chunk.subarray(0, Math.max(0, room)));
        stop(
          Object.assign(new RangeError(`${stream} maxBuffer length exceeded`), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
        );
        return maxBuffer;
      }
      into.push(chunk);
      return len + chunk.length;
    };
    proc = children.spawner.spawn(
      { argv, env, cwd: opts.cwd, stdin: opts.input !== undefined },
      {
        onStdout: (c) => void (outLen = keep(out, outLen, c, "stdout")),
        onStderr: (c) => void (errLen = keep(err, errLen, c, "stderr")),
      },
    );
    if (opts.input !== undefined) {
      proc.write(opts.input);
      proc.end();
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(
        () => stop(Object.assign(new Error("timed out"), { code: null, killed: true })),
        opts.timeoutMs,
      );
    }
    const text = (bufs: Buffer[]) => decode(bufs, encoding);
    const done = (result: RunResult) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    proc.exited.then(
      (exit: SpawnExit) => {
        const stdout = text(out);
        const stderr = text(err);
        if (stopped !== undefined) {
          if (stopped.name !== "AbortError" && stopped.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            stopped = commandFailed(argv, stderr, exit, true);
          }
          return done({ code: null, signal: exit.signal, stdout, stderr, error: stopped });
        }
        if (exit.code === 0) return done({ code: 0, signal: null, stdout, stderr });
        done({ code: exit.code, signal: exit.signal, stdout, stderr, error: commandFailed(argv, stderr, exit, false) });
      },
      (e: unknown) => {
        const error = (e instanceof SpawnError || e instanceof SpawnerGoneError ? e : new Error(String(e))) as Error & {
          code?: unknown;
        };
        done({ code: null, signal: null, stdout: text(out), stderr: text(err), error });
      },
    );
  });
}

function decode(bufs: Buffer[], encoding: BufferEncoding): string {
  const d = new StringDecoder(encoding);
  return bufs.map((b) => d.write(b)).join("") + d.end();
}

function abortError(): Error & { code: string } {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
}

/** `execFile`'s error for a run that did not end with 0. */
function commandFailed(
  argv: readonly string[],
  stderr: string,
  exit: SpawnExit,
  killed: boolean,
): Error & { code: number | null; signal: NodeJS.Signals | null; killed: boolean } {
  return Object.assign(new Error(`Command failed: ${argv.join(" ")}\n${stderr}`), {
    code: exit.signal === null ? exit.code : null,
    signal: exit.signal,
    killed,
  });
}
