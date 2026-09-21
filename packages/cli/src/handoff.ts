// The Handoff (ADR-0056, the gulp/grunt model): a global `jr2` run inside an Instance that resolves
// its own `@jr2/cli` to a DIFFERENT copy runs that copy's binary with the same arguments and stdio,
// returns its exit code, and does nothing else. So the copy that runs is the one the Instance pins,
// and the global's version stops mattering inside an Instance. No Instance, or the Instance resolves
// the running copy itself (a workspace member in the checkout, `npx jr2`): no handoff.
//
// Spawn, not import. gulp loads local gulp in-process because local gulp is a LIBRARY; here the
// local is a BINARY, and spawning couples the global to one contract — the package's `bin` field,
// npm's own — where importing `src/cli.ts` would make the local's internal layout a cross-version
// API the global (the copy that cannot be updated once shipped) must honor forever. The local's own
// preamble runs: its pinned erasure hook, whatever a future bin adds.
//
// Plus one env var (ADR-0056 as amended): the copy that hands off names itself in
// `JR2_HANDOFF_FROM`, because "is my global out of date" is the one fact the local copy cannot
// learn on its own, and `jr2 version` answers it from here. Nothing else reads it.
//
// Builtins only, like everything the launcher runs before it knows which `jr2` will run.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { CLI_ROOT, CLI_VERSION, resolvePackage } from "./kit-version.ts";
import { findRoot } from "./root.ts";

/** `<version> <realpath>` of the copy that handed off — set on the child by {@link handoff}. */
export const HANDOFF_ENV = "JR2_HANDOFF_FROM";

/** The copy that handed off to this process, if one did and said so. A global that predates the
 * variable hands off silently, which reads the same as no handoff at all — there is no third source. */
export function handedOffFrom(env: Record<string, string | undefined>): { version: string; path: string } | undefined {
  const raw = env[HANDOFF_ENV];
  if (!raw) return undefined;
  const sp = raw.indexOf(" ");
  if (sp < 0) return undefined;
  return { version: raw.slice(0, sp), path: raw.slice(sp + 1) };
}

/** The local binary to hand off to, or `undefined` when this copy is the one that runs. */
export function handoffTarget(cwd: string, selfRoot: string = CLI_ROOT): string | undefined {
  const root = findRoot(cwd);
  if (!root) return undefined;
  const local = resolvePackage("@jr2/cli", root);
  if (!local || local.root === selfRoot) return undefined;
  const bin = typeof local.bin === "string" ? local.bin : local.bin?.jr2;
  return bin ? join(local.root, bin) : undefined;
}

/** Run `bin` with `argv` on this node, sharing stdio; resolves to its exit code. A child that dies
 * by signal re-raises that signal here, so the shell sees what it would have seen. */
export function handoff(bin: string, argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...argv], {
      stdio: "inherit",
      env: { ...process.env, [HANDOFF_ENV]: `${CLI_VERSION} ${CLI_ROOT}` },
    });
    child.on("error", (err) => {
      process.stderr.write(`error: cannot run ${bin}: ${err.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      resolve(code ?? 1);
    });
  });
}
