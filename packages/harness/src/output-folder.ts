// The Harness's output folder (`/run/jr2/output`, ADR-0076): where pi's `bash` keeps the whole
// output of a long command, one file for each call, which the model reads by the path in the
// result. Nothing of pi removes a file there, and the folder is an emptyDir on the node's disk, so
// without a bound a long conversation of long commands fills it.
//
// The bound: after each `bash` call, the Harness removes the oldest files until the folder holds at
// most `OUTPUT_KEEP_BYTES`, and it always keeps the newest file. It never removes a file that a call
// in flight can still write or read: only a file last changed before the oldest call in flight
// started. So the folder holds at most `OUTPUT_KEEP_BYTES`, plus the newest file, plus the files of
// the calls in flight. A model that reads a removed file gets the error of a missing file.
//
// Not an emptyDir `sizeLimit`: on a disk-backed emptyDir the kubelet evicts the whole pod when the
// folder passes it, so one long output would lose the Workspace (ADR-0021). On a memory-backed one,
// a full folder is ENOSPC on pi's write stream, for which pi has no listener while the command runs.
//
// The domain only reads this folder, so the Harness lists and removes its files in its own process.

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** What the folder keeps after a call, besides the newest file and the files of calls in flight. */
export const OUTPUT_KEEP_BYTES = 256 * 1024 * 1024;

/** The bound on one output folder. One for the process: every conversation's `bash` writes there. */
export class OutputFolder {
  readonly #dir: string;
  readonly #keepBytes: number;
  readonly #inFlight = new Map<number, number>();
  #next = 0;

  constructor(dir: string, keepBytes = OUTPUT_KEEP_BYTES) {
    this.#dir = dir;
    this.#keepBytes = keepBytes;
  }

  /** A `bash` call starts: the answer ends it, and then prunes the folder. */
  call(): () => void {
    const id = this.#next++;
    this.#inFlight.set(id, Date.now());
    return () => {
      this.#inFlight.delete(id);
      this.prune();
    };
  }

  /** Remove the oldest files over the bound. A file that cannot be read or removed is left. */
  prune(): void {
    let names: string[];
    try {
      names = readdirSync(this.#dir);
    } catch {
      return;
    }
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      const path = join(this.#dir, name);
      try {
        const st = statSync(path);
        if (st.isFile()) files.push({ path, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // Gone already.
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    // A call in flight writes its file from its start on: a file changed since then can be its.
    const oldestCall = Math.min(Infinity, ...this.#inFlight.values());
    let kept = 0;
    for (const [i, file] of files.entries()) {
      kept += file.size;
      if (i === 0 || kept <= this.#keepBytes || file.mtimeMs >= oldestCall) continue;
      try {
        unlinkSync(file.path);
      } catch {
        // Removed by another prune, or not ours to remove: leave it.
      }
    }
  }
}
