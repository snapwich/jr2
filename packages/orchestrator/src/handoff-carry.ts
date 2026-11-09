// The carry of a Handoff (ADR-0080): the Orchestrator takes the files of a Handoff from the source
// Workspace's Harness and gives them to the child's Harness, before the child's cut starts.
//
// Two legs of the Harness wire, each behind the Harness bearer (ADR-0058), and no route that faces
// a Sandbox. `POST /handoff` on the source asks for the bundle of the ledger row's head and its Git
// LFS objects, as one stream of frames (`HandoffFrame`). `PUT /handoffs/<id>` on the child sends
// them on, under the cut's Effect id, as frames that this module writes itself. The two legs are
// one pipe: a chunk of the source is read only when the child's leg takes the last one, so the
// Orchestrator never holds the whole stream, and a slow child holds the source's step paused.
//
// The source's stream comes from a process of the parent Sandbox, through its Harness. The Harness
// writes each frame in its own words, but the Orchestrator serves every run of the Instance, so it
// trusts the stream no more than it must: each header is a bounded JSON line in the order of the
// form, the parts' bytes are counted against their headers, the parts together never pass the
// bound (`HANDOFF_MAX_BYTES`), and the Git LFS objects are never more than `HANDOFF_MAX_OBJECTS`,
// each with at least one byte. So what the carry holds (one oid for each object) and what it sends
// have a bound that no file of the parent's can move. The child's leg gets only frames that passed
// these checks.
//
// How each end maps to the cut's outcome (ADR-0080, "Two kinds of transport error"):
//   - `nothing`: the range is empty. No PUT; the cut takes the commit from its clone.
//   - `end`, and the child answers `{ landed: true }`: `carried`.
//   - `refused` from the source (the commit or a prerequisite is gone, the step's deadline, a file
//     that is not regular, the source's bound), or a stream past the bound here: `refused`. A cut
//     again would meet the same files. The child's leg is ended before its `end`, so the child
//     keeps nothing: its Harness removes what the land wrote. A carry that ends `refused` or
//     `unknown` after the child renamed the files into place leaves them, so the cut's Effect
//     then kills its id in the child, whose Harness removes them (`effect.ts`).
//   - `unknown` from the source, no answer, an HTTP error, a stream that ends before its last frame,
//     breaks or is out of its form, a stall, a carry past its time (`HANDOFF_CARRY_MS`), or a child
//     that does not take the files: `unknown`. The Machine can cut again.
//
// The carry reads the source and replaces the child's files under one id, so it is safe to run
// again: the Orchestrator runs it before each send of the cut's start, and a restored run runs it
// again with the source that the cut's intent row keeps (ADR-0067).

import { dialFetch, neverDelivered, transportDetail } from "./dial.ts";
import type { HandoffCarrier, HandoffSource } from "./handoff.ts";
import {
  HANDOFF_CONTENT_TYPE,
  HANDOFF_DEADLINE_MS,
  HANDOFF_MAX_BYTES,
  HANDOFF_MAX_OBJECTS,
  type HandoffFrame,
  type HandoffLandFrame,
  type HandoffRequest,
} from "./wire.ts";

/**
 * How long the carry waits with no byte from the source before it ends the carry `unknown`: longer
 * than the bundle step's deadline, so a step that the parent's files hold ends `refused` first. The
 * deadline counts only the step's own time, and a step that the carry holds paused (a slow child)
 * sends nothing, so this wait also ends a carry that stays stalled, which cancels the source's
 * stream and kills its step.
 */
export const HANDOFF_IDLE_MS = HANDOFF_DEADLINE_MS + 60_000;

/** The slowest carry that jr2 takes: 1 MiB/s, so the bound's 1 GiB takes about 17 minutes. */
const MIN_BYTES_PER_MS = 1024 ** 2 / 1000;

/**
 * The longest time a carry takes, from the first ask of the source to the child's answer, tries
 * again included: the bound at the slowest rate, and one idle wait. The idle wait alone does not
 * end a carry that a child (or a source) keeps alive with a byte now and then, and the cut's
 * `timeout` starts only with the cut's exec, after the carry. Past it, the carry is `unknown`, and
 * the source's step and the child's request end.
 */
export const HANDOFF_CARRY_MS = Math.ceil(HANDOFF_MAX_BYTES / MIN_BYTES_PER_MS) + HANDOFF_IDLE_MS;

/** The dial of both legs: a connected leg with no byte for {@link HANDOFF_IDLE_MS} ends. */
export const HANDOFF_DIAL = { idleTimeoutMs: HANDOFF_IDLE_MS } as const;

/** The longest header line that the carry reads. A refusal's reason can hold a line of git's. */
const MAX_LINE = 64 * 1024;

const OID = /^[0-9a-f]{64}$/;

/** The waits before each new try of a carry whose connection never opened (the Harness is not
 * there yet, or it restarts). */
const RETRY_WAITS_MS = [250, 500, 1_000, 2_000];

export type CarryOptions = {
  /** Default: `dial(HANDOFF_DIAL)`, with {@link HANDOFF_IDLE_MS} as its idle bound. */
  fetch?: typeof globalThis.fetch;
  /** Makes the default `fetch` from its options. Default `dialFetch`; a test sees the options. */
  dial?: typeof dialFetch;
  /** Default {@link HANDOFF_MAX_BYTES}. */
  maxBytes?: number;
  /** Default {@link HANDOFF_MAX_OBJECTS}. */
  maxObjects?: number;
  /** Default {@link HANDOFF_CARRY_MS}. */
  carryMs?: number;
  /** The waits before each new try of a carry that never reached a Harness. */
  retryWaitsMs?: readonly number[];
};

type Carried = Awaited<ReturnType<HandoffCarrier>>;

/** The Orchestrator's carrier of a Handoff's files: the transport of `worktree()` (ADR-0080). */
export function handoffCarrier(options: CarryOptions = {}): HandoffCarrier {
  const fetchImpl = options.fetch ?? (options.dial ?? dialFetch)(HANDOFF_DIAL);
  const bounds = {
    maxBytes: options.maxBytes ?? HANDOFF_MAX_BYTES,
    maxObjects: options.maxObjects ?? HANDOFF_MAX_OBJECTS,
  };
  const carryMs = options.carryMs ?? HANDOFF_CARRY_MS;
  const waits = options.retryWaitsMs ?? RETRY_WAITS_MS;
  return async (args) => {
    // The carry's own time: its end aborts both legs, as a stop of the cut does, but settles.
    const late = new AbortController();
    const timer = setTimeout(() => late.abort(new Error("the carry passed its time")), carryMs);
    const signal = AbortSignal.any([args.signal, late.signal]);
    const pastTime = notCarried(`the carry passed its time of ${Math.round(carryMs / 1000)} s`);
    try {
      for (let attempt = 0; ; attempt++) {
        let result: Carried | { retry: string };
        try {
          result = await carryOnce(fetchImpl, bounds, { ...args, signal });
        } catch (err) {
          if (late.signal.aborted && !args.signal.aborted) return pastTime;
          throw err;
        }
        // A fault that the end of the time caused is told as the end of the time.
        if (late.signal.aborted && !args.signal.aborted && ("retry" in result || result.outcome === "unknown")) {
          return pastTime;
        }
        if (!("retry" in result)) return result;
        if (attempt >= waits.length || args.signal.aborted) return notCarried(result.retry);
        await sleep(waits[attempt]!, signal);
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

const notCarried = (detail: string): Carried => ({
  outcome: "unknown",
  reason: `the files of the Handoff were not carried: ${detail}`,
});
const refusedFor = (source: HandoffSource, reason: string): Carried => ({
  outcome: "refused",
  reason: `the Handoff of ${source.path} at ${source.head}: ${reason}`,
});

/** One carry. `retry`: no connection to a Harness opened, so nothing was read or sent. */
async function carryOnce(
  fetchImpl: typeof globalThis.fetch,
  bounds: Bounds,
  args: Parameters<HandoffCarrier>[0],
): Promise<Carried | { retry: string }> {
  const { maxBytes } = bounds;
  const { source, from, target, signal } = args;
  const ask: HandoffRequest = { path: source.path, head: source.head };
  let answer: Response;
  try {
    answer = await fetchImpl(`${from.endpoint}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearerOf(args.bearer(from.sandbox)) },
      body: JSON.stringify(ask),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    const detail = `the source Harness (${from.sandbox}) did not answer: ${transportDetail(err)}`;
    return neverDelivered(err) ? { retry: detail } : notCarried(detail);
  }
  if (answer.status !== 200 || mediaType(answer.headers.get("content-type")) !== HANDOFF_CONTENT_TYPE) {
    const text = await answer.text().catch(() => "");
    return notCarried(`the source Harness (${from.sandbox}) answered ${answer.status}: ${errorOf(text)}`);
  }
  const frames = new FrameReader(answer.body!, MAX_LINE);
  try {
    const first = await frames.header();
    if ("fault" in first) return notCarried(first.fault);
    const frame = first.frame;
    if ("nothing" in frame) return { outcome: "nothing" };
    if ("refused" in frame) return refusedFor(source, frame.refused);
    if ("unknown" in frame) return notCarried(`the source Harness: ${frame.unknown}`);
    if (!("bundle" in frame)) return notCarried("the source Harness's answer does not start with the bundle");
    if (frame.bundle > maxBytes) return refusedFor(source, boundText(maxBytes));

    // The pipe: what the child's leg pulls, read from the source and checked on the way.
    let stop: Carried | undefined;
    let ended = false;
    const parts = forward(frames, frame.bundle, bounds, (end) => {
      if (end === "end") ended = true;
      else stop = end.stop === "refused" ? refusedFor(source, end.reason) : notCarried(end.reason);
    });
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(ctrl) {
          // A read of the source never throws here: a break of its stream is a stop (`FrameReader`).
          const next = await parts.next();
          if (next.done) {
            if (stop !== undefined) ctrl.error(new Error("the carry stopped"));
            else ctrl.close();
          } else ctrl.enqueue(next.value);
        },
        async cancel() {
          await parts.return(undefined);
        },
      },
      { highWaterMark: 0 },
    );
    let landed: Response;
    try {
      landed = await fetchImpl(`${target.endpoint}/handoffs/${encodeURIComponent(args.effect)}`, {
        method: "PUT",
        headers: { "content-type": HANDOFF_CONTENT_TYPE, ...bearerOf(args.bearer(target.sandbox)) },
        body,
        signal,
        // The global fetch needs it for a streamed body; `dialFetch` streams any ReadableStream.
        duplex: "half",
      } as RequestInit);
    } catch (err) {
      if (signal.aborted) throw err;
      if (stop !== undefined) return stop;
      const detail = `the child's Harness (${target.sandbox}) did not take them: ${transportDetail(err)}`;
      return neverDelivered(err) ? { retry: detail } : notCarried(detail);
    }
    const text = await landed.text().catch(() => "");
    if (stop !== undefined) return stop;
    if (!ended) {
      return notCarried(
        `the child's Harness (${target.sandbox}) answered ${landed.status} before it took them all: ${errorOf(text)}`,
      );
    }
    if (landed.status !== 200 || !isLanded(text)) {
      return notCarried(`the child's Harness (${target.sandbox}) answered ${landed.status}: ${errorOf(text)}`);
    }
    return { outcome: "carried" };
  } finally {
    // A carry that ends before the source's last frame ends the source's stream, which kills its
    // step.
    await frames.cancel();
  }
}

/** The most `data` frames of a part of `size` bytes: one for each KiB, and a few more. */
export const framesFor = (size: number): number => 16 + Math.ceil(size / 1024);

/** The bounds of one carry: the bytes of the parts together, and the number of Git LFS objects. */
type Bounds = { maxBytes: number; maxObjects: number };

/** What ends the forward: the source's `end`, or a stop with the cut's outcome. */
type ForwardEnd = "end" | { stop: "refused" | "unknown"; reason: string };

/**
 * The frames for the child's leg, read from the source: the bundle's bytes (its header is read),
 * then each Git LFS object, then `end`. Each frame is written here, from values that passed the
 * checks; the parts' bytes go on as they come. At the first fault, `onEnd` gets the stop, and the
 * generator returns before the child's `end`.
 */
async function* forward(
  frames: FrameReader,
  bundle: number,
  { maxBytes, maxObjects }: Bounds,
  onEnd: (end: ForwardEnd) => void,
): AsyncGenerator<Uint8Array, void, undefined> {
  // The bundle's size is within the bound: the caller checked it.
  let total = bundle;
  // At most `maxObjects` oids: the next one past it ends the carry first.
  const seen = new Set<string>();
  const out = (frame: HandoffLandFrame) => Buffer.from(`${JSON.stringify(frame)}\n`);
  const counted = (size: number): boolean => {
    total += size;
    if (total <= maxBytes) return true;
    onEnd({ stop: "refused", reason: boundText(maxBytes) });
    return false;
  };
  yield out({ bundle });
  let part = bundle;
  // The source relays a part's bytes in frames of up to 64 KiB, or what came in a second: a part
  // of `size` bytes needs few. More is out of the form, so the parsing work that the parent's step
  // can cause stays bounded by its bytes.
  let partFrames = 0;
  let maxFrames = framesFor(bundle);
  for (;;) {
    const got = await frames.header();
    if ("fault" in got) return onEnd({ stop: "unknown", reason: got.fault });
    const frame = got.frame;
    if ("refused" in frame) return onEnd({ stop: "refused", reason: frame.refused });
    if ("unknown" in frame) return onEnd({ stop: "unknown", reason: `the source Harness: ${frame.unknown}` });
    if ("data" in frame) {
      if (frame.data > part) {
        return onEnd({ stop: "unknown", reason: "the source Harness's answer has more bytes than a part's header" });
      }
      if (++partFrames > maxFrames) {
        return onEnd({ stop: "unknown", reason: "the source Harness's answer has more data frames than its form" });
      }
      yield out({ data: frame.data });
      for await (const chunk of frames.bytes(frame.data)) yield chunk;
      if (frames.broke !== undefined) return onEnd({ stop: "unknown", reason: frames.broke });
      if (frames.short) return onEnd({ stop: "unknown", reason: "the source Harness's stream ended in a part" });
      part -= frame.data;
      continue;
    }
    if (part > 0) {
      return onEnd({
        stop: "unknown",
        reason: "the source Harness's answer has a part with fewer bytes than its header",
      });
    }
    if ("end" in frame) {
      yield out({ end: true });
      return onEnd("end");
    }
    if ("lfs" in frame) {
      if (seen.has(frame.lfs)) {
        return onEnd({ stop: "unknown", reason: `the source Harness's answer has the object ${frame.lfs} twice` });
      }
      if (seen.size >= maxObjects) {
        return onEnd({ stop: "refused", reason: `its files hold more than ${maxObjects} Git LFS objects` });
      }
      seen.add(frame.lfs);
      if (!counted(frame.size)) return;
      yield out({ lfs: frame.lfs, size: frame.size });
      part = frame.size;
      partFrames = 0;
      maxFrames = framesFor(frame.size);
      continue;
    }
    return onEnd({ stop: "unknown", reason: `the source Harness's answer has ${Object.keys(frame)[0]} in a stream` });
  }
}

/**
 * A reader of the source's stream: header lines, checked against the form of a `HandoffFrame`, and
 * the bytes between them. It reads a chunk of the source only when its caller asks.
 */
class FrameReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  /** The stream ended in the middle of the last `bytes()`. */
  short = false;
  /** Why the source's stream broke (a reset, the idle bound, an abort), as the carry's reason. */
  broke: string | undefined;

  private readonly maxLine: number;

  constructor(body: ReadableStream<Uint8Array>, maxLine: number) {
    this.reader = body.getReader();
    this.maxLine = maxLine;
  }

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    let next: Awaited<ReturnType<typeof this.reader.read>>;
    try {
      next = await this.reader.read();
    } catch (err) {
      this.done = true;
      this.broke = `the source Harness's stream broke: ${transportDetail(err)}`;
      return false;
    }
    if (next.done) {
      this.done = true;
      return false;
    }
    this.buf = this.buf.length === 0 ? Buffer.from(next.value) : Buffer.concat([this.buf, next.value]);
    return true;
  }

  /** The next header, or what is wrong with it (the carry's reason). */
  async header(): Promise<{ frame: HandoffFrame } | { fault: string }> {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl >= 0) {
        if (nl > this.maxLine) return { fault: "the source Harness's answer has a header longer than its form" };
        const line = this.buf.subarray(0, nl).toString("utf8");
        this.buf = this.buf.subarray(nl + 1);
        const frame = frameOf(line);
        if (frame === undefined) return { fault: "the source Harness's answer has a header out of its form" };
        return { frame };
      }
      if (this.buf.length > this.maxLine)
        return { fault: "the source Harness's answer has a header longer than its form" };
      if (!(await this.fill()))
        return { fault: this.broke ?? "the source Harness's answer ended before its last frame" };
    }
  }

  /** Exactly `n` bytes, as they come; fewer, with `short` set, when the stream ends. */
  async *bytes(n: number): AsyncGenerator<Uint8Array, void, undefined> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.fill())) {
        this.short = true;
        return;
      }
      const take = Math.min(left, this.buf.length);
      const chunk = this.buf.subarray(0, take);
      this.buf = this.buf.subarray(take);
      left -= take;
      yield chunk;
    }
  }

  /** Let the source's stream go. Before its last frame, this ends the stream, which kills the
   * source's step. */
  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }
}

/** One header line as a frame, or undefined when it is out of the form: one JSON object, with
 * exactly the keys of one kind of frame and values of their types. A Git LFS object has at least one
 * byte: git-lfs stores no empty file, and an object of no bytes would cost nothing against the
 * bound. */
function frameOf(line: string): HandoffFrame | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  const size = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  switch (keys) {
    case "bundle":
      return size(o.bundle) && (o.bundle as number) > 0 ? { bundle: o.bundle as number } : undefined;
    case "lfs,size":
      return typeof o.lfs === "string" && OID.test(o.lfs) && size(o.size) && (o.size as number) > 0
        ? { lfs: o.lfs, size: o.size as number }
        : undefined;
    case "data":
      return size(o.data) && (o.data as number) > 0 ? { data: o.data as number } : undefined;
    case "end":
      return o.end === true ? { end: true } : undefined;
    case "nothing":
      return o.nothing === true ? { nothing: true } : undefined;
    case "refused":
      return typeof o.refused === "string" ? { refused: o.refused } : undefined;
    case "unknown":
      return typeof o.unknown === "string" ? { unknown: o.unknown } : undefined;
    default:
      return undefined;
  }
}

const bearerOf = (token: string | undefined): Record<string, string> =>
  token ? { authorization: `Bearer ${token}` } : {};

const mediaType = (value: string | null): string => (value ?? "").split(";")[0]!.trim().toLowerCase();

const isLanded = (text: string): boolean => {
  try {
    return (JSON.parse(text) as { landed?: unknown }).landed === true;
  } catch {
    return false;
  }
};

/** A Harness's error answer, short: its `error` field, or the start of its text. */
function errorOf(text: string): string {
  try {
    const error = (JSON.parse(text) as { error?: unknown }).error;
    if (typeof error === "string") return error.slice(0, 500);
  } catch {
    // not JSON
  }
  return text.trim().slice(0, 500) || "no body";
}

const boundText = (n: number): string =>
  `its files pass the bound of ${n % 1024 ** 3 === 0 ? `${n / 1024 ** 3} GiB` : n % 1024 ** 2 === 0 ? `${n / 1024 ** 2} MiB` : `${n} bytes`}`;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
