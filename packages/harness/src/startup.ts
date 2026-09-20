// What the Harness process sets for ITSELF before it serves anything (ADR-0037, ADR-0005).
//
// Since ADR-0037 the Harness is not baked into the image it runs in: the Sandbox Image is the
// user's, byte-for-byte, and jr2's runtime arrives at pod time on the `/opt/jr2` volume with the
// container's command overridden. So no `ENV` line in any Dockerfile can carry these — the only
// place left that both placements share is the process itself, and a Working tool child inherits
// what the process holds (`execFile(file, args, { cwd, signal })` passes no env, working-tools.ts).
// Three settings, each with a reason a comment must survive:
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
//
// Called first in `main.ts`, before the spec loads or the server binds.

/** Where the pod's `/opt/jr2` volume puts jr2's vendored binaries (`node`, `rg`). */
export const RUNTIME_BIN = "/opt/jr2/bin";

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

/**
 * Condition the current process for the Sandbox it was injected into: umask, PATH, HOME.
 *
 * Idempotent on PATH — the stock image also carries the append as an `ENV` (for a human's `exec`
 * shell, which no process-level setting can reach), so both may be true at once and the entry must
 * not accumulate. `env` and `setUmask` are seams for the tests; production passes neither.
 */
export function prepareProcess(
  env: NodeJS.ProcessEnv = process.env,
  setUmask: (mask: number) => void = (mask) => {
    process.umask(mask);
  },
): void {
  setUmask(WORK_UMASK);

  // An EMPTY PATH entry means "the current directory" to every exec that walks PATH, and the
  // current directory here is agent-authored `/work` — so empties are dropped rather than carried.
  const entries = (env.PATH ?? "").split(":").filter((entry) => entry.length > 0);
  if (entries.length === 0) entries.push(...DEFAULT_PATH.split(":"));
  if (!entries.includes(RUNTIME_BIN)) entries.push(RUNTIME_BIN);
  env.PATH = entries.join(":");

  if (!env.HOME) env.HOME = FALLBACK_HOME;
}
