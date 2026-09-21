#!/usr/bin/env node
// The `jr2` binary (ADR-0009). The kit is zero-build `.ts` — but Node's own type stripping REFUSES
// to run on files under `node_modules`, and an installed kit is nothing but files under
// `node_modules` (ADR-0043). So this entry is the one `.js` file in the package: it teaches the
// loader to erase types the same way Node would, then hands over to the `.ts` sources.
//
// One entry for both worlds, deliberately: a checkout-only `.ts` bin plus an installed-only `.js`
// bin would mean the binary users run is not the binary the checkout's tiers run. The image
// bundle solves the same problem with `tsx` (see INSTANCE_DOCKERFILE) because there the entry is
// the orchestrator's, not this one.
//
// After the hook, the launcher's one decision (ADR-0056): inside an Instance that resolves its own
// `@jr2/cli` to a different copy, hand off — run THAT copy's binary with the same argv and stdio
// and exit with its code — so the `jr2` that runs is the one the Instance pins, whatever this one's
// version is. Otherwise hand argv to `main` and surface the exit code. `main` is pure-ish (takes an
// injectable IO) so the dispatch + commands stay unit-testable without a process. The handoff
// modules import no kit code: a global with no orchestrator beside it can still hand off.

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import tsBlankSpace from "ts-blank-space";

// Erasure, not compilation: types are replaced by whitespace, so line and column numbers in a
// stack trace still point at the source (ADR-0034 makes the same trade for the Console). What
// `ts-blank-space` cannot erase — an enum, a namespace, a constructor parameter property — is
// exactly what Node's own stripping rejects too, so this hook widens where the kit runs, never
// what the kit may be written in. `module` is the only format the kit ships: every jr2 package is
// `type: "module"`, and the hook sees kit sources only (the CLI imports no instance code).
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
    const source = tsBlankSpace(readFileSync(fileURLToPath(url), "utf8"));
    return { format: "module", source, shortCircuit: true };
  },
});

const argv = process.argv.slice(2);
const { handoffTarget, handoff } = await import("../src/handoff.ts");
const local = handoffTarget(process.cwd());
if (local) {
  process.exitCode = await handoff(local, argv);
} else {
  const { main } = await import("../src/cli.ts");
  process.exitCode = await main(argv);
}
