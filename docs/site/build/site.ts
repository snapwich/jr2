// `pnpm docs:site` and `pnpm docs:dev` run this before VitePress (ADR-0072): build the bundle,
// strict, into .vitepress/bundle, and put its Reference into reference/, where VitePress renders it
// beside the hand-written pages, made safe for Vue's compiler (`vueSafe`). Both folders are
// generated and not in git. The site's build then copies the bundle beside the HTML
// (.vitepress/config.ts), so a page's `.md` URL serves exactly what the Kit ships.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocs, writeBundle } from "./build.ts";
import { formatError } from "./markdown.ts";
import { vueSafe } from "./vitepress.ts";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = join(SITE, ".vitepress/bundle");
const REFERENCE = join(SITE, "reference");

const started = performance.now();
// Before the build: a stale Reference page must not be there while the links are checked.
await rm(REFERENCE, { recursive: true, force: true });
const result = await buildDocs();
if (result.errors.length) {
  for (const e of result.errors) console.error(formatError(e));
  console.error(`docs:site: ${result.errors.length} error(s) in the bundle; the site is not built`);
  process.exit(1);
}
await writeBundle(result.files, BUNDLE);
for (const [path, text] of result.files) {
  if (!path.startsWith("reference/")) continue;
  const file = join(SITE, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, vueSafe(text));
}
console.error(`docs:site: the bundle and its Reference are ready (${Math.round(performance.now() - started)} ms)`);
