// The process conditioning the Harness does for itself (ADR-0037, ADR-0005). Every claim here is
// invisible in a Dockerfile now: a Sandbox runs the USER'S image, so the umask, the PATH append,
// the HOME default and git's default identity exist only because this code runs — and a Working
// tool child inherits them from the process, never from an `ENV`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FALLBACK_HOME,
  imageSystemGitConfig,
  prepareProcess,
  RUNTIME_BIN,
  RUNTIME_GITCONFIG,
  WORK_UMASK,
} from "../src/startup.ts";

/** A umask sink, so the suite never moves the real process's mask under the other tests. */
function rig(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; masks: number[] } {
  const masks: number[] = [];
  prepareProcess(env, (mask) => masks.push(mask));
  return { env, masks };
}

test("umask 002: what the Agent writes on /work is group-writable for the work group", () => {
  const { masks } = rig({});
  assert.deepEqual(masks, [WORK_UMASK]);
  assert.equal(WORK_UMASK, 0o002);
});

test("PATH APPENDS /opt/jr2/bin — the image's own toolchain still wins", () => {
  const { env } = rig({ PATH: "/usr/local/bin:/usr/bin" });
  assert.equal(env.PATH, `/usr/local/bin:/usr/bin:${RUNTIME_BIN}`);
});

test("PATH: the append does not accumulate — the stock image carries it as ENV too", () => {
  const { env } = rig({ PATH: `/usr/bin:${RUNTIME_BIN}` });
  assert.equal(env.PATH, `/usr/bin:${RUNTIME_BIN}`);
});

test("PATH: an image that cleared PATH gets a POSIX base under the append, never jr2's bin alone", () => {
  const { env } = rig({});
  const entries = (env.PATH ?? "").split(":");
  assert.ok(entries.includes("/usr/bin"), "the toolchain a bare PATH would have deleted");
  assert.equal(entries.at(-1), RUNTIME_BIN, "jr2's bin stays the fallback, never the first hit");
});

test("PATH: an empty entry — which means the cwd, and the cwd is agent-authored — is dropped", () => {
  const { env } = rig({ PATH: "/usr/bin::" });
  assert.equal(env.PATH, `/usr/bin:${RUNTIME_BIN}`);
});

test("HOME: an image's own HOME is left alone — the exec'ing human lands where its author built", () => {
  const { env } = rig({ HOME: "/home/dev" });
  assert.equal(env.HOME, "/home/dev");
});

test("HOME: unset or empty falls back to the operator's no-USER home", () => {
  assert.equal(rig({}).env.HOME, FALLBACK_HOME);
  assert.equal(rig({ HOME: "" }).env.HOME, FALLBACK_HOME);
});

// git's default identity (ADR-0037): jr2's file is git's system level, the LOWEST rung. Each test
// runs the real `git var GIT_AUTHOR_IDENT` in a temp HOME with a cleared environment, against the
// shipped file with one change: its include points at a temp file in place of the image's
// /etc/gitconfig, which a test cannot write. The system-file probe is a seam that answers
// /etc/gitconfig, so these tests do not depend on how the host's git was built.

const JR2_IDENT = "jr2 Agent <agent@jr2.invalid>";
const SHIPPED = fileURLToPath(new URL("../../../deploy/harness/gitconfig", import.meta.url));

type GitRig = { root: string; home: string; config: string; etc: string; env: NodeJS.ProcessEnv };

/** A temp HOME, jr2's file with its include at `etc` (absent until a test writes it), and a cleared
 * env run through `prepareProcess`. `env` is what the image set before the Harness started. */
function gitRig(env: NodeJS.ProcessEnv = {}): GitRig {
  const root = mkdtempSync(join(tmpdir(), "jr2-gitident-"));
  const home = join(root, "home");
  mkdirSync(home);
  const etc = join(root, "etc-gitconfig");
  const config = join(root, "jr2-gitconfig");
  const shipped = readFileSync(SHIPPED, "utf8");
  assert.match(shipped, /path = \/etc\/gitconfig\n/, "the shipped file includes the image's /etc/gitconfig");
  writeFileSync(config, shipped.replace("path = /etc/gitconfig", `path = ${etc}`));
  const full: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    ...env,
  };
  prepareProcess(
    full,
    () => {},
    config,
    () => "/etc/gitconfig",
  );
  return { root, home, config, etc, env: full };
}

/** The author line git would write, or its error. */
function ident(rig: GitRig, opts: { cwd?: string; args?: string[] } = {}): string {
  try {
    return execFileSync("git", [...(opts.args ?? []), "var", "GIT_AUTHOR_IDENT"], {
      cwd: opts.cwd ?? rig.root,
      env: rig.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/ \d+ [+-]\d{4}\n$/, "");
  } catch (error) {
    return `error: ${String((error as { stderr?: string }).stderr ?? error)}`;
  }
}

const userConfig = (name: string, email: string) => `[user]\n\tname = ${name}\n\temail = ${email}\n`;

test("git identity: an image with no git config commits as jr2 Agent", () => {
  const rig = gitRig();
  assert.equal(rig.env.GIT_CONFIG_SYSTEM, rig.config);
  assert.equal(ident(rig), JR2_IDENT);
});

test("git identity: the image's /etc/gitconfig wins over jr2's lines, key by key", () => {
  const rig = gitRig();
  writeFileSync(rig.etc, userConfig("Image Bot", "bot@image.example"));
  assert.equal(ident(rig), "Image Bot <bot@image.example>");
  writeFileSync(rig.etc, "[user]\n\tname = Image Bot\n");
  assert.equal(ident(rig), "Image Bot <agent@jr2.invalid>", "a key the image did not set stays jr2's");
});

test("git identity: the global ~/.gitconfig and the XDG config win", () => {
  const rig = gitRig();
  writeFileSync(join(rig.home, ".gitconfig"), userConfig("Global", "global@example"));
  assert.equal(ident(rig), "Global <global@example>");
  const xdg = gitRig();
  mkdirSync(join(xdg.home, ".config", "git"), { recursive: true });
  writeFileSync(join(xdg.home, ".config", "git", "config"), userConfig("Xdg", "xdg@example"));
  assert.equal(ident(xdg), "Xdg <xdg@example>");
});

test("git identity: repo-local config, `-c`, and GIT_AUTHOR_* win", () => {
  const rig = gitRig();
  const repo = join(rig.root, "repo");
  execFileSync("git", ["init", "-q", repo], { env: rig.env });
  execFileSync("git", ["-C", repo, "config", "user.name", "Local"], { env: rig.env });
  execFileSync("git", ["-C", repo, "config", "user.email", "local@example"], { env: rig.env });
  assert.equal(ident(rig, { cwd: repo }), "Local <local@example>");
  assert.equal(ident(rig, { args: ["-c", "user.name=Flag", "-c", "user.email=flag@example"] }), "Flag <flag@example>");
  rig.env.GIT_AUTHOR_NAME = "Env";
  rig.env.GIT_AUTHOR_EMAIL = "env@example";
  assert.equal(ident(rig), "Env <env@example>");
});

test("git identity: an image that sets GIT_CONFIG_SYSTEM keeps its own file, and jr2 adds nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "jr2-gitident-own-"));
  const own = join(root, "own-gitconfig");
  writeFileSync(own, userConfig("Own System", "own@example"));
  const rig = gitRig({ GIT_CONFIG_SYSTEM: own });
  assert.equal(rig.env.GIT_CONFIG_SYSTEM, own);
  assert.equal(ident(rig), "Own System <own@example>");
  const empty = gitRig({ GIT_CONFIG_SYSTEM: "" });
  assert.equal(empty.env.GIT_CONFIG_SYSTEM, "", "an empty value is the image's choice too");
});

test("git identity: an image that sets GIT_CONFIG_NOSYSTEM gets no system file, jr2's included", () => {
  const rig = gitRig({ GIT_CONFIG_NOSYSTEM: "1" });
  assert.equal(rig.env.GIT_CONFIG_SYSTEM, undefined);
  assert.notEqual(ident(rig), JR2_IDENT);
});

test("git identity: with no file on the runtime volume, jr2 sets nothing — the image's /etc/gitconfig is not dropped", () => {
  const env: NodeJS.ProcessEnv = {};
  prepareProcess(env, () => {}, "/nonexistent/jr2/gitconfig");
  assert.equal(env.GIT_CONFIG_SYSTEM, undefined);
  assert.equal(RUNTIME_GITCONFIG, "/opt/jr2/etc/gitconfig");
});

// Which system file the image's git reads decides whether jr2 may set GIT_CONFIG_SYSTEM: its file
// includes /etc/gitconfig only, so a git built with another prefix would lose its own system file.
// Each fake `git` answers `var GIT_CONFIG_SYSTEM` and `--exec-path` as one git build does.

/** A PATH holding only a fake `git`: `named` is what `git var GIT_CONFIG_SYSTEM` prints (undefined:
 * the usage error of a git older than 2.42), `exec` what `git --exec-path` prints. */
function fakeGit(named: string | undefined, exec: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jr2-fakegit-"));
  const script =
    "#!/bin/sh\n" +
    'if [ "$1" = var ] && [ "$2" = GIT_CONFIG_SYSTEM ]; then\n' +
    (named === undefined
      ? "  echo 'usage: git var (-l | <variable>)' >&2; exit 129\n"
      : `  echo '${named}'; exit 0\n`) +
    "fi\n" +
    `if [ "$1" = --exec-path ]; then echo '${exec}'; exit 0; fi\n` +
    "exit 1\n";
  writeFileSync(join(dir, "git"), script, { mode: 0o755 });
  return dir;
}

/** What `prepareProcess` sets with this PATH and an existing jr2 file. */
function systemWith(path: string): string | undefined {
  const config = join(mkdtempSync(join(tmpdir(), "jr2-gitcfg-")), "gitconfig");
  writeFileSync(config, "");
  const env: NodeJS.ProcessEnv = { PATH: path };
  prepareProcess(env, () => {}, config);
  return env.GIT_CONFIG_SYSTEM === undefined ? undefined : "set";
}

test("git identity: a git 2.42+ that reads /etc/gitconfig gets jr2's file", () => {
  assert.equal(imageSystemGitConfig({ PATH: fakeGit("/etc/gitconfig", "/usr/lib/git-core") }), "/etc/gitconfig");
  assert.equal(systemWith(fakeGit("/etc/gitconfig", "/usr/lib/git-core")), "set");
});

test("git identity: a git 2.42+ built with another prefix gets nothing — its own system file stays", () => {
  assert.equal(systemWith(fakeGit("/usr/local/etc/gitconfig", "/usr/local/libexec/git-core")), undefined);
  assert.equal(systemWith(fakeGit("/opt/homebrew/etc/gitconfig", "/usr/lib/git-core")), undefined, "var wins");
});

test("git identity: an older git is read by its exec path — prefix /usr gets jr2's file, another prefix nothing", () => {
  assert.equal(systemWith(fakeGit(undefined, "/usr/lib/git-core")), "set", "Debian");
  assert.equal(systemWith(fakeGit(undefined, "/usr/libexec/git-core")), "set", "Alpine, Fedora");
  assert.equal(systemWith(fakeGit(undefined, "/usr/local/libexec/git-core")), undefined, "a source build");
  assert.equal(systemWith(fakeGit(undefined, "/opt/conda/libexec/git-core")), undefined, "conda");
});

test("git identity: no git on PATH gets nothing", () => {
  const empty = mkdtempSync(join(tmpdir(), "jr2-nogit-"));
  assert.equal(imageSystemGitConfig({ PATH: empty }), undefined);
  assert.equal(systemWith(empty), undefined);
});
