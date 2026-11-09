// The land process of a Handoff (ADR-0080): it runs in the child Agent's Landlock domain, started by
// the spawner (`handoff-land.ts`), and writes the files of one Handoff, which the Orchestrator
// carries in a `PUT /handoffs/<id>` body, to the folder of that cut (`landedFolder`). The child's cut
// then reads them (`handoff-take.ts`) and removes the folder when it settles.
//
// Its stdin is the body, as the Harness gets it: `HandoffLandFrame`s (wire.ts), each part's bytes in
// `data` frames, then `{ end: true }`. What it does:
//
//   1. It removes what an earlier body for the same id left (a second body replaces the first),
//      and writes into `<id>.part`, a folder of its own.
//   2. It checks the form as it reads: a header is one JSON line of a bounded length, the bundle
//      comes first and once, each Git LFS object by its oid comes once and has at least one byte,
//      the data of a part sums to its size, and the bounds of the Handoff hold. A body out of the
//      form keeps nothing.
//   3. After each chunk that it wrote, it writes `{"took":<bytes>}` on its stdout: the Harness sends
//      the next chunks only while it is not far ahead (`handoff-land.ts`), so neither process holds
//      the whole body.
//   4. At `end` and the end of its stdin, it renames `<id>.part` to `<id>`, and only then writes
//      `{"landed":true}`. A body that ends before `end` keeps nothing: the Orchestrator ended the
//      carry. This process removes `<id>.part` when it finds the fault; when the Harness kills it
//      (the body broke), the Harness removes `<id>.part` after its exit (`handoff-land.ts`).
//
// The folder is on the Sandbox's `/work` volume, so a restart of the Harness container keeps it, and
// the cut's start that the Orchestrator sends again after the restart finds the files.
//
// A fault is a non-zero exit, with the reason on stderr.

import { constants, realpathSync } from "node:fs";
import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { HANDOFF_MAX_BYTES, HANDOFF_MAX_OBJECTS } from "./wire.ts";

/** What the Harness gives the land process, as its one argument (JSON). */
export type LandInput = {
  /** The folder of the landed Handoffs: `<work root>/.jr2/handoffs`. */
  root: string;
  /** The cut's Effect id. */
  id: string;
  maxBytes?: number;
  maxObjects?: number;
};

/** The folder of the landed Handoffs in a Sandbox: in `/work/.jr2/`, jr2's own folder of `/work`
 * (ADR-0075), beside the Repo Slots, because a cut's Effect id names no slot. */
export const HANDOFF_LAND_DIR = ".jr2/handoffs";

/** An Effect id that names a folder: what the Orchestrator gives (a UUID), and nothing that is a
 * path. */
export const LAND_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The folder of the landed files of the cut whose Effect id is `id`. It holds `bundle`, and
 * `lfs/<oid>` for each Git LFS object that came with it. */
export const landedFolder = (workRoot: string, id: string): string => join(workRoot, HANDOFF_LAND_DIR, id);

const OID = /^[0-9a-f]{64}$/;
const MAX_HEADER = 1024;

class Fault extends Error {}

/** Write one line to stdout, and wait while the pipe is full. */
function say(f: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.stdout.write(`${JSON.stringify(f)}\n`, (err) => (err ? reject(err) : undefined))) return resolve();
    process.stdout.once("drain", resolve);
  });
}

/**
 * Land the body that `chunks` gives in `<root>/<id>`. `took` is told the bytes of the body that it
 * has written, after each chunk. Throws `Fault` for a body out of its form or that ends before
 * `end`; the part folder is then gone.
 */
export async function land(
  input: LandInput,
  chunks: AsyncIterable<Buffer>,
  took: (bytes: number) => Promise<void> = async () => {},
): Promise<void> {
  if (!LAND_ID.test(input.id)) throw new Fault(`"${input.id}" is no Effect id`);
  const maxBytes = input.maxBytes ?? HANDOFF_MAX_BYTES;
  const maxObjects = input.maxObjects ?? HANDOFF_MAX_OBJECTS;
  const final = join(input.root, input.id);
  const part = `${final}.part`;
  await mkdir(input.root, { recursive: true });
  await rm(part, { recursive: true, force: true });
  await mkdir(join(part, "lfs"), { recursive: true });

  let header: Buffer[] = [];
  let headerLen = 0;
  /** The bytes of the part that are still to come in data frames, and of the data frame now. */
  let partLeft = 0;
  let dataLeft = 0;
  let file: FileHandle | undefined;
  let parts = 0;
  let total = 0;
  let ended = false;
  let seen = 0;
  const oids = new Set<string>();

  const openPart = async (name: string): Promise<void> => {
    file = await open(
      join(part, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o640,
    );
  };
  const closePart = async (): Promise<void> => {
    await file?.close();
    file = undefined;
  };

  const onHeader = async (text: string): Promise<void> => {
    let f: unknown;
    try {
      f = JSON.parse(text);
    } catch {
      throw new Fault("a header of the body is not JSON");
    }
    const h = (typeof f === "object" && f !== null && !Array.isArray(f) ? f : {}) as Record<string, unknown>;
    const keys = Object.keys(h).sort().join(",");
    const size = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
    if (ended) throw new Fault("the body goes on after its end frame");
    if (keys === "data" && size(h.data) && h.data <= partLeft) {
      dataLeft = h.data;
      return;
    }
    if (keys === "data") throw new Fault("a data frame of the body is out of its part");
    if (partLeft > 0) throw new Fault("a part of the body ended before its size");
    await closePart();
    const fits = (n: number): void => {
      if (total + n > maxBytes) throw new Fault(`the Handoff's files pass the bound of ${maxBytes} bytes`);
      total += n;
    };
    if (keys === "bundle" && size(h.bundle) && parts === 0) {
      fits(h.bundle);
      parts = 1;
      partLeft = h.bundle;
      return openPart("bundle");
    }
    if (keys === "lfs,size" && typeof h.lfs === "string" && OID.test(h.lfs) && size(h.size) && parts > 0) {
      if (oids.has(h.lfs)) throw new Fault(`the Git LFS object ${h.lfs} came twice`);
      if (oids.size >= maxObjects) throw new Fault(`the Handoff's files hold more than ${maxObjects} Git LFS objects`);
      fits(h.size);
      oids.add(h.lfs);
      parts += 1;
      partLeft = h.size;
      return openPart(join("lfs", h.lfs));
    }
    if (keys === "end" && h.end === true && parts > 0) {
      ended = true;
      return;
    }
    throw new Fault("a header of the body is out of its form");
  };

  try {
    for await (const chunk of chunks) {
      let rest = chunk;
      while (rest.length > 0) {
        if (dataLeft > 0) {
          const take = rest.subarray(0, Math.min(dataLeft, rest.length));
          await file!.write(take);
          dataLeft -= take.length;
          partLeft -= take.length;
          rest = rest.subarray(take.length);
          continue;
        }
        const nl = rest.indexOf(0x0a);
        const piece = nl < 0 ? rest : rest.subarray(0, nl);
        headerLen += piece.length;
        if (headerLen > MAX_HEADER) throw new Fault("a header of the body is longer than its form");
        header.push(piece);
        if (nl < 0) break;
        rest = rest.subarray(nl + 1);
        const text = Buffer.concat(header).toString("utf8");
        header = [];
        headerLen = 0;
        await onHeader(text);
      }
      seen += chunk.length;
      await took(seen);
    }
    if (!ended || headerLen > 0) throw new Fault("the body ended before its end frame");
    await closePart();
    await rm(final, { recursive: true, force: true });
    await rename(part, final);
  } catch (err) {
    await closePart().catch(() => {});
    await rm(part, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Land stdin, and say `landed`. A fault is a non-zero exit, with the reason on stderr. */
export async function main(argv: readonly string[]): Promise<void> {
  try {
    await land(JSON.parse(argv[0] ?? "{}") as LandInput, process.stdin, (bytes) => say({ took: bytes }));
    await say({ landed: true });
  } catch (err) {
    process.stderr.write(`${(err instanceof Error ? err.message : String(err)).slice(0, 1024)}\n`);
    process.exitCode = 3;
  }
}

// `node handoff-land-main.ts <json>`, started by the Harness through the spawner.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)
) {
  void main(process.argv.slice(2));
}
