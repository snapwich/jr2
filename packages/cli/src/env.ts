// `.env` at the instance root (ADR-0019). Deployment-varying values — a vLLM `baseUrl`, a model
// specifier, provider keys — must NOT be hardcoded in `j2.config.ts`; the config reads them from
// `process.env`, and the uncommitted `.env` beside it is where they live. This is the loader that
// makes that literal, rather than a `set -a; . ./.env; set +a` ritual the user has to remember (and
// whose omission fails SILENTLY: an unset var just makes `harness.provider` undefined).
//
// Discovery mirrors `resolveRoot` — walk up from cwd to the folder holding `j2.config.ts`, read the
// `.env` beside it — so `j2` works from any subdirectory of an instance. Outside an instance
// (`j2 init`) or with no file: nothing happens, never an error.
//
// Precedence: the REAL environment always wins. `VLLM_BASE_URL=… j2 up` and an exported shell var
// both override the file, so `.env` is the default layer, not an override one.
//
// Applied keys (never values) are announced on stderr, for the same reason `resolveTarget` prints
// its target: ambient context that changes what a command does stays visible.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRoot } from "./instance.ts";
import { activity, type Io } from "./output.ts";

/**
 * Load the instance's `.env` into `io.env`, without clobbering what is already set.
 *
 * Mutates `io.env` in place ON PURPOSE: in the real bin that object IS `process.env`, and instance
 * config modules read `process.env` directly, so a copy would never reach them. Must therefore run
 * before anything imports `j2.config.ts` — `main` calls it first thing.
 */
export function loadDotenv(io: Io): void {
  const root = findRoot(io.cwd);
  if (!root) return;

  let text: string;
  try {
    text = readFileSync(join(root, ".env"), "utf8");
  } catch {
    return; // no .env is the normal case, not a failure
  }

  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseDotenv(text))) {
    if (io.env[key] !== undefined) continue; // the real environment wins
    io.env[key] = value;
    applied.push(key);
  }
  if (applied.length > 0) activity(io, `→ .env: ${applied.join(", ")}`);
}

// One assignment per match: an optional `export `, the key, then a single-quoted (literal),
// double-quoted (escapes honored), or bare value. Quoted forms may span lines — deploy keys are a
// plausible thing to park here. A bare value ends at ` #`, so trailing comments don't leak in.
const ASSIGNMENT =
  /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|([^#\r\n]*?))[ \t]*(?:#[^\r\n]*)?$/gm;

/** Parse `.env` text into a plain record. Malformed lines are ignored, not fatal. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, key, single, double, bare] of text.replace(/^﻿/, "").matchAll(ASSIGNMENT)) {
    if (!key) continue;
    out[key] = single ?? (double !== undefined ? unescape(double) : (bare ?? ""));
  }
  return out;
}

/** Double-quoted values honor the usual escapes; everything else passes through verbatim. */
function unescape(value: string): string {
  return value.replace(/\\([nrt"'\\])/g, (_, ch: string) => ({ n: "\n", r: "\r", t: "\t" })[ch] ?? ch);
}
