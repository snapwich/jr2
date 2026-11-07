// The I/O of pi's Working tools (ADR-0027, ADR-0076): jr2's `Operations` for pi-coding-agent's
// `read`, `write`, `edit`, `bash` and `find`. Every file op and every process runs in the domain,
// done by the spawner (`spawner.ts`), so the kernel applies the domain's rules to it: the tools
// reach what `bash` reaches, and a path under `/run/jr2`, or a link to one, fails as an unreadable
// file fails. Each failure reads as Node's error for the same system call (`nodeError`), so the
// text that the model reads is the text that pi's own `fs` calls would give.
//
// pi's tools also look at a path in this process: `read` tries the variants of a name with
// `access`, and `write` and `edit` key their queue by `realpath`. Each of these tells only whether
// a name is there and where a link points, which a `stat` in the domain tells too. No content is
// read in this process.

import { constants as osConstants } from "node:os";
import { getSystemErrorMessage } from "node:util";
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { runIn, type ChildPolicy, type RunResult } from "./children.ts";
import { detectSupportedImageMimeType } from "./pi-tools.ts";
import { execInDomain } from "./shell.ts";
import { FileOpError, type FileOps } from "./spawner.ts";

/** How many bytes of a file pi's image sniff reads. */
const IMAGE_SNIFF_BYTES = 4100;

/**
 * The spawner's failure as Node's error for the same system call: the errno, Node's words for it,
 * the call and the path (`ENOENT: no such file or directory, open '/x'`), with Node's `code`. A
 * failure that is not a file op's (the spawner ended) keeps its own words.
 */
export function nodeError(err: unknown, path: string, syscall: string): Error {
  if (!(err instanceof FileOpError)) return err instanceof Error ? err : new Error(String(err));
  const errno = (osConstants.errno as Record<string, number | undefined>)[err.code];
  const words = errno === undefined ? err.code : getSystemErrorMessage(-errno);
  return Object.assign(new Error(`${err.code}: ${words}, ${syscall} '${path}'`), { code: err.code, syscall, path });
}

/** A path is there for a tool when the domain can `stat` it: else Node's `access` error. */
async function access(files: FileOps, path: string): Promise<void> {
  try {
    await files.stat(path);
  } catch (err) {
    throw nodeError(err, path, "access");
  }
}

async function readContent(files: FileOps, path: string): Promise<Buffer> {
  try {
    return await files.read(path);
  } catch (err) {
    throw nodeError(err, path, "open");
  }
}

async function writeContent(files: FileOps, path: string, content: string): Promise<void> {
  try {
    await files.write(path, content);
  } catch (err) {
    throw nodeError(err, path, "open");
  }
}

/**
 * An image that `read` does not send: a BMP. pi converts a BMP to PNG with photon, which decodes the
 * whole image in this process, so a small file that holds a large image could take the Harness's
 * memory past the container's limit, where the memory guard (ADR-0061) protects only the domain.
 * `read` answers it with the text that the model read before (`omitting` in `working-tools.ts`).
 */
export class ImageOmitted extends Error {
  readonly mimeType: string;
  constructor(mimeType: string) {
    super(`Read image file [${mimeType}]\n[Image omitted: configure an imageProcessor to convert BMP images.]`);
    this.mimeType = mimeType;
  }
}

/**
 * `read`'s operations. The image sniff reads the file once, in the domain, and the read that comes
 * next for the same path takes those bytes: one read of the file for each call. A PNG, a JPEG, a
 * GIF or a WebP goes to the model as its bytes, with no decode in this process (`read` is made with
 * `autoResizeImages: false`). A BMP is omitted (`ImageOmitted`).
 */
export function readOps(files: FileOps): ReadOperations {
  let sniffed: { path: string; data: Buffer } | undefined;
  return {
    readFile: async (path) => {
      const kept = sniffed?.path === path ? sniffed.data : undefined;
      sniffed = undefined;
      return kept ?? readContent(files, path);
    },
    access: (path) => access(files, path),
    detectImageMimeType: async (path) => {
      const data = await readContent(files, path);
      const mimeType = detectSupportedImageMimeType(data.subarray(0, IMAGE_SNIFF_BYTES));
      if (mimeType === "image/bmp") throw new ImageOmitted(mimeType);
      sniffed = { path, data };
      return mimeType;
    },
  };
}

/** `write`'s operations. The spawner's `write` makes the missing folders, so `mkdir` does nothing. */
export function writeOps(files: FileOps): WriteOperations {
  return {
    writeFile: (path, content) => writeContent(files, path, content),
    mkdir: async () => {},
  };
}

/** `edit`'s operations. */
export function editOps(files: FileOps): EditOperations {
  return {
    readFile: (path) => readContent(files, path),
    writeFile: (path, content) => writeContent(files, path, content),
    access: (path) => access(files, path),
  };
}

/**
 * `bash`'s operations: the shell in the domain (`shell.ts`). The env that pi passes is this
 * process's own, so it is never used: the shell has the domain's env (ADR-0076). pi writes a long
 * command's whole output to a new file in this process's `os.tmpdir()`, and opens it by its path
 * again to read it: that is the Harness's output folder (`OUTPUT_DIR`), where the domain reads and
 * writes nothing, so no command can put a link or a FIFO in the file's place.
 */
export function bashOps(children: ChildPolicy): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      execInDomain(children, command, cwd, { onData, signal, timeout }),
  };
}

/** The bound of what one search keeps of a process's output. */
const SEARCH_BUFFER = 16 * 1024 * 1024;

/** One search process in the domain. A program that the domain's PATH does not hold is a spawn
 * that never ran. */
function search(children: ChildPolicy, argv: string[], cwd: string): Promise<RunResult> {
  return runIn(children, argv, { cwd, maxBuffer: SEARCH_BUFFER });
}

/** The command never ran (its code is a string like ENOENT, not an exit code). */
function spawnFailed(r: RunResult): boolean {
  return r.code === null && r.signal === null && !(r.error && r.error.name === "AbortError") && !overflowed(r);
}

function overflowed(r: RunResult): boolean {
  return r.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

/** The complete lines of a search's output, at most `limit`. An output past the bound keeps the
 * lines before its cut. */
function lines(r: RunResult, limit: number): string[] {
  const all = r.stdout.split("\n");
  if (overflowed(r)) all.pop();
  return all.filter((l) => l !== "").slice(0, limit);
}

/**
 * `find`'s operations. pi's own `find` starts `fd` in this process, and downloads it when it is
 * not there; given `glob`, it does neither. The glob runs `rg --files` in the domain, by pi's rule
 * for a pattern: one without a `/` matches a name at any depth, and one with a `/` matches the
 * path, at any depth unless it starts with `/`. Hidden files are found, `.gitignore` is respected,
 * and pi's ignore list is applied. Where rg is not on the domain's PATH, `find` runs in its place,
 * which does not read `.gitignore`.
 */
export function findOps(children: ChildPolicy): FindOperations {
  return {
    exists: async (path) => {
      try {
        await children.spawner.stat(path);
        return true;
      } catch {
        return false;
      }
    },
    glob: async (pattern, cwd, { ignore, limit }) => {
      const anchored = pattern.includes("/") && !pattern.startsWith("/") && !pattern.startsWith("**/");
      const glob = anchored ? `**/${pattern}` : pattern;
      const rg = await search(
        children,
        [
          "rg",
          "--files",
          "--hidden",
          "--no-require-git",
          "--sort",
          "path",
          "--glob",
          glob,
          ...ignore.flatMap((i) => ["--glob", `!${i}`]),
        ],
        cwd,
      );
      if (!spawnFailed(rg)) {
        if (rg.code === 0 || overflowed(rg)) return lines(rg, limit);
        if (rg.code === 1 && rg.stderr.trim() === "") return [];
        throw new Error(rg.stderr.trim() || rg.error?.message || `rg exited ${rg.code}`);
      }
      return plainFind(children, pattern, cwd, ignore, limit);
    },
  };
}

/** The glob by `find`, where rg is absent: `*` in `-path` spans `/`, so `**` is `*`. */
async function plainFind(
  children: ChildPolicy,
  pattern: string,
  cwd: string,
  ignore: string[],
  limit: number,
): Promise<string[]> {
  const star = (p: string) => p.replaceAll("**/", "").replaceAll("**", "*");
  const matcher = !pattern.includes("/")
    ? ["-name", pattern]
    : ["-path", pattern.startsWith("/") ? `.${star(pattern)}` : `*/${star(pattern)}`];
  const pruned = ignore.flatMap((i) => ["-not", "-path", `*/${star(i)}`]);
  const r = await search(children, ["find", ".", "-type", "f", ...pruned, ...matcher], cwd);
  if (r.code !== 0 && !overflowed(r)) throw new Error(r.stderr.trim() || r.error?.message || `find exited ${r.code}`);
  return lines(r, Number.MAX_SAFE_INTEGER)
    .map((l) => l.replace(/^\.\//, ""))
    .sort()
    .slice(0, limit);
}
