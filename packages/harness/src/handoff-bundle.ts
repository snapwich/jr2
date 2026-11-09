// The source Harness's half of a Handoff (ADR-0080): `POST /handoff` runs the bundle step in the
// parent Agent's domain and answers with its files as one stream of `HandoffFrame`s (wire.ts). The
// step writes each part's header and then its bytes; the Harness sends the bytes on in `data`
// frames, so a refusal in the middle of a part is still a frame that the reader finds.
//
// The step is a process of the domain (`handoff-bundle-main.ts`), started by the spawner as each
// process of the Agents is (ADR-0076). So it reads only what an Agent of the parent can read, and
// nothing in the parent's files gets more than that. What it writes is data of the domain: an
// Agent can trace the step and change its output. So this module trusts none of it:
//
//   - Each header is one JSON line of a bounded length, in the order of the form: the bundle first
//     and once, then Git LFS objects by oid, each once, then `end`. Else the stream ends `refused`.
//   - The bytes of each part are counted, and the bundle and the objects together never pass the
//     bound (`HANDOFF_MAX_BYTES`): at a header that would pass it, the stream ends `refused`.
//   - The deadline (`HANDOFF_DEADLINE_MS`) counts from the start to the last byte. At it, the step's
//     whole process group is killed (SIGKILL) and the stream ends `refused`: a FIFO that an Agent
//     planted in the clone holds git for ever.
//   - A step that exits before its last frame ends the stream `refused`, with its last stderr line.
//   - A step that does not start (no node, the spawner gone) ends it `unknown`: the parent's files
//     did not cause it.
//
// The stream pauses the step when its reader is behind (`Spawned.pause`), so neither the Harness
// nor the Orchestrator holds the whole of it. A reader that cancels kills the step's group.

import { fileURLToPath } from "node:url";
import { HARNESS_HOME, type ChildPolicy } from "./children.ts";
import { pathFault } from "./cut.ts";
import { SpawnerGoneError, SpawnError, type Spawned } from "./spawner.ts";
import { HANDOFF_DEADLINE_MS, HANDOFF_MAX_BYTES, type HandoffFrame, type HandoffRequest } from "./wire.ts";

/** The step's entry, beside this module: `/opt/jr2/src/handoff-bundle-main.ts` in a pod. */
export const HANDOFF_BUNDLE_ENTRY = fileURLToPath(new URL("./handoff-bundle-main.ts", import.meta.url));

/** The longest header line that the step may write. */
const MAX_HEADER = 1024;

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OID = /^[0-9a-f]{64}$/;

/** What `POST /handoff` refuses before anything runs: a body that is not a Handoff request. */
export function handoffRequestFault(body: unknown, workRoot = "/work"): string | undefined {
  if (typeof body !== "object" || body === null) return "a Handoff request is an object";
  const b = body as Record<string, unknown>;
  const bad = pathFault(b.path, workRoot);
  if (bad !== undefined) return bad;
  if (typeof b.head !== "string" || !COMMIT.test(b.head)) return "head is not a full commit id";
  return undefined;
}

export type BundleOptions = {
  /** Where the Repo Slots are. Default `/work`. */
  workRoot?: string;
  /** Default {@link HANDOFF_MAX_BYTES}. */
  maxBytes?: number;
  /** Default {@link HANDOFF_DEADLINE_MS}. */
  deadlineMs?: number;
  /** The step's entry. Default {@link HANDOFF_BUNDLE_ENTRY}; a test names another. */
  entry?: string;
  /** The bytes the stream holds before it pauses the step. */
  highWaterMark?: number;
};

const line = (f: HandoffFrame): Uint8Array => Buffer.from(`${JSON.stringify(f)}\n`);

/**
 * Run the bundle step for `req` in the domain of `children`, and answer its files as a stream of
 * frames. The stream always ends with one terminal frame (`end`, `nothing`, `refused` or `unknown`)
 * and never errors.
 */
export function bundleHandoff(
  children: ChildPolicy,
  req: HandoffRequest,
  opts: BundleOptions = {},
): ReadableStream<Uint8Array> {
  const workRoot = opts.workRoot ?? "/work";
  const maxBytes = opts.maxBytes ?? HANDOFF_MAX_BYTES;
  const deadlineMs = opts.deadlineMs ?? HANDOFF_DEADLINE_MS;
  const slot = req.path.slice(workRoot.length + 1).split("/")[0]!;
  const input = {
    clone: `${workRoot}/${slot}/default`,
    head: req.head,
    maxBytes,
    tmp: children.env.TMPDIR ?? "/tmp",
    path: children.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };

  let proc: Spawned | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let paused = false;
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;

  // The parser's state: a header line being read, or the bytes of a part still to come.
  let header: Buffer[] = [];
  let headerLen = 0;
  let body = 0;
  let total = 0;
  let parts = 0;
  const oids = new Set<string>();
  let stderr = "";

  const finish = (f: HandoffFrame): void => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    // Nothing of the step outlives its answer: the group goes, git and whatever it started.
    proc?.signal("SIGKILL");
    try {
      ctrl.enqueue(line(f));
      ctrl.close();
    } catch {
      // The reader cancelled.
    }
  };
  const refuse = (why: string) => finish({ refused: why.slice(0, 1024) });

  const push = (bytes: Uint8Array): void => {
    ctrl.enqueue(bytes);
    if (!paused && (ctrl.desiredSize ?? 1) <= 0) {
      paused = true;
      proc?.pause();
    }
  };

  /** One header line of the step: checked, and sent on in jr2's own words. */
  const onHeader = (text: string): void => {
    let f: unknown;
    try {
      f = JSON.parse(text);
    } catch {
      return refuse("the bundle step wrote a header that is not JSON");
    }
    const h = (typeof f === "object" && f !== null && !Array.isArray(f) ? f : {}) as Record<string, unknown>;
    const keys = Object.keys(h).sort().join(",");
    const size = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    const fits = (n: number): boolean => {
      if (total + n <= maxBytes) return true;
      refuse(`the Handoff's files pass the bound of ${maxBytes} bytes`);
      return false;
    };
    if (keys === "bundle" && size(h.bundle) && parts === 0) {
      if (!fits(h.bundle)) return;
      parts = 1;
      total += h.bundle;
      body = h.bundle;
      return push(line({ bundle: h.bundle }));
    }
    if (keys === "lfs,size" && typeof h.lfs === "string" && OID.test(h.lfs) && size(h.size) && parts > 0) {
      if (oids.has(h.lfs)) return refuse(`the bundle step wrote the Git LFS object ${h.lfs} twice`);
      if (!fits(h.size)) return;
      oids.add(h.lfs);
      parts += 1;
      total += h.size;
      body = h.size;
      return push(line({ lfs: h.lfs, size: h.size }));
    }
    if (keys === "end" && h.end === true && parts > 0) return finish({ end: true });
    if (keys === "nothing" && h.nothing === true && parts === 0) return finish({ nothing: true });
    if (keys === "refused" && typeof h.refused === "string") return refuse(h.refused);
    refuse("the bundle step wrote a header out of its form");
  };

  const onStdout = (chunk: Buffer): void => {
    let rest = chunk;
    while (!done && rest.length > 0) {
      if (body > 0) {
        const take = rest.subarray(0, Math.min(body, rest.length));
        body -= take.length;
        rest = rest.subarray(take.length);
        push(line({ data: take.length }));
        push(new Uint8Array(take));
        continue;
      }
      const nl = rest.indexOf(0x0a);
      const piece = nl < 0 ? rest : rest.subarray(0, nl);
      headerLen += piece.length;
      if (headerLen > MAX_HEADER) return refuse("the bundle step wrote a header longer than its form");
      header.push(piece);
      if (nl < 0) return;
      rest = rest.subarray(nl + 1);
      const text = Buffer.concat(header).toString("utf8");
      header = [];
      headerLen = 0;
      onHeader(text);
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      start(c) {
        ctrl = c;
        timer = setTimeout(
          () => refuse(`the bundle step passed its deadline of ${Math.round(deadlineMs / 1000)} s`),
          deadlineMs,
        );
        timer.unref?.();
        proc = children.spawner.spawn(
          {
            argv: [process.execPath, opts.entry ?? HANDOFF_BUNDLE_ENTRY, JSON.stringify(input)],
            // node's HOME is the Harness's own, which the domain cannot reach: node looks for modules
            // in jr2's folders alone, and no `NODE_OPTIONS` of the image loads code into it. Its git
            // gets a cleared env of the step's own.
            env: { HOME: HARNESS_HOME },
            cwd: "/",
          },
          {
            onStdout,
            onStderr: (c) => void (stderr = (stderr + c.toString("utf8")).slice(-4096)),
          },
        );
        proc.exited.then(
          (exit) => {
            if (done) return;
            const last = stderr.trim().split("\n").at(-1)?.slice(0, 500);
            const how = exit.signal !== null ? `by ${exit.signal}` : `with exit ${exit.code}`;
            refuse(`the bundle step ended ${how} before its last frame${last ? `: ${last}` : ""}`);
          },
          (err: unknown) => {
            const why = err instanceof SpawnError || err instanceof SpawnerGoneError ? err.message : String(err);
            finish({ unknown: `the bundle step did not run: ${why}` });
          },
        );
      },
      pull() {
        if (paused) {
          paused = false;
          proc?.resume();
        }
      },
      cancel() {
        done = true;
        if (timer) clearTimeout(timer);
        proc?.signal("SIGKILL");
      },
    },
    { highWaterMark: opts.highWaterMark ?? 1 << 20, size: (c) => c.byteLength },
  );
}
