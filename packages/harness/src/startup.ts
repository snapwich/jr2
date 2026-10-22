// What the Harness process sets for ITSELF before it serves anything (ADR-0037, ADR-0005).
//
// Since ADR-0037 the Harness is not baked into the image it runs in: the Sandbox Image is the
// user's, byte-for-byte, and jr2's runtime arrives at pod time on the `/opt/jr2` volume with the
// container's command overridden. So no `ENV` line in any Dockerfile can carry these — the only
// place left that both placements share is the process itself, and a Working tool child inherits
// what the process holds (`execFile(file, args, { cwd, signal })` passes no env, working-tools.ts).
// Four settings, each with a reason a comment must survive:
//
//   - `umask 002`, so even what the Agent writes OUTSIDE a repo tree lands group-writable for the
//     pod's work group. Inside the trees the attach's default ACL governs creation and the umask
//     is ignored (ADR-0005) — this is the defence-in-depth layer, inert when no second uid writes.
//   - `/opt/jr2/bin` APPENDED to PATH, never prepended (ADR-0037): the image's own `node`, `rg`, and
//     toolchain win where present and jr2's vendored ones are the fallback. Prepending would
//     silently shadow a pinned toolchain inside the user's own image.
//   - `HOME` filled only when the image left it empty, matching the operator's no-`USER` fallback
//     (uid 1000, `HOME=/home/jr2` on an emptyDir). The attach writes `$HOME/.gitconfig` and any real
//     toolchain wants `~/.npm`, `~/.cargo`, `~/.cache`; git with no `HOME` at all fails obscurely.
//   - `GIT_CONFIG_SYSTEM` pointed at jr2's `/opt/jr2/etc/gitconfig`, a default git identity
//     (`jr2 Agent <agent@jr2.invalid>`) at the LOWEST rung of git's config. Without it, an image
//     with no identity makes the Agent's first `git commit` fail ("Author identity unknown"). The
//     file includes the image's `/etc/gitconfig` after its own lines, so the image's system values
//     win, and every higher level (global, XDG, repo-local, `-c`, `GIT_AUTHOR_*`/`GIT_COMMITTER_*`)
//     wins too. An image that sets GIT_CONFIG_SYSTEM or GIT_CONFIG_NOSYSTEM itself gets nothing:
//     it made its own choice about git's system level, and jr2 does not replace it. Nor does an
//     image whose git reads another system file than `/etc/gitconfig` (another prefix), because
//     jr2's file would hide that file.
//
// Called first in `main.ts`, before the spec loads or the server binds.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Where the pod's `/opt/jr2` volume puts jr2's vendored binaries (`node`, `rg`). */
export const RUNTIME_BIN = "/opt/jr2/bin";

/** jr2's default git identity on the runtime volume: git's system level, at the lowest rung (ADR-0037). */
export const RUNTIME_GITCONFIG = "/opt/jr2/etc/gitconfig";

/** The home the operator gives an image that declares no `USER` (ADR-0037). */
export const FALLBACK_HOME = "/home/jr2";

/** Group-writable for the work group, world-unchanged (ADR-0005). */
export const WORK_UMASK = 0o002;

/**
 * The PATH a process gets when its image cleared the variable. Appending `/opt/jr2/bin` to nothing
 * would leave a PATH holding jr2's bin ALONE — the user's toolchain deleted, which is the exact
 * failure appending exists to avoid — so a POSIX-default base goes underneath it first.
 */
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** The system file jr2's own file includes: git's default where git was built with prefix `/usr`. */
const IMAGE_GITCONFIG = "/etc/gitconfig";

/** Where a git built with prefix `/usr` keeps its programs: Debian's and Alpine's, among others. */
const PREFIX_USR_EXEC_PATHS = ["/usr/lib/git-core", "/usr/libexec/git-core"];

/**
 * The system file the image's git reads when nothing sets GIT_CONFIG_SYSTEM, or undefined when it
 * cannot be told (no git on PATH, an unknown build). git 2.42 and later say it (`git var
 * GIT_CONFIG_SYSTEM`); an older git is read from its exec path, because a git built with prefix
 * `/usr` reads `/etc/gitconfig`, and a git built with another prefix (a source build in `/usr/local`,
 * Homebrew, conda) reads `<prefix>/etc/gitconfig`, which jr2's file does not include. `env` is the
 * process's, conditioned (its PATH finds the image's git).
 */
export function imageSystemGitConfig(env: NodeJS.ProcessEnv): string | undefined {
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: "/", env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  const named = git(["var", "GIT_CONFIG_SYSTEM"]);
  if (named.error) return undefined;
  if (named.status === 0) return named.stdout.trim() || undefined;
  const exec = git(["--exec-path"]);
  if (exec.status === 0 && PREFIX_USR_EXEC_PATHS.includes(exec.stdout.trim())) return IMAGE_GITCONFIG;
  return undefined;
}

/**
 * Point git's system level at jr2's default identity, unless that would hide a file the image's
 * git reads. jr2 adds nothing when:
 *   - the image sets `GIT_CONFIG_SYSTEM` (any value) or `GIT_CONFIG_NOSYSTEM` (any value): the image
 *     chose about git's system level itself;
 *   - jr2's file is not on the runtime volume: git reads a missing system file as empty, so pointing
 *     at one would drop the image's `/etc/gitconfig`;
 *   - the image's git reads another system file than `/etc/gitconfig`, or jr2 cannot tell which
 *     (`imageSystemGitConfig`): jr2's file includes `/etc/gitconfig` only, so that file's values
 *     (a `safe.directory`, a credential helper, an identity) would be lost. jr2 does not write a
 *     file that includes the other path: the volume is read-only, and the image's directories are
 *     the image's.
 * Only `GIT_CONFIG_SYSTEM` changes; every git the process and its children run inherits it. jr2's
 * own git calls that must not read the image's config set `GIT_CONFIG_NOSYSTEM` themselves
 * (sync.ts).
 */
export function defaultGitIdentity(
  env: NodeJS.ProcessEnv,
  config: string = RUNTIME_GITCONFIG,
  systemFile: (env: NodeJS.ProcessEnv) => string | undefined = imageSystemGitConfig,
): void {
  if (env.GIT_CONFIG_SYSTEM !== undefined || env.GIT_CONFIG_NOSYSTEM !== undefined) return;
  if (!existsSync(config)) return;
  if (systemFile(env) !== IMAGE_GITCONFIG) return;
  env.GIT_CONFIG_SYSTEM = config;
}

/**
 * Condition the current process for the Sandbox it was injected into: umask, PATH, HOME, and git's
 * default identity.
 *
 * Idempotent on PATH — the stock image also carries the append as an `ENV` (for a human's `exec`
 * shell, which no process-level setting can reach), so both may be true at once and the entry must
 * not accumulate. `env`, `setUmask`, `gitConfig` and `systemFile` are seams for the tests; production passes none.
 */
export function prepareProcess(
  env: NodeJS.ProcessEnv = process.env,
  setUmask: (mask: number) => void = (mask) => {
    process.umask(mask);
  },
  gitConfig: string = RUNTIME_GITCONFIG,
  systemFile: (env: NodeJS.ProcessEnv) => string | undefined = imageSystemGitConfig,
): void {
  setUmask(WORK_UMASK);

  // An EMPTY PATH entry means "the current directory" to every exec that walks PATH, and the
  // current directory here is agent-authored `/work` — so empties are dropped rather than carried.
  const entries = (env.PATH ?? "").split(":").filter((entry) => entry.length > 0);
  if (entries.length === 0) entries.push(...DEFAULT_PATH.split(":"));
  if (!entries.includes(RUNTIME_BIN)) entries.push(RUNTIME_BIN);
  env.PATH = entries.join(":");

  if (!env.HOME) env.HOME = FALLBACK_HOME;

  defaultGitIdentity(env, gitConfig, systemFile);
}
