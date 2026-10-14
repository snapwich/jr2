// `pnpm docs:build [--partial] [--out <dir>]` (ADR-0072): build the docs bundle, and write it to
// packages/orchestrator/docs, or to `--out`. Every error is printed as `file:line: message`, and
// any error writes nothing and exits 1.

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { buildDocs, DEFAULT_OUT, writeBundle } from "./build.ts";
import { formatError } from "./markdown.ts";

const USAGE = "usage: docs:build [--partial] [--out <dir>]";

let values: { partial?: boolean; out?: string; help?: boolean };
try {
  ({ values } = parseArgs({
    options: { partial: { type: "boolean" }, out: { type: "string" }, help: { type: "boolean", short: "h" } },
  }));
} catch (e) {
  console.error(`docs:build: ${(e as Error).message}\n${USAGE}`);
  process.exit(2);
}
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

// pnpm runs a package script in the package's folder; INIT_CWD is where the user typed it, which is
// what a relative --out means.
const out = values.out ? resolve(process.env.INIT_CWD ?? process.cwd(), values.out) : DEFAULT_OUT;
const started = performance.now();
const result = await buildDocs({ partial: values.partial ?? false });
if (result.errors.length) {
  for (const e of result.errors) console.error(formatError(e));
  console.error(`docs:build: ${result.errors.length} error(s); nothing written`);
  process.exit(1);
}
await writeBundle(result.files, out);
const skipped = result.skipped.length ? `, ${result.skipped.length} sitemap page(s) skipped (--partial)` : "";
const ms = Math.round(performance.now() - started);
console.error(`docs:build: ${result.files.size} files in ${out}${skipped} (${ms} ms)`);
