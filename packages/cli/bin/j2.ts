#!/usr/bin/env node
// The `j2` binary (ADR-0009). A zero-build `.ts` shebang script: Node 24 type-strips it (and every
// `.ts` it imports, including `@j2/orchestrator`) at load, so there is no compile step. pnpm links
// this as the `j2` bin; `pnpm exec j2 …` from an instance folder is the human entrypoint.
//
// It does nothing but hand argv to `main` and surface the exit code. `main` is pure-ish (takes an
// injectable IO) so the dispatch + commands are unit-testable without spawning a process.

import { main } from "../src/cli.ts";

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
