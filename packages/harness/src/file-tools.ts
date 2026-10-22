// Ported from @earendil-works/pi-agent-core 0.82.1 (MIT, see PI-LICENSE): dist/harness/tools/{read,write,edit,edit-diff,path-utils,file-mutation-queue,image}.js and the path rules of dist/harness/env/nodejs.js
//
// The file Working tools (ADR-0027/0028): `read`, `write` and `edit`. pi 1.x removed them from
// pi-agent-core, so jr2 owns them now. What the model reads stays pi 0.82.1's, byte for byte: the
// names, the descriptions and the parameter schemas (`test/working-tools.test.ts` compares them with
// the golden capture), each result text and each error text. Two changes, each with its reason:
// `write` counts UTF-8 bytes, not UTF-16 units (its text says "bytes"), and `edit` returns no diff
// details, which nothing read (the printer never prints a Working tool's result, ADR-0023).
//
// Each tool closes over the Frame's `cwd` (ADR-0057): a relative path resolves against it. The
// schemas stay TypeBox (`Type` from pi-ai), so pi-ai coerces the arguments as it did on 0.82.1.

import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.ts";

// ─── the path rules ──────────────────────────────────────────────────────────

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

/** The environment's rule (pi's `resolvePath`): `~` and `~/x` under the home directory, a
 * `file://` URL to its path (a malformed one stays an ordinary path), a relative path against
 * `cwd`. */
export function resolvePath(cwd: string, path: string): string {
  let normalized = path;
  if (normalized === "~") {
    normalized = homedir();
  } else if (normalized.startsWith("~/")) {
    normalized = join(homedir(), normalized.slice(2));
  } else if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // A malformed URL is an ordinary path.
    }
  }
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

/** The tools' rule over the environment's: the Unicode spaces become a plain space, and a leading
 * `@` goes (a model that copies a path from a mention). */
function resolveToolPath(cwd: string, path: string): string {
  const spaced = path.replace(UNICODE_SPACES, " ");
  return resolvePath(cwd, spaced.startsWith("@") ? spaced.slice(1) : spaced);
}

/** `read` alone also tries the macOS variants of a name: a narrow no-break space before AM/PM
 * (screenshots), NFD, and a curly apostrophe. */
async function resolveReadToolPath(cwd: string, path: string): Promise<string> {
  const resolved = resolveToolPath(cwd, path);
  const variants = [
    resolved,
    resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
    resolved.normalize("NFD"),
    resolved.replace(/'/g, "\u2019"),
    resolved.normalize("NFD").replace(/'/g, "\u2019"),
  ];
  for (const variant of new Set(variants)) {
    if (await exists(variant)) return variant;
  }
  return resolved;
}

// ─── the file system, as pi's environment answered ───────────────────────────

/** pi's `FileError` codes, which `edit` names in its access error. */
function fileErrorCode(err: unknown): string {
  switch ((err as NodeJS.ErrnoException).code) {
    case "ABORT_ERR":
      return "aborted";
    case "ENOENT":
      return "not_found";
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    case "ENOTDIR":
      return "not_directory";
    case "EISDIR":
      return "is_directory";
    case "EINVAL":
      return "invalid";
    default:
      return "unknown";
  }
}

/** An error whose message and code pi's environment gave. */
class FileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function fileError(err: unknown): FileError {
  if (err instanceof FileError) return err;
  return new FileError(fileErrorCode(err), err instanceof Error ? err.message : String(err));
}

/** `lstat`'s kind, or an `invalid` error for a kind pi did not know (a socket, a FIFO). */
async function kindOf(path: string): Promise<"file" | "directory" | "symlink"> {
  const stats = await lstat(path).catch((err: unknown) => {
    throw fileError(err);
  });
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  throw new FileError("invalid", "Unsupported file type");
}

/** True when the path is there; false only when it is missing. Any other error throws. */
async function exists(path: string): Promise<boolean> {
  try {
    await kindOf(path);
    return true;
  } catch (err) {
    if (err instanceof FileError && err.code === "not_found") return false;
    throw err;
  }
}

function aborted(signal: AbortSignal | undefined): FileError | undefined {
  return signal?.aborted ? new FileError("aborted", "aborted") : undefined;
}

async function writeContent(path: string, content: string, signal: AbortSignal | undefined): Promise<void> {
  const before = aborted(signal);
  if (before) throw before;
  try {
    await mkdir(resolve(path, ".."), { recursive: true });
    const afterMkdir = aborted(signal);
    if (afterMkdir) throw afterMkdir;
    await writeFile(path, content, { signal });
  } catch (err) {
    throw fileError(err);
  }
}

// ─── the file-mutation queue ─────────────────────────────────────────────────

/** Writes and edits to one canonical path run one after the other. One queue for each tool set
 * (one tool set for each Submission), as pi keyed it by its environment. */
type MutationQueue = { queues: Map<string, Promise<void>>; registration: Promise<void> };

async function mutationKey(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw fileError(err);
  }
}

async function withFileMutationQueue<T>(state: MutationQueue, path: string, fn: () => Promise<T>): Promise<T> {
  const registration = state.registration.then(async () => {
    const key = await mutationKey(path);
    const currentQueue = state.queues.get(key) ?? Promise.resolve();
    let releaseNext = () => {};
    const nextQueue = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    const chainedQueue = currentQueue.then(() => nextQueue);
    state.queues.set(key, chainedQueue);
    return { key, currentQueue, chainedQueue, releaseNext };
  });
  state.registration = registration.then(
    () => undefined,
    () => undefined,
  );
  const { key, currentQueue, chainedQueue, releaseNext } = await registration;
  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (state.queues.get(key) === chainedQueue) state.queues.delete(key);
  }
}

// ─── read ────────────────────────────────────────────────────────────────────

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

function readTool(cwd: string): AgentTool<typeof readSchema> {
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: readSchema,
    async execute(_toolCallId, { path, offset, limit }, signal) {
      const absolutePath = await resolveReadToolPath(cwd, path);
      const before = aborted(signal);
      if (before) throw before;
      const bytes = await readFile(absolutePath, { signal }).catch((err: unknown) => {
        throw fileError(err);
      });
      const mimeType = detectSupportedImageMimeType(bytes);
      if (mimeType === "image/bmp") {
        return {
          content: [
            {
              type: "text",
              text: "Read image file [image/bmp]\n[Image omitted: configure an imageProcessor to convert BMP images.]",
            },
          ],
          details: undefined,
        };
      }
      if (mimeType) {
        return {
          content: [
            { type: "text", text: `Read image file [${mimeType}]` },
            { type: "image", data: bytes.toString("base64"), mimeType },
          ],
          details: undefined,
        };
      }
      // `TextDecoder` drops a leading BOM, as pi's did.
      const allLines = new TextDecoder().decode(bytes).split("\n");
      const totalFileLines = allLines.length;
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      const startLineDisplay = startLine + 1;
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
      }
      let selectedContent: string;
      let userLimitedLines: number | undefined;
      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
      } else {
        selectedContent = allLines.slice(startLine).join("\n");
      }
      const truncation = truncateHead(selectedContent);
      let outputText: string;
      let details: { truncation: typeof truncation } | undefined;
      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine]!, "utf8"));
        outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
        details = { truncation };
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText = truncation.content;
        if (truncation.truncatedBy === "lines") {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
        } else {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
        }
        details = { truncation };
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText = truncation.content;
      }
      return { content: [{ type: "text", text: outputText }], details };
    },
  };
}

// ─── write ───────────────────────────────────────────────────────────────────

const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
});

function writeTool(cwd: string, queue: MutationQueue): AgentTool<typeof writeSchema> {
  return {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    async execute(_toolCallId, { path, content }, signal) {
      const absolutePath = resolveToolPath(cwd, path);
      return withFileMutationQueue(queue, absolutePath, async () => {
        if (signal?.aborted) throw new Error("Operation aborted");
        await writeContent(absolutePath, content, signal);
        if (signal?.aborted) throw new Error("Operation aborted");
        // UTF-8 bytes, as the text says. pi 0.82.1 counted UTF-16 units (`content.length`), which
        // is the same number for ASCII content only.
        const bytes = Buffer.byteLength(content, "utf8");
        return {
          content: [{ type: "text", text: `Successfully wrote ${bytes} bytes to ${path}` }],
          details: undefined,
        };
      });
    },
  };
}

// ─── edit ────────────────────────────────────────────────────────────────────

const replaceEditSchema = Type.Object(
  {
    oldText: Type.String({
      description:
        "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
    }),
    newText: Type.String({ description: "Replacement text for this targeted edit." }),
  },
  {},
);

const editSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
    edits: Type.Array(replaceEditSchema, {
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    }),
  },
  {},
);

type Edit = { oldText: string; newText: string };

/** Before validation: `edits` sent as a JSON string, and the legacy one-edit form
 * (`oldText`/`newText` beside `path`). */
function prepareEditArguments(input: unknown): Static<typeof editSchema> {
  if (!input || typeof input !== "object") return input as Static<typeof editSchema>;
  const args = input as Record<string, unknown>;
  if (typeof args.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {
      // Not JSON: validation names it.
    }
  }
  if (typeof args.oldText !== "string" || typeof args.newText !== "string") {
    return args as Static<typeof editSchema>;
  }
  const edits = Array.isArray(args.edits) ? [...(args.edits as unknown[])] : [];
  edits.push({ oldText: args.oldText, newText: args.newText });
  const { oldText: _oldText, newText: _newText, ...rest } = args;
  return { ...rest, edits } as Static<typeof editSchema>;
}

function editAccessError(path: string, error: unknown): Error {
  return new Error(`Could not edit file: ${path}. Error code: ${fileError(error).code}.`, { cause: error });
}

function editTool(cwd: string, queue: MutationQueue): AgentTool<typeof editSchema> {
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    parameters: editSchema,
    prepareArguments: prepareEditArguments,
    async execute(_toolCallId, input, signal) {
      if (!Array.isArray(input.edits) || input.edits.length === 0) {
        throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
      }
      const { path, edits } = input;
      const absolutePath = resolveToolPath(cwd, path);
      return withFileMutationQueue(queue, absolutePath, async () => {
        if (signal?.aborted) throw new Error("Operation aborted");
        let kind: string;
        try {
          kind = await kindOf(absolutePath);
        } catch (err) {
          throw editAccessError(path, err);
        }
        if (kind !== "file" && kind !== "symlink") throw new Error(`Could not edit file: ${path}. Path is not a file.`);
        let raw: string;
        try {
          const before = aborted(signal);
          if (before) throw before;
          raw = await readFile(absolutePath, { encoding: "utf8", signal });
        } catch (err) {
          throw editAccessError(path, err);
        }
        if (signal?.aborted) throw new Error("Operation aborted");
        const { bom, text: content } = stripBom(raw);
        const originalEnding = detectLineEnding(content);
        const normalizedContent = normalizeToLF(content);
        const newContent = applyEditsToNormalizedContent(normalizedContent, edits, path);
        if (signal?.aborted) throw new Error("Operation aborted");
        try {
          await writeContent(absolutePath, bom + restoreLineEndings(newContent, originalEnding), signal);
        } catch (err) {
          throw editAccessError(path, err);
        }
        if (signal?.aborted) throw new Error("Operation aborted");
        return {
          content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
          details: undefined,
        };
      });
    },
  };
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** The fuzzy match's view of a text: NFKC, no trailing white space on a line, and the curly
 * quotes, the Unicode dashes and the special spaces as their ASCII forms. */
function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

type Span = { start: number; end: number };

function getLineSpans(content: string): Span[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

type Replacement = { editIndex: number; matchIndex: number; matchLength: number; newText: string };

function getReplacementLineRange(lines: Span[], replacement: Replacement): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) throw new Error("Replacement range is outside the base content.");
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine]!.end < replacementEnd) endLine++;
  if (endLine >= lines.length) throw new Error("Replacement range is outside the base content.");
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: Replacement[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]!;
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

/** Apply replacements that matched the fuzzy view to the original text: each touched line is
 * rewritten from the fuzzy view, and every other line keeps its original bytes. */
function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: Replacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
  }
  const groups: Array<{ startLine: number; endLine: number; replacements: Replacement[] }> = [];
  const sorted = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sorted) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }
  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const groupStartOffset = baseLines[group.startLine]!.start;
    const groupEndOffset = baseLines[group.endLine - 1]!.end;
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset,
    );
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");
  return result;
}

type Match = { found: boolean; index: number; matchLength: number; usedFuzzyMatch: boolean };

/** The exact match first, then the fuzzy one (offsets in the fuzzy view). */
function fuzzyFindText(content: string, oldText: string): Match {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
  }
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

function countOccurrences(content: string, oldText: string): number {
  return normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
    );
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
  );
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
  );
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) return new Error(`oldText must not be empty in ${path}.`);
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    );
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/** Every edit matches the same original text; the replacements apply from the end, so offsets
 * hold. When any edit needs the fuzzy match, all of them run in the fuzzy view. */
function applyEditsToNormalizedContent(normalizedContent: string, edits: Edit[], path: string): string {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));
  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i]!.oldText.length === 0) throw getEmptyOldTextError(path, i, normalizedEdits.length);
  }
  const usedFuzzyMatch = normalizedEdits.some((edit) => fuzzyFindText(normalizedContent, edit.oldText).usedFuzzyMatch);
  const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
  const matchedEdits: Replacement[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i]!;
    const match = fuzzyFindText(replacementBaseContent, edit.oldText);
    if (!match.found) throw getNotFoundError(path, i, normalizedEdits.length);
    const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
    if (occurrences > 1) throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
    matchedEdits.push({ editIndex: i, matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText });
  }
  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1]!;
    const current = matchedEdits[i]!;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }
  const newContent = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
    : applyReplacements(replacementBaseContent, matchedEdits);
  if (normalizedContent === newContent) throw getNoChangeError(path, normalizedEdits.length);
  return newContent;
}

// ─── images ──────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The image types `read` sends, by their magic bytes: jpeg, png (not animated), gif, webp, bmp. */
function detectSupportedImageMimeType(buffer: Uint8Array): string | undefined {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return buffer[3] === 0xf7 ? undefined : "image/jpeg";
  if (startsWith(buffer, PNG_SIGNATURE)) return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : undefined;
  if (startsWithAscii(buffer, 0, "GIF")) return "image/gif";
  if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) return "image/webp";
  if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) return "image/bmp";
  return undefined;
}

function isPng(buffer: Uint8Array): boolean {
  return (
    buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
  );
}

function isAnimatedPng(buffer: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32BE(buffer, offset);
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
    if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
    const nextOffset = offset + 8 + chunkLength + 4;
    if (nextOffset <= offset || nextOffset > buffer.length) return false;
    offset = nextOffset;
  }
  return false;
}

function isBmp(buffer: Uint8Array): boolean {
  if (buffer.length < 26) return false;
  const declaredFileSize = readUint32LE(buffer, 2);
  const pixelDataOffset = readUint32LE(buffer, 10);
  const dibHeaderSize = readUint32LE(buffer, 14);
  if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
  if (pixelDataOffset < 14 + dibHeaderSize) return false;
  if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;
  let colorPlanes: number;
  let bitsPerPixel: number;
  if (dibHeaderSize === 12) {
    colorPlanes = readUint16LE(buffer, 22);
    bitsPerPixel = readUint16LE(buffer, 24);
  } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
    if (buffer.length < 30) return false;
    colorPlanes = readUint16LE(buffer, 26);
    bitsPerPixel = readUint16LE(buffer, 28);
  } else {
    return false;
  }
  return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
  return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] ?? 0) * 0x1000000 +
    ((buffer[offset + 1] ?? 0) << 16) +
    ((buffer[offset + 2] ?? 0) << 8) +
    (buffer[offset + 3] ?? 0)
  );
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] ?? 0) +
    ((buffer[offset + 1] ?? 0) << 8) +
    ((buffer[offset + 2] ?? 0) << 16) +
    (buffer[offset + 3] ?? 0) * 0x1000000
  );
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (buffer[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

// ─── the set ─────────────────────────────────────────────────────────────────

/** The file tools rooted at `cwd`, in the order the model reads them. `write` and `edit` share
 * one mutation queue. `readOnly` gives `read` alone (ADR-0028). */
export function fileTools(cwd: string, opts: { readOnly?: boolean } = {}): AgentTool[] {
  const queue: MutationQueue = { queues: new Map(), registration: Promise.resolve() };
  if (opts.readOnly) return [readTool(cwd) as AgentTool];
  return [readTool(cwd) as AgentTool, writeTool(cwd, queue) as AgentTool, editTool(cwd, queue) as AgentTool];
}
