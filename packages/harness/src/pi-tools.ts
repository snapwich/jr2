// The one module that imports pi's Working tools (ADR-0027). `read`, `write`, `edit`, `bash` and
// `find` are upstream's (`@earendil-works/pi-coding-agent`, MIT, at the exact pin that moves with
// pi-ai and pi-agent-core): their declarations, their result texts and their error texts. jr2
// gives each one its I/O (`tool-ops.ts`), which runs in the domain (ADR-0076).
//
// The import is of pi-coding-agent's `dist` files, by a file URL, as `pi-compaction.ts` imports
// Compaction: the package root costs about 45 MB more in this process than these files, and it
// adds signal-exit's SIGINT and SIGTERM listeners. The image sniff (`utils/mime.js`) is not
// exported from the root at all. `pi-tools.test.ts` fails when a pin bump moves a file or a name,
// so such a bump is loud. The types come from the root, which a type import does not load.

import type {
  BashToolOptions,
  EditToolOptions,
  FindToolOptions,
  ReadToolOptions,
  ToolDefinition,
  WriteToolOptions,
} from "@earendil-works/pi-coding-agent";

/** The private files, relative to the package root's entry (`dist/index.js`). */
export const PRIVATE_FILES = {
  read: "./core/tools/read.js",
  write: "./core/tools/write.js",
  edit: "./core/tools/edit.js",
  bash: "./core/tools/bash.js",
  find: "./core/tools/find.js",
  mime: "./utils/mime.js",
} as const;

/** A definition as jr2 reads it: the declaration, `prepareArguments` and `execute`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PiToolDefinition = ToolDefinition<any, any, any>;

type ReadFile = { createReadToolDefinition(cwd: string, options?: ReadToolOptions): PiToolDefinition };
type WriteFile = { createWriteToolDefinition(cwd: string, options?: WriteToolOptions): PiToolDefinition };
type EditFile = { createEditToolDefinition(cwd: string, options?: EditToolOptions): PiToolDefinition };
type BashFile = { createBashToolDefinition(cwd: string, options?: BashToolOptions): PiToolDefinition };
type FindFile = { createFindToolDefinition(cwd: string, options?: FindToolOptions): PiToolDefinition };
type MimeFile = { detectSupportedImageMimeType(buffer: Uint8Array): string | null };

const root = import.meta.resolve("@earendil-works/pi-coding-agent");
const load = async <T>(file: string): Promise<T> => (await import(new URL(file, root).href)) as T;

const readFile = await load<ReadFile>(PRIVATE_FILES.read);
const writeFile = await load<WriteFile>(PRIVATE_FILES.write);
const editFile = await load<EditFile>(PRIVATE_FILES.edit);
const bashFile = await load<BashFile>(PRIVATE_FILES.bash);
const findFile = await load<FindFile>(PRIVATE_FILES.find);
const mimeFile = await load<MimeFile>(PRIVATE_FILES.mime);

export const createReadToolDefinition = readFile.createReadToolDefinition;
export const createWriteToolDefinition = writeFile.createWriteToolDefinition;
export const createEditToolDefinition = editFile.createEditToolDefinition;
export const createBashToolDefinition = bashFile.createBashToolDefinition;
export const createFindToolDefinition = findFile.createFindToolDefinition;
/** pi's image sniff over a file's first bytes: a MIME type that `read` sends as an image, or null. */
export const detectSupportedImageMimeType = mimeFile.detectSupportedImageMimeType;
