// The Instance's `AGENTS.md` block (ADR-0072): an Assistant reads `AGENTS.md` on every start, so
// the index of the docs this Kit version bundles goes there, between two marker lines. `jr2 init`
// writes the file; `jr2 up` keeps the text between the markers equal to the block of the Kit the
// Instance resolves, because every upgrade ends in `up`. The block's text is the bundle's
// (`docs/agents-block.md` in `@jr2/orchestrator`, assembled by `docs:build`), never this module's,
// so it names its own Kit version and cannot describe another one.
//
// The file is the user's. The markers are the whole contract: a folder without them has opted out,
// so `up` never creates the file or the markers and no config key exists for it; a broken pair is
// said and left alone, since any repair would guess which half the user meant; and every byte
// outside the markers survives a rewrite, line endings included. The block takes the line ending
// of the BEGIN marker's line, so a CRLF checkout compares equal and is not rewritten on every `up`.
//
// Builtins only: `init` reads the bundle from the CLI's own peer, which a global `jr2` has before
// any Instance exists.

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activity, type Io } from "./output.ts";

export const AGENTS_MD = "AGENTS.md";
export const BEGIN_MARKER = "<!-- BEGIN:jr2-docs -->";
export const END_MARKER = "<!-- END:jr2-docs -->";

/** Where the bundle keeps the block, relative to the `@jr2/orchestrator` root. */
export const AGENTS_BLOCK_PATH = join("docs", "agents-block.md");

/** The `AGENTS.md` that `jr2 init` writes: the line that says who owns the markers, the markers
 * with `block` between them (empty when init has no bundle to read), and room for the user's own
 * instructions after the END marker. `templates/default/AGENTS.md` is this with no block. */
export function scaffoldAgentsMd(block = ""): string {
  return (
    "<!-- jr2 up writes the text between the jr2-docs markers. Write your own instructions after the END marker. -->\n" +
    `${BEGIN_MARKER}\n${block}${END_MARKER}\n`
  );
}

/** Claude Code reads `AGENTS.md` only when no `CLAUDE.md` exists, so the scaffold's `CLAUDE.md`
 * imports it and holds nothing else. */
export const CLAUDE_MD = "@AGENTS.md\n";

/** The block a Kit at `kitRoot` bundles; `undefined` when it has none (a checkout before
 * `docs:build`, or a Kit that predates the bundle). */
export function readAgentsBlock(kitRoot: string): string | undefined {
  try {
    return readFileSync(join(kitRoot, AGENTS_BLOCK_PATH), "utf8");
  } catch {
    return undefined;
  }
}

/** Where the block sits in an `AGENTS.md` text: `from` is where the line after BEGIN starts, `to`
 * where the END line starts, and `eol` the BEGIN line's own line ending. */
export type BlockPlace =
  | { kind: "opted-out" }
  | { kind: "broken"; reason: string }
  | { kind: "found"; from: number; to: number; eol: string };

type MarkerLine = { marker: typeof BEGIN_MARKER | typeof END_MARKER; start: number; end: number; eol: string };

/** Each line that IS a marker (a CR before its LF included), with where it starts, where the next
 * line starts, and its own line ending. A marker inside other text on a line is not a marker. */
function markerLines(text: string): MarkerLine[] {
  const found: MarkerLine[] = [];
  let start = 0;
  while (start < text.length) {
    const lf = text.indexOf("\n", start);
    const stop = lf < 0 ? text.length : lf + 1;
    const raw = text.slice(start, lf < 0 ? text.length : lf);
    const eol = lf < 0 ? "" : raw.endsWith("\r") ? "\r\n" : "\n";
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === BEGIN_MARKER || line === END_MARKER) found.push({ marker: line, start, end: stop, eol });
    start = stop;
  }
  return found;
}

/** Find the markers in `text`, or say why there is no block to rewrite. */
export function placeAgentsBlock(text: string): BlockPlace {
  const lines = markerLines(text);
  if (lines.length === 0) return { kind: "opted-out" };
  const begins = lines.filter((l) => l.marker === BEGIN_MARKER);
  const ends = lines.filter((l) => l.marker === END_MARKER);
  if (begins.length > 1) return { kind: "broken", reason: `${BEGIN_MARKER} occurs ${begins.length} times` };
  if (ends.length > 1) return { kind: "broken", reason: `${END_MARKER} occurs ${ends.length} times` };
  const [begin] = begins;
  const [end] = ends;
  if (!begin) return { kind: "broken", reason: `${END_MARKER} has no ${BEGIN_MARKER} before it` };
  if (!end) return { kind: "broken", reason: `${BEGIN_MARKER} has no ${END_MARKER} after it` };
  if (end.start < begin.start) return { kind: "broken", reason: `${END_MARKER} comes before ${BEGIN_MARKER}` };
  return { kind: "found", from: begin.end, to: end.start, eol: begin.eol };
}

/** What {@link rewriteAgentsBlock} found. Only `updated` carries a text to write. */
export type BlockRewrite =
  | Exclude<BlockPlace, { kind: "found" }>
  | { kind: "current" }
  | { kind: "updated"; text: string };

/**
 * Put `block` between the markers of the `AGENTS.md` text `text`. Pure: the caller reads and
 * writes. `block` is the bundle's, with LF line endings; it is written with the BEGIN line's.
 */
export function rewriteAgentsBlock(text: string, block: string): BlockRewrite {
  const place = placeAgentsBlock(text);
  if (place.kind !== "found") return place;
  const wanted = place.eol === "\r\n" ? block.replace(/\r?\n/g, "\r\n") : block;
  if (text.slice(place.from, place.to) === wanted) return { kind: "current" };
  return { kind: "updated", text: text.slice(0, place.from) + wanted + text.slice(place.to) };
}

/**
 * `jr2 up`'s step: bring the Instance's `AGENTS.md` to the block of the Kit at `kitRoot`, which is
 * `version`. Says what it did on stderr in at most one line, and nothing when there was nothing to
 * do. Never throws for the file's content, and never refuses the converge: the block describes the
 * installed Kit, not the cluster.
 */
export async function syncAgentsMd(io: Io, root: string, kitRoot: string, version: string): Promise<void> {
  // Read and written as latin1, one char per byte, so a byte outside the markers that is not valid
  // UTF-8 survives too. The markers are ASCII; the block is re-encoded to match.
  let text: string;
  try {
    text = (await readFile(join(root, AGENTS_MD))).toString("latin1");
  } catch {
    return; // no AGENTS.md: opted out
  }
  // The markers are checked before the bundle is read, so a broken pair is said even by a Kit
  // with no bundle.
  const place = placeAgentsBlock(text);
  if (place.kind === "opted-out") return;
  if (place.kind === "broken") {
    activity(io, `warning: AGENTS.md: ${place.reason}, so the jr2 block was not updated`);
    return;
  }
  const block = readAgentsBlock(kitRoot);
  if (block === undefined) {
    activity(
      io,
      `AGENTS.md: jr2 block not updated: the Kit at ${kitRoot} has no ${AGENTS_BLOCK_PATH} ` +
        "(a kit checkout makes it with docs:build)",
    );
    return;
  }
  const rewrite = rewriteAgentsBlock(text, Buffer.from(block, "utf8").toString("latin1"));
  if (rewrite.kind !== "updated") return;
  await writeFile(join(root, AGENTS_MD), Buffer.from(rewrite.text, "latin1"));
  activity(io, `AGENTS.md: jr2 block updated for ${version}`);
}
