// The Instance's own typecheck, run as a converge gate (ADR-0050). A Machine names its parts by
// string — an actor slot, a composed Machine, a `customize()` of either, a Repo Slot it binds
// (ADR-0051) — and since ADR-0049 those strings are typed by xstate's own `src` typing and by the
// Machine's own parts. A type error is therefore the EARLIEST place a wrong name can be caught,
// so `jr2 up` runs the compiler first: a mistyped slot is refused here, before a bundle, three
// image builds, and a rollout are spent on a Machine that would fail at invoke time mid-run.
// The one check that is converge-time and not compile-time is an OPEN Repo Slot nobody bound: a
// `workflows/` export has no type to hang it on, so `jr2 up`'s walk refuses it right after this gate.
//
// The compiler is the INSTANCE's, resolved from its own `node_modules` (ADR-0043): the instance's
// program includes @jr2/orchestrator's `.ts` sources (zero-build — `exports` point at source), so
// the checker is part of the kit contract and the scaffold pins it in `devDependencies`. A
// compiler the CLI carried would check the user's code with a version their editor and their own
// `npm run typecheck` never run, and would report the kit's sources against a compiler the kit
// never ran — the exact failure that put `typescript` in the scaffold in the first place.
//
// It runs the same two inputs the user's own `typecheck` script runs — `tsc --noEmit` against the
// folder's `tsconfig.json` — so `jr2 up`'s answer and the editor's are one answer.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** What the compiler said. `output` is empty exactly when `ok`. */
export type TypecheckResult = { ok: boolean; output: string };

/** Typecheck one Instance folder. Injectable through `io.typecheck` so the CLI's own unit tests
 * drive the gate's two answers without spending a compiler on a fixture in the temp dir. */
export type TypecheckPort = (root: string) => Promise<TypecheckResult>;

/** The real port: the Instance's own `tsc`, in the Instance's own folder. */
export const tscTypecheck: TypecheckPort = async (root) => {
  if (!existsSync(join(root, "tsconfig.json"))) {
    throw new Error(
      "this instance has no tsconfig.json — `jr2 init` scaffolds one that extends " +
        "`@jr2/orchestrator/tsconfig.instance.json`, and `jr2 up` typechecks the folder before it builds anything",
    );
  }
  const tsc = compilerBin(root);
  try {
    // `--pretty false` because this output is relayed, not drawn: one `file(line,col): error TSxxxx`
    // per line survives a pipe, a CI log, and the `activity` prefix that carries it to stderr.
    await exec(process.execPath, [tsc, "--noEmit", "--pretty", "false"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, output: "" };
  } catch (err) {
    // tsc reports on STDOUT and exits non-zero; a compiler that failed to start reports on stderr.
    // Both are the answer here — the gate's job is to show what the compiler said, not to classify it.
    const failed = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}`.trim() };
  }
};

/** `typescript`'s own `tsc`, as the package declares it, resolved from the Instance. */
function compilerBin(root: string): string {
  // Resolution starts at a file INSIDE the instance (the root marker), so it walks the instance's
  // own `node_modules` first and finds what the folder installed — never what the CLI carries.
  const requireFrom = createRequire(join(root, "jr2.config.ts"));
  let manifest: string;
  try {
    manifest = requireFrom.resolve("typescript/package.json");
  } catch {
    throw new Error(
      "this instance's TypeScript compiler is missing — install its dependencies (npm, pnpm, or bun), then " +
        "re-run `jr2 up`. The scaffold pins `typescript` in devDependencies because the instance's program " +
        "includes the kit's own .ts sources, so the checker travels with the kit rather than floating (ADR-0043)",
    );
  }
  const bin = (requireFrom(manifest) as { bin?: { tsc?: string } }).bin?.tsc;
  if (!bin) throw new Error(`the \`typescript\` at ${dirname(manifest)} declares no \`tsc\` binary`);
  return resolve(dirname(manifest), bin);
}
